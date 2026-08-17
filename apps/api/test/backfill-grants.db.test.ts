import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleAddon } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Перенос назначений и сверка (ADR 0106, решение 9, шаг 1b; план реструктуризации модели доступа,
 * §13) — на живой схеме.
 *
 * Зачем база. Предмет теста и есть база: перенос — это `INSERT ... SELECT` под блокировкой, и всё,
 * что здесь проверяется, — свойства строк, которых на подменах не существует. Идемпотентность
 * держит `UNIQUE (user_id, grant_id)` и `ON CONFLICT DO NOTHING`, автор и время выдачи копируются
 * соединением по коду набора, а три сверки — это три запроса к тем же таблицам. Мок ответил бы
 * «функция вызвана» на любую из ошибок, ради которых шаг 1b и написан так.
 *
 * Зачем подпроцесс, а не импорт функции. Проверяются два свойства, которых у вызова функции нет:
 * **код возврата** (шаг ставится в чек-лист выката и обязан его останавливать) и **текст отчёта**
 * (человек читает не число, а кто и что не доехало). Скрипт запускается ровно так, как его запустит
 * админ, — `tsx src/backfill-grants.ts` с теми же переменными окружения.
 *
 * Исходное состояние теста — надстройка, заведённая **в обход** двойной записи: прямая вставка в
 * `user_role_addons` с прошлым `granted_at`. Это и есть легаси, ради которого перенос написан:
 * строки, попавшие в старую таблицу до релиза шага 1a.
 *
 * **Утверждения файла — только про свои строки, и это решение, а не осторожность.** Скрипт
 * миграционный, области у него нет, и его вердикт — про всю таблицу; база у db-тестов общая, а
 * файлы vitest гоняет параллельно. Прежняя редакция сводила базу к нулю в `beforeAll` и дальше
 * утверждала «diff нулевой», «Перенесено сейчас: 1», «расхождение: 1 + 0» — то есть говорила о
 * состоянии, которого не контролирует: соседний файл, заведший надстройку в те же секунды,
 * разваливал и счётчики, и вердикт. Сводить базу к нулю тем более нельзя: `user-grants-dual-write`
 * **намеренно** держит назначение без надстройки посреди своего сценария (проверка повторной
 * выдачи), и это его законное промежуточное состояние, а не мусор.
 *
 * Отсюда устройство проверок:
 *
 * - строки отчёта разбираются и фильтруются по своему префиксу почты — утверждается ровно то, что
 *   про наши учётки написал скрипт;
 * - вердикт и код возврата проверяются **инвариантом** (`backfill`): код обязан следовать
 *   напечатанному вердикту, а числа вердикта — сумме секций. Это утверждение верно при любом
 *   содержимом базы и держит ровно тот контракт, ради которого код возврата и заведён;
 * - `code === 1` утверждается там, где расхождение создали мы: своя строка делает diff ненулевым
 *   независимо от чужих.
 *
 * Альтернатива — `fileParallelism: false` для db-тестов — чинит один файл ценой всего прогона (их
 * шестьдесят с лишним, каждый со своими миграциями и сборкой приложения) и держится на честном
 * слове: любой будущий тест, оставивший надстройку между своими шагами, вернул бы флак обратно.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/backfill-grants.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Уникальный хвост прогона: база общая с другими db-тестами и переживает прогоны. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
/**
 * Метка своих учёток: уборка идёт по ней, а не «по последним строкам». Префикс общий на все
 * прогоны — упавший прогон обязан убираться следующим, а не копить учётки в общей базе.
 */
const EMAIL_PREFIX = 'db-backfill-grants';
/** Свои учётки **этого** прогона: по ним отбираются строки отчёта, чужие в нём не наше дело. */
const OURS = `${EMAIL_PREFIX}-${RUN}`;

const OPERATOR: RoleAddon = 'office_equipment_operator';
const IT_APPROVER: RoleAddon = 'office_equipment_it_approver';

/** Код пользовательского набора: такие появятся на этапе 3, и надстройки под них не бывает. */
const CUSTOM_CODE = `${EMAIL_PREFIX}-custom-${RUN}`;

