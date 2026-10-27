import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type ReadingInput,
  type ReportItemSubmit,
  type RequestRouteTimeDto,
  type VehicleRequestShiftDto,
  type VehicleRequestShiftsDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values are imported with `await import` after the environment is set — the
// config is read at import time and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';
import type * as AssignmentNs from '../src/services/driver-assignment';
import type * as RoutePointsNs from '../src/services/route-points';

/**
 * Stage 3 of the readings-shifts merge on the live schema (plan `docs/readings-shifts-merge-plan.md`
 * §8, owner decisions D6, D7, D10, D12): the driver's times reach the requests.
 *
 * - The shift time overlay: a clean unsigned driver day takes its time from the readings — an
 *   ESM-2 pair, a route item's arrival at stop 1 and departure from the last stop — when they fold
 *   into one interval; several intervals that do not fold are shown and the site types the time; a
 *   signed time stays frozen.
 * - The freight reader: the request's recorded stops and its D6 share of the route time, read from
 *   the stop and request snapshots — so a rebuild of the route and a detached request change
 *   nothing — and the reasons a share is missing.
 *
 * WHY A LIVE DATABASE. The rules are pure and tested apart (`request-driver-times-contracts.test.ts`);
 * what only the database proves is the wiring: the readings service writing the times and the
 * stop snapshot, the readers picking them up through both source branches, the doors writing the
 * driver's interval under the request lock, and who sees the diagnostics (D10).
 *
 * Run (an own database; migrations are applied by the test):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_test \
 *     npx vitest run test/request-driver-times.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-request-driver-times-password-123';
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: время водителя в заявках ${RUN}`;
/** Own waybill series: numbers are unique per series, and a shared one would race the neighbours. */
const SERIES_CODE = `zz_request_driver_times_${RUN}`;

const TODAY = moscowDateKeyOf(new Date());
const ago = (days: number): string => shiftDateKey(TODAY, -days);
const STAFF = { mode: 'staff' as const };

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  readings: typeof ReadingsNs;
  assignment: typeof AssignmentNs;
  placeRequestTrips: (typeof RoutePointsNs)['placeRequestTrips'];
  closeDb: () => Promise<void>;
  admin: Auth;
  observer: Auth;
  adminId: string;
  objectId: string;
  specialTypeId: string;
  freightTypeId: string;
  organizationId: string;
  seriesId: string;
}

let ctx: Ctx;
let waybillNo = 0;

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

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** One run's cleanup, in the reverse order of references. */
async function purge(db: typeof AppDb): Promise<void> {
  const persons = sql`(SELECT id FROM persons WHERE comment = ${MARK})`;
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM waybills WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_routes WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${MARK}`);
  await db.execute(sql`DELETE FROM vehicles WHERE note = ${MARK}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${MARK}`);
  await db.execute(sql`DELETE FROM waybill_series WHERE code = ${SERIES_CODE}`);
}

async function userWithRole(email: string, role: 'admin' | 'observer'): Promise<string> {
  const { hashPassword } = await import('../src/auth/password');
  const created = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
    VALUES (${email}, 'Тестовый', ${role === 'admin' ? 'Администратор' : 'Наблюдатель'}, '',
            ${await hashPassword(PASSWORD)}, ${role}::role, true)
    RETURNING id`);
  return created.rows[0]!.id;
}

async function login(email: string): Promise<Auth> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

function inject(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  auth: Auth = ctx.admin,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

async function expectStatus(
  res: Promise<LightMyRequestResponse>,
  code: number,
): Promise<LightMyRequestResponse> {
  const done = await res;
  expect(done.statusCode, done.body).toBe(code);
  return done;
}

// ── Scene ──

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Временов', firstName, middleName: 'Точкович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

/** An own vehicle: its description is empty and it has no prices (`vehicles_own_fields_check`). */
async function newVehicle(typeId: string = ctx.specialTypeId): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({ ownership: 'own', vehicleTypeId: typeId, status: 'active', note: MARK })
    .returning({ id: ctx.schema.vehicles.id });
  return vehicle!.id;
}

