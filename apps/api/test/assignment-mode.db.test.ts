import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentMode from '../src/services/assignment-mode';

/*
 * Файлу нужна СВОЯ база: он меняет глобальную управляющую строку модуля, а
 * `assignment-periods-schema.db.test.ts` проверяет её исходное состояние. Параллельный прогон обоих
 * по одной `TEST_DATABASE_URL` даёт ложное падение.
 */

/**
 * Автомат режимов модуля периодов назначения
 * ([assignment-mode.ts](../src/services/assignment-mode.ts), план §6 и §10, решения Ж3, И1, О2–О5).
 *
 * Проверяется то, чего база сама не проверяет и проверить не может. `CHECK` перечисляет **значения**
 * режима, а не переходы между ними: прямой `history_frozen → normal` и `set read_mode = 'history',
 * cutover_run_id = '<любой существующий>'` прошли бы беспрепятственно. Значит, всё, что отделяет
 * cutover от «переключили и посмотрим», живёт в сервисе — и падёж любой из этих проверок не даст ни
 * ошибки, ни отказа, а тихо разрешит переключение, которое доказать нечем.
 *
 * Четыре предмета файла:
 *
 * 1. **матрица переходов** — каждое допустимое ребро проходит, каждое недопустимое отвергается, и
 *    отказ называет путь, а не просто отказывает;
 * 2. **доказательства активации** — поколение сверки, аттестация деплоя и предикат готовности Р20:
 *    двадцать два способа включить историю без права на это, и все двадцать два отклонены;
 * 3. **журнал** — пополняется каждым переходом, не пополняется ни одним отказом и физически
 *    неизменяем;
 * 4. **freeze как drain** (Ж3) — писатель, держащий управляющую строку `FOR SHARE`, останавливает
 *    смену режима до своего коммита. Это и есть механизм, ради которого блокировка и флаг сведены в
 *    одну строку, и проверить его можно только двумя соединениями: на одном он не воспроизводится
 *    вовсе.
 *
 * ФАЙЛ ЗАВОДИТ СОБСТВЕННУЮ БАЗУ И СНОСИТ ЕЁ ЗА СОБОЙ. Иначе никак, и причин две. Первая: дверь
 * коммитит, а управляющая строка одна на базу — файл, замораживающий запись модуля, на общей базе
 * топил бы соседей, и отказ «модуль закрыт на запись» они получали бы неизвестно от кого. Вторая:
 * предикат готовности Р20 считается по **всей** базе, и на общей `technic_archive_test` случай
 * «включение истории проходит» краснел бы по чужой вине — три сотни заявок в состоянии `empty`
 * приезжают туда от соседних файлов. База создаётся из `TEST_DATABASE_URL` заменой имени,
 * мигрируется тем же раннером, что и все прочие, и удаляется в `afterAll`.
 *
 * Журнал переходов не чистится вовсе — он append-only, и это ровно то свойство, которое файл
 * проверяет; счёт идёт от `max(id)`, снятого перед случаем.
 *
 * Запуск (база из переменной может быть любой — своя всё равно создаётся рядом):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/assignment-mode.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Хвост прогона: учётка живёт дольше транзакции, а email уникален глобально. */
const RUN = Date.now().toString(36).slice(-6);

/** Сборка, которой «раскатан» портал в сценарии: своя, ни на что в репозитории не похожая. */
const BUILD = `build-${RUN}`;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  mode: typeof AssignmentMode;
  /** Адрес своей базы: два соединения барьерного случая ходят именно в неё, а не в общую. */
  ownUrl: string;
  userId: string;
  objectId: string;
  vehicleTypeId: string;
  vehicleId: string;
  /** Тип назначенной машины: составной ключ назначения ведёт в справочник её собственным типом. */
  vehicleTypeOfVehicleId: string;
}

let ctx: Ctx;

/**
 * Имя и адрес заведённой базы — **вне** `ctx` намеренно: сцена в `ctx` появляется последней, а
 * снести базу надо и тогда, когда она не собралась. Иначе упавший `beforeAll` оставляет на
 * кластере брошенную базу, и находят её через неделю по списку.
 */
let created: { dbName: string; adminUrl: string } | null = null;
/** Версия алгоритма берётся у самого сервиса: разойдись константа и тест — проверялась бы копия. */
let ALGO = '';

