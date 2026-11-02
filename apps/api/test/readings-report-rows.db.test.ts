import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, type ReadingInput } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';
import type * as RowsNs from '../src/services/readings-report-rows';

/**
 * The rows of the readings report on the live schema (ADR 0240).
 *
 * WHY A LIVE DATABASE. The builder of the book has its own test on rows in memory. What only the
 * database proves is the selection: which request days are rows, which vehicle stands on them,
 * which readings belong to them through the request card's readers, where the counters of a shared
 * route go, and what is left as «без заявки». Readings are made by the readings service
 * (`openReport`/`submitReport`), so the counter chains are the service's own; requests, routes and
 * waybills are inserted directly — they are the scene, not the subject.
 *
 * Every case takes its own vehicles and people, so their chains never meet, and the assertions read
 * the rows of the case's vehicles only. The test makes its own database (`OWN_DB_NAME`): the
 * selection reads whole periods, and a neighbour's rows in a shared base would be in them.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_test \
 *     npx vitest run test/readings-report-rows.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_readings_report_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: книга показаний ${RUN}`;
const WAYBILL_NUMBER_BASE = 950_000_000 + Math.floor(Math.random() * 900) * 1_000;

const TODAY = moscowDateKeyOf(new Date());
const ago = (days: number): string => shiftDateKey(TODAY, -days);
const STAFF = { mode: 'staff' as const };

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  readings: typeof ReadingsNs;
  rows: typeof RowsNs;
  closeDb: () => Promise<void>;
  adminId: string;
  objectId: string;
  typeId: string;
  organizationId: string;
  seriesId: string;
  lessorId: string;
}

let ctx: Ctx;
let waybillNo = 0;
let report: RowsNs.ReportRowsResult;

function prepareEnv(databaseUrl: string): void {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PUBLIC_KEY_PEM ??= '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----';
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED ??= 'false';
}

// ── Scene ──

async function one(query: ReturnType<typeof sql>): Promise<string> {
  const result = await ctx.db.execute<{ id: string }>(query);
  return result.rows[0]!.id;
}

async function newPerson(firstName: string): Promise<{ id: string; fullName: string }> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Отчётов', firstName, middleName: 'Сменович', comment: MARK })
    .returning({ id: ctx.schema.persons.id, fullName: ctx.schema.persons.fullName });
  return person!;
}

async function newVehicle(registrationNumber: string | null = null): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'own',
      vehicleTypeId: ctx.typeId,
      status: 'active',
      registrationNumber,
      note: MARK,
    })
    .returning({ id: ctx.schema.vehicles.id });
  return vehicle!.id;
}

async function newRentalVehicle(): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'rental',
      vehicleTypeId: ctx.typeId,
      status: 'active',
      lessorId: ctx.lessorId,
      lessorType: 'vehicle_lessor',
      lessorIsActive: true,
      pricePerHour: '2500.00',
      description: `Аренда ${RUN}`,
      note: MARK,
    })
    .returning({ id: ctx.schema.vehicles.id });
  return vehicle!.id;
}

async function special(
  vehicleId: string,
  dateFrom: string,
  dateTo: string,
  prices: { pricePerHour?: string; pricePerShift?: string; shiftHours?: number } = {},
): Promise<string> {
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
    pricePerHour: prices.pricePerHour ?? null,
    pricePerShift: prices.pricePerShift ?? null,
    shiftHours: prices.shiftHours ?? null,
    assignedBy: ctx.adminId,
  });
  return request!.id;
}

async function freight(date: string, cargo: string): Promise<{ id: string; tripId: string }> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.typeId,
      status: 'confirmed',
      approvedBy: ctx.adminId,
      approvedAt: new Date(),
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  await ctx.db.execute(sql`
    INSERT INTO freight_transport_request_details (request_id, scheduled_at)
    VALUES (${request!.id}, ${`${date}T09:00:00+03:00`}::timestamptz)`);
  const tripId = await one(sql`
    INSERT INTO vehicle_request_trips (request_id, num, from_location, to_location, cargo_name)
    VALUES (${request!.id}, 1, 'Карьер', 'Площадка', ${cargo}) RETURNING id`);
  return { id: request!.id, tripId };
}

/** A route of the day with its issued 4-П: the driver's report will expect it. */
async function route(
  vehicleId: string,
  personId: string,
  date: string,
  composition: { requestId: string; workDate?: string }[],
  move?: { purpose: 'delivery' | 'pickup'; sourceRequestId: string },
): Promise<{ id: string; num: number }> {
  const [created] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId,
      routeDate: date,
      purpose: move?.purpose ?? 'freight',
      sourceRequestId: move?.sourceRequestId ?? null,
      moveFrom: move ? 'База' : '',
      moveTo: move ? 'Площадка' : '',
      driverPersonId: personId,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id, num: ctx.schema.vehicleRoutes.num });
  for (const [index, member] of composition.entries()) {
    await ctx.db.insert(ctx.schema.vehicleRouteRequests).values({
      routeId: created!.id,
      requestId: member.requestId,
      position: index + 1,
      workDate: member.workDate ?? null,
    });
  }
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
    routeId: created!.id,
    issuedBy: ctx.adminId,
  });
  return { id: created!.id, num: created!.num! };
}

