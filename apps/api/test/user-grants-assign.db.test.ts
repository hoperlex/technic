import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isPersonScopedRole,
  SYSTEM_GRANT_CODES,
  type GrantAssignmentResultDto,
  type GrantCardDto,
  type GrantImpactDto,
  type GrantValidationDetailsDto,
  type GrantViolationCode,
  type Role,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Выдача и отзыв полномочия учётке плюс предпросмотр последствий — через HTTP, на живой схеме
 * (ADR 0106, этап 3; план §12 — сценарий выдачи, §13.1 — жизненный цикл и отпечаток).
 *
 * **Чем этот файл отличается от соседних.** `grants-contracts.test.ts` проверяет барьеры как
 * функцию: подай состав — получи список нарушений. `grants-routes.db.test.ts` — сам каталог: что в
 * наборе и что делает его правка с держателями. `user-grants-routes.db.test.ts` — двойную запись
 * надстроек на путях правки учётки. Здесь третий предмет: **операция над одной учёткой** — строка
 * назначения, её автор и происхождение, гашение токенов, барьеры по итогу и подтверждение по
 * отпечатку.
 *
 * **Что ловится только отсюда.**
 *
 * - Дельта считается `effectiveDelta` по всем источникам, а не разницей составов: право, которое
 *   держателю и так даёт роль, в предпросмотре не появляется и при отзыве не исчезает. Проверить это
 *   на составе набора нельзя вовсе — нужен субъект с ролью.
 * - Барьеры выдачи проверяются **на выдаче**, а не только в конструкторе. Три из пяти в конструкторе
 *   недостижимы: набор с невыдаваемым правом и набор с запрещённой клеткой матрицы он не сохранит, а
 *   конфликт обязанностей возникает суммой двух наборов, которых по отдельности хватает. Поэтому
 *   такие наборы здесь собираются прямым `INSERT` — ровно так они и появляются в жизни: право стало
 *   защищённым выкатом, матрица ужесточилась, набор завела миграция.
 * - Устаревший отпечаток. Сценарий из §13.1 воспроизводится целиком: состав не менялся, версия та
 *   же, а применяться должно другое — потому что у учётки за это время появился второй набор.
 * - Идемпотентность выдачи с сохранением идентификатора: повторная выдача не создаёт второй строки и
 *   не переписывает первую. На неизменяемом `id` держится откат перевода ролей (решение 3).
 *
 * **Общий прогон.** Свои префиксы кодов и адресов, уборка по ним же до и после; ни одного утверждения
 * обо всей базе.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/user-grants-assign.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Метки своих строк: уборка идёт по ним, а не «по последним записям». */
const EMAIL_PREFIX = 'db-grant-assign';
const GRANT_PREFIX = 'db_grant_assign';
/** Метка работников файла: по ней их и убирают за собой — база у db-тестов общая. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: выдача полномочий';
/** Уникальный хвост прогона: код набора и адрес учётки уникальны в базе. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');

const PASSWORD = 'db-test-password-123';

/** Отпечаток нужного вида, заведомо не совпадающий ни с одним настоящим. */
const WRONG_HASH = 'f'.repeat(64);

interface Account {
  id: string;
  email: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  admin: Account;
  /** Второй администратор: автор выдачи обязан быть тем, от чьего имени шёл запрос, а не «каким-то». */
  otherAdmin: Account;
  /** Диспетчер без `users.manage`: полномочиями он не распоряжается ни одной ручкой. */
  outsider: Account;
}