beforeAll(async () => {
  if (!DB_URL) return;

  const base = new URL(DB_URL);
  const dbName = `${base.pathname.slice(1)}_mode_${RUN}`.slice(0, 63);
  const admin = new URL(DB_URL);
  admin.pathname = '/postgres';
  const own = new URL(DB_URL);
  own.pathname = `/${dbName}`;
  created = { dbName, adminUrl: admin.toString() };

  const adminClient = new pg.Client({ connectionString: admin.toString() });
  await adminClient.connect();
  try {
    await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminClient.end();
  }

  process.env.DATABASE_URL = own.toString();
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';

  const client = new pg.Client({ connectionString: own.toString() });
  await client.connect();
  try {
    // Без этих трёх расширений миграции падают на `type "citext" does not exist`,
    // `operator class "gin_trgm_ops" does not exist` и `gen_random_uuid()`.
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(client);
  } finally {
    await client.end();
  }
  const { db, closeDb } = await import('../src/db/client');
  const mode = await import('../src/services/assignment-mode');
  ALGO = mode.ASSIGNMENT_HISTORY_ALGO_VERSION;

  // Автор перехода — настоящая учётка: `actor_user_id` стоит `ON DELETE RESTRICT`, и «кто разрешил»
  // обязано пережить увольнение.
  const one = async <T extends object>(q: Parameters<typeof db.execute>[0]): Promise<T> => {
    const [row] = (await db.execute<T>(q)).rows;
    if (!row) throw new Error('в справочнике пусто: сцену не собрать');
    return row;
  };
  const user = await one<{ id: string }>(sql`
    INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
    VALUES (${`ap-mode-${RUN}@example.invalid`}, 'Режимов', 'Пров', 'x', 'admin', false)
    RETURNING id`);
  const obj = await one<{ id: string }>(sql`SELECT id FROM construction_objects LIMIT 1`);
  const vt = await one<{ id: string }>(sql`SELECT id FROM vehicle_types LIMIT 1`);
  const vehicle = await one<{ id: string; vehicle_type_id: string }>(sql`
    SELECT id, vehicle_type_id FROM vehicles
     WHERE ownership = 'own' AND deleted_at IS NULL ORDER BY id LIMIT 1`);

  ctx = {
    db,
    closeDb,
    mode,
    ownUrl: own.toString(),
    userId: user.id,
    objectId: obj.id,
    vehicleTypeId: vt.id,
    vehicleId: vehicle.id,
    vehicleTypeOfVehicleId: vehicle.vehicle_type_id,
  };
}, 180_000);

afterAll(async () => {
  // Пул закрывается раньше `DROP DATABASE`: открытое соединение не дало бы снести базу даже с
  // `FORCE` — точнее, `FORCE` оборвал бы его чужой рукой, и последняя строка лога была бы про это.
  if (ctx) await ctx.closeDb();
  if (!created) return;
  const adminClient = new pg.Client({ connectionString: created.adminUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`DROP DATABASE IF EXISTS "${created.dbName}" WITH (FORCE)`);
  } finally {
    await adminClient.end();
  }
}, 60_000);

// ── Сцена ──

const today = (): string => moscowDateKeyOf(new Date());

/** Управляющая строка как её видит база. */
interface ControlRow {
  write_mode: string;
  read_mode: string;
  cutover_run_id: string | null;
}

/**
 * Поставить режим в обход двери — только для подготовки случая.
 *
 * Прямой `UPDATE` проходит потому, что роли `technic_maintenance` в кластере нет и триггер
 * `assignment_periods_control_guard` пропускает запись (fail-open до разделения ролей). На проде
 * дверь остаётся единственным путём, и именно это делает сервисные проверки нормой, а не
 * рекомендацией.
 */
