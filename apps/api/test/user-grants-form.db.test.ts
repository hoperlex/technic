import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GRANT_CONFLICT_CODES,
  MAX_ASSIGNED_GRANTS,
  MAX_GRANT_STATEMENTS,
  ROLE_PERMISSIONS,
  type GrantValidationDetailsDto,
  type GrantViolationCode,
  type Permission,
  type Role,
  type UserAccountDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Полномочия в окне учётки (план `docs/account-form-grants-plan.md`, §4–§5) — через HTTP, на живой
 * схеме.
 *
 * **Чем этот файл отличается от соседних.** `grant-statements.test.ts` проверяет планировщик как
 * функцию: подай состояние и тело — получи разницу и нарушения. `grant-refs.db.test.ts` — чтения,
 * из которых это состояние собирается. `user-grants-assign.db.test.ts` — выдачу из реестра, то есть
 * второй путь. Здесь предмет третий и свой: **операция целиком** — одна транзакция, в которой роль,
 * область, активность, назначения, письмо и журнал либо случаются вместе, либо не случаются вовсе.
 *
 * **Что ловится только отсюда.**
 *
 * - Приём заявки одной операцией. Планировщик о письме и о решении по заявке не знает ничего, а
 *   половинчатый исход («роль назначили, набор не выдался») — ровно то, ради чего поле и заводили.
 * - Неизменность `id` назначения на путях формы. Пересоздание строки прошло бы всякую проверку
 *   состава и сломало бы откат перевода ролей, который ищет **свои** идентификаторы (ADR 0113).
 * - Смысл ответа сервера: 400 с путём поля `grants`, 400 **без** пути у молчания и 409 у гонки.
 *   Функция отдаёт код нарушения, а какой ответ ему положен — решает маршрут.
 * - `authVersion` и refresh-сессии: у планировщика их нет вовсе, а выданный набор, не погасивший
 *   токены, начинает действовать не тогда, когда его выдали.
 * - Строгий журнал (§5.1): событие пишется той же транзакцией, и его сбой откатывает операцию.
 *   На подменах это утверждение неотличимо от «функция вызвана».
 * - Общий предел назначений у обоих путей выдачи (§4.2): считает его одна функция, но набивает
 *   учётку точечная выдача, а упирается в предел форма.
 *
 * Конкурентность (Р6) живёт отдельным файлом (`user-grants-form-locks.db.test.ts`): ей нужны свои
 * сессии-держатели и свой счёт взаимных блокировок.
 *
 * **Общий прогон.** Свои префиксы адресов и кодов, уборка по ним же до и после; ни одного
 * утверждения обо всей базе.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/user-grants-form.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Метка своих учёток: уборка идёт по ней, а не «по последним строкам». */
const EMAIL_PREFIX = 'db-grants-form';
/** Метка своих наборов. Подчёркивание, а не дефис: `grantCodeSchema` иного кода не примет. */
const GRANT_PREFIX = 'db_grants_form';
/** Метка работников и контрагента файла: по ней их и убирают за собой — база у db-тестов общая. */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: полномочия в окне учётки';
/** Уникальный хвост прогона: адрес и код набора уникальны в базе, а она переживает прогоны. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');

const ADMIN_PASSWORD = 'db-test-password-123';
/** Пароль подопытной учётки: примет адреса и ФИО в нём быть не должно (`passwordSchema`). */
const HOLDER_PASSWORD = 'db-holder-secret-456';

/** Ролевой набор поставочного каталога: им переводят «Штаб» в «Площадку» (ADR 0112). */
const VEHICLE_ORDERING = 'vehicle_ordering';

