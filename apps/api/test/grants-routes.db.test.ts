import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SYSTEM_GRANT_CODES,
  type GrantCardDto,
  type GrantDto,
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
 * Серверный каталог полномочий через HTTP, на живой схеме (ADR 0106, этап 3; план §12 и §13.1).
 *
 * **Что здесь проверяется и почему только здесь.** `grants-contracts.test.ts` проверяет барьеры как
 * функцию: подай ей состав — получи список нарушений. Заявление этапа 3 шире и целиком про
 * операцию: барьеры считаются по **итогу каждого держателя**, версия набора растёт, держателям
 * гасятся токены, системный набор не правится, выданный не удаляется, и всё это происходит одной
 * транзакцией под блокировками. Ни одно из этих утверждений не проверяется на составе набора: у
 * него нет ни держателей, ни версии, ни `authVersion`.
 *
 * **Чем этот файл отличается от `user-grants-routes.db.test.ts`.** Тот про назначения на путях
 * учётки (кому выдано), этот — про сам каталог (что в наборе). Пересечение у них одно и
 * намеренное: держателя здесь заводит прямой `INSERT` в `user_grants`, потому что маршрута выдачи
 * ещё нет — он приходит следующей волной вместе с карточкой учётки. Как только он появится,
 * держатель в этом файле будет заводиться им, а проверки останутся те же.
 *
 * **Что ловится только отсюда.** Пересчёт по итогу: правка, снимающая из набора право чтения,
 * отклоняется не потому, что состав плох (он безупречен), а потому что у держателя остаётся
 * действие в модуле, которого он больше не видит. Второе — гашение токенов: правка состава без
 * поднятого `authVersion` начала бы действовать не тогда, когда её сохранили, а когда истёк
 * последний выданный токен.
 *
 * **Общий прогон.** Свои префиксы кодов и адресов, уборка по ним же до и после; утверждений обо
 * всей базе нет — про системные наборы проверяется только то, что они есть и не правятся, а их
 * держателей заводят соседние тесты.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/grants-routes.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Метки своих строк: уборка идёт по ним, а не «по последним записям». */
const EMAIL_PREFIX = 'db-grants-routes';
const GRANT_PREFIX = 'db_grants_routes';
/** Уникальный хвост прогона: код набора и адрес учётки уникальны в базе. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');

const PASSWORD = 'db-test-password-123';

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
  /** Диспетчер: у него нет `users.manage`, и каталог обязан отвечать ему 403 на каждой ручке. */
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
 * Уборка. Порядок обязателен: записи журнала уходят первыми (`entity_id` там текстовый и каскадом
 * не убирается), затем учётки — они уносят назначения каскадом по `user_id`, — и только потом сами
 * наборы: `user_grants.grant_id` стоит под RESTRICT, и выданный набор не удаляется вовсе.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'grant' AND entity_id IN (
    SELECT id::text FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'user' AND entity_id IN (
    SELECT id::text FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`}`);
}

/** Учётка в базе. Токен ей не нужен: держатель наборов сам в портал не ходит. */
async function newUser(role: Role, suffix: string): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `${EMAIL_PREFIX}-${suffix}-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: 'Пользователь',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return { id: created!.id, email };
}

/** Учётка с настоящим входом: каталог ходит под правом, а не под подменённым принципалом. */
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
 * Держатель наборов — своя учётка на каждый тест, а не одна общая.
 *
 * Причина в самом предмете проверки: барьеры считаются по **итогу** держателя, то есть по всем его
 * наборам сразу. Одна учётка на файл копила бы права от теста к тесту, и отказ в одном тесте начал
 * бы зависеть от того, что успел выдать предыдущий, — а его правка ломала бы соседей молча.
 *
 * Роль `mechanic`: своей оси области у неё нет, поэтому матрица «ось × модуль» не запрещает ей ни
 * одного модуля — барьеры итога проверяются без помех от барьеров набора.
 */
function newHolder(): Promise<{ id: string; email: string }> {
  return newUser('mechanic', 'holder');
}

function freshCode(): string {
  seq += 1;
  return `${GRANT_PREFIX}_${RUN}_${seq}`;
}

// ── Ручки каталога ──

function listGrants(account: Account, query = '') {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/grants${query ? `?${query}` : ''}`,
    headers: account.auth,
  });
}