async function point(
  routeId: string,
  position: number,
  stops: { requestId: string; tripId: string | null; role: 'load' | 'unload' | 'work' }[],
): Promise<void> {
  const pointId = await one(sql`
    INSERT INTO vehicle_route_points (route_id, position, location)
    VALUES (${routeId}, ${position}, ${`Точка ${position}`}) RETURNING id`);
  for (const [index, stop] of stops.entries()) {
    await ctx.db.execute(sql`
      INSERT INTO vehicle_route_point_trips (point_id, route_id, request_id, trip_id, role, position)
      VALUES (${pointId}, ${routeId}, ${stop.requestId}, ${stop.tripId}, ${stop.role}, ${index + 1})`);
  }
}

/**
 * A one-day ESM-2 of the request.
 *
 * ЭСМ2-РАЗРЕЗ: the sheet is a one-day segment, the shape the read switch produces. Its bounds only
 * give the day an ESM-2 source; no assertion reads the period as a Monday-to-Sunday week.
 */
async function esm2(
  requestId: string,
  vehicleId: string,
  personId: string,
  date: string,
): Promise<number> {
  waybillNo += 1;
  await ctx.db.insert(ctx.schema.waybills).values({
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
  });
  return WAYBILL_NUMBER_BASE + waybillNo;
}

function values(input: { odometerKm?: number; engineHours?: number }): ReadingInput {
  return {
    kind: 'values',
    odometerKm: input.odometerKm ?? null,
    engineHours: input.engineHours ?? null,
    fuelFilledLiters: null,
    comment: '',
  } as ReadingInput;
}

/** Open the driver's day and submit every item with the same numbers. Staff mode: old days pass. */
async function submitDay(
  personId: string,
  date: string,
  reading: ReadingInput,
): Promise<{ reportId: string }> {
  const opened =
    (await ctx.readings.loadReport(personId, date)) ??
    (await ctx.readings.openReport(personId, date, ctx.adminId, STAFF));
  expect(opened.items.length, `${date}: задания дня`).toBeGreaterThan(0);
  const submitted = await ctx.readings.submitReport(
    personId,
    date,
    {
      version: opened.version,
      items: opened.items.map((item) => ({
        itemId: item.id,
        reading,
        fileIds: [],
        confirmOdometerAnomaly: true,
        confirmEngineHoursAnomaly: true,
      })),
      reason: 'тест книги показаний',
    },
    ctx.adminId,
    null,
    { ...STAFF, reason: 'тест книги показаний' },
  );
  return { reportId: submitted.id };
}

