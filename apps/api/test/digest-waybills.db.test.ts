import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DIGEST_TABLE_ROW_LIMIT,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  vehicleRequestPath,
  vehicleRoutePath,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type { loadPrincipal as LoadPrincipal } from '../src/auth/principal';
import type { DigestContext } from '../src/services/mailings/digest-context';
import type {
  digestOnsiteTable as DigestOnsiteTable,
  digestTripsDays as DigestTripsDays,
} from '../src/services/mailings/digest-waybills';

/**
 * Состав ролевой сводки (ADR 0093): что оформлено на дни окна.
 *
 * Главное свойство письма — отбор идёт по **действующим путевым листам**, а не по заявкам и не по
 * рейсам. Лист означает, что работа не просто заказана, а оформлена: заявка без листа может ещё
 * двадцать раз переехать, и сводка, показывающая намерения, читается как план — а подводит ровно
 * там, где на неё положились. Отсюда же следствие, которое надо удерживать: рейс на арендной
 * машине листа не имеет по устройству модуля и в письмо не попадает вовсе.
 *
 * Зачем этому тесту база. Проверять здесь нечего на правилах: и «действующий лист», и «неделя
 * ЭСМ-2 пересекается с окном», и «заявка ещё жива» — это условия `WHERE` в двух запросах, которые
 * ходят в шесть таблиц. Разойтись могут не правила, а запрос и схема, и цена расхождения — письмо,
 * по которому диспетчер планирует день: пропавшая строка означает несделанную работу, лишняя —
 * поездку по аннулированному листу.
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test digest-waybills
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * Адрес портала задаётся явно, а не берётся из окружения машины: ссылки в письме сверяются
 * целиком — по ним человек и открывает карточку.
 */
const ORIGIN = 'http://localhost:5173';

/**
 * Дни рейсов — заведомо будущие и свои у каждого сценария. База общая: на «сегодня» и на соседние
 * дни рейсы заводят другие тесты, а сводка собирается глазами роли без области — то есть видит
 * вообще всё, что попало в окно.
 */
const DAYS = {
  /** Рейс с листом 4-П и двумя живыми заявками — типовая строка таблицы перевозок. */
  trips: '2099-09-02',
  /** Рейс с листом, на котором проверяются ссылки строки. */
  links: '2099-09-01',
  /** Тот же рейс, но лист аннулирован. */
  cancelled: '2099-09-03',
  /** Рейсы вовсе без листа: своя машина и арендная. */
  noWaybill: '2099-09-04',
  /** Лист есть, а заявки в составе отменены и удалены. */
  dead: '2099-09-05',
};

/** Неделя работы ЭСМ-2 (пн 7 сентября — пт 11-е) и день окна внутри неё. */
const ONSITE = { from: '2099-09-07', to: '2099-09-11', day: '2099-09-09' };
/** Неделя, кончившаяся до окна: лист по ней в письмо не попадает. */
const PAST = { from: '2099-08-31', to: '2099-09-04' };
/** Неделя, на которую выписан 61 лист: ею проверяется лимит строк таблицы. */
const MANY = { from: '2099-09-14', to: '2099-09-18', day: '2099-09-16' };

interface TestRequest {
  id: string;
  /** «ТС-461» — то, чем заявку называют в разговоре и что ищут в письме глазами. */
  number: string;
}

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  digestTripsDays: typeof DigestTripsDays;
  digestOnsiteTable: typeof DigestOnsiteTable;
  loadPrincipal: typeof LoadPrincipal;
  /** Получатель сводки: диспетчер — роль без области, ей видно всё, что попало в окно. */
  recipientId: string;
  /** Автор заявок и рейсов, он же выписавший листы. */
  authorId: string;
  objectId: string;
  freightTypeId: string;
  specialTypeId: string;
  modelId: string;
  vehicleId: string;
  specialVehicleId: string;
  rentalVehicleId: string;
  lessorId: string;
  driverId: string;
  organizationId: string;
  seriesId: string;
}

let ctx: Ctx;

const createdRequestIds: string[] = [];
const createdRouteIds: string[] = [];
const createdWaybillIds: string[] = [];

/** Номера листов внутри своей серии: сквозные, как в журнале учёта бланков. */
let nextWaybillNumber = 1;

/** СНИЛС с верной контрольной суммой: база общая, номера наполнения в ней заняты. */
function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
}

