import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
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
 * Приведение снимка к источнику — операция переноса строки ожидания (ADR 0103, план Р21а).
 *
 * Зачем база. Перенос — это тупик, у которого выход держится схемой: глобальный `UNIQUE (route_id)`
 * не даёт завести вторую строку по тому же рейсу, составной ключ снимка (`ON UPDATE CASCADE`)
 * уносит показание вслед за строкой, а составной ключ «день строки равен дню отчёта» не даст
 * переехать в чужой день. Сверх того операция трогает две шапки, две машины и две цепочки
 * счётчиков сразу — проверить это на правилах невозможно: расходятся не правила, а порядок шагов и
 * база.
 *
 * Живой источник тест меняет прямым UPDATE рейса намеренно: переназначение водителя, смена машины
 * и перенос даты — законные действия чужого модуля (ADR 0082), и звать его сервис значило бы
 * тащить сюда принципала, права и окна коррекции. Предмет теста — то, как показания приводят к
 * такому источнику свой снимок.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/report-rebase.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Уникальный хвост прогона: база общая и переживает прогоны, а коды справочников уникальны. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const ADMIN_EMAIL = `db-report-rebase-${RUN}@example.invalid`;
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: приведение снимка к источнику';
/**
 * Своя серия бланков, а не общая: номер уникален внутри серии, и нумеровать листы в чужой серии
 * значило бы драться за номера с соседним db-тестом того же прогона. Префикс `zz_` — чтобы серия
 * не стала первой у тестов, берущих её `ORDER BY code LIMIT 1`.
 */
const SERIES_CODE = `zz_report_rebase_${RUN}`;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  readings: typeof ReadingsService;
  userId: string;
  objectId: string;
  vehicleTypeId: string;
  modelId: string;
  organizationId: string;
  seriesId: string;
  today: string;
  /** Вчерашний день: окно записи водителя — неделя, и перенос даты в него укладывается (Р11). */
  yesterday: string;
}

let ctx: Ctx;
let waybillNo = 0;

const created = {
  personIds: [] as string[],
  vehicleIds: [] as string[],
  routeIds: [] as string[],
  requestIds: [] as string[],
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

/** СНИЛС генерируется правилами ПФР: база общая, а номера сида заняты живыми карточками. */
function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
}

async function makeDriver(lastName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({
      lastName: `${lastName}${RUN}`,
      firstName: 'Пётр',
      middleName: 'Сергеевич',
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
      registrationNumber: `Р${randomUUID().slice(0, 6).toUpperCase()}БС${created.vehicleIds.length}77`,
      status: 'active',
    })
    .returning({ id: ctx.schema.vehicles.id });
  created.vehicleIds.push(vehicle!.id);
  return vehicle!.id;
}

/**
 * Лист 4-П по рейсу: `waybills_form_source_check` требует у него заполненный `route_id`. Выписка
 * идёт фикстурой каждого рейса, потому что кабинет строго документален (ADR 0105, Р5) — рейс без
 * действительного листа в задание не входит, и переносить у него было бы нечего.
 *
 * Лист привязан к рейсу, а не к отчёту: переназначение водителя, смена машины и перенос даты его не
 * трогают — ровно поэтому строка и переезжает, а не исчезает.
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
 * Грузовой рейс с живой заявкой и выписанным по нему листом: без заявки рейс в задание дня не
 * попадает вовсе, без листа — тоже (ADR 0105, Р5).
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
    fromLocation: 'г Москва, ул Погрузочная, д 3',
    toLocation: 'г Москва, ул Разгрузочная, д 4',
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

function odometer(km: number): ReadingInput {
  return { kind: 'values', odometerKm: km, engineHours: null, fuelFilledLiters: null, comment: '' };
}

function line(itemId: string, reading: ReadingInput): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: [],
    confirmOdometerAnomaly: false,
    confirmEngineHoursAnomaly: false,
  };
}

function itemOf(report: DriverReportDto, sourceId: string) {
  const item = report.items.find((i) => i.sourceId === sourceId);
  if (!item) throw new Error(`в отчёте нет строки по источнику ${sourceId}`);
  return item;
}

/**
 * День работника целиком: открыть, закрыть перечисленные строки и (по требованию) принять.
 * `odometer: null` оставляет строку пустой — такую переносят без показания.
 */