async function force(
  writeMode: string,
  readMode: string,
  cutoverRunId: string | null = null,
): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE assignment_periods_control
       SET write_mode = ${writeMode}, read_mode = ${readMode}, cutover_run_id = ${cutoverRunId}
     WHERE id = true`);
}

async function control(): Promise<ControlRow> {
  const [row] = (
    await ctx.db.execute<ControlRow>(sql`
      SELECT write_mode, read_mode, cutover_run_id FROM assignment_periods_control WHERE id = true`)
  ).rows;
  if (!row) throw new Error('управляющая строка исчезла');
  return row;
}

/** Хвост журнала: `bigint` приезжает строкой, поэтому нормализуем сразу. */
async function journalTop(): Promise<number> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(
      sql`SELECT coalesce(max(id), 0) AS id FROM assignment_periods_mode_transitions`,
    )
  ).rows;
  return Number(row?.id ?? 0);
}

interface JournalRow {
  id: string;
  from_write_mode: string;
  to_write_mode: string;
  from_read_mode: string;
  to_read_mode: string;
  run_id: string | null;
  attestation_id: string | null;
  build_sha: string;
  algo_version: string;
  reason: string;
  actor_user_id: string;
}

async function journalAfter(id: number): Promise<JournalRow[]> {
  return (
    await ctx.db.execute<JournalRow>(sql`
      SELECT * FROM assignment_periods_mode_transitions WHERE id > ${id} ORDER BY id`)
  ).rows;
}

/** Что просят у двери по умолчанию — случай меняет только то, что проверяет. */
function change(over: Partial<AssignmentMode.AssignmentModeChange> = {}) {
  return {
    targetWriteMode: 'normal',
    targetReadMode: 'legacy',
    reason: 'проверка автомата',
    actorUserId: ctx.userId,
    buildSha: BUILD,
    ...over,
  } as AssignmentMode.AssignmentModeChange;
}

/** Отказ двери: он обязан быть `AppError` с внятным текстом, а не «что-то упало». */
interface Refusal {
  statusCode: number;
  code: string;
  message: string;
}

async function refused(run: Promise<unknown>): Promise<Refusal> {
  try {
    await run;
  } catch (e) {
    const error = e as Partial<Refusal> & { message?: string };
    return {
      statusCode: error.statusCode ?? 0,
      code: error.code ?? 'unknown',
      message: error.message ?? '',
    };
  }
  throw new Error('переход прошёл, хотя должен был быть отклонён');
}

/**
 * Дверь исполняет транзакцию тем соединением, которое ей дали (умолчания у неё нет намеренно):
 * административный путь ходит своими кредами, портал — прикладным пулом. В тесте это db сцены.
 */
function setMode(change: Parameters<(typeof AssignmentMode)['setModuleMode']>[0]) {
  return ctx.mode.setModuleMode(change, ctx.db);
}

/** Отказ базы (триггер, ограничение): сообщение лежит в причине, а не на верхнем уровне. */
async function refusedBySql(query: Parameters<(typeof AppDb)['execute']>[0]): Promise<string> {
  try {
    await ctx.db.execute(query);
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause ?? (e as { message?: string });
    return cause.message ?? '';
  }
  throw new Error('база приняла запись, которую принимать не должна');
}

type CheckStatus = 'pending' | 'match' | 'mismatch';

interface RunSeed {
  status?: string;
  asOf?: string;
  algoVersion?: string;
  buildVersion?: string;
  /** Сколько целей объявлено в manifest: по умолчанию — сколько заведено строк. */
  expected?: number;
  checks?: readonly CheckStatus[];
}

/** Поколение сверки со своим manifest'ом. `request_id` здесь значение, а не ссылка, — заявка не нужна. */
async function seedRun(seed: RunSeed = {}): Promise<string> {
  const status = seed.status ?? 'completed';
  const checks = seed.checks ?? (['match', 'match'] as const);
  const expected = seed.expected ?? checks.length;
  const finished = status === 'completed' || status === 'failed';
  const [run] = (
    await ctx.db.execute<{ run_id: string }>(sql`
      INSERT INTO assignment_shadow_runs
        (status, as_of, algo_version, build_version, expected_checks, finished_at)
      VALUES (${status}, ${seed.asOf ?? today()}, ${seed.algoVersion ?? ALGO},
              ${seed.buildVersion ?? BUILD}, ${expected}, ${finished ? sql`now()` : sql`null`})
      RETURNING run_id`)
  ).rows;
  if (!run) throw new Error('поколение не завелось');
  for (const [i, status_] of checks.entries()) {
    await ctx.db.execute(sql`
      INSERT INTO assignment_shadow_checks
        (run_id, request_id, scope_fingerprint, status, evaluation_fingerprint, details, checked_at)
      VALUES (${run.run_id}, gen_random_uuid(), ${`scope-${i}`}, ${status_},
              ${status_ === 'pending' ? null : `ev-${i}`},
              ${status_ === 'mismatch' ? sql`'{"why":"расхождение"}'::jsonb` : sql`null`},
              ${status_ === 'pending' ? sql`null` : sql`now()`})`);
  }
  return run.run_id;
}

interface AttestationSeed {
  builds?: readonly string[];
  algoVersion?: string;
  legacyCalls?: number;
  /** Насколько аттестация «состарена» к моменту проверки. */
  ageSeconds?: number;
  consumed?: boolean;
}

/**
 * Массив сборок собирается `ARRAY[...]`, а не подстановкой JS-массива: drizzle разворачивает массив
 * в шаблоне в список параметров через запятую, и `text[]` получал бы на вход одну строку.
 */
function buildArray(builds: readonly string[]) {
  return sql`ARRAY[${sql.join(
    builds.map((b) => sql`${b}`),
    sql`, `,
  )}]::text[]`;
}

async function seedAttestation(seed: AttestationSeed = {}): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO assignment_deploy_attestations
        (attested_at, active_build_shas, algo_version, legacy_client_calls, consumed_at)
      VALUES (now() - ${`${seed.ageSeconds ?? 0} seconds`}::interval,
              ${buildArray(seed.builds ?? [BUILD])}, ${seed.algoVersion ?? ALGO},
              ${seed.legacyCalls ?? 0}, ${seed.consumed ? sql`now()` : sql`null`})
      RETURNING id`)
  ).rows;
  if (!row) throw new Error('аттестация не завелась');
  return row.id;
}

/**
 * Заявка с заданным состоянием истории — только для проверок готовности.
 *
 * Заводится и убирается внутри случая: непогашенная метка `dirty` запретила бы разморозку всем
 * следующим случаям файла, а найти причину по отказу «сначала revalidation» было бы непросто.
 *
 * Тип «грузовой перевозки» и статус `cancelled` выбраны так, чтобы заявка **не попала** в
 * популяцию Р20: метки загрязнения и устаревания дверь считает по всей таблице — той же формулой,
 * что и сводка, — и случай обязан показывать именно это, а не заодно предикат готовности.
 */
