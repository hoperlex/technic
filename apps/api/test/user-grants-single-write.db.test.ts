import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleAddon } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as UserScopesNs from '../src/services/user-scopes';

/**
 * Единственный писатель назначений (ADR 0106, шаг 1d; план реструктуризации §15) — на живой схеме.
 *
 * До этого шага файл назывался `user-grants-dual-write.db.test.ts` и проверял двойную запись: та же
 * надстройка заводила строку и в `user_role_addons`, и в `user_grants`. Запись в старую таблицу
 * прекращена, поэтому и утверждение теста стало обратным — её строк правка учётки не заводит и не
 * убирает вовсе, — а имя файла обязано называть проверяемое свойство, а не бывшее.
 *
 * Зачем база. Предмет теста и есть база: `replaceUserAddons` пишет разницу строками, и всё, что
 * здесь проверяется, — их свойства, которых на подменах не существует. Собственный `id` назначения
 * выдаёт `gen_random_uuid()`, время выдачи — умолчание `now()`, повторную выдачу гасит
 * `UNIQUE (user_id, grant_id)`, а сами системные наборы завела миграция 0145. Мок ответил бы
 * «функция вызвана» на любую из ошибок, ради которых шаг и написан так.
 *
 * **Главных утверждений здесь два.**
 *
 * Первое — разница считается **от назначений**. С прекращением записи `user_role_addons` перестала
 * что-либо описывать, и читай `addonsOfUser` по-прежнему её, каждая правка карточки считала бы
 * разницу от мёртвого состояния: снятая надстройка возвращалась бы, а выданную нельзя было бы
 * снять. Ловят это два теста — снятие и легаси-строка в старой таблице, которая на разницу влиять
 * не должна.
 *
 * Второе — добавление второй надстройки **не трогает первую**. Запись «снести всё и вставить
 * заново» прошла бы остальные проверки и при этом каждый раз выдавала бы уцелевшему назначению
 * новый `id`, нового автора и новое время. На неизменности `id` держится откат будущего перевода
 * ролей: он снимает свои строки и не трогает выданное вручную, а найти их он может только по
 * идентификаторам.
 *
 * Рядом проверяется граница пути надстроек: собранный администратором набор он не снимает. Разница
 * берётся не из всех кодов учётки, а из пересечения с системными (`systemAddonsOf`), и без этого
 * фильтра сохранение карточки отзывало бы всё, что выдали реестром.
 *
 * Чтение прав здесь не проверяется намеренно: `can` и выражения источника — предмет
 * `access-matrix` и `user-grants-read.db.test.ts`.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/user-grants-single-write.db.test.ts
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
const EMAIL_PREFIX = 'db-user-grants-single-write';
/** Метка своего набора: собранный администратором набор заводится тестом и убирается по этой же. */
const GRANT_PREFIX = 'db-user-grants-single-write';

const OPERATOR: RoleAddon = 'office_equipment_operator';
const IT_APPROVER: RoleAddon = 'office_equipment_it_approver';

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof UserScopesNs;
  closeDb: () => Promise<void>;
  /** Кто выдаёт: двое, чтобы `granted_by` уцелевшего назначения было с чем спутать. */
  adminId: string;
  otherAdminId: string;
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
  // Почта тут ни при чём: тест зовёт сервис напрямую, мимо маршрутов учёток.
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
 * Уборка своих строк — и перед прогоном тоже. Учёток достаточно: назначения и надстройки уходят
 * каскадом (`user_grants.user_id`, `user_role_addons.user_id` — оба `ON DELETE CASCADE`), а
 * `granted_by` у чужих строк каскад не трогает вовсе.
 *
 * Свой набор удаляется после учёток: `grant_id` стоит под RESTRICT, и выданный набор не удалить,
 * пока жив хоть один держатель.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`}`);
}