/** Десятизначный ИНН по девяти цифрам основы: контрагент остаётся в общей базе и проверяется. */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN = ORIGIN;
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
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

/** Тип ТС из наполнения: заявка и машина обязаны быть типа своего вида работ. */
async function typeIdOfKind(db: typeof AppDb, kind: string): Promise<string> {
  const res = await db.execute<{ id: string }>(sql`
    SELECT vt.id FROM vehicle_types vt
    JOIN vehicle_kinds vk ON vk.id = vt.kind_id
    WHERE vk.code = ${kind}
    ORDER BY vt.name
    LIMIT 1`);
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`В базе нет типа ТС вида ${kind}: миграции наполнения не применены`);
  return id;
}

/** Заявка на грузоперевозку с деталями: из них таблица берёт адреса и время подачи. */
async function makeFreightRequest(input: {
  tag: string;
  status?: 'new' | 'confirmed' | 'cancelled';
  deleted?: boolean;
}): Promise<TestRequest> {
  const { db, schema } = ctx;
  const [request] = await db
    .insert(schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.freightTypeId,
      status: input.status ?? 'confirmed',
      createdBy: ctx.authorId,
      ...(input.deleted ? { deletedAt: new Date(), deletedBy: ctx.authorId } : {}),
    })
    .returning({ id: schema.vehicleRequests.id, num: schema.vehicleRequests.num });
  createdRequestIds.push(request!.id);

  await db.insert(schema.freightTransportRequestDetails).values({
    requestId: request!.id,
    scheduledAt: new Date(`${DAYS.trips}T05:30:00Z`),
    volumeM3: '10.000',
    loadingLocation: `г Москва, ул Погрузочная, д 1 (${input.tag})`,
    unloadingLocation: `г Москва, ул Разгрузочная, д 2 (${input.tag})`,
  });
  return { id: request!.id, number: formatVehicleRequestNumber(request!.num) };
}

/** Грузовой рейс с составом; позиции — порядок строк в таблице перевозок. */
async function makeRoute(input: {
  date: string;
  requestIds: string[];
  vehicleId?: string;
}): Promise<{ id: string; displayNumber: string }> {
  const { db, schema } = ctx;
  const [route] = await db
    .insert(schema.vehicleRoutes)
    .values({
      vehicleId: input.vehicleId ?? ctx.vehicleId,
      routeDate: input.date,
      purpose: 'freight',
      driverPersonId: ctx.driverId,
      createdBy: ctx.authorId,
    })
    .returning({ id: schema.vehicleRoutes.id, num: schema.vehicleRoutes.num });
  createdRouteIds.push(route!.id);

  if (input.requestIds.length > 0) {
    await db.insert(schema.vehicleRouteRequests).values(
      input.requestIds.map((requestId, index) => ({
        routeId: route!.id,
        requestId,
        position: index + 1,
      })),
    );
  }
  return { id: route!.id, displayNumber: formatVehicleRouteNumber(route!.num) };
}

/** Лист 4-П на рейс: аннулированный отличается от действующего только статусом и причиной. */
async function makeRouteWaybill(input: { routeId: string; date: string; cancelled?: boolean }) {
  const { db, schema } = ctx;
  const [row] = await db
    .insert(schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: nextWaybillNumber,
      formCode: '4p',
      organizationId: ctx.organizationId,
      vehicleId: ctx.vehicleId,
      driverPersonId: ctx.driverId,
      issuedForDate: input.date,
      routeId: input.routeId,
      issuedBy: ctx.authorId,
      ...(input.cancelled
        ? {
            status: 'cancelled' as const,
            cancelledAt: new Date(),
            cancelledBy: ctx.authorId,
            cancelReason: 'Испорчен при печати',
          }
        : {}),
    })
    .returning({ id: schema.waybills.id });
  nextWaybillNumber += 1;
  createdWaybillIds.push(row!.id);
  return row!.id;
}

