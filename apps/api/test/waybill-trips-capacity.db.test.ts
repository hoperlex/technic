import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  formatVehicleRequestNumber,
  moscowDateKeyOf,
  ROUTE_REQUEST_CAPACITY,
  type WaybillDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRouteWaybill } from './waybill-issue-helper';
// Types only: the modules are imported with `await import` after the environment is set — the
// config reads it on import and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Printed trips, the issue check, and one count of the form's capacity (ADR 0108 items 11, 20, 21;
 * roadmap item F4) — on the live schema and through the real doors.
 *
 * Two subjects, one file, because they share the scene: a route whose task rows outnumber its
 * requests.
 *
 * 1. The sheet answer carries what the issue wrote and nobody read until now: `waybill_trips`
 *    (which trip is which printed row) and `issue_warnings` (under what the number was spent).
 *    Losing a join shows only in the server answer — the journal stays green and goes silent.
 * 2. The form's capacity is refused by task rows on every path that spends a number, now that
 *    `canIssueWaybill` no longer counts requests. Each door is driven into an overfull form and
 *    must refuse with the `capacity_exceeded` blocker, without a new sheet and — for the
 *    correction and the transfer — before the live sheet is cancelled. The day batch is not here:
 *    it places a day only after the row count passed (`assertRoutePlacement`), and its own file
 *    covers the room checks.
 *
 * Run (the file migrates the database itself):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_test \
 *     npx vitest run test/waybill-trips-capacity.db.test.ts
 *
 * Skipped without `TEST_DATABASE_URL`.
 */

/**
 * Sheets the correction cancelled, recorded by a pass-through wrapper. The refusal tests below
 * must prove the preflight stopped the operation BEFORE the first cancellation: after the cancel
 * the issue point refuses the same overfull form with the same 422 and the transaction rolls back,
 * so the response and the database look identical either way and only a call count tells them
 * apart.
 */
const cancelled = vi.hoisted(() => ({ waybillIds: [] as string[] }));
vi.mock('../src/services/waybill-correction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/waybill-correction')>();
  return {
    ...actual,
    cancelWaybillForCorrection: async (
      ...args: Parameters<typeof actual.cancelWaybillForCorrection>
    ) => {
      cancelled.waybillIds.push(args[1].waybillId);
      return actual.cancelWaybillForCorrection(...args);
    },
  };
});

const DB_URL = process.env.TEST_DATABASE_URL;

const PASSWORD = 'db-test-password-123';
const ADMIN_EMAIL = 'db-waybill-trips-capacity-admin@example.invalid';

/** Run suffix: directory codes are unique and the database outlives runs. */
const RUN = Date.now().toString(36);
/** «яя» keeps the test site last for the files that take the first site by `ORDER BY … LIMIT 1`. */
const OBJECT_CODE = `яя-f4-trips-${RUN}`;
const TYPE_PREFIX = `f4_trips_${RUN}`;
/** Marks the people and the vehicle of this file: cleanup removes them by it. */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: ездки листа и ёмкость бланка';

/** Invented contacts, unlike anyone's digits — the database is shared. */
const LOADING = { name: 'Погрузов Аркадий Львович', phone: '9007770781' };
const UNLOADING = { name: 'Разгрузов Виктор Олегович', phone: '9007770782' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: { authorization: string };
  objectId: string;
  objectAddress: string;
  /** Two fleet trucks on 4-P (capacity 7): the target of a correction and both transfer routes. */
  truckId: string;
  otherTruckId: string;
  /** Own vehicle of an own type on form No. 3 (capacity 10): the route assembled wider than 4-P. */
  wideVehicleId: string;
  wideTypeId: string;
  plainTypeId: string;
  driverId: string;
  today: string;
}

let ctx: Ctx;

const createdRequests: string[] = [];
const createdRoutes: string[] = [];

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

async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (existing) return;
  await db.insert(schema.users).values({
    email: ADMIN_EMAIL,
    lastName: 'Тестовый',
    firstName: 'admin',
    middleName: '',
    passwordHash: await hashPassword(PASSWORD),
    role: 'admin',
    isActive: true,
  });
}