async function submitDay(
  personId: string,
  date: string,
  plan: readonly { routeId: string; odometer: number | null }[],
  options: { accept?: boolean } = {},
): Promise<DriverReportDto> {
  const opened = await ctx.readings.openReport(personId, date, ctx.userId);
  const items = plan
    .filter((p) => p.odometer !== null)
    .map((p) => line(itemOf(opened, p.routeId).id, odometer(p.odometer!)));
  const submitted = await ctx.readings.submitReport(
    personId,
    date,
    { version: opened.version, items, reason: '' },
    ctx.userId,
    null,
  );
  if (!options.accept) return submitted;
  return ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId);
}

/** Перенос строки: причина обязательна, версии — оптимистическая блокировка обоих отчётов. */
function rebase(
  itemId: string,
  reportVersions: Record<string, number>,
  reason = 'приводим снимок к источнику',
): Promise<DriverReportDto> {
  return ctx.readings.rebaseItem(itemId, { reason, reportVersions }, ctx.userId);
}

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

describe.skipIf(!DB_URL)('приведение снимка к источнику (живая схема)', () => {
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
        middleName: 'Переносный',
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `яя-rebase-${RUN}`,
        name: `Тестовая площадка (перенос) ${RUN}`,
        address: 'г Москва, ул Объектная, д 2',
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
      .values({ vehicleTypeId, name: `Тестовый тягач ${RUN}` })
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
        name: `Тестовая серия (перенос) ${RUN}`,
        prefix: 'ПРН-',
      })
      .returning({ id: schema.waybillSeries.id });

    const today = moscowDateKeyOf(new Date());
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
      today,
      yesterday: shiftDateKey(today, -1),
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { schema, db } = ctx;
    if (created.personIds.length > 0) {
      await db
        .delete(schema.driverDailyReports)
        .where(inArray(schema.driverDailyReports.personId, created.personIds));
    }
    // Листы сносятся перед рейсами и машинами: и тех и других лист держит `RESTRICT`'ом, и без
    // этого следующий прогон упёрся бы в него при удалении машины.
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

  // ── Переназначение водителя ──

  it('рейс переназначен: строка уезжает в отчёт нового работника, которого ещё не было', async () => {
    const from = await makeDriver('Отдаев');
    const to = await makeDriver('Принимаев');
    const moved = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const stays = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const report = await submitDay(from, ctx.today, [
      { routeId: moved, odometer: 1000 },
      { routeId: stays, odometer: 2000 },
    ]);
    expect(await ctx.readings.loadReport(to, ctx.today)).toBeNull();

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: to })
      .where(eq(ctx.schema.vehicleRoutes.id, moved));
    const target = await rebase(itemOf(report, moved).id, { [report.id]: report.version });

    // Закрытая строка молча в черновик не прячется: показание уже сдано.
    expect(target.personId).toBe(to);
    expect(target.state).toBe('submitted');
    expect(target.items.map((i) => i.sourceId)).toEqual([moved]);
    expect(target.items[0]?.reading?.odometerKm).toBe(1000);

    const source = await ctx.readings.loadReportById(report.id);
    expect(source.items.map((i) => i.sourceId)).toEqual([stays]);
    expect(source.state).toBe('submitted');
    expect(source.contentVersion).toBe(report.contentVersion + 1);
    // Снимок приведён к источнику — расхождения по водителю больше нет ни у кого.
    expect(source.discrepancies).toHaveLength(0);
    expect(target.discrepancies).toHaveLength(0);
  });

  it('рейс переназначен после приёма: исходный отчёт уходит на повторный приём', async () => {
    const from = await makeDriver('Сдалов');
    const to = await makeDriver('Забралов');
    const moved = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const stays = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const accepted = await submitDay(
      from,
      ctx.today,
      [
        { routeId: moved, odometer: 1100 },
        { routeId: stays, odometer: 2100 },
      ],
      { accept: true },
    );
    expect(accepted.state).toBe('accepted');

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: to })
      .where(eq(ctx.schema.vehicleRoutes.id, moved));
    const target = await rebase(itemOf(accepted, moved).id, { [accepted.id]: accepted.version });

    expect(target.personId).toBe(to);
    const source = await ctx.readings.loadReportById(accepted.id);
    expect(source.state).toBe('needs_reacceptance');
    // Принятая редакция сохраняется: по паре версий видно, что разошлось.
    expect(source.acceptedContentVersion).toBe(accepted.acceptedContentVersion);
    expect(source.contentVersion).toBeGreaterThan(source.acceptedContentVersion!);
  });

  // ── Смена машины: отчёт один и тот же ──

  it('сменилась одна машина: исходный и целевой отчёт совпадают, версии растут однократно', async () => {
    const person = await makeDriver('Машинов');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const report = await submitDay(person, ctx.today, [{ routeId: route, odometer: 3000 }]);
    const another = await makeVehicle();

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ vehicleId: another })
      .where(eq(ctx.schema.vehicleRoutes.id, route));
    const after = await rebase(itemOf(report, route).id, { [report.id]: report.version });

    expect(after.id).toBe(report.id);
    expect(itemOf(after, route).vehicleId).toBe(another);
    // Отчёт один: блокировка и рост версий однократны, а не по разу на «исходный» и «целевой».
    expect(after.contentVersion).toBe(report.contentVersion + 1);
    expect(after.version).toBe(report.version + 1);
    expect(after.discrepancies).toHaveLength(0);
    expect(after.state).toBe('submitted');
  });

  it('смена машины после приёма: тот же отчёт уходит на повторный приём', async () => {
    const person = await makeDriver('Перецеп');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const accepted = await submitDay(person, ctx.today, [{ routeId: route, odometer: 3100 }], {
      accept: true,
    });
    const another = await makeVehicle();

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ vehicleId: another })
      .where(eq(ctx.schema.vehicleRoutes.id, route));
    const after = await rebase(itemOf(accepted, route).id, { [accepted.id]: accepted.version });

    expect(after.id).toBe(accepted.id);
    expect(after.state).toBe('needs_reacceptance');
    expect(after.contentVersion).toBe(accepted.contentVersion + 1);
    expect(after.version).toBe(accepted.version + 1);
    expect(itemOf(after, route).vehicleId).toBe(another);
  });

  // ── Перенос даты ──

  it('рейс перенесён на другую дату: строка уезжает в отчёт того же работника за тот день', async () => {
    const person = await makeDriver('Датчиков');
    const moved = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const stays = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const report = await submitDay(person, ctx.today, [
      { routeId: moved, odometer: 4000 },
      { routeId: stays, odometer: 5000 },
    ]);

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ routeDate: ctx.yesterday })
      .where(eq(ctx.schema.vehicleRoutes.id, moved));
    const target = await rebase(itemOf(report, moved).id, { [report.id]: report.version });

    expect(target.id).not.toBe(report.id);
    expect(target.reportDate).toBe(ctx.yesterday);
    expect(target.personId).toBe(person);
    expect(target.items.map((i) => i.sourceId)).toEqual([moved]);
    // День показания уезжает вместе со строкой: копии снимка скреплены составным ключом.
    expect(target.items[0]?.reading?.odometerKm).toBe(4000);

    const source = await ctx.readings.loadReportById(report.id);
    expect(source.items.map((i) => i.sourceId)).toEqual([stays]);
    expect(source.discrepancies).toHaveLength(0);
  });

  it('перенос даты после приёма: принятый день теряет строку и требует повторного приёма', async () => {
    const person = await makeDriver('Вчерашн');
    const moved = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const stays = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const accepted = await submitDay(
      person,
      ctx.today,
      [
        { routeId: moved, odometer: 4100 },
        { routeId: stays, odometer: 5100 },
      ],
      { accept: true },
    );

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ routeDate: ctx.yesterday })
      .where(eq(ctx.schema.vehicleRoutes.id, moved));
    const target = await rebase(itemOf(accepted, moved).id, { [accepted.id]: accepted.version });

    expect(target.reportDate).toBe(ctx.yesterday);
    expect(target.state).toBe('submitted');
    const source = await ctx.readings.loadReportById(accepted.id);
    expect(source.state).toBe('needs_reacceptance');
    expect(source.items.map((i) => i.sourceId)).toEqual([stays]);
  });

  // ── Пустая строка, единственная строка, решения ──

  it('строка без показания переезжает черновиком: прятать в черновик нечего', async () => {
    const from = await makeDriver('Пустосдат');
    const to = await makeDriver('Пустоприн');
    const empty = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const closed = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const report = await submitDay(from, ctx.today, [
      { routeId: empty, odometer: null },
      { routeId: closed, odometer: 6000 },
    ]);

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: to })
      .where(eq(ctx.schema.vehicleRoutes.id, empty));
    const target = await rebase(itemOf(report, empty).id, { [report.id]: report.version });

    expect(target.personId).toBe(to);
    expect(target.state).toBe('draft');
    expect(target.items.map((i) => i.sourceId)).toEqual([empty]);
    expect(target.items[0]?.reading).toBeNull();
  });

  it('единственная строка уехала: отчёт аннулирован, приёмке не подлежит, возврат его поднимает', async () => {
    const from = await makeDriver('Одиноков');
    const to = await makeDriver('Подобрал');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const report = await submitDay(from, ctx.today, [{ routeId: route, odometer: 7000 }]);

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: to })
      .where(eq(ctx.schema.vehicleRoutes.id, route));
    const target = await rebase(itemOf(report, route).id, { [report.id]: report.version });

    const voided = await ctx.readings.loadReportById(report.id);
    expect(voided.state).toBe('voided');
    expect(voided.items).toHaveLength(0);
    expect(voided.canAccept).toBe(false);
    const denied = await failure(ctx.readings.acceptReport(voided.id, voided.version, ctx.userId));
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('аннулирован');

    // Диспетчер передумал: рейс вернулся прежнему водителю — и отчёт поднимается туда, откуда его
    // унёс перенос (принимали — на повторный приём, не принимали — в отправленные).
    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: from })
      .where(eq(ctx.schema.vehicleRoutes.id, route));
    const back = await rebase(itemOf(target, route).id, {
      [target.id]: target.version,
      [voided.id]: voided.version,
    });

    expect(back.id).toBe(report.id);
    expect(back.state).toBe('submitted');
    expect(back.items.map((i) => i.sourceId)).toEqual([route]);
    expect(back.items[0]?.reading?.odometerKm).toBe(7000);
    // Опустевший теперь отчёт получателя аннулирован в свою очередь.
    expect((await ctx.readings.loadReportById(target.id)).state).toBe('voided');
  });

  it('решение по расхождению остаётся в исходном отчёте: оно история разбора, а не свойство строки', async () => {
    const from = await makeDriver('Разбор');
    const to = await makeDriver('Получат');
    const moved = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const stays = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const report = await submitDay(from, ctx.today, [
      { routeId: moved, odometer: 8000 },
      { routeId: stays, odometer: 9000 },
    ]);

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: to })
      .where(eq(ctx.schema.vehicleRoutes.id, moved));
    const seen = await ctx.readings.loadReportById(report.id);
    const discrepancy = seen.discrepancies.find((d) => d.kind === 'driver')!;
    const resolved = await ctx.readings.resolveDiscrepancy(
      seen.id,
      {
        kind: 'driver',
        itemId: discrepancy.itemId,
        sourceKind: null,
        sourceId: null,
        fingerprint: discrepancy.fingerprint,
        resolution: 'accepted_as_is',
        reason: 'разбираемся, пока признаём допустимым',
        version: seen.version,
      },
      ctx.userId,
    );
    const movedItemId = itemOf(resolved, moved).id;

    const target = await rebase(movedItemId, { [resolved.id]: resolved.version });

    const journal = await ctx.db
      .select({
        reportId: ctx.schema.driverReportDiscrepancyResolutions.reportId,
        itemId: ctx.schema.driverReportDiscrepancyResolutions.itemId,
      })
      .from(ctx.schema.driverReportDiscrepancyResolutions)
      .where(eq(ctx.schema.driverReportDiscrepancyResolutions.itemId, movedItemId));
    // Ссылка историческая: строка уехала, а разбор остался там, где его вели.
    expect(journal).toHaveLength(1);
    expect(journal[0]?.reportId).toBe(report.id);
    expect(target.id).not.toBe(report.id);
    // В целевом отчёте у расхождения другой предмет и другой отпечаток — да и самого его нет.
    expect(target.discrepancies).toHaveLength(0);
  });

  // ── Версии обоих отчётов ──

  it('устаревшая версия исходного отчёта — отказ', async () => {
    const from = await makeDriver('Устарел');
    const to = await makeDriver('Новый');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const report = await submitDay(from, ctx.today, [{ routeId: route, odometer: 10_000 }]);

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: to })
      .where(eq(ctx.schema.vehicleRoutes.id, route));

    const denied = await failure(
      rebase(itemOf(report, route).id, { [report.id]: report.version - 1 }),
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('Отчёт изменился');
    // Откат уносит и только что созданный целевой отчёт: пустой шапки после отказа не остаётся.
    expect(await ctx.readings.loadReport(to, ctx.today)).toBeNull();
  });

  it('устаревшая версия целевого отчёта — отказ', async () => {
    const from = await makeDriver('Отдающ');
    const to = await makeDriver('Занятой');
    const moved = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: from,
      date: ctx.today,
    });
    const own = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: to,
      date: ctx.today,
    });
    const source = await submitDay(from, ctx.today, [{ routeId: moved, odometer: 11_000 }]);
    const target = await submitDay(to, ctx.today, [{ routeId: own, odometer: 12_000 }]);

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ driverPersonId: to })
      .where(eq(ctx.schema.vehicleRoutes.id, moved));

    const denied = await failure(
      rebase(itemOf(source, moved).id, {
        [source.id]: source.version,
        [target.id]: target.version - 1,
      }),
    );
    expect(denied.statusCode).toBe(409);
    expect(denied.message).toContain('Отчёт изменился');
    expect((await ctx.readings.loadReportById(source.id)).items.map((i) => i.sourceId)).toEqual([
      moved,
    ]);
  });

  // ── Цепочки счётчиков ──

  it('перестроены цепочки обеих машин: у прежней строка ушла, у новой появилась', async () => {
    const person = await makeDriver('Цепочк');
    const oldVehicle = await makeVehicle();
    const newVehicle = await makeVehicle();
    // Порядок смен назначается по номеру рейса: первый — первая смена прежней машины.
    const moved = await makeRoute({ vehicleId: oldVehicle, personId: person, date: ctx.today });
    const successor = await makeRoute({ vehicleId: oldVehicle, personId: person, date: ctx.today });
    const target = await makeRoute({ vehicleId: newVehicle, personId: person, date: ctx.today });
    const report = await submitDay(person, ctx.today, [
      { routeId: moved, odometer: 1000 },
      { routeId: successor, odometer: 1100 },
      { routeId: target, odometer: 500 },
    ]);
    expect(itemOf(report, successor).reading?.odometerDelta).toBe(100);
    expect(itemOf(report, moved).reading?.odometerDelta).toBeNull();

    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ vehicleId: newVehicle })
      .where(eq(ctx.schema.vehicleRoutes.id, moved));
    const after = await rebase(itemOf(report, moved).id, { [report.id]: report.version });

    // Прежняя машина: строка ушла, и её преемник остался началом ряда — разности больше нет.
    expect(itemOf(after, successor).reading?.odometerDelta).toBeNull();
    // Новая машина: строка встала в хвост позиций и получила предшественником её последнюю смену.
    expect(itemOf(after, moved).shiftOrder).toBe(2);
    expect(itemOf(after, moved).reading?.odometerDelta).toBe(500);
    expect(itemOf(after, moved).reading?.odometerAnomaly).toBeNull();
  });
});