let ctx: Ctx;
let seq = 0;

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
 * Уборка. Порядок обязателен: записи журнала уходят первыми (`entity_id` там текстовый и каскадом не
 * убирается), затем учётки — они уносят назначения каскадом по `user_id`, — и только потом сами
 * наборы: `user_grants.grant_id` стоит под RESTRICT, и выданный набор не удаляется вовсе.
 *
 * Работник идёт последним и отдельной строкой: `users.person_id` при сносе учётки **обнуляется**, а
 * не удаляется, — и карточка водителя, заведённая ради `users_driver_person_check`, оставалась в
 * общей базе по штуке за прогон. Работник без документов потом мешал соседям: обмен справочниками
 * спотыкается как раз о людей без СНИЛС.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'grant' AND entity_id IN (
    SELECT id::text FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'user' AND entity_id IN (
    SELECT id::text FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${PERSON_MARK}`);
}

async function newUser(role: Role | null, suffix: string): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `${EMAIL_PREFIX}-${suffix}-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  /*
   * Живая учётка водителя без карточки работника невозможна: её запрещает CHECK
   * `users_driver_person_check` (ADR 0102, миграция 0131) — кабинет без работника не ответит ни на
   * один вопрос. Поэтому роли `driver` работник заводится здесь же: тест про отказ в выдаче
   * полномочия должен получить отказ **от барьера**, а не от ограничения схемы.
   */
  const personId = isPersonScopedRole(role) ? await newPerson(suffix) : null;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      personId,
      isActive: role !== null,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return { id: created!.id, email };
}

/** Работник справочника под учётку водителя — четвёртая ось области (ADR 0102). */
async function newPerson(suffix: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({
      lastName: `Водителев${suffix}`,
      firstName: 'Виктор',
      middleName: 'Викторович',
      comment: PERSON_MARK,
    })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

/** Учётка с настоящим входом: ручки ходят под правом, а не под подменённым принципалом. */
async function newAccount(role: Role, suffix: string): Promise<Account> {
  const user = await newUser(role, suffix);
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: user.email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const { accessToken } = login.json<{ accessToken: string }>();
  return { ...user, auth: { authorization: `Bearer ${accessToken}` } };
}

/**
 * Держатель — своя учётка на каждый тест, а не одна общая: барьеры считаются по **итогу**, то есть по
 * всем наборам учётки сразу, и общая учётка копила бы права от теста к тесту.
 *
 * Роль `mechanic` по умолчанию: своей оси области у неё нет, поэтому матрица «ось × модуль» не
 * запрещает ей ни одного модуля — барьеры итога проверяются без помех от барьеров набора. И она
 * держит `garage.read` своей ролью, а `vehicleReadings.*` — нет: на этой разнице проверяется, что
 * дельта считается по итогу, а не по составу набора.
 */
function newHolder(role: Role = 'mechanic'): Promise<{ id: string; email: string }> {
  return newUser(role, 'holder');
}

function freshCode(): string {
  seq += 1;
  return `${GRANT_PREFIX}_${RUN}_${seq}`;
}

// ── Ручки ──

function previewAssignment(
  account: Account,
  userId: string,
  body: Record<string, unknown>,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/users/${userId}/grants/preview`,
    headers: account.auth,
    payload: body,
  });
}

function postAssignment(
  account: Account,
  userId: string,
  body: Record<string, unknown>,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/users/${userId}/grants`,
    headers: account.auth,
    payload: body,
  });
}

function deleteAssignment(
  account: Account,
  userId: string,
  grantId: string,
  hash: string,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/users/${userId}/grants/${grantId}?expectedImpactHash=${hash}`,
    headers: account.auth,
  });
}

/** Предпросмотр как его видит экран: дельта плюс отпечаток, которым подтверждают именно этот расчёт. */
async function preview(
  userId: string,
  operation: 'assign' | 'revoke',
  grantId: string,
): Promise<GrantImpactDto> {
  const res = await previewAssignment(ctx.admin, userId, { operation, grantId });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<GrantImpactDto>();
}

/** Выдача по свежему предпросмотру — тот же порядок, каким работает форма. */
async function assign(
  userId: string,
  grantId: string,
  account: Account = ctx.admin,
): ReturnType<typeof ctx.app.inject> {
  const { expectedImpactHash } = await preview(userId, 'assign', grantId);
  return postAssignment(account, userId, { grantId, expectedImpactHash });
}

async function assignOk(
  userId: string,
  grantId: string,
  account: Account = ctx.admin,
): Promise<GrantAssignmentResultDto> {
  const res = await assign(userId, grantId, account);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<GrantAssignmentResultDto>();
}

async function revoke(
  userId: string,
  grantId: string,
  account: Account = ctx.admin,
): ReturnType<typeof ctx.app.inject> {
  const { expectedImpactHash } = await preview(userId, 'revoke', grantId);
  return deleteAssignment(account, userId, grantId, expectedImpactHash);
}

/** Набор, созданный конструктором: дальше он выдаётся и отзывается настоящими ручками. */
async function createGrant(over: Record<string, unknown> = {}): Promise<GrantCardDto> {
  const code = freshCode();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/grants',
    headers: ctx.admin.auth,
    payload: {
      code,
      name: `Набор выдачи ${code}`,
      description: 'Набор заведён тестом выдачи',
      permissions: [],
      roles: [],
      ...over,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<GrantCardDto>();
}

/**
 * Состав, которого конструктор не сохранит, — прямым `INSERT`.
 *
 * Так наборы и появляются в жизни: право стало защищённым выкатом (`NON_GRANTABLE_PERMISSIONS`
 * растёт), матрица осей ужесточилась, набор завела миграция. Барьер выдачи обязан отвечать на такое
 * состояние, а не полагаться на то, что конструктор его не пропустил.
 */
async function addPermissionRaw(grantId: string, permission: string): Promise<void> {
  await ctx.db.insert(ctx.schema.grantPermissions).values({ grantId, permission });
}

async function addRoleRaw(grantId: string, role: Role): Promise<void> {
  await ctx.db.insert(ctx.schema.grantRoles).values({ grantId, role });
}

// ── Чтение состояния ──

interface AssignmentRow {
  id: string;
  grantId: string;
  grantedBy: string | null;
  grantedAt: Date;
  origin: string;
  migrationId: string | null;
}

async function assignmentsOf(userId: string): Promise<AssignmentRow[]> {
  return ctx.db
    .select({
      id: ctx.schema.userGrants.id,
      grantId: ctx.schema.userGrants.grantId,
      grantedBy: ctx.schema.userGrants.grantedBy,
      grantedAt: ctx.schema.userGrants.grantedAt,
      origin: ctx.schema.userGrants.origin,
      migrationId: ctx.schema.userGrants.migrationId,
    })
    .from(ctx.schema.userGrants)
    .where(eq(ctx.schema.userGrants.userId, userId))
    .orderBy(asc(ctx.schema.userGrants.grantedAt)) as Promise<AssignmentRow[]>;
}

async function authVersionOf(userId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ authVersion: ctx.schema.users.authVersion })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  return row!.authVersion;
}

interface AuditRow {
  action: string;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
}

/** Журнал по учётке: цель выдачи и отзыва — человек, так их находит разбор «что меняли у него». */
async function auditOfUser(userId: string): Promise<AuditRow[]> {
  return ctx.db
    .select({
      action: ctx.schema.auditLog.action,
      actorUserId: ctx.schema.auditLog.actorUserId,
      metadata: ctx.schema.auditLog.metadata,
    })
    .from(ctx.schema.auditLog)
    .where(
      and(eq(ctx.schema.auditLog.entityType, 'user'), eq(ctx.schema.auditLog.entityId, userId)),
    )
    .orderBy(asc(ctx.schema.auditLog.createdAt)) as Promise<AuditRow[]>;
}

/**
 * Сломанная запись журнала: триггер на `audit_log`, наведённый на **одну** учётку.
 *
 * Точечно, а не глухим отказом всей таблице, по единственной причине: база у db-тестов общая, и
 * запрет на вставку сорвал бы соседние файлы, идущие тем же прогоном. Идентификатор подставляется
 * литералом — в `CREATE TRIGGER` параметров не бывает, условие `WHEN` разбирается при создании
 * триггера, — и берётся он из строки, которую только что завёл этот же тест.
 */
async function withBrokenAudit(entityId: string, body: () => Promise<void>): Promise<void> {
  const name = `db_grant_assign_boom_${RUN}`;
  await ctx.db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'db-тест: запись журнала не удалась'; END $fn$`),
  );
  await ctx.db.execute(
    sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_log
      FOR EACH ROW WHEN (NEW.entity_id = '${entityId}') EXECUTE FUNCTION ${name}()`),
  );
  try {
    await body();
  } finally {
    await ctx.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON audit_log`));
    await ctx.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
  }
}