function getGrant(account: Account, id: string) {
  return ctx.app.inject({ method: 'GET', url: `/api/v1/grants/${id}`, headers: account.auth });
}

function postGrant(account: Account, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/grants',
    headers: account.auth,
    payload: body,
  });
}

function patchGrant(account: Account, id: string, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/grants/${id}`,
    headers: account.auth,
    payload: body,
  });
}

/**
 * Отпечаток правильного вида, но заведомо не тот. Нужен там, где проверяется отказ **до** сверки
 * последствий: страж прав и «набора нет». Схема поля стоит раньше стража, и без формально верного
 * значения такой тест получил бы 400 от схемы вместо проверяемого ответа.
 */
const WELL_FORMED_HASH = 'f'.repeat(64);

/** Предпросмотр правки: он же выдаёт отпечаток последствий, которым правка подтверждается. */
function previewGrant(account: Account, id: string, body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/grants/${id}/preview`,
    headers: account.auth,
    payload: body,
  });
}

/**
 * Правка так, как её делает администратор: сперва предпросмотр последствий, затем сохранение с
 * полученным отпечатком (ADR 0106, решение 7). Отпечаток обязателен именно потому, что версии
 * состава мало: набор могли выдать ещё одному человеку, ничего в составе не меняя.
 *
 * Отдельные тесты ниже правят набор **без** отпечатка и с **устаревшим** — эта дорога проверяется
 * своими проверками, а не сквозь общий хелпер.
 */
async function applyGrantPatch(account: Account, id: string, body: Record<string, unknown>) {
  const preview = await previewGrant(account, id, body);
  if (preview.statusCode !== 200) return preview;
  const { expectedImpactHash } = preview.json() as { expectedImpactHash: string };
  return patchGrant(account, id, { ...body, expectedImpactHash });
}

function deleteGrant(account: Account, id: string) {
  return ctx.app.inject({ method: 'DELETE', url: `/api/v1/grants/${id}`, headers: account.auth });
}

