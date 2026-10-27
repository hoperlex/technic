import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DRIVER_CLIENT_OUTDATED_CODE,
  DRIVER_DRAFT_FORMAT,
  moscowDateKeyOf,
  reportSubmitSchema,
  routeTimeByRequest,
  type DriverReportDto,
  type ReportSubmitBody,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the modules are imported with `await import` after the environment is set, because
// the config validates it on import.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type * as ReadingsService from '../src/services/readings';
import type * as AssignmentService from '../src/services/driver-assignment';
import type * as RoutePointsService from '../src/services/route-points';
import type * as ReadingTimesService from '../src/services/reading-times';

/**
 * Driver shift and stop times on the live schema (ADR 0234, plan
 * `docs/readings-shifts-merge-plan.md` §7, owner decisions D5, D8, D11).
 *
 * Why a database. Half of the contract is in the write path, not in the rules: an absent key keeps
 * the saved time while the rule reads the resolved value, the stop set is compared with the live
 * route under its lock and its request snapshot is taken from `vehicle_route_point_trips`, a rebuild
 * of the route sets `route_point_id` to NULL and must keep the recorded times, and the stored report
 * format decides which rules apply — after the idempotency lookup, so a pre-release retry still
 * replays. The pure rules have their own tests (`reading-times-contracts.test.ts`).
 *
 * Run (the test applies migrations itself):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_test \
 *     npx vitest run test/reading-times.db.test.ts
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like every `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Unique run suffix: the base is shared and survives runs, and directory codes are unique. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const ADMIN_EMAIL = `db-reading-times-${RUN}@example.invalid`;
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: время смены и остановок';
/** Own waybill series: numbers are unique per series, and a shared one would race the neighbours. */
const SERIES_CODE = `zz_reading_times_${RUN}`;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  readings: typeof ReadingsService;
  assignment: typeof AssignmentService;
  placeRequestTrips: (typeof RoutePointsService)['placeRequestTrips'];
  readingTimes: typeof ReadingTimesService;
  userId: string;
  objectId: string;
  vehicleTypeId: string;
  modelId: string;
  organizationId: string;
  seriesId: string;
  today: string;
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

/** A valid SNILS is generated: the shared base holds live cards, and the format has a CHECK. */
function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
}

/** One person per scenario: a report belongs to "person + day" and cannot be shared. */
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

/** One vehicle per scenario: the counter chain is per vehicle. */
async function makeVehicle(): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'own',
      vehicleTypeId: ctx.vehicleTypeId,
      vehicleModelId: ctx.modelId,
      registrationNumber: `Т${randomUUID().slice(0, 6).toUpperCase()}ВР${created.vehicleIds.length}77`,
      status: 'active',
    })
    .returning({ id: ctx.schema.vehicles.id });
  created.vehicleIds.push(vehicle!.id);
  return vehicle!.id;
}

/** A special-equipment request: the base of a relocation and the source of an ESM-2. */
async function makeSpecialRequest(): Promise<string> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      createdBy: ctx.userId,
      comment: PERSON_MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  created.requestIds.push(request!.id);
  return request!.id;
}

/** A freight request with its trips; addresses live on trips (route trips plan, Р2). */
async function makeFreightRequest(trips: { from: string; to: string }[]): Promise<string> {
  const { schema } = ctx;
  const [request] = await ctx.db
    .insert(schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      status: 'confirmed',
      createdBy: ctx.userId,
      comment: PERSON_MARK,
    })
    .returning({ id: schema.vehicleRequests.id });
  created.requestIds.push(request!.id);
  await ctx.db.insert(schema.freightTransportRequestDetails).values({
    requestId: request!.id,
    scheduledAt: new Date(`${ctx.today}T05:30:00Z`),
  });
  await ctx.db.insert(schema.vehicleRequestTrips).values(
    trips.map((trip, index) => ({
      requestId: request!.id,
      num: index + 1,
      fromLocation: trip.from,
      toLocation: trip.to,
      volumeM3: '10.000',
    })),
  );
  return request!.id;
}

/** A 4-П for a route: the cabinet is documentary, a route without a waybill is not in the task. */
async function issue4p(routeId: string, vehicleId: string, personId: string): Promise<void> {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: waybillNo,
      formCode: '4p',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId,
      driverPersonId: personId,
      issuedForDate: ctx.today,
      routeId,
      issuedBy: ctx.userId,
    })
    .returning({ id: ctx.schema.waybills.id });
  created.waybillIds.push(waybill!.id);
}

/**
 * A freight route laid out in stops by the same algorithm the working doors call
 * (`placeRequestTrips`): equal addresses with equal contacts share one point (Р8).
 */