function holderViolations(body: string): GrantValidationDetailsDto['holders'] {
  const details = JSON.parse(body).details as GrantValidationDetailsDto | undefined;
  return details?.holders ?? [];
}

/** Коды нарушений у единственного виновника — целевой учётки. */
function codesOf(body: string): GrantViolationCode[] {
  const holders = holderViolations(body);
  return (holders[0]?.violations ?? []).map((v) => v.code);
}

describe.skipIf(!DB_URL)('выдача и отзыв полномочия: маршруты на живой схеме', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    await cleanup(db);

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    ctx = {
      app,
      db,
      schema,
      closeDb,
      admin: { id: '', email: '', auth: { authorization: '' } },
      otherAdmin: { id: '', email: '', auth: { authorization: '' } },
      outsider: { id: '', email: '', auth: { authorization: '' } },
    };
    ctx.admin = await newAccount('admin', 'admin');
    ctx.otherAdmin = await newAccount('admin', 'admin2');
    ctx.outsider = await newAccount('dispatcher', 'outsider');
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Доступ ──

  /**
   * Условие доступа объявлено манифестом и проверено перебором (`access-conditions.test.ts`), но там
   * субъект синтетический: права приходят подменённым принципалом. Здесь отказ проверяется на
   * настоящей учётке с настоящим входом — то есть на том же пути, каким пришёл бы диспетчер.
   */
  it('чужая роль не открывает ни выдачи, ни отзыва, ни предпросмотра', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });
    const fresh = await preview(holder.id, 'assign', grant.id);

    for (const res of [
      await previewAssignment(ctx.outsider, holder.id, {
        operation: 'assign',
        grantId: grant.id,
      }),
      await postAssignment(ctx.outsider, holder.id, {
        grantId: grant.id,
        expectedImpactHash: fresh.expectedImpactHash,
      }),
      await deleteAssignment(ctx.outsider, holder.id, grant.id, fresh.expectedImpactHash),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }
    // Отказ не оставил следов: назначения нет, токены не гасли.
    expect(await assignmentsOf(holder.id)).toEqual([]);
  });

  // ── Предпросмотр ──

  /**
   * **Главное утверждение предпросмотра: дельта — это `effectiveDelta`, а не состав набора.**
   *
   * Набор даёт `garage.read` и `vehicleReadings.read`, но `garage.read` механику и так приходит от
   * роли. В предпросмотре обязано появиться одно право — то, которое **реально** появится. Разница
   * составов показала бы два, то есть соврала бы про последствия ровно в ту сторону, в которую
   * администратору важнее всего не ошибиться: «набор что-то добавляет» вместо «набор добавляет вот
   * это».
   *
   * Обратная сторона того же — отзыв: `garage.read` останется у механика от роли, и в `removed` он
   * попасть не должен.
   */
  it('предпросмотр считает дельту по итогу, а не по составу набора, и отдаёт отпечаток', async () => {
    const holder = await newHolder();
    const grant = await createGrant({
      permissions: ['garage.read', 'vehicleReadings.read'],
      roles: ['mechanic'],
    });

    const before = await preview(holder.id, 'assign', grant.id);
    expect(before).toMatchObject({
      operation: 'assign',
      grantId: grant.id,
      grantCode: grant.code,
      grantName: grant.name,
      userId: holder.id,
      version: grant.version,
      violations: [],
      holders: [],
    });
    expect(before.expectedImpactHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(before.users).toHaveLength(1);
    expect(before.users[0]).toMatchObject({
      userId: holder.id,
      role: 'mechanic',
      roleMismatch: false,
      removed: [],
    });
    // Одно право, а не два: `garage.read` механику даёт роль.
    expect(before.users[0]!.added).toEqual(['vehicleReadings.read']);

    await assignOk(holder.id, grant.id);

    const after = await preview(holder.id, 'revoke', grant.id);
    expect(after.operation).toBe('revoke');
    expect(after.users[0]!.added).toEqual([]);
    // И обратно: `garage.read` остаётся при отзыве, потому что его даёт роль.
    expect(after.users[0]!.removed).toEqual(['vehicleReadings.read']);
    // Отпечаток другой: у учётки появилось назначение, да и вид операции входит в него слагаемым.
    expect(after.expectedImpactHash).not.toBe(before.expectedImpactHash);
  });

  /**
   * Предпросмотр — чтение: он **показывает** нарушение, а не отказывает им. Иначе экран не смог бы
   * объяснить, почему кнопка недоступна: тело отказа приходит вместо дельты, а нужны обе половины.
   */
  it('предпросмотр показывает нарушение в теле, а не отказом', async () => {
    const holder = await newHolder();
    const grant = await createGrant({
      permissions: ['vehicleRequests.status'],
      roles: ['mechanic'],
    });

    const impact = await preview(holder.id, 'assign', grant.id);
    expect(impact.holders).toHaveLength(1);
    expect(impact.holders[0]!.violations.map((v) => v.code)).toEqual(['requirement_missing']);
    expect(impact.expectedImpactHash).toMatch(/^[0-9a-f]{64}$/u);
    // Назначения так и не появилось: предпросмотр ничего не пишет.
    expect(await assignmentsOf(holder.id)).toEqual([]);
  });

  // ── Выдача ──

  it('выдача создаёт назначение с верным автором и происхождением, гасит токены и пишет журнал', async () => {
    const holder = await newHolder();
    const grant = await createGrant({
      permissions: ['vehicleReadings.read', 'vehicleReadings.write'],
      roles: ['mechanic'],
    });
    const versionBefore = await authVersionOf(holder.id);

    // Выдаёт второй администратор: `granted_by` обязано называть того, от чьего имени шёл запрос, а
    // не первого попавшегося администратора.
    const result = await assignOk(holder.id, grant.id, ctx.otherAdmin);
    expect(result).toMatchObject({ userId: holder.id, grantId: grant.id, changed: true });
    expect(result.delta.added).toEqual(['vehicleReadings.read', 'vehicleReadings.write']);
    expect(result.delta.removed).toEqual([]);

    const rows = await assignmentsOf(holder.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.assignmentId,
      grantId: grant.id,
      grantedBy: ctx.otherAdmin.id,
      // `migration` зарезервирован за переводом ролей: на этом различии держится его откат.
      origin: 'manual',
      migrationId: null,
    });
    expect(rows[0]!.grantedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // Токены держателя погасли той же операцией: иначе набор начал бы действовать не тогда, когда
    // его выдали, а когда истёк последний выданный токен.
    expect(await authVersionOf(holder.id)).toBeGreaterThan(versionBefore);

    // Реестр выдач в ответе — актуальный, без второго запроса за ним.
    expect(result.grant.holderCount).toBe(1);
    expect(result.grant.holders).toHaveLength(1);
    expect(result.grant.holders[0]).toMatchObject({
      assignmentId: result.assignmentId,
      userId: holder.id,
      email: holder.email,
      role: 'mechanic',
      roleMismatch: false,
      origin: 'manual',
    });
    expect(result.grant.holders[0]!.grantedByName).toContain('Тестовый');

    const audit = await auditOfUser(holder.id);
    expect(audit.map((row) => row.action)).toEqual(['grant.assign']);
    expect(audit[0]!.actorUserId).toBe(ctx.otherAdmin.id);
    expect(audit[0]!.metadata).toMatchObject({
      grantId: grant.id,
      grantCode: grant.code,
      grantName: grant.name,
      assignmentId: result.assignmentId,
      origin: 'manual',
      role: 'mechanic',
      permissionsAdded: ['vehicleReadings.read', 'vehicleReadings.write'],
      permissionsRemoved: [],
    });
  });

  /**
   * Повторная выдача того же набора дубля не создаёт (`UNIQUE (user_id, grant_id)`) — и, что важнее,
   * **не переписывает прежнюю строку**: `id`, автор и время выдачи остаются теми же. На неизменяемом
   * `id` держится откат перевода ролей — он снимает свои строки по идентификаторам и, не найдя их, не
   * трогает ничего (решение 3).
   */
  it('повторная выдача не двоит назначение и ничего не меняет', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['vehicleReadings.read'], roles: ['mechanic'] });

    const first = await assignOk(holder.id, grant.id, ctx.admin);
    const versionAfterFirst = await authVersionOf(holder.id);
    const rowAfterFirst = (await assignmentsOf(holder.id))[0]!;

    // Второй раз — уже от имени другого администратора: перезапись автора была бы видна.
    const again = await assign(holder.id, grant.id, ctx.otherAdmin);
    expect(again.statusCode, again.body).toBe(200);
    const body = again.json<GrantAssignmentResultDto>();
    expect(body.changed).toBe(false);
    expect(body.assignmentId).toBe(first.assignmentId);
    // Ничего не изменилось — значит и дельта пуста.
    expect(body.delta).toEqual({ added: [], removed: [] });

    const rows = await assignmentsOf(holder.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(rowAfterFirst.id);
    expect(rows[0]!.grantedBy).toBe(ctx.admin.id);
    expect(rows[0]!.grantedAt.getTime()).toBe(rowAfterFirst.grantedAt.getTime());
    // Токены не гасли и в журнал ничего не ушло: ничего не произошло.
    expect(await authVersionOf(holder.id)).toBe(versionAfterFirst);
    expect((await auditOfUser(holder.id)).map((row) => row.action)).toEqual(['grant.assign']);
  });

  // ── Отзыв ──

  it('отзыв удаляет строку назначения, гасит токены и пишет журнал', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['vehicleReadings.read'], roles: ['mechanic'] });
    const assigned = await assignOk(holder.id, grant.id);
    const versionAfterAssign = await authVersionOf(holder.id);

    const res = await revoke(holder.id, grant.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<GrantAssignmentResultDto>();
    expect(body).toMatchObject({
      assignmentId: assigned.assignmentId,
      userId: holder.id,
      grantId: grant.id,
      changed: true,
    });
    expect(body.delta.removed).toEqual(['vehicleReadings.read']);
    expect(body.delta.added).toEqual([]);

    // Строка **удалена**, а не помечена снятой: только так откат перевода ролей отличает «моё
    // назначение живо» от «его уже нет».
    expect(await assignmentsOf(holder.id)).toEqual([]);
    expect(await authVersionOf(holder.id)).toBeGreaterThan(versionAfterAssign);
    // Реестр выдач в ответе пуст сразу — второй запрос за ним не нужен.
    expect(body.grant.holderCount).toBe(0);
    expect(body.grant.holders).toEqual([]);

    const audit = await auditOfUser(holder.id);
    expect(audit.map((row) => row.action)).toEqual(['grant.assign', 'grant.revoke']);
    expect(audit[1]!.metadata).toMatchObject({
      grantId: grant.id,
      grantCode: grant.code,
      assignmentId: assigned.assignmentId,
      origin: 'manual',
      permissionsRemoved: ['vehicleReadings.read'],
    });

    // Повторная выдача даёт **новый** идентификатор: прежний не переиспользуется никогда.
    const reassigned = await assignOk(holder.id, grant.id);
    expect(reassigned.assignmentId).not.toBe(assigned.assignmentId);
  });

  it('отзыв невыданного набора — 404, и он ничего не пишет', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['vehicleReadings.read'], roles: ['mechanic'] });
    const versionBefore = await authVersionOf(holder.id);

    const res = await revoke(holder.id, grant.id);
    expect(res.statusCode, res.body).toBe(404);
    expect(await authVersionOf(holder.id)).toBe(versionBefore);
    expect(await auditOfUser(holder.id)).toEqual([]);
  });

  /**
   * **Событие доступа пишется той же транзакцией, и его сбой роняет операцию** (§5.1 плана
   * «полномочия в окне учётки»; ADR 0106, решение 7 — «запись, `authVersion + 1` и журнал в той же
   * транзакции»).
   *
   * Для остального портала `writeAudit` намеренно мягок: потеря записи не должна ронять выписанный
   * путевой лист. У доступа наоборот — выданное полномочие без строки в журнале не отвечает на
   * вопрос «кто это выдал», ради которого реестр выдач и заведён, и молчаливая потеря случается
   * ровно в тех редких случаях, когда его читают.
   *
   * Проверяется исход, а не механика: назначения нет, токены не гасли, журнал пуст — то есть
   * операция откатилась целиком, а не «прошла молча».
   */
  it('сбой записи журнала откатывает выдачу целиком', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['vehicleReadings.read'], roles: ['mechanic'] });
    const versionBefore = await authVersionOf(holder.id);

    await withBrokenAudit(holder.id, async () => {
      const res = await assign(holder.id, grant.id);
      expect(res.statusCode, res.body).toBe(500);
    });

    expect(await assignmentsOf(holder.id)).toEqual([]);
    expect(await authVersionOf(holder.id)).toBe(versionBefore);
    expect(await auditOfUser(holder.id)).toEqual([]);

    // Со снятым триггером та же выдача проходит: отказ дала именно запись журнала, а не что-то,
    // что тест сломал заодно.
    await assignOk(holder.id, grant.id);
  });

  /** То же у отзыва: строка назначения удаляется насовсем, и потерять событие о ней нельзя. */
  it('сбой записи журнала откатывает отзыв', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['vehicleReadings.read'], roles: ['mechanic'] });
    const assigned = await assignOk(holder.id, grant.id);
    const versionAfterAssign = await authVersionOf(holder.id);

    await withBrokenAudit(holder.id, async () => {
      const res = await revoke(holder.id, grant.id);
      expect(res.statusCode, res.body).toBe(500);
    });

    // Назначение на месте — с прежним `id`: откат вернул именно ту строку, а не завёл новую.
    const rows = await assignmentsOf(holder.id);
    expect(rows.map((row) => row.id)).toEqual([assigned.assignmentId]);
    expect(await authVersionOf(holder.id)).toBe(versionAfterAssign);
    expect((await auditOfUser(holder.id)).map((row) => row.action)).toEqual(['grant.assign']);
  });

  // ── Барьеры выдачи: по одному тесту на каждый ──

  /**
   * Барьер 1 — невыдаваемое право (`NON_GRANTABLE_PERMISSIONS`). В конструкторе он недостижим: набор
   * с таким правом не сохранить. А в жизни достижим — список защищённых прав растёт выкатом, и
   * набор, собранный до него, содержит право, которое стало невыдаваемым. Барьер обязан стоять на
   * выдаче, а не только в конструкторе.
   */
  it('невыдаваемое право в наборе выдачу не пропускает', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });
    await addPermissionRaw(grant.id, 'users.manage');

    const res = await assign(holder.id, grant.id);
    expect(res.statusCode, res.body).toBe(400);
    expect(codesOf(res.body)).toEqual(['permission_not_grantable']);
    expect(res.json<{ message: string }>().message).toContain('users.manage');
    expect(await assignmentsOf(holder.id)).toEqual([]);
  });

  /**
   * Барьер 2 — роль водителя. Кабинет показывает задание конкретного работника и принимает показания
   * от его имени (ADR 0102); добавить к нему чужие права нельзя ни одним способом.
   *
   * Проверяется здесь и **отдельно от совместимости с ролью**, потому что `driver` не входит в
   * `grant_roles` ни одного набора вовсе: проверка «роль не в списке», стоящая первой, отвечала бы
   * правдой о следствии вместо правды о причине. Отсюда порядок в обработчике — и отсюда этот тест.
   */
  it('роль водителя полномочий не принимает — и отказ называет причину, а не следствие', async () => {
    const driver = await newHolder('driver');
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });

    const res = await assign(driver.id, grant.id);
    expect(res.statusCode, res.body).toBe(400);
    expect(codesOf(res.body)).toEqual(['role_not_grantable']);
    expect(res.json<{ message: string }>().message).toMatch(/не принимает/u);
    expect(await assignmentsOf(driver.id)).toEqual([]);
  });

  /**
   * Барьер 3 — запрещённая клетка матрицы осей. Журнал путевых листов не сужается ничем, а у роли
   * `shtab` есть объектная ось: набор открыл бы ей листы всей компании вместе с персональными
   * данными водителей.
   *
   * Роль дописывается в набор прямым `INSERT`: конструктор такую пару не сохранит, а миграция или
   * ужесточение матрицы — оставят.
   */
  it('запрещённая клетка матрицы осей выдачу не пропускает', async () => {
    const holder = await newHolder('shtab');
    const grant = await createGrant({ permissions: ['waybills.read'], roles: ['dispatcher'] });
    await addRoleRaw(grant.id, 'shtab');

    const res = await assign(holder.id, grant.id);
    expect(res.statusCode, res.body).toBe(400);
    expect(codesOf(res.body)).toEqual(['module_forbidden_for_axis']);
    expect(res.json<{ message: string }>().message).toMatch(/нет фильтрации по её области/u);
    expect(await assignmentsOf(holder.id)).toEqual([]);
  });

  /**
   * Барьер 4 — «модуль закрывается чтением» (ADR 0021, §13.1). Состав из одного
   * `vehicleRequests.status` безупречен сам по себе, и конструктор его сохраняет: держателей у нового
   * набора нет, проверять итог не по кому. А выданный механику он открывает прямой вызов смены
   * статуса в модуле, которого механик не видит вовсе.
   */
  it('выдача, оставляющая учётку с действием без чтения, отклоняется по итогу', async () => {
    const holder = await newHolder();
    const grant = await createGrant({
      permissions: ['vehicleRequests.status'],
      roles: ['mechanic'],
    });
    const versionBefore = await authVersionOf(holder.id);

    const res = await assign(holder.id, grant.id);
    expect(res.statusCode, res.body).toBe(400);
    const holders = holderViolations(res.body);
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ userId: holder.id });
    expect(holders[0]!.violations.map((v) => v.code)).toEqual(['requirement_missing']);
    expect(holders[0]!.violations[0]!.requires).toBe('vehicleRequests.read');
    expect(await assignmentsOf(holder.id)).toEqual([]);
    expect(await authVersionOf(holder.id)).toBe(versionBefore);
  });

  /**
   * Барьер 5 — разделение обязанностей, и пара собирается **суммой двух наборов**: смету считает
   * первый, утверждает второй, и по отдельности оба безупречны. Проверить это внутри набора нельзя
   * вовсе — вот почему барьер считается по итоговым правам учётки.
   */
  it('конфликт обязанностей суммой двух наборов выдачу второго отклоняет', async () => {
    const holder = await newHolder();
    const estimating = await createGrant({
      permissions: ['serviceRequests.read', 'serviceRequests.estimate'],
      roles: ['mechanic'],
    });
    const approving = await createGrant({
      permissions: ['serviceRequests.read', 'serviceRequests.approveEstimate'],
      roles: ['mechanic'],
    });

    // Первый набор ложится без возражений: конфликта в нём нет.
    await assignOk(holder.id, estimating.id);

    const res = await assign(holder.id, approving.id);
    expect(res.statusCode, res.body).toBe(400);
    const holders = holderViolations(res.body);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.violations.map((v) => v.code)).toEqual(['duty_conflict']);
    expect(holders[0]!.violations[0]!.conflict?.permissions).toEqual([
      'serviceRequests.estimate',
      'serviceRequests.approveEstimate',
    ]);
    // Первый набор остался, второй не лёг: отказ откатил транзакцию целиком.
    const rows = await assignmentsOf(holder.id);
    expect(rows.map((row) => row.grantId)).toEqual([estimating.id]);
  });

  /**
   * Совместимость с ролью — не барьер выдачи, а вопрос «кому набор вообще положен» (`grant_roles`),
   * поэтому исход у неё свой: 409 со своим кодом. Список наборов в карточке учётки отфильтрован
   * совместимостью, и пара, которой в списке быть не могло, означает устаревший экран.
   */
  it('набор, не положенный роли держателя, не выдаётся', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['dispatcher'] });

    const impact = await preview(holder.id, 'assign', grant.id);
    // Предпросмотр честно показывает, что набор этой роли прав не даст, — и не отказывает.
    expect(impact.users[0]).toMatchObject({ roleMismatch: true, added: [], removed: [] });

    const res = await postAssignment(ctx.admin, holder.id, {
      grantId: grant.id,
      expectedImpactHash: impact.expectedImpactHash,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('grant_role_not_allowed');
    expect(await assignmentsOf(holder.id)).toEqual([]);
  });

  it('учётке без роли (нерассмотренной заявке) полномочие не выдаётся', async () => {
    const pending = await newUser(null, 'pending');
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });

    const res = await assign(pending.id, grant.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('grant_role_not_allowed');
    expect(await assignmentsOf(pending.id)).toEqual([]);
  });

  // ── Отпечаток последствий ──

  /**
   * **Сценарий из §13.1 целиком.** Предпросмотр посчитан; параллельно у той же учётки появился второй
   * набор. Состав первого набора не менялся, его версия та же — то есть `expectedVersion` сошёлся бы, —
   * а применяться должно другое: барьеры считаются по сумме наборов, и итог у учётки уже иной.
   *
   * Именно этот случай отпечаток и заводился ловить: версии для него недостаточно по построению.
   */
  it('выдача с устаревшим отпечатком отклоняется, хотя версия набора та же', async () => {
    const holder = await newHolder();
    const target = await createGrant({
      permissions: ['serviceRequests.read', 'serviceRequests.approveEstimate'],
      roles: ['mechanic'],
    });
    const other = await createGrant({
      permissions: ['vehicleReadings.read'],
      roles: ['mechanic'],
    });

    // Экран посчитал предпросмотр выдачи `target`.
    const shown = await preview(holder.id, 'assign', target.id);
    expect(shown.holders).toEqual([]);

    // Пока администратор читал его, второй администратор выдал учётке другой набор.
    await assignOk(holder.id, other.id, ctx.otherAdmin);
    // Состав `target` не менялся, и версия у него прежняя — версии для отказа не хватило бы.
    const [row] = await ctx.db
      .select({ version: ctx.schema.grants.version })
      .from(ctx.schema.grants)
      .where(eq(ctx.schema.grants.id, target.id));
    expect(row!.version).toBe(target.version);

    const stale = await postAssignment(ctx.admin, holder.id, {
      grantId: target.id,
      expectedImpactHash: shown.expectedImpactHash,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('grant_impact_changed');
    expect(stale.json<{ message: string }>().message).toMatch(/предпросмотр/u);

    // Ничего не применилось: у учётки по-прежнему один набор.
    expect((await assignmentsOf(holder.id)).map((r) => r.grantId)).toEqual([other.id]);

    // Свежий предпросмотр — и та же выдача проходит.
    const again = await assignOk(holder.id, target.id);
    expect(again.changed).toBe(true);
  });

  /**
   * Второе слагаемое, которого нет в версии, — `authVersion` затронутой учётки: смена роли или
   * другого набора у неё меняет и дельту, и приговор барьеров. Здесь роль меняется настоящей ручкой
   * правки учётки, а не `UPDATE` в базу: именно она поднимает `authVersion`, и проверяться должно то,
   * что происходит в жизни.
   */
  it('смена роли держателя обесценивает показанный отпечаток', async () => {
    const holder = await newHolder();
    const grant = await createGrant({
      permissions: ['vehicleReadings.read'],
      roles: ['mechanic', 'dispatcher'],
    });
    const shown = await preview(holder.id, 'assign', grant.id);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${holder.id}`,
      headers: ctx.admin.auth,
      payload: { role: 'dispatcher', notifyUser: false },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const stale = await postAssignment(ctx.admin, holder.id, {
      grantId: grant.id,
      expectedImpactHash: shown.expectedImpactHash,
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('grant_impact_changed');
    expect(await assignmentsOf(holder.id)).toEqual([]);
  });

  it('отзыв с устаревшим отпечатком не удаляет строку', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['vehicleReadings.read'], roles: ['mechanic'] });
    const other = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });
    const assigned = await assignOk(holder.id, grant.id);

    const shown = await preview(holder.id, 'revoke', grant.id);
    await assignOk(holder.id, other.id, ctx.otherAdmin);

    const stale = await deleteAssignment(ctx.admin, holder.id, grant.id, shown.expectedImpactHash);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('grant_impact_changed');
    expect((await assignmentsOf(holder.id)).map((row) => row.id)).toContain(assigned.assignmentId);

    const fresh = await revoke(holder.id, grant.id);
    expect(fresh.statusCode, fresh.body).toBe(200);
  });

  /** Мусор в поле отпечатка — 400 от схемы, а не 409: «так отпечатки не выглядят», а не «устарело». */
  it('отпечаток негодного вида отвергается схемой, чужой — конфликтом', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['vehicleReadings.read'], roles: ['mechanic'] });

    const malformed = await postAssignment(ctx.admin, holder.id, {
      grantId: grant.id,
      expectedImpactHash: 'нет',
    });
    expect(malformed.statusCode, malformed.body).toBe(400);

    const wrong = await postAssignment(ctx.admin, holder.id, {
      grantId: grant.id,
      expectedImpactHash: WRONG_HASH,
    });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(wrong.json<{ code: string }>().code).toBe('grant_impact_changed');
    expect(await assignmentsOf(holder.id)).toEqual([]);
  });

  // ── Границы первой поставки ──

  /**
   * **Точечной выдачи одного права в первой поставке нет, и её нельзя изобразить** (§12, вторая
   * поставка). Тело выдачи принимает только `grantId`: право, присланное вместо набора, отклоняет
   * схема, а не проверка внутри, — и `origin` назначения знает два значения, оба про набор.
   *
   * Проверяется потому, что «выдано лично» — это источник права в карточке доступа, и появиться он
   * должен вместе с механикой, а не раньше неё.
   */
  it('выдать право мимо набора нельзя: сущности «выдано лично» в поставке нет', async () => {
    const holder = await newHolder();
    const res = await postAssignment(ctx.admin, holder.id, {
      permission: 'garage.read',
      expectedImpactHash: WRONG_HASH,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(await assignmentsOf(holder.id)).toEqual([]);

    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });
    await assignOk(holder.id, grant.id);
    const rows = await assignmentsOf(holder.id);
    // Единственные два значения происхождения — `manual` и `migration`, и оба означают набор.
    expect(rows.map((row) => row.origin)).toEqual(['manual']);
  });

  /**
   * Системный набор выдаётся наравне с пользовательским: в коде живёт его **состав** (решение 2), а
   * не список держателей. Иначе перенос надстроек оставил бы набор ИТ-службы невыдаваемым вовсе — а
   * именно его и раздают людям.
   *
   * Прибавка проверяется по `serviceRequests.assign`, а не по прежней визе: мёртвое
   * `serviceRequests.approveIt` из состава убрано (план профилей оргтехники, Э9, миграция E).
   * Назначение — то, ради чего набор и выдают, и роли `shtab` оно не положено.
   */
  it('системный набор выдаётся и отзывается теми же ручками', async () => {
    const holder = await newHolder('shtab');
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/grants?kind=system&pageSize=500',
      headers: ctx.admin.auth,
    });
    const approver = list
      .json<{ items: GrantCardDto[] }>()
      .items.find((row) => row.code === SYSTEM_GRANT_CODES[1])!;
    expect(approver, 'системный набор ИТ-службы в каталоге').toBeDefined();

    const assigned = await assignOk(holder.id, approver.id);
    expect(assigned.changed).toBe(true);
    expect(assigned.delta.added).toContain('serviceRequests.assign');

    const revoked = await revoke(holder.id, approver.id);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(await assignmentsOf(holder.id)).toEqual([]);
  });
});
