import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoleAddon } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Запись назначений на настоящих путях учётки (ADR 0106, решение 9, шаги 1a–1d) — через HTTP, на
 * живой схеме.
 *
 * **Чем этот файл отличается от `user-grants-single-write.db.test.ts`.** Тот зовёт
 * `replaceUserAddons` напрямую, своей транзакцией, и проверяет свойства строк. Заявление шага 1a
 * шире: «во всех путях вызова запись идёт транзакцией самой правки», — а путей у сервиса три, и все
 * три живут в `routes/users.ts`: заведение учётки (`POST /users`), правка (`PATCH /users/:id`) и
 * рассмотрение заявки на регистрацию (тот же `PATCH` с объявленным намерением). До этого файла
 * заявление держалось чтением кода: ни один тест не входил в маршрут учёток вовсе.
 *
 * **Что ловится только отсюда.** Транзакцию открывает маршрут, а не сервис — `tx` приходит
 * снаружи, — и правку учётки составляют ещё пять действий рядом: область, работник, строка
 * `users`, `authVersion`, письмо. Порядок и границы этой транзакции сервису не видны: вынеси
 * запись назначений в свой `db.transaction`, забудь дождаться его `await`, поставь его после
 * коммита — тест сервиса пройдёт целиком. Здесь же проверяется то, чего у сервиса нет вовсе:
 * `granted_by` берётся из принципала запроса (а не из первого попавшегося администратора),
 * несовместимость возвращает 400 и **не оставляет строк**, а сменившийся набор поднимает
 * `authVersion` — то есть гасит выданные токены. Последнее и связывает выдачу с безопасностью:
 * назначение, записанное без отзыва токенов, начинает действовать не тогда, когда его выдали.
 *
 * **Что изменил шаг 1d.** Единственным писателем назначений стал `applyAddonGrants`, а
 * `user_role_addons` не пишется вовсе — и утверждений о её строках здесь не осталось: доказывали бы
 * они теперь не запись, а её отсутствие, и предмет этот чужой (`user-grants-single-write`). Заодно
 * лишились второй половины две сверки времени: «одна транзакция — одно время» сравнивало отметки
 * двух таблиц, а сравнивать стало не с чем. Обе переформулированы на соседнюю строку, которую та же
 * транзакция датирует своим `now()`, — саму учётку при заведении и запись журнала о рассмотрении
 * заявки.
 *
 * **Что добавилось на шаге 1c.** Витрина учёток (карточка и список) читает пометки рядом с ролью из
 * назначенных полномочий — и проверяется это здесь же, потому что источник у неё тот же самый
 * маршрут. Прав по новой схеме файл по-прежнему не касается: `can`
 * проверяют `access-matrix` и `access-scope`, состав системных наборов — `grants-catalog.db.test.ts`,
 * перенос — `backfill-grants.db.test.ts`, сами выражения чтения — `user-grants-read.db.test.ts`.
 *
 * **Общий прогон.** Свой префикс адресов, уборка до и после по нему же; ни одного утверждения обо
 * всей базе — все выборки идут по идентификатору своей учётки.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/user-grants-routes.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Метка своих учёток: уборка идёт по ней, а не «по последним строкам». Префикс общий на все
 * прогоны — упавший прогон обязан убираться следующим, а не копить учётки в общей базе.
 */
const EMAIL_PREFIX = 'db-user-grants-routes';
/** Метка своих наборов: собранный администратором набор заводится тестом и убирается по этой же. */
const GRANT_PREFIX = 'db-user-grants-routes';
/** Уникальный хвост прогона: адрес занимает действующая учётка, и два прогона не должны спорить. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;

const ADMIN_PASSWORD = 'db-test-password-123';
/** Пароль подопытной учётки: приметы адреса и ФИО в него попасть не должны (`passwordSchema`). */
const USER_PASSWORD = 'db-holder-secret-456';

const OPERATOR: RoleAddon = 'office_equipment_operator';
const IT_APPROVER: RoleAddon = 'office_equipment_it_approver';

