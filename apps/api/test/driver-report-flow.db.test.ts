import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  type DriverReportDto,
  type ReadingInput,
  type ReportItemSubmit,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type * as ReadingsService from '../src/services/readings';

/**
 * Приёмка дня и журнал решений по расхождениям (ADR 0103, план Р21/Р22) — на живой схеме.
 *
 * Зачем база. Четыре условия приёма (Р22) не живут в ветвлении: непустота, закрытость строк и
 * аномалии считаются запросами по трём таблицам, расхождение — сравнением снимка с ЖИВЫМ
 * источником, а «разобрано ли оно» — последним событием журнала по отпечатку. Сверх того половину
 * правил держит сама схема: матрица состояний шапки одним CHECK'ом (`draft` с проставленной
 * приёмкой незаконен, `needs_reacceptance` требует `accepted_content_version < content_version`),
 * глобальная уникальность источника и составной ключ снимка. Проверить это на правилах нечем —
 * расходятся не правила, а код и база.
 *
 * Живой источник тест меняет прямым UPDATE рейса намеренно: переназначение водителя и смена
 * машины — действия чужого модуля, и звать его сервис значило бы тащить сюда принципала, права и
 * окна коррекции. Предмет теста — то, как показания на эти изменения отвечают.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/driver-report-flow.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Уникальный хвост прогона: база общая и переживает прогоны, а коды справочников уникальны. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const ADMIN_EMAIL = `db-report-flow-${RUN}@example.invalid`;
/** Метка тестовых людей: по ней их и убирают за собой. */
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: приёмка отчёта дня';
/**
 * Своя серия бланков, а не общая: номер уникален внутри серии, и нумеровать листы в чужой серии
 * значило бы драться за номера с соседним db-тестом того же прогона. Префикс `zz_` — чтобы серия
 * не стала первой у тестов, берущих её `ORDER BY code LIMIT 1`.
 */
const SERIES_CODE = `zz_report_flow_${RUN}`;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  readings: typeof ReadingsService;
  /** Принимающий и он же автор рейсов: `created_by` обязателен везде. */
  userId: string;
  objectId: string;
  vehicleTypeId: string;
  modelId: string;
  organizationId: string;
  seriesId: string;
  /** Чужой работник: ему переназначают рейс, чтобы получить расхождение по водителю. */
  strangerId: string;
  today: string;
}

let ctx: Ctx;
let waybillNo = 0;

/** Что завёл файл: по этим спискам он за собой и убирает — база у db-тестов общая. */
const created = {
  personIds: [] as string[],
  vehicleIds: [] as string[],
  routeIds: [] as string[],
  requestIds: [] as string[],
  fileIds: [] as string[],
  waybillIds: [] as string[],
};

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
 * СНИЛС генерируется, а не берётся готовым: база общая, и номера сида в ней заняты живыми
 * карточками. Контрольное число считается правилами ПФР — иначе запись не пройдёт CHECK формата.
 */
function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
}

/** Свой работник на каждый сценарий: отчёт один на пару «человек + день», и делить их нельзя. */
async function makeDriver(lastName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({
      lastName: `${lastName}${RUN}`,
      firstName: 'Иван',
      middleName: 'Петрович',
      snils: makeSnils(),
      comment: PERSON_MARK,
    })
    .returning({ id: ctx.schema.persons.id });
  created.personIds.push(person!.id);
  return person!.id;
}

/** Своя машина на сценарий: цепочка счётчиков строится по машине, и общая перепутала бы ряды. */
async function makeVehicle(): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'own',
      vehicleTypeId: ctx.vehicleTypeId,
      vehicleModelId: ctx.modelId,
      registrationNumber: `Т${randomUUID().slice(0, 6).toUpperCase()}ЕС${created.vehicleIds.length}77`,
      status: 'active',
    })
    .returning({ id: ctx.schema.vehicles.id });
  created.vehicleIds.push(vehicle!.id);
  return vehicle!.id;
}

/**
 * Лист 4-П по рейсу: `waybills_form_source_check` требует у него заполненный `route_id`. Выписка —
 * часть фикстуры рейса, а не отдельный сценарий: кабинет строго документален (ADR 0105, Р5), и
 * рейс без действительного листа в задание не входит, а значит и строки ожидания не даёт.
 */