/** Подопытная учётка: роль `shtab` — та, которой надстройки и положены (`ROLE_ADDON_BASE_ROLES`). */
async function newUser(role: 'shtab' | 'admin' = 'shtab'): Promise<string> {
  userSeq += 1;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${RUN}-${userSeq}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: `Надстроечный ${userSeq}`,
      // Входа здесь нет: тест зовёт сервис напрямую, пароль не участвует.
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
    })
    .returning({ id: ctx.schema.users.id });
  return created!.id;
}

/** Транзакция пула — тот же тип, что маршрут передаёт сервису. */
type Tx = Parameters<Parameters<typeof AppDb.transaction>[0]>[0];
/** Соединение, которым идёт шаг сценария: пул или транзакция, если сценарий живёт в одной. */
type Reader = typeof AppDb | Tx;

/**
 * Правка набора надстроек так, как её делает маршрут учёток.
 *
 * Транзакция своя, если её не дали снаружи: маршрут открывает её сам и передаёт сервису готовой,
 * поэтому оба способа вызова здесь равноправны, а сценарий, которому нужна **одна** транзакция на
 * все шаги, приносит её с собой (см. `inRolledBackTx`).
 */
async function setAddons(
  userId: string,
  addons: RoleAddon[],
  actorUserId: string,
  tx?: Tx,
): Promise<boolean> {
  return tx
    ? ctx.service.replaceUserAddons(tx, userId, addons, actorUserId)
    : ctx.db.transaction((own) => ctx.service.replaceUserAddons(own, userId, addons, actorUserId));
}

/** Старая таблица: с шага 1d правка учётки её не касается, и проверяется здесь именно это. */
async function addonRows(userId: string, reader: Reader = ctx.db): Promise<RoleAddon[]> {
  const rows = await reader
    .select({ addon: ctx.schema.userRoleAddons.addon })
    .from(ctx.schema.userRoleAddons)
    .where(eq(ctx.schema.userRoleAddons.userId, userId))
    .orderBy(asc(ctx.schema.userRoleAddons.addon));
  return rows.map((row) => row.addon);
}

/**
 * Сценарий целиком в одной транзакции, которую в конце откатывают.
 *
 * Нужно это ровно одному тесту — тому, что заводит легаси-строку `user_role_addons` **без** парного
 * назначения, — и причина не в чистоте, а в соседях по базе. `backfill-grants.db.test.ts` гоняет
 * настоящий перенос по всей таблице, файлы vitest идут параллельно, и попади перенос в это окно —
 * он честно сделает свою работу: заведёт по легаси-строке назначение. Тест покраснеет на ровном
 * месте, и виноват будет не он.
 *
 * Развести их можно только тем свойством, на котором держится сам перенос: он берёт
 * `LOCK TABLE user_role_addons IN SHARE MODE` и потому видит лишь **зафиксированные** правки
 * надстроек — «начатая до нас к этой секунде зафиксировала обе стороны, начатая после — ждёт»
 * (`src/backfill-grants.ts`). Половинчатое состояние, живущее внутри незакоммиченной транзакции,
 * переносу не видно ни при каком расписании, а откат не оставляет от него следа. Порядок файлов или
 * `fileParallelism: false` чинили бы то же самое ценой всего прогона и держались бы на честном
 * слове.
 *
 * Откат — исключением, а не `tx.rollback()`: то бросает своё, и отличать его от настоящей ошибки
 * теста пришлось бы по типу чужого модуля.
 */