async function withRequest(
  columns: { dirty?: boolean; state?: string; validatedOn?: string | null },
  run: () => Promise<void>,
): Promise<void> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests
        (request_type, object_id, vehicle_type_id, status, created_by,
         assignment_history_dirty, assignment_history_state, assignment_history_validated_on)
      VALUES ('freight_transport', ${ctx.objectId}, ${ctx.vehicleTypeId}, 'cancelled', ${ctx.userId},
              ${columns.dirty ?? false}, ${columns.state ?? 'empty'}, ${columns.validatedOn ?? null})
      RETURNING id`)
  ).rows;
  if (!row) throw new Error('заявка не завелась');
  await ctx.db.execute(sql`
    INSERT INTO freight_transport_request_details (request_id, scheduled_at)
    VALUES (${row.id}, now())`);
  try {
    await run();
  } finally {
    await ctx.db.execute(
      sql`DELETE FROM freight_transport_request_details WHERE request_id = ${row.id}`,
    );
    await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ${row.id}`);
  }
}

/**
 * Заявка **из популяции Р20** — заказ спецтехники со сроком, то самое множество, готовности
 * которого дверь и требует ({@link ASSIGNMENT_READINESS_POPULATION} в `assignment-readiness.ts`).
 *
 * Состояние задаётся прямо: доводить историю по-настоящему здесь нечем и незачем — проверяется
 * дверь, а не бэкфилл. Ограничение схемы связывает состояние с днём пересчёта
 * (`state = 'empty'` тогда и только тогда, когда `validated_on` пуст), и помощник его соблюдает.
 */
async function withPopulationRequest(
  columns: { state: string; validatedOn?: string | null; assigned?: boolean },
  run: () => Promise<void>,
): Promise<void> {
  const validatedOn = columns.state === 'empty' ? null : (columns.validatedOn ?? today());
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests
        (request_type, object_id, vehicle_type_id, status, created_by,
         assignment_history_state, assignment_history_validated_on)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.vehicleTypeId}, 'confirmed', ${ctx.userId},
              ${columns.state}, ${validatedOn})
      RETURNING id`)
  ).rows;
  if (!row) throw new Error('заказ спецтехники не завёлся');
  // Срок обязателен: без `date_from` заявка в предикат не входит вовсе — считать отрезки не по чему.
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${row.id}, ${today()}, ${today()})`);
  if (columns.assigned) {
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignments
        (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
      VALUES (${row.id}, ${ctx.vehicleId}, ${ctx.vehicleTypeOfVehicleId}, ${ctx.vehicleTypeId},
              ${ctx.userId})`);
  }
  try {
    await run();
  } finally {
    await ctx.db.execute(sql`DELETE FROM vehicle_request_assignments WHERE request_id = ${row.id}`);
    await ctx.db.execute(
      sql`DELETE FROM special_equipment_request_details WHERE request_id = ${row.id}`,
    );
    await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ${row.id}`);
  }
}

/** Полный комплект доказательств активации: поколение сегодняшнего дня и свежая аттестация. */
async function activationKit(
  run: RunSeed = {},
  attestation: AttestationSeed = {},
): Promise<{ runId: string; attestationId: string }> {
  return { runId: await seedRun(run), attestationId: await seedAttestation(attestation) };
}

// ── Матрица переходов записи (О2) ──

describe.skipIf(!DB_URL)('матрица переходов режима записи', () => {
  const allowed: ReadonlyArray<[string, string]> = [
    ['normal', 'history_frozen'],
    ['normal', 'all_frozen'],
    // Единственная дорога из отката обратно в работу: «через `all_frozen` + revalidation».
    ['history_frozen', 'all_frozen'],
    ['all_frozen', 'normal'],
  ];

  it.each(allowed)('%s → %s проходит и попадает в журнал', async (from, to) => {
    await force(from, 'legacy');
    const top = await journalTop();
    const record = await setMode(
      change({
        targetWriteMode: to as AssignmentMode.AssignmentWriteMode,
        reason: `переход ${from} → ${to}`,
      }),
    );

    expect(record.from.writeMode).toBe(from);
    expect(record.to.writeMode).toBe(to);
    expect((await control()).write_mode).toBe(to);

    const [written, ...rest] = await journalAfter(top);
    expect(rest).toHaveLength(0);
    expect(written).toMatchObject({
      from_write_mode: from,
      to_write_mode: to,
      from_read_mode: 'legacy',
      to_read_mode: 'legacy',
      run_id: null,
      attestation_id: null,
      build_sha: BUILD,
      algo_version: ALGO,
      reason: `переход ${from} → ${to}`,
      actor_user_id: ctx.userId,
    });
  });

  const forbidden: ReadonlyArray<[string, string, RegExp]> = [
    // Пока история была закрыта, ручная выписка и смены двигали отменяемость бумаги (К4).
    ['history_frozen', 'normal', /Прямой переход/],
    // Ослабление открыло бы ровно то, что полная заморозка и закрывает (И1).
    ['all_frozen', 'history_frozen', /Ослабление/],
  ];

  it.each(forbidden)('%s → %s отвергается и объясняет путь', async (from, to, hint) => {
    await force(from, 'legacy');
    const top = await journalTop();
    const refusal = await refused(
      setMode(change({ targetWriteMode: to as AssignmentMode.AssignmentWriteMode })),
    );

    expect(refusal.statusCode).toBe(422);
    expect(refusal.code).toBe('assignment_mode_transition_rejected');
    expect(refusal.message).toMatch(hint);
    expect((await control()).write_mode).toBe(from);
    // Отказ — не переход: журнал доказательств отказами не пополняется.
    expect(await journalAfter(top)).toHaveLength(0);
  });

  it('переход, ничего не меняющий, в журнал не пишется', async () => {
    await force('normal', 'legacy');
    const top = await journalTop();
    const refusal = await refused(setMode(change({ targetWriteMode: 'normal' })));
    expect(refusal.message).toMatch(/Режим уже такой/);
    expect(await journalAfter(top)).toHaveLength(0);
  });

  it('заморозка и переключение чтения — разные шаги', async () => {
    const { runId, attestationId } = await activationKit();
    await force('normal', 'legacy');
    const refusal = await refused(
      setMode(
        change({ targetWriteMode: 'all_frozen', targetReadMode: 'history', runId, attestationId }),
      ),
    );
    expect(refusal.message).toMatch(/разными шагами/);
    expect(await control()).toMatchObject({ write_mode: 'normal', read_mode: 'legacy' });
  });

  it('разморозка не проходит, пока где-то поднята метка загрязнения', async () => {
    await force('all_frozen', 'legacy');
    await withRequest({ dirty: true }, async () => {
      const refusal = await refused(setMode(change({ targetWriteMode: 'normal' })));
      expect(refusal.message).toMatch(/revalidation/);
      expect((await control()).write_mode).toBe('all_frozen');
    });
    // Метка снята вместе с заявкой — та же разморозка теперь проходит.
    const record = await setMode(change({ targetWriteMode: 'normal' }));
    expect(record.to.writeMode).toBe('normal');
  });

  it('поколение и аттестация к заморозке отношения не имеют', async () => {
    const { runId, attestationId } = await activationKit();
    await force('normal', 'legacy');
    const refusal = await refused(
      setMode(change({ targetWriteMode: 'all_frozen', runId, attestationId })),
    );
    expect(refusal.message).toMatch(/только к включению истории/);
  });
});