/** An on-site order in work on the vehicle, approved and assigned. */
async function newRequest(vehicleId: string, dateFrom: string, dateTo: string): Promise<string> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.specialTypeId,
      status: 'confirmed',
      approvedBy: ctx.adminId,
      approvedAt: new Date(),
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  await ctx.db
    .insert(ctx.schema.specialEquipmentRequestDetails)
    .values({ requestId: request!.id, dateFrom, dateTo });
  await ctx.db.insert(ctx.schema.vehicleRequestAssignments).values({
    requestId: request!.id,
    vehicleId,
    vehicleTypeId: ctx.specialTypeId,
    orderedVehicleTypeId: ctx.specialTypeId,
    pricePerHour: '3000',
    assignedBy: ctx.adminId,
  });
  return request!.id;
}

/** A freight request in work with its trips; addresses live on trips. */
async function newFreightRequest(trips: { from: string; to: string }[]): Promise<string> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.freightTypeId,
      status: 'confirmed',
      approvedBy: ctx.adminId,
      approvedAt: new Date(),
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  await ctx.db.insert(ctx.schema.freightTransportRequestDetails).values({
    requestId: request!.id,
    scheduledAt: new Date(`${TODAY}T05:30:00Z`),
  });
  await ctx.db.insert(ctx.schema.vehicleRequestTrips).values(
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

/**
 * A one-day weekly ESM-2 of the request.
 *
 * ЭСМ2-РАЗРЕЗ: the sheet is a one-day segment, the shape the read switch produces. Its bounds only
 * give the day an ESM-2 source of the request; no assertion reads the period as a week.
 */
async function issueEsm2(
  requestId: string,
  vehicleId: string,
  personId: string,
  date: string,
): Promise<void> {
  waybillNo += 1;
  await ctx.db.insert(ctx.schema.waybills).values({
    seriesId: ctx.seriesId,
    number: waybillNo,
    formCode: 'esm2',
    status: 'issued',
    organizationId: ctx.organizationId,
    vehicleId,
    driverPersonId: personId,
    issuedForDate: date,
    sourceRequestId: requestId,
    periodFrom: date,
    periodTo: date,
    issuedBy: ctx.adminId,
  });
}

/** A 4-П for a route: the report lists only routes with an issued waybill. */
async function issue4p(routeId: string, vehicleId: string, personId: string, date: string) {
  waybillNo += 1;
  await ctx.db.insert(ctx.schema.waybills).values({
    seriesId: ctx.seriesId,
    number: waybillNo,
    formCode: '4p',
    status: 'issued',
    organizationId: ctx.organizationId,
    vehicleId,
    driverPersonId: personId,
    issuedForDate: date,
    routeId,
    issuedBy: ctx.adminId,
  });
}

/**
 * A route of `date` laid out in stops by the algorithm the working doors call
 * (`placeRequestTrips`): equal addresses share one point. `dayRequestId` puts a special-equipment
 * request's day into it (`work_date`), the freight requests ride along as the stops.
 */
async function stopRoute(opts: {
  vehicleId: string;
  personId: string;
  date: string;
  freightIds: string[];
  dayRequestId?: string;
}): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId: opts.vehicleId,
      routeDate: opts.date,
      purpose: 'freight',
      driverPersonId: opts.personId,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  const members = [
    ...(opts.dayRequestId ? [{ requestId: opts.dayRequestId, workDate: opts.date }] : []),
    ...opts.freightIds.map((requestId) => ({ requestId, workDate: null })),
  ];
  await ctx.db.insert(ctx.schema.vehicleRouteRequests).values(
    members.map((member, index) => ({
      routeId: route!.id,
      requestId: member.requestId,
      position: index + 1,
      workDate: member.workDate,
    })),
  );
  for (const requestId of opts.freightIds) {
    await ctx.placeRequestTrips(ctx.db as never, route!.id, requestId);
  }
  await issue4p(route!.id, opts.vehicleId, opts.personId, opts.date);
  return route!.id;
}

/** The live stop ids of a route, in the order the cabinet shows them. */
async function stopIds(routeId: string): Promise<string[]> {
  return (await ctx.assignment.loadReadingStops(ctx.db, routeId)).map((stop) => stop.routePointId);
}

/** Stops on the wire: `[arrival, departure]` per stop; only stop 1 carries an arrival. */
function wirePoints(ids: string[], times: [string | null, string | null][]) {
  return ids.map((routePointId, index) => ({
    position: index + 1,
    routePointId,
    arrivedAt: index === 0 ? times[index]![0] : null,
    departedAt: times[index]![1],
  }));
}