/** Администратор со своим токеном: `granted_by` обязано называть того, от чьего имени шёл запрос. */
interface Admin {
  id: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  /** Двое, чтобы автора уцелевшего назначения было с кем спутать. */
  admin: Admin;
  otherAdmin: Admin;
  /** Площадка: у объектной роли область обязательна (ADR 0039), а надстройки — у роли `site`. */
  objectId: string;
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
  // Письма здесь ни при чём: проверяются назначения, и `notifyUser: false` идёт в каждом запросе.
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
 * Уборка своих учёток — и перед прогоном тоже. Записи журнала уходят первыми: `entity_id` там
 * текстовый и каскадом не убирается, а `actor_user_id` стоит под `SET NULL` и удаление
 * администратора не тронет. Остальное каскадом от `users`: и надстройки, и назначения объявлены
 * `ON DELETE CASCADE` по `user_id`.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'user' AND entity_id IN (
    SELECT id::text FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  // Свой набор «как у администратора» (проверка витрины ниже) — после учёток: `grant_id` стоит под
  // RESTRICT, и выданный набор не удаляется, пока жив хоть один держатель.
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`}`);
}

/** Администратор с настоящим входом: маршруты учёток ходят под правом `users.manage`. */
async function newAdmin(suffix: string): Promise<Admin> {
  const email = `${EMAIL_PREFIX}-admin-${suffix}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: '',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: ADMIN_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const { accessToken } = login.json<{ accessToken: string }>();
  return { id: created!.id, auth: { authorization: `Bearer ${accessToken}` } };
}

function freshEmail(): string {
  userSeq += 1;
  return `${EMAIL_PREFIX}-${RUN}-${userSeq}@example.invalid`;
}

/*
 * Тело заведения учётки: роль `site` на своей площадке — та, которой надстройки и положены.
 *
 * Не `shtab`, хотя надстройки заводились под него: шаг prepare этапа 8 (ADR 0113) закрыл вход в
 * упраздняемые роли, и заведение штаба маршрутом отвечает теперь 400. Роль перевода на этом месте
 * честнее прежней — именно с ней надстройка и будет жить после перевода.
 */
function accountPayload(
  email: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email,
    lastName: 'Тестовый',
    firstName: 'Держатель',
    middleName: '',
    phone: '',
    password: USER_PASSWORD,
    role: 'site',
    isActive: true,
    constructionObjectIds: [ctx.objectId],
    addons: [],
    notifyUser: false,
    ...over,
  };
}

function postUser(admin: Admin, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: admin.auth,
    payload,
  });
}

function patchUser(admin: Admin, id: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/users/${id}`,
    headers: admin.auth,
    payload,
  });
}

/** Заведение учётки маршрутом: возвращает то, о чём потом спрашивают базу. */
async function createAccount(
  admin: Admin,
  over: Record<string, unknown> = {},
): Promise<{ id: string; email: string }> {
  const email = freshEmail();
  const res = await postUser(admin, accountPayload(email, over));
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json<{ user: { id: string } }>().user.id, email };
}

/**
 * Заявка на регистрацию: неактивная учётка без роли (ADR 0034). Заводится вставкой, а не
 * `POST /auth/register`, — предмет проверки здесь рассмотрение, а не саморегистрация с капчей.
 */
async function newRegistration(): Promise<string> {
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: freshEmail(),
      lastName: 'Заявкин',
      firstName: 'Пётр',
      middleName: '',
      passwordHash: 'db-test-not-a-hash',
      role: null,
      isActive: false,
      requestedRole: 'site_staff',
      requestedObject: 'Площадка из заявки',
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return created!.id;
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
 * Реестр выдач, прочитанный по коду набора: назначение ссылается на `grants.id`, а сопоставляется с
 * надстройкой именно код — тот самый, который ищет и выдача (`applyAddonGrants`).
 */
async function grantRows(userId: string): Promise<GrantRow[]> {
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
    .where(eq(ctx.schema.userGrants.userId, userId))
    .orderBy(asc(ctx.schema.grants.code));
}

/** Пометки рядом с ролью в карточке учётки — то, чем витрина отвечает на «что человеку выдано». */
async function cardAddons(admin: Admin, id: string): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/users/${id}`,
    headers: admin.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ user: { addons: string[] } }>().user.addons;
}

/** То же поле в списке: список и карточка обязаны отвечать одинаково — источник у них один. */
async function listAddons(admin: Admin, id: string, email: string): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/users?search=${encodeURIComponent(email)}`,
    headers: admin.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const items = res.json<{ items: { id: string; addons: string[] }[] }>().items;
  const own = items.find((row) => row.id === id);
  expect(own, `учётка ${email} в списке`).toBeDefined();
  return own!.addons;
}