// ── Причина (О5) ──

describe.skipIf(!DB_URL)('переход без причины', () => {
  it.each([['', 'пустая'] as const, ['   ', 'из одних пробелов'] as const])(
    'причина %s (%s) отвергается',
    async (reason) => {
      await force('normal', 'legacy');
      const top = await journalTop();
      const refusal = await refused(setMode(change({ targetWriteMode: 'all_frozen', reason })));
      expect(refusal.message).toMatch(/требует причины/);
      expect((await control()).write_mode).toBe('normal');
      expect(await journalAfter(top)).toHaveLength(0);
    },
  );

  it('сборка, которой переключают, обязательна', async () => {
    await force('normal', 'legacy');
    const refusal = await refused(
      setMode(change({ targetWriteMode: 'all_frozen', buildSha: '  ' })),
    );
    expect(refusal.message).toMatch(/Не названа сборка/);
  });
});

// ── Переключение чтения (М1, О3, О4, И5) ──

describe.skipIf(!DB_URL)('включение истории', () => {
  it('под полным комплектом доказательств проходит и потребляет аттестацию', async () => {
    const { runId, attestationId } = await activationKit();
    await force('all_frozen', 'legacy');
    const top = await journalTop();

    const record = await setMode(
      change({
        targetWriteMode: 'all_frozen',
        targetReadMode: 'history',
        runId,
        attestationId,
        reason: 'cutover: поколение зелёное, раскат подтверждён',
      }),
    );

    expect(record.to.readMode).toBe('history');
    expect(record.runId).toBe(runId);
    expect(record.attestationId).toBe(attestationId);
    expect(await control()).toMatchObject({
      write_mode: 'all_frozen',
      read_mode: 'history',
      cutover_run_id: runId,
    });

    const [written] = await journalAfter(top);
    expect(written).toMatchObject({
      from_read_mode: 'legacy',
      to_read_mode: 'history',
      run_id: runId,
      attestation_id: attestationId,
    });

    // Аттестация потреблена той же транзакцией: одна аттестация — одно переключение.
    const [attestation] = (
      await ctx.db.execute<{ consumed_at: string | null }>(
        sql`SELECT consumed_at FROM assignment_deploy_attestations WHERE id = ${attestationId}`,
      )
    ).rows;
    expect(attestation?.consumed_at).not.toBeNull();

    // Читатели с этого момента берут историю, а не назначение.
    expect(ctx.mode.historyIsAuthoritative(await ctx.mode.readAssignmentMode(ctx.db))).toBe(true);
  });

  it('доведённая до `ready` заявка популяции переключению не мешает', async () => {
    const { runId, attestationId } = await activationKit();
    await force('all_frozen', 'legacy');
    // Обратная сторона предиката: отказ обязан исчезать вместе с причиной, иначе дверь заперта
    // навсегда и «готово» недостижимо ни одним прогоном.
    await withPopulationRequest({ state: 'ready', assigned: true }, async () => {
      const record = await setMode(
        change({
          targetWriteMode: 'all_frozen',
          targetReadMode: 'history',
          runId,
          attestationId,
          reason: 'cutover: популяция доведена до ready',
        }),
      );
      expect(record.to.readMode).toBe('history');
      expect((await control()).cutover_run_id).toBe(runId);
    });
  });

  it('возврат к legacy идёт той же дверью и не стирает поколение', async () => {
    const { runId, attestationId } = await activationKit();
    await force('all_frozen', 'legacy');
    await setMode(
      change({ targetWriteMode: 'all_frozen', targetReadMode: 'history', runId, attestationId }),
    );

    const top = await journalTop();
    const record = await setMode(
      change({
        targetWriteMode: 'all_frozen',
        targetReadMode: 'legacy',
        reason: 'откат: чтение возвращено на назначение',
      }),
    );

    expect(record.to.readMode).toBe('legacy');
    // Ссылка остаётся аудитом того, чем история была включена, — условие схемы одностороннее.
    expect(await control()).toMatchObject({ read_mode: 'legacy', cutover_run_id: runId });
    const [written] = await journalAfter(top);
    expect(written).toMatchObject({
      from_read_mode: 'history',
      to_read_mode: 'legacy',
      run_id: null,
      attestation_id: null,
    });
  });

  it('возврат к legacy не потребляет ни поколения, ни аттестации', async () => {
    const kit = await activationKit();
    await force('all_frozen', 'legacy');
    await setMode(
      change({
        targetWriteMode: 'all_frozen',
        targetReadMode: 'history',
        runId: kit.runId,
        attestationId: kit.attestationId,
      }),
    );
    const spare = await activationKit();
    const refusal = await refused(
      setMode(
        change({
          targetWriteMode: 'all_frozen',
          targetReadMode: 'legacy',
          runId: spare.runId,
          attestationId: spare.attestationId,
        }),
      ),
    );
    expect(refusal.message).toMatch(/не потребляет/);
  });

  const underFreeze: ReadonlyArray<[string, string]> = [
    ['normal', 'history'],
    ['history_frozen', 'history'],
  ];

  it.each(underFreeze)(
    'из режима %s чтение на %s не переключается',
    async (writeMode, readMode) => {
      await force(writeMode, 'legacy');
      const { runId, attestationId } = await activationKit();
      const refusal = await refused(
        setMode(
          change({
            targetWriteMode: writeMode as AssignmentMode.AssignmentWriteMode,
            targetReadMode: readMode as AssignmentMode.AssignmentReadMode,
            runId,
            attestationId,
          }),
        ),
      );
      expect(refusal.message).toMatch(/под полной заморозкой/);
      expect((await control()).read_mode).toBe('legacy');
    },
  );

  it('выключение истории тоже требует полной заморозки', async () => {
    const { runId, attestationId } = await activationKit();
    await force('all_frozen', 'legacy');
    await setMode(
      change({ targetWriteMode: 'all_frozen', targetReadMode: 'history', runId, attestationId }),
    );
    await force('normal', 'history', runId);
    const refusal = await refused(
      setMode(change({ targetWriteMode: 'normal', targetReadMode: 'legacy' })),
    );
    expect(refusal.message).toMatch(/под полной заморозкой/);
    expect((await control()).read_mode).toBe('history');
  });
});