/** Заявка на спецтехнику: основание недельного листа ЭСМ-2. */
async function makeSpecialRequest(tag: string, period: { from: string; to: string }) {
  const { db, schema } = ctx;
  const [request] = await db
    .insert(schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.specialTypeId,
      status: 'confirmed',
      comment: `Работы по графику (${tag})`,
      createdBy: ctx.authorId,
    })
    .returning({ id: schema.vehicleRequests.id, num: schema.vehicleRequests.num });
  createdRequestIds.push(request!.id);

  await db.insert(schema.specialEquipmentRequestDetails).values({
    requestId: request!.id,
    dateFrom: period.from,
    dateTo: period.to,
    responsibleName: 'Петров Пётр Петрович',
    responsiblePhone: '9001234567',
  });
  return { id: request!.id, number: formatVehicleRequestNumber(request!.num) };
}

/** Лист ЭСМ-2 на неделю работы машины: рейса у него нет, есть заявка и период. */
async function makeEsm2(input: { requestId: string; from: string; to: string }): Promise<string> {
  const { db, schema } = ctx;
  const [row] = await db
    .insert(schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: nextWaybillNumber,
      formCode: 'esm2',
      organizationId: ctx.organizationId,
      vehicleId: ctx.specialVehicleId,
      driverPersonId: ctx.driverId,
      issuedForDate: input.from,
      sourceRequestId: input.requestId,
      periodFrom: input.from,
      periodTo: input.to,
      issuedBy: ctx.authorId,
    })
    .returning({ id: schema.waybills.id, number: schema.waybills.number });
  nextWaybillNumber += 1;
  createdWaybillIds.push(row!.id);
  // Ширина серии — 8 знаков, префикса нет: номер печатается как «00000001».
  return String(row!.number).padStart(8, '0');
}

/** Окно письма от имени получателя — ровно тот контекст, который собирает `runRoleDigest`. */
async function contextFor(from: string, to: string): Promise<DigestContext> {
  const principal = await ctx.loadPrincipal(ctx.recipientId);
  return {
    principal: principal!,
    windowFrom: from,
    windowTo: to,
    requestScope: 'scope',
    scopeMode: 'all',
    objectIds: [],
    departmentIds: [],
  };
}

/** Таблицы перевозок за один день окна. */
async function tripsOn(date: string) {
  return ctx.digestTripsDays(await contextFor(date, date));
}

/** Таблица техники на объектах за один день окна. */
async function onsiteOn(date: string) {
  return ctx.digestOnsiteTable(await contextFor(date, date));
}