function rowsOf(vehicleId: string): RowsNs.ReportRow[] {
  return report.rows
    .filter((row) => row.vehicle.id === vehicleId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

// ── Cases (built before the report is read once) ──

const scene = {} as Record<string, string>;
let sharedRouteNum = 0;
let waybillOfCancelled = 0;

async function buildScene(): Promise<void> {
  // A. A freight route shared by two freight requests and a linear special-equipment day. The
  //    linear day stops first by the route's points, so its row carries the counters even though
  //    it stands last in the composition and has the highest number.
  {
    const day = ago(10);
    const person = await newPerson('Общий');
    const vehicle = await newVehicle('А001АА797');
    const f1 = await freight(day, 'щебень');
    const f2 = await freight(day, 'песок');
    const linear = await special(vehicle, day, day);
    const shared = await route(vehicle, person.id, day, [
      { requestId: f1.id },
      { requestId: f2.id },
      { requestId: linear, workDate: day },
    ]);
    sharedRouteNum = shared.num;
    await point(shared.id, 1, [{ requestId: linear, tripId: null, role: 'work' }]);
    await point(shared.id, 2, [{ requestId: f1.id, tripId: f1.tripId, role: 'load' }]);
    await point(shared.id, 3, [{ requestId: f1.id, tripId: f1.tripId, role: 'unload' }]);
    await submitDay(person.id, day, values({ odometerKm: 1200, engineHours: 50 }));
    Object.assign(scene, { aVehicle: vehicle, aF1: f1.id, aF2: f2.id, aLinear: linear });
  }

  // B. An ESM-2 week of one request: a sheet a day, readings on three of five days.
  {
    const person = await newPerson('Недельный');
    const vehicle = await newVehicle();
    const request = await special(vehicle, ago(9), ago(5));
    for (let day = 9; day >= 5; day -= 1) await esm2(request, vehicle, person.id, ago(day));
    await submitDay(person.id, ago(9), values({ odometerKm: 5000, engineHours: 100 }));
    await submitDay(person.id, ago(8), values({ odometerKm: 5040, engineHours: 108 }));
    await submitDay(person.id, ago(6), values({ odometerKm: 5100, engineHours: 120 }));
    Object.assign(scene, { bVehicle: vehicle, bRequest: request, bPerson: person.fullName });
  }

  // C. A relocation made by a carrier truck: the row belongs to the truck, not to the unit.
  {
    const driver = await newPerson('Перегонщик');
    const unit = await newVehicle();
    const carrier = await newVehicle('В777ВВ777');
    const request = await special(unit, ago(4), ago(3));
    await route(carrier, driver.id, ago(4), [], {
      purpose: 'delivery',
      sourceRequestId: request,
    });
    await submitDay(driver.id, ago(4), values({ odometerKm: 30_000 }));
    Object.assign(scene, { cUnit: unit, cCarrier: carrier, cRequest: request });
  }

  // D. A reading whose request was cancelled after it: the own vehicle's work «без заявки».
  {
    const person = await newPerson('Отменённый');
    const vehicle = await newVehicle();
    const request = await special(vehicle, ago(6), ago(6));
    waybillOfCancelled = await esm2(request, vehicle, person.id, ago(6));
    await submitDay(person.id, ago(6), values({ odometerKm: 700, engineHours: 70 }));
    await ctx.db.execute(
      sql`UPDATE vehicle_requests SET status = 'cancelled' WHERE id = ${request}`,
    );
    Object.assign(scene, { dVehicle: vehicle, dRequest: request });
  }

  // E. Two vehicles worked one request on one day: a row per vehicle.
  {
    const first = await newPerson('Первая');
    const second = await newPerson('Вторая');
    const vehicle1 = await newVehicle();
    const vehicle2 = await newVehicle();
    const request = await special(vehicle1, ago(3), ago(3));
    await esm2(request, vehicle1, first.id, ago(3));
    await esm2(request, vehicle2, second.id, ago(3));
    await submitDay(first.id, ago(3), values({ engineHours: 10 }));
    await submitDay(second.id, ago(3), values({ engineHours: 20 }));
    Object.assign(scene, { eVehicle1: vehicle1, eVehicle2: vehicle2, eRequest: request });
  }

  // F, G. A voided report counts nothing; the term runs into the future, the rows stop today.
  {
    const person = await newPerson('Аннулированный');
    const vehicle = await newVehicle();
    const request = await special(vehicle, ago(2), ago(-2));
    await esm2(request, vehicle, person.id, ago(2));
    const { reportId } = await submitDay(person.id, ago(2), values({ engineHours: 300 }));
    await ctx.db.execute(
      sql`UPDATE driver_daily_reports SET state = 'voided' WHERE id = ${reportId}`,
    );
    Object.assign(scene, { fVehicle: vehicle, fRequest: request });
  }

  // H. A rented vehicle: its rows go to «Аренда» with the assignment's rates and the site's shift.
  {
    const vehicle = await newRentalVehicle();
    const request = await special(vehicle, ago(12), ago(11), {
      pricePerHour: '2500',
      shiftHours: 8,
    });
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_shifts (request_id, shift_date, started_at, ended_at, machine_hours,
                                          comment, filled_by, approved_by, approved_at)
      VALUES (${request}, ${ago(12)}, '08:00', '15:00', 7, '', ${ctx.adminId}, ${ctx.adminId}, now())`);
    Object.assign(scene, { hVehicle: vehicle, hRequest: request });
  }

  // I. A chain gap: the middle route day of the vehicle has no reading, so the third day's start is
  //    the first day's snapshot, and the pair is broken by the garage's rule.
  {
    const person = await newPerson('Разрывов');
    const vehicle = await newVehicle();
    const days = [ago(15), ago(14), ago(13)];
    const requests: string[] = [];
    for (const day of days) {
      const request = await freight(day, 'бетон');
      requests.push(request.id);
      await route(vehicle, person.id, day, [{ requestId: request.id }]);
    }
    await submitDay(person.id, ago(15), values({ odometerKm: 2000 }));
    await submitDay(person.id, ago(13), values({ odometerKm: 2300 }));
    Object.assign(scene, { iVehicle: vehicle, iLast: requests[2]! });
  }

  // J. A reading attributed to the request on a day outside its term.
  {
    const person = await newPerson('Внесрочный');
    const vehicle = await newVehicle();
    const request = await special(vehicle, ago(17), ago(16));
    await esm2(request, vehicle, person.id, ago(18));
    await submitDay(person.id, ago(18), values({ engineHours: 40 }));
    Object.assign(scene, { jVehicle: vehicle, jRequest: request });
  }
}

describe.skipIf(!DB_URL)('строки книги показаний по дням заявок (живая схема)', () => {
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

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
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyMigrations(client);
    } finally {
      await client.end();
    }
    prepareEnv(OWN_DB!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const readings = await import('../src/services/readings');
    const rows = await import('../src/services/readings-report-rows');

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
      VALUES (${`яя-report-${RUN}`}, ${`Площадка книги ${RUN}`}, 'г Москва, ул Отчётная, д 1')
      RETURNING id`);
    const lessor = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('vehicle_lessor', ${`Арендодатель книги ${RUN}`}, '7700000099') RETURNING id`);
    const user = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
      VALUES (${`db-report-admin-${RUN}@example.invalid`}, 'Диспетчеров', 'Иван', 'Петрович',
              'x', 'admin'::role, true)
      RETURNING id`);

    ctx = {
      db,
      schema,
      readings,
      rows,
      closeDb,
      adminId: user.rows[0]!.id,
      objectId: object.rows[0]!.id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: seriesRows.rows[0].id,
      lessorId: lessor.rows[0]!.id,
    };
    await buildScene();
    report = await rows.loadReportRows(ago(20), ago(-3), TODAY);
  });

  afterAll(async () => {
    await ctx?.closeDb();
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('общий рейс: счётчики в строке заявки с первой остановкой, у остальных — пометка рейса', () => {
    const rows = rowsOf(scene.aVehicle!);
    expect(rows.map((row) => row.request?.id).sort()).toEqual(
      [scene.aF1, scene.aF2, scene.aLinear].sort(),
    );
    const carrier = rows.find((row) => row.request?.id === scene.aLinear)!;
    expect(carrier.readings.map((reading) => reading.odometer.value)).toEqual([1200]);
    expect(carrier.sharedRoutes).toEqual([]);
    for (const id of [scene.aF1, scene.aF2]) {
      const row = rows.find((candidate) => candidate.request?.id === id)!;
      expect(row.readings).toEqual([]);
      expect(row.sharedRoutes).toEqual([`Р-${sharedRouteNum}`]);
      // The person who drove the route is the person of every row it carries.
      expect(row.readingPersons).toEqual(['Отчётов Общий Сменович']);
    }
    // The freight rows know their trips and cargo; the linear day is a special-equipment day.
    expect(rows.find((row) => row.request?.id === scene.aF1)!.request!.trips).toEqual([
      { from: 'Карьер', to: 'Площадка', cargo: 'щебень' },
    ]);
    expect(carrier.request!.type).toBe('special_equipment');
    expect(carrier.outOfTerm).toBe(false);
  });

  it('неделя ЭСМ-2: строка на каждый день срока, показания там, где их сдали', () => {
    const rows = rowsOf(scene.bVehicle!);
    expect(rows.map((row) => row.date)).toEqual([ago(9), ago(8), ago(7), ago(6), ago(5)]);
    expect(rows.every((row) => row.kind === 'request' && row.request?.id === scene.bRequest)).toBe(
      true,
    );
    expect(rows.map((row) => row.readings.length)).toEqual([1, 1, 0, 1, 0]);
    const second = rows[1]!.readings[0]!;
    expect(second.odometer).toMatchObject({ value: 5040, previous: 5000, previousDate: ago(9) });
    expect(second.engineHours).toMatchObject({ value: 108, previous: 100 });
    // A day without a reading still names the machinist of its sheet.
    expect(rows[2]!.sourcePerson).toBe(scene.bPerson);
    expect(rows[0]!.request!.authorName).toBe('Диспетчеров Иван Петрович');
  });

  it('перегон: строка тягача под заявкой-источником, сама машина заявки — своими днями', () => {
    const carrierRows = rowsOf(scene.cCarrier!);
    expect(carrierRows).toHaveLength(1);
    expect(carrierRows[0]).toMatchObject({
      kind: 'relocation',
      date: ago(4),
      relocation: { from: 'База', to: 'Площадка' },
    });
    expect(carrierRows[0]!.request?.id).toBe(scene.cRequest);
    expect(carrierRows[0]!.readings.map((reading) => reading.odometer.value)).toEqual([30_000]);
    const unitRows = rowsOf(scene.cUnit!);
    expect(unitRows.map((row) => [row.kind, row.date, row.readings.length])).toEqual([
      ['request', ago(4), 0],
      ['request', ago(3), 0],
    ]);
  });

  it('показание отменённой заявки — строка «без заявки» своей машины с источником', () => {
    const rows = rowsOf(scene.dVehicle!);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'noRequest', date: ago(6), request: null });
    expect(rows[0]!.sourceLabel).toContain(String(waybillOfCancelled));
    expect(rows[0]!.readings.map((reading) => reading.odometer.value)).toEqual([700]);
  });

  it('две машины в один день заявки — строка на машину с пометкой замены', () => {
    const first = rowsOf(scene.eVehicle1!);
    const second = rowsOf(scene.eVehicle2!);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({ swapped: true, date: ago(3) });
    expect(second[0]).toMatchObject({ swapped: true, date: ago(3) });
    expect(second[0]!.request?.id).toBe(scene.eRequest);
  });

  it('аннулированный отчёт не считается, а дни после сегодняшнего не строки', () => {
    const rows = rowsOf(scene.fVehicle!);
    expect(rows.map((row) => row.date)).toEqual([ago(2), ago(1), ago(0)]);
    expect(rows.every((row) => row.readings.length === 0)).toBe(true);
    expect(report.coveredTo).toBe(TODAY);
  });

  it('арендная машина: строки со ставками назначения и подписанной сменой площадки', () => {
    const rows = rowsOf(scene.hVehicle!);
    expect(rows.map((row) => row.date)).toEqual([ago(12), ago(11)]);
    expect(rows[0]!.vehicle).toMatchObject({
      ownership: 'rental',
      lessorName: `Арендодатель книги ${RUN}`,
    });
    expect(rows[0]!.request!.assignment).toEqual({
      pricePerHour: 2500,
      pricePerShift: null,
      shiftHours: 8,
    });
    expect(rows[0]!.shift).toEqual({
      machineHours: 7,
      signed: true,
      startedAt: '08:00',
      endedAt: '15:00',
    });
    expect(rows[1]!.shift).toBeNull();
  });

  it('разрыв ряда: начало от прежнего снимка, пара отмечена разорванной', () => {
    const rows = rowsOf(scene.iVehicle!);
    expect(rows.map((row) => [row.date, row.readings.length])).toEqual([
      [ago(15), 1],
      [ago(14), 0],
      [ago(13), 1],
    ]);
    const last = rows[2]!.readings[0]!;
    expect(last.odometer).toMatchObject({
      value: 2300,
      previous: 2000,
      previousDate: ago(15),
      continuous: false,
    });
    expect(rows[2]!.request?.id).toBe(scene.iLast);
  });

  it('показание вне срока заявки — строка той же заявки на свою дату с пометкой', () => {
    const rows = rowsOf(scene.jVehicle!);
    expect(rows.map((row) => [row.date, row.outOfTerm, row.readings.length])).toEqual([
      [ago(18), true, 1],
      [ago(17), false, 0],
      [ago(16), false, 0],
    ]);
    expect(rows.every((row) => row.request?.id === scene.jRequest)).toBe(true);
  });
});