// ── Доказательства активации: поколение (М1, О3) и аттестация (О4, И5) ──

describe.skipIf(!DB_URL)('активация без доказательств', () => {
  /** Каждый случай — свой способ обмануть дверь; ожидание одно: отказ и неизменённое чтение. */
  async function attempt(
    over: Partial<AssignmentMode.AssignmentModeChange>,
  ): Promise<Refusal & { journal: JournalRow[] }> {
    await force('all_frozen', 'legacy');
    const top = await journalTop();
    const refusal = await refused(
      setMode(change({ targetWriteMode: 'all_frozen', targetReadMode: 'history', ...over })),
    );
    expect(await control()).toMatchObject({ read_mode: 'legacy', cutover_run_id: null });
    return { ...refusal, journal: await journalAfter(top) };
  }

  it('без поколения сверки', async () => {
    const attestationId = await seedAttestation();
    const refusal = await attempt({ runId: null, attestationId });
    expect(refusal.message).toMatch(/требует поколения/);
    expect(refusal.journal).toHaveLength(0);
  });

  it('без аттестации деплоя', async () => {
    const runId = await seedRun();
    const refusal = await attempt({ runId, attestationId: null });
    expect(refusal.message).toMatch(/требует аттестации/);
  });

  it('поколение, которого нет', async () => {
    const attestationId = await seedAttestation();
    const refusal = await attempt({
      runId: '00000000-0000-4000-8000-000000000000',
      attestationId,
    });
    expect(refusal.message).toMatch(/не найдено/);
  });

  it.each([['building'], ['running'], ['failed']])('поколение в состоянии %s', async (status) => {
    const { runId, attestationId } = await activationKit({ status });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/только completed/);
  });

  it('manifest построен не полностью', async () => {
    // Девяносто целей из ста: расхождений нет, но и проверено не всё (К1, Л2).
    const { runId, attestationId } = await activationKit({ checks: ['match'], expected: 2 });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/Manifest поколения неполон/);
  });

  it('поколение не досчитано', async () => {
    const { runId, attestationId } = await activationKit({ checks: ['match', 'pending'] });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/непроверенными/);
  });

  it('поколение зафиксировало расхождение', async () => {
    const { runId, attestationId } = await activationKit({ checks: ['match', 'mismatch'] });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/расхождений/);
  });

  it('поколение, пережившее полночь (О3)', async () => {
    const { runId, attestationId } = await activationKit({ asOf: shiftDateKey(today(), -1) });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/начинается заново/);
  });

  it('аттестация, потреблённая другим переходом', async () => {
    const { runId, attestationId } = await activationKit({}, { consumed: true });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/уже потреблена/);
  });

  it('аттестация старше своего окна', async () => {
    const stale = Math.round(ctx.mode.ATTESTATION_MAX_AGE_MS / 1000) + 60;
    const { runId, attestationId } = await activationKit({}, { ageSeconds: stale });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/не сегодняшний раскат/);
  });

  it('метрика насчитала старые клиентские вызовы (И5)', async () => {
    const { runId, attestationId } = await activationKit({}, { legacyCalls: 3 });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/старого маршрута/);
  });

  it('поколение получено сборкой, которой нет на площадке', async () => {
    const { runId, attestationId } = await activationKit({ buildVersion: 'build-позавчерашний' });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/нет среди раскатанных/);
  });

  it('переключает сборка, которой нет на площадке', async () => {
    const { runId, attestationId } = await activationKit();
    const refusal = await attempt({ runId, attestationId, buildSha: 'build-с-ноутбука' });
    expect(refusal.message).toMatch(/переключает не то, что работает/);
  });

  it('версия алгоритма поколения разошлась с раскатом', async () => {
    const { runId, attestationId } = await activationKit({ algoVersion: `${ALGO}-старый` });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/Версии алгоритма разошлись/);
  });

  it('версия алгоритма раската разошлась с дверью', async () => {
    const { runId, attestationId } = await activationKit({}, { algoVersion: `${ALGO}-будущий` });
    const refusal = await attempt({ runId, attestationId });
    expect(refusal.message).toMatch(/Версии алгоритма разошлись/);
  });

  it('где-то поднята метка загрязнения истории', async () => {
    const { runId, attestationId } = await activationKit();
    await withRequest({ dirty: true }, async () => {
      const refusal = await attempt({ runId, attestationId });
      expect(refusal.message).toMatch(/revalidation/);
    });
  });

  it('состояние заявки считалось не на день поколения (З1)', async () => {
    const { runId, attestationId } = await activationKit();
    await withRequest({ state: 'ready', validatedOn: shiftDateKey(today(), -1) }, async () => {
      const refusal = await attempt({ runId, attestationId });
      expect(refusal.message).toMatch(/revalidation не закончена/);
    });
  });

  /*
   * Три случая предиката Р20 — та самая дыра, которую нашла сводка: заявка в состоянии `empty`
   * проходила и метки, и пересчёт насквозь. Метки у неё нет, а из запроса устаревания `empty`
   * исключён явно — то есть обе прежние проверки о ней молчали, и портал после переключения читал
   * бы «кто и на чём работал» из пустоты.
   */
  it('заявка популяции без истории вовсе (Р20)', async () => {
    const { runId, attestationId } = await activationKit();
    await withPopulationRequest({ state: 'empty', assigned: true }, async () => {
      const refusal = await attempt({ runId, attestationId });
      expect(refusal.message).toMatch(/Предикат готовности Р20 не выполнен/);
      // Число названо — по нему оператор понимает объём работы, а не только факт отказа.
      expect(refusal.message).toMatch(/у 1 заявок популяции/);
      expect(refusal.message).toMatch(/1 без истории вовсе/);
      // И путь назван: массовый прогон, а невосстановимое — в блокирующий отчёт.
      expect(refusal.message).toMatch(/assignment:backfill/);
      expect(refusal.message).toMatch(/assignment:report/);
    });
  });

  it('заявка популяции без назначенной машины названа отдельно (Ю64)', async () => {
    const { runId, attestationId } = await activationKit();
    await withPopulationRequest({ state: 'empty', assigned: false }, async () => {
      const refusal = await attempt({ runId, attestationId });
      // У неё другой адресат: прогон её пропустит и в десятый раз, чинит её диспетчер.
      expect(refusal.message).toMatch(/1 без назначенной машины/);
      expect(refusal.message).toMatch(/диспетчер/);
    });
  });

  it('заявка популяции с историей, но без валидности (Р26)', async () => {
    const { runId, attestationId } = await activationKit();
    await withPopulationRequest({ state: 'materialized' }, async () => {
      const refusal = await attempt({ runId, attestationId });
      expect(refusal.message).toMatch(/1 с историей, но без валидности/);
    });
  });
});