describe.skipIf(!DB_URL)('сводка по путевым листам (живая схема)', () => {
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { loadPrincipal } = await import('../src/auth/principal');
    const { digestOnsiteTable, digestTripsDays } =
      await import('../src/services/mailings/digest-waybills');

    const [author] = await db
      .insert(schema.users)
      .values({
        email: `db-wb-author-${suffix}@example.invalid`,
        lastName: 'Тестовый',
        firstName: 'Автор',
        middleName: '',
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    const [recipient] = await db
      .insert(schema.users)
      .values({
        email: `db-wb-disp-${suffix}@example.invalid`,
        lastName: 'Тестовый',
        firstName: 'Диспетчер',
        middleName: '',
        passwordHash: 'db-test-not-a-hash',
        role: 'dispatcher',
        isActive: true,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `WB-${suffix}`,
        name: `Тестовая площадка (листы) ${suffix}`,
        address: 'г Москва, ул Объектная, д 5',
      })
      .returning({ id: schema.constructionObjects.id });

    const freightTypeId = await typeIdOfKind(db, 'freight_transport');
    const specialTypeId = await typeIdOfKind(db, 'special_equipment');

    const [model] = await db
      .insert(schema.vehicleModels)
      .values({ vehicleTypeId: freightTypeId, name: `Тестовый самосвал (листы) ${suffix}` })
      .returning({ id: schema.vehicleModels.id });
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({
        ownership: 'own',
        vehicleTypeId: freightTypeId,
        vehicleModelId: model!.id,
        registrationNumber: `В${suffix.slice(0, 3).toUpperCase()}199`,
        status: 'active',
      })
      .returning({ id: schema.vehicles.id });
    const [specialVehicle] = await db
      .insert(schema.vehicles)
      .values({
        ownership: 'own',
        vehicleTypeId: specialTypeId,
        registrationNumber: `В${suffix.slice(0, 3).toUpperCase()}299`,
        status: 'active',
      })
      .returning({ id: schema.vehicles.id });

    // Арендная машина: своего листа у неё не бывает — его выписывает арендодатель, и рейс на ней
    // в сводку не попадает ни строкой, ни счётчиком.
    const [lessor] = await db
      .insert(schema.counterparties)
      .values({
        type: 'vehicle_lessor',
        name: `Тестовый арендодатель ${suffix}`,
        inn: innOf(`79${String(Date.now()).slice(-6)}0`),
      })
      .returning({ id: schema.counterparties.id });
    const [rentalVehicle] = await db
      .insert(schema.vehicles)
      .values({
        ownership: 'rental',
        vehicleTypeId: freightTypeId,
        lessorId: lessor!.id,
        lessorType: 'vehicle_lessor',
        lessorIsActive: true,
        description: `Самосвал арендный ${suffix}`,
        pricePerHour: '2500.00',
        status: 'active',
      })
      .returning({ id: schema.vehicles.id });

    const [driver] = await db
      .insert(schema.persons)
      .values({
        lastName: `Листовой${suffix}`,
        firstName: 'Иван',
        middleName: 'Петрович',
        snils: makeSnils(),
        phone: '9007654321',
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: сводка по путевым листам',
      })
      .returning({ id: schema.persons.id });

    const organization = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
    );
    const organizationId = organization.rows[0]?.id;
    if (!organizationId)
      throw new Error('В базе нет организации: миграции наполнения не применены');

    // Своя серия бланков, а не общая: номера в общей выдаёт сервис выписки, и тест, занимающий
    // их вручную, оставил бы в журнале учёта дыры.
    const [series] = await db
      .insert(schema.waybillSeries)
      .values({
        code: `dig${suffix}`,
        name: `Тестовая серия (сводка) ${suffix}`,
        nextNumber: 1,
      })
      .returning({ id: schema.waybillSeries.id });

    ctx = {
      db,
      closeDb,
      schema,
      digestTripsDays,
      digestOnsiteTable,
      loadPrincipal,
      recipientId: recipient!.id,
      authorId: author!.id,
      objectId: object!.id,
      freightTypeId,
      specialTypeId,
      modelId: model!.id,
      vehicleId: vehicle!.id,
      specialVehicleId: specialVehicle!.id,
      rentalVehicleId: rentalVehicle!.id,
      lessorId: lessor!.id,
      driverId: driver!.id,
      organizationId,
      seriesId: series!.id,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { db, schema } = ctx;
    // Порядок — по ссылкам: лист держит RESTRICT'ом и рейс, и заявку, и машину, и водителя;
    // рейс держит заявку; заявки и рейсы держат учётку автора.
    if (createdWaybillIds.length > 0) {
      await db.delete(schema.waybills).where(inArray(schema.waybills.id, createdWaybillIds));
    }
    if (createdRouteIds.length > 0) {
      await db
        .delete(schema.vehicleRoutes)
        .where(inArray(schema.vehicleRoutes.id, createdRouteIds));
    }
    if (createdRequestIds.length > 0) {
      await db
        .delete(schema.vehicleRequests)
        .where(inArray(schema.vehicleRequests.id, createdRequestIds));
    }
    await db
      .delete(schema.vehicles)
      .where(
        inArray(schema.vehicles.id, [ctx.vehicleId, ctx.specialVehicleId, ctx.rentalVehicleId]),
      );
    await db.delete(schema.vehicleModels).where(eq(schema.vehicleModels.id, ctx.modelId));
    await db.delete(schema.counterparties).where(eq(schema.counterparties.id, ctx.lessorId));
    await db.delete(schema.waybillSeries).where(eq(schema.waybillSeries.id, ctx.seriesId));
    await db.delete(schema.persons).where(eq(schema.persons.id, ctx.driverId));
    await db
      .delete(schema.constructionObjects)
      .where(eq(schema.constructionObjects.id, ctx.objectId));
    await db.delete(schema.users).where(inArray(schema.users.id, [ctx.authorId, ctx.recipientId]));
    await ctx.closeDb();
  });

  it('лист 4-П на рейс окна даёт по строке на каждую живую заявку рейса', async () => {
    const first = await makeFreightRequest({ tag: 'первая' });
    const second = await makeFreightRequest({ tag: 'вторая' });
    const route = await makeRoute({ date: DAYS.trips, requestIds: [first.id, second.id] });
    await makeRouteWaybill({ routeId: route.id, date: DAYS.trips });

    const days = await tripsOn(DAYS.trips);
    expect(days).toHaveLength(1);
    const table = days[0]!.table;
    // Строка на заявку, а не на рейс: у одного выезда семь талонов, и «Р-12 · 7 заявок» не
    // отвечает на вопрос, куда именно машина едет.
    expect(table.total).toBe(2);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]![1]!.text).toContain(first.number);
    expect(table.rows[1]![1]!.text).toContain(second.number);
    // Номер рейса печатается только у первой строки: повтори его во второй — читатель насчитает
    // два выезда там, где выезд один. Продолжение остаётся пустым, а не прочерком: прочерк в графе
    // водителя читается как «не назначен», хотя человек назван строкой выше.
    expect(table.rows[0]![0]!.text).toContain(route.displayNumber);
    expect(table.rows[1]![0]!.text).toBe('');
    expect(table.rows[1]![3]!.text).toBe('');
  });

  it('номер заявки в строке — ссылка на её карточку, номер рейса — на карточку рейса', async () => {
    const request = await makeFreightRequest({ tag: 'ссылка' });
    const route = await makeRoute({ date: DAYS.links, requestIds: [request.id] });
    await makeRouteWaybill({ routeId: route.id, date: DAYS.links });

    const days = await tripsOn(DAYS.links);
    const row = days[0]!.table.rows[0]!;

    // Номер печатается ссылкой, и адрес считается общим правилом контрактов: разойдись письмо с
    // порталом в выборе вкладки — ссылка привела бы на список, в котором заявки нет. Заявка
    // взята в работу, значит её показывают во вкладке заявок, а не в журнале закрытых.
    expect(row[1]!.text).toContain(request.number);
    expect(row[1]!.href).toBe(
      `${ORIGIN}${vehicleRequestPath({ id: request.id, status: 'confirmed' })}`,
    );
    expect(row[1]!.href).toContain('tab=requests');
    expect(row[0]!.href).toBe(`${ORIGIN}${vehicleRoutePath(route.id)}`);
  });

  it('аннулированный лист не даёт ни одной строки: работы по нему не будет', async () => {
    const request = await makeFreightRequest({ tag: 'аннулированный' });
    const route = await makeRoute({ date: DAYS.cancelled, requestIds: [request.id] });
    await makeRouteWaybill({ routeId: route.id, date: DAYS.cancelled, cancelled: true });

    // Списанный бланк — не «лист с пометкой»: рейс по нему не состоится, и в сводке его быть не
    // должно так же, как если бы листа не выписывали вовсе.
    expect(await tripsOn(DAYS.cancelled)).toEqual([]);
  });

  it('рейс без листа не попадает — ни своя машина, ни арендная', async () => {
    const own = await makeFreightRequest({ tag: 'без листа' });
    const rented = await makeFreightRequest({ tag: 'аренда' });
    await makeRoute({ date: DAYS.noWaybill, requestIds: [own.id] });
    await makeRoute({
      date: DAYS.noWaybill,
      requestIds: [rented.id],
      vehicleId: ctx.rentalVehicleId,
    });

    // На арендную технику лист выписывает арендодатель, и своего листа в портале у неё не будет
    // никогда. Сводка отвечает на вопрос «что оформлено», а не «что запланировано», — оговорки
    // «плюс аренда» в ней нет.
    expect(await tripsOn(DAYS.noWaybill)).toEqual([]);
  });

  it('отменённая и удалённая заявки выпадают, а рейс без живых заявок не даёт строк вовсе', async () => {
    const alive = await makeFreightRequest({ tag: 'живая' });
    const cancelled = await makeFreightRequest({ tag: 'отменённая', status: 'cancelled' });
    const deleted = await makeFreightRequest({ tag: 'удалённая', deleted: true });
    const withAlive = await makeRoute({
      date: DAYS.dead,
      requestIds: [alive.id, cancelled.id, deleted.id],
    });
    await makeRouteWaybill({ routeId: withAlive.id, date: DAYS.dead });

    const dead = await makeFreightRequest({ tag: 'вторая отменённая', status: 'cancelled' });
    const deadRoute = await makeRoute({ date: DAYS.dead, requestIds: [dead.id] });
    await makeRouteWaybill({ routeId: deadRoute.id, date: DAYS.dead });

    const days = await tripsOn(DAYS.dead);
    expect(days).toHaveLength(1);
    const table = days[0]!.table;
    // Отменённая заявка остаётся в составе рейса историей — лист по ней уже выписан, — но ехать
    // по ней не надо; удалённая не показывается никому, кроме архива.
    expect(table.total).toBe(1);
    expect(table.rows[0]![1]!.text).toContain(alive.number);
    const printed = table.rows
      .flat()
      .map((cell) => cell.text)
      .join(' ');
    expect(printed).not.toContain(cancelled.number);
    expect(printed).not.toContain(deleted.number);
    // Счётчик считается теми же строками, что печатаются: рейс, у которого живых заявок не
    // осталось, не должен добавлять к нему единицу «на всякий случай».
    expect(printed).not.toContain(deadRoute.displayNumber);
  });

  it('ЭСМ-2 попадает в окно пересечением недели, а кончившийся до окна — нет', async () => {
    const working = await makeSpecialRequest('в работе', ONSITE);
    const number = await makeEsm2({ requestId: working.id, from: ONSITE.from, to: ONSITE.to });
    const past = await makeSpecialRequest('прошлая неделя', PAST);
    const pastNumber = await makeEsm2({ requestId: past.id, from: PAST.from, to: PAST.to });

    const table = await onsiteOn(ONSITE.day);
    expect(table).not.toBeNull();
    // Машина, начавшая работать в понедельник, стоит на площадке и в среду: отбор по дате
    // выписки потерял бы её во все дни, кроме первого.
    expect(table!.total).toBe(1);
    expect(table!.rows[0]![0]!.text).toBe(number);
    expect(table!.rows[0]![1]!.text).toContain(working.number);
    // Лист прошлой недели кончился до окна — работы по нему в эти дни нет.
    expect(table!.rows.flat().map((cell) => cell.text)).not.toContain(pastNumber);
    // Период печатается пересечённым с окном: «7–11 сентября» в сводке на среду отвечает не на
    // тот вопрос, который задан.
    expect(table!.rows[0]![0]!.sub).toBe('9 сентября');
  });

  it('строк больше лимита — печатается лимит, а счётчик остаётся полным', async () => {
    const { db, schema } = ctx;
    const count = DIGEST_TABLE_ROW_LIMIT + 1;
    const requests = await db
      .insert(schema.vehicleRequests)
      .values(
        Array.from({ length: count }, () => ({
          requestType: 'special_equipment' as const,
          objectId: ctx.objectId,
          vehicleTypeId: ctx.specialTypeId,
          status: 'confirmed' as const,
          createdBy: ctx.authorId,
        })),
      )
      .returning({ id: schema.vehicleRequests.id });
    createdRequestIds.push(...requests.map((r) => r.id));
    await db.insert(schema.specialEquipmentRequestDetails).values(
      requests.map((r) => ({
        requestId: r.id,
        dateFrom: MANY.from,
        dateTo: MANY.to,
        responsibleName: 'Петров Пётр Петрович',
        responsiblePhone: '9001234567',
      })),
    );
    const waybills = await db
      .insert(schema.waybills)
      .values(
        requests.map((r, i) => ({
          seriesId: ctx.seriesId,
          number: nextWaybillNumber + i,
          formCode: 'esm2' as const,
          organizationId: ctx.organizationId,
          vehicleId: ctx.specialVehicleId,
          driverPersonId: ctx.driverId,
          issuedForDate: MANY.from,
          sourceRequestId: r.id,
          periodFrom: MANY.from,
          periodTo: MANY.to,
          issuedBy: ctx.authorId,
        })),
      )
      .returning({ id: schema.waybills.id });
    nextWaybillNumber += count;
    createdWaybillIds.push(...waybills.map((r) => r.id));

    const table = await onsiteOn(MANY.day);
    expect(table).not.toBeNull();
    // Лимит — потолок против письма, которое почтовый клиент обрежет на середине; счётчик при
    // этом обязан остаться полным, иначе человек решит, что техники на объектах ровно шестьдесят
    // единиц, и не пойдёт смотреть остальное.
    expect(table!.rows).toHaveLength(DIGEST_TABLE_ROW_LIMIT);
    expect(table!.total).toBe(count);
    expect(table!.link).toBe(`${ORIGIN}/vehicle-requests?tab=on-site`);
  });
});