/**
 * A driver with the specialization only: no documents, so every issue here raises the
 * `driver_documents` warning and the sheet is born `acknowledged` — the state the journal must
 * show with its texts.
 */
async function seedDriver(): Promise<string> {
  const { db } = await import('../src/db/client');
  const schema = await import('../src/db/schema');
  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  if (!specialization) throw new Error('в справочнике нет специализации «водитель»');
  const [person] = await db
    .insert(schema.persons)
    .values({ lastName: 'Ездков', firstName: 'Тест', middleName: 'Листовой', comment: MARK })
    .returning({ id: schema.persons.id });
  await db.insert(schema.personSpecializations).values({
    personId: person!.id,
    specializationId: specialization.id,
    isPrimary: true,
    startedOn: '2024-01-15',
  });
  return person!.id;
}

async function createType(kindId: string, suffix: string, form: '4p' | 'leg3'): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.admin,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}_${suffix}`,
      name: `Самосвалы ёмкости ${suffix} ${RUN}`,
      isLinear: false,
      waybillFormCode: form,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function approve(request: { id: string; version: number }): Promise<number> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.admin,
    payload: { approved: true, version: request.version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

/** `count` identical trips: rows of the task, not requests, are what fill the form. */
function trips(count: number) {
  return Array.from({ length: count }, () => ({
    fromLocation: ctx.objectAddress,
    toLocation: ctx.objectAddress,
    fromAddress: { source: 'object', refId: ctx.objectId },
    toAddress: { source: 'object', refId: ctx.objectId },
    volumeM3: 12,
    fromResponsibleName: LOADING.name,
    fromResponsiblePhone: LOADING.phone,
    toResponsibleName: UNLOADING.name,
    toResponsiblePhone: UNLOADING.phone,
  }));
}

/** A freight request taken into work on `vehicleId`, into its own new route or into `routeId`. */
async function freightInProgress(params: {
  vehicleId: string;
  trips: number;
  routeId?: string;
}): Promise<{ id: string; routeId: string; num: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.admin,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.plainTypeId,
      scheduledAt: `${ctx.today}T10:00:00+03:00`,
      trips: trips(params.trips),
      comment: 'Щебень',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();
  createdRequests.push(request.id as string);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.admin,
    payload: {
      status: 'confirmed',
      comment: '',
      version: await approve(request),
      assignment: {
        vehicleId: params.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        route: params.routeId
          ? { routeId: params.routeId }
          : { newRoute: { driverPersonId: ctx.driverId } },
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const dto = confirmed.json();
  expect(dto.route, confirmed.body).not.toBeNull();
  if (!params.routeId) createdRoutes.push(dto.route.id as string);
  return { id: request.id as string, routeId: dto.route.id as string, num: dto.num as number };
}

async function routeVersion(routeId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-routes/${routeId}`,
    headers: ctx.admin,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

/** A live sheet on the route, through the handshake (the driver's gaps always warn here). */
async function issueWaybill(routeId: string): Promise<string> {
  const { res } = await issueRouteWaybill({
    app: ctx.app,
    headers: ctx.admin,
    routeId,
    payload: { version: await routeVersion(routeId) },
  });
  return res.json().waybill.id as string;
}

/** The route's day moves into the past with its sheet — the state a correction finds it in. */
async function movePast(routeId: string, daysAgo: number): Promise<void> {
  const day = new Date(Date.now() - daysAgo * 86_400_000);
  const key = moscowDateKeyOf(day);
  await ctx.db.execute(sql`UPDATE vehicle_routes SET route_date = ${key} WHERE id = ${routeId}`);
  await ctx.db.execute(
    sql`UPDATE waybills SET issued_for_date = ${key} WHERE route_id = ${routeId}`,
  );
}