// ── Журнал append-only (О5) ──

describe.skipIf(!DB_URL)('журнал переходов', () => {
  it('запись перехода не правится и не удаляется', async () => {
    await force('normal', 'legacy');
    const top = await journalTop();
    await setMode(
      change({ targetWriteMode: 'history_frozen', reason: 'откат: история заморожена' }),
    );
    const [written] = await journalAfter(top);
    expect(written).toBeDefined();

    const updated = await refusedBySql(sql`
      UPDATE assignment_periods_mode_transitions SET reason = 'подделка' WHERE id = ${written!.id}`);
    expect(updated).toMatch(/неизменяем/);

    const deleted = await refusedBySql(
      sql`DELETE FROM assignment_periods_mode_transitions WHERE id = ${written!.id}`,
    );
    expect(deleted).toMatch(/неизменяем/);

    // Строка на месте и с прежней причиной: доказательство, которое можно поправить, ничего не
    // доказывает.
    const [after] = await journalAfter(top);
    expect(after?.reason).toBe('откат: история заморожена');
  });
});

// ── Гейт пишущих дверей (§10, И1) ──

describe.skipIf(!DB_URL)('гейт пишущих дверей', () => {
  async function tryDoor(door: AssignmentMode.AssignmentDoorClass): Promise<Refusal | null> {
    try {
      await ctx.db.transaction(async (tx) => {
        await ctx.mode.requireOpenDoor(tx, door);
      });
      return null;
    } catch (e) {
      const error = e as Partial<Refusal>;
      return {
        statusCode: error.statusCode ?? 0,
        code: error.code ?? 'unknown',
        message: (e as Error).message,
      };
    }
  }

  it('в обычном режиме открыты обе двери', async () => {
    await force('normal', 'legacy');
    expect(await tryDoor('history')).toBeNull();
    expect(await tryDoor('history_free')).toBeNull();
  });

  it('history_frozen закрывает историю и оставляет ручную выписку и смены (И1)', async () => {
    await force('history_frozen', 'legacy');
    const refusal = await tryDoor('history');
    expect(refusal?.statusCode).toBe(503);
    expect(refusal?.code).toBe('assignment_mode_frozen');
    expect(refusal?.message).toMatch(/заморожена история/);
    expect(await tryDoor('history_free')).toBeNull();
  });

  it('all_frozen закрывает и то и другое', async () => {
    await force('all_frozen', 'legacy');
    expect((await tryDoor('history'))?.statusCode).toBe(503);
    expect((await tryDoor('history_free'))?.statusCode).toBe(503);
  });
});