/** Время выдачи легаси-надстройки: заведомо в прошлом, чтобы «проставил момент переноса» бросалось
 *  в глаза, а не пряталось в пределах секунды. */
const GRANTED_AT = new Date('2026-01-15T10:20:30.000Z');
/** Время повторной выдачи: тот же порядок величины, но другой день — расхождение видно глазом. */
const REGRANTED_AT = new Date('2026-02-20T08:00:00.000Z');

const SCRIPT = fileURLToPath(new URL('../src/backfill-grants.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

/** Учётка теста: почта нужна не меньше идентификатора — по ней строки узнаются в отчёте. */
interface TestUser {
  id: string;
  email: string;
}

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  /** Кто выдал надстройку: значение обязано доехать до назначения в неизменном виде. */
  admin: TestUser;
  /** Второй автор: с ним расхождение истории выдачи есть с чем спутать. */
  otherAdmin: TestUser;
}

let ctx: Ctx;
let userSeq = 0;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  // Почта тут ни при чём: скрипт ходит только в базу.
  process.env.MAIL_ENABLED = 'false';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/**
 * Уборка своих строк — и перед прогоном тоже. Учётки уносят с собой назначения и надстройки
 * каскадом (`user_grants.user_id`, `user_role_addons.user_id` — оба `ON DELETE CASCADE`), а свой
 * пользовательский набор удаляется следом и только после них: `user_grants.grant_id` — `RESTRICT`.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${EMAIL_PREFIX}%`}`);
}

/** Строка отчёта: «  · Имя <почта>: код [хвост]». */
interface ReportRow {
  email: string;
  code: string;
  /** Хвост строки: пометка про отсутствующий набор, `origin`, разошедшиеся автор и время. */
  note: string;
}

/** Секция отчёта: сколько строк насчитал скрипт и какие из них напечатал. */
interface Section {
  total: number;
  rows: ReportRow[];
}

interface Run {
  code: number;
  /** stdout и stderr вместе: вердикт печатается в stderr, всё остальное — в stdout. */
  out: string;
  checkOnly: boolean;
  /** «Перенесено сейчас»; `null` — режим `--check`, где счётчик называется иначе. */
  inserted: number | null;
  missing: Section;
  extra: Section;
  history: Section;
  /** Сумма из вердикта: `0` — «diff нулевой», иначе слагаемые строки «расхождение: A + B». */
  verdictDiff: number;
}

const MISSING_HEADER = 'Есть в user_role_addons, нет в user_grants (';
const EXTRA_HEADER = 'Есть в user_grants, нет в user_role_addons (';
const HISTORY_HEADER = 'Права совпали, история выдачи разошлась (';

/**
 * Секция отчёта по её заголовку. Отсутствие заголовка — это ноль строк, а не ошибка разбора:
 * пустую секцию скрипт не печатает вовсе.
 */
function section(lines: string[], header: string): Section {
  const at = lines.findIndex((line) => line.startsWith(header));
  if (at < 0) return { total: 0, rows: [] };
  const total = Number(/\((\d+)\)/.exec(lines[at]!)![1]);
  const rows: ReportRow[] = [];
  for (const line of lines.slice(at + 1)) {
    const parsed = /^ {2}· .+ <([^>]+)>: (\S+)(.*)$/.exec(line);
    if (!parsed) break;
    rows.push({ email: parsed[1]!, code: parsed[2]!, note: parsed[3]!.trim() });
  }
  // Печать секции обрезана `SAMPLE_LIMIT`, и обрезанный образец мог не донести наши строки — тогда
  // «наших расхождений нет» ниже означало бы «наши строки не поместились». Такого количества общая
  // база не наживает; если нажила, пусть падает здесь и с объяснением.
  if (rows.length < total) {
    throw new Error(
      `Секция «${header}» обрезана образцом (${rows.length} из ${total}): в общей базе слишком ` +
        'много расхождений, свои строки в отчёте не найти. Разберите базу db-тестов.',
    );
  }
  return { total, rows };
}

/** Счётчик из шапки отчёта. Отсутствие строки — сломанный формат: читают отчёт люди. */
function counterOf(out: string, label: string): number {
  const match = new RegExp(`${label}: (\\d+)`).exec(out);
  if (!match) throw new Error(`В отчёте нет строки «${label}»:\n${out}`);
  return Number(match[1]);
}

/**
 * Прогон скрипта так, как его запускает администратор: отдельным процессом, своим подключением.
 * Отчёт сразу разбирается, и на каждом прогоне проверяются два инварианта, верных при любом
 * содержимом общей базы:
 *
 * - числа вердикта равны числам секций — вердикт считает то же, что печатает;
 * - код возврата следует вердикту: 1 при ненулевом diff, 1 при разошедшейся истории в `--check`
 *   (см. `main` скрипта) и 0 в остальных случаях. Ради этого соответствия шаг и ставится в
 *   чек-лист выката, и проверять его надо на каждом прогоне, а не в одном отведённом тесте.
 */
async function backfill(...args: string[]): Promise<Run> {
  const raw = await new Promise<{ code: number; out: string }>((resolve, reject) => {
    const child = spawn(TSX, [SCRIPT, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const collect = (chunk: Buffer) => {
      out += chunk.toString('utf8');
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });

  const checkOnly = args.includes('--check');
  const lines = raw.out.split('\n');
  const missing = section(lines, MISSING_HEADER);
  const extra = section(lines, EXTRA_HEADER);
  const history = section(lines, HISTORY_HEADER);

  // Шапка: в каждом режиме свои счётчики, и отсутствие любого из них — сломанный отчёт.
  counterOf(raw.out, 'Надстроек в user_role_addons');
  counterOf(raw.out, 'Из них с заведённым набором');
  const inserted = checkOnly ? null : counterOf(raw.out, 'Перенесено сейчас');
  if (checkOnly) counterOf(raw.out, 'Уже перенесено');
  else counterOf(raw.out, 'Уже было');

  const diff = /Итог: расхождение: (\d+) \+ (\d+)/.exec(raw.out);
  const zero = raw.out.includes('Итог: diff нулевой, переключение чтения разрешено.');
  if (!diff && !zero) throw new Error(`В отчёте нет вердикта:\n${raw.out}`);
  const verdictDiff = diff ? Number(diff[1]) + Number(diff[2]) : 0;

  expect(verdictDiff, raw.out).toBe(missing.total + extra.total);
  expect(raw.code, raw.out).toBe(verdictDiff > 0 || (checkOnly && history.total > 0) ? 1 : 0);

  return {
    code: raw.code,
    out: raw.out,
    checkOnly,
    inserted,
    missing,
    extra,
    history,
    verdictDiff,
  };
}

/** Свои строки секции: чужие в общей базе принадлежат чужому тесту и утверждениям не подлежат. */
function ours(part: Section): { email: string; code: string }[] {
  return part.rows
    .filter((row) => row.email.startsWith(OURS))
    .map((row) => ({ email: row.email, code: row.code }));
}

/** Подопытная учётка: роль `shtab` — та, которой надстройки и положены (`ROLE_ADDON_BASE_ROLES`). */
async function newUser(role: 'shtab' | 'admin' = 'shtab'): Promise<TestUser> {
  userSeq += 1;
  const email = `${OURS}-${userSeq}@example.invalid`;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: 'Легаси',
      middleName: `Надстроечный ${userSeq}`,
      // Входа здесь нет: тест ходит в базу и в скрипт, пароль не участвует.
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
    })
    .returning({ id: ctx.schema.users.id });
  return { id: created!.id, email };
}

/** Убрать учётку сразу: состояние, заведённое одним тестом, не должно доживать до следующего. */
async function dropUser(user: TestUser): Promise<void> {
  await ctx.db.delete(ctx.schema.users).where(eq(ctx.schema.users.id, user.id));
}

/**
 * Легаси-надстройка: прямая вставка мимо `replaceUserAddons`, то есть без зеркала в `user_grants`.
 * Именно такие строки и лежат в базе к моменту шага 1b — выданные версией портала, которая про
 * назначения ещё ничего не знала.
 */
async function legacyAddon(user: TestUser, addon: RoleAddon): Promise<void> {
  await ctx.db
    .insert(ctx.schema.userRoleAddons)
    .values({ userId: user.id, addon, grantedBy: ctx.admin.id, grantedAt: GRANTED_AT });
}

interface GrantRow {
  id: string;
  code: string;
  grantedBy: string | null;
  grantedAt: Date;
  origin: string;
  migrationId: string | null;
}

/** Новая схема, прочитанная по коду набора: назначение ссылается на `grants.id`. */
async function grantRows(user: TestUser): Promise<GrantRow[]> {
  return ctx.db
    .select({
      id: ctx.schema.userGrants.id,
      code: ctx.schema.grants.code,
      grantedBy: ctx.schema.userGrants.grantedBy,
      grantedAt: ctx.schema.userGrants.grantedAt,
      origin: ctx.schema.userGrants.origin,
      migrationId: ctx.schema.userGrants.migrationId,
    })
    .from(ctx.schema.userGrants)
    .innerJoin(ctx.schema.grants, eq(ctx.schema.grants.id, ctx.schema.userGrants.grantId))
    .where(eq(ctx.schema.userGrants.userId, user.id))
    .orderBy(asc(ctx.schema.grants.code));
}

/** Идентификатор системного набора по коду — чтобы завести лишнее назначение руками. */
async function grantIdOf(code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: ctx.schema.grants.id })
    .from(ctx.schema.grants)
    .where(eq(ctx.schema.grants.code, code));
  if (!row) throw new Error(`В базе нет системного набора «${code}»`);
  return row.id;
}