/** The directory edit after assembly (ADR 0065): the wide type goes to 4-P with its routes. */
async function setWideForm(form: '4p' | 'leg3'): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE vehicle_types SET waybill_form_code = ${form} WHERE id = ${ctx.wideTypeId}::uuid`,
  );
}

async function sheetsOf(routeId: string) {
  const rows = await ctx.db.execute<{ id: string; status: string; number: string }>(sql`
    SELECT id, status, number::text AS number FROM waybills
    WHERE route_id = ${routeId} ORDER BY number`);
  return rows.rows;
}

/** The blockers of a 422 — the machine list the portal routes the person by. */
function blockersOf(res: { statusCode: number; body: string }) {
  expect(res.statusCode, res.body).toBe(422);
  const body = JSON.parse(res.body) as { details?: { blockers?: { code: string }[] } };
  return body.details?.blockers ?? [];
}

describe.skipIf(!DB_URL)('ездки листа и ёмкость бланка строками задания (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    const trucks = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
      ORDER BY v.registration_number
      LIMIT 2`);
    const [first, second] = trucks.rows;
    if (!first || !second) throw new Error('в базе нет двух своих грузовых машин на 4-П');

    const objectAddress = 'г Москва, ул Ёмкостная, д 7';
    const object = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${OBJECT_CODE}, ${`Площадка ёмкости бланка ${RUN}`}, ${objectAddress})
      RETURNING id`);

    ctx = {
      app,
      db,
      closeDb,
      admin: { authorization: `Bearer ${login.json().accessToken}` },
      objectId: object.rows[0]!.id,
      objectAddress,
      truckId: first.id,
      otherTruckId: second.id,
      wideVehicleId: '',
      wideTypeId: '',
      plainTypeId: '',
      driverId: await seedDriver(),
      today: moscowDateKeyOf(new Date()),
    };
    ctx.plainTypeId = await createType(first.kind_id, 'plain', '4p');
    ctx.wideTypeId = await createType(first.kind_id, 'wide', 'leg3');
    const wide = await db.execute<{ id: string }>(sql`
      INSERT INTO vehicles (ownership, vehicle_type_id, registration_number, status, source_name)
      VALUES ('own', ${ctx.wideTypeId}, ${`F4W${RUN}`}, 'active', ${MARK})
      RETURNING id`);
    ctx.wideVehicleId = wide.rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    /*
     * The database is shared, so the file cleans up after itself, in reverse order of the
     * references: sheets hold routes and requests by RESTRICT keys, `waybill_trips` and the coupons
     * go with their sheets, the composition and trips with their requests.
     */
    if (ctx?.db) {
      const requests = sql.param(createdRequests);
      const routes = sql.param(createdRoutes);
      await ctx.db.execute(sql`DELETE FROM waybills WHERE route_id = ANY(${routes}::uuid[])`);
      await ctx.db.execute(sql`DELETE FROM vehicle_routes WHERE id = ANY(${routes}::uuid[])`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id = ANY(${requests}::uuid[])`);
      await ctx.db.execute(sql`
        DELETE FROM waybill_corrections
        WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
      await ctx.db.execute(sql`DELETE FROM vehicles WHERE source_name = ${MARK}`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_types
        WHERE code LIKE ${`${TYPE_PREFIX}%`}
          AND id NOT IN (SELECT vehicle_type_id FROM vehicle_requests)
          AND id NOT IN (SELECT vehicle_type_id FROM vehicles)`);
      await ctx.db.execute(sql`
        DELETE FROM construction_objects
        WHERE code = ${OBJECT_CODE}
          AND id NOT IN (SELECT object_id FROM vehicle_requests WHERE object_id IS NOT NULL)`);
      await ctx.db.execute(sql`
        DELETE FROM persons
        WHERE comment = ${MARK} AND id NOT IN (SELECT driver_person_id FROM waybills)`);
      await ctx.db.execute(sql`
        DELETE FROM audit_log
        WHERE actor_user_id IN (SELECT id FROM users WHERE email = ${ADMIN_EMAIL})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  /*
   * The sheet answer names its printed rows by trip and the check it was issued under, in the
   * single read and in the journal page alike — the two are built by one `toDto`, and a page that
   * lost the batch read would show the card with trips and the journal without them.
   */
  it('лист отдаёт напечатанные ездки по строкам и подтверждённые предупреждения', async () => {
    const request = await freightInProgress({ vehicleId: ctx.truckId, trips: 2 });
    const waybillId = await issueWaybill(request.routeId);

    const single = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills/${waybillId}`,
      headers: ctx.admin,
    });
    expect(single.statusCode, single.body).toBe(200);
    const sheet = single.json() as WaybillDto;
    const number = formatVehicleRequestNumber(request.num);
    // One coupon, two rows: the coupon answers whose work it is, the trips which row is which.
    expect(sheet.requests.map((link) => link.slot)).toEqual([1]);
    expect(sheet.trips.map((trip) => [trip.slot, trip.displayNumber, trip.deleted])).toEqual([
      [1, `${number}/1`, false],
      [2, `${number}/2`, false],
    ]);
    expect(sheet.trips.every((trip) => trip.requestId === request.id)).toBe(true);

    // The test driver has no documents: the number was spent under a confirmed warning, and the
    // journal reads it as the person read it — text and subject, no fingerprint, no ids.
    expect(sheet.issueWarnings.status).toBe('acknowledged');
    const codes = sheet.issueWarnings.warnings.map((warning) => warning.code);
    expect(codes).toContain('driver_documents');
    expect(sheet.issueWarnings.warnings.every((warning) => warning.message !== '')).toBe(true);
    expect(JSON.stringify(sheet.issueWarnings)).not.toContain(ctx.driverId);

    const page = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills?driverPersonId=${ctx.driverId}&pageSize=100`,
      headers: ctx.admin,
    });
    expect(page.statusCode, page.body).toBe(200);
    const row = (page.json().items as WaybillDto[]).find((item) => item.id === waybillId);
    expect(row?.trips).toEqual(sheet.trips);
    expect(row?.issueWarnings).toEqual(sheet.issueWarnings);
  }, 120_000);

  /*
   * A trip removed from its request after issue stays in the journal, marked (item 13a), and a
   * sheet whose column holds the default reads «not checked» — the state of every sheet issued
   * before migration 0136. Both are set by SQL: the first state needs a cancellation and a request
   * edit that are not the subject here, the second cannot be produced by today's code at all.
   */
  it('удалённая ездка остаётся в листе с пометкой, а умолчание колонки читается «не проверялся»', async () => {
    const request = await freightInProgress({ vehicleId: ctx.truckId, trips: 2 });
    const waybillId = await issueWaybill(request.routeId);
    await ctx.db.execute(sql`
      UPDATE vehicle_request_trips SET deleted_at = now()
      WHERE request_id = ${request.id} AND num = 2`);
    await ctx.db.execute(sql`UPDATE waybills SET issue_warnings = DEFAULT WHERE id = ${waybillId}`);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills/${waybillId}`,
      headers: ctx.admin,
    });
    expect(res.statusCode, res.body).toBe(200);
    const sheet = res.json() as WaybillDto;
    expect(sheet.trips.map((trip) => [trip.slot, trip.deleted])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(sheet.issueWarnings).toEqual({ status: 'not_checked', warnings: [] });
  }, 120_000);

  /*
   * The issue door. A route assembled on form No. 3 and moved to 4-P by the directory: nine rows
   * of two requests (the request count would have let it through), and eight one-trip requests
   * (the request count used to refuse them itself). Both are refused by the row count before a
   * number is taken: no sheet is born.
   */
  it('обычная выписка отказывает переполненному бланку строками задания, номера не тратит', async () => {
    await setWideForm('leg3');
    const mixed = await freightInProgress({ vehicleId: ctx.wideVehicleId, trips: 5 });
    await freightInProgress({ vehicleId: ctx.wideVehicleId, trips: 4, routeId: mixed.routeId });

    const many = await freightInProgress({ vehicleId: ctx.wideVehicleId, trips: 1 });
    for (let i = 1; i < ROUTE_REQUEST_CAPACITY['4p'] + 1; i += 1) {
      await freightInProgress({ vehicleId: ctx.wideVehicleId, trips: 1, routeId: many.routeId });
    }

    await setWideForm('4p');
    try {
      for (const [routeId, rows] of [
        [mixed.routeId, 9],
        [many.routeId, ROUTE_REQUEST_CAPACITY['4p'] + 1],
      ] as const) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/vehicle-routes/${routeId}/waybill`,
          headers: ctx.admin,
          payload: { version: await routeVersion(routeId) },
        });
        // Blockers come before the handshake: no acknowledgement is asked for a sheet that will
        // not be issued, so the very first answer is the refusal.
        expect(blockersOf(res)).toEqual([
          { code: 'capacity_exceeded', rows, capacity: ROUTE_REQUEST_CAPACITY['4p'] },
        ]);
        expect(await sheetsOf(routeId)).toEqual([]);
      }
    } finally {
      await setWideForm('leg3');
    }
  }, 180_000);

  /*
   * The correction door. A past route of one request with eight trips, issued on form No. 3, is
   * corrected onto a 4-P truck: the prospective form holds seven rows. The preflight refuses
   * before the live sheet is cancelled (R36) — with the issue point's own answer — and the sheet
   * stays issued under its number.
   */
  it('коррекция на машину с меньшим бланком отказывает до аннулирования, лист цел', async () => {
    await setWideForm('leg3');
    const request = await freightInProgress({ vehicleId: ctx.wideVehicleId, trips: 8 });
    await issueWaybill(request.routeId);
    await movePast(request.routeId, 2);
    const before = await sheetsOf(request.routeId);
    expect(before.map((sheet) => sheet.status)).toEqual(['issued']);

    cancelled.waybillIds.length = 0;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-routes/${request.routeId}/correction`,
      headers: ctx.admin,
      payload: {
        version: await routeVersion(request.routeId),
        operationId: crypto.randomUUID(),
        reason: 'Ехал самосвал, а не машина снабжения',
        vehicleId: ctx.truckId,
      },
    });
    expect(blockersOf(res)).toEqual([
      { code: 'capacity_exceeded', rows: 8, capacity: ROUTE_REQUEST_CAPACITY['4p'] },
    ]);
    expect(await sheetsOf(request.routeId)).toEqual(before);
    expect(cancelled.waybillIds).toEqual([]);
  }, 180_000);

  /*
   * The transfer door. The target has one request of six trips on 4-P; the ticket moved in brings
   * two more. The request count of the old preflight saw two requests in a seven-row form and let
   * the operation cancel both sheets; the row count refuses before either is touched.
   */
  it('перенос талона в рейс без места под его ездки отказывает до аннулирования обоих листов', async () => {
    const arrived = await freightInProgress({ vehicleId: ctx.otherTruckId, trips: 6 });
    const moving = await freightInProgress({ vehicleId: ctx.truckId, trips: 2 });
    await issueWaybill(arrived.routeId);
    await issueWaybill(moving.routeId);
    await movePast(arrived.routeId, 2);
    await movePast(moving.routeId, 3);
    const before = {
      target: await sheetsOf(arrived.routeId),
      source: await sheetsOf(moving.routeId),
    };

    cancelled.waybillIds.length = 0;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-routes/${arrived.routeId}/correction/transfer`,
      headers: ctx.admin,
      payload: {
        operationId: crypto.randomUUID(),
        version: await routeVersion(arrived.routeId),
        source: { routeId: moving.routeId, version: await routeVersion(moving.routeId) },
        requestId: moving.id,
        reason: 'Ездки уехали соседним рейсом',
      },
    });
    expect(blockersOf(res)).toEqual([
      { code: 'capacity_exceeded', rows: 8, capacity: ROUTE_REQUEST_CAPACITY['4p'] },
    ]);
    expect(await sheetsOf(arrived.routeId)).toEqual(before.target);
    expect(await sheetsOf(moving.routeId)).toEqual(before.source);
    expect(cancelled.waybillIds).toEqual([]);
    const stayed = await ctx.db.execute<{ route_id: string }>(sql`
      SELECT route_id FROM vehicle_route_requests WHERE request_id = ${moving.id}`);
    expect(stayed.rows.map((row) => row.route_id)).toEqual([moving.routeId]);
  }, 180_000);
});