/**
 * Набор, собранный администратором (ADR 0106, этап 2): системным кодам он не равен и в пометки
 * попадать не должен. Заводится прямой вставкой — конструктора наборов ещё нет, а форма учётки
 * такой код не примет вовсе (`roleAddonsSchema` — enum), и в этом вся суть проверки.
 */
async function assembleGrantFor(userId: string, admin: Admin): Promise<string> {
  const code = `${GRANT_PREFIX}-assembled-${RUN}`;
  const [grant] = await ctx.db
    .insert(ctx.schema.grants)
    .values({ code, name: 'Собранный набор', createdBy: admin.id })
    .onConflictDoNothing()
    .returning({ id: ctx.schema.grants.id });
  const grantId =
    grant?.id ??
    (
      await ctx.db
        .select({ id: ctx.schema.grants.id })
        .from(ctx.schema.grants)
        .where(eq(ctx.schema.grants.code, code))
    )[0]!.id;
  await ctx.db
    .insert(ctx.schema.userGrants)
    .values({ userId, grantId, grantedBy: admin.id, origin: 'manual' })
    .onConflictDoNothing();
  return code;
}

/**
 * Время строки учётки. Ставит его умолчание базы (`created_at ... defaultNow()`), то есть `now()`
 * транзакции, — и потому оно годится в свидетели той самой транзакции, которой заведена учётка.
 * До шага 1d ту же роль играла отметка второй таблицы, но писателей у назначений теперь один.
 */
async function userCreatedAt(userId: string): Promise<Date> {
  const [row] = await ctx.db
    .select({ createdAt: ctx.schema.users.createdAt })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  return row!.createdAt;
}

/**
 * Время записи журнала об этом решении — свидетель транзакции там, где учётка заведена раньше и её
 * `created_at` ни о чём не говорит. `audit_log.created_at` — то же умолчание базы, а пишется запись
 * тем же `writeAuditTx` внутри транзакции маршрута.
 */
async function auditCreatedAt(userId: string, action: string): Promise<Date> {
  const [row] = await ctx.db
    .select({ createdAt: ctx.schema.auditLog.createdAt })
    .from(ctx.schema.auditLog)
    .where(
      and(
        eq(ctx.schema.auditLog.entityType, 'user'),
        eq(ctx.schema.auditLog.entityId, userId),
        eq(ctx.schema.auditLog.action, action),
      ),
    );
  expect(row, `запись журнала «${action}» об учётке ${userId}`).toBeDefined();
  return row!.createdAt;
}

/** Роль и версия прав учётки: по второй сверяется гашение выданных токенов. */
async function userRow(userId: string): Promise<{ role: string | null; authVersion: number }> {
  const [row] = await ctx.db
    .select({ role: ctx.schema.users.role, authVersion: ctx.schema.users.authVersion })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  return { role: row!.role, authVersion: row!.authVersion };
}

/**
 * Что осталось в базе от адреса, по которому отказали. Считается по самому адресу, а не по
 * идентификатору: у отклонённого заведения идентификатора нет вовсе, и «строк нет» приходится
 * спрашивать той стороной, которая у нас есть.
 */
async function rowsFor(email: string): Promise<{ users: number; grants: number }> {
  const res = await ctx.db.execute<{ users: string; grants: string }>(sql`
    SELECT
      (SELECT count(*) FROM users WHERE email = ${email})::text AS users,
      (SELECT count(*) FROM user_grants ug JOIN users u ON u.id = ug.user_id
        WHERE u.email = ${email})::text AS grants`);
  const row = res.rows[0]!;
  return { users: Number(row.users), grants: Number(row.grants) };
}

