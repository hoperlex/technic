import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq as sqlEq, sql } from 'drizzle-orm';
import type {
  Role,
  TicketAuditAccuracyDto,
  TicketAuditCohortsDto,
  TicketAuditEventsDto,
  TicketAuditOperationsDto,
  TicketAuditSummaryDto,
  WasteTicketField,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';

/**
 * Ручки аудита распознавания на живом приложении (ADR 0137, план
 * `docs/waste-ticket-audit-plan.md` §4.1, §4.3, §5.1, §5.2, §6).
 *
 * Арифметику считает сервис, и проверена она своим файлом (`ticket-audit-summary.db`).
 * Здесь предмет другой — то, что живёт только в маршруте и нигде больше:
 *
 * 1. **право**: пускает `wasteRequests.ticketAudit` и не пускает соседнее `wasteRequests.ticketReview`;
 * 2. **период**: умолчание в 30 суток по московскому календарю и предел в 92 дня — у КАЖДОЙ ручки
 *    раздела, а не только у первой написанной;
 * 3. **адрес**: `ticket-audit/summary` не перехватывается параметрическим `/:id/...` из
 *    `waste-tickets.ts` и `waste-requests.ts` — два плагина сидят на одном префиксе, и порядок
 *    узлов в дереве маршрутов из кода не виден;
 * 4. **отсутствие области**: сводка сквозная, и держатель без доступа к площадке всё равно видит
 *    наблюдения по ней. Это единственная ручка вывоза, где область НЕ применяется, — и именно
 *    поэтому её отсутствие проверяется запросом, а не читается в комментарии;
 * 5. **согласие двух экранов**: сумма наблюдений по когортам равна числу наблюдений сводки за тот
 *    же период. Сервис своей проверкой этого не закрывает: он считает по периоду, который ему
 *    ПЕРЕДАЛИ, а расходятся экраны как раз тогда, когда одну и ту же строку запроса две ручки
 *    разберут в разные отрезки времени.
 * 6. **лента (§5.3)**: право, фильтры и постраничность — общее число не должно меняться от того,
 *    какую страницу спросили;
 * 7. **выгрузка (§4.3)**: BOM и заголовок, апостроф перед каждым из шести опасных символов, оба
 *    предела и строка в `audit_log`. Это единственное место раздела, где проверяется не число, а
 *    БАЙТЫ ответа: файл откроют в Excel, и «формально верный CSV» там становится либо мусором из
 *    кириллицы, либо выполненной формулой.
 *
 * Проверить это вызовом сервиса нельзя: сервис не знает ни о правах, ни о периоде по умолчанию,
 * ни об адресе, а область он не применял бы и в том случае, если бы маршрут её применил.
 *
 * СВОЯ БАЗА, а не общая тестовая — по той же причине, что у `ticket-audit-summary.db`: сводка
 * считает по всему порталу, и наблюдения соседних файлов попали бы в тот же период. Здесь это
 * важнее вдвойне: половина утверждений ниже — про РАВЕНСТВО чисел у двух держателей, и общий фон,
 * подросший между двумя запросами, сделал бы проверку области бессмысленной.
 *
 * Запуск (базу тест заводит и сносит сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_audit_route_test \
 *     npx vitest run test/ticket-audit-route.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_audit_route_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'Audit-Route-1234';

/** Период сева: обе даты внутри, длина в пределах 92 дней. */
const PERIOD = { from: '2026-08-01', to: '2026-08-31' };

interface Person {
  id: string;
  auth: { authorization: string };
  permissions: string[];
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof DbSchema;
  closeDb: () => Promise<void>;
  adminId: string;
  /** Площадка держателя объектной роли — на ней НЕТ ни одного наблюдения. */
  ownObjectId: string;
  /** Площадка, по которой сеются наблюдения: чужая для держателя объектной роли. */
  foreignObjectId: string;
  /** Заявка чужой площадки: по ней проверяется, что область на соседних ручках работает. */
  foreignRequestId: string;
  /** Держатель `wasteRequests.ticketAudit` — набором `waste_ticket_audit`, как в жизни. */
  auditor: Person;
  /** Держатель `wasteRequests.ticketReview` без аудита: разбор сводки не открывает. */
  reviewer: Person;
  /** Объектная роль с аудитом и чужой площадкой: субъект, на котором область была бы видна. */
  scoped: Person;
}

let ctx: Ctx;

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
  process.env.MAIL_ENABLED ??= 'false';
}

/** Свой адрес на запрос: вход ограничен десятью попытками в минуту с адреса. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Учётка с настоящим входом: право проверяет страж, а он читает субъекта из живого токена. */
async function newPerson(tag: string, role: Role): Promise<Person> {
  const { hashPassword } = await import('../src/auth/password');
  const email = `audit-route-${RUN}-${tag}@example.invalid`;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email,
      lastName: 'Аудитов',
      firstName: 'Тест',
      middleName: tag,
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return { id: created!.id, auth: { authorization: '' }, permissions: [] };
}

/**
 * Вход отдельным шагом, а не внутри заведения учётки: наборы выдаются между тем и другим, а ответ
 * входа несёт эффективные права — ими и проверяется, что субъект собрался тем, чем задумано.
 */
async function login(person: Person, tag: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email: `audit-route-${RUN}-${tag}@example.invalid`, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { accessToken: string; user: { permissions: string[] } };
  person.auth = { authorization: `Bearer ${body.accessToken}` };
  person.permissions = body.user.permissions;
}

/** Идентификатор системного набора по коду — его завела миграция 0211, а не тест. */
async function systemGrantId(code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: ctx.schema.grants.id })
    .from(ctx.schema.grants)
    .where(sqlEq(ctx.schema.grants.code, code));
  if (!row) throw new Error(`В базе нет системного набора «${code}»`);
  return row.id;
}