function values(input: Record<string, unknown>): ReadingInput {
  return {
    kind: 'values',
    odometerKm: null,
    engineHours: null,
    fuelFilledLiters: null,
    comment: '',
    ...input,
  } as ReadingInput;
}

/**
 * Open the person's day as staff (older days are allowed) and submit its single item; a second call
 * on a submitted day is a correction and carries a reason.
 */
async function submitDay(
  personId: string,
  date: string,
  reading: ReadingInput,
  reason = '',
): Promise<void> {
  const opened =
    (await ctx.readings.loadReport(personId, date)) ??
    (await ctx.readings.openReport(personId, date, ctx.adminId, STAFF));
  expect(opened.items).toHaveLength(1);
  const line: ReportItemSubmit = {
    itemId: opened.items[0]!.id,
    reading,
    fileIds: [],
    confirmOdometerAnomaly: false,
    confirmEngineHoursAnomaly: false,
  };
  await ctx.readings.submitReport(
    personId,
    date,
    { version: opened.version, items: [line], reason },
    ctx.adminId,
    null,
    { ...STAFF, reason },
  );
}

async function dayOf(
  requestId: string,
  date: string,
  auth: Auth = ctx.admin,
): Promise<VehicleRequestShiftDto> {
  const res = await expectStatus(
    inject('GET', `/api/v1/vehicle-requests/${requestId}/shifts`, undefined, auth),
    200,
  );
  const day = (res.json() as VehicleRequestShiftsDto).items.find((item) => item.date === date);
  expect(day, date).toBeDefined();
  return day!;
}

async function rowTimeOf(requestId: string, date: string) {
  const rows = await ctx.db.execute<{
    started_at: string | null;
    ended_at: string | null;
    machine_hours: string;
    approved: boolean;
  }>(sql`
    SELECT started_at::text, ended_at::text, machine_hours::text, approved_at IS NOT NULL AS approved
      FROM vehicle_request_shifts WHERE request_id = ${requestId} AND shift_date = ${date}`);
  return rows.rows[0] ?? null;
}

async function routeTimeOf(
  requestId: string,
  auth: Auth = ctx.admin,
): Promise<RequestRouteTimeDto> {
  const res = await expectStatus(
    inject('GET', `/api/v1/vehicle-requests/${requestId}/route-time`, undefined, auth),
    200,
  );
  return res.json() as RequestRouteTimeDto;
}

/**
 * A special-equipment case on its own vehicle: a two-day term, a baseline snapshot on the first
 * day (a first snapshot is never clean) and ESM-2 sheets of the request on both days.
 */
async function esm2Case(name: string, requestId?: string) {
  const baseline = ago(3);
  const day = ago(2);
  const personId = await newPerson(name);
  const vehicleId = await newVehicle();
  const request = requestId ?? (await newRequest(vehicleId, baseline, day));
  await issueEsm2(request, vehicleId, personId, baseline);
  await issueEsm2(request, vehicleId, personId, day);
  await submitDay(personId, baseline, values({ engineHours: 1000 }));
  return { requestId: request, personId, vehicleId, baseline, day };
}