async function makeStopRoute(opts: {
  vehicleId: string;
  personId: string;
  requestIds: string[];
}): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId: opts.vehicleId,
      routeDate: ctx.today,
      purpose: 'freight',
      driverPersonId: opts.personId,
      createdBy: ctx.userId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  created.routeIds.push(route!.id);
  await ctx.db.insert(ctx.schema.vehicleRouteRequests).values(
    opts.requestIds.map((requestId, index) => ({
      routeId: route!.id,
      requestId,
      position: index + 1,
    })),
  );
  for (const requestId of opts.requestIds) {
    await ctx.placeRequestTrips(ctx.db as never, route!.id, requestId);
  }
  await issue4p(route!.id, opts.vehicleId, opts.personId);
  return route!.id;
}

/** A relocation: no stops by construction, only "from / to" (D8). */
async function makeRelocation(vehicleId: string, personId: string): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId,
      routeDate: ctx.today,
      purpose: 'delivery',
      sourceRequestId: await makeSpecialRequest(),
      moveFrom: 'База',
      moveTo: 'Объект',
      driverPersonId: personId,
      createdBy: ctx.userId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  created.routeIds.push(route!.id);
  await issue4p(route!.id, vehicleId, personId);
  return route!.id;
}

/**
 * A one-day ESM-2: the week CHECK holds, and the day is covered.
 *
 * ЭСМ2-РАЗРЕЗ: the sheet is a one-day segment, the shape the read switch produces; its bounds only
 * give the day an ESM-2 source and go into no assertion.
 */
async function makeEsm2(vehicleId: string, personId: string): Promise<void> {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: waybillNo,
      formCode: 'esm2',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId,
      driverPersonId: personId,
      issuedForDate: ctx.today,
      sourceRequestId: await makeSpecialRequest(),
      periodFrom: ctx.today,
      periodTo: ctx.today,
      issuedBy: ctx.userId,
    })
    .returning({ id: ctx.schema.waybills.id });
  created.waybillIds.push(waybill!.id);
}

type Line = ReportSubmitBody['items'][number];

function line(itemId: string, reading: Record<string, unknown>): Line {
  return { itemId, reading: { kind: 'values', ...reading } as Line['reading'] };
}

/**
 * A submit as the route sends it: the body goes through the wire schema first, so defaults and
 * absent keys are exactly what the service receives in production.
 */
function submit(
  personId: string,
  version: number,
  items: Line[],
  opts: {
    mode?: 'driver' | 'staff';
    reason?: string;
    key?: string;
    clientDraftFormat?: string | null;
  } = {},
): Promise<DriverReportDto> {
  const body = reportSubmitSchema.parse({ version, items, reason: opts.reason ?? '' });
  return ctx.readings.submitReport(personId, ctx.today, body, ctx.userId, opts.key ?? null, {
    mode: opts.mode,
    reason: opts.reason,
    clientDraftFormat: opts.clientDraftFormat,
  });
}

async function failure(
  promise: Promise<unknown>,
): Promise<{ statusCode: number; message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode: number; message: string; code?: string };
  }
  throw new Error('a refusal was expected, but the operation went through');
}

/** The cabinet's stop list for a route: the live stops by the same rule the task uses. */
async function stopsOf(routeId: string) {
  return ctx.assignment.loadReadingStops(ctx.db, routeId);
}

/** Stops on the wire: `[arrival, departure]` per stop, in the order of the given ids. */
function wirePoints(ids: (string | null)[], times: [string | null, string | null][]) {
  return ids.map((routePointId, index) => ({
    position: index + 1,
    routePointId,
    arrivedAt: index === 0 ? times[index]![0] : null,
    departedAt: times[index]![1],
  }));
}

async function snapshotOf(readingId: string): Promise<[number, string][]> {
  const rows = await ctx.db
    .select()
    .from(ctx.schema.vehicleReadingPointRequests)
    .where(eq(ctx.schema.vehicleReadingPointRequests.readingId, readingId))
    .orderBy(
      asc(ctx.schema.vehicleReadingPointRequests.position),
      asc(ctx.schema.vehicleReadingPointRequests.requestId),
    );
  return rows.map((row) => [row.position, row.requestId]);
}

/** Simulates a report opened by old code during the migration window: the column default. */
async function markLegacy(reportId: string): Promise<void> {
  await ctx.db
    .update(ctx.schema.driverDailyReports)
    .set({ draftFormat: 'v2' })
    .where(eq(ctx.schema.driverDailyReports.id, reportId));
}