/**
 * Набор, собранный руками, — под держателя аудита с объектной ролью.
 *
 * В каталоге такого набора нет: `waste_ticket_audit` объявляет совместимыми только диспетчера и
 * менеджера (§4.1), а гейт совместимости (`grantPermissionsExpr`) выдаёт права лишь той роли,
 * которая перечислена в `grant_roles`. Но поставочные держатели аудита объектной области не имеют
 * вовсе — и прошли бы сводку даже в том случае, если бы маршрут область применял. Проверять
 * отсутствие фильтра на субъекте, которого фильтр всё равно не касается, значит не проверять
 * ничего; поэтому здесь собирается самый строгий из возможных держателей.
 */
async function assembledGrant(roles: Role[], permissions: string[]): Promise<string> {
  const [created] = await ctx.db
    .insert(ctx.schema.grants)
    .values({
      code: `audit-route-${RUN}`,
      name: 'Аудит распознавания для объектной роли',
      isSystem: false,
    })
    .returning({ id: ctx.schema.grants.id });
  const grantId = created!.id;
  await ctx.db.insert(ctx.schema.grantRoles).values(roles.map((role) => ({ grantId, role })));
  await ctx.db
    .insert(ctx.schema.grantPermissions)
    .values(permissions.map((permission) => ({ grantId, permission })));
  return grantId;
}

/** Выдача набора напрямую: предмет проверки — ручка аудита, а не форма выдачи полномочий. */
async function assign(userId: string, grantId: string): Promise<void> {
  await ctx.db
    .insert(ctx.schema.userGrants)
    .values({ userId, grantId, grantedBy: ctx.adminId, origin: 'manual' });
}

/** Талон, к которому будут привязаны наблюдения. `confirmedAt` даёт исход «принято как есть». */
async function seedTicket(number: string, confirmedAt: Date | null): Promise<string> {
  const [ticket] = await ctx.db
    .insert(ctx.schema.wasteTickets)
    .values({
      requestId: ctx.foreignRequestId,
      origin: 'ocr',
      status: confirmedAt ? 'confirmed' : 'unconfirmed',
      numberRaw: number,
      numberKey: number,
      numberFuzzy: number,
      issuedOn: '2026-08-11',
      volumeM3: '20',
      workKind: 'removal',
      // «Когда подтвердили» и «кто подтвердил» ходят парой: это держит CHECK таблицы.
      confirmedAt,
      confirmedBy: confirmedAt ? ctx.adminId : null,
    })
    .returning({ id: ctx.schema.wasteTickets.id });
  return ticket!.id;
}

/** Машинное чтение одного поля — единица наблюдения (§1.1). */
async function seedObservation(
  ticketId: string,
  field: WasteTicketField,
  at: Date,
): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.wasteTicketFieldEvents)
    .values({
      ticketId,
      requestId: ctx.foreignRequestId,
      event: 'recognized',
      field,
      newValue: '20',
      readState: 'read',
      collectionVersion: 2,
      createdAt: at,
    })
    .returning({ id: ctx.schema.wasteTicketFieldEvents.id });
  return row!.id;
}

async function summaryOf(
  person: Person,
  query = `from=${PERIOD.from}&to=${PERIOD.to}`,
): Promise<TicketAuditSummaryDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/ticket-audit/summary?${query}`,
    headers: person.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TicketAuditSummaryDto;
}

async function cohortsOf(
  person: Person,
  query = `from=${PERIOD.from}&to=${PERIOD.to}`,
): Promise<TicketAuditCohortsDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/ticket-audit/cohorts?${query}`,
    headers: person.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TicketAuditCohortsDto;
}

async function eventsOf(person: Person, query: string): Promise<TicketAuditEventsDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/ticket-audit/events?${query}`,
    headers: person.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TicketAuditEventsDto;
}

async function accuracyOf(
  person: Person,
  query = `from=${PERIOD.from}&to=${PERIOD.to}`,
): Promise<TicketAuditAccuracyDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/ticket-audit/blind?${query}`,
    headers: person.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TicketAuditAccuracyDto;
}

/** Состояние подсистемы: строка запроса не передаётся вовсе — ручка её не принимает (§5.4). */
async function operationsOf(person: Person): Promise<TicketAuditOperationsDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/waste-requests/ticket-audit/operations',
    headers: person.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TicketAuditOperationsDto;
}

/**
 * Выгрузка отдаётся как есть, без проверки кода: у неё половина проверок — про отказы, а тело
 * читается БАЙТАМИ. `res.json()` здесь не годится вовсе, и это не мелочь: BOM — это три байта в
 * начале файла, и любой декодер по дороге показал бы его одинаково и там, где он есть, и там, где
 * его нет.
 */