describe.skipIf(!DB_URL)('время водителя доходит до заявок (живая схема)', () => {
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const readings = await import('../src/services/readings');
    const assignment = await import('../src/services/driver-assignment');
    const routePoints = await import('../src/services/route-points');
    const { buildApp: build } = await import('../src/app');

    const typeOf = async (kind: string) =>
      (
        await db.execute<{ id: string }>(sql`
          SELECT vt.id FROM vehicle_types vt
            JOIN vehicle_kinds vk ON vk.id = vt.kind_id
           WHERE vk.code = ${kind} AND vt.is_active
           ORDER BY vt.code LIMIT 1`)
      ).rows[0]?.id;
    const specialTypeId = await typeOf('special_equipment');
    const freightTypeId = await typeOf('freight_transport');
    const organizations = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
    );
    if (!specialTypeId || !freightTypeId || !organizations.rows[0]) {
      throw new Error('В базе нет типов спецтехники и грузовых или организации');
    }
    const object = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`яя-driver-times-${RUN}`}, ${`Площадка времени ${RUN}`}, 'г Москва, ул Точечная, д 5')
      RETURNING id`);
    const [series] = await db
      .insert(schema.waybillSeries)
      .values({ code: SERIES_CODE, name: `Тестовая серия (время в заявках) ${RUN}`, prefix: 'ВЗ-' })
      .returning({ id: schema.waybillSeries.id });

    const app = await build();
    await app.ready();
    ctx = {
      app,
      db,
      schema,
      readings,
      assignment,
      placeRequestTrips: routePoints.placeRequestTrips,
      closeDb,
      admin: { authorization: '' },
      observer: { authorization: '' },
      adminId: '',
      objectId: object.rows[0]!.id,
      specialTypeId,
      freightTypeId,
      organizationId: organizations.rows[0].id,
      seriesId: series!.id,
    };
    const adminEmail = `db-driver-times-admin-${RUN}@example.invalid`;
    const observerEmail = `db-driver-times-observer-${RUN}@example.invalid`;
    ctx.adminId = await userWithRole(adminEmail, 'admin');
    await userWithRole(observerEmail, 'observer');
    ctx.admin = await login(adminEmail);
    ctx.observer = await login(observerEmail);
  });

  afterAll(async () => {
    if (ctx) {
      await purge(ctx.db);
      await ctx.db.execute(
        sql`DELETE FROM construction_objects WHERE code = ${`яя-driver-times-${RUN}`}`,
      );
      await ctx.app.close();
      await ctx.closeDb();
    }
  });

  // ── The shift time of a special-equipment day ──

  it('ЭСМ-2: время смены дня — водителя, подпись пишет его и замораживает', async () => {
    const { requestId, personId, day } = await esm2Case('Первый');
    await submitDay(
      personId,
      day,
      values({ engineHours: 1009, startedAt: '08:00', endedAt: '17:30' }),
    );

    const driverDay = await dayOf(requestId, day);
    expect(driverDay).toMatchObject({
      source: 'driver',
      machineHours: 9,
      startedAt: '08:00',
      endedAt: '17:30',
      driverDay: {
        clean: true,
        startedAt: '08:00',
        endedAt: '17:30',
        intervals: [{ startedAt: '08:00', endedAt: '17:30' }],
        timeIssue: null,
      },
    });
    // D10: the time is a number of the day — the observer sees it without the diagnostics.
    const seen = await dayOf(requestId, day, ctx.observer);
    expect(seen).toMatchObject({ startedAt: '08:00', endedAt: '17:30', source: 'driver' });
    expect(seen.driver).toBeUndefined();

    // The save door takes the driver's interval, not the body's: the time is locked like the hours.
    const fingerprint = driverDay.driverDay!.fingerprint;
    await expectStatus(
      inject('PUT', `/api/v1/vehicle-requests/${requestId}/shifts/${day}`, {
        startedAt: '07:00',
        endedAt: '19:00',
        machineHours: 1,
        comment: 'проверили',
        expectedDriverFingerprint: fingerprint,
      }),
      200,
    );
    expect(await rowTimeOf(requestId, day)).toMatchObject({
      started_at: '08:00:00',
      ended_at: '17:30:00',
      machine_hours: '9.00',
      approved: false,
    });

    await expectStatus(
      inject('POST', `/api/v1/vehicle-requests/${requestId}/shifts/${day}/approval`, {
        approved: true,
        expectedDriverFingerprint: fingerprint,
      }),
      200,
    );

    // A time correction after the signature: the signed time stays, the new one rides alongside.
    await submitDay(
      personId,
      day,
      values({ engineHours: 1009, startedAt: '09:00', endedAt: '18:00' }),
      'время со слов машиниста',
    );
    const signed = await dayOf(requestId, day);
    expect(signed).toMatchObject({
      source: 'site',
      startedAt: '08:00',
      endedAt: '17:30',
      driverDay: { startedAt: '09:00', endedAt: '18:00' },
    });
    expect(signed.approvedAt).not.toBeNull();
  });

  it('время водителя меняет отпечаток: вкладка, видевшая прежнее время, получает 409', async () => {
    const { requestId, personId, day } = await esm2Case('Отпечатков');
    await submitDay(
      personId,
      day,
      values({ engineHours: 1008, startedAt: '08:00', endedAt: '16:00' }),
    );
    const stale = (await dayOf(requestId, day)).driverDay!.fingerprint;
    await submitDay(
      personId,
      day,
      values({ engineHours: 1008, startedAt: '08:00', endedAt: '17:00' }),
      'уточнили конец смены',
    );
    await expectStatus(
      inject('POST', `/api/v1/vehicle-requests/${requestId}/shifts/${day}/approval`, {
        approved: true,
        expectedDriverFingerprint: stale,
      }),
      409,
    );
    expect(await rowTimeOf(requestId, day)).toBeNull();
  });

  it('чистый день без времени водителя оставляет время объекта; нечистый времени водителя не берёт', async () => {
    const { requestId, personId, day, baseline } = await esm2Case('Безвременный');
    // The site typed its day before the driver submitted.
    await expectStatus(
      inject('PUT', `/api/v1/vehicle-requests/${requestId}/shifts/${day}`, {
        startedAt: '07:00',
        endedAt: '19:00',
        machineHours: 5,
      }),
      200,
    );
    // A legacy-shaped reading: counters without a time (staff may leave it empty, D5).
    await submitDay(personId, day, values({ engineHours: 1010 }));
    const shift = await dayOf(requestId, day);
    expect(shift).toMatchObject({
      source: 'driver',
      machineHours: 10,
      startedAt: '07:00',
      endedAt: '19:00',
      driverDay: { startedAt: null, endedAt: null, timeIssue: 'incomplete', intervals: [] },
    });
    await expectStatus(
      inject('POST', `/api/v1/vehicle-requests/${requestId}/shifts/${day}/approval`, {
        approved: true,
        expectedDriverFingerprint: shift.driverDay!.fingerprint,
      }),
      200,
    );
    expect(await rowTimeOf(requestId, day)).toMatchObject({
      started_at: '07:00:00',
      ended_at: '19:00:00',
      machine_hours: '10.00',
      approved: true,
    });

    // The baseline is a first snapshot — never clean — so its time is not the day's either.
    await submitDay(
      personId,
      baseline,
      values({ engineHours: 1000, startedAt: '08:00', endedAt: '12:00' }),
      'добавили время',
    );
    expect(await dayOf(requestId, baseline)).toMatchObject({
      source: null,
      startedAt: null,
      driverDay: { clean: false, startedAt: '08:00', endedAt: '12:00' },
    });
  });

  it('несколько показаний дня: один интервал, когда складываются; иначе интервалы врозь и время объекта', async () => {
    // Two vehicles of one request on one day: each its own sheet, machinist and counter chain.
    const first = await esm2Case('Утренний');
    const second = await esm2Case('Вечерний', first.requestId);
    const { requestId, day } = first;
    await submitDay(
      first.personId,
      day,
      values({ engineHours: 1004, startedAt: '08:00', endedAt: '12:00' }),
    );
    await submitDay(
      second.personId,
      day,
      values({ engineHours: 1005, startedAt: '13:00', endedAt: '18:00' }),
    );

    expect(await dayOf(requestId, day)).toMatchObject({
      source: 'driver',
      machineHours: 9,
      startedAt: '08:00',
      endedAt: '18:00',
      driverDay: {
        intervals: [
          { startedAt: '08:00', endedAt: '12:00' },
          { startedAt: '13:00', endedAt: '18:00' },
        ],
        timeIssue: null,
      },
    });

    // A night shift and a short one at 02:00 of the same day: 30 h from the first start to the
    // last end. No single interval is invented; the site types the time.
    await submitDay(
      first.personId,
      day,
      values({ engineHours: 1004, startedAt: '20:00', endedAt: '08:00' }),
      'ночная смена',
    );
    await submitDay(
      second.personId,
      day,
      values({ engineHours: 1005, startedAt: '02:00', endedAt: '06:00' }),
      'ранний выезд',
    );
    const split = await dayOf(requestId, day);
    expect(split).toMatchObject({
      source: 'driver',
      machineHours: 9,
      startedAt: null,
      endedAt: null,
      driverDay: {
        startedAt: null,
        endedAt: null,
        timeIssue: 'ambiguous',
        intervals: [
          { startedAt: '02:00', endedAt: '06:00' },
          { startedAt: '20:00', endedAt: '08:00' },
        ],
      },
    });
    // The window lets the site type its own time on such a day, and the save door keeps it.
    await expectStatus(
      inject('PUT', `/api/v1/vehicle-requests/${requestId}/shifts/${day}`, {
        startedAt: '02:00',
        endedAt: '08:00',
        machineHours: 9,
        expectedDriverFingerprint: split.driverDay!.fingerprint,
      }),
      200,
    );
    expect(await rowTimeOf(requestId, day)).toMatchObject({
      started_at: '02:00:00',
      ended_at: '08:00:00',
    });
    expect(await dayOf(requestId, day)).toMatchObject({ startedAt: '02:00', endedAt: '08:00' });
  });

  it('день в рейсе: время смены — прибытие на первую точку и отправление с последней', async () => {
    const baseline = ago(3);
    const day = ago(2);
    const personId = await newPerson('Рейсовый');
    const vehicleId = await newVehicle();
    const requestId = await newRequest(vehicleId, baseline, day);
    await issueEsm2(requestId, vehicleId, personId, baseline);
    await submitDay(personId, baseline, values({ engineHours: 2000 }));
    // The linear day rides a route whose stops are a freight request's: the vehicle's shift is the
    // whole route, as its counter is.
    const freight = await newFreightRequest([
      { from: 'г Москва, ул Карьерная, д 9', to: 'г Москва, ул Бетонная, д 4' },
    ]);
    const routeId = await stopRoute({
      vehicleId,
      personId,
      date: day,
      freightIds: [freight],
      dayRequestId: requestId,
    });
    const ids = await stopIds(routeId);
    expect(ids).toHaveLength(2);
    await submitDay(
      personId,
      day,
      values({
        engineHours: 2007.5,
        points: wirePoints(ids, [
          ['07:40', '09:10'],
          [null, '15:20'],
        ]),
      }),
    );
    expect(await dayOf(requestId, day)).toMatchObject({
      source: 'driver',
      machineHours: 7.5,
      startedAt: '07:40',
      endedAt: '15:20',
    });
  });

  // ── Freight: «Факт по точкам» and «время по заявке» ──

  it('грузоперевозка: время по заявке — доля D6 из снимка, перестройка и открепление его не меняют', async () => {
    const personId = await newPerson('Грузовой');
    const vehicleId = await newVehicle(ctx.freightTypeId);
    const quarry = 'г Москва, ул Карьерная, д 11';
    const first = await newFreightRequest([{ from: quarry, to: 'г Москва, ул Первая, д 1' }]);
    const second = await newFreightRequest([{ from: quarry, to: 'г Москва, ул Вторая, д 2' }]);
    const routeId = await stopRoute({
      vehicleId,
      personId,
      date: TODAY,
      freightIds: [first, second],
    });
    const ids = await stopIds(routeId);
    expect(ids).toHaveLength(3);

    // Nothing submitted yet: no time and the reason why.
    expect(await routeTimeOf(first)).toEqual({
      readings: [],
      seconds: null,
      issues: ['no_readings'],
      driver: { readings: [] },
    });

    // The quarry is shared (07:00–08:10 split in two), then each request's own unloading.
    await submitDay(
      personId,
      TODAY,
      values({
        odometerKm: 50_000,
        comment: 'пробка на МКАД',
        points: wirePoints(ids, [
          ['07:00', '08:10'],
          [null, '09:00'],
          [null, '10:30'],
        ]),
      }),
    );
    const firstTime = await routeTimeOf(first);
    const secondTime = await routeTimeOf(second);
    // 70 min shared → 35 each; then 50 min to the first unloading, 90 to the second.
    expect(firstTime.seconds).toBe((35 + 50) * 60);
    expect(secondTime.seconds).toBe((35 + 90) * 60);
    expect(firstTime.seconds! + secondTime.seconds!).toBe(3.5 * 3600);
    expect(firstTime.issues).toEqual([]);
    expect(firstTime.readings[0]!.stops).toEqual([
      {
        position: 1,
        location: quarry,
        arrivedAt: '07:00',
        segmentFrom: '07:00',
        departedAt: '08:10',
        sharedBy: 2,
      },
      {
        position: 2,
        location: 'г Москва, ул Первая, д 1',
        arrivedAt: null,
        segmentFrom: '08:10',
        departedAt: '09:00',
        sharedBy: 1,
      },
    ]);
    expect(firstTime.driver?.readings[0]).toMatchObject({
      reportState: 'submitted',
      kind: 'values',
      comment: 'пробка на МКАД',
    });

    // D10: the observer reads the times and the share, not who submitted them.
    const seen = await routeTimeOf(first, ctx.observer);
    expect(seen.seconds).toBe(firstTime.seconds);
    expect(seen.driver).toBeUndefined();

    // A rebuild of the route and a detached request leave the attribution where it was captured.
    await ctx.db.execute(sql`DELETE FROM vehicle_route_points WHERE route_id = ${routeId}`);
    await ctx.db.execute(
      sql`DELETE FROM vehicle_route_requests WHERE route_id = ${routeId} AND request_id = ${second}`,
    );
    expect((await routeTimeOf(first)).seconds).toBe(firstTime.seconds);
    expect((await routeTimeOf(second)).seconds).toBe(secondTime.seconds);
    expect((await routeTimeOf(second)).readings[0]!.stops.map((stop) => stop.location)).toEqual([
      quarry,
      'г Москва, ул Вторая, д 2',
    ]);
  });

  it('грузоперевозка: неполное время, показание без времени и закрытая без показаний смена — без времени и с причиной', async () => {
    const quarry = 'г Москва, ул Карьерная, д 12';

    // An interim reading: the arrival at stop 1 only.
    const interimPerson = await newPerson('Промежуточный');
    const interimRequest = await newFreightRequest([{ from: quarry, to: 'г Москва, ул Ж, д 1' }]);
    const interimRoute = await stopRoute({
      vehicleId: await newVehicle(ctx.freightTypeId),
      personId: interimPerson,
      date: TODAY,
      freightIds: [interimRequest],
    });
    await submitDay(
      interimPerson,
      TODAY,
      values({
        fuelStartLiters: 40,
        points: wirePoints(await stopIds(interimRoute), [
          ['07:00', null],
          [null, null],
        ]),
      }),
    );
    expect(await routeTimeOf(interimRequest)).toMatchObject({
      seconds: null,
      issues: ['incomplete'],
      readings: [{ seconds: null, issue: 'incomplete' }],
    });

    // A reading without stop times: staff entered the counters only (D5).
    const untimedPerson = await newPerson('Безточечный');
    const untimedRequest = await newFreightRequest([{ from: quarry, to: 'г Москва, ул З, д 2' }]);
    await stopRoute({
      vehicleId: await newVehicle(ctx.freightTypeId),
      personId: untimedPerson,
      date: TODAY,
      freightIds: [untimedRequest],
    });
    await submitDay(untimedPerson, TODAY, values({ odometerKm: 70_000 }));
    expect(await routeTimeOf(untimedRequest)).toMatchObject({
      seconds: null,
      issues: ['no_times'],
    });

    // A shift closed without values: nothing was timed.
    const closedPerson = await newPerson('Закрытый');
    const closedRequest = await newFreightRequest([{ from: quarry, to: 'г Москва, ул И, д 3' }]);
    await stopRoute({
      vehicleId: await newVehicle(ctx.freightTypeId),
      personId: closedPerson,
      date: TODAY,
      freightIds: [closedRequest],
    });
    await submitDay(closedPerson, TODAY, { kind: 'no_data', noDataReason: 'машина не вышла' });
    const closed = await routeTimeOf(closedRequest);
    expect(closed).toMatchObject({ seconds: null, issues: ['no_data'] });
    expect(closed.driver?.readings[0]).toMatchObject({
      kind: 'no_data',
      noDataReason: 'машина не вышла',
    });
    expect((await routeTimeOf(closedRequest, ctx.observer)).driver).toBeUndefined();
  });

  it('у заказа техники на объект времени по точкам нет — пустой ответ, а не отказ', async () => {
    const vehicleId = await newVehicle();
    const requestId = await newRequest(vehicleId, ago(1), TODAY);
    expect(await routeTimeOf(requestId)).toEqual({ readings: [], seconds: null, issues: [] });
  });
});