async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  class Rollback extends Error {}
  try {
    await ctx.db.transaction(async (tx) => {
      await body(tx);
      throw new Rollback('сценарий закончен, откатываемся');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

interface GrantRow {
  id: string;
  code: string;
  grantedBy: string | null;
  grantedAt: Date;
  origin: string;
  migrationId: string | null;
}

/**
 * Назначения, прочитанные по коду набора: строка ссылается на `grants.id`, а сопоставляется с
 * надстройкой именно код — тот самый, который запись и ищет.
 */
async function grantRows(userId: string, reader: Reader = ctx.db): Promise<GrantRow[]> {
  return reader
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
    .where(eq(ctx.schema.userGrants.userId, userId))
    .orderBy(asc(ctx.schema.grants.code));
}

/** Идентификатор системного набора по коду — им же тест выдаёт назначение мимо пути надстроек. */
async function grantIdByCode(code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: ctx.schema.grants.id })
    .from(ctx.schema.grants)
    .where(eq(ctx.schema.grants.code, code));
  return row!.id;
}

describe.skipIf(!DB_URL)('назначения: единственный писатель (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/user-scopes');
    await cleanup(db);

    ctx = {
      db,
      schema,
      service,
      closeDb,
      adminId: '',
      otherAdminId: '',
    };
    ctx.adminId = await newUser('admin');
    ctx.otherAdminId = await newUser('admin');

    // Системные наборы завела миграция 0145, и без них выдавать надстройку некуда. Если их нет —
    // сломан не тест, а накат: пусть это будет видно здесь, а не в чужом ожидании.
    const codes = await db
      .select({ code: schema.grants.code })
      .from(schema.grants)
      .orderBy(asc(schema.grants.code));
    const present = new Set(codes.map((row) => row.code));
    for (const code of [OPERATOR, IT_APPROVER]) {
      if (!present.has(code)) throw new Error(`В базе нет системного набора «${code}»`);
    }
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await cleanup(ctx.db);
      await ctx.closeDb();
    }
  });

  it('выдача надстройки заводит назначение и не пишет в старую таблицу', async () => {
    const userId = await newUser();
    expect(await setAddons(userId, [OPERATOR], ctx.adminId)).toBe(true);

    const granted = await grantRows(userId);
    expect(granted).toHaveLength(1);
    expect(granted[0]!.code).toBe(OPERATOR);
    // `manual` — выдал администратор. `migration` зарезервирован за переводом ролей, и колонка
    // перевода здесь обязана оставаться пустой: писателя у неё в этом пути нет вовсе.
    expect(granted[0]!.origin).toBe('manual');
    expect(granted[0]!.migrationId).toBeNull();
    expect(granted[0]!.grantedBy).toBe(ctx.adminId);

    // Главное отличие шага 1d от 1a: старая таблица не заполняется. Строка в ней означала бы, что
    // прекращение записи не состоялось, — а обнаружилось бы это только на удалении таблицы (1e).
    expect(await addonRows(userId)).toEqual([]);
  });

  /**
   * Второе главное утверждение. Вторая надстройка выдаётся **другим** администратором и другой
   * транзакцией: пересоздание уцелевшей строки выдало бы себя тремя способами сразу — новым `id`,
   * чужим автором и более поздним временем.
   */
  it('добавление второй надстройки не трогает назначение первой', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR], ctx.adminId);
    const [before] = await grantRows(userId);

    expect(await setAddons(userId, [OPERATOR, IT_APPROVER], ctx.otherAdminId)).toBe(true);

    const after = await grantRows(userId);
    expect(after.map((row) => row.code)).toEqual([IT_APPROVER, OPERATOR]);
    const operator = after.find((row) => row.code === OPERATOR)!;
    expect(operator.id).toBe(before!.id);
    expect(operator.grantedAt.getTime()).toBe(before!.grantedAt.getTime());
    expect(operator.grantedBy).toBe(ctx.adminId);

    // Новое назначение — своё во всём: свой идентификатор, свой автор, своё время.
    const approver = after.find((row) => row.code === IT_APPROVER)!;
    expect(approver.id).not.toBe(before!.id);
    expect(approver.grantedBy).toBe(ctx.otherAdminId);
    expect(approver.grantedAt.getTime()).toBeGreaterThan(before!.grantedAt.getTime());
  });

  /**
   * Снятие — и есть проверка того, что состояние читается из назначений. Читай `addonsOfUser`
   * мёртвую `user_role_addons`, `before` вышло бы пустым: снимать было бы нечего, а `IT_APPROVER`
   * выглядел бы новой выдачей — то есть правка не сняла бы ничего и вернула бы обе надстройки.
   */
  it('снятие одной надстройки удаляет ровно её назначение', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR, IT_APPROVER], ctx.adminId);
    const kept = (await grantRows(userId)).find((row) => row.code === IT_APPROVER)!;

    expect(await setAddons(userId, [IT_APPROVER], ctx.otherAdminId)).toBe(true);

    const after = await grantRows(userId);
    expect(after.map((row) => row.code)).toEqual([IT_APPROVER]);
    // Уцелевшее назначение — то же самое, а не выданное заново вместо снятого соседа.
    expect(after[0]!.id).toBe(kept.id);
    expect(after[0]!.grantedAt.getTime()).toBe(kept.grantedAt.getTime());
    // Снятое не возвращается следующей же правкой: разницы больше нет, и писать нечего.
    expect(await setAddons(userId, [IT_APPROVER], ctx.adminId)).toBe(false);
  });

  /**
   * Легаси-строка старой таблицы — та самая, что осталась у живых учёток от шагов 1a–1c. С шага 1d
   * она не значит ничего: ни на разницу не влияет, ни убираться не должна. Второе не мелочь —
   * `user_role_addons` живёт до 1e, и до тех пор она свидетельство прошлых выдач (`granted_by`,
   * `granted_at`), которым объясняется история доступа; чистка «за компанию» уносила бы его молча.
   *
   * **Сценарий целиком идёт одной откатываемой транзакцией**, и это не оформление, а развод с
   * соседом по общей базе: половинчатое состояние «надстройка без назначения» — ровно то, что
   * переносит `backfill-grants`, и параллельный прогон переноса завёл бы по нашей строке назначение
   * между шагами. Почему транзакции достаточно и почему её хватает надёжнее порядка файлов —
   * см. `inRolledBackTx`.
   */
  it('надстройка в старой таблице не считается выданной и не убирается', async () => {
    const userId = await newUser();

    await inRolledBackTx(async (tx) => {
      await tx
        .insert(ctx.schema.userRoleAddons)
        .values({ userId, addon: OPERATOR, grantedBy: ctx.adminId });

      // Назначений нет — снимать нечего, сколько бы строк ни лежало в старой таблице.
      expect(await setAddons(userId, [], ctx.otherAdminId, tx)).toBe(false);
      expect(await grantRows(userId, tx)).toHaveLength(0);

      // И выдать ту же надстройку она не мешает: разница считается не по ней.
      expect(await setAddons(userId, [OPERATOR], ctx.otherAdminId, tx)).toBe(true);
      expect((await grantRows(userId, tx)).map((row) => row.code)).toEqual([OPERATOR]);
      expect(await addonRows(userId, tx)).toEqual([OPERATOR]);
    });

    // Откат ничего не оставил — ни в новой таблице, ни в старой: свидетелей у сценария нет.
    expect(await grantRows(userId)).toHaveLength(0);
    expect(await addonRows(userId)).toEqual([]);
  });

  /**
   * Граница пути надстроек. Собранный администратором набор выдан реестром — прямой строкой
   * `user_grants`, как её заводит `grant-catalog`, — и путь `addons` про него ничего не знает:
   * разница берётся из пересечения кодов с системными (`systemAddonsOf`). Возьмись она из всех
   * кодов учётки, сохранение карточки без поля «Надстройки» отзывало бы всё, что выдали реестром, —
   * и снятие доступа выглядело бы правкой телефона.
   */
  it('собранный администратором набор путь надстроек не снимает', async () => {
    const userId = await newUser();
    const [assembled] = await ctx.db
      .insert(ctx.schema.grants)
      .values({ code: `${GRANT_PREFIX}-assembled-${RUN}`, name: 'Собранный набор' })
      .onConflictDoNothing()
      .returning({ id: ctx.schema.grants.id });
    const assembledId = assembled?.id ?? (await grantIdByCode(`${GRANT_PREFIX}-assembled-${RUN}`));
    await ctx.db
      .insert(ctx.schema.userGrants)
      .values({ userId, grantId: assembledId, grantedBy: ctx.adminId, origin: 'manual' });

    // Выдача надстройки соседний набор не трогает…
    expect(await setAddons(userId, [OPERATOR], ctx.adminId)).toBe(true);
    expect((await grantRows(userId)).map((row) => row.code)).toContain(
      `${GRANT_PREFIX}-assembled-${RUN}`,
    );

    // …и снятие всех надстроек — тоже: он не надстройка, и в поле формы его не было.
    expect(await setAddons(userId, [], ctx.otherAdminId)).toBe(true);
    expect((await grantRows(userId)).map((row) => row.code)).toEqual([
      `${GRANT_PREFIX}-assembled-${RUN}`,
    ]);
  });

  /**
   * Назначение, заведённое мимо пути надстроек, для него — уже выданное: разница считается по
   * назначениям, а не по тому, кто их создал. Второй строки той же пары не появляется, и прежняя не
   * переписывается — ни автором, ни временем.
   */
  it('уже выданный системный набор второй раз не назначается', async () => {
    const userId = await newUser();
    await ctx.db.insert(ctx.schema.userGrants).values({
      userId,
      grantId: await grantIdByCode(OPERATOR),
      grantedBy: ctx.adminId,
      origin: 'manual',
    });
    const [before] = await grantRows(userId);

    expect(await setAddons(userId, [OPERATOR], ctx.otherAdminId)).toBe(false);

    const after = await grantRows(userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.grantedAt.getTime()).toBe(before!.grantedAt.getTime());
    expect(after[0]!.grantedBy).toBe(ctx.adminId);
  });

  /**
   * Отзыв и новая выдача — это новое назначение, а не воскрешение прежнего (ADR 0106, решение 3).
   * Переиспользование `id` сделало бы откат перевода ролей слепым: он снял бы строку, которую
   * администратор выдал заново по своей причине.
   */
  it('выданная заново надстройка получает новый идентификатор', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR], ctx.adminId);
    const [first] = await grantRows(userId);

    await setAddons(userId, [], ctx.adminId);
    expect(await grantRows(userId)).toHaveLength(0);

    await setAddons(userId, [OPERATOR], ctx.otherAdminId);
    const [second] = await grantRows(userId);
    expect(second!.id).not.toBe(first!.id);
    expect(second!.grantedBy).toBe(ctx.otherAdminId);
    expect(second!.origin).toBe('manual');
  });

  it('набор без изменений не пишет ничего', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR, IT_APPROVER], ctx.adminId);
    const before = await grantRows(userId);

    // Порядок другой, состав тот же — разницы нет, и трогать нечего.
    expect(await setAddons(userId, [IT_APPROVER, OPERATOR], ctx.otherAdminId)).toBe(false);

    expect(await grantRows(userId)).toEqual(before);
  });

  /**
   * Атомарность записи. Назначение, пережившее откат правки, означало бы доступ, выданный
   * операцией, которая не удалась: транзакцию открывает маршрут, и рядом с надстройками в ней
   * правятся область, работник и сама строка учётки. Здесь она падает после вызова сервиса — как
   * упала бы правка учётки на любой следующей проверке.
   */
  it('откат транзакции не оставляет назначения', async () => {
    const userId = await newUser();
    await setAddons(userId, [OPERATOR], ctx.adminId);

    await expect(
      ctx.db.transaction(async (tx) => {
        await ctx.service.replaceUserAddons(tx, userId, [OPERATOR, IT_APPROVER], ctx.adminId);
        throw new Error('правка учётки не удалась');
      }),
    ).rejects.toThrow('правка учётки не удалась');

    expect((await grantRows(userId)).map((row) => row.code)).toEqual([OPERATOR]);
  });
});