/**
 * Десятизначный ИНН по девяти цифрам основы: последняя считается по весам приказа ФНС.
 *
 * Выдуманный «77…01» сюда не годится, и причина не в строгости схемы — тест пишет строку прямой
 * вставкой мимо неё. Пока идёт прогон (а после падения и дольше) контрагент лежит в общей базе, а
 * обмен справочниками выгружает её целиком и загружает обратно; на ИНН без контрольной суммы он
 * спотыкается, и выглядит это дефектом чужого модуля. Тем же приёмом заводит своих исполнителей
 * `service-request-flow.db.test.ts`.
 */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

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
  /** Площадка: объектной роли область обязательна (ADR 0039), а «Штаб» и «Площадка» — объектные. */
  objectId: string;
  /** Свой исполнитель: тип `service` даёт учётке ведение сметы — половину запрещённой пары. */
  serviceCounterpartyId: string;
  /** Набор «Заказ техники» из поставочного каталога — предмет стража Р4. */
  vehicleOrderingId: string;
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
  // Почта включена, но наружу не ходит: письмо о рассмотрении заявки обязано лечь в очередь той же
  // транзакцией, и проверяется именно это, а не доставка.
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
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
 * Уборка. Порядок обязателен: сначала записи журнала (`entity_id` там текстовый и каскадом не
 * убирается), затем очередь писем с задачами, затем учётки — они уносят назначения и снимки
 * перевода каскадом по `user_id`, — и только потом наборы: `user_grants.grant_id` стоит под
 * RESTRICT, и выданный набор не удаляется вовсе.
 *
 * Работник и контрагент идут последними и отдельными строками: при сносе учётки `person_id` и
 * `counterparty_id` **обнуляются**, а не удаляются, и обе карточки оставались бы в общей базе по
 * штуке за прогон.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'user' AND entity_id IN (
    SELECT id::text FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'grant' AND entity_id IN (
    SELECT id::text FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM jobs WHERE type = 'send_email' AND payload ->> 'mailMessageId' IN (
    SELECT id::text FROM mail_messages WHERE to_email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM mail_messages WHERE to_email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${MARK}`);
  await db.execute(sql`DELETE FROM counterparties WHERE comment = ${MARK}`);
}

// ── Заведение подопытных ──

function freshEmail(suffix: string): string {
  seq += 1;
  return `${EMAIL_PREFIX}-${suffix}-${RUN}-${seq}@example.invalid`;
}

/**
 * Учётка прямой вставкой: предмет теста — правка, а не заведение, и подопытный обязан появляться в
 * нужном состоянии, включая роли, которые маршрут уже не назначает (`shtab` закрыт ADR 0113).
 */
async function newUser(role: Role): Promise<{ id: string; email: string }> {
  const email = freshEmail('holder');
  const { hashPassword } = await import('../src/auth/password');
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: '',
      passwordHash: await hashPassword(HOLDER_PASSWORD),
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return { id: created!.id, email };
}

/** Учётка объектной роли: без объекта её не сохранить, и правка упёрлась бы не в то поле. */
async function newObjectUser(role: Role): Promise<{ id: string; email: string }> {
  const user = await newUser(role);
  await ctx.db
    .insert(ctx.schema.userConstructionObjects)
    .values({ userId: user.id, constructionObjectId: ctx.objectId, createdBy: ctx.admin.id });
  return user;
}

/** Учётка с настоящим входом: сессии гасятся у того, кто в портал действительно вошёл. */
async function newAccount(role: Role): Promise<Account> {
  const user = await newUser(role);
  return { ...user, auth: await loginAs(user.email, HOLDER_PASSWORD) };
}

async function loginAs(email: string, password: string): Promise<{ authorization: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json<{ accessToken: string }>().accessToken}` };
}

async function newAdmin(suffix: string): Promise<Account> {
  const email = `${EMAIL_PREFIX}-admin-${suffix}-${RUN}@example.invalid`;
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
  return { id: created!.id, email, auth: await loginAs(email, ADMIN_PASSWORD) };
}

/** Заявка на регистрацию: неактивная учётка без роли (ADR 0034) — исходное состояние приёма. */
async function newRegistration(): Promise<{ id: string; email: string }> {
  const email = freshEmail('request');
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
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
  return { id: created!.id, email };
}

/** Работник справочника — четвёртая ось области (ADR 0102), без него роли `driver` не бывает. */
async function newPerson(): Promise<string> {
  seq += 1;
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({
      lastName: `Водителев${seq}`,
      firstName: 'Виктор',
      middleName: 'Викторович',
      comment: MARK,
    })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

interface TestGrant {
  id: string;
  code: string;
  name: string;
  version: number;
}

/**
 * Набор каталога прямой вставкой.
 *
 * Прямой, а не конструктором: предмет файла — окно учётки, и каталог здесь исходные данные. Заодно
 * так заводятся составы, которых конструктор не сохранит (строка `grant_roles` с ролью `driver`), —
 * ровно те повреждённые данные, ради которых барьеры и стоят на выдаче, а не только в конструкторе.
 */
async function createGrant(over: {
  name?: string;
  permissions?: readonly Permission[];
  roles?: readonly Role[];
}): Promise<TestGrant> {
  seq += 1;
  const code = `${GRANT_PREFIX}_${RUN}_${seq}`;
  const name = over.name ?? `Набор формы ${seq}`;
  const [grant] = await ctx.db
    .insert(ctx.schema.grants)
    .values({
      code,
      name,
      description: 'Набор заведён тестом окна учётки',
      createdBy: ctx.admin.id,
    })
    .returning({ id: ctx.schema.grants.id, version: ctx.schema.grants.version });
  const id = grant!.id;
  if (over.permissions?.length) {
    await ctx.db
      .insert(ctx.schema.grantPermissions)
      .values(over.permissions.map((permission) => ({ grantId: id, permission })));
  }
  if (over.roles?.length) {
    await ctx.db
      .insert(ctx.schema.grantRoles)
      .values(over.roles.map((role) => ({ grantId: id, role })));
  }
  return { id, code, name, version: grant!.version };
}

/** Роль набора мимо конструктора: так выглядят повреждённые данные и гонка с правкой `grant_roles`. */
async function addRoleRaw(grantId: string, role: Role): Promise<void> {
  await ctx.db.insert(ctx.schema.grantRoles).values({ grantId, role }).onConflictDoNothing();
}

/**
 * Назначение мимо формы — так его заводят реестр выдач и шаг prepare перевода ролей.
 *
 * У `origin = 'migration'` снимок перевода обязателен: `user_grants_migration_origin_check` требует
 * ссылку, и без неё «взведено переводом» не выражается в базе вовсе.
 */
async function assignRaw(
  userId: string,
  grantId: string,
  origin: 'manual' | 'migration' = 'manual',
): Promise<string> {
  let migrationId: string | null = null;
  if (origin === 'migration') {
    const [snapshot] = await ctx.db
      .insert(ctx.schema.userRoleMigration)
      .values({ userId, stage: 8, roleBefore: 'shtab', roleAfter: 'site' })
      .onConflictDoNothing()
      .returning({ id: ctx.schema.userRoleMigration.id });
    migrationId =
      snapshot?.id ??
      (
        await ctx.db
          .select({ id: ctx.schema.userRoleMigration.id })
          .from(ctx.schema.userRoleMigration)
          .where(eq(ctx.schema.userRoleMigration.userId, userId))
      )[0]!.id;
  }
  const [row] = await ctx.db
    .insert(ctx.schema.userGrants)
    .values({ userId, grantId, grantedBy: ctx.admin.id, origin, migrationId })
    .returning({ id: ctx.schema.userGrants.id });
  return row!.id;
}

// ── Ручки ──

function patchUser(
  id: string,
  payload: Record<string, unknown>,
  account: Account = ctx.admin,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/users/${id}`,
    headers: account.auth,
    payload,
  });
}

function postUser(payload: Record<string, unknown>): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: ctx.admin.auth,
    payload,
  });
}

async function cardOf(id: string): Promise<UserAccountDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/users/${id}`,
    headers: ctx.admin.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ user: UserAccountDto }>().user;
}

/** Точечная выдача так, как её делает реестр: свежий предпросмотр и подтверждение его отпечатком. */
async function assignFromRegistry(
  userId: string,
  grantId: string,
): ReturnType<typeof ctx.app.inject> {
  const preview = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/users/${userId}/grants/preview`,
    headers: ctx.admin.auth,
    payload: { operation: 'assign', grantId },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/users/${userId}/grants`,
    headers: ctx.admin.auth,
    payload: {
      grantId,
      expectedImpactHash: preview.json<{ expectedImpactHash: string }>().expectedImpactHash,
    },
  });
}

/**
 * Чужая правка состава набора между открытием формы и сохранением — настоящей ручкой каталога,
 * с предпросмотром и отпечатком, как её делает администратор.
 */