describe.skipIf(!DB_URL)('назначения: перенос надстроек и сверка (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    await cleanup(db);

    const stub: TestUser = { id: '', email: '' };
    ctx = { db, schema, closeDb, admin: stub, otherAdmin: stub };
    ctx.admin = await newUser('admin');
    ctx.otherAdmin = await newUser('admin');

    // Системные наборы завела миграция 0145, и без них переносить некуда. Если их нет — сломан не
    // тест, а накат: пусть это будет видно здесь, а не в чужом ожидании.
    await grantIdOf(OPERATOR);
    await grantIdOf(IT_APPROVER);
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await cleanup(ctx.db);
      await ctx.closeDb();
    }
  });

  /** Учётка первого теста живёт до конца файла: на ней же проверяются повтор и первая сторона. */
  let user: TestUser;

  it('перенос заводит назначение с автором и временем выдачи из старой таблицы', async () => {
    user = await newUser();
    await legacyAddon(user, OPERATOR);

    // До переноса наша надстройка стоит на первой стороне сверки — и уже поэтому прогон обязан
    // вернуть 1: своя строка делает diff ненулевым независимо от чужих.
    const before = await backfill('--check');
    expect(ours(before.missing)).toEqual([{ email: user.email, code: OPERATOR }]);
    expect(before.code).toBe(1);

    const run = await backfill();

    expect(ours(run.missing)).toEqual([]);
    expect(ours(run.extra)).toEqual([]);
    expect(ours(run.history)).toEqual([]);
    // Счётчик переноса — про всю базу, поэтому проверяется вклад, а не равенство: нашу строку
    // прогон обязан включать, а сколько чужих он подобрал заодно — свойство базы, а не теста.
    expect(run.inserted).toBeGreaterThanOrEqual(1);

    const rows = await grantRows(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe(OPERATOR);
    // Главное утверждение переноса: не момент прогона, а исходные автор и время выдачи. Скрипт
    // меняет способ хранения, а не бизнес-причину выдачи.
    expect(rows[0]!.grantedAt.getTime()).toBe(GRANTED_AT.getTime());
    expect(rows[0]!.grantedBy).toBe(ctx.admin.id);
    // `manual` — выдал администратор; `migration` зарезервирован за переводом ролей, и колонка
    // перевода обязана остаться пустой: писателя у неё пока нет вовсе.
    expect(rows[0]!.origin).toBe('manual');
    expect(rows[0]!.migrationId).toBeNull();
  }, 90_000);

  it('повторный запуск ничего не меняет', async () => {
    const before = await grantRows(user);

    const run = await backfill();

    expect(ours(run.missing)).toEqual([]);
    // Идемпотентность — это не «вставка не упала» и не «Перенесено сейчас: 0» (этот счётчик считает
    // всю базу, включая чужие строки соседних файлов), а «строка та же»: `DO NOTHING` обязан
    // оставить прежний `id`, прежнего автора и прежнее время. Пересозданное назначение потеряло бы
    // `id`, на который опирается откат будущего перевода ролей.
    expect(await grantRows(user)).toEqual(before);
  }, 90_000);

  it('--check не пишет: недостающее назначение он только показывает', async () => {
    const second = await newUser();
    await legacyAddon(second, IT_APPROVER);

    const run = await backfill('--check');

    expect(run.out).toContain('--check: база не менялась.');
    expect(ours(run.missing)).toEqual([{ email: second.email, code: IT_APPROVER }]);
    // Ненулевой код возврата — условие того, что шаг можно поставить в чек-лист выката.
    expect(run.code).toBe(1);
    // Ни одной записи: `--check` только сверяет.
    expect(await grantRows(second)).toHaveLength(0);

    // Чинится переносом: ровно этим он и занят.
    const applied = await backfill();
    expect(ours(applied.missing)).toEqual([]);
    expect((await grantRows(second)).map((row) => row.code)).toEqual([IT_APPROVER]);
    await dropUser(second);
  }, 90_000);

  it('сверка ловит удалённое руками назначение', async () => {
    await ctx.db.delete(ctx.schema.userGrants).where(eq(ctx.schema.userGrants.userId, user.id));

    const run = await backfill('--check');

    expect(ours(run.missing)).toEqual([{ email: user.email, code: OPERATOR }]);
    expect(run.code).toBe(1);

    const applied = await backfill();
    expect(ours(applied.missing)).toEqual([]);
    expect((await grantRows(user)).map((row) => row.code)).toEqual([OPERATOR]);
  }, 90_000);

  /**
   * Обратная сторона. Ловит она то, чего первая не видит вовсе: назначение без надстройки — это
   * либо отзыв, не дошедший до второй таблицы, либо запись кода следующего шага. Такое право не
   * показывает ни один интерфейс (до 1c его никто не читает), и обнаружить его можно только здесь.
   */
  it('сверка ловит лишнее назначение, которому нет надстройки', async () => {
    const orphan = await newUser();
    await ctx.db
      .insert(ctx.schema.userGrants)
      .values({ userId: orphan.id, grantId: await grantIdOf(OPERATOR), grantedBy: ctx.admin.id });

    const run = await backfill('--check');

    expect(ours(run.extra)).toEqual([{ email: orphan.email, code: OPERATOR }]);
    expect(run.out).toContain(`${OPERATOR} (origin: manual)`);
    expect(run.code).toBe(1);

    // Переносом это не чинится — и не должно: снимать чужие назначения скрипт не берётся.
    const applied = await backfill();
    expect(ours(applied.extra)).toEqual([{ email: orphan.email, code: OPERATOR }]);
    expect(applied.code).toBe(1);
    expect(await grantRows(orphan)).toHaveLength(1);

    await dropUser(orphan);
  }, 120_000);

  /**
   * Третья сверка: пара есть в обеих таблицах, а история выдачи разошлась. Ни одна из сторон
   * diff'а этого не видит — обе спрашивают только о существовании пары, — и без третьей проверки
   * «diff нулевой» означало бы «доступ совпал», выдавая себя за «таблицы совпали».
   *
   * Состояние достижимо через объявленный безопасным откат `1b → 1a` (план §15): пока работал код
   * без двойной записи, надстройку отозвали и выдали заново — старая таблица получила нового автора
   * и новое время, а назначение осталось прежним, потому что повторную вставку погасил
   * `ON CONFLICT DO NOTHING`. Прямая правка старой таблицы здесь и играет ту версию портала.
   */
  it('сверка ловит разошедшуюся историю у совпавшей пары', async () => {
    const drifted = await newUser();
    await legacyAddon(drifted, OPERATOR);
    await backfill();
    const mirrored = await grantRows(drifted);
    expect(mirrored).toHaveLength(1);

    await ctx.db
      .update(ctx.schema.userRoleAddons)
      .set({ grantedBy: ctx.otherAdmin.id, grantedAt: REGRANTED_AT })
      .where(
        and(
          eq(ctx.schema.userRoleAddons.userId, drifted.id),
          eq(ctx.schema.userRoleAddons.addon, OPERATOR),
        ),
      );

    const run = await backfill('--check');

    // Обе стороны diff'а по нашим строкам пусты: доступ совпадает, врёт только объяснение выдачи.
    expect(ours(run.missing)).toEqual([]);
    expect(ours(run.extra)).toEqual([]);
    expect(ours(run.history)).toEqual([{ email: drifted.email, code: OPERATOR }]);
    // Отчёт называет обе стороны расхождения поимённо: иначе с ним нечего делать — правится оно
    // руками, и человеку нужно знать, чей автор и чьё время где лежат.
    const row = run.history.rows.find((item) => item.email === drifted.email)!;
    expect(row.note).toContain(ctx.otherAdmin.email);
    expect(row.note).toContain(ctx.admin.email);
    expect(row.note).toContain('выдано:');
    // Код возврата 1 при нулевом diff'е — то самое решение: переключению чтения расхождение не
    // мешает, но `--check` обязан заставить человека посмотреть отчёт. Чинится оно только руками и
    // только пока жива `user_role_addons`: шаг 1e уносит её вместе со свидетельством выдачи.
    expect(run.code).toBe(1);
    expect(run.out).toContain('Предупреждение: история выдачи разошлась');

    // Перенос историю не переписывает: `DO NOTHING` бережёт прежнюю строку, и это решение, а не
    // побочный эффект — с шага 1d копирование из отставшей таблицы затирало бы верную историю.
    // Что в режиме переноса расхождение истории код возврата не меняет, проверяет инвариант
    // `backfill`: там код сверяется с вердиктом, а вердикт от истории не зависит.
    const rerun = await backfill();
    expect(await grantRows(drifted)).toEqual(mirrored);
    expect(ours(rerun.history)).toEqual([{ email: drifted.email, code: OPERATOR }]);

    await dropUser(drifted);
  }, 120_000);

  /**
   * Обратная сторона ограничена системными кодами. С этапа 3 в `user_grants` появятся наборы,
   * собранные администратором: надстройки под них нет и не будет никогда — старая таблица о них не
   * знает вовсе. Не ограничь сверку кодами переезда, первая же законная выдача «Аудитора» встала бы
   * в отчёт расхождением и уронила бы прогон, требуя разобрать состояние, которое разбору не
   * подлежит.
   */
  it('пользовательский набор в обратную сторону сверки не попадает', async () => {
    const holder = await newUser();
    const [custom] = await ctx.db
      .insert(ctx.schema.grants)
      .values({ code: CUSTOM_CODE, name: `Тестовый набор ${RUN}`, isSystem: false })
      .returning({ id: ctx.schema.grants.id });
    await ctx.db
      .insert(ctx.schema.userGrants)
      .values({ userId: holder.id, grantId: custom!.id, grantedBy: ctx.admin.id });

    const run = await backfill('--check');

    expect(ours(run.extra)).toEqual([]);
    expect(ours(run.missing)).toEqual([]);
    expect(run.out).not.toContain(CUSTOM_CODE);

    // И перенос его не трогает: переезжают надстройки, а не содержимое `user_grants`.
    const applied = await backfill();
    expect(ours(applied.extra)).toEqual([]);
    expect((await grantRows(holder)).map((row) => row.code)).toEqual([CUSTOM_CODE]);

    await dropUser(holder);
    await ctx.db.delete(ctx.schema.grants).where(eq(ctx.schema.grants.id, custom!.id));
  }, 120_000);
});