describe.skipIf(!DB_URL)('назначения на путях учётки: маршруты, а не сервис (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    await cleanup(db);

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
    );
    if (objects.rows.length === 0) {
      throw new Error(
        'В базе нет ни одного действующего объекта: миграции наполнения не применены',
      );
    }

    ctx = {
      app,
      db,
      schema,
      closeDb,
      admin: { id: '', auth: { authorization: '' } },
      otherAdmin: { id: '', auth: { authorization: '' } },
      objectId: objects.rows[0]!.id,
    };
    ctx.admin = await newAdmin('one');
    ctx.otherAdmin = await newAdmin('two');

    // Системные наборы завела миграция 0145, и без них выдаче некуда вставлять назначение.
    // Если их нет — сломан не тест, а накат: пусть это будет видно здесь, а не в чужом ожидании.
    const present = new Set(
      (await db.select({ code: schema.grants.code }).from(schema.grants)).map((row) => row.code),
    );
    for (const code of [OPERATOR, IT_APPROVER]) {
      if (!present.has(code)) throw new Error(`В базе нет системного набора «${code}»`);
    }
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  /**
   * Первый путь вызова. Без этой проверки заведение учётки с надстройкой могло бы не завести
   * назначения вовсе: с шага 1d другого следа у выданной надстройки нет — карточка сохранилась бы с
   * пометкой в форме, а прав человеку не досталось бы, и объяснить это администратору было бы
   * нечем.
   *
   * `granted_by` сверяется с администратором, от чьего имени шёл запрос: сервис берёт автора
   * параметром, и подставить туда, например, владельца правимой учётки маршрут может незаметно —
   * тест сервиса передаёт этот параметр сам и такую подмену не увидит.
   */
  it('заведение учётки с надстройкой заводит назначение', async () => {
    const { id } = await createAccount(ctx.admin, { addons: [OPERATOR] });

    const granted = await grantRows(id);
    expect(granted).toHaveLength(1);
    expect(granted[0]!.code).toBe(OPERATOR);
    expect(granted[0]!.grantedBy).toBe(ctx.admin.id);
    // `manual` — выдал администратор. `migration` зарезервирован за переводом ролей, и колонка
    // перевода на этом шаге обязана оставаться пустой: писателя у неё ещё нет вовсе.
    expect(granted[0]!.origin).toBe('manual');
    expect(granted[0]!.migrationId).toBeNull();
    // Одна транзакция — одно время: `now()` в Postgres это момент её начала, а не строки, и обе
    // отметки ставит умолчание базы. Разойдись они — значит назначение легло не той транзакцией,
    // которой заведена учётка, и между ними был миг, когда учётка уже жила, а выданного набора у
    // неё ещё не было.
    expect(granted[0]!.grantedAt.getTime()).toBe((await userCreatedAt(id)).getTime());
  });

  /**
   * Второй путь и главное утверждение шага 1a. Вторую надстройку добавляет **другой**
   * администратор: зеркалирование буквой «снести и вставить заново» прошло бы все остальные
   * проверки и выдало бы себя здесь тремя способами сразу — новым `id`, чужим автором и более
   * поздним временем.
   *
   * На неизменности `id` держится откат будущего перевода ролей: он снимает ровно свои строки и не
   * трогает выданное позже вручную, а найти их он может только по идентификаторам.
   */
  it('правка, добавляющая вторую надстройку, не пересоздаёт назначение первой', async () => {
    const { id } = await createAccount(ctx.admin, { addons: [OPERATOR] });
    const [before] = await grantRows(id);

    const res = await patchUser(ctx.otherAdmin, id, { addons: [OPERATOR, IT_APPROVER] });
    expect(res.statusCode, res.body).toBe(200);

    const after = await grantRows(id);
    expect(after.map((row) => row.code)).toEqual([IT_APPROVER, OPERATOR]);
    const operator = after.find((row) => row.code === OPERATOR)!;
    expect(operator.id).toBe(before!.id);
    expect(operator.grantedAt.getTime()).toBe(before!.grantedAt.getTime());
    expect(operator.grantedBy).toBe(ctx.admin.id);

    // Новое назначение — своё во всём: свой идентификатор, свой автор, своё время.
    const approver = after.find((row) => row.code === IT_APPROVER)!;
    expect(approver.id).not.toBe(before!.id);
    expect(approver.grantedBy).toBe(ctx.otherAdmin.id);
    expect(approver.grantedAt.getTime()).toBeGreaterThan(before!.grantedAt.getTime());
  });

  /**
   * Отзыв тем же маршрутом. Снимается ровно снятое: удаление «всех назначений учётки перед
   * вставкой остатка» дало бы тот же итог по составу и при этом переписало бы уцелевшую строку —
   * и обнаружилось бы это лишь тогда, когда откат перевода ролей не нашёл своих идентификаторов.
   */
  it('снятие надстройки правкой удаляет ровно её назначение', async () => {
    const { id } = await createAccount(ctx.admin, { addons: [OPERATOR, IT_APPROVER] });
    const kept = (await grantRows(id)).find((row) => row.code === IT_APPROVER)!;

    const res = await patchUser(ctx.otherAdmin, id, { addons: [IT_APPROVER] });
    expect(res.statusCode, res.body).toBe(200);

    const after = await grantRows(id);
    expect(after.map((row) => row.code)).toEqual([IT_APPROVER]);
    // Уцелевшее назначение — то же самое, а не выданное заново вместо снятого соседа.
    expect(after[0]!.id).toBe(kept.id);
    expect(after[0]!.grantedAt.getTime()).toBe(kept.grantedAt.getTime());
    expect(after[0]!.grantedBy).toBe(ctx.admin.id);
  });

  /**
   * Отказ по несовместимости при заведении (`ROLE_ADDON_BASE_ROLES`): надстройка оргтехники не
   * прикрепляется к «Наблюдателю». Проверяется не только код ответа: отказ обязан не оставить
   * **ничего** — ни учётки, ни назначения. Учётка, заведённая без набора, была бы молчаливым
   * исполнением половины просьбы, а назначение без учётки — сиротой в реестре выдач.
   *
   * РОЛЬ СМЕНИЛАСЬ С «Диспетчера» НА «Наблюдателя» (этап Э7 плана профилей оргтехники, Р5,
   * миграция B): «Ведение» стало выдаваемым и менеджеру, и диспетчеру — ведение оргтехники бывает
   * централизованным, — и прежний пример несовместимости перестал быть несовместимым. Наблюдатель
   * останется им при любом расширении списка: он по построению только смотрит, и набор, дающий
   * ему решения по заявке, противоречил бы самой роли.
   */
  it('несовместимая надстройка при заведении не оставляет ни учётки, ни строк', async () => {
    const email = freshEmail();

    const res = await postUser(
      ctx.admin,
      accountPayload(email, {
        role: 'observer',
        constructionObjectIds: [],
        addons: [OPERATOR],
      }),
    );

    expect(res.statusCode, res.body).toBe(400);
    // Ошибка помечает поле формы, а не приходит общим текстом: набор надстроек в портале один на
    // все роли, и почему не подошла именно эта, из формы иначе не видно.
    expect(res.json<{ fields?: { addons?: string } }>().fields?.addons).toMatch(
      /не прикрепляется/u,
    );
    expect(await rowsFor(email)).toEqual({ users: 0, grants: 0 });
  });

  /**
   * Тот же запрет с другой стороны — и это уже проверка границ транзакции, а не валидации тела.
   * Роль меняется на несовместимую, а набор в запросе не участвует вовсе: сверяется **итоговое**
   * состояние учётки, поэтому отказ приходит из маршрута (по прочитанному в транзакции набору), а
   * не от схемы. Правка обязана откатиться целиком: и роль, и назначения, и версия прав.
   *
   * Отсюда же и главное свидетельство того, что назначения пишутся транзакцией самой правки: откат
   * маршрута обязан уносить и их. Без этой проверки прошёл бы худший из возможных исходов — снятие
   * надстройки «за компанию» со сменой роли: доступ отобран молча, в журнале ничего, а учётка
   * осталась той же самой.
   */
  it('смена роли на несовместимую откатывает правку целиком', async () => {
    const { id } = await createAccount(ctx.admin, { addons: [OPERATOR] });
    const [before] = await grantRows(id);
    const stateBefore = await userRow(id);

    // Роль — «Наблюдатель» по той же причине, что и в соседнем случае: диспетчер с этапа Э7 набору
    // «Ведение» совместим (Р5, миграция B), и правка на него откатываться больше не обязана.
    const res = await patchUser(ctx.otherAdmin, id, { role: 'observer' });

    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ fields?: { addons?: string } }>().fields?.addons).toMatch(
      /не прикрепляется/u,
    );
    // Роль не сменилась, и версия прав не выросла: токены гасить не за что — ничего не произошло.
    expect(await userRow(id)).toEqual(stateBefore);
    const after = await grantRows(id);
    expect(after.map((row) => row.code)).toEqual([OPERATOR]);
    // То же назначение, а не снятое и выданное заново внутри упавшей правки.
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.grantedAt.getTime()).toBe(before!.grantedAt.getTime());
  });

  /**
   * Чем выдача связана с безопасностью. Access-токен сверяется с `authVersion` на каждом
   * запросе, и записанное назначение без поднятой версии начало бы действовать не тогда, когда его
   * выдали, а когда истёк последний выданный токен: снятая надстройка ещё несколько минут даёт
   * права, а выданная — не даёт.
   *
   * Вторая половина — правка без изменений: набор прислан тот же, разницы нет, и версия обязана
   * остаться прежней. Иначе «сохранить карточку не меняя ничего» выкидывало бы человека из портала,
   * и отличить настоящую смену прав от нажатия кнопки стало бы нечем.
   */
  it('правка набора поднимает версию прав, а правка без изменений — нет', async () => {
    const { id } = await createAccount(ctx.admin, { addons: [] });
    const clean = await userRow(id);

    expect((await patchUser(ctx.admin, id, { addons: [OPERATOR] })).statusCode).toBe(200);
    const granted = await userRow(id);
    expect(granted.authVersion).toBeGreaterThan(clean.authVersion);

    // Тот же набор — и та же версия: разница считается от состояния, а не от факта запроса.
    expect((await patchUser(ctx.admin, id, { addons: [OPERATOR] })).statusCode).toBe(200);
    expect((await userRow(id)).authVersion).toBe(granted.authVersion);

    // Снятие — то же гашение: прежний токен иначе дожил бы до истечения с правами оператора.
    expect((await patchUser(ctx.admin, id, { addons: [] })).statusCode).toBe(200);
    expect((await userRow(id)).authVersion).toBeGreaterThan(granted.authVersion);
    expect(await grantRows(id)).toHaveLength(0);
  });

  /**
   * Третий путь вызова — рассмотрение заявки на регистрацию (ADR 0087). Тот же `PATCH`, но другая
   * ветка: роль назначается вместе с активацией, и надстройку выдают там же, в одном решении. Путь
   * этот отдельный ровно настолько, чтобы выдача могла из него выпасть незаметно: в журнале у него
   * своё действие, а состав правки собирается иначе, чем при обычном сохранении карточки.
   */
  it('рассмотрение заявки с надстройкой заводит назначение одной транзакцией с решением', async () => {
    const id = await newRegistration();

    const res = await patchUser(ctx.otherAdmin, id, {
      approveRegistration: true,
      role: 'site',
      isActive: true,
      constructionObjectIds: [ctx.objectId],
      addons: [OPERATOR],
      notifyUser: false,
    });
    expect(res.statusCode, res.body).toBe(200);

    const granted = await grantRows(id);
    expect(granted.map((row) => row.code)).toEqual([OPERATOR]);
    // Автор — рассмотревший заявку администратор, происхождение — ручная выдача: заявку одобрил
    // человек, и `migration` здесь означал бы перевод ролей, которого не было.
    expect(granted[0]!.grantedBy).toBe(ctx.otherAdmin.id);
    expect(granted[0]!.origin).toBe('manual');
    // Свидетель транзакции здесь — запись журнала о самом решении: учётку завёл тест, и её
    // `created_at` относится к другой транзакции вовсе. Разойдись отметки — значит назначение
    // писалось отдельно от одобрения, и заявка могла бы оказаться рассмотренной без выданного
    // набора.
    expect(granted[0]!.grantedAt.getTime()).toBe(
      (await auditCreatedAt(id, 'user.approve_registration')).getTime(),
    );
    // Учётка стала действующей той же транзакцией — назначение не опередило роль и не отстало.
    expect(await userRow(id)).toMatchObject({ role: 'site' });
  });

  /*
   * ── Витрина учёток читает назначения (шаг 1c) ──────────────────────────────────────────────────
   *
   * Пометки рядом с ролью — единственное, что портал видит о выданном, и форма правки присылает их
   * обратно. На шаге 1c переключение источника проверялось расхождением таблиц: обе писались, и
   * «читает новую» от «читает старую» отличимо было только там, где содержимое у них разное.
   *
   * С шага 1d такого расхождения не завести вовсе — писатель у назначений один, и старая таблица
   * пуста. Заводить его легаси-строкой (прямая вставка в `user_role_addons`) нельзя по другой
   * причине: `backfill:grants` идёт по всей базе, соседний файл гоняет его настоящим переносом, и
   * подложенная надстройка уехала бы в назначения посреди проверки — вернув пометку, которой тест
   * ждёт пустой. Что легаси-строка ничего не значит, проверяется отдельно и с другой стороны — в
   * `user-grants-single-write.db.test.ts`, на разнице, а не на витрине.
   *
   * Отсюда и остаток предмета: пометка равна **системным** назначениям, показывается в порядке
   * словаря, и снятое мимо формы назначение её убирает (следующий тест).
   */
  it('карточка и список берут пометку из назначений', async () => {
    const { id, email } = await createAccount(ctx.admin, { addons: [OPERATOR, IT_APPROVER] });

    /*
     * Порядок значим, и держателя обоих наборов он проверяет заодно с источником. Старое выражение
     * отдавало надстройки в порядке объявления enum'а, новое сортирует назначения по коду — а по
     * алфавиту «Согласование ИТ» встаёт перед «Оператором». Пометки после переключения источника
     * переставляться не должны: шаг меняет хранение и ничего больше, поэтому порядок берётся из
     * словаря (`SYSTEM_GRANT_CODES`), а не из ответа базы.
     */
    expect(await cardAddons(ctx.admin, id)).toEqual([OPERATOR, IT_APPROVER]);
    expect(await listAddons(ctx.admin, id, email)).toEqual([OPERATOR, IT_APPROVER]);
    // Сам реестр выдач при этом отвечает алфавитом — расхождение и есть предмет проверки выше.
    expect((await grantRows(id)).map((row) => row.code)).toEqual([IT_APPROVER, OPERATOR]);
  });

  it('снятое мимо формы назначение убирает пометку', async () => {
    const { id, email } = await createAccount(ctx.admin, { addons: [OPERATOR] });

    // Так набор снимает реестр выдач (`routes/user-grants.ts`): он пишет только `user_grants` и о
    // форме учётки не знает вовсе. Витрина обязана показать учётку без пометки — прав ей теперь
    // тоже не даёт ничто, и пометка, пережившая снятие, обещала бы администратору доступ, которого
    // у человека нет.
    await ctx.db.delete(ctx.schema.userGrants).where(eq(ctx.schema.userGrants.userId, id));

    expect(await cardAddons(ctx.admin, id)).toEqual([]);
    expect(await listAddons(ctx.admin, id, email)).toEqual([]);
  });

  /**
   * Набор, собранный администратором, в пометки не попадает. Проверка на будущее этапа 2, но нужна
   * уже здесь: витрина рисует пометку по словарю надстроек, и чужой код дал бы пустую подпись
   * неизвестного цвета, а вернувшись из формы правки — отказ схемы, то есть учётку, которую нельзя
   * сохранить, не сняв набор. Отсеивает его пересечение с системными кодами (`systemAddonsOf`).
   */
  it('набор вне системных кодов пометкой не показывается', async () => {
    const { id, email } = await createAccount(ctx.admin, { addons: [OPERATOR] });
    const assembled = await assembleGrantFor(id, ctx.admin);

    // Назначений у учётки два — это видно в реестре выдач…
    expect((await grantRows(id)).map((row) => row.code)).toEqual(
      [OPERATOR, assembled].sort((a, b) => a.localeCompare(b)),
    );
    // …а пометка осталась одна: собранный набор ни в карточке, ни в списке не появляется.
    expect(await cardAddons(ctx.admin, id)).toEqual([OPERATOR]);
    expect(await listAddons(ctx.admin, id, email)).toEqual([OPERATOR]);
  });
});