async function editGrantComposition(
  grant: TestGrant,
  permissions: readonly Permission[],
): Promise<void> {
  const body = { permissions: [...permissions] };
  const preview = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/grants/${grant.id}/preview`,
    headers: ctx.admin.auth,
    payload: body,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/grants/${grant.id}`,
    headers: ctx.admin.auth,
    payload: {
      ...body,
      expectedVersion: await versionOf(grant.id),
      expectedImpactHash: preview.json<{ expectedImpactHash: string }>().expectedImpactHash,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

// ── Чтение состояния ──

interface AssignmentRow {
  id: string;
  grantId: string;
  grantedBy: string | null;
  grantedAt: Date;
  origin: string;
}

async function assignmentsOf(userId: string): Promise<AssignmentRow[]> {
  return ctx.db
    .select({
      id: ctx.schema.userGrants.id,
      grantId: ctx.schema.userGrants.grantId,
      grantedBy: ctx.schema.userGrants.grantedBy,
      grantedAt: ctx.schema.userGrants.grantedAt,
      origin: ctx.schema.userGrants.origin,
    })
    .from(ctx.schema.userGrants)
    .where(eq(ctx.schema.userGrants.userId, userId))
    .orderBy(asc(ctx.schema.userGrants.grantId)) as Promise<AssignmentRow[]>;
}

async function grantIdsOf(userId: string): Promise<string[]> {
  return (await assignmentsOf(userId)).map((row) => row.grantId).sort();
}

async function versionOf(grantId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ version: ctx.schema.grants.version })
    .from(ctx.schema.grants)
    .where(eq(ctx.schema.grants.id, grantId));
  return row!.version;
}

async function userRow(userId: string): Promise<{
  role: string | null;
  isActive: boolean;
  authVersion: number;
  phone: string;
}> {
  const [row] = await ctx.db
    .select({
      role: ctx.schema.users.role,
      isActive: ctx.schema.users.isActive,
      authVersion: ctx.schema.users.authVersion,
      phone: ctx.schema.users.phone,
    })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  return row!;
}

/** Живые refresh-сессии: гашение доступа видно по ним, а не по одному лишь `authVersion`. */
async function liveSessions(userId: string): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM refresh_sessions
     WHERE user_id = ${userId} AND revoked_at IS NULL`);
  return Number(res.rows[0]!.n);
}

interface AuditRow {
  action: string;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Журнал по учётке: цель у правки, выдачи и отзыва одна — человек.
 *
 * **Порядок здесь — порядок чтения, а не порядок записи, и путать их нельзя.** Все события одной
 * операции пишутся одной транзакцией, `audit_log.created_at` — это `now()`, то есть время её начала,
 * а первичный ключ случаен: физический порядок записи из таблицы не восстанавливается вовсе.
 * Поэтому строки упорядочиваются по действию — чтобы чтение было устойчивым, — а утверждения о
 * последовательности событий строятся не на нём (см. проверки раскладки дельты).
 */
async function auditOf(userId: string): Promise<AuditRow[]> {
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
    .orderBy(asc(ctx.schema.auditLog.createdAt), asc(ctx.schema.auditLog.action)) as Promise<
    AuditRow[]
  >;
}

/** Событие журнала по действию: искать его по номеру строки нельзя — порядок не восстановим. */
function eventOf(rows: readonly AuditRow[], action: string): AuditRow {
  const found = rows.filter((row) => row.action === action);
  expect(found, `событие «${action}»`).toHaveLength(1);
  return found[0]!;
}

async function mailCount(email: string, kind: string): Promise<number> {
  const res = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM mail_messages WHERE to_email = ${email} AND kind = ${kind}`);
  return Number(res.rows[0]!.n);
}

/**
 * Сломанная запись журнала: триггер на `audit_log`, наведённый на **одну** учётку.
 *
 * Точечно, а не глухим отказом всей таблице: база у db-тестов общая, и запрет на вставку сорвал бы
 * соседние файлы того же прогона. Приём взят у `user-grants-assign.db.test.ts` — там им проверяется
 * строгость журнала на пути реестра, здесь на пути формы, и обещание §5.1 у них общее.
 */