// ── Freeze как drain: два соединения (Ж3) ──

describe.skipIf(!DB_URL)('писатель под FOR SHARE не даёт сменить режим', () => {
  /** Сколько ждать, пока дверь встанет в очередь за держателем: барьер, а не пауза «на глазок». */
  const BLOCK_TIMEOUT_MS = 15_000;

  it('смена режима ждёт коммита писателя, а второй писатель проходит сразу', async () => {
    await force('normal', 'legacy');

    // Писатель: та самая первая строка пишущей транзакции (шаг 0 канонического порядка).
    const writer = new pg.Client({ connectionString: ctx.ownUrl });
    await writer.connect();
    const probe = new pg.Client({ connectionString: ctx.ownUrl });
    await probe.connect();
    try {
      const {
        rows: [me],
      } = await writer.query<{ pid: number }>('select pg_backend_pid() as pid');
      await writer.query('begin');
      await writer.query(
        'select write_mode from assignment_periods_control where id = true for share',
      );

      // Второй писатель под `FOR SHARE` проходит сразу: shared-блокировки совместимы, и гейт не
      // сериализует работу портала — он ждёт только оператора.
      const second = new pg.Client({ connectionString: ctx.ownUrl });
      await second.connect();
      try {
        await second.query('begin');
        await second.query(
          "set local lock_timeout = '2s'; select write_mode from assignment_periods_control where id = true for share",
        );
        await second.query('commit');
      } finally {
        await second.end();
      }

      // Дверь стартует и обязана встать в очередь: `FOR UPDATE` несовместим с `FOR SHARE`.
      const door = setMode(
        change({ targetWriteMode: 'all_frozen', reason: 'cutover: заморозка перед прогоном' }),
      );
      const settled = door.then(
        (record) => ({ record, error: null as unknown }),
        (error: unknown) => ({ record: null, error }),
      );

      const startedAt = Date.now();
      let blocked = false;
      while (Date.now() - startedAt < BLOCK_TIMEOUT_MS) {
        const { rows } = await probe.query<{ pid: number }>(
          `select pid from pg_stat_activity
            where datname = current_database() and $1 = any(pg_blocking_pids(pid))`,
          [me!.pid],
        );
        if (rows.length > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);

      // И она именно ждёт, а не успела пройти: `Promise.race` с немедленным маркером показывает,
      // что дверь всё ещё в очереди, а не проскочила мимо писателя за время опроса.
      const pending = Symbol('дверь ещё ждёт');
      expect(await Promise.race([settled, Promise.resolve(pending)])).toBe(pending);

      // Пока писатель держит строку, режим прежний — freeze дожидается его, а не наоборот.
      const {
        rows: [before],
      } = await probe.query<ControlRow>(
        'select write_mode, read_mode, cutover_run_id from assignment_periods_control where id = true',
      );
      expect(before?.write_mode).toBe('normal');

      await writer.query('commit');

      const outcome = await settled;
      expect(outcome.error).toBeNull();
      expect(outcome.record?.to.writeMode).toBe('all_frozen');
      expect((await control()).write_mode).toBe('all_frozen');
    } finally {
      await writer.end().catch(() => undefined);
      await probe.end().catch(() => undefined);
    }
  }, 30_000);
});