async function exportOf(person: Person, query: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waste-requests/ticket-audit/events.csv?${query}`,
    headers: person.auth,
  });
}

/**
 * Человеческое событие ленты — правка.
 *
 * `observationId` не ставится намеренно: лента показывает события подряд, а исход наблюдения к ней
 * отношения не имеет. Свяжи мы правку с чтением — сдвинулись бы числа сводки, по которым сверяются
 * соседние проверки этого же файла, и лента доказывала бы себя ценой чужих утверждений.
 */
async function seedEdit(
  field: WasteTicketField,
  at: Date,
  oldValue: string | null,
  newValue: string,
): Promise<void> {
  await ctx.db.insert(ctx.schema.wasteTicketFieldEvents).values({
    requestId: ctx.foreignRequestId,
    event: 'edited',
    field,
    oldValue,
    newValue,
    collectionVersion: 2,
    actorId: ctx.adminId,
    createdAt: at,
  });
}

/**
 * Слепая перепроверка одного талона — единица счёта точности (§5.5).
 *
 * Сеется СОВПАДЕНИЕ: два независимых чтения сошлись, и это свидетельство в пользу машины. Больше
 * одного случая здесь не нужно — три исхода арбитража считает сервис, и проверены они своим файлом
 * (`ticket-audit-summary.db`); маршруту достаточно доказать, что он спрашивает именно этот счёт и
 * именно за тот отрезок, который разобрал из строки запроса.
 *
 * Талон свой на каждую перепроверку: `waste_ticket_blind_checks_ticket_unique` держит правило «одна
 * перепроверка на бумагу», иначе доля расхождений зависела бы от того, скольких позвали смотреть.
 * Дата и объём в снимке и в чтении пусты с обеих сторон — так требует `…_match_check`: статус
 * «совпало» обязан соответствовать фактическому сравнению всех трёх полей.
 */
async function seedBlindCheck(number: string, at: Date): Promise<void> {
  const ticketId = await seedTicket(number, new Date('2026-08-11T10:00:00.000Z'));
  await ctx.db.insert(ctx.schema.wasteTicketBlindChecks).values({
    ticketId,
    checkerId: ctx.adminId,
    reviewNumberRaw: number,
    reviewNumberKey: number,
    baselineNumberRaw: number,
    baselineNumberKey: number,
    baselineFingerprint: 'a'.repeat(64),
    status: 'match',
    createdAt: at,
  });
}

/** Номер заявки: в ленте он показывается и ищется как текст, а в базе он целочисленный. */
async function foreignRequestNum(): Promise<string> {
  const [row] = await ctx.db
    .select({ num: ctx.schema.wasteRequests.num })
    .from(ctx.schema.wasteRequests)
    .where(sqlEq(ctx.schema.wasteRequests.id, ctx.foreignRequestId));
  return String(row!.num);
}

/** Что журнал обязан помнить о выгрузке (§4.3): период, фильтры и число строк. */
interface ExportAuditMetadata {
  period: { from: string; to: string };
  filters: Record<string, unknown>;
  rows: number;
}

/** Сегодняшняя дата в Москве — тем же способом, каким её считает ручка. */
function moscowToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Сдвиг номера дня: сравнивать надо календарь, а не моменты времени. */
function shiftDays(dateOnly: string, days: number): string {
  const at = new Date(`${dateOnly}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

describe.skipIf(!DB_URL)('ручки аудита распознавания', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    ctx = {
      app,
      db,
      schema,
      closeDb,
      adminId: '',
      ownObjectId: '',
      foreignObjectId: '',
      foreignRequestId: '',
      auditor: null as never,
      reviewer: null as never,
      scoped: null as never,
    };

    const objects = await db
      .insert(schema.constructionObjects)
      .values([
        { code: `AR-own-${RUN}`, name: `Своя площадка ${RUN}`, address: 'Волоколамское ш., 71к14' },
        { code: `AR-far-${RUN}`, name: `Чужая площадка ${RUN}`, address: 'Ленинский пр-т, 42' },
      ])
      .returning({ id: schema.constructionObjects.id });
    ctx.ownObjectId = objects[0]!.id;
    ctx.foreignObjectId = objects[1]!.id;

    const keeper = await newPerson('admin', 'admin');
    ctx.adminId = keeper.id;

    ctx.auditor = await newPerson('auditor', 'dispatcher');
    ctx.reviewer = await newPerson('reviewer', 'dispatcher');
    ctx.scoped = await newPerson('scoped', 'shtab');
    // Площадка держателя объектной роли — та, на которой наблюдений нет.
    await db
      .insert(schema.userConstructionObjects)
      .values({ userId: ctx.scoped.id, constructionObjectId: ctx.ownObjectId });

    await assign(ctx.auditor.id, await systemGrantId('waste_ticket_audit'));
    await assign(ctx.scoped.id, await assembledGrant(['shtab'], ['wasteRequests.ticketAudit']));

    await login(ctx.auditor, 'auditor');
    await login(ctx.reviewer, 'reviewer');
    await login(ctx.scoped, 'scoped');

    const [request] = await db
      .insert(schema.wasteRequests)
      .values({
        objectId: ctx.foreignObjectId,
        requestType: 'waste_removal',
        deliveryAt: new Date('2026-08-11T09:00:00.000Z'),
        createdBy: ctx.adminId,
        status: 'done',
        comment: `audit-route-${RUN}`,
        volumeM3: '20',
      })
      .returning({ id: schema.wasteRequests.id });
    ctx.foreignRequestId = request!.id;

    // Два наблюдения с разными исходами: подтверждённый талон даёт «принято как есть», правка —
    // «исправлено». Больше не нужно: арифметику исходов проверяет `ticket-audit-summary.db`.
    const accepted = await seedTicket(`AC${RUN}`, new Date('2026-08-11T10:00:00.000Z'));
    await seedObservation(accepted, 'number', new Date('2026-08-11T09:00:00.000Z'));
    const corrected = await seedTicket(`CO${RUN}`, null);
    const observation = await seedObservation(
      corrected,
      'volumeM3',
      new Date('2026-08-10T09:00:00.000Z'),
    );
    await db.insert(schema.wasteTicketFieldEvents).values({
      ticketId: corrected,
      requestId: ctx.foreignRequestId,
      event: 'edited',
      field: 'volumeM3',
      oldValue: '20',
      newValue: '38',
      observationId: observation,
      collectionVersion: 2,
      actorId: ctx.adminId,
      createdAt: new Date('2026-08-10T10:00:00.000Z'),
    });
  }, 240_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.app.close();
    await ctx.closeDb();
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  });

  it('держатель права получает сводку', async () => {
    expect(ctx.auditor.permissions).toContain('wasteRequests.ticketAudit');
    const dto = await summaryOf(ctx.auditor);

    expect(dto.period).toEqual(PERIOD);
    // База своя и пустая: числа сходятся с севом до единицы, а не «не меньше, чем».
    expect(dto.observations.total).toBe(2);
    expect(dto.observations.resolved).toBe(2);
    expect(dto.observations.pending).toBe(0);
    const number = dto.fields.find((f) => f.field === 'number')!;
    const volume = dto.fields.find((f) => f.field === 'volumeM3')!;
    expect(number.decided).toBe(1);
    expect(number.corrected).toBe(0);
    expect(volume.corrected).toBe(1);
  });

  it('разбор талонов сводки не открывает', async () => {
    // Оба утверждения нужны вместе: без первого 403 доказывал бы лишь, что у субъекта нет вообще
    // ничего, и проверка прошла бы даже для случайного прохожего.
    expect(ctx.reviewer.permissions).toContain('wasteRequests.ticketReview');
    expect(ctx.reviewer.permissions).not.toContain('wasteRequests.ticketAudit');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waste-requests/ticket-audit/summary?from=${PERIOD.from}&to=${PERIOD.to}`,
      headers: ctx.reviewer.auth,
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('период длиннее 92 дней отклоняется, ровно 92 — проходит', async () => {
    // Граница названа кварталом (§4.3): июль + август + сентябрь — это ровно 92 дня, и целый
    // квартал в отчёт помещаться обязан. Проверяются обе стороны границы: без верхней половины
    // предел мог бы стоять на любом числе меньше 92 и тест бы не заметил.
    const quarter = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit/summary?from=2026-07-01&to=2026-09-30',
      headers: ctx.auditor.auth,
    });
    expect(quarter.statusCode, quarter.body).toBe(200);

    const tooLong = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit/summary?from=2026-07-01&to=2026-10-01',
      headers: ctx.auditor.auth,
    });
    expect(tooLong.statusCode, tooLong.body).toBe(400);
    // Отказ обязан называть предел: «некорректный запрос» не говорит человеку, что укоротить.
    expect(String((tooLong.json() as { message: string }).message)).toContain('92');
  });

  it('без параметров период — последние 30 суток по московскому календарю', async () => {
    const dto = await summaryOf(ctx.auditor, '');
    const today = moscowToday();
    expect(dto.period.to).toBe(today);
    expect(dto.period.from).toBe(shiftDays(today, -30));
  });

  it('сводку не перехватывает параметрический маршрут заявки', async () => {
    // На префиксе `/api/v1/waste-requests` сидят три плагина, и у двух из них ручки вида `/:id/…`.
    // Найти сводку маршрутизатор обязан по статическому сегменту; ответь вместо неё обработчик
    // заявки — пришёл бы отказ про «заявку не найдено» либо 400 на нечитаемый идентификатор.
    const dto = await summaryOf(ctx.auditor);
    expect(dto.observations.total).toBe(2);

    // Параметрическая ветка при этом жива и отвечает по-своему: несуществующая заявка — 404, а не
    // сводка. Без этой половины первая проверка прошла бы и на приложении, где `/:id/…` отвалился.
    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waste-requests/${randomUUID()}/tickets`,
      headers: ctx.auditor.auth,
    });
    expect(missing.statusCode, missing.body).toBe(404);

    // И ровно поэтому путь двусоставный: односегментное имя разбиралось бы как идентификатор
    // заявки — вот его ответ, отказ схемы `:id`, а не сводка.
    const single = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit',
      headers: ctx.auditor.auth,
    });
    // 400 — отказ схемы `:id`: «ticket-audit» не читается как идентификатор. Не 404 и не сводка.
    expect(single.statusCode).toBe(400);
  });

  it('область объекта на сводку не действует: чужая площадка видна вся', async () => {
    expect(ctx.scoped.permissions).toContain('wasteRequests.ticketAudit');

    // Область у субъекта настоящая и на соседней ручке работает: карточку заявки чужой площадки
    // он не открывает. Без этой половины «сводка отдала всё» ничего не доказывало бы — область
    // могла бы просто не быть выдана.
    const card = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waste-requests/${ctx.foreignRequestId}`,
      headers: ctx.scoped.auth,
    });
    expect(card.statusCode, card.body).toBe(403);

    // А сводка отдаёт те же числа, что и держателю без области: аудит сквозной (§4.1). Считай его
    // по своему куску выборки — и доля исправлений мерила бы площадку, а не модель.
    const dto = await summaryOf(ctx.scoped);
    expect(dto.observations.total).toBe(2);
    expect(dto.fields.find((f) => f.field === 'volumeM3')!.corrected).toBe(1);
  });

  // ── Когорты конфигураций конвейера (§5.2) ──

  it('держатель права получает когорты', async () => {
    const dto = await cohortsOf(ctx.auditor);

    expect(dto.period).toEqual(PERIOD);
    // Наблюдения сеял тест, а не воркер, и снимка конфигурации в них нет: `primary_model_reported`
    // объявлен NOT NULL DEFAULT ''. Строка когорты обязана быть всё равно — «конфигурация себя не
    // назвала» это тоже когорта, и потерять её значило бы потерять наблюдения из знаменателя.
    expect(dto.cohorts).toHaveLength(1);
    const cohort = dto.cohorts[0]!;
    expect(cohort.primaryModel).toBe('');
    // Пустой снимок второй ступени ручка обязана отдать как `null`, а не как пустую строку: пусто
    // здесь значит «эскалации не было», и экран должен печатать прочерк, а не безымянную модель.
    expect(cohort.escalationModel).toBeNull();
    expect(cohort.observations).toBe(2);
    expect(cohort.corrected).toBe(1);
    expect(cohort.decided).toBe(2);
    // Два талона, прочитанных по разу: разбор — это группа наблюдений одного чтения, и по ним, а
    // не по наблюдениям, считается «сколько раз читали».
    expect(cohort.runs).toBe(2);

    // Блок каскада приходит всегда, даже когда вторая ступень не включалась ни разу: экран рисует
    // его отдельной карточкой, и отсутствующий блок он показал бы как пустое место, а не как ноль.
    expect(dto.cascade.runsWithEscalation).toBe(0);
    expect(dto.cascade.disputes).toBe(0);
    expect(dto.cascade.disputeOutcomes.unresolved).toBe(0);
  });

  it('разбор талонов когорт не открывает', async () => {
    // Как и на сводке, оба утверждения нужны вместе: без первого 403 доказывал бы лишь, что у
    // субъекта нет вообще ничего. Право у когорт то же, и проверяется оно отдельно как раз потому,
    // что «то же» — это утверждение о коде, а не факт: страж вешается на каждый маршрут свой.
    expect(ctx.reviewer.permissions).toContain('wasteRequests.ticketReview');
    expect(ctx.reviewer.permissions).not.toContain('wasteRequests.ticketAudit');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waste-requests/ticket-audit/cohorts?from=${PERIOD.from}&to=${PERIOD.to}`,
      headers: ctx.reviewer.auth,
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('предел периода действует и на когортах', async () => {
    // Предел стоит на разборе периода, общем для раздела, — но общий он ровно до тех пор, пока
    // вторая ручка не завела себе свой разбор. Проверка стоит здесь именно поэтому: она краснеет
    // в тот день, когда когорты начнут читать период мимо помощника.
    const quarter = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit/cohorts?from=2026-07-01&to=2026-09-30',
      headers: ctx.auditor.auth,
    });
    expect(quarter.statusCode, quarter.body).toBe(200);

    const tooLong = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit/cohorts?from=2026-07-01&to=2026-10-01',
      headers: ctx.auditor.auth,
    });
    expect(tooLong.statusCode, tooLong.body).toBe(400);
    expect(String((tooLong.json() as { message: string }).message)).toContain('92');
  });

  it('когорты и сводка считают одни и те же наблюдения', async () => {
    // Ключевой инвариант двух экранов: конфигурации не пересекаются, и сумма по ним равна целому.
    // У сервиса эта проверка тоже есть (`ticket-audit-summary.db`), и она НЕ покрывает здешнюю:
    // сервису период передают готовым, а разойтись экраны могут на разборе строки запроса — тогда
    // сумма и целое посчитаются по разным отрезкам времени, каждый ответ будет верен сам по себе,
    // и спорить с расхождением будет нечем.
    const query = `from=${PERIOD.from}&to=${PERIOD.to}`;
    const summary = await summaryOf(ctx.auditor, query);
    const { cohorts } = await cohortsOf(ctx.auditor, query);

    const observations = cohorts.reduce((acc, c) => acc + c.observations, 0);
    // Сначала — что считать вообще было что: равенство двух нулей прошло бы и на пустой базе.
    expect(summary.observations.total).toBeGreaterThan(0);
    expect(observations).toBe(summary.observations.total);
    expect(cohorts.reduce((acc, c) => acc + c.corrected, 0)).toBe(
      summary.fields.reduce((acc, f) => acc + f.corrected, 0),
    );

    // И то же самое на периоде по умолчанию — том, который ручки достраивают сами. Здесь равенство
    // проверяет уже не арифметику, а согласие двух умолчаний: разъедься они на сутки, числа
    // разошлись бы ровно на наблюдения этих суток и никакой ошибки при этом не случилось бы.
    const defaultSummary = await summaryOf(ctx.auditor, '');
    const defaultCohorts = await cohortsOf(ctx.auditor, '');
    expect(defaultCohorts.period).toEqual(defaultSummary.period);
    expect(defaultCohorts.cohorts.reduce((acc, c) => acc + c.observations, 0)).toBe(
      defaultSummary.observations.total,
    );
  });

  // ── Лента событий (§5.3) ──

  it('держатель права получает ленту', async () => {
    const dto = await eventsOf(ctx.auditor, `from=${PERIOD.from}&to=${PERIOD.to}`);

    // Три события августовского сева: два машинных чтения и правка. Лента показывает ВСЕ типы, а
    // не одни правки (§5.3): покажи она только человеческую работу, здесь стояла бы единица, и
    // экран отвечал бы на вопрос «где работал человек» вместо «что путает машина».
    expect(dto.total).toBe(3);
    expect(dto.page).toBe(1);
    // Свежее сверху: это порядок чтения журнала, а не выборки. Обратный превратил бы ленту в
    // архив, который листают с начала времён.
    expect(dto.rows.map((r) => r.event)).toEqual(['recognized', 'edited', 'recognized']);

    const edit = dto.rows[1]!;
    expect(edit.oldValue).toBe('20');
    expect(edit.newValue).toBe('38');
    // Человек у человеческого события и пусто у машинного. Различие обязано быть видно: `actor_id`
    // у чтения запрещён ограничением таблицы, и подставь лента сюда «система» — исчезла бы разница
    // между «ошиблась модель» и «ошибся человек».
    expect(edit.actorName).not.toBeNull();
    expect(dto.rows[0]!.actorName).toBeNull();
    // Время московское и в порядке ленты: правка сделана в 10:00 UTC, то есть в 13:00 (§1.3).
    expect(edit.at).toBe('2026-08-10T13:00:00');
  });

  it('разбор талонов ленту не открывает', async () => {
    // Оба утверждения вместе, как и на соседних ручках: без первого 403 доказывал бы лишь, что у
    // субъекта нет вообще ничего. Право у ленты то же, что у сводки, и «то же» — это утверждение о
    // коде: страж вешается на каждый маршрут свой.
    expect(ctx.reviewer.permissions).toContain('wasteRequests.ticketReview');
    expect(ctx.reviewer.permissions).not.toContain('wasteRequests.ticketAudit');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waste-requests/ticket-audit/events?from=${PERIOD.from}&to=${PERIOD.to}`,
      headers: ctx.reviewer.auth,
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('фильтры сужают ленту', async () => {
    const period = `from=${PERIOD.from}&to=${PERIOD.to}`;

    const edits = await eventsOf(ctx.auditor, `${period}&event=edited`);
    expect(edits.total).toBe(1);
    expect(edits.rows[0]!.field).toBe('volumeM3');

    const numbers = await eventsOf(ctx.auditor, `${period}&field=number`);
    expect(numbers.total).toBe(1);
    expect(numbers.rows[0]!.event).toBe('recognized');

    // Два фильтра разом сужают вместе, а не по очереди: правка есть, но не по номеру.
    const both = await eventsOf(ctx.auditor, `${period}&field=number&event=edited`);
    expect(both.total).toBe(0);
    expect(both.rows).toHaveLength(0);

    // Номер заявки ищется вхождением: разбор начинается с «покажи вот эту бумагу».
    const num = await foreignRequestNum();
    expect((await eventsOf(ctx.auditor, `${period}&requestNum=${num}`)).total).toBe(3);
    // И чужой номер не отдаёт ничего. Без этой половины «фильтр вернул три строки» доказывал бы
    // только то, что параметр не сломал запрос.
    expect((await eventsOf(ctx.auditor, `${period}&requestNum=99${num}88`)).total).toBe(0);
  });

  it('постраничность не меняет общее число', async () => {
    // Двенадцать событий одного дня: страница по десять — это две страницы, а меньше десяти
    // страница по контракту быть не может. День свой, чтобы сев не сдвинул числа соседних проверок.
    const day = Date.parse('2026-06-03T09:00:00.000Z');
    for (let i = 0; i < 12; i += 1) {
      await seedEdit('workKind', new Date(day + i * 60_000), 'removal', `правка ${i}`);
    }

    const first = await eventsOf(ctx.auditor, 'from=2026-06-03&to=2026-06-03&pageSize=10');
    const second = await eventsOf(ctx.auditor, 'from=2026-06-03&to=2026-06-03&pageSize=10&page=2');

    expect(first.rows).toHaveLength(10);
    expect(second.rows).toHaveLength(2);
    // Общее число — это ОБЩЕЕ число, а не длина страницы. Считай его лента по выбранным строкам,
    // на второй странице оно стало бы двойкой, и портал показывал бы «11–12 из 2».
    expect(first.total).toBe(12);
    expect(second.total).toBe(12);
    expect(second.page).toBe(2);
    // Страницы не пересекаются: одинаковый порядок обеих выборок — часть того же обещания, и без
    // него строка, стоящая на границе, приезжала бы дважды, а соседняя не приезжала бы вовсе.
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(12);
  }, 30_000);

  // ── Выгрузка (§4.3) ──

  it('выгрузка начинается с BOM, несёт заголовок и все строки отбора', async () => {
    const res = await exportOf(ctx.auditor, `from=${PERIOD.from}&to=${PERIOD.to}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    expect(String(res.headers['content-disposition'])).toContain('attachment');

    // BOM проверяется БАЙТАМИ. `res.body` его не докажет: Node декодирует ответ сам, и строка
    // выглядела бы одинаково и с меткой, и без неё, — а Excel читает именно байты и без них
    // открывает кириллицу в однобайтовой кодировке системы, то есть мусором.
    expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const text = res.rawPayload.toString('utf8');
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'Время,Заявка,Поле,Событие,Было,Стало,Кто,Модель,Версия промпта,Версия подготовки',
    );

    // Выгрузка ПОЛНАЯ, а не первая страница: строк ровно столько, сколько в ленте того же отбора.
    const feed = await eventsOf(ctx.auditor, `from=${PERIOD.from}&to=${PERIOD.to}`);
    expect(lines.filter((line) => line !== '')).toHaveLength(feed.total + 1);

    // Правка стоит в файле обеими сторонами значения, московским временем в читаемом Excel виде и
    // русскими названиями поля и события: `volumeM3` и `edited` прочёл бы только тот, кто и так
    // знает журнал изнутри.
    expect(lines[2]).toMatch(/^2026-08-10 13:00:00,/);
    expect(lines[2]).toContain(',Объём,правка,20,38,');
  });

  it('опасные значения предваряются апострофом — каждый символ из §4.3', async () => {
    // По значению на каждый символ. Проверяются все шесть, а не один показательный: они ловятся
    // разными частями одного правила, и удавшийся `=` ничего не говорит о табуляции — а Excel
    // табуляцию в начале ячейки молча съедает и читает формулой то, что за ней.
    //
    // Значения кладутся в адрес площадки: это ПЕРСОНАЛЬНЫЕ данные, и в файл они идут как есть
    // (§4.3, выгрузка полная). Именно поэтому защита нужна здесь, а не «где-нибудь»: адрес
    // печатает чужая рука, и содержимое ячейки портал не выбирает.
    const dangerous = ['=2+2', '+7 999 000-00-00', '-5', '@ул. Ленина', '\tтабуляция', '\rвозврат'];
    const day = Date.parse('2026-05-04T09:00:00.000Z');
    for (const [i, value] of dangerous.entries()) {
      await seedEdit('addressRaw', new Date(day + i * 60_000), 'ул. Ленина, 5', value);
    }

    const res = await exportOf(ctx.auditor, 'from=2026-05-04&to=2026-05-04');
    expect(res.statusCode, res.body).toBe(200);
    const text = res.rawPayload.toString('utf8');

    for (const value of dangerous) {
      // Апостроф стоит вплотную к значению — где бы в строке значение ни оказалось.
      expect(text, `значение ${JSON.stringify(value)} без апострофа`).toContain(`'${value}`);
      // И ни одна ячейка не начинается с самого значения: первая проверка прошла бы и на файле,
      // где апостроф приписан лишь одному из двух вхождений.
      expect(text, `ячейка начинается с ${JSON.stringify(value)}`).not.toContain(`,${value}`);
    }
  });

  it('кавычка, запятая и перевод строки внутри значения экранируются по RFC 4180', async () => {
    // Адрес с кавычками и запятой — обычная запись талона, а не выдумка: «ул. "Ленина", д. 5».
    // Не закавычь мы такое значение, запятая разъехалась бы столбцом, и файл сдвинулся бы весь.
    const value = 'ул. "Ленина", д. 5\nкорп. 2';
    await seedEdit('addressRaw', new Date('2026-05-05T09:00:00.000Z'), null, value);

    const res = await exportOf(ctx.auditor, 'from=2026-05-05&to=2026-05-05');
    expect(res.statusCode, res.body).toBe(200);
    const text = res.rawPayload.toString('utf8');

    // Значение целиком в кавычках, внутренние кавычки удвоены, перевод строки остался внутри поля.
    expect(text).toContain('"ул. ""Ленина"", д. 5\nкорп. 2"');
    // А строк в файле по-прежнему две: заголовок и одна запись. Перевод строки внутри значения
    // ломает счёт ровно тогда, когда его выпустили из кавычек.
    expect(
      text
        .slice(1)
        .split('\r\n')
        .filter((line) => line !== ''),
    ).toHaveLength(2);
  });

  it('выгрузка отказывает и на длинном периоде, и на слишком большом числе строк', async () => {
    // Предел периода стоит на общем разборе, и проверка краснеет в тот день, когда выгрузка
    // заведёт свой: отказ обязан называть число, иначе человеку нечего укорачивать.
    const tooLong = await exportOf(ctx.auditor, 'from=2026-07-01&to=2026-10-01');
    expect(tooLong.statusCode, tooLong.body).toBe(400);
    expect(String((tooLong.json() as { message: string }).message)).toContain('92');

    // 50 001 строка в ОДНИ сутки: предел строк — не следствие предела периода, и упереться в него
    // можно на дне. Сеется одним запросом: полсотни тысяч отдельных вставок — это тест, которого
    // никто не станет ждать.
    await ctx.db.execute(sql`
      INSERT INTO waste_ticket_field_events
        (request_id, event, field, new_value, read_state, collection_version, created_at)
      SELECT ${ctx.foreignRequestId}::uuid, 'recognized', 'number', 'N' || g, 'read', 2,
             timestamptz '2026-03-05 09:00:00+03'
        FROM generate_series(1, 50001) AS g
    `);

    const tooMany = await exportOf(ctx.auditor, 'from=2026-03-05&to=2026-03-05');
    expect(tooMany.statusCode, tooMany.body).toBe(400);
    const message = String((tooMany.json() as { message: string }).message);
    // Оба числа: предел и то, сколько строк вышло. «Слишком много» не говорит, насколько сузить.
    expect(message).toContain('50000');
    expect(message).toContain('50001');

    // А лента тот же отбор отдаёт. Предел принадлежит ФАЙЛУ, а не выборке: человек, упёршийся в
    // него, видит на экране, сколько строк он просит, и сужает отбор осмысленно.
    const feed = await eventsOf(ctx.auditor, 'from=2026-03-05&to=2026-03-05&pageSize=10');
    expect(feed.total).toBe(50_001);
    expect(feed.rows).toHaveLength(10);
  }, 180_000);

  it('состоявшаяся выгрузка записана в audit_log', async () => {
    const res = await exportOf(ctx.auditor, `from=${PERIOD.from}&to=${PERIOD.to}&event=edited`);
    expect(res.statusCode, res.body).toBe(200);

    const written = await ctx.db
      .select({
        actorUserId: ctx.schema.auditLog.actorUserId,
        entityType: ctx.schema.auditLog.entityType,
        metadata: ctx.schema.auditLog.metadata,
      })
      .from(ctx.schema.auditLog)
      .where(sqlEq(ctx.schema.auditLog.action, 'waste_request.ticket_audit_export'));

    // Отбирается строка ЭТОЙ выгрузки: соседние проверки файла тоже писали журнал, и «последняя по
    // времени» опознавала бы их же при перестановке тестов.
    const mine = written.filter(
      (row) => (row.metadata as ExportAuditMetadata).filters.event === 'edited',
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.actorUserId).toBe(ctx.auditor.id);
    expect(mine[0]!.entityType).toBe('waste_request');

    const metadata = mine[0]!.metadata as ExportAuditMetadata;
    // Период, фильтры и число строк — все три (§4.3). Без периода и фильтров журнал отвечает
    // «выгружал», но не «что именно», а это и есть вопрос, ради которого запись заведена: файл
    // уносит из портала адреса площадок и фамилии.
    expect(metadata.period).toEqual(PERIOD);
    expect(metadata.filters).toEqual({ event: 'edited' });
    // Ровно одно событие правки за август — столько же строк, сколько отдала лента тем же отбором.
    expect(metadata.rows).toBe(1);
  });

  // ── Точность среди неисправленных подтверждённых талонов (§5.5) ──

  it('держатель права получает точность, и она посчитана за разобранный период', async () => {
    await seedBlindCheck(`BC${RUN}`, new Date('2026-08-15T09:00:00.000Z'));

    const dto = await accuracyOf(ctx.auditor);
    // Период возвращается тот, что ручка разобрала из строки запроса: свяжись она с другим счётом
    // или с чужим отрезком — экран показал бы верные числа не о том времени.
    expect(dto.period).toEqual(PERIOD);
    expect(dto.issued).toBe(1);
    expect(dto.returned).toBe(1);
    expect(dto.waitingChecker).toBe(0);
    const number = dto.fields.find((f) => f.field === 'number')!;
    expect(number.matched).toBe(1);
    expect(number.diverged).toBe(0);

    // И тот же запрос за соседний месяц отдаёт ноль. Без этой половины равенство единице
    // доказывало бы только то, что в базе есть одна перепроверка: период мог бы и не применяться
    // вовсе — например, если бы ручка звала счёт без него.
    const july = await accuracyOf(ctx.auditor, 'from=2026-07-01&to=2026-07-31');
    expect(july.issued).toBe(0);
    // Три строки таблицы приходят и на пустом периоде: «нулей нет» и «полей нет» — разные вещи, и
    // экран, потерявший строку, прочитался бы как экран без такого поля вовсе (§5.5).
    expect(july.fields.map((f) => f.field)).toEqual(['number', 'issuedOn', 'volumeM3']);
    expect(july.fields.every((f) => f.matched === 0 && f.diverged === 0)).toBe(true);
  });

  it('разбор талонов точность не открывает', async () => {
    // Оба утверждения вместе, как и на соседних ручках: без первого 403 доказывал бы лишь, что у
    // субъекта нет вообще ничего. Соблазн отдать точность разбору силён — слепую перепроверку
    // делает как раз он, — но делает он одну бумагу, а экран показывает долю по всем сразу.
    expect(ctx.reviewer.permissions).toContain('wasteRequests.ticketReview');
    expect(ctx.reviewer.permissions).not.toContain('wasteRequests.ticketAudit');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waste-requests/ticket-audit/blind?from=${PERIOD.from}&to=${PERIOD.to}`,
      headers: ctx.reviewer.auth,
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('предел периода действует и на точности', async () => {
    // Предел живёт в общем разборе периода — общем ровно до того дня, когда точность заведёт свой.
    // Проверка стоит здесь именно поэтому и краснеет ровно в тот день.
    const quarter = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit/blind?from=2026-07-01&to=2026-09-30',
      headers: ctx.auditor.auth,
    });
    expect(quarter.statusCode, quarter.body).toBe(200);

    const tooLong = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit/blind?from=2026-07-01&to=2026-10-01',
      headers: ctx.auditor.auth,
    });
    expect(tooLong.statusCode, tooLong.body).toBe(400);
    // Отказ обязан называть предел: «некорректный запрос» не говорит человеку, что укоротить.
    expect(String((tooLong.json() as { message: string }).message)).toContain('92');
  });

  // ── Состояние подсистемы (§5.4) ──

  it('выключенное распознавание приходит состоянием «выключено», а не поломкой', async () => {
    // Модуль в тестовом окружении не включали — это проверяется, а не подразумевается: включись он
    // у соседнего файла через `process.env`, ожидание ниже стало бы неверным молча.
    expect(process.env.TICKET_OCR_ENABLED).toBeUndefined();

    const ops = await operationsOf(ctx.auditor);
    // «Выключено» и «сломано» на экране обязаны различаться словом: увидев `degraded`, дежурный
    // пойдёт искать сбой там, где принято решение, а увидев `ok` — не пойдёт туда, где данные
    // просто не собираются.
    expect(ops.state).toBe('disabled');
    // Тело при этом полное, а не обрезанное: экран рисует плитки очереди и окна в любом состоянии,
    // и отсутствующий блок он показал бы пустым местом вместо нуля.
    expect(ops.window.days).toBe(7);
    expect(ops.window.calls).toBe(0);
    expect(ops.queue.waiting).toBe(0);
    // Пустая очередь — это `null` возраста, а не ноль минут: «старейшая задача ждёт 0 минут»
    // означало бы, что задача есть.
    expect(ops.queue.oldestMinutes).toBeNull();
    // Момент ответа обязателен: без него вкладка, открытая со вчера, читается как «прямо сейчас».
    expect(Date.parse(ops.generatedAt)).not.toBeNaN();
    // Журнал не пуст — значит ответ собран по этой базе, а не выдан заготовкой.
    expect(ops.journalRows).toBeGreaterThan(0);
  });

  it('разбор талонов состояние не открывает', async () => {
    // У соседней ручки состояния (`ticket-recognition/health`) право как раз разборное, и потому
    // проверка тут не по инерции: этой ручкой уходит цена работы по всему порталу — токены,
    // очередь и коды отказов, — и открыть её разбору значило бы отдать её всей диспетчерской.
    expect(ctx.reviewer.permissions).toContain('wasteRequests.ticketReview');
    expect(ctx.reviewer.permissions).not.toContain('wasteRequests.ticketAudit');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit/operations',
      headers: ctx.reviewer.auth,
    });
    expect(res.statusCode, res.body).toBe(403);
  });

  it('состояние отвергает период, а не игнорирует его', async () => {
    // Молча проигнорированный параметр обманывает убедительнее отказа: приславший июльские границы
    // получил бы 200 и числа за последнюю неделю, прочёл бы их как июльские — и был бы по-своему
    // прав, ведь параметр он передал и ошибки не увидел.
    const withPeriod = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit/operations?from=2026-07-01&to=2026-07-31',
      headers: ctx.auditor.auth,
    });
    expect(withPeriod.statusCode, withPeriod.body).toBe(400);

    const body = withPeriod.json() as { code: string; fields?: Record<string, string> };
    // Отказ пришёл ОТ СХЕМЫ, а не из обработчика: `validation_error` против `bad_request`. Разница
    // не косметическая — схема стоит до стража, и только она отвергает параметр раньше, чем ручка
    // успеет что-нибудь посчитать.
    expect(body.code).toBe('validation_error');
    // И называет повод: «Ошибка валидации данных» не объясняет приславшему, почему периода нет.
    expect(Object.values(body.fields ?? {}).join(' ')).toContain('не считается за период');

    // Отвергается ЛЮБОЙ лишний параметр, а не два известных имени: строгая схема — это перечень
    // разрешённого, а чёрный список из `from` и `to` завтра обошли бы третьим именем.
    const alien = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/waste-requests/ticket-audit/operations?days=30',
      headers: ctx.auditor.auth,
    });
    expect(alien.statusCode, alien.body).toBe(400);
  });
});