/** Набор, созданный маршрутом: дальше его правят и удаляют те же ручки. */
async function createGrant(over: Record<string, unknown> = {}): Promise<GrantCardDto> {
  const code = freshCode();
  const res = await postGrant(ctx.admin, {
    code,
    name: `Набор каталога ${code}`,
    description: 'Набор заведён тестом каталога',
    permissions: [],
    roles: [],
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<GrantCardDto>();
}

/**
 * Держатель набора прямым `INSERT`: маршрута выдачи ещё нет (следующая волна). `origin: 'manual'` —
 * выдал человек; `migration` зарезервирован за переводом ролей.
 */
async function assign(grantId: string, userId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.userGrants)
    .values({ userId, grantId, grantedBy: ctx.admin.id, origin: 'manual' })
    .returning({ id: ctx.schema.userGrants.id });
  return row!.id;
}

async function grantRow(id: string): Promise<{ version: number; deletedAt: Date | null }> {
  const [row] = await ctx.db
    .select({ version: ctx.schema.grants.version, deletedAt: ctx.schema.grants.deletedAt })
    .from(ctx.schema.grants)
    .where(eq(ctx.schema.grants.id, id));
  return row!;
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

/** Журнал по набору: `entity_type = 'grant'`, цель — сам набор (у правки состава нет одной жертвы). */
async function auditOf(grantId: string): Promise<AuditRow[]> {
  return ctx.db
    .select({
      action: ctx.schema.auditLog.action,
      actorUserId: ctx.schema.auditLog.actorUserId,
      metadata: ctx.schema.auditLog.metadata,
    })
    .from(ctx.schema.auditLog)
    .where(
      and(eq(ctx.schema.auditLog.entityType, 'grant'), eq(ctx.schema.auditLog.entityId, grantId)),
    )
    .orderBy(asc(ctx.schema.auditLog.createdAt)) as Promise<AuditRow[]>;
}

/** Коды нарушений из тела отказа: экран подсвечивает по ним, а не по тексту. */
function violationCodes(body: string): GrantViolationCode[] {
  const details = JSON.parse(body).details as GrantValidationDetailsDto | undefined;
  return (details?.violations ?? []).map((v) => v.code);
}

function holderViolations(body: string): GrantValidationDetailsDto['holders'] {
  const details = JSON.parse(body).details as GrantValidationDetailsDto | undefined;
  return details?.holders ?? [];
}

describe.skipIf(!DB_URL)('каталог назначаемых полномочий: маршруты на живой схеме', () => {
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
      outsider: { id: '', email: '', auth: { authorization: '' } },
    };
    ctx.admin = await newAccount('admin', 'admin');
    ctx.outsider = await newAccount('dispatcher', 'outsider');

    const present = new Set(
      (await db.select({ code: schema.grants.code }).from(schema.grants)).map((row) => row.code),
    );
    for (const code of SYSTEM_GRANT_CODES) {
      if (!present.has(code)) throw new Error(`В базе нет системного набора «${code}»`);
    }
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── Доступ ──

  /**
   * Условие доступа объявлено манифестом и проверено перебором (`access-conditions.test.ts`), но
   * там субъект синтетический: права приходят подменённым принципалом. Здесь отказ проверяется на
   * настоящей учётке с настоящим входом — то есть на том же пути, каким в каталог придёт диспетчер.
   */
  it('чужая роль не открывает ни одной ручки каталога', async () => {
    const grant = await createGrant();
    for (const res of [
      await listGrants(ctx.outsider),
      await getGrant(ctx.outsider, grant.id),
      await postGrant(ctx.outsider, { code: freshCode(), name: 'Набор диспетчера' }),
      await patchGrant(ctx.outsider, grant.id, {
        expectedVersion: grant.version,
        name: 'Иное',
        expectedImpactHash: WELL_FORMED_HASH,
      }),
      await deleteGrant(ctx.outsider, grant.id),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }
    // Отказ не оставил следов: версия та же, набор жив.
    expect(await grantRow(grant.id)).toMatchObject({ version: grant.version, deletedAt: null });
  });

  // ── Каталог ──

  it('каталог отдаёт состав, роли и число держателей; фильтры делят классы', async () => {
    const holder = await newHolder();
    const name = `Приёмка топлива ${RUN}`;
    const grant = await createGrant({
      name,
      permissions: ['vehicleReadings.read', 'vehicleReadings.write'],
      roles: ['mechanic', 'dispatcher'],
    });
    await assign(grant.id, holder.id);

    const own = await listGrants(ctx.admin, `search=${encodeURIComponent(name)}`);
    expect(own.statusCode, own.body).toBe(200);
    const found = own.json<{ items: GrantDto[] }>().items.find((row) => row.id === grant.id);
    expect(found, 'набор найден поиском по названию').toBeDefined();
    expect(found!.isSystem).toBe(false);
    expect(found!.version).toBe(1);
    // Порядок состава — словарный, а не порядок галочек в запросе и не алфавит кодов.
    expect(found!.permissions).toEqual(['vehicleReadings.read', 'vehicleReadings.write']);
    // Порядок ролей — по словарю `ROLES`: диспетчер в нём стоит раньше механика.
    expect(found!.roles).toEqual(['dispatcher', 'mechanic']);
    expect(found!.holderCount).toBe(1);
    expect(found!.unknownPermissions).toEqual([]);

    // Фильтр по классу: свой набор виден только среди пользовательских, системные — только среди
    // системных. Утверждений обо всей базе нет: соседние тесты заводят свои наборы.
    const custom = await listGrants(ctx.admin, 'kind=custom&pageSize=500');
    const customItems = custom.json<{ items: GrantDto[] }>().items;
    expect(customItems.some((row) => row.id === grant.id)).toBe(true);
    expect(customItems.every((row) => !row.isSystem)).toBe(true);

    const system = await listGrants(ctx.admin, 'kind=system&pageSize=500');
    const systemItems = system.json<{ items: GrantDto[] }>().items;
    expect(systemItems.every((row) => row.isSystem)).toBe(true);
    for (const code of SYSTEM_GRANT_CODES) {
      expect(
        systemItems.some((row) => row.code === code),
        `в каталоге нет «${code}»`,
      ).toBe(true);
    }
    expect(systemItems.some((row) => row.id === grant.id)).toBe(false);
  });

  /** Карточка — это каталожная строка плюс реестр выдач (§12): кому, кем и когда выдано. */
  it('карточка показывает держателя, автора выдачи и происхождение', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });
    const assignmentId = await assign(grant.id, holder.id);

    const res = await getGrant(ctx.admin, grant.id);
    expect(res.statusCode, res.body).toBe(200);
    const card = res.json<GrantCardDto>();
    expect(card.holderCount).toBe(1);
    expect(card.holders).toHaveLength(1);
    expect(card.holders[0]).toMatchObject({
      assignmentId,
      userId: holder.id,
      email: holder.email,
      role: 'mechanic',
      roleMismatch: false,
      isActive: true,
      isArchived: false,
      origin: 'manual',
    });
    expect(card.holders[0]!.grantedByName).toContain('Тестовый');
  });

  /**
   * Право-сирота (ADR 0106, решение 3): право хранится текстом, справочника прав в базе нет, и
   * выкат, снявший право из словаря, оставляет в наборе строку, которой не соответствует ничего.
   * Доступа она не даёт никогда, но и молчать о ней нельзя — витрина показывает её отдельным полем.
   *
   * Уносит её только правка **состава**: присланный состав заменяет прежний целиком. Правка
   * названия сироту не трогает — иначе переименование меняло бы состав набора и поднимало бы
   * `authVersion` всем держателям за исправленную опечатку.
   */
  it('право-сирота видно отдельным полем и уходит только правкой состава', async () => {
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });
    await ctx.db
      .insert(ctx.schema.grantPermissions)
      .values({ grantId: grant.id, permission: 'garage.readOld' });

    const card = await getGrant(ctx.admin, grant.id);
    expect(card.json<GrantCardDto>().permissions).toEqual(['garage.read']);
    expect(card.json<GrantCardDto>().unknownPermissions).toEqual(['garage.readOld']);

    const renamed = await applyGrantPatch(ctx.admin, grant.id, {
      expectedVersion: grant.version,
      name: `${grant.name} (переименованный)`,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<GrantCardDto>().unknownPermissions).toEqual(['garage.readOld']);

    const composed = await applyGrantPatch(ctx.admin, grant.id, {
      expectedVersion: grant.version + 1,
      permissions: ['garage.read'],
    });
    expect(composed.statusCode, composed.body).toBe(200);
    expect(composed.json<GrantCardDto>().unknownPermissions).toEqual([]);
    expect(composed.json<GrantCardDto>().permissions).toEqual(['garage.read']);
    expect((await auditOf(grant.id)).at(-1)!.metadata).toMatchObject({
      permissionsRemoved: ['garage.readOld'],
    });
  });

  // ── Создание ──

  it('создание пишет состав, версию и журнал', async () => {
    const code = freshCode();
    const res = await postGrant(ctx.admin, {
      code,
      name: 'Журнал путевых листов',
      description: 'Один набор из плана §12',
      permissions: ['garage.read'],
      roles: ['dispatcher'],
    });
    expect(res.statusCode, res.body).toBe(201);
    const card = res.json<GrantCardDto>();
    expect(card).toMatchObject({
      code,
      name: 'Журнал путевых листов',
      description: 'Один набор из плана §12',
      isSystem: false,
      version: 1,
      holderCount: 0,
    });
    expect(card.permissions).toEqual(['garage.read']);
    expect(card.roles).toEqual(['dispatcher']);
    expect(card.holders).toEqual([]);

    const audit = await auditOf(card.id);
    expect(audit.map((row) => row.action)).toEqual(['grant.create']);
    expect(audit[0]!.actorUserId).toBe(ctx.admin.id);
    expect(audit[0]!.metadata).toMatchObject({ grantCode: code, grantName: card.name });
  });

  /**
   * Барьер 1 — невыдаваемое право (`NON_GRANTABLE_PERMISSIONS`). Проверяется именно `users.manage`:
   * право, которым набирают права, собранное набором, замыкает модель саму на себя.
   */
  it('невыдаваемое право не создаёт набор', async () => {
    const res = await postGrant(ctx.admin, {
      code: freshCode(),
      name: 'Набор с ведением учёток',
      permissions: ['users.manage', 'garage.read'],
      roles: ['dispatcher'],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(violationCodes(res.body)).toEqual(['permission_not_grantable']);
    // Пометка поля формы, а не общий текст: перечень прав в конструкторе один на все роли.
    expect(res.json<{ fields?: { permissions?: string } }>().fields?.permissions).toMatch(
      /не выдаётся полномочиями/u,
    );
    expect(res.json<{ message: string }>().message).toContain('users.manage');
  });

  it('роль водителя набора не принимает ни одним способом', async () => {
    const res = await postGrant(ctx.admin, {
      code: freshCode(),
      name: 'Набор для водителя',
      permissions: ['garage.read'],
      roles: ['driver', 'mechanic'],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(violationCodes(res.body)).toEqual(['role_not_grantable']);
    expect(res.json<{ fields?: { roles?: string } }>().fields?.roles).toMatch(/не принимает/u);
  });

  /**
   * Барьер 3 — декартово произведение «роль × право» против матрицы осей. Журнал путевых листов не
   * сужается ничем, а у роли `shtab` есть объектная ось: набор открыл бы ей листы всей компании
   * вместе с персональными данными водителей.
   */
  it('запрещённая клетка матрицы осей набор не создаёт', async () => {
    const res = await postGrant(ctx.admin, {
      code: freshCode(),
      name: 'Листы для площадки',
      permissions: ['waybills.read'],
      roles: ['shtab'],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(violationCodes(res.body)).toEqual(['module_forbidden_for_axis']);
    expect(res.json<{ message: string }>().message).toMatch(/нет фильтрации по её области/u);
  });

  it('код системного набора и занятый код отклоняются', async () => {
    const system = await postGrant(ctx.admin, {
      code: SYSTEM_GRANT_CODES[1],
      name: 'Подделка визы ИТ',
      permissions: ['garage.read'],
      roles: ['dispatcher'],
    });
    // Схема, а не обработчик: сквозную область таблица кода ищет **по коду**, и до базы такой
    // запрос доходить не должен вовсе.
    expect(system.statusCode, system.body).toBe(400);
    expect(system.json<{ fields?: { code?: string } }>().fields?.code).toMatch(/системным/u);

    const first = await createGrant();
    const dup = await postGrant(ctx.admin, { code: first.code, name: 'Второй под тем же кодом' });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json<{ code: string }>().code).toBe('grant_code_taken');
  });

  // ── Правка ──

  it('системный набор не редактируется и не удаляется', async () => {
    const list = await listGrants(ctx.admin, 'kind=system&pageSize=500');
    const operator = list
      .json<{ items: GrantDto[] }>()
      .items.find((row) => row.code === SYSTEM_GRANT_CODES[0])!;

    const patched = await applyGrantPatch(ctx.admin, operator.id, {
      expectedVersion: operator.version,
      name: 'Оператор оргтехники (правленый)',
      permissions: ['garage.read'],
    });
    expect(patched.statusCode, patched.body).toBe(409);
    expect(patched.json<{ code: string }>().code).toBe('grant_is_system');
    expect(patched.json<{ message: string }>().message).toMatch(/не редактируется/u);

    const removed = await deleteGrant(ctx.admin, operator.id);
    expect(removed.statusCode, removed.body).toBe(409);
    expect(removed.json<{ code: string }>().code).toBe('grant_is_system');

    // Состав системного набора остался прежним: отказ пришёл до записи, а не после половины её.
    const after = await getGrant(ctx.admin, operator.id);
    expect(after.json<GrantCardDto>()).toMatchObject({
      name: operator.name,
      version: operator.version,
      permissions: operator.permissions,
    });
  });

  it('устаревшая версия правку не применяет', async () => {
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });

    const first = await applyGrantPatch(ctx.admin, grant.id, {
      expectedVersion: grant.version,
      name: 'Первая правка',
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<GrantCardDto>().version).toBe(grant.version + 1);

    // Второй администратор держит в руках карточку, прочитанную до первой правки.
    const stale = await applyGrantPatch(ctx.admin, grant.id, {
      expectedVersion: grant.version,
      name: 'Правка по устаревшей карточке',
      permissions: [],
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('version_conflict');

    const card = await getGrant(ctx.admin, grant.id);
    expect(card.json<GrantCardDto>()).toMatchObject({
      name: 'Первая правка',
      version: grant.version + 1,
    });
    expect(card.json<GrantCardDto>().permissions).toEqual(['garage.read']);
  });

  /**
   * Главное утверждение файла. Правка состава меняет доступ держателю — значит его токены обязаны
   * погаснуть той же транзакцией; правка названия доступа не меняет — и гасить нечего, иначе
   * «сохранить карточку, поправив опечатку» выкидывало бы людей из портала.
   */
  it('правка состава поднимает версию и authVersion держателям, правка названия — только версию', async () => {
    const holder = await newHolder();
    const grant = await createGrant({
      permissions: ['vehicleReadings.read'],
      roles: ['mechanic'],
    });
    await assign(grant.id, holder.id);
    const before = await authVersionOf(holder.id);

    const composed = await applyGrantPatch(ctx.admin, grant.id, {
      expectedVersion: grant.version,
      permissions: ['vehicleReadings.read', 'vehicleReadings.write'],
    });
    expect(composed.statusCode, composed.body).toBe(200);
    expect(composed.json<GrantCardDto>().version).toBe(grant.version + 1);
    const afterCompose = await authVersionOf(holder.id);
    expect(afterCompose).toBeGreaterThan(before);

    const renamed = await applyGrantPatch(ctx.admin, grant.id, {
      expectedVersion: grant.version + 1,
      name: 'Приёмка топлива (переименованный)',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    // Версия растёт и здесь: `expectedVersion` отвечает на «то ли я правлю, что видел», и
    // переименование делает прежнюю карточку такой же устаревшей.
    expect(renamed.json<GrantCardDto>().version).toBe(grant.version + 2);
    expect(await authVersionOf(holder.id)).toBe(afterCompose);

    const audit = await auditOf(grant.id);
    expect(audit.map((row) => row.action)).toEqual([
      'grant.create',
      'grant.update',
      'grant.update',
    ]);
    expect(audit[1]!.metadata).toMatchObject({
      permissionsAdded: ['vehicleReadings.write'],
      permissionsRemoved: [],
      accessChanged: true,
      holders: 1,
    });
    expect(audit[2]!.metadata).toMatchObject({ accessChanged: false, holders: 1 });
    expect(audit[2]!.metadata.name).toMatchObject({ to: 'Приёмка топлива (переименованный)' });
  });

  /**
   * Пересчёт по итогу, барьер «модуль закрывается чтением». Состав `[vehicleRequests.status]`
   * безупречен сам по себе — механику модуль заказа ТС матрицей осей не запрещён, — а вот у
   * держателя после правки остаётся действие в модуле, которого он не видит: `vehicleRequests.read`
   * ему не даёт ни роль, ни другой набор. Проверить это на составе набора нельзя вовсе.
   */
  it('правка, оставляющая держателя с действием без чтения, отклоняется по итогу', async () => {
    const holder = await newHolder();
    const grant = await createGrant({
      permissions: ['vehicleRequests.read', 'vehicleRequests.status'],
      roles: ['mechanic'],
    });
    await assign(grant.id, holder.id);
    const before = await authVersionOf(holder.id);

    const res = await applyGrantPatch(ctx.admin, grant.id, {
      expectedVersion: grant.version,
      permissions: ['vehicleRequests.status'],
    });
    expect(res.statusCode, res.body).toBe(400);
    // Барьеров набора здесь нет: виноват не состав, а итог у держателя — и отказ называет его.
    expect(violationCodes(res.body)).toEqual([]);
    const holders = holderViolations(res.body);
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ userId: holder.id });
    expect(holders[0]!.violations.map((v) => v.code)).toEqual(['requirement_missing']);
    expect(holders[0]!.violations[0]!.requires).toBe('vehicleRequests.read');

    // Правка откатилась целиком: версия, состав и токены держателя те же.
    expect(await grantRow(grant.id)).toMatchObject({ version: grant.version });
    expect(await authVersionOf(holder.id)).toBe(before);
    const card = await getGrant(ctx.admin, grant.id);
    expect(card.json<GrantCardDto>().permissions).toEqual([
      'vehicleRequests.read',
      'vehicleRequests.status',
    ]);
  });

  /**
   * Второй барьер итога — разделение обязанностей. Пара собирается **суммой**: половина уже выдана
   * держателю первым набором, вторая приезжает правкой второго, и внутри каждого набора по
   * отдельности запрещённой пары нет.
   */
  it('правка, сводящая конфликт обязанностей у держателя, отклоняется', async () => {
    const holder = await newHolder();
    const first = await createGrant({
      permissions: ['serviceRequests.read', 'serviceRequests.estimate'],
      roles: ['mechanic'],
    });
    await assign(first.id, holder.id);
    const second = await createGrant({
      permissions: ['serviceRequests.read'],
      roles: ['mechanic'],
    });
    await assign(second.id, holder.id);

    const res = await applyGrantPatch(ctx.admin, second.id, {
      expectedVersion: second.version,
      permissions: ['serviceRequests.read', 'serviceRequests.approveEstimate'],
    });
    expect(res.statusCode, res.body).toBe(400);
    const holders = holderViolations(res.body);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.violations.map((v) => v.code)).toEqual(['duty_conflict']);
    expect(holders[0]!.violations[0]!.conflict?.permissions).toEqual([
      'serviceRequests.estimate',
      'serviceRequests.approveEstimate',
    ]);
    expect(await grantRow(second.id)).toMatchObject({ version: second.version });
  });

  /**
   * Роль, убранная из списка совместимых (§13.1): назначение **сохраняется** и помечается в реестре,
   * новых выдач этой роли не будет. Молчаливый массовый отзыв опаснее несоответствия — но доступ по
   * набору держатель теряет (гейт совместимости стоит в выражении чтения), поэтому токены гаснут.
   */
  it('снятая из набора роль оставляет выдачу живой и помечает её несоответствием', async () => {
    const holder = await newHolder();
    const grant = await createGrant({
      permissions: ['vehicleReadings.read'],
      roles: ['mechanic', 'dispatcher'],
    });
    await assign(grant.id, holder.id);
    const before = await authVersionOf(holder.id);

    const res = await applyGrantPatch(ctx.admin, grant.id, {
      expectedVersion: grant.version,
      roles: ['dispatcher'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const card = res.json<GrantCardDto>();
    expect(card.roles).toEqual(['dispatcher']);
    expect(card.holders).toHaveLength(1);
    expect(card.holders[0]).toMatchObject({ userId: holder.id, roleMismatch: true });
    expect(await authVersionOf(holder.id)).toBeGreaterThan(before);

    const audit = await auditOf(grant.id);
    expect(audit.at(-1)!.metadata).toMatchObject({
      rolesRemoved: ['mechanic'],
      accessChanged: true,
    });
  });

  // ── Удаление ──

  it('выданный набор не удаляется: 409 со списком держателей', async () => {
    const holder = await newHolder();
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });
    const assignmentId = await assign(grant.id, holder.id);

    const res = await deleteGrant(ctx.admin, grant.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('grant_has_holders');
    const details = JSON.parse(res.body).details as { holders: GrantCardDto['holders'] };
    expect(details.holders.map((holder) => holder.assignmentId)).toEqual([assignmentId]);
    expect(details.holders[0]).toMatchObject({ userId: holder.id, fullName: expect.any(String) });
    // Набор жив: RESTRICT на `grant_id` и есть та причина, по которой каскадом это делать нельзя.
    expect(await grantRow(grant.id)).toMatchObject({ deletedAt: null });
    expect((await auditOf(grant.id)).map((row) => row.action)).toEqual(['grant.create']);
  });

  it('невыданный набор удаляется мягко и уходит из каталога', async () => {
    const grant = await createGrant({ permissions: ['garage.read'], roles: ['mechanic'] });

    const res = await deleteGrant(ctx.admin, grant.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await grantRow(grant.id)).toMatchObject({ deletedAt: expect.any(Date) });

    // Карточка удалённого набора — 404: он не действует ни у кого, править и удалять в нём нечего.
    expect((await getGrant(ctx.admin, grant.id)).statusCode).toBe(404);
    expect(
      (
        await applyGrantPatch(ctx.admin, grant.id, {
          expectedVersion: 1,
          expectedImpactHash: WELL_FORMED_HASH,
        })
      ).statusCode,
    ).toBe(404);
    expect((await deleteGrant(ctx.admin, grant.id)).statusCode).toBe(404);

    const list = await listGrants(ctx.admin, 'kind=custom&pageSize=500');
    expect(list.json<{ items: GrantDto[] }>().items.some((row) => row.id === grant.id)).toBe(false);

    const audit = await auditOf(grant.id);
    expect(audit.map((row) => row.action)).toEqual(['grant.create', 'grant.delete']);
    expect(audit[1]!.metadata).toMatchObject({ grantCode: grant.code, grantName: grant.name });

    // Код остаётся занятым и после удаления: на него ссылаются журнал и реестр выдач, и новый набор
    // под кодом удалённого рассказывал бы историю за него.
    const reuse = await postGrant(ctx.admin, { code: grant.code, name: 'Под кодом удалённого' });
    expect(reuse.statusCode, reuse.body).toBe(409);
    expect(reuse.json<{ code: string }>().code).toBe('grant_code_taken');
  });
});