async function withBrokenAudit(entityId: string, body: () => Promise<void>): Promise<void> {
  const name = `db_grants_form_boom_${RUN}`;
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

// ── Разбор ответа ──

interface ErrorBody {
  code: string;
  message: string;
  fields?: Record<string, string>;
  details?: GrantValidationDetailsDto;
}

function errorOf(res: { body: string }): ErrorBody {
  return JSON.parse(res.body) as ErrorBody;
}

/** Коды барьеров из тела отказа: у операции над одной учёткой они лежат в общем списке (Р8). */
function violationCodes(res: { body: string }): GrantViolationCode[] {
  return (errorOf(res).details?.violations ?? []).map((v) => v.code);
}

/** Строка высказывания о наборе — то, что собирает форма (§6). */
function say(grant: { id: string; version: number }, selected: boolean): Record<string, unknown> {
  return { id: grant.id, version: grant.version, selected };
}

describe.skipIf(!DB_URL)('полномочия в окне учётки: операция целиком (живая схема)', () => {
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
    // Ролевые наборы завела миграция каталога. Нет их — сломан не тест, а накат: пусть это будет
    // видно здесь, а не в чужом ожидании.
    const ordering = await db.execute<{ id: string }>(
      sql`SELECT id FROM grants WHERE code = ${VEHICLE_ORDERING}`,
    );
    if (ordering.rows.length === 0) {
      throw new Error(`В базе нет системного набора «${VEHICLE_ORDERING}»`);
    }

    ctx = {
      app,
      db,
      schema,
      closeDb,
      admin: { id: '', email: '', auth: { authorization: '' } },
      objectId: objects.rows[0]!.id,
      serviceCounterpartyId: '',
      vehicleOrderingId: ordering.rows[0]!.id,
    };
    ctx.admin = await newAdmin('one');

    /*
     * Исполнитель заводится свой, а не берётся «первым попавшимся» из базы, и это не вкус.
     * Соседний файл (`service-request-flow.db.test.ts`) заводит своих сервисных контрагентов на
     * время прогона и удаляет их в `afterAll`; выбери мы строку запросом `ORDER BY name LIMIT 1` —
     * и в параллельном прогоне досталась бы чужая, а её удаление посреди нашего теста превращало бы
     * `duty_conflict` в «Контрагент не найден». Своя строка не зависит ни от наполнения, ни от
     * расписания. Имя с «яя» — чтобы уже нам не достаться тому, кто берёт первого попавшегося.
     */
    const [counterparty] = await db
      .insert(schema.counterparties)
      .values({
        type: 'service',
        name: `яя-Сервис полномочий ${RUN}`,
        inn: innOf(`77${String(Date.now()).slice(-7)}`),
        comment: MARK,
        createdBy: ctx.admin.id,
      })
      .returning({ id: schema.counterparties.id });
    ctx.serviceCounterpartyId = counterparty!.id;
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Приём заявки одной операцией (Р3) ──

  /**
   * Ради этого сценария поле и заводилось. Разложи его на «PATCH учётки + N выдач» — и
   * половинчатый исход станет обычным делом: роль назначена, письмо ушло, набор не выдан, а заявка
   * рассмотрена наполовину. Здесь проверяется обратное: всё случилось разом и одной записью в
   * журнале решения.
   */
  it('рассмотрение заявки назначает роль, включает вход, выдаёт полномочие и шлёт письмо разом', async () => {
    const request = await newRegistration();
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });

    const res = await patchUser(request.id, {
      approveRegistration: true,
      role: 'mechanic',
      isActive: true,
      notifyUser: true,
      grants: [say(grant, true)],
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ notified: string }>().notified).toBe('queued');
    expect(await userRow(request.id)).toMatchObject({ role: 'mechanic', isActive: true });
    expect(await grantIdsOf(request.id)).toEqual([grant.id]);
    expect(await mailCount(request.email, 'registration_approved')).toBe(1);

    // Решение по заявке — своё действие журнала, и полномочие названо в его же перечне изменений.
    const audit = await auditOf(request.id);
    expect(audit.map((row) => row.action)).toEqual(['grant.assign', 'user.approve_registration']);
    expect(eventOf(audit, 'user.approve_registration').metadata.changes).toContainEqual({
      field: 'grantsGranted',
      from: null,
      to: grant.name,
    });
    // Ответ ручки — карточка «после», а не второе чтение: набор виден в ней сразу.
    const card = res.json<{ user: UserAccountDto }>().user;
    expect(card.grants.map((row) => row.id)).toEqual([grant.id]);
  });

  /**
   * Повторное сохранение той же карточки — не выдача. `id` назначения неизменяем: на нём держится
   * откат перевода ролей, который снимает **свои** строки и, не найдя их, не трогает ничего
   * (решение 3 ADR 0106). Пересоздание прошло бы всякую проверку состава и сломало бы именно его.
   */
  it('повторное сохранение того же полномочия назначения не пересоздаёт', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    expect((await patchUser(holder.id, { grants: [say(grant, true)] })).statusCode).toBe(200);
    const [first] = await assignmentsOf(holder.id);

    const again = await patchUser(holder.id, {
      grants: [say(grant, true)],
      phone: '+7 926 000-00-01',
    });

    expect(again.statusCode, again.body).toBe(200);
    const [second, ...rest] = await assignmentsOf(holder.id);
    expect(rest).toHaveLength(0);
    expect(second!.id).toBe(first!.id);
    expect(second!.grantedBy).toBe(first!.grantedBy);
    expect(second!.grantedAt.getTime()).toBe(first!.grantedAt.getTime());
    // Ничего не произошло — и в журнале второго события выдачи нет.
    expect((await auditOf(holder.id)).filter((row) => row.action === 'grant.assign')).toHaveLength(
      1,
    );
  });

  /**
   * Третий случай того же окна — заведение учётки администратором. Назначений у ненаписанной строки
   * не бывает, снимать нечего, и «роль до» — `null`: молчание здесь законно всегда, а высказывание
   * применяется целиком той же транзакцией, что и сама учётка.
   *
   * Автор выдачи сверяется с администратором, от чьего имени шёл запрос: подставить туда, например,
   * владельца заводимой учётки маршрут может незаметно.
   */
  it('заведение учётки с полномочием заводит назначение той же транзакцией', async () => {
    const email = freshEmail('created');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });

    const res = await postUser({
      email,
      lastName: 'Новиков',
      firstName: 'Илья',
      middleName: '',
      phone: '',
      role: 'mechanic',
      password: HOLDER_PASSWORD,
      isActive: true,
      notifyUser: false,
      grants: [say(grant, true)],
    });

    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<{ user: UserAccountDto }>().user;
    expect(created.grants.map((row) => row.id)).toEqual([grant.id]);
    expect((await assignmentsOf(created.id))[0]).toMatchObject({
      grantId: grant.id,
      grantedBy: ctx.admin.id,
      origin: 'manual',
    });
    const audit = await auditOf(created.id);
    expect(audit.map((row) => row.action)).toEqual(['grant.assign', 'user.create']);
    expect(eventOf(audit, 'user.create').metadata.changes).toContainEqual({
      field: 'grantsGranted',
      from: null,
      to: grant.name,
    });
  });

  // ── Переход роли: зажигание и гашение (Р4, Р7, §4.3) ──

  /**
   * Страж блокирующего сценария Р4, и он же — сценарий этапа 8 реформы доступа.
   *
   * У «Штаба» взведённое переводом `vehicle_ordering` несовместимо и в форме скрыто; смена роли на
   * «Площадку» делает его совместимым — то есть вводит в диапазон разницы, — и высказывание о нём
   * приходит с галочкой. Не будь гидратации и правила диапазона, сервер прочёл бы «его в списке
   * оставшихся нет» и отозвал бы строку: откат перевода ищет **свои** идентификаторы и не нашёл бы
   * их (решение 3 ADR 0106).
   *
   * Зажигание проверяется по итоговым правам: сама роль «Площадка» заказа техники не даёт — значит
   * право пришло от набора, который перестал быть тёмным.
   */
  it('`shtab → site` сохраняет взведённое переводом назначение и зажигает его состав', async () => {
    const holder = await newObjectUser('shtab');
    const assignmentId = await assignRaw(holder.id, ctx.vehicleOrderingId, 'migration');
    const before = await cardOf(holder.id);
    expect(before.grants).toMatchObject([{ roleMismatch: true, origin: 'migration' }]);

    const res = await patchUser(holder.id, {
      role: 'site',
      grants: [say({ id: ctx.vehicleOrderingId, version: before.grants[0]!.version }, true)],
    });

    expect(res.statusCode, res.body).toBe(200);
    const [row, ...rest] = await assignmentsOf(holder.id);
    expect(rest).toHaveLength(0);
    // Та же строка: ни отзыва, ни повторной выдачи не было.
    expect(row!.id).toBe(assignmentId);
    expect(row!.origin).toBe('migration');

    const after = await cardOf(holder.id);
    expect(after.grants).toMatchObject([{ roleMismatch: false, origin: 'migration' }]);
    expect(ROLE_PERMISSIONS.site).not.toContain('vehicleRequests.create');
    expect(after.permissions).toContain('vehicleRequests.create');
  });

  /**
   * Обратная сторона того же перехода: назначение выходит из диапазона роли, права по нему гаснут,
   * а строка остаётся жить — `selected: false` здесь **подтверждение**, а не команда снять (§4.3).
   *
   * Дословный `site → shtab` из плана недостижим: шаг prepare этапа 8 закрыл вход в упраздняемые
   * роли (`retiringRoleIssue`), и назначить «Штаб» нельзя ни формой, ни ручкой. Проверяется поэтому
   * тот же переход на действующей роли без своей оси: гейт совместимости считает по `grant_roles`,
   * а не по именам ролей.
   */
  it('обратный переход права гасит, а строку с прежним `id` оставляет', async () => {
    const holder = await newObjectUser('site');
    const assignmentId = await assignRaw(holder.id, ctx.vehicleOrderingId, 'migration');
    const before = await cardOf(holder.id);
    expect(before.permissions).toContain('vehicleRequests.create');

    const res = await patchUser(holder.id, {
      role: 'mechanic',
      grants: [say({ id: ctx.vehicleOrderingId, version: before.grants[0]!.version }, false)],
    });

    expect(res.statusCode, res.body).toBe(200);
    const [row, ...rest] = await assignmentsOf(holder.id);
    expect(rest).toHaveLength(0);
    expect(row!.id).toBe(assignmentId);
    expect(row!.origin).toBe('migration');

    const after = await cardOf(holder.id);
    expect(after.grants).toMatchObject([{ roleMismatch: true }]);
    expect(after.permissions).not.toContain('vehicleRequests.create');
  });

  /**
   * Тот же флаг у **управляемого** назначения означает уже команду снять — и на взведённом
   * переводом она отклоняется (Р4). Отказ стоит до расчёта разницы: вычти мы неснимаемое из «снять»,
   * запрос был бы принят, а сделано было бы не то, о чём просили.
   */
  it('снятие управляемого взведённого переводом отклоняется, и назначение остаётся', async () => {
    const holder = await newObjectUser('site');
    const assignmentId = await assignRaw(holder.id, ctx.vehicleOrderingId, 'migration');
    const version = (await cardOf(holder.id)).grants[0]!.version;

    const res = await patchUser(holder.id, {
      grants: [say({ id: ctx.vehicleOrderingId, version }, false)],
    });

    expect(res.statusCode, res.body).toBe(400);
    const error = errorOf(res);
    expect(error.message).toContain('взведены переводом ролей');
    // Отказ по галочке приходит на поле: администратору нужно видеть, какая именно виновата (Р8).
    expect(error.fields?.grants).toBeTruthy();
    expect((await assignmentsOf(holder.id))[0]!.id).toBe(assignmentId);
  });

  /**
   * За диапазоном разницы остаются назначения, которых форма чекбоксами не показывает: роль убрали
   * из `grant_roles` уже после выдачи (§13.1 плана реструктуризации). Правка соседнего поля обязана
   * пройти мимо них — иначе снятие доступа выглядело бы правкой телефона.
   */
  it('назначение с несоответствием роли переживает правку чужого поля карточки', async () => {
    const holder = await newUser('mechanic');
    const alien = await createGrant({ permissions: ['wasteRequests.read'], roles: ['dispatcher'] });
    const assignmentId = await assignRaw(holder.id, alien.id);

    // Ни молчание, ни пустое высказывание его не трогают: управляемым он не стал, роль не менялась.
    expect((await patchUser(holder.id, { phone: '+7 926 000-00-02' })).statusCode).toBe(200);
    expect((await patchUser(holder.id, { grants: [] })).statusCode).toBe(200);

    expect((await assignmentsOf(holder.id)).map((row) => row.id)).toEqual([assignmentId]);
    expect(await userRow(holder.id)).toMatchObject({ phone: '9260000002' });
  });

  // ── Полнота высказывания и границы молчания (§4.2) ──

  /**
   * Правило закрывает класс ошибок, неустранимый по построению: сервер не отличает «администратор
   * снял галочку» от «экран этого набора не показал». Любая причина неполноты — каталог не
   * поместился на страницу, запрос оборвался, старая версия портала — превращалась бы в тихий отзыв
   * полномочий, которых никто не касался.
   */
  it('тело без строки об управляемом назначении — отказ, а не тихий отзыв', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    const assignmentId = await assignRaw(holder.id, grant.id);

    const res = await patchUser(holder.id, { grants: [] });

    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).message).toContain(grant.name);
    expect(errorOf(res).fields?.grants).toBeTruthy();
    expect((await assignmentsOf(holder.id))[0]!.id).toBe(assignmentId);
  });

  /**
   * Вторая половина той же пары: названное `selected: false` управляемое назначение снимается. Без
   * этой проверки первая доказывала бы лишь строгость, а не различимость двух намерений.
   */
  it('то же назначение с `selected: false` снимается: «не показали» и «сняли» различимы', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    await assignRaw(holder.id, grant.id);

    const res = await patchUser(holder.id, { grants: [say(grant, false)] });

    expect(res.statusCode, res.body).toBe(200);
    expect(await assignmentsOf(holder.id)).toHaveLength(0);
    expect((await auditOf(holder.id)).map((row) => row.action)).toEqual([
      'grant.revoke',
      'user.update',
    ]);
  });

  /**
   * Молчание законно ровно до тех пор, пока роль не меняет действия назначений. Смена роли
   * переключает гейт совместимости — состав зажигается или гаснет без единой галочки, — и увидеть
   * это администратор обязан **до** сохранения.
   *
   * Отказ приходит общей ошибкой формы, а не на поле: поля `grants` в запросе нет вовсе,
   * подсвечивать нечего, и виновата не галочка, а устаревший экран (Р8). Различие проверяется здесь
   * же — по нему видно, что маршрут выбирает ответ по коду нарушения, а не по одному лишь статусу.
   */
  it('запрос без поля, переключающий действие назначения, отклоняется и поля не подсвечивает', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['dispatcher'] });
    await assignRaw(holder.id, grant.id);

    const res = await patchUser(holder.id, { role: 'dispatcher' });

    expect(res.statusCode, res.body).toBe(400);
    const error = errorOf(res);
    expect(error.message).toContain(grant.name);
    expect(error.fields).toBeUndefined();
    expect(await userRow(holder.id)).toMatchObject({ role: 'mechanic' });
  });

  /** Обычная правка молчания не теряет: роль в ней не меняется, и условие не срабатывает. */
  it('тот же запрос без смены роли проходит и назначений не трогает', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['dispatcher'] });
    const assignmentId = await assignRaw(holder.id, grant.id);

    const res = await patchUser(holder.id, { phone: '+7 926 000-00-03' });

    expect(res.statusCode, res.body).toBe(200);
    expect((await assignmentsOf(holder.id)).map((row) => row.id)).toEqual([assignmentId]);
    expect(await userRow(holder.id)).toMatchObject({ role: 'mechanic', phone: '9260000003' });
  });

  // ── Версии участвующих наборов (Р7) ──

  /**
   * Состав набора могли изменить между открытием формы и сохранением — и человек получил бы права,
   * которых в подсказке не видел. Отпечатка последствий у этого пути нет вовсе (Р7), и вся защита —
   * версия в строке высказывания; проверяются четыре её применения: выдаваемый, снимаемый и
   * переключаемые сменой роли в обе стороны.
   *
   * Исход — 409 со своим кодом, а не 400 на поле: галочка не виновата, и делать надо другое —
   * перечитать карточку.
   */
  it('правка состава выдаваемого набора даёт 409 с именем набора', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    const shown = grant.version;
    await editGrantComposition(grant, ['wasteRequests.read', 'wasteRequests.create']);

    const res = await patchUser(holder.id, {
      grants: [say({ id: grant.id, version: shown }, true)],
    });

    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe(GRANT_CONFLICT_CODES.impactChanged);
    expect(errorOf(res).message).toContain(grant.name);
    expect(await assignmentsOf(holder.id)).toHaveLength(0);
  });

  it('правка состава снимаемого набора даёт тот же 409: лишается человек тоже состава', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    const assignmentId = await assignRaw(holder.id, grant.id);
    const shown = grant.version;
    await editGrantComposition(grant, ['wasteRequests.read', 'wasteRequests.create']);

    const res = await patchUser(holder.id, {
      grants: [say({ id: grant.id, version: shown }, false)],
    });

    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe(GRANT_CONFLICT_CODES.impactChanged);
    expect((await assignmentsOf(holder.id))[0]!.id).toBe(assignmentId);
  });

  it('зажигаемый сменой роли набор сверяется наравне с выдаваемым', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['dispatcher'] });
    await assignRaw(holder.id, grant.id);
    const shown = grant.version;
    await editGrantComposition(grant, ['wasteRequests.read', 'wasteRequests.create']);

    const res = await patchUser(holder.id, {
      role: 'dispatcher',
      grants: [say({ id: grant.id, version: shown }, true)],
    });

    expect(res.statusCode, res.body).toBe(409);
    expect(await userRow(holder.id)).toMatchObject({ role: 'mechanic' });
  });

  it('гасимый сменой роли набор сверяется тоже: подтверждают состав, который перестаёт действовать', async () => {
    const holder = await newUser('dispatcher');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['dispatcher'] });
    await assignRaw(holder.id, grant.id);
    const shown = grant.version;
    await editGrantComposition(grant, ['wasteRequests.read', 'wasteRequests.create']);

    const res = await patchUser(holder.id, {
      role: 'mechanic',
      grants: [say({ id: grant.id, version: shown }, false)],
    });

    expect(res.statusCode, res.body).toBe(409);
    expect(await userRow(holder.id)).toMatchObject({ role: 'dispatcher' });
  });

  /**
   * Версии наборов **вне** участвующего множества не сверяются: на результат они не влияют, а
   * лишний 409 заставлял бы переоткрывать форму из-за чужой правки соседнего набора.
   */
  it('правка соседнего набора сохранению не мешает', async () => {
    const holder = await newUser('mechanic');
    const managed = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    const neighbour = await createGrant({
      permissions: ['wasteRequests.read'],
      roles: ['dispatcher'],
    });
    await assignRaw(holder.id, managed.id);
    const neighbourAssignment = await assignRaw(holder.id, neighbour.id);
    const shownNeighbour = neighbour.version;
    await editGrantComposition(neighbour, ['wasteRequests.read', 'wasteRequests.update']);

    const res = await patchUser(holder.id, {
      grants: [say(managed, false), say({ id: neighbour.id, version: shownNeighbour }, false)],
    });

    expect(res.statusCode, res.body).toBe(200);
    // Управляемый снят, соседний — жив: `selected: false` вне диапазона роли ничего не снимает.
    expect((await assignmentsOf(holder.id)).map((row) => row.id)).toEqual([neighbourAssignment]);
  });

  // ── Барьеры итога (Р5) ──

  /**
   * Дыра, которую фича чинит: сегодня смена роли держателю набора проверяется лишь надстройками, а
   * пара, собранная суммой субъекта и набора, не ловится никем.
   *
   * Пара собрана ровно так: набор даёт согласование сметы, а её ведение приходит от **типа
   * контрагента**, назначаемого тем же запросом. Ролью половину пары в поставочной матрице не
   * набрать вовсе — ни одна роль, кроме `admin`, ни одного из этих двух прав не держит, — а тип
   * контрагента вторая ось того же субъекта и читается уже после правки.
   */
  it('пара разделения обязанностей собирается сменой субъекта и отклоняется с деталями', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({
      permissions: ['serviceRequests.approveEstimate'],
      roles: ['mechanic', 'operator'],
    });
    await assignRaw(holder.id, grant.id);

    const res = await patchUser(holder.id, {
      role: 'operator',
      counterpartyId: ctx.serviceCounterpartyId,
      grants: [say(grant, true)],
    });

    expect(res.statusCode, res.body).toBe(400);
    expect(violationCodes(res)).toContain('duty_conflict');
    expect(errorOf(res).fields?.grants).toBeTruthy();
    // Транзакция откатилась целиком: ни роли, ни контрагента правка не оставила.
    expect(await userRow(holder.id)).toMatchObject({ role: 'mechanic' });
  });

  /**
   * Второй барьер итога — «модуль закрывается чтением» (ADR 0021). Ловится он тем же способом:
   * набор даёт визу заказа, а чтение заказов давала прежняя роль, и смена роли его отбирает.
   * Поле `grants` в запросе есть, значит отказ приходит на него.
   */
  it('смена роли, отбирающая чтение модуля, отклоняется барьером требований', async () => {
    const holder = await newUser('dispatcher');
    const grant = await createGrant({
      permissions: ['vehicleRequests.approve'],
      roles: ['dispatcher', 'mechanic'],
    });
    await assignRaw(holder.id, grant.id);

    const res = await patchUser(holder.id, { role: 'mechanic', grants: [say(grant, true)] });

    expect(res.statusCode, res.body).toBe(400);
    expect(violationCodes(res)).toContain('requirement_missing');
    expect(await userRow(holder.id)).toMatchObject({ role: 'dispatcher' });
  });

  /**
   * Роль `driver` полномочий не принимает ни одним способом (инвариант 6 ADR 0106), и отвечают за
   * это два слоя. В исправном каталоге до барьера дело не доходит: `grant_roles` роли `driver` не
   * содержит по построению, и отмеченный набор отклоняется как несовместимый — список формы устарел.
   * На повреждённых данных (строка, появившаяся мимо конструктора) отвечает сам барьер и называет
   * причину, а не следствие.
   */
  it('роли «Водитель» полномочие не выдаётся ни списком, ни на повреждённых данных', async () => {
    const personId = await newPerson();
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    const toDriver = (): ReturnType<typeof ctx.app.inject> =>
      patchUser(holder.id, {
        role: 'driver',
        personId,
        confirmNameMismatch: true,
        grants: [say(grant, true)],
      });

    const listed = await toDriver();
    expect(listed.statusCode, listed.body).toBe(400);
    // Отказ именно по галочке, а не по работнику: путь поля называет `grants`, и список устарел.
    expect(errorOf(listed).fields?.grants).toContain('Водитель');

    // Строка `grant_roles`, появившаяся мимо конструктора: барьер обязан отвечать и на неё.
    await addRoleRaw(grant.id, 'driver');
    const broken = await toDriver();
    expect(broken.statusCode, broken.body).toBe(400);
    expect(violationCodes(broken)).toContain('role_not_grantable');

    expect(await userRow(holder.id)).toMatchObject({ role: 'mechanic' });
    expect(await assignmentsOf(holder.id)).toHaveLength(0);
  });

  /**
   * Полномочия себе не правятся (Р9) — рядом с запретами деактивировать себя и менять себе роль и
   * по той же причине: администратор не набирает себе доступ сам, даже вычитанием.
   */
  it('полномочия собственной учётной записи не правятся', async () => {
    const res = await patchUser(ctx.admin.id, { grants: [] });

    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).fields?.grants).toBeTruthy();
  });

  // ── Границы высказывания и итога (§4.2) ──

  it('высказывание длиннее предела отклоняется схемой, до всякого чтения базы', async () => {
    const holder = await newUser('mechanic');
    const rows = Array.from({ length: MAX_GRANT_STATEMENTS + 1 }, () => ({
      id: randomUUID(),
      version: 1,
      selected: false,
    }));

    const res = await patchUser(holder.id, { grants: rows });

    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe('validation_error');
  });

  /**
   * Полная замена — тот случай, ради которого границ две: в теле сходятся и снимаемые строки, и
   * выдаваемые, и одной границы на оба смысла не хватило бы. Итог при этом ровно в пределе.
   */
  it('полная замена предельного числа назначений проходит: в теле их вдвое больше', async () => {
    const holder = await newUser('mechanic');
    const held: TestGrant[] = [];
    const fresh: TestGrant[] = [];
    for (let i = 0; i < MAX_ASSIGNED_GRANTS; i += 1) {
      const oldOne = await createGrant({ roles: ['mechanic'] });
      await assignRaw(holder.id, oldOne.id);
      held.push(oldOne);
      fresh.push(await createGrant({ roles: ['mechanic'] }));
    }

    const res = await patchUser(holder.id, {
      grants: [...held.map((g) => say(g, false)), ...fresh.map((g) => say(g, true))],
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(await grantIdsOf(holder.id)).toEqual(fresh.map((g) => g.id).sort());
  }, 120_000);

  /**
   * Предел — инвариант **обоих** путей выдачи, а не проверка одной формы. Считай его точечная
   * выдача по-своему — она набила бы учётке больше назначений, чем форма способна высказать, и
   * карточка такого человека перестала бы сохраняться вовсе, включая правку телефона.
   */
  it('точечная выдача сверх предела отклоняется тем же счётом, что и форма', async () => {
    const holder = await newUser('mechanic');
    for (let i = 0; i < MAX_ASSIGNED_GRANTS; i += 1) {
      const grant = await createGrant({ roles: ['mechanic'] });
      await assignRaw(holder.id, grant.id);
    }
    const extra = await createGrant({ roles: ['mechanic'] });

    const res = await assignFromRegistry(holder.id, extra.id);

    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).message).toContain(String(MAX_ASSIGNED_GRANTS));
    expect(await assignmentsOf(holder.id)).toHaveLength(MAX_ASSIGNED_GRANTS);
  }, 120_000);

  // ── Гашение выданных токенов (Р10) ──

  /**
   * Выданный набор обязан начать действовать тогда, когда его выдали, а не когда истечёт последний
   * выданный токен. `authVersion` сверяется с access-токеном на каждом запросе, refresh-сессии
   * гасятся после коммита — они живут своей таблицей, и откатывать их вместе с правкой нечем.
   */
  it('изменившееся множество назначений поднимает версию прав и гасит сессии', async () => {
    const holder = await newAccount('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    const before = await userRow(holder.id);
    expect(await liveSessions(holder.id)).toBe(1);

    const res = await patchUser(holder.id, { grants: [say(grant, true)] });

    expect(res.statusCode, res.body).toBe(200);
    expect((await userRow(holder.id)).authVersion).toBe(before.authVersion + 1);
    expect(await liveSessions(holder.id)).toBe(0);
  });

  /** Не изменилось ничего — гасить нечего: сохранение карточки не должно выбрасывать человека. */
  it('неизменившееся множество ни версии прав, ни сессий не трогает', async () => {
    const holder = await newAccount('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    await assignRaw(holder.id, grant.id);
    const before = await userRow(holder.id);

    const res = await patchUser(holder.id, { grants: [say(grant, true)] });

    expect(res.statusCode, res.body).toBe(200);
    expect((await userRow(holder.id)).authVersion).toBe(before.authVersion);
    expect(await liveSessions(holder.id)).toBe(1);
  });

  // ── Журнал (Р11, §5.1, §5.2) ──

  /**
   * Из формы пишутся **те же** события, что из реестра, и с тем же составом `metadata`: иначе срез
   * журнала (ADR 0117) и вопрос «кто выдал этот набор» отвечали бы половиной правды — выдачи,
   * сделанные при правке карточки, в них бы не появились.
   *
   * Порядок объявлен и обязателен: сначала отзывы, затем выдачи, внутри группы — по возрастанию
   * `grant_id`. Проверяется он на паре наборов, чьи идентификаторы заранее упорядочены.
   */
  it('выдача и отзыв пишутся событиями реестра с полной metadata', async () => {
    const holder = await newUser('mechanic');
    const goingAway = await createGrant({
      permissions: ['wasteRequests.update'],
      roles: ['mechanic'],
    });
    const coming = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    const assignmentId = await assignRaw(holder.id, goingAway.id);

    const res = await patchUser(holder.id, { grants: [say(goingAway, false), say(coming, true)] });
    expect(res.statusCode, res.body).toBe(200);

    const audit = await auditOf(holder.id);
    expect(audit.map((row) => row.action)).toEqual(['grant.assign', 'grant.revoke', 'user.update']);
    const revoke = eventOf(audit, 'grant.revoke');
    expect(revoke.actorUserId).toBe(ctx.admin.id);
    expect(revoke.metadata).toMatchObject({
      grantId: goingAway.id,
      grantCode: goingAway.code,
      grantName: goingAway.name,
      // Идентификатор снятой строки: после удаления опознать её больше нечем, а откат перевода
      // ролей ищет свои назначения именно по нему.
      assignmentId,
      origin: 'manual',
      // Роль **после** правки: под ней набор и действовал.
      role: 'mechanic',
      permissions: ['wasteRequests.update'],
      permissionsAdded: [],
      permissionsRemoved: ['wasteRequests.update'],
    });
    const created = (await assignmentsOf(holder.id))[0]!;
    expect(eventOf(audit, 'grant.assign').metadata).toMatchObject({
      grantId: coming.id,
      grantCode: coming.code,
      grantName: coming.name,
      assignmentId: created.id,
      origin: 'manual',
      role: 'mechanic',
      permissions: ['wasteRequests.read'],
      permissionsAdded: ['wasteRequests.read'],
      permissionsRemoved: [],
    });
    // Перечень изменений события правки называет обе стороны рядом с ролью и областью (ADR 0109).
    const update = eventOf(audit, 'user.update');
    expect(update.metadata.changes).toEqual(
      expect.arrayContaining([
        { field: 'grantsGranted', from: null, to: coming.name },
        { field: 'grantsRevoked', from: null, to: goingAway.name },
      ]),
    );
    expect(update.metadata).toMatchObject({ grantsChanged: true });
  });

  /**
   * Объявленный порядок событий (§5.2) проверяется своим следствием, а не чтением строк: физического
   * порядка записи в `audit_log` не существует — все события операции пишутся одной транзакцией,
   * `created_at` у них равен её `now()`, а ключ случаен.
   *
   * Следствие же наблюдаемо и есть само правило: право, которое дают два выдаваемых набора, попадает
   * в событие **первого по `grant_id`**, а второе показывает пустую добавку — «сверх уже имеющегося
   * не дал». Сумма событий при этом равна итоговой дельте без взаимных погашений.
   */
  it('право двух выдаваемых наборов попадает в событие первого по `grant_id`', async () => {
    const holder = await newUser('mechanic');
    const one = await createGrant({
      permissions: ['wasteRequests.read', 'wasteRequests.update'],
      roles: ['mechanic'],
    });
    const two = await createGrant({
      permissions: ['wasteRequests.read', 'wasteRequests.create'],
      roles: ['mechanic'],
    });
    const [first, second] = [one, two].sort((a, b) => (a.id < b.id ? -1 : 1));

    const res = await patchUser(holder.id, { grants: [say(one, true), say(two, true)] });
    expect(res.statusCode, res.body).toBe(200);

    const audit = await auditOf(holder.id);
    const assigned = audit.filter((row) => row.action === 'grant.assign');
    const addedOf = (grantId: string): string[] =>
      assigned.find((row) => row.metadata.grantId === grantId)!.metadata
        .permissionsAdded as string[];
    expect(addedOf(first!.id)).toContain('wasteRequests.read');
    expect(addedOf(second!.id)).not.toContain('wasteRequests.read');
    // Взаимных погашений нет: вместе события называют ровно то, что человек получил.
    expect([...addedOf(first!.id), ...addedOf(second!.id)].sort()).toEqual([
      'wasteRequests.create',
      'wasteRequests.read',
      'wasteRequests.update',
    ]);
  });

  /**
   * События раскладывают **итоговую** дельту операции, а не пошаговый пересчёт, и отвергнут он был
   * именно на замене: снимают набор A и выдают B, оба дают одно право — пошаговый пересчёт написал
   * бы «право снято», а следом «право добавлено», хотя транзакционно доступ не прерывался ни на
   * мгновение.
   */
  it('замена наборов с общим правом не пишет по нему ни «снято», ни «добавлено»', async () => {
    const holder = await newUser('mechanic');
    const old = await createGrant({
      permissions: ['wasteRequests.read', 'wasteRequests.update'],
      roles: ['mechanic'],
    });
    const next = await createGrant({
      permissions: ['wasteRequests.read', 'wasteRequests.create'],
      roles: ['mechanic'],
    });
    await assignRaw(holder.id, old.id);

    const res = await patchUser(holder.id, { grants: [say(old, false), say(next, true)] });
    expect(res.statusCode, res.body).toBe(200);

    const audit = await auditOf(holder.id);
    const revoke = audit.find((row) => row.action === 'grant.revoke')!;
    const assign = audit.find((row) => row.action === 'grant.assign')!;
    // Общее право не названо ни одной из сторон: доступ по нему не прерывался.
    expect(revoke.metadata.permissionsRemoved).toEqual(['wasteRequests.update']);
    expect(assign.metadata.permissionsAdded).toEqual(['wasteRequests.create']);
    expect(await cardOf(holder.id)).toMatchObject({
      permissions: expect.arrayContaining(['wasteRequests.read']),
    });
  });

  /**
   * Доступ, изменённый без события, — ровно то состояние, ради разбора которого реестр выдач и
   * заведён. Поэтому запись событий доступа строгая: её сбой откатывает операцию целиком, а не
   * глотается, как у остального журнала (§5.1).
   */
  it('сбой записи журнала откатывает операцию целиком', async () => {
    const holder = await newUser('mechanic');
    const grant = await createGrant({ permissions: ['wasteRequests.read'], roles: ['mechanic'] });
    const before = await userRow(holder.id);

    await withBrokenAudit(holder.id, async () => {
      const res = await patchUser(holder.id, {
        phone: '+7 926 000-00-04',
        grants: [say(grant, true)],
      });
      expect(res.statusCode, res.body).toBe(500);
    });

    // Ни назначения, ни правки карточки, ни поднятой версии прав: транзакция была одна.
    expect(await assignmentsOf(holder.id)).toHaveLength(0);
    expect(await userRow(holder.id)).toMatchObject({
      phone: before.phone,
      authVersion: before.authVersion,
    });
    expect(await auditOf(holder.id)).toHaveLength(0);
  });
});
