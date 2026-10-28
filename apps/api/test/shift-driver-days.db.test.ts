import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type ReadingInput,
  type ReportItemSubmit,
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
import type * as DaysNs from '../src/services/vehicle-request-days';
import type * as AssignmentShiftsNs from '../src/services/assignment-shifts';
import type * as AggregateNs from '../src/services/readings-aggregate';
import type * as GarageNs from '../src/services/garage';

/**
 * The request shift table reading the driver's readings (readings-shifts-merge plan §6, ADR 0184
 * section "Driver readings as the day's numbers") on the live schema, through the real handlers.
 *
 * WHY A LIVE DATABASE. The day's rule is pure and has its own test (`shift-driver-days.test.ts`).
 * What only the database proves is the wiring: which readings belong to a request day (both source
 * branches, the submitted states, a voided report), the engine-hour chain the readings service
 * builds, the discrepancy rule shared with the garage, the doors' handshake under the request lock,
 * and who sees the diagnostics (D10).
 *
 * The data is made by the readings service (`openReport`/`submitReport`/`acceptReport`), as in the
 * garage tests: a reading inserted by hand would agree the reader with itself. Requests, sources and
 * waybills are inserted directly — they are the scene, not the subject.
 *
 * Every case takes its own vehicle and driver, so the counter chains never meet; each case writes a
 * baseline snapshot the day before its subject day, since a first snapshot is never clean.
 *
 * Run (an own database; migrations are applied by the test):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_test \
 *     npx vitest run test/shift-driver-days.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-shift-driver-days-password-123';
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: смены по показаниям';
const MARK = `${MARK_PREFIX} ${RUN}`;
/** Blank numbers from a range nobody else uses, a block per run. */
const WAYBILL_NUMBER_BASE = 940_000_000 + Math.floor(Math.random() * 900) * 1_000;

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
  days: typeof DaysNs;
  assignmentShifts: typeof AssignmentShiftsNs;
  aggregate: typeof AggregateNs;
  garage: typeof GarageNs;
  closeDb: () => Promise<void>;
  admin: Auth;
  observer: Auth;
  adminId: string;
  objectId: string;
  typeId: string;
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
async function purge(db: typeof AppDb, mark: string): Promise<void> {
  const persons = sql`(SELECT id FROM persons WHERE comment = ${mark})`;
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM waybills WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_routes WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${mark}`);
  await db.execute(sql`DELETE FROM vehicles WHERE note = ${mark}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${mark}`);
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

async function newPerson(firstName: string): Promise<{ id: string; fullName: string }> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Сменов', firstName, middleName: 'Показаниевич', comment: MARK })
    .returning({ id: ctx.schema.persons.id, fullName: ctx.schema.persons.fullName });
  return person!;
}

/** An own vehicle: its description is empty and it has no prices (`vehicles_own_fields_check`). */
async function newVehicle(): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({ ownership: 'own', vehicleTypeId: ctx.typeId, status: 'active', note: MARK })
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
      vehicleTypeId: ctx.typeId,
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
    vehicleTypeId: ctx.typeId,
    orderedVehicleTypeId: ctx.typeId,
    pricePerHour: '3000',
    assignedBy: ctx.adminId,
  });
  return request!.id;
}

/**
 * A one-day weekly ESM-2 of the request — a week of one day keeps the period inside a week.
 *
 * ЭСМ2-РАЗРЕЗ: the sheet is a one-day segment, the shape the read switch produces. Its bounds only
 * give the day an ESM-2 source; the moved-sheet case re-dates that single day to make a `date`
 * discrepancy, and no assertion reads the period as a Monday-to-Sunday week.
 */
async function issueEsm2(
  requestId: string,
  vehicleId: string,
  personId: string,
  date: string,
): Promise<string> {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: WAYBILL_NUMBER_BASE + waybillNo,
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
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

/** A day route of the request (`vehicle_route_requests.work_date`) with its issued 4-П. */
async function dayRoute(
  requestId: string,
  vehicleId: string,
  personId: string,
  date: string,
): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId,
      routeDate: date,
      purpose: 'freight',
      driverPersonId: personId,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  await ctx.db
    .insert(ctx.schema.vehicleRouteRequests)
    .values({ routeId: route!.id, requestId, position: 1, workDate: date });
  waybillNo += 1;
  await ctx.db.insert(ctx.schema.waybills).values({
    seriesId: ctx.seriesId,
    number: WAYBILL_NUMBER_BASE + waybillNo,
    formCode: '4p',
    status: 'issued',
    organizationId: ctx.organizationId,
    vehicleId,
    driverPersonId: personId,
    issuedForDate: date,
    routeId: route!.id,
    issuedBy: ctx.adminId,
  });
  return route!.id;
}

function values(input: Partial<Omit<ReadingInput & { kind: 'values' }, 'kind'>>): ReadingInput {
  return {
    kind: 'values',
    odometerKm: null,
    engineHours: null,
    fuelFilledLiters: null,
    comment: '',
    ...input,
  } as ReadingInput;
}

function line(itemId: string, reading: ReadingInput, confirm = false): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: [],
    confirmOdometerAnomaly: confirm,
    confirmEngineHoursAnomaly: confirm,
  };
}

/** Open the day for the driver and submit its single item. Staff mode: older days are allowed. */
async function submitDay(
  personId: string,
  date: string,
  reading: ReadingInput,
  options: { reason?: string; confirm?: boolean } = {},
): Promise<{ reportId: string; version: number }> {
  const opened =
    (await ctx.readings.loadReport(personId, date)) ??
    (await ctx.readings.openReport(personId, date, ctx.adminId, STAFF));
  expect(opened.items).toHaveLength(1);
  const reason = options.reason ?? '';
  const submitted = await ctx.readings.submitReport(
    personId,
    date,
    {
      version: opened.version,
      items: [line(opened.items[0]!.id, reading, options.confirm)],
      reason,
    },
    ctx.adminId,
    null,
    { ...STAFF, reason },
  );
  return { reportId: submitted.id, version: submitted.version };
}

async function shiftsOf(
  requestId: string,
  auth: Auth = ctx.admin,
): Promise<VehicleRequestShiftsDto> {
  const res = await expectStatus(
    inject('GET', `/api/v1/vehicle-requests/${requestId}/shifts`, undefined, auth),
    200,
  );
  return res.json() as VehicleRequestShiftsDto;
}

async function dayOf(
  requestId: string,
  date: string,
  auth: Auth = ctx.admin,
): Promise<VehicleRequestShiftDto> {
  const day = (await shiftsOf(requestId, auth)).items.find((item) => item.date === date);
  expect(day, date).toBeDefined();
  return day!;
}

function approve(requestId: string, date: string, body: Record<string, unknown>) {
  return inject('POST', `/api/v1/vehicle-requests/${requestId}/shifts/${date}/approval`, body);
}

function save(requestId: string, date: string, body: Record<string, unknown>) {
  return inject('PUT', `/api/v1/vehicle-requests/${requestId}/shifts/${date}`, body);
}

/** The day's shift of the request in the garage occupancy of its vehicle (D15). */
async function garageShiftOf(vehicleId: string, requestId: string, date: string) {
  const busy = (await ctx.garage.loadVehicleBusy(date, [vehicleId])).get(vehicleId) ?? [];
  const special = busy.find((entry) => entry.kind === 'special' && entry.requestId === requestId);
  expect(special, `${date}: заказ в занятости машины`).toBeDefined();
  return special!.kind === 'special' ? special!.shift : undefined;
}

async function rowOf(requestId: string, date: string) {
  const rows = await ctx.db.execute<{
    machine_hours: string;
    refuel: string;
    comment: string;
    started_at: string | null;
    approved: boolean;
  }>(sql`
    SELECT machine_hours::text, refuel, comment, started_at::text, approved_at IS NOT NULL AS approved
      FROM vehicle_request_shifts WHERE request_id = ${requestId} AND shift_date = ${date}`);
  return rows.rows[0] ?? null;
}

/**
 * A driver case on its own vehicle: a request with a two-day term, a baseline snapshot on the first
 * day and the subject day on the second, both on one-day ESM-2 sheets of the request.
 */
async function esm2Case(name: string): Promise<{
  requestId: string;
  vehicleId: string;
  person: { id: string; fullName: string };
  baseline: string;
  day: string;
  waybillOfDay: string;
}> {
  const baseline = ago(3);
  const day = ago(2);
  const person = await newPerson(name);
  const vehicleId = await newVehicle();
  const requestId = await newRequest(vehicleId, baseline, day);
  await issueEsm2(requestId, vehicleId, person.id, baseline);
  const waybillOfDay = await issueEsm2(requestId, vehicleId, person.id, day);
  await submitDay(person.id, baseline, values({ engineHours: 1000 }));
  return { requestId, vehicleId, person, baseline, day, waybillOfDay };
}

describe.skipIf(!DB_URL)('смены заявки по показаниям водителя (живая схема)', () => {
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const readings = await import('../src/services/readings');
    const days = await import('../src/services/vehicle-request-days');
    const assignmentShifts = await import('../src/services/assignment-shifts');
    const aggregate = await import('../src/services/readings-aggregate');
    const garage = await import('../src/services/garage');
    const { buildApp: build } = await import('../src/app');

    const types = await db.execute<{ id: string }>(sql`
      SELECT vt.id FROM vehicle_types vt
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE vk.code = 'special_equipment' AND vt.is_active
       ORDER BY vt.code LIMIT 1`);
    const organizations = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
    );
    const seriesRows = await db.execute<{ id: string }>(
      sql`SELECT id FROM waybill_series ORDER BY code LIMIT 1`,
    );
    if (!types.rows[0] || !organizations.rows[0] || !seriesRows.rows[0]) {
      throw new Error('В базе нет типа спецтехники, организации или серии бланков');
    }
    const object = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`яя-shift-readings-${RUN}`}, ${`Площадка показаний ${RUN}`}, 'г Москва, ул Сменная, д 3')
      RETURNING id`);

    const app = await build();
    await app.ready();
    ctx = {
      app,
      db,
      schema,
      readings,
      days,
      assignmentShifts,
      aggregate,
      garage,
      closeDb,
      admin: { authorization: '' },
      observer: { authorization: '' },
      adminId: '',
      objectId: object.rows[0]!.id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: seriesRows.rows[0].id,
    };
    const adminEmail = `db-shift-readings-admin-${RUN}@example.invalid`;
    const observerEmail = `db-shift-readings-observer-${RUN}@example.invalid`;
    ctx.adminId = await userWithRole(adminEmail, 'admin');
    await userWithRole(observerEmail, 'observer');
    ctx.admin = await login(adminEmail);
    ctx.observer = await login(observerEmail);
  });

  afterAll(async () => {
    if (ctx) {
      await purge(ctx.db, MARK);
      await ctx.db.execute(
        sql`DELETE FROM construction_objects WHERE code = ${`яя-shift-readings-${RUN}`}`,
      );
      await ctx.app.close();
      await ctx.closeDb();
    }
  });

  /**
   * The ESM-2 branch end to end: a clean driver day is the request day's numbers, everyone who
   * reads the request sees them (D10), an old tab cannot sign it, the garage accepting the report
   * between load and click changes nothing, and one click writes and signs the row. A later
   * reading edit does not rewrite the signature — it shows as a difference.
   */
  it('ЭСМ-2: день водителя подписывается в один клик, подпись не переписывается правкой показания', async () => {
    const scene = await esm2Case('Первый');
    const { requestId, day, baseline, person } = scene;
    const report = await submitDay(
      person.id,
      day,
      values({ engineHours: 1008.5, comment: 'работали без обеда' }),
    );

    const driverDay = await dayOf(requestId, day);
    expect(driverDay).toMatchObject({
      source: 'driver',
      machineHours: 8.5,
      // An empty refill is "not refuelled", as the garage reads it.
      refuel: '',
      comment: '',
      filledAt: null,
      approvedAt: null,
      driverDay: { machineHours: 8.5, refuelLiters: 0, clean: true, since: null },
    });
    expect(driverDay.driver?.readings).toEqual([
      expect.objectContaining({
        personName: person.fullName,
        reportState: 'submitted',
        sourceKind: 'esm2',
        comment: 'работали без обеда',
        previousDate: baseline,
      }),
    ]);
    // The same day in the garage's month aggregate: an empty refill is zero liters there too.
    const card = await ctx.aggregate.loadVehicleCard(scene.vehicleId, day, day);
    expect(card?.total.fuelFilledLiters).toBe(0);

    // The baseline is a first snapshot: shown, never signable, nothing filled.
    expect(await dayOf(requestId, baseline)).toMatchObject({
      source: null,
      driverDay: { machineHours: null, clean: false },
      driver: { issues: ['first_snapshot'] },
    });

    // D15: the garage occupancy counts the driver day as filled — as the card shows it — but only
    // the site signs it; the baseline (a first snapshot) is not filled there either.
    expect(await garageShiftOf(scene.vehicleId, requestId, day)).toEqual({
      filled: true,
      approved: false,
    });
    expect(await garageShiftOf(scene.vehicleId, requestId, baseline)).toBeNull();

    // D10: the observer reads the request — the numbers and the mark, no diagnostics.
    const seen = await dayOf(requestId, day, ctx.observer);
    expect(seen).toMatchObject({ source: 'driver', machineHours: 8.5, driverDay: { clean: true } });
    expect(seen.driver).toBeUndefined();

    // A day the site never wrote has no row to delete.
    await expectStatus(
      inject('DELETE', `/api/v1/vehicle-requests/${requestId}/shifts/${day}`),
      404,
    );
    // A non-clean day without a row is signed only after a conscious save.
    await expectStatus(approve(requestId, baseline, { approved: true }), 422);
    // An old tab sends no fingerprint: it never saw these numbers.
    await expectStatus(approve(requestId, day, { approved: true }), 409);
    expect(await rowOf(requestId, day)).toBeNull();

    // The dispatcher accepts the report between the load and the click: no number changed.
    const fingerprint = driverDay.driverDay!.fingerprint;
    await ctx.readings.acceptReport(report.reportId, report.version, ctx.adminId);
    expect((await dayOf(requestId, day)).driver?.readings[0]?.reportState).toBe('accepted');

    const signed = await expectStatus(
      approve(requestId, day, { approved: true, expectedDriverFingerprint: fingerprint }),
      200,
    );
    const signedDay = (signed.json() as VehicleRequestShiftsDto).items.find((s) => s.date === day);
    expect(signedDay).toMatchObject({ source: 'site', machineHours: 8.5, refuel: '' });
    expect(signedDay?.approvedAt).not.toBeNull();
    expect(await garageShiftOf(scene.vehicleId, requestId, day)).toEqual({
      filled: true,
      approved: true,
    });
    expect(await rowOf(requestId, day)).toMatchObject({ machine_hours: '8.50', approved: true });

    // The history line says where the signed numbers came from.
    const audit = await ctx.db.execute<{ metadata: { changes: unknown } }>(sql`
      SELECT metadata FROM audit_log
       WHERE entity_id = ${requestId} AND action = 'vehicle_request.shift_approve'`);
    expect(JSON.stringify(audit.rows[0]?.metadata.changes)).toContain('по показаниям водителя');

    // A correction after the signature: the signed row stays, the difference is visible next to it.
    await submitDay(person.id, day, values({ engineHours: 1010 }), {
      reason: 'переписали со счётчика',
    });
    expect(await dayOf(requestId, day)).toMatchObject({
      source: 'site',
      machineHours: 8.5,
      driverDay: { machineHours: 10, clean: true },
    });

    // The term refusal counts rows, not driver days: the baseline has none and does not lock.
    await ctx.db.transaction((tx) =>
      ctx.assignmentShifts.assertTermKeepsFilledShifts(tx, {
        requestId,
        status: 'confirmed',
        termBefore: { dateFrom: baseline, dateTo: day },
        termAfter: { dateFrom: day, dateTo: day },
      }),
    );
  });

  /**
   * The route branch with a gap, the save door and a site row overlaid by a driver day (D4). The gap
   * is the garage's continuity rule (D16): the route of d5 is an expected shift nobody submitted, so
   * the d4 reading's engine hours cover two days of work. Also the linear days table: it shows the
   * effective hours inside the term and keeps the physical row of a planned day outside the term
   * that an issued route holds.
   */
  it('рейсы дня: разрыв цепочки, дверь сохранения и строка площадки под днём водителя', async () => {
    const person = await newPerson('Рейсовый');
    const vehicleId = await newVehicle();
    const [d6, d5, d4, d3, d2] = [ago(6), ago(5), ago(4), ago(3), ago(2)];
    const requestId = await newRequest(vehicleId, d6, d2);
    for (const date of [ago(7), d6, d5, d4, d3, d2])
      await dayRoute(requestId, vehicleId, person.id, date);

    await submitDay(person.id, d6, values({ engineHours: 500, fuelFilledLiters: 40 }));
    await submitDay(person.id, d4, values({ engineHours: 523 }));
    // The site wrote the day before the driver did.
    await expectStatus(save(requestId, d3, { machineHours: 9, refuel: '50 л', comment: '' }), 200);
    await submitDay(person.id, d3, values({ engineHours: 530, fuelFilledLiters: 60 }));
    await submitDay(person.id, d2, values({ odometerKm: 12000 }));

    const shifts = await shiftsOf(requestId);
    const byDate = new Map(shifts.items.map((s) => [s.date, s]));
    expect(byDate.get(d5)).toMatchObject({ source: null, driverDay: null });
    expect(byDate.get(d4)).toMatchObject({
      source: null,
      driverDay: { machineHours: 23, clean: false, since: d6 },
      driver: { issues: ['gap'] },
    });
    // D4: the driver's clean numbers replace the site's unsigned ones; the row keeps its place.
    expect(byDate.get(d3)).toMatchObject({
      source: 'driver',
      machineHours: 7,
      refuel: '60 л',
      driverDay: { clean: true },
    });
    expect(byDate.get(d3)?.filledAt).not.toBeNull();
    expect(byDate.get(d2)).toMatchObject({
      source: null,
      driver: { issues: ['missing_engine_hours'] },
    });

    // The linear days table reads the same effective day inside the term, and only the row outside.
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_shifts (request_id, shift_date, machine_hours, refuel, comment, filled_by)
      VALUES (${requestId}, ${ago(7)}, 5, '', '', ${ctx.adminId})`);
    const state = await ctx.days.loadLinearRequest(ctx.db, requestId);
    const linear = new Map(
      (await ctx.days.loadRequestDays(ctx.db, state!)).map((item) => [item.date, item]),
    );
    expect(linear.get(ago(7))).toMatchObject({
      outOfTerm: true,
      shift: { machineHours: 5, source: 'site' },
    });
    expect(linear.get(d3)?.shift).toMatchObject({ machineHours: 7, source: 'driver' });
    expect(linear.get(d6)?.shift).toBeNull();

    // An old tab saw the site's 9 h: signing now would sign numbers it never saw.
    await expectStatus(approve(requestId, d3, { approved: true }), 409);
    await expectStatus(
      save(requestId, d3, { machineHours: 9, expectedDriverFingerprint: 'v1:stale' }),
      409,
    );
    // The save door writes the server's numbers and the site's time and comment.
    const fingerprint = byDate.get(d3)!.driverDay!.fingerprint;
    await expectStatus(
      save(requestId, d3, {
        startedAt: '08:00',
        endedAt: '17:00',
        machineHours: 3,
        refuel: 'выдумка',
        comment: 'по графику',
        expectedDriverFingerprint: fingerprint,
      }),
      200,
    );
    expect(await rowOf(requestId, d3)).toMatchObject({
      machine_hours: '7.00',
      refuel: '60 л',
      comment: 'по графику',
      started_at: '08:00:00',
      approved: false,
    });
    await expectStatus(
      approve(requestId, d3, { approved: true, expectedDriverFingerprint: fingerprint }),
      200,
    );

    // A non-clean day: a fingerprint is stale there, the manual save and the sign-off are the site's.
    await expectStatus(
      save(requestId, d4, { machineHours: 8, expectedDriverFingerprint: fingerprint }),
      409,
    );
    await expectStatus(save(requestId, d4, { machineHours: 8, comment: '' }), 200);
    await expectStatus(approve(requestId, d4, { approved: true }), 200);
    expect(await rowOf(requestId, d4)).toMatchObject({ machine_hours: '8.00', approved: true });

    // Rows still lock a term edit, signed or not.
    await expect(
      ctx.db.transaction((tx) =>
        ctx.assignmentShifts.assertTermKeepsFilledShifts(tx, {
          requestId,
          status: 'confirmed',
          termBefore: { dateFrom: d6, dateTo: d2 },
          termAfter: { dateFrom: d3, dateTo: d2 },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  /**
   * D16: a pair is continuous when no expected shift of the vehicle without numbers lies between
   * the snapshots — the month aggregate's rule, not the calendar. Days without an expected shift (a
   * weekend) break nothing; a weekly ESM-2 day breaks only once its report was opened without
   * numbers (Р13б), as the garage counts it.
   */
  it('непрерывность пары — правило гаража: выходные без смен не рвут, открытый пустой день рвёт', async () => {
    const [friday, saturday, sunday, monday] = [ago(5), ago(4), ago(3), ago(2)];
    const person = await newPerson('Понедельничный');
    const vehicleId = await newVehicle();
    const requestId = await newRequest(vehicleId, friday, monday);
    await issueEsm2(requestId, vehicleId, person.id, friday);
    await issueEsm2(requestId, vehicleId, person.id, monday);
    await submitDay(person.id, friday, values({ engineHours: 1000 }));
    await submitDay(person.id, monday, values({ engineHours: 1009 }));

    expect(await dayOf(requestId, monday)).toMatchObject({
      source: 'driver',
      machineHours: 9,
      driverDay: { clean: true, since: null },
      driver: { issues: [], readings: [{ previousDate: friday }] },
    });

    // A weekly sheet in force on Saturday whose day nobody opened is not a missed shift (Р13б).
    await issueEsm2(requestId, vehicleId, person.id, saturday);
    expect((await dayOf(requestId, monday)).source).toBe('driver');

    // Sunday's report opened without numbers is: the delta now covers a shift with no reading.
    await issueEsm2(requestId, vehicleId, person.id, sunday);
    await ctx.readings.openReport(person.id, sunday, ctx.adminId, STAFF);
    expect(await dayOf(requestId, monday)).toMatchObject({
      source: null,
      machineHours: 0,
      driverDay: { machineHours: 9, clean: false, since: friday },
      driver: { issues: ['gap'] },
    });
  });

  it('no_data и сброс счётчика — день не чистый', async () => {
    const noData = await esm2Case('Безданный');
    await submitDay(noData.person.id, noData.day, {
      kind: 'no_data',
      noDataReason: 'счётчик неисправен',
      comment: '',
    } as ReadingInput);
    expect(await dayOf(noData.requestId, noData.day)).toMatchObject({
      source: null,
      driverDay: { machineHours: null, refuelLiters: null, clean: false },
      driver: { issues: ['no_data'], readings: [{ noDataReason: 'счётчик неисправен' }] },
    });

    const reset = await esm2Case('Сброшенный');
    await submitDay(reset.person.id, reset.day, values({ engineHours: 3 }), { confirm: true });
    expect(await dayOf(reset.requestId, reset.day)).toMatchObject({
      source: null,
      driverDay: { machineHours: null, clean: false },
      driver: { issues: ['counter_reset'] },
    });
  });

  it('расхождения: машина и состояние источника запирают, водитель и разобранное — нет', async () => {
    const vehicle = await esm2Case('Чужая машина');
    const vehicleReport = await submitDay(
      vehicle.person.id,
      vehicle.day,
      values({ engineHours: 1006 }),
    );
    const otherVehicle = await newVehicle();
    await ctx.db
      .update(ctx.schema.waybills)
      .set({ vehicleId: otherVehicle })
      .where(eq(ctx.schema.waybills.id, vehicle.waybillOfDay));
    expect(await dayOf(vehicle.requestId, vehicle.day)).toMatchObject({
      source: null,
      driverDay: { machineHours: 6, clean: false },
      driver: {
        issues: ['discrepancy'],
        readings: [{ discrepancies: [{ kind: 'vehicle', resolved: false }] }],
      },
    });
    // Resolved in the garage, the day is clean again: the dispatcher already decided.
    const report = await ctx.readings.loadReportById(vehicleReport.reportId);
    const found = report.discrepancies.find((d) => d.kind === 'vehicle')!;
    await ctx.readings.resolveDiscrepancy(
      report.id,
      {
        kind: 'vehicle',
        itemId: found.itemId,
        sourceKind: null,
        sourceId: null,
        fingerprint: found.fingerprint,
        resolution: 'accepted_as_is',
        reason: 'машину заменили на объекте',
        version: report.version,
      },
      ctx.adminId,
    );
    expect(await dayOf(vehicle.requestId, vehicle.day)).toMatchObject({
      source: 'driver',
      machineHours: 6,
    });

    const moved = await esm2Case('Перенесённый лист');
    await submitDay(moved.person.id, moved.day, values({ engineHours: 1003 }));
    await ctx.db
      .update(ctx.schema.waybills)
      .set({ periodFrom: ago(1), periodTo: ago(1), issuedForDate: ago(1) })
      .where(eq(ctx.schema.waybills.id, moved.waybillOfDay));
    expect(await dayOf(moved.requestId, moved.day)).toMatchObject({
      source: null,
      driver: {
        issues: ['discrepancy'],
        readings: [{ discrepancies: [{ kind: 'date', resolved: false }] }],
      },
    });

    const cancelled = await esm2Case('Аннулированный лист');
    await submitDay(cancelled.person.id, cancelled.day, values({ engineHours: 1004 }));
    await ctx.db
      .update(ctx.schema.waybills)
      .set({ status: 'cancelled', cancelReason: 'испорчен бланк', cancelledAt: new Date() })
      .where(eq(ctx.schema.waybills.id, cancelled.waybillOfDay));
    expect(await dayOf(cancelled.requestId, cancelled.day)).toMatchObject({
      source: null,
      driver: { issues: ['discrepancy'] },
    });

    // The counter is the vehicle's: a sheet reissued to a substitute machinist stays clean.
    const substitute = await esm2Case('Сменщик');
    await submitDay(substitute.person.id, substitute.day, values({ engineHours: 1005 }));
    const other = await newPerson('Подменный');
    await ctx.db
      .update(ctx.schema.waybills)
      .set({ driverPersonId: other.id })
      .where(eq(ctx.schema.waybills.id, substitute.waybillOfDay));
    expect(await dayOf(substitute.requestId, substitute.day)).toMatchObject({
      source: 'driver',
      machineHours: 5,
      driver: { issues: [], readings: [{ discrepancies: [{ kind: 'driver', resolved: false }] }] },
    });
  });

  it('аннулированный отчёт не считается', async () => {
    const scene = await esm2Case('Аннулированный отчёт');
    const report = await submitDay(scene.person.id, scene.day, values({ engineHours: 1007 }));
    expect((await dayOf(scene.requestId, scene.day)).source).toBe('driver');
    await ctx.db
      .update(ctx.schema.driverDailyReports)
      .set({ state: 'voided' })
      .where(eq(ctx.schema.driverDailyReports.id, report.reportId));
    expect(await dayOf(scene.requestId, scene.day)).toMatchObject({
      source: null,
      driverDay: null,
    });
  });

  /**
   * An idle day's reason is the site's own word. The driver's reading comment is diagnostics behind
   * `vehicleReadings.read` (D10): the signer may not hold that right, and the row's comment goes to
   * every reader of the request and into its history.
   */
  it('простой без причины — 422, комментарий водителя не становится причиной площадки', async () => {
    const silent = await esm2Case('Молчаливый');
    await submitDay(silent.person.id, silent.day, values({ engineHours: 1000 }));
    const idle = await dayOf(silent.requestId, silent.day);
    expect(idle).toMatchObject({ source: 'driver', machineHours: 0 });
    const fingerprint = idle.driverDay!.fingerprint;
    await expectStatus(
      approve(silent.requestId, silent.day, {
        approved: true,
        expectedDriverFingerprint: fingerprint,
      }),
      422,
    );
    await expectStatus(
      save(silent.requestId, silent.day, {
        machineHours: 0,
        expectedDriverFingerprint: fingerprint,
      }),
      422,
    );
    expect(await rowOf(silent.requestId, silent.day)).toBeNull();

    const rainy = await esm2Case('Дождливый');
    await submitDay(rainy.person.id, rainy.day, values({ engineHours: 1000, comment: 'дождь' }));
    const rain = await dayOf(rainy.requestId, rainy.day);
    const rainFingerprint = rain.driverDay!.fingerprint;
    // The driver's word does not stand in for the site's: both doors still ask for one.
    await expectStatus(
      approve(rainy.requestId, rainy.day, {
        approved: true,
        expectedDriverFingerprint: rainFingerprint,
      }),
      422,
    );
    await expectStatus(
      save(rainy.requestId, rainy.day, {
        machineHours: 0,
        comment: '',
        expectedDriverFingerprint: rainFingerprint,
      }),
      422,
    );
    expect(await rowOf(rainy.requestId, rainy.day)).toBeNull();

    // The site types its reason, saves and signs.
    await expectStatus(
      save(rainy.requestId, rainy.day, {
        machineHours: 0,
        comment: 'стояли — не было фронта работ',
        expectedDriverFingerprint: rainFingerprint,
      }),
      200,
    );
    await expectStatus(
      approve(rainy.requestId, rainy.day, {
        approved: true,
        expectedDriverFingerprint: rainFingerprint,
      }),
      200,
    );
    expect(await rowOf(rainy.requestId, rainy.day)).toMatchObject({
      machine_hours: '0.00',
      comment: 'стояли — не было фронта работ',
      approved: true,
    });
    // Neither the shift row an observer reads nor the request history carries the reading text.
    const seen = await dayOf(rainy.requestId, rainy.day, ctx.observer);
    expect(seen.driver).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain('дождь');
    const audit = await ctx.db.execute<{ metadata: unknown }>(sql`
      SELECT metadata FROM audit_log WHERE entity_id = ${rainy.requestId}`);
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.rows)).not.toContain('дождь');
  });
});