describe.skipIf(!DB_URL)('время смены и остановок (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const readings = await import('../src/services/readings');
    const assignment = await import('../src/services/driver-assignment');
    const routePoints = await import('../src/services/route-points');
    const readingTimes = await import('../src/services/reading-times');

    const [user] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Диспетчер',
        middleName: 'Временной',
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        // «яя» keeps the object away from tests that take the first one `ORDER BY … LIMIT 1`.
        code: `яя-reading-times-${RUN}`,
        name: `Тестовая площадка (время смены) ${RUN}`,
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
    if (!vehicleTypeId) throw new Error('no freight vehicle type: the seed is not applied');

    const [model] = await db
      .insert(schema.vehicleModels)
      .values({ vehicleTypeId, name: `Тестовый самосвал (время) ${RUN}` })
      .returning({ id: schema.vehicleModels.id });

    const orgRes = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
    );
    const organizationId = orgRes.rows[0]?.id;
    if (!organizationId) throw new Error('no organization: the seed is not applied');

    const [series] = await db
      .insert(schema.waybillSeries)
      .values({ code: SERIES_CODE, name: `Тестовая серия (время) ${RUN}`, prefix: 'ВРМ-' })
      .returning({ id: schema.waybillSeries.id });

    ctx = {
      db,
      closeDb,
      schema,
      readings,
      assignment,
      placeRequestTrips: routePoints.placeRequestTrips,
      readingTimes,
      userId: user!.id,
      objectId: object!.id,
      vehicleTypeId,
      modelId: model!.id,
      organizationId,
      seriesId: series!.id,
      today: moscowDateKeyOf(new Date()),
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { schema, db } = ctx;
    // By references: a report takes its items, readings, stops and histories with it; a route and
    // a waybill hold items RESTRICT, and the route composition holds requests.
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

  // ── D11: the driver's rule, derived from the evening values ──

  it('ЭСМ-2: водитель v3 передаёт начало всегда, конец — вместе с вечерними числами', async () => {
    const person = await makeDriver('Сменов');
    const vehicle = await makeVehicle();
    await makeEsm2(vehicle, person);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    expect(opened.draftFormat).toBe(DRIVER_DRAFT_FORMAT);
    const itemId = opened.items[0]!.id;

    const noStart = await failure(
      submit(person, opened.version, [line(itemId, { odometerKm: 1000 })]),
    );
    expect(noStart.statusCode).toBe(400);
    expect(noStart.message).toContain('начала смены');

    // A morning interim reading: the start and the fuel in the tank, nothing of the evening.
    const morning = await submit(person, opened.version, [
      line(itemId, { fuelStartLiters: 50, startedAt: '07:30' }),
    ]);
    expect(morning.items[0]!.reading).toMatchObject({
      startedAt: '07:30',
      endedAt: null,
      fuelStartLiters: 50,
    });

    // The evening sends the counter without the start key: the saved start is kept and read.
    const noEnd = await failure(
      submit(person, morning.version, [line(itemId, { odometerKm: 1000 })]),
    );
    expect(noEnd.statusCode).toBe(400);
    expect(noEnd.message).toContain('окончания');

    const equal = await failure(
      submit(person, morning.version, [line(itemId, { odometerKm: 1000, endedAt: '07:30' })]),
    );
    expect(equal.message).toContain('совпадают');

    // Past midnight is the next day, by the one reading of a pair (`shiftSpanMinutes`).
    const evening = await submit(person, morning.version, [
      line(itemId, { odometerKm: 1000, endedAt: '01:15' }),
    ]);
    expect(evening.items[0]!.reading).toMatchObject({
      startedAt: '07:30',
      endedAt: '01:15',
      fuelStartLiters: 50,
      odometerKm: 1000,
      points: [],
    });

    // Staff closing the shift as `no_data` take the times with the numbers.
    const closed = await submit(
      person,
      evening.version,
      [{ itemId, reading: { kind: 'no_data', noDataReason: 'счётчик неисправен' } }],
      { mode: 'staff', reason: 'прибор сломан' },
    );
    expect(closed.items[0]!.reading).toMatchObject({ startedAt: null, endedAt: null, points: [] });
  });

  it('персонал вносит за водителя без времени: обязательность — правило водителя', async () => {
    const person = await makeDriver('Безвременов');
    const vehicle = await makeVehicle();
    await makeEsm2(vehicle, person);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId, { mode: 'staff' });
    const sent = await submit(
      person,
      opened.version,
      [line(opened.items[0]!.id, { odometerKm: 2000 })],
      { mode: 'staff' },
    );
    expect(sent.items[0]!.reading).toMatchObject({ odometerKm: 2000, startedAt: null });
  });

  /**
   * The cabinet sends back every block that has a reading. A staff entry without times (D5) resent
   * as saved is not the driver's word and must not hold his day; the same line changed by him is.
   */
  it('строка персонала без времени, присланная водителем без правки, день не держит', async () => {
    const person = await makeDriver('Смешанов');
    const staffVehicle = await makeVehicle();
    const ownVehicle = await makeVehicle();
    await makeEsm2(staffVehicle, person);
    await makeEsm2(ownVehicle, person);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId, { mode: 'staff' });
    expect(opened.draftFormat).toBe(DRIVER_DRAFT_FORMAT);
    const staffItem = opened.items.find((item) => item.vehicleId === staffVehicle)!;
    const ownItem = opened.items.find((item) => item.vehicleId === ownVehicle)!;

    const entered = await submit(
      person,
      opened.version,
      [line(staffItem.id, { odometerKm: 2000, engineHours: 310.5 })],
      { mode: 'staff' },
    );
    const staffReading = entered.items.find((item) => item.id === staffItem.id)!.reading!;
    expect(staffReading).toMatchObject({ startedAt: null, endedAt: null });

    // The staff line exactly as the cabinet sends it back: every key explicit, times empty.
    const asSaved = line(staffItem.id, {
      odometerKm: 2000,
      engineHours: 310.5,
      fuelStartLiters: null,
      fuelFilledLiters: null,
      fuelEndLiters: null,
      startedAt: null,
      endedAt: null,
      comment: '',
    });
    const sent = await submit(person, entered.version, [
      asSaved,
      line(ownItem.id, { odometerKm: 5000, startedAt: '08:00', endedAt: '17:00' }),
    ]);
    expect(sent.items.find((item) => item.id === staffItem.id)!.reading).toMatchObject({
      id: staffReading.id,
      source: 'staff',
      startedAt: null,
    });
    expect(sent.items.find((item) => item.id === ownItem.id)!.reading).toMatchObject({
      odometerKm: 5000,
      startedAt: '08:00',
      endedAt: '17:00',
    });

    // Changed by the driver, the line is his: the evening value brings both times with it.
    const edited = await failure(
      submit(person, sent.version, [
        line(staffItem.id, { odometerKm: 2001, startedAt: null, endedAt: null }),
      ]),
    );
    expect(edited.statusCode).toBe(400);
    expect(edited.message).toContain('начала смены');
  });

  it('рейс с остановками: прибытие на первую — всегда, отправления — с вечерними числами', async () => {
    const person = await makeDriver('Рейсов');
    const vehicle = await makeVehicle();
    const request = await makeFreightRequest([
      { from: 'г Москва, ул Карьерная, д 1', to: 'г Москва, ул Стройки, д 2' },
    ]);
    const route = await makeStopRoute({
      vehicleId: vehicle,
      personId: person,
      requestIds: [request],
    });
    const stops = await stopsOf(route);
    expect(stops).toHaveLength(2);
    const ids = stops.map((stop) => stop.routePointId);

    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const itemId = opened.items[0]!.id;

    const noArrival = await failure(
      submit(person, opened.version, [line(itemId, { fuelStartLiters: 40 })]),
    );
    expect(noArrival.message).toContain('прибытия на первую точку');

    const morning = await submit(person, opened.version, [
      line(itemId, {
        fuelStartLiters: 40,
        points: wirePoints(ids, [
          ['08:00', null],
          [null, null],
        ]),
      }),
    ]);
    const interim = morning.items[0]!.reading!;
    expect(interim.startedAt).toBe('08:00');
    expect(interim.endedAt).toBeNull();
    expect(interim.points.map((p) => [p.position, p.routePointId, p.location])).toEqual([
      [1, ids[0], 'г Москва, ул Карьерная, д 1'],
      [2, ids[1], 'г Москва, ул Стройки, д 2'],
    ]);
    // The request snapshot is taken at the first capture, one row per distinct request per stop.
    expect(await snapshotOf(interim.id)).toEqual([
      [1, request],
      [2, request],
    ]);

    const missingDeparture = await failure(
      submit(person, morning.version, [
        line(itemId, {
          odometerKm: 500,
          points: wirePoints(ids, [
            ['08:00', '09:00'],
            [null, null],
          ]),
        }),
      ]),
    );
    expect(missingDeparture.message).toContain('отправления с точки 2');

    // A route's pair is derived from its stops; a typed pair that disagrees is refused.
    const typed = await failure(
      submit(person, morning.version, [line(itemId, { odometerKm: 500, startedAt: '07:00' })]),
    );
    expect(typed.statusCode).toBe(400);
    expect(typed.message).toContain('по остановкам');

    const evening = await submit(person, morning.version, [
      line(itemId, {
        odometerKm: 500,
        points: wirePoints(ids, [
          ['08:00', '09:00'],
          [null, '10:30'],
        ]),
      }),
    ]);
    expect(evening.items[0]!.reading).toMatchObject({ startedAt: '08:00', endedAt: '10:30' });
    const row = await ctx.db
      .select()
      .from(ctx.schema.vehicleReadings)
      .where(eq(ctx.schema.vehicleReadings.id, interim.id));
    expect(row[0]).toMatchObject({ startedAt: '08:00:00', endedAt: '10:30:00' });

    // The garage readers carry the same times: the vehicle journal and the intake registry rows
    // (which also feed the readings book).
    const { loadVehicleReadingJournal } = await import('../src/services/readings-stats');
    const journal = await loadVehicleReadingJournal(vehicle, {
      from: ctx.today,
      to: ctx.today,
      page: 1,
      pageSize: 25,
    });
    expect(journal!.items[0]!.draftFormat).toBe('v3');
    expect(journal!.items[0]!.reading).toMatchObject({
      startedAt: '08:00',
      endedAt: '10:30',
      points: evening.items[0]!.reading!.points,
    });
    const { loadIntakeRows } = await import('../src/services/readings-intake');
    const intake = (await loadIntakeRows(ctx.today, ctx.today)).find(
      (candidate) => candidate.item_id === itemId,
    );
    expect(intake).toMatchObject({
      started_at: '08:00',
      ended_at: '10:30',
      reading_points: evening.items[0]!.reading!.points,
    });
  });

  it('через полночь рейс переходит один раз; второй переход — отказ', async () => {
    const person = await makeDriver('Ночной');
    const vehicle = await makeVehicle();
    const request = await makeFreightRequest([
      { from: 'г Москва, ул Ночная, д 1', to: 'г Москва, ул Утренняя, д 2' },
    ]);
    const route = await makeStopRoute({
      vehicleId: vehicle,
      personId: person,
      requestIds: [request],
    });
    const ids = (await stopsOf(route)).map((stop) => stop.routePointId);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const itemId = opened.items[0]!.id;

    const twice = await failure(
      submit(person, opened.version, [
        line(itemId, {
          odometerKm: 700,
          // 22:00 → 01:00 wraps once; 01:00 → 00:30 would wrap a second time.
          points: wirePoints(ids, [
            ['22:00', '01:00'],
            [null, '00:30'],
          ]),
        }),
      ]),
    );
    expect(twice.message).toContain('через полночь');

    const once = await submit(person, opened.version, [
      line(itemId, {
        odometerKm: 700,
        points: wirePoints(ids, [
          ['22:00', '23:30'],
          [null, '00:45'],
        ]),
      }),
    ]);
    expect(once.items[0]!.reading).toMatchObject({ startedAt: '22:00', endedAt: '00:45' });
  });

  it('перегон времени не записывает: без остановок требовать нечего, остановки — отказ (D8)', async () => {
    const person = await makeDriver('Перегонов');
    const vehicle = await makeVehicle();
    const route = await makeRelocation(vehicle, person);
    expect(await stopsOf(route)).toEqual([]);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const itemId = opened.items[0]!.id;

    const extra = await failure(
      submit(person, opened.version, [
        line(itemId, { odometerKm: 10, points: wirePoints([randomUUID()], [['08:00', '09:00']]) }),
      ]),
    );
    expect(extra.statusCode).toBe(409);
    const typed = await failure(
      submit(person, opened.version, [line(itemId, { odometerKm: 10, startedAt: '08:00' })]),
    );
    expect(typed.statusCode).toBe(400);

    const sent = await submit(person, opened.version, [line(itemId, { odometerKm: 10 })]);
    expect(sent.items[0]!.reading).toMatchObject({ startedAt: null, endedAt: null, points: [] });
  });

  // ── The draft format gate ──

  it('отчёт v2 после выката сдаётся по старым правилам, а повтор тела старой сборки отвечается', async () => {
    const person = await makeDriver('Прежнев');
    const vehicle = await makeVehicle();
    await makeEsm2(vehicle, person);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    await markLegacy(opened.id);
    const itemId = opened.items[0]!.id;
    const key = randomUUID();
    // The body a pre-release build sends: no time keys at all, no format header.
    const body = {
      version: opened.version,
      items: [{ itemId, reading: { kind: 'values', odometerKm: 1000 } }],
    };

    const sent = await ctx.readings.submitReport(
      person,
      ctx.today,
      reportSubmitSchema.parse(body),
      ctx.userId,
      key,
      { clientDraftFormat: null },
    );
    // Finished without times: a `v2` report keeps the rules it was opened with.
    expect(sent.draftFormat).toBe('v2');
    expect(sent.items[0]!.reading).toMatchObject({ odometerKm: 1000, startedAt: null });

    /*
     * The fingerprint the pre-release server stored for this very body. Its schema had no time
     * keys, so its parsed body is written here by hand with sorted keys, exactly as `canonical`
     * serialises it. Equality proves that the new optional keys left no trace in the parse.
     */
    const preRelease = {
      items: [
        {
          confirmEngineHoursAnomaly: false,
          confirmOdometerAnomaly: false,
          fileIds: [],
          itemId,
          reading: {
            comment: '',
            engineHours: null,
            fuelFilledLiters: null,
            kind: 'values',
            odometerKm: 1000,
          },
        },
      ],
      reason: '',
      version: opened.version,
    };
    const [head] = await ctx.db
      .select()
      .from(ctx.schema.driverDailyReports)
      .where(eq(ctx.schema.driverDailyReports.id, opened.id));
    expect(head!.submitFingerprint).toBe(
      `v1:${createHash('sha256').update(JSON.stringify(preRelease)).digest('hex')}`,
    );

    // A lost response retried with the stale version replays instead of failing.
    const replay = await ctx.readings.submitReport(
      person,
      ctx.today,
      reportSubmitSchema.parse(body),
      ctx.userId,
      key,
      { clientDraftFormat: null },
    );
    expect(replay.version).toBe(sent.version);

    // The new build may finish a `v2` report too, still under the old rules.
    const later = await submit(person, sent.version, [line(itemId, { odometerKm: 1010 })], {
      clientDraftFormat: DRIVER_DRAFT_FORMAT,
    });
    expect(later.items[0]!.reading!.odometerKm).toBe(1010);
  });

  it('в отчёт v3 старая сборка не пишет, но её повтор принятой отправки отвечается', async () => {
    const person = await makeDriver('Новиков');
    const vehicle = await makeVehicle();
    await makeEsm2(vehicle, person);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const itemId = opened.items[0]!.id;
    const key = randomUUID();
    const items = [line(itemId, { odometerKm: 300, startedAt: '08:00', endedAt: '17:00' })];

    const sent = await submit(person, opened.version, items, {
      key,
      clientDraftFormat: DRIVER_DRAFT_FORMAT,
    });
    // The idempotency lookup comes first: the same key and body replay whatever the header says.
    const replay = await submit(person, opened.version, items, { key, clientDraftFormat: null });
    expect(replay.version).toBe(sent.version);

    const outdated = await failure(
      submit(person, sent.version, [line(itemId, { odometerKm: 310 })], {
        key: randomUUID(),
        clientDraftFormat: null,
      }),
    );
    expect(outdated.statusCode).toBe(409);
    expect(outdated.code).toBe(DRIVER_CLIENT_OUTDATED_CODE);
  });

  it('открытие v3 переводит нетронутый черновик v2 и сдвигает версию; сданный не трогает', async () => {
    const person = await makeDriver('Переводов');
    const vehicle = await makeVehicle();
    await makeEsm2(vehicle, person);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    await markLegacy(opened.id);

    // Staff have no draft format to declare: their open leaves the format alone.
    const byStaff = await ctx.readings.openReport(person, ctx.today, ctx.userId, { mode: 'staff' });
    expect(byStaff.draftFormat).toBe('v2');
    expect(byStaff.version).toBe(opened.version);

    // The legacy build may reopen its own `v2` draft and leaves it `v2`.
    const byLegacy = await ctx.readings.openReport(person, ctx.today, ctx.userId, {
      clientDraftFormat: 'v2',
    });
    expect(byLegacy.draftFormat).toBe('v2');
    expect(byLegacy.version).toBe(opened.version);

    const upgraded = await ctx.readings.openReport(person, ctx.today, ctx.userId, {
      clientDraftFormat: DRIVER_DRAFT_FORMAT,
    });
    expect(upgraded.draftFormat).toBe('v3');
    // An old tab holding the `v2` draft gets a conflict instead of writing under unknown rules.
    expect(upgraded.version).toBe(opened.version + 1);

    // A submitted `v2` report is not upgraded: what was recorded keeps its rules.
    const other = await makeDriver('Сданов');
    const otherVehicle = await makeVehicle();
    await makeEsm2(otherVehicle, other);
    const draft = await ctx.readings.openReport(other, ctx.today, ctx.userId);
    await markLegacy(draft.id);
    const sent = await submit(other, draft.version, [line(draft.items[0]!.id, { odometerKm: 5 })]);
    expect(sent.state).toBe('submitted');
    const reopened = await ctx.readings.openReport(other, ctx.today, ctx.userId);
    expect(reopened.draftFormat).toBe('v2');
    expect(reopened.version).toBe(sent.version);

    // Once a report is `v3`, the legacy build is refused; and it never starts a new report.
    const refused = await failure(
      ctx.readings.openReport(person, ctx.today, ctx.userId, { clientDraftFormat: 'v2' }),
    );
    expect(refused.code).toBe(DRIVER_CLIENT_OUTDATED_CODE);
    const fresh = await makeDriver('Свежев');
    await makeEsm2(await makeVehicle(), fresh);
    const notStarted = await failure(
      ctx.readings.openReport(fresh, ctx.today, ctx.userId, { clientDraftFormat: 'v2' }),
    );
    expect(notStarted.code).toBe(DRIVER_CLIENT_OUTDATED_CODE);
    expect(await ctx.readings.loadReport(fresh, ctx.today)).toBeNull();
  });

  // ── Times are content ──

  it('правка одного времени после приёма уводит отчёт на повторный приём', async () => {
    const person = await makeDriver('Приёмов');
    const vehicle = await makeVehicle();
    await makeEsm2(vehicle, person);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const itemId = opened.items[0]!.id;
    const sent = await submit(person, opened.version, [
      line(itemId, { odometerKm: 800, startedAt: '08:00', endedAt: '18:00' }),
    ]);
    const accepted = await ctx.readings.acceptReport(sent.id, sent.version, ctx.userId);
    expect(accepted.state).toBe('accepted');

    // The same body is no change at all: nothing reopens.
    const same = await submit(
      person,
      accepted.version,
      [line(itemId, { odometerKm: 800, startedAt: '08:00', endedAt: '18:00' })],
      { mode: 'staff', reason: 'сверка' },
    );
    expect(same.state).toBe('accepted');

    const edited = await submit(
      person,
      same.version,
      [line(itemId, { odometerKm: 800, endedAt: '19:00' })],
      { mode: 'staff', reason: 'водитель ошибся с окончанием' },
    );
    expect(edited.state).toBe('needs_reacceptance');
    expect(edited.contentVersion).toBe(accepted.contentVersion + 1);

    const reading = edited.items[0]!.reading!;
    const history = await ctx.db
      .select()
      .from(ctx.schema.vehicleReadingHistory)
      .where(eq(ctx.schema.vehicleReadingHistory.readingId, reading.id))
      .orderBy(asc(ctx.schema.vehicleReadingHistory.version));
    const last = history.at(-1)!;
    expect(last.event).toBe('updated');
    expect(last.reason).toBe('водитель ошибся с окончанием');
    expect(last.before).toMatchObject({ endedAt: '18:00', startedAt: '08:00' });
    expect(last.after).toMatchObject({ endedAt: '19:00', startedAt: '08:00' });
  });

  // ── Request attribution (D6) and the rebuild ──

  it('две ездки одной заявки на точке — одна доля, и время рейса делится по заявкам без остатка', async () => {
    const person = await makeDriver('Долев');
    const vehicle = await makeVehicle();
    const quarry = 'г Москва, ул Карьерная, д 7';
    // Two trips of one request load at the same quarry; a second request loads there too.
    const first = await makeFreightRequest([
      { from: quarry, to: 'г Москва, ул Первая, д 1' },
      { from: quarry, to: 'г Москва, ул Вторая, д 2' },
    ]);
    const second = await makeFreightRequest([{ from: quarry, to: 'г Москва, ул Третья, д 3' }]);
    const route = await makeStopRoute({
      vehicleId: vehicle,
      personId: person,
      requestIds: [first, second],
    });
    const stops = await stopsOf(route);
    expect(stops.map((stop) => stop.location)).toEqual([
      quarry,
      'г Москва, ул Первая, д 1',
      'г Москва, ул Вторая, д 2',
      'г Москва, ул Третья, д 3',
    ]);

    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const sent = await submit(person, opened.version, [
      line(opened.items[0]!.id, {
        odometerKm: 900,
        points: wirePoints(
          stops.map((stop) => stop.routePointId),
          [
            ['08:00', '08:07'],
            [null, '09:00'],
            [null, '10:00'],
            [null, '11:00'],
          ],
        ),
      }),
    ]);
    const reading = sent.items[0]!.reading!;
    const sorted = [first, second].sort();
    // The quarry carries both requests once each, not the first one twice.
    expect(await snapshotOf(reading.id)).toEqual([
      [1, sorted[0]],
      [1, sorted[1]],
      [2, first],
      [3, first],
      [4, second],
    ]);

    // The split reads the saved snapshot, and the shares add up to the shift exactly.
    const saved = (await ctx.readingTimes.loadReadingPoints(ctx.db, [reading.id])).get(reading.id)!;
    const allocation = routeTimeByRequest(
      saved,
      new Map(saved.map((point) => [point.position, point.requestIds])),
    );
    expect(allocation).toEqual({
      ok: true,
      totalSeconds: 3 * 3600,
      byRequest: { [first]: 210 + 53 * 60 + 3600, [second]: 210 + 3600 },
    });
  });

  it('перестройка маршрута оставляет записанное время и атрибуцию, персонал правит по сохранённым точкам', async () => {
    const person = await makeDriver('Перестроев');
    const vehicle = await makeVehicle();
    const request = await makeFreightRequest([
      { from: 'г Москва, ул Старая, д 1', to: 'г Москва, ул Прежняя, д 2' },
    ]);
    const route = await makeStopRoute({
      vehicleId: vehicle,
      personId: person,
      requestIds: [request],
    });
    const ids = (await stopsOf(route)).map((stop) => stop.routePointId);
    const opened = await ctx.readings.openReport(person, ctx.today, ctx.userId);
    const itemId = opened.items[0]!.id;
    const sent = await submit(person, opened.version, [
      line(itemId, {
        odometerKm: 400,
        points: wirePoints(ids, [
          ['08:00', '09:00'],
          [null, '10:00'],
        ]),
      }),
    ]);
    const readingId = sent.items[0]!.reading!.id;

    // The rebuild: a cancelled waybill reassembles the route, and the old points go with cascade.
    await ctx.db
      .delete(ctx.schema.vehicleRoutePoints)
      .where(eq(ctx.schema.vehicleRoutePoints.routeId, route));
    await ctx.placeRequestTrips(ctx.db as never, route, request);
    const rebuilt = await stopsOf(route);
    expect(rebuilt.map((stop) => stop.routePointId)).not.toEqual(ids);

    const kept = await ctx.readings.loadReport(person, ctx.today);
    const keptReading = kept!.items[0]!.reading!;
    expect(keptReading.points).toEqual([
      {
        position: 1,
        routePointId: null,
        location: 'г Москва, ул Старая, д 1',
        arrivedAt: '08:00',
        departedAt: '09:00',
      },
      {
        position: 2,
        routePointId: null,
        location: 'г Москва, ул Прежняя, д 2',
        arrivedAt: null,
        departedAt: '10:00',
      },
    ]);
    expect(await snapshotOf(readingId)).toEqual([
      [1, request],
      [2, request],
    ]);

    // Staff correct a time against the saved stops: the deleted ids are not required.
    const corrected = await submit(
      person,
      kept!.version,
      [
        line(itemId, {
          odometerKm: 400,
          points: wirePoints(
            [null, null],
            [
              ['08:00', '09:15'],
              [null, '10:00'],
            ],
          ),
        }),
      ],
      { mode: 'staff', reason: 'отметка с весовой' },
    );
    expect(corrected.items[0]!.reading!.points[0]!.departedAt).toBe('09:15');
    expect(await snapshotOf(readingId)).toEqual([
      [1, request],
      [2, request],
    ]);

    // A different stop set is not a correction: it is refused, not silently re-attributed.
    const reshaped = await failure(
      submit(
        person,
        corrected.version,
        [line(itemId, { odometerKm: 400, points: wirePoints([null], [['08:00', '10:00']]) })],
        { mode: 'staff', reason: 'одна точка' },
      ),
    );
    expect(reshaped.statusCode).toBe(409);

    // Moving the reading onto the new plan is explicit: clear the stops, then capture anew.
    const cleared = await submit(
      person,
      corrected.version,
      [line(itemId, { odometerKm: 400, points: null })],
      { mode: 'staff', reason: 'маршрут пересобран' },
    );
    expect(cleared.items[0]!.reading).toMatchObject({ points: [], startedAt: null, endedAt: null });
    const recaptured = await submit(
      person,
      cleared.version,
      [
        line(itemId, {
          odometerKm: 400,
          points: wirePoints(
            rebuilt.map((stop) => stop.routePointId),
            [
              ['08:00', '09:15'],
              [null, '10:00'],
            ],
          ),
        }),
      ],
      { mode: 'staff', reason: 'маршрут пересобран' },
    );
    expect(recaptured.items[0]!.reading!.points.map((p) => p.routePointId)).toEqual(
      rebuilt.map((stop) => stop.routePointId),
    );
  });
});