async function issueWaybillFor(opts: {
  routeId: string;
  vehicleId: string;
  personId: string;
  date: string;
}): Promise<string> {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: waybillNo,
      formCode: '4p',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId: opts.vehicleId,
      driverPersonId: opts.personId,
      issuedForDate: opts.date,
      routeId: opts.routeId,
      issuedBy: ctx.userId,
    })
    .returning({ id: ctx.schema.waybills.id });
  created.waybillIds.push(waybill!.id);
  return waybill!.id;
}

/**
 * Грузовой рейс с одной живой заявкой в составе и выписанным по нему листом. Заявка обязательна:
 * рейс без единой живой заявки в задание дня не попадает вовсе (`loadRouteEntries`), а строки
 * ожидания строятся из задания. Лист обязателен по той же причине (ADR 0105, Р5): у рейса, по
 * которому сдают показания, бумага выписана до выезда.
 */
async function makeRoute(opts: {
  vehicleId: string;
  personId: string;
  date: string;
}): Promise<string> {
  const { schema } = ctx;
  const [request] = await ctx.db
    .insert(schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      status: 'confirmed',
      createdBy: ctx.userId,
    })
    .returning({ id: schema.vehicleRequests.id });
  created.requestIds.push(request!.id);
  await ctx.db.insert(schema.freightTransportRequestDetails).values({
    requestId: request!.id,
    scheduledAt: new Date(`${opts.date}T05:30:00Z`),
  });
  // Адреса и количество — у ездки, а не у заявки (план `docs/route-trips-plan.md`, Р2): у заявки
  // с ездками `A→B` и `A→C` «адрес разгрузки заявки» не существует. Одна ездка — то же, чем была
  // пара полей детали.
  await ctx.db.insert(schema.vehicleRequestTrips).values({
    requestId: request!.id,
    num: 1,
    fromLocation: 'г Москва, ул Погрузочная, д 1',
    toLocation: 'г Москва, ул Разгрузочная, д 2',
    volumeM3: '10.000',
  });

  const [route] = await ctx.db
    .insert(schema.vehicleRoutes)
    .values({
      vehicleId: opts.vehicleId,
      routeDate: opts.date,
      purpose: 'freight',
      driverPersonId: opts.personId,
      createdBy: ctx.userId,
    })
    .returning({ id: schema.vehicleRoutes.id });
  created.routeIds.push(route!.id);
  await ctx.db
    .insert(schema.vehicleRouteRequests)
    .values({ routeId: route!.id, requestId: request!.id, position: 1 });
  await issueWaybillFor({
    routeId: route!.id,
    vehicleId: opts.vehicleId,
    personId: opts.personId,
    date: opts.date,
  });
  return route!.id;
}

/** Загруженный файл: показанию годится только `active` — `pending` это оборванная загрузка (Р18). */
async function makeFile(): Promise<string> {
  const [file] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `readings/${randomUUID()}.jpg`,
      filename: 'приборная-панель.jpg',
      contentType: 'image/jpeg',
      size: 1024,
      status: 'active',
      uploadedBy: ctx.userId,
    })
    .returning({ id: ctx.schema.files.id });
  created.fileIds.push(file!.id);
  return file!.id;
}

// ── Ввод показаний ──

function odometer(km: number): ReadingInput {
  return { kind: 'values', odometerKm: km, engineHours: null, fuelFilledLiters: null, comment: '' };
}

/** Закрытие строки без чисел: вид, которым диспетчер отвечает «снять было нечем» (Р18). */
function noData(reason: string): ReadingInput {
  return { kind: 'no_data', noDataReason: reason, comment: '' };
}

function line(
  itemId: string,
  reading: ReadingInput,
  confirm: { odometer?: boolean; engineHours?: boolean } = {},
): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: [],
    confirmOdometerAnomaly: confirm.odometer ?? false,
    confirmEngineHoursAnomaly: confirm.engineHours ?? false,
  };
}

/** Строка отчёта по своему источнику: порядок строк задаёт машина и позиция смены, а не рейс. */
function itemOf(report: DriverReportDto, sourceId: string) {
  const item = report.items.find((i) => i.sourceId === sourceId);
  if (!item) throw new Error(`в отчёте нет строки по источнику ${sourceId}`);
  return item;
}

/** Отказ операции: проверяются и код, и текст — по тексту диспетчер понимает, что чинить. */
async function failure(
  promise: Promise<unknown>,
): Promise<{ statusCode: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode: number; message: string };
  }
  throw new Error('ожидался отказ, но операция прошла');
}

describe.skipIf(!DB_URL)('отчёт дня: приёмка и разбор расхождений (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const readings = await import('../src/services/readings');

    const [user] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Диспетчер',
        middleName: 'Приёмный',
        // Входа здесь нет: тест зовёт сервисы напрямую, пароль не участвует.
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        // «яя» в коде: половина db-тестов берёт объект `ORDER BY … LIMIT 1`, и запись, ставшая
        // первой, молча увела бы их заявки на тестовую площадку.
        code: `яя-report-flow-${RUN}`,
        name: `Тестовая площадка (приёмка) ${RUN}`,
        address: 'г Москва, ул Объектная, д 1',
      })
      .returning({ id: schema.constructionObjects.id });

    const typeRes = await db.execute<{ id: string }>(sql`
      SELECT vt.id FROM vehicle_types vt
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE vk.code = 'freight_transport'
      ORDER BY vt.name
      LIMIT 1`);
    const vehicleTypeId = typeRes.rows[0]?.id;
    if (!vehicleTypeId) throw new Error('В базе нет грузового типа ТС: наполнение не применено');

    const [model] = await db
      .insert(schema.vehicleModels)
      .values({ vehicleTypeId, name: `Тестовый самосвал ${RUN}` })
      .returning({ id: schema.vehicleModels.id });

    const orgRes = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
    );
    const organizationId = orgRes.rows[0]?.id;
    if (!organizationId) throw new Error('В базе нет организации: наполнение не применено');

    const [series] = await db
      .insert(schema.waybillSeries)
      .values({
        code: SERIES_CODE,
        name: `Тестовая серия (приёмка) ${RUN}`,
        prefix: 'ПРМ-',
      })
      .returning({ id: schema.waybillSeries.id });

    ctx = {
      db,
      closeDb,
      schema,
      readings,
      userId: user!.id,
      objectId: object!.id,
      vehicleTypeId,
      modelId: model!.id,
      organizationId,
      seriesId: series!.id,
      strangerId: '',
      today: moscowDateKeyOf(new Date()),
    };
    ctx.strangerId = await makeDriver('Чужаков');
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { schema, db } = ctx;
    // Порядок — по ссылкам: шапка уносит каскадом строки, показания, истории и журнал решений, но
    // рейс держит строку `RESTRICT`, а заявку — состав рейса. Листы идут перед рейсами и машинами:
    // тех и других лист держит `RESTRICT`'ом, и без сноса листов следующий прогон упёрся бы в него.
    if (created.personIds.length > 0) {
      await db
        .delete(schema.driverDailyReports)
        .where(inArray(schema.driverDailyReports.personId, created.personIds));
    }
    if (created.waybillIds.length > 0) {
      await db.delete(schema.waybills).where(inArray(schema.waybills.id, created.waybillIds));
    }
    if (created.routeIds.length > 0) {
      await db
        .delete(schema.vehicleRoutes)
        .where(inArray(schema.vehicleRoutes.id, created.routeIds));
    }
    if (created.requestIds.length > 0) {
      await db
        .delete(schema.vehicleRequests)
        .where(inArray(schema.vehicleRequests.id, created.requestIds));
    }
    if (created.fileIds.length > 0) {
      await db.delete(schema.files).where(inArray(schema.files.id, created.fileIds));
    }
    if (created.vehicleIds.length > 0) {
      await db.delete(schema.vehicles).where(inArray(schema.vehicles.id, created.vehicleIds));
    }
    await db.delete(schema.vehicleModels).where(eq(schema.vehicleModels.id, ctx.modelId));
    if (created.personIds.length > 0) {
      await db.delete(schema.persons).where(inArray(schema.persons.id, created.personIds));
    }
    await db
      .delete(schema.constructionObjects)
      .where(eq(schema.constructionObjects.id, ctx.objectId));
    await db.delete(schema.waybillSeries).where(eq(schema.waybillSeries.id, ctx.seriesId));
    await db.delete(schema.users).where(eq(schema.users.id, ctx.userId));
    await ctx.closeDb();
  });

  // ── Четыре условия приёма (Р22) ──

  it('пустой отчёт принять нельзя: непустота — своё условие, а не следствие «все закрыты»', async () => {
    const person = await makeDriver('Пустов');
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    expect(opened.items).toHaveLength(0);

    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      { version: opened.version, items: [], reason: '' },
      ctx.userId,
      null,
    );
    expect(submitted.state).toBe('submitted');
    expect(submitted.canAccept).toBe(false);
    expect(submitted.blockers.join('; ')).toContain('нет ни одной строки');

    const denied = await failure(
      ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId),
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('нет ни одной строки');
  });

  it('день с незакрытой строкой принять нельзя: иначе гараж показывал бы «частично» у принятого', async () => {
    const person = await makeDriver('Недосдач');
    const first = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    await makeRoute({ vehicleId: await makeVehicle(), personId: person, date: ctx.today });

    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    expect(opened.items).toHaveLength(2);
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: opened.version,
        items: [line(itemOf(opened, first).id, odometer(120))],
        reason: '',
      },
      ctx.userId,
      null,
    );

    expect(submitted.blockers.join('; ')).toContain('не закрыто строк: 1');
    const denied = await failure(
      ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId),
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('не закрыто строк: 1');
  });

  it('неподтверждённая аномалия держит день до подписи, а подтверждение открывает приём', async () => {
    const person = await makeDriver('Сбросов');
    const vehicle = await makeVehicle();
    const morning = await makeRoute({ vehicleId: vehicle, personId: person, date: ctx.today });
    const evening = await makeRoute({ vehicleId: vehicle, personId: person, date: ctx.today });

    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const morningItem = itemOf(opened, morning).id;
    const eveningItem = itemOf(opened, evening).id;
    // Вторая смена показывает меньше первой: счётчик сброшен или заменён.
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: opened.version,
        items: [line(morningItem, odometer(1000)), line(eveningItem, odometer(900))],
        reason: '',
      },
      ctx.userId,
      null,
    );
    expect(itemOf(submitted, evening).reading?.odometerAnomaly).toMatchObject({
      kind: 'counter_reset',
      confirmed: false,
    });

    const denied = await failure(
      ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId),
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('не подтверждены аномалии');

    // Те же числа с подписью: содержимое не менялось, поэтому редакция остаётся прежней.
    const confirmed = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: submitted.version,
        items: [
          line(morningItem, odometer(1000)),
          line(eveningItem, odometer(900), { odometer: true }),
        ],
        reason: '',
      },
      ctx.userId,
      null,
    );
    expect(confirmed.contentVersion).toBe(submitted.contentVersion);
    expect(itemOf(confirmed, evening).reading?.odometerAnomaly?.confirmed).toBe(true);

    const accepted = await ctx.readings.acceptReport(confirmed.id, confirmed.version, ctx.userId);
    expect(accepted.state).toBe('accepted');
  });

  it('неразобранное расхождение держит день: рейс переназначен, снимок остался прежним', async () => {
    const person = await makeDriver('Расхожд');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: opened.version,
        items: [line(itemOf(opened, route).id, odometer(300))],
        reason: '',
      },
      ctx.userId,
      null,
    );

    // Диспетчер переназначает рейс: снимок отчёта об этом не знает — и не должен (Р21).
    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: ctx.strangerId })
      .where(eq(ctx.schema.vehicleRoutes.id, route));

    const seen = await ctx.readings.loadReportById(submitted.id);
    expect(seen.discrepancies).toHaveLength(1);
    expect(seen.discrepancies[0]).toMatchObject({ kind: 'driver', resolved: false });
    const denied = await failure(ctx.readings.acceptReport(seen.id, seen.version, ctx.userId));
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('не разобрано расхождений: 1');
  });

  // ── Кто закрывает строку без показаний (план кабинета, Р4) ──

  it('водитель не ставит «нет возможности снять показания»: отказ, и показания не появляется', async () => {
    const person = await makeDriver('Отписков');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);

    // Режим по умолчанию — водительский: так кабинет и зовёт сервис.
    const denied = await failure(
      ctx.readings.submitReport(
        person,
        ctx.today,
        {
          version: opened.version,
          items: [line(itemOf(opened, route).id, noData('счётчик разбит'))],
          reason: '',
        },
        ctx.userId,
        null,
      ),
    );
    expect(denied.statusCode).toBe(403);
    // Текст говорит, что делать: строку не заполняют, её закрывает диспетчер.
    expect(denied.message).toContain('диспетчер');

    // Отказ не оставил следа: ни показания, ни сдвинутой версии — иначе водитель закрыл бы день
    // наполовину, а гараж показал бы «частично» там, где не было и попытки.
    const after = await ctx.readings.loadReport(person, ctx.today);
    expect(after!.state).toBe('draft');
    expect(after!.version).toBe(opened.version);
    expect(after!.items.every((i) => i.reading === null)).toBe(true);
  });

  it('строку без показаний закрывает диспетчер: до этого день не принимается, после — принимается', async () => {
    const person = await makeDriver('Диспетч');
    const driven = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const broken = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });

    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    expect(opened.items).toHaveLength(2);
    // Водитель отправляет только то, что снял: строка с неисправным счётчиком остаётся пустой.
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: opened.version,
        items: [line(itemOf(opened, driven).id, odometer(240))],
        reason: '',
      },
      ctx.userId,
      null,
    );
    expect(itemOf(submitted, broken).reading).toBeNull();

    // Условие приёма «все строки закрыты» (Р22) продолжает работать: день висит как «частично».
    expect(submitted.canAccept).toBe(false);
    expect(submitted.blockers.join('; ')).toContain('не закрыто строк: 1');
    const early = await failure(
      ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId),
    );
    expect(early.statusCode).toBe(409);
    expect(early.message).toContain('не закрыто строк: 1');

    // Тем же видом, который водителю запрещён, персонал строку закрывает — с причиной, которую
    // знает: в этом и смысл переноса действия (Р4).
    const closed = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: submitted.version,
        items: [line(itemOf(submitted, broken).id, noData('счётчик неисправен, кабина опечатана'))],
        reason: '',
      },
      ctx.userId,
      null,
      { mode: 'staff' },
    );
    const closedItem = itemOf(closed, broken);
    expect(closedItem.reading).toMatchObject({
      kind: 'no_data',
      noDataReason: 'счётчик неисправен, кабина опечатана',
      source: 'staff',
    });
    expect(closed.canAccept).toBe(true);

    const accepted = await ctx.readings.acceptReport(closed.id, closed.version, ctx.userId);
    expect(accepted.state).toBe('accepted');
  });

  // ── Версии (Р22) ──

  it('приём записывает принятую редакцию и сам её не двигает', async () => {
    const person = await makeDriver('Принятов');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: opened.version,
        items: [line(itemOf(opened, route).id, odometer(500))],
        reason: '',
      },
      ctx.userId,
      null,
    );

    const accepted = await ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId);

    expect(accepted.state).toBe('accepted');
    expect(accepted.acceptedContentVersion).toBe(submitted.contentVersion);
    // Приём фиксирует числа, а не нажатие: редакция содержимого им не меняется, версия шапки — да.
    expect(accepted.contentVersion).toBe(submitted.contentVersion);
    expect(accepted.version).toBe(submitted.version + 1);
    expect(accepted.acceptedAt).not.toBeNull();
  });

  it('правка принятого переводит его на повторный приём, а принятую редакцию сохраняет', async () => {
    const person = await makeDriver('Поправк');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const item = itemOf(opened, route).id;
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      { version: opened.version, items: [line(item, odometer(700))], reason: '' },
      ctx.userId,
      null,
    );
    const accepted = await ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId);

    const edited = await ctx.readings.submitReport(
      person,
      ctx.today,
      { version: accepted.version, items: [line(item, odometer(760))], reason: 'уточнили по фото' },
      ctx.userId,
      null,
      { mode: 'staff', reason: 'уточнили по фото' },
    );

    expect(edited.state).toBe('needs_reacceptance');
    // По паре версий видно, насколько принятое разошлось с текущим, — приём при этом не стёрт.
    expect(edited.acceptedContentVersion).toBe(accepted.acceptedContentVersion);
    expect(edited.contentVersion).toBe(accepted.contentVersion + 1);
    expect(edited.acceptedAt).toBe(accepted.acceptedAt);
    expect(edited.acceptedByName).toBe(accepted.acceptedByName);

    // Повторный приём — те же четыре условия и та же запись принятой редакции.
    const reaccepted = await ctx.readings.acceptReport(edited.id, edited.version, ctx.userId);
    expect(reaccepted.state).toBe('accepted');
    expect(reaccepted.acceptedContentVersion).toBe(edited.contentVersion);
  });

  it('приложенное фото не двигает ни редакцию содержимого, ни состояние принятого отчёта', async () => {
    const person = await makeDriver('Фотограф');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const item = itemOf(opened, route).id;
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      { version: opened.version, items: [line(item, odometer(400))], reason: '' },
      ctx.userId,
      null,
    );
    const accepted = await ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId);

    const fileId = await makeFile();
    const withPhoto = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: accepted.version,
        items: [{ ...line(item, odometer(400)), fileIds: [fileId] }],
        reason: '',
      },
      ctx.userId,
      null,
      { mode: 'staff' },
    );

    expect(withPhoto.state).toBe('accepted');
    expect(withPhoto.contentVersion).toBe(accepted.contentVersion);
    expect(withPhoto.acceptedContentVersion).toBe(accepted.acceptedContentVersion);
    expect(itemOf(withPhoto, route).reading?.fileIds).toEqual([fileId]);
  });

  it('гонка «правка против приёма»: приём с устаревшей версией отвергается', async () => {
    const person = await makeDriver('Гоночк');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const item = itemOf(opened, route).id;
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      { version: opened.version, items: [line(item, odometer(200))], reason: '' },
      ctx.userId,
      null,
    );
    // Водитель дописал строку, пока диспетчер смотрел на кнопку.
    const edited = await ctx.readings.submitReport(
      person,
      ctx.today,
      { version: submitted.version, items: [line(item, odometer(210))], reason: '' },
      ctx.userId,
      null,
    );
    expect(edited.version).toBeGreaterThan(submitted.version);

    const denied = await failure(
      ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId),
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('Отчёт изменился');
  });

  // ── Журнал решений (Р21) ──

  it('отмена решения при неизменном отпечатке снова делает расхождение неразобранным', async () => {
    const person = await makeDriver('Передум');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: opened.version,
        items: [line(itemOf(opened, route).id, odometer(150))],
        reason: '',
      },
      ctx.userId,
      null,
    );
    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: ctx.strangerId })
      .where(eq(ctx.schema.vehicleRoutes.id, route));

    const seen = await ctx.readings.loadReportById(submitted.id);
    const discrepancy = seen.discrepancies[0]!;
    const resolved = await ctx.readings.resolveDiscrepancy(
      seen.id,
      {
        kind: discrepancy.kind,
        itemId: discrepancy.itemId,
        sourceKind: null,
        sourceId: null,
        fingerprint: discrepancy.fingerprint,
        resolution: 'accepted_as_is',
        reason: 'смена водителя оформлена задним числом, цифры сдал прежний',
        version: seen.version,
      },
      ctx.userId,
    );
    expect(resolved.discrepancies[0]).toMatchObject({ kind: 'driver', resolved: true });
    expect(resolved.canAccept).toBe(true);
    // Разбор двигает версию шапки, но не редакцию содержимого: чисел он не менял (Р22).
    expect(resolved.contentVersion).toBe(seen.contentVersion);
    expect(resolved.version).toBe(seen.version + 1);

    // Отпечаток тот же — вторая запись `accepted_as_is` ничего не изменила бы, и отменяет решение
    // именно `revoked`.
    const revoked = await ctx.readings.resolveDiscrepancy(
      resolved.id,
      {
        kind: discrepancy.kind,
        itemId: discrepancy.itemId,
        sourceKind: null,
        sourceId: null,
        fingerprint: discrepancy.fingerprint,
        resolution: 'revoked',
        reason: 'выяснилось, что ездил другой',
        version: resolved.version,
      },
      ctx.userId,
    );

    expect(revoked.discrepancies[0]).toMatchObject({ resolved: false });
    expect(revoked.canAccept).toBe(false);
    const denied = await failure(
      ctx.readings.acceptReport(revoked.id, revoked.version, ctx.userId),
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('не разобрано расхождений: 1');

    const journal = await ctx.db
      .select({ resolution: ctx.schema.driverReportDiscrepancyResolutions.resolution })
      .from(ctx.schema.driverReportDiscrepancyResolutions)
      .where(eq(ctx.schema.driverReportDiscrepancyResolutions.reportId, seen.id))
      .orderBy(ctx.schema.driverReportDiscrepancyResolutions.reportVersionAfter);
    expect(journal.map((r) => r.resolution)).toEqual(['accepted_as_is', 'revoked']);
  });

  it('передумали дважды: «признали допустимым», затем «добавили источник» — две строки журнала', async () => {
    const person = await makeDriver('Поздняк');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: opened.version,
        items: [line(itemOf(opened, route).id, odometer(800))],
        reason: '',
      },
      ctx.userId,
      null,
    );
    // Рейс завели после отправки: состав дня зафиксирован отправкой, поэтому это расхождение.
    const late = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });

    const seen = await ctx.readings.loadReportById(submitted.id);
    const missing = seen.discrepancies.find((d) => d.kind === 'missing_source')!;
    expect(missing).toMatchObject({ sourceId: late, resolved: false });

    const accepted = await ctx.readings.resolveDiscrepancy(
      seen.id,
      {
        kind: 'missing_source',
        itemId: null,
        sourceKind: missing.sourceKind,
        sourceId: missing.sourceId,
        fingerprint: missing.fingerprint,
        resolution: 'accepted_as_is',
        reason: 'рейс завели ошибочно, машина не выезжала',
        version: seen.version,
      },
      ctx.userId,
    );
    expect(accepted.discrepancies.find((d) => d.kind === 'missing_source')?.resolved).toBe(true);

    const added = await ctx.readings.resolveDiscrepancy(
      accepted.id,
      {
        kind: 'missing_source',
        itemId: null,
        sourceKind: missing.sourceKind,
        sourceId: missing.sourceId,
        fingerprint: missing.fingerprint,
        resolution: 'source_added',
        reason: 'рейс всё-таки был: добавляем строку',
        version: accepted.version,
      },
      ctx.userId,
    );

    // Источник в составе — расхождение исчезло само, а не «стало разобранным».
    expect(added.discrepancies.filter((d) => d.kind === 'missing_source')).toHaveLength(0);
    expect(added.items).toHaveLength(2);
    expect(added.items.map((i) => i.sourceId)).toContain(late);
    // Отправленный отчёт остаётся отправленным: переоткрывать нечего, пока не принимали (Р21).
    expect(added.state).toBe('submitted');
    expect(added.contentVersion).toBe(accepted.contentVersion + 1);

    const journal = await ctx.db
      .select({ resolution: ctx.schema.driverReportDiscrepancyResolutions.resolution })
      .from(ctx.schema.driverReportDiscrepancyResolutions)
      .where(eq(ctx.schema.driverReportDiscrepancyResolutions.reportId, seen.id))
      .orderBy(ctx.schema.driverReportDiscrepancyResolutions.reportVersionAfter);
    expect(journal.map((r) => r.resolution)).toEqual(['accepted_as_is', 'source_added']);
  });

  it('решение перестаёт действовать после смены машины источника: отпечаток другой', async () => {
    const person = await makeDriver('Отпечат');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const submitted = await ctx.readings.submitReport(
      person,
      ctx.today,
      {
        version: opened.version,
        items: [line(itemOf(opened, route).id, odometer(900))],
        reason: '',
      },
      ctx.userId,
      null,
    );
    const late = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });

    const seen = await ctx.readings.loadReportById(submitted.id);
    const missing = seen.discrepancies.find((d) => d.kind === 'missing_source')!;
    const resolved = await ctx.readings.resolveDiscrepancy(
      seen.id,
      {
        kind: 'missing_source',
        itemId: null,
        sourceKind: missing.sourceKind,
        sourceId: missing.sourceId,
        fingerprint: missing.fingerprint,
        resolution: 'accepted_as_is',
        reason: 'выезда не было',
        version: seen.version,
      },
      ctx.userId,
    );
    expect(resolved.canAccept).toBe(true);

    // Машину рейса сменили: источник, который «решили не включать», — уже другой источник.
    const another = await makeVehicle();
    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ vehicleId: another })
      .where(eq(ctx.schema.vehicleRoutes.id, late));

    const after = await ctx.readings.loadReportById(resolved.id);
    const stale = after.discrepancies.find((d) => d.kind === 'missing_source')!;
    expect(stale.resolved).toBe(false);
    expect(stale.fingerprint).not.toBe(missing.fingerprint);
    expect(after.canAccept).toBe(false);
    const denied = await failure(ctx.readings.acceptReport(after.id, after.version, ctx.userId));
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('не разобрано расхождений');
  });
});
