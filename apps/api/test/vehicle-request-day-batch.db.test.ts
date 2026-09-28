import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  DAY_BATCH_LIMIT,
  DAY_BATCH_SKIP_AMBIGUOUS_ROUTE,
  DAY_BATCH_SKIP_BACKDATED,
  DAY_BATCH_SKIP_BEYOND_LIMIT,
  DAY_BATCH_SKIP_FROZEN,
  DAY_BATCH_SKIP_NO_ROOM,
  DAY_BATCH_SKIP_PLANNED,
  ROLLBACK_WAYBILL_MESSAGE,
  WAYBILL_CORRECTION_DAYS,
  moscowDateKeyOf,
  shiftDateKey,
  type VehicleRequestDayBatchResultDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRouteWaybill } from './waybill-issue-helper';
// Types only: the values of these modules are taken through `await import` once the environment is
// set — the config checks it at import time and crashes without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * The «4-П for the whole term» batch of a special-equipment request on a site —
 * `POST /vehicle-requests/:id/days/batch`
 * ([ADR 0207](../../../docs/adr/0207-vehicle-request-day-batch.md), plan
 * [docs/vehicle-request-day-batch-plan.md](../../../docs/vehicle-request-day-batch-plan.md)).
 *
 * WHY A LIVE DATABASE. The subject of the batch is not a rule but a SEQUENCE OF WRITES: its own
 * transaction per day (§8), the «Р-» numbers and the blank numbers that never return to their
 * sequences, the lazy corrections journal row (§9) and the retry by operation key. None of that is
 * reproducible on rules: where the batch errs, the code and the database drift apart, and the price
 * of the error is paper issued and never named.
 *
 * What is proven here:
 *
 * - **linearity no longer bars the door** (§1): the term of a NON-LINEAR request passes whole, and
 *   for the same day its weekly ESM-2 stays — double paper is named as boundary G1, not as a defect
 *   (§2);
 * - **the report is per-day and the counters add up** — the header "issued N, skipped M" is read
 *   where the rows are not shown at all;
 * - **a conflicting day is skipped while the batch goes on** (§7) — and each of the five obstacles
 *   is named IN ITS OWN WORDS: the day is already in a route, the vehicle has two routes, the route
 *   is frozen by a waybill, the blank has run out of task rows, the past without the right or
 *   deeper than the limit;
 * - **a frozen route is not bypassed with a second route** — otherwise the vehicle would hold two
 *   blanks for one day's work;
 * - **past days go under one operation** (§9): the `waybill_corrections` row of kind `day_batch` is
 *   one per batch, is opened lazily and marks every waybill it gave birth to with the reason;
 * - **the pre-check stands before the first write**: a refusal of the batch leaves not a row in
 *   `vehicle_routes`, that is, burns no «Р-» numbers (the ADR 0207 consequence about ragged numbers
 *   is about a batch broken off midway, not about a refusal at the entrance);
 * - **a long term is walked in portions** (§11): a click takes the first `DAY_BATCH_LIMIT`
 *   unplanned days and names the remainder, and a second click picks up the tail — days already
 *   done take up no room;
 * - **a retry by operation key continues the work instead of issuing a second stack**.
 *
 * ITS OWN DATABASE. The file creates a database of its own and drops it behind itself: the shared
 * db-test database lies in both directions (the header of `apps/api/scripts/quality-db.ts`), while
 * the batch counts the routes OF A VEHICLE ON A DATE — somebody else's route, created by a
 * neighbouring file on the same unit and the same day, would turn "zero candidates" into "there are
 * several" and paint an innocent red. Only the cluster is taken from `TEST_DATABASE_URL`.
 *
 * To run:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm --filter @technic/api exec vitest run vehicle-request-day-batch.db
 */

const DB_URL = process.env.TEST_DATABASE_URL;
/**
 * The name of its own database is DERIVED from the main one — `<main>_day_batch`, not a constant.
 *
 * The cleanup of `pnpm check:db` drops the run's database together with everything named `<main>_%`
 * (`apps/api/scripts/quality-db.ts`): a run broken off never reaches its own `afterAll`, and a
 * database with a constant name would outlive it while being indistinguishable from a foreign one
 * from the outside. A derived name makes "drops it behind itself" true for a run killed midway too.
 */
const OWN_DB_NAME = `${DB_URL?.replace(/^.*\//, '') ?? ''}_day_batch`;
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const PASSWORD = 'db-day-batch-password-123';
/** The run's suffix: the database is its own, yet directory codes are unique inside it as well. */
const RUN = randomUUID().slice(0, 8);
/**
 * The site code starts with «яя»: half the code picks an object by an `ORDER BY … LIMIT 1`
 * expression, and a record that became the first one would carry other people's requests off to the
 * test site. The vehicle type uses the same device in its name: its code is Latin only.
 */
const OBJECT_CODE = `яя-day-batch-${RUN}`;
const TYPE_PREFIX = `day_batch_${RUN}`;

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** The administrator: he builds the scenes, and the past beyond the limit is asked of him. */
  admin: Auth;
  /** Dispatcher: `waybills.correct` granted, `waybills.correctBeyondLimit` not (ADR 0101 §4). */
  dispatcher: Auth;
  /** The manager — the past is not for him at all: he is what proves past days get skipped. */
  manager: Auth;
  objectId: string;
  driverId: string;
  /** A non-linear type: it is the one ADR 0207 §1 unlocked the door for. */
  plainTypeId: string;
  /** The linear type — scenes are built with it: the portal issues no weekly ESM-2 for it. */
  linearTypeId: string;
  /**
   * Own freight vehicles with the 4-П blank — one per case.
   *
   * Different vehicles for different cases are not tidiness but a condition: a route belongs to the
   * pair "vehicle + date", and two cases on one unit over the same days would see each other's
   * routes — "zero candidates" would turn into "there are several" depending on the order of tests.
   */
  vehicles: string[];
  /** A vehicle taken off the line: the refusal of the pre-check is proven with it. */
  inactiveVehicleId: string;
  /** A rental vehicle: a request like that never has days at all. */
  rentalVehicleId: string;
  today: string;
}

let ctx: Ctx;

/** The config is read at import, so the environment is set before any `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 takes no part in this scenario, but the config demands it — the stubs are knowingly dead.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED ??= 'false';
}

/** Its own database from scratch: created, migrated and dropped in `afterAll`. */
async function createOwnDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_DB });
  await admin.connect();
  try {
    // `FORCE` is against connections of a PREVIOUS run abandoned by a crashed or killed process:
    // without it the remains of yesterday's session keep the database from being created, and the
    // file goes red through no fault of its own.
    await admin.query(`DROP DATABASE IF EXISTS "${OWN_DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${OWN_DB_NAME}"`);
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
}

async function seedUser(role: 'admin' | 'dispatcher' | 'manager'): Promise<string> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const email = `db-day-batch-${role}@example.invalid`;
  await db.execute(sql`
    INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
    VALUES (${email}, 'Тестовый', ${role}, '', ${await hashPassword(PASSWORD)}, ${role}::role, true)`);
  return email;
}

/**
 * The route's driver: a person with the "driver" specialization. No licences are created — the
 * selection sets one condition, "the person exists and he is a driver" (ADR 0064), while gaps in
 * the documents turn into issue warnings, and those are exactly the ones the batch confirms for the
 * human itself (§10).
 */
async function seedDriver(): Promise<string> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    WITH person AS (
      INSERT INTO persons (last_name, first_name, middle_name, comment)
      VALUES ('Пачкин', 'Тест', 'Дневной', 'ТЕСТОВЫЕ ДАННЫЕ: пачка дней заказа')
      RETURNING id
    ), link AS (
      INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
      SELECT person.id, s.id, true, '2024-01-15'
        FROM person, specializations s
       WHERE s.code = 'driver'
      RETURNING person_id
    )
    SELECT id FROM person`);
  return rows.rows[0]!.id;
}

// ── Calls to the portal ──

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

/** The head's approval: without it a request is not taken into work. */
async function approve(request: { id: string; version: number }): Promise<number> {
  const res = await inject('PATCH', `/api/v1/vehicle-requests/${request.id}/approval`, ctx.admin, {
    approved: true,
    version: request.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

interface RequestOptions {
  typeId?: string;
  vehicleId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** The declared past: without it the request schema will not pass yesterday's term. */
  backdateReason?: string;
  /** The rate: for a rental vehicle an assignment without money is not accepted at all. */
  pricePerHour?: number;
}

/** A special-equipment request on a site brought into work: the start of almost every case. */
async function requestInProgress(
  options: RequestOptions = {},
): Promise<{ id: string; version: number; dateFrom: string; dateTo: string }> {
  const typeId = options.typeId ?? ctx.plainTypeId;
  const vehicleId = options.vehicleId ?? ctx.vehicles[0]!;
  const dateFrom = options.dateFrom ?? ctx.today;
  const dateTo = options.dateTo ?? shiftDateKey(dateFrom, 3);

  const created = await inject('POST', '/api/v1/vehicle-requests', ctx.admin, {
    requestType: 'special_equipment',
    objectId: ctx.objectId,
    vehicleTypeId: typeId,
    dateFrom,
    dateTo,
    responsibleName: 'Прорабов Пётр Петрович',
    responsiblePhone: '9007770761',
    comment: 'Планировка площадки',
    ...(options.backdateReason
      ? { backdateReason: options.backdateReason, operationId: randomUUID() }
      : {}),
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();

  const confirmed = await inject(
    'PATCH',
    `/api/v1/vehicle-requests/${request.id}/status`,
    ctx.admin,
    {
      status: 'confirmed',
      comment: '',
      version: await approve(request),
      assignment: {
        vehicleId,
        pricePerHour: options.pricePerHour ?? null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.driverId,
      },
      schedule: { requestType: 'special_equipment', dateFrom, dateTo },
    },
  );
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return {
    id: request.id as string,
    version: confirmed.json().version as number,
    dateFrom,
    dateTo,
  };
}

/** An empty route on a date — it builds the scenes "a route already exists" and "there are two". */
async function createRoute(vehicleId: string, routeDate: string): Promise<string> {
  const created = await inject('POST', '/api/v1/vehicle-routes', ctx.admin, {
    vehicleId,
    routeDate,
    driverPersonId: ctx.driverId,
    trip: { communicationKind: 'городское' },
    // A past route date needs an explanation (ADR 0101 §4); on a future one the reason is ignored.
    reason: 'подготовка обстановки теста',
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().id as string;
}

/** The route as the card sees it: issue needs the version, report rows need the number. */
async function routeOf(routeId: string): Promise<{ version: number; displayNumber: string }> {
  const res = await inject('GET', `/api/v1/vehicle-routes/${routeId}`, ctx.admin);
  expect(res.statusCode, res.body).toBe(200);
  return {
    version: res.json().version as number,
    displayNumber: res.json().displayNumber as string,
  };
}

/**
 * Issue a waybill on the route — that is what freezes the route.
 *
 * Through the helper: the subject of the case is the fate of a day under paper already issued, not
 * the issue itself, and the handshake (ADR 0108 §21) always fires here — no documents are created
 * for the test driver.
 */
async function freezeRoute(routeId: string): Promise<void> {
  await issueRouteWaybill({
    app: ctx.app,
    headers: { ...ctx.admin },
    routeId,
    payload: { version: (await routeOf(routeId)).version },
  });
}

/** Place one day through the per-day door — the very door whose rules the batch repeats. */
async function planDay(
  requestId: string,
  date: string,
  target: { routeId: string } | { vehicleId: string },
): Promise<LightMyRequestResponse> {
  const payload =
    'routeId' in target
      ? { routeId: target.routeId, reason: 'подготовка обстановки теста' }
      : {
          newRoute: { vehicleId: target.vehicleId, driverPersonId: ctx.driverId },
          reason: 'подготовка обстановки теста',
        };
  return inject(
    'POST',
    `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    ctx.admin,
    payload,
  );
}

interface BatchBody {
  driverPersonId?: string;
  issueWaybills?: boolean;
  reason?: string;
  operationId?: string;
}

function batch(
  requestId: string,
  body: BatchBody = {},
  auth: Auth = ctx.admin,
): Promise<LightMyRequestResponse> {
  return inject('POST', `/api/v1/vehicle-requests/${requestId}/days/batch`, auth, {
    driverPersonId: ctx.driverId,
    issueWaybills: true,
    ...body,
  });
}

/** A batch that was obliged to pass: 200 and a parsed report. */
async function batchOk(
  requestId: string,
  body: BatchBody = {},
  auth: Auth = ctx.admin,
): Promise<VehicleRequestDayBatchResultDto> {
  const res = await batch(requestId, body, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as VehicleRequestDayBatchResultDto;
}

// ── Questions to the database ──

/** How many routes the vehicle has on a date: it proves whether a «Р-» number was burnt. */
async function routeCount(vehicleId: string, date: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM vehicle_routes
     WHERE vehicle_id = ${vehicleId} AND route_date = ${date}`);
  return rows.rows[0]!.n;
}

/** All routes of this vehicle, however many days pass: "not a single row" is counted by them. */
async function routesOfVehicle(vehicleId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM vehicle_routes WHERE vehicle_id = ${vehicleId}`);
  return rows.rows[0]!.n;
}

interface DayWaybillRow {
  id: string;
  number: string;
  formCode: string;
  status: string;
  issuedForDate: string;
  correctionId: string | null;
  correctionReason: string;
}

/** Waybills issued on the routes of this request's days, ordered by the day they cover. */
async function dayWaybills(requestId: string): Promise<DayWaybillRow[]> {
  const rows = await ctx.db.execute<{
    id: string;
    number: string;
    form_code: string;
    status: string;
    issued_for_date: string;
    correction_id: string | null;
    correction_reason: string;
  }>(sql`
    SELECT w.id::text AS id, w.number::text AS number, w.form_code, w.status::text AS status,
           w.issued_for_date::text AS issued_for_date, w.correction_id::text AS correction_id,
           w.correction_reason
      FROM waybills w
      JOIN vehicle_route_requests rr ON rr.route_id = w.route_id
     WHERE rr.request_id = ${requestId}
     ORDER BY w.issued_for_date`);
  return rows.rows.map((row) => ({
    id: row.id,
    number: row.number,
    formCode: row.form_code,
    status: row.status,
    issuedForDate: row.issued_for_date,
    correctionId: row.correction_id,
    correctionReason: row.correction_reason,
  }));
}

/** Weekly ESM-2 waybills of the request: they prove the batch left them alone (§2, boundary G1). */
async function esm2Count(requestId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM waybills
     WHERE source_request_id = ${requestId} AND form_code = 'esm2' AND status <> 'cancelled'`);
  return rows.rows[0]!.n;
}

/**
 * The request as its card reads it: `hasActiveWaybill` and the version the status door wants.
 * Read through the HTTP door on purpose — the flag is a column of the list/card selection, and a
 * direct query would re-derive it rather than test the one the portal gets.
 */
async function requestCard(
  requestId: string,
): Promise<{ hasActiveWaybill: boolean; version: number }> {
  const res = await inject('GET', `/api/v1/vehicle-requests/${requestId}`, ctx.admin);
  expect(res.statusCode, res.body).toBe(200);
  return {
    hasActiveWaybill: res.json().hasActiveWaybill as boolean,
    version: res.json().version as number,
  };
}

/** Rolling the request back to «Новая» — the move `hasActiveWaybill` warns about in advance. */
function rollbackToNew(requestId: string, version: number): Promise<LightMyRequestResponse> {
  return inject('PATCH', `/api/v1/vehicle-requests/${requestId}/status`, ctx.admin, {
    status: 'new',
    comment: 'машина ушла на другой объект',
    version,
  });
}

/** Corrections journal rows by operation key: there must be exactly one of them per batch. */
async function correctionsOf(
  operationId: string,
): Promise<{ id: string; kind: string; reason: string; payload: Record<string, unknown> }[]> {
  const rows = await ctx.db.execute<{
    id: string;
    kind: string;
    reason: string;
    payload: Record<string, unknown>;
  }>(sql`
    SELECT id::text AS id, kind, reason, payload FROM waybill_corrections
     WHERE operation_id = ${operationId}`);
  return rows.rows;
}

/** The requests the operation touched: by this link the investigation card finds it. */
async function linkedRequests(correctionId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ request_id: string }>(sql`
    SELECT request_id::text AS request_id FROM vehicle_request_corrections
     WHERE correction_id = ${correctionId}`);
  return rows.rows.map((row) => row.request_id);
}

/** The route composition rows: the blank's task capacity is counted by them. */
async function routeRequestCount(routeId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM vehicle_route_requests WHERE route_id = ${routeId}`);
  return rows.rows[0]!.n;
}

describe.skipIf(!DB_URL)('пачка «4-П на весь период» (живая схема)', () => {
  /*
   * Terms here are measured in tens of transactions: every day of the batch is its own transaction
   * with a blank number under `FOR UPDATE` (§8), while the setup creates requests through the real
   * handles. The five-second default limit of vitest is not meant for that.
   */
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 900_000 });

  beforeAll(async () => {
    await createOwnDatabase();
    prepareEnv(OWN_DB!);

    const { db, closeDb } = await import('../src/db/client');
    const adminEmail = await seedUser('admin');
    const dispatcherEmail = await seedUser('dispatcher');
    const managerEmail = await seedUser('manager');
    const driverId = await seedDriver();

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${OBJECT_CODE}, ${`Площадка пачки дней ${RUN}`}, 'г Москва, ул Дневная, д 5')
      RETURNING id`);

    /*
     * Vehicles come from the directory: migrations fill it, and a route is created only for an own
     * active unit. The freight kind with the 4-П blank is the very document a day prints.
     */
    const own = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
         AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
       ORDER BY v.registration_number
       LIMIT 16`);
    if (own.rows.length < 16) {
      throw new Error('в базе нет шестнадцати своих грузовых машин с 4-П: миграции не применены');
    }
    const kindId = own.rows[0]!.kind_id;

    const rental = await db.execute<{ id: string }>(sql`
      SELECT id FROM vehicles
       WHERE ownership = 'rental' AND deleted_at IS NULL ORDER BY id LIMIT 1`);
    if (!rental.rows[0])
      throw new Error('в справочнике нет арендной техники: миграции не применены');

    const { buildApp: build } = await import('../src/app');
    const app = await build();
    await app.ready();

    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }

    const admin = await login(adminEmail);
    async function createType(isLinear: boolean): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/vehicle-types',
        headers: admin,
        payload: {
          kindId,
          code: `${TYPE_PREFIX}_${isLinear ? 'lin' : 'plain'}`,
          name: `Ямобуры пачки, ${isLinear ? 'линейный' : 'обычный'} ${RUN}`,
          isLinear,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    }

    // The last of the sixteen leaves for repair in the middle of a working request — the case
    // itself does that. Its unit is its own so that nothing shifts under the others' feet.
    const inactiveVehicleId = own.rows[15]!.id;

    ctx = {
      app,
      db,
      closeDb,
      admin,
      dispatcher: await login(dispatcherEmail),
      manager: await login(managerEmail),
      objectId: objectRow.rows[0]!.id,
      driverId,
      plainTypeId: await createType(false),
      linearTypeId: await createType(true),
      vehicles: own.rows.slice(0, 15).map((row) => row.id),
      inactiveVehicleId,
      rentalVehicleId: rental.rows[0].id,
      today: moscowDateKeyOf(new Date()),
    };
  });

  afterAll(async () => {
    // There is deliberately no cleanup of rows: the database is ours and is dropped whole — there
    // is nothing left inside it to clean.
    await ctx?.app.close();
    await ctx?.closeDb();
    if (!DB_URL) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${OWN_DB_NAME}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  /**
   * §1 and §2 at once: the linearity lock is gone, while the ESM-2 is untouched.
   *
   * The request here is NON-LINEAR — the very one that was allowed no days at all before ADR 0207.
   * What is checked is not only "the batch passed" but both halves of the price: its table of days
   * is no longer empty and shows no blocker, while the weekly ESM-2 for the same day stayed where
   * it was (boundary G1).
   */
  it('срок нелинейного заказа проходит целиком: дни в рейсах, листы выписаны, отчёт построчный', async () => {
    const vehicleId = ctx.vehicles[0]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));
    // The weekly waybill was issued to the request by the move into work itself: the batch neither
    // cancels nor replaces it.
    const esm2Before = await esm2Count(request.id);
    expect(esm2Before).toBeGreaterThan(0);

    const result = await batchOk(request.id);

    expect(result.issued).toBe(4);
    expect(result.planned).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    // The term is shorter than the portion limit — nothing was left outside the window (§11).
    expect(result.remaining).toBe(0);
    expect(result.rows.map((row) => row.date)).toEqual(days);
    for (const row of result.rows) {
      expect(row.outcome).toBe('issued');
      expect(row.reason).toBeUndefined();
      expect(row.routeNumber).toMatch(/^Р-\d+$/);
      expect(row.waybillNumber).toBeTruthy();
    }
    // Every day has a route of its own: a route belongs to the pair "vehicle + date", and one route
    // for four days would be physically impossible (the composite FK, migration 0127).
    expect(new Set(result.rows.map((row) => row.routeNumber)).size).toBe(4);

    /*
     * The table of days arrives together with the report and is already the new one (the "response"
     * section of the service): the card must show the picture the report was built from.
     */
    expect(result.days.blocker).toBeNull();
    expect(result.days.items).toHaveLength(4);
    for (const item of result.days.items) {
      expect(item.route).not.toBeNull();
      expect(item.route!.vehicleId).toBe(vehicleId);
      // The vehicle was taken from the assignment (§5) — there is no divergence to mark.
      expect(item.otherVehicle).toBe(false);
      expect(item.route!.waybill).not.toBeNull();
    }

    const waybills = await dayWaybills(request.id);
    expect(waybills.map((w) => w.issuedForDate)).toEqual(days);
    for (const waybill of waybills) {
      expect(waybill.formCode).toBe('4p');
      expect(waybill.status).toBe('issued');
      // Today's and future paper is no correction operation: it has no journal row.
      expect(waybill.correctionId).toBeNull();
    }

    // Double paper is named as boundary G1: the weekly ESM-2 is in place, the daily 4-П beside it.
    expect(await esm2Count(request.id)).toBe(esm2Before);
  });

  /**
   * The second half of the "batch body" decision: `issueWaybills: false` places the days and spends
   * not a single blank number. The route is assembled in advance, the paper is handed out when it
   * is about to travel.
   */
  it('без выписки листов пачка только заводит рейсы — номера бланков не расходуются', async () => {
    const request = await requestInProgress({ vehicleId: ctx.vehicles[1]! });

    const result = await batchOk(request.id, { issueWaybills: false });

    expect(result.planned).toBe(4);
    expect(result.issued).toBe(0);
    expect(result.skipped + result.failed).toBe(0);
    for (const row of result.rows) {
      expect(row.outcome).toBe('planned');
      expect(row.routeNumber).toMatch(/^Р-\d+$/);
      expect(row.waybillNumber).toBeUndefined();
    }
    expect(await dayWaybills(request.id)).toHaveLength(0);
    for (const item of result.days.items) {
      expect(item.route).not.toBeNull();
      expect(item.route!.waybill).toBeNull();
    }
  });

  /**
   * §7, the first of the five obstacles: a day already standing in a route of this request the
   * batch does not touch.
   *
   * What matters is not only that it is skipped but that the batch WENT ON: that is what the
   * outcome was made separate from `failed` for.
   */
  it('день, уже стоящий в рейсе, пропускается своими словами, а пачка идёт дальше', async () => {
    const vehicleId = ctx.vehicles[2]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));
    const planned = await planDay(request.id, days[1]!, { vehicleId });
    expect(planned.statusCode, planned.body).toBe(200);

    const result = await batchOk(request.id);

    expect(result.skipped).toBe(1);
    expect(result.issued).toBe(3);
    const skipped = result.rows.find((row) => row.date === days[1]);
    expect(skipped!.outcome).toBe('skipped');
    expect(skipped!.reason).toBe(DAY_BATCH_SKIP_PLANNED);
    // The batch created no second route for that day: the vehicle still has one on that date.
    expect(await routeCount(vehicleId, days[1]!)).toBe(1);
    // And it issued no paper on the foreign route: a skipped day the batch does not touch at all.
    expect((await dayWaybills(request.id)).map((w) => w.issuedForDate)).toEqual([
      days[0],
      days[2],
      days[3],
    ]);
  });

  /**
   * §7 and the route picking rule: two freight routes of a vehicle on one date are a legitimate
   * state (morning and evening), and the batch does not take that choice upon itself.
   *
   * Were it to err — the day would travel into somebody else's task, and that would be noticed at
   * the printer.
   */
  it('два рейса машины на дату: день пропускается, выбор остаётся диспетчеру', async () => {
    const vehicleId = ctx.vehicles[3]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));
    const morning = await createRoute(vehicleId, days[2]!);
    const evening = await createRoute(vehicleId, days[2]!);
    const numbers = [
      (await routeOf(morning)).displayNumber,
      (await routeOf(evening)).displayNumber,
    ];

    const result = await batchOk(request.id);

    const skipped = result.rows.find((row) => row.date === days[2]);
    expect(skipped!.outcome).toBe('skipped');
    expect(skipped!.reason).toBe(DAY_BATCH_SKIP_AMBIGUOUS_ROUTE);
    /*
     * The route is named by name: in a report of half a hundred rows "the vehicle has two routes
     * somewhere" is unactionable. Which of the two is not stipulated and cannot be: candidates are
     * taken under lock by ascending `id`, and `id` is random. The assertion is therefore about
     * membership, not about order.
     */
    expect(numbers).toContain(skipped!.routeNumber);
    expect(result.issued).toBe(3);
    // The batch created no third route — otherwise the vehicle would have three papers for a day.
    expect(await routeCount(vehicleId, days[2]!)).toBe(2);
  });

  /**
   * §7 and the consequence "a waybill issued in advance freezes the route" (G2).
   *
   * The dearest part here is the second half: beside a frozen route the batch does NOT create its
   * own. Were it to create one, the vehicle would hold two blanks for one day's work, and that
   * would be found at the printer.
   */
  it('рейс, замороженный выписанным листом, день не принимает — и второго рейса рядом не заводится', async () => {
    const vehicleId = ctx.vehicles[4]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));

    // Somebody else's day in a route of this vehicle: the waybill on it is what freezes the route.
    // The neighbour is of the linear type, so that the move into work issues it no weekly ESM-2 —
    // this case has no business with those.
    const neighbour = await requestInProgress({ typeId: ctx.linearTypeId, vehicleId });
    const occupied = await planDay(neighbour.id, days[3]!, { vehicleId });
    expect(occupied.statusCode, occupied.body).toBe(200);
    const routeId = (
      occupied.json().items as { date: string; route: { id: string } | null }[]
    ).find((item) => item.date === days[3])!.route!.id;
    const frozen = await routeOf(routeId);
    await freezeRoute(routeId);

    const result = await batchOk(request.id);

    const skipped = result.rows.find((row) => row.date === days[3]);
    expect(skipped!.outcome).toBe('skipped');
    expect(skipped!.reason).toBe(DAY_BATCH_SKIP_FROZEN);
    // The very route that did not take the day is named: that is the one the human goes to cancel.
    expect(skipped!.routeNumber).toBe(frozen.displayNumber);
    expect(result.issued).toBe(3);
    expect(await routeCount(vehicleId, days[3]!)).toBe(1);
  });

  /**
   * §7 and ADR 0068: the capacity is set by the route's blank, and the batch does not go around it.
   *
   * The seven task rows of a 4-П are filled with days of seven neighbouring requests — by the same
   * per-day path the dispatcher would fill them. Answering "zero candidates" here would be untrue:
   * the route exists, and the human needs to know there is nothing left to pack the day with.
   */
  it('в бланке рейса кончились строки задания — день пропускается своей причиной', async () => {
    const vehicleId = ctx.vehicles[5]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));
    const full = days[1]!;
    const routeId = await createRoute(vehicleId, full);
    const routeNumber = (await routeOf(routeId)).displayNumber;

    // Seven is the 4-П capacity (`ROUTE_REQUEST_CAPACITY`): an eighth row has no room in the blank.
    for (let i = 0; i < 7; i += 1) {
      const filler = await requestInProgress({ typeId: ctx.linearTypeId, vehicleId });
      const placed = await planDay(filler.id, full, { routeId });
      expect(placed.statusCode, placed.body).toBe(200);
    }
    expect(await routeRequestCount(routeId)).toBe(7);

    const result = await batchOk(request.id);

    const skipped = result.rows.find((row) => row.date === full);
    expect(skipped!.outcome).toBe('skipped');
    expect(skipped!.reason).toBe(DAY_BATCH_SKIP_NO_ROOM);
    // The route that has no room left is named: it is beside that one that a second is created.
    expect(skipped!.routeNumber).toBe(routeNumber);
    expect(result.issued).toBe(3);
    // The batch created no route of its own beside the full one: "create a second route" is the
    // dispatcher's call.
    expect(await routeCount(vehicleId, full)).toBe(1);
    expect(await routeRequestCount(routeId)).toBe(7);
  });

  /**
   * §7, R9 of the plan: the past without the `waybills.correct` right is an obstacle of EVERY past
   * day, not a refusal of the whole batch.
   *
   * The manager is not allowed the past at all (ADR 0101 §4), and the batch must say so per day
   * without creating a single route: not one day of this term is in the future.
   */
  it('без права оформлять задним числом прошедшие дни пропускаются, и ни одной бумаги не выписано', async () => {
    const vehicleId = ctx.vehicles[6]!;
    const dateFrom = shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS + 2));
    const dateTo = shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS - 1));
    const request = await requestInProgress({
      typeId: ctx.linearTypeId,
      vehicleId,
      dateFrom,
      dateTo,
      backdateReason: 'работы шли в прошлом месяце, оформляем сейчас',
    });

    const result = await batchOk(request.id, { reason: 'оформляем прошедший период' }, ctx.manager);

    expect(result.skipped).toBe(4);
    expect(result.issued + result.planned + result.failed).toBe(0);
    for (const row of result.rows) {
      // One text for "no right" and "too long ago" would send half the people to the wrong place:
      // here the right is absent entirely, and it is granted the ordinary way.
      expect(row.reason).toBe(DAY_BATCH_SKIP_BACKDATED);
    }
    expect(await routesOfVehicle(vehicleId)).toBe(0);
    expect(await dayWaybills(request.id)).toHaveLength(0);
  });

  /**
   * §9 in full: past days go under ONE operation, and it is opened lazily by the first day that
   * reached issue.
   *
   * The same run checks the second boundary of the past — the depth. The dispatcher has
   * `waybills.correct` and lacks `waybills.correctBeyondLimit`, so days deeper than
   * `WAYBILL_CORRECTION_DAYS` leave as skips with THEIR OWN text: there the right is present, and
   * the limit is lifted only by what is granted to nobody. That case used to be covered by nothing.
   */
  it('прошедшие дни: одна строка операции на пачку, причина в каждом листе, глубокое прошлое — пропуск', async () => {
    const vehicleId = ctx.vehicles[7]!;
    const dateFrom = shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS + 2));
    const dateTo = shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS - 1));
    const deep = [dateFrom, shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS + 1))];
    const allowed = [shiftDateKey(ctx.today, -WAYBILL_CORRECTION_DAYS), dateTo];
    const request = await requestInProgress({
      typeId: ctx.linearTypeId,
      vehicleId,
      dateFrom,
      dateTo,
      backdateReason: 'работы шли в прошлом месяце, оформляем сейчас',
    });
    const operationId = randomUUID();
    const reason = 'бумага за прошедший период оформляется одним решением';

    const result = await batchOk(request.id, { reason, operationId }, ctx.dispatcher);

    // Deeper than the limit — its own text: the dispatcher has the right, and the depth is lifted
    // only by the ungrantable one.
    for (const date of deep) {
      const row = result.rows.find((r) => r.date === date)!;
      expect(row.outcome).toBe('skipped');
      expect(row.reason).toBe(DAY_BATCH_SKIP_BEYOND_LIMIT);
    }
    expect(result.skipped).toBe(2);
    expect(result.issued).toBe(2);
    expect(result.rows.filter((r) => r.outcome === 'issued').map((r) => r.date)).toEqual(allowed);

    // There is exactly one operation row for the whole batch — that is what §9 introduced its own
    // `day_batch` kind for.
    const corrections = await correctionsOf(operationId);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.kind).toBe('day_batch');
    expect(corrections[0]!.reason).toBe(reason);
    // The link is kept to the request: up to fifty waybills under the operation, but one request.
    expect(await linkedRequests(corrections[0]!.id)).toEqual([request.id]);
    // The operation snapshot lists what it did itself: only the waybills issued with a past date.
    const payload = corrections[0]!.payload as {
      waybills?: { date: string; number: string }[];
      term?: { days?: number };
    };
    expect(payload.waybills?.map((w) => w.date)).toEqual(allowed);
    expect(payload.term?.days).toBe(4);

    // Every waybill of a past day is marked with the same reason and the same operation.
    const waybills = await dayWaybills(request.id);
    expect(waybills.map((w) => w.issuedForDate)).toEqual(allowed);
    for (const waybill of waybills) {
      expect(waybill.correctionId).toBe(corrections[0]!.id);
      expect(waybill.correctionReason).toBe(reason);
    }
  });

  /**
   * §9 and the "retry" section: the same operation key with the same body continues the former work
   * instead of issuing a second stack.
   *
   * The scene is built so that the first batch has something left undone: on one day the vehicle
   * has two routes, and that day leaves as a skip. The spare route is removed — and the retry
   * finishes that day UNDER THE SAME operation row, while the days already issued are cut off by
   * their own UNIQUE and leave as skips.
   */
  it('повтор с тем же ключом операции доделывает пропущенное и не жжёт вторых номеров', async () => {
    const vehicleId = ctx.vehicles[8]!;
    const dateFrom = shiftDateKey(ctx.today, -3);
    const dateTo = shiftDateKey(ctx.today, -1);
    const days = [dateFrom, shiftDateKey(ctx.today, -2), dateTo];
    const request = await requestInProgress({
      typeId: ctx.linearTypeId,
      vehicleId,
      dateFrom,
      dateTo,
      backdateReason: 'работы шли на прошлой неделе',
    });
    // Two routes on the middle day: the first batch will not take it — it has no right to choose
    // between them.
    const spare = await createRoute(vehicleId, days[1]!);
    await createRoute(vehicleId, days[1]!);

    const operationId = randomUUID();
    const body = { reason: 'оформляем прошедшую неделю', operationId };
    const first = await batchOk(request.id, body, ctx.dispatcher);
    expect(first.issued).toBe(2);
    expect(first.rows.find((row) => row.date === days[1])!.reason).toBe(
      DAY_BATCH_SKIP_AMBIGUOUS_ROUTE,
    );
    const correctionId = (await correctionsOf(operationId))[0]!.id;
    const issuedFirst = new Map(
      (await dayWaybills(request.id)).map((w) => [w.issuedForDate, w.number]),
    );
    expect([...issuedFirst.keys()]).toEqual([days[0], days[2]]);

    // The spare route is gone — the ambiguity is over, and the retry with the same key finishes
    // the day.
    const removed = await inject('DELETE', `/api/v1/vehicle-routes/${spare}`, ctx.admin);
    expect(removed.statusCode, removed.body).toBe(200);

    const second = await batchOk(request.id, body, ctx.dispatcher);

    expect(second.issued).toBe(1);
    expect(second.rows.find((row) => row.date === days[1])!.outcome).toBe('issued');
    // Days already done are not redone: the day's UNIQUE cuts them off, not a second stack of
    // paper.
    expect(second.skipped).toBe(2);
    for (const date of [days[0], days[2]]) {
      expect(second.rows.find((row) => row.date === date)!.reason).toBe(DAY_BATCH_SKIP_PLANNED);
    }

    // The operation stayed one and the same: the key answers "a retry?" and opens no second work.
    const corrections = await correctionsOf(operationId);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.id).toBe(correctionId);

    // Three waybills for three days and not one more: the retry issued no second stack.
    const waybills = await dayWaybills(request.id);
    expect(waybills).toHaveLength(3);
    expect(waybills.map((w) => w.issuedForDate)).toEqual(days);
    // The numbers of the first two days stayed THE SAME: the retry neither rewrote nor doubled
    // them.
    for (const [date, number] of issuedFirst) {
      expect(waybills.find((w) => w.issuedForDate === date)!.number).toBe(number);
    }
    for (const waybill of waybills) expect(waybill.correctionId).toBe(correctionId);
  });

  /**
   * `hasActiveWaybill` and the rollback refusal answer one question with one condition (ADR 0207,
   * «Последствия»: a day waybill holds the rollback to «Новая» just as a freight one does).
   *
   * The flag is an expression of the request selection that repeats `activeWaybillOfRequest`, the
   * function the status door refuses with; nothing ties them but a comment. If they drift, the
   * portal either promises a rollback the server then refuses after the reason has been typed, or
   * hides one the server would allow. So the scene checks both sides at each step, on a NON-linear
   * order — the one that has both kinds of paper at once:
   *
   * - with only the weekly ESM-2 the flag is off: ESM-2 hangs on the request, not on a route, and
   *   does not hold the rollback;
   * - after the batch the real day 4-P waybills turn it on, and the door answers 409 with
   *   `ROLLBACK_WAYBILL_MESSAGE`;
   * - once the day waybills are cancelled the flag is off again and the door lets the rollback
   *   through — the cancelled form is written off and no longer carries the request's work.
   */
  it('признак «действующий лист» и отказ отката в «Новую» отвечают одним условием', async () => {
    const vehicleId = ctx.vehicles[12]!;
    const request = await requestInProgress({ vehicleId });
    expect(await esm2Count(request.id)).toBeGreaterThan(0);
    expect((await requestCard(request.id)).hasActiveWaybill).toBe(false);

    const result = await batchOk(request.id);
    expect(result.issued).toBe(4);

    const held = await requestCard(request.id);
    expect(held.hasActiveWaybill).toBe(true);
    const refused = await rollbackToNew(request.id, held.version);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().message).toContain(ROLLBACK_WAYBILL_MESSAGE);

    const waybills = await dayWaybills(request.id);
    expect(waybills).toHaveLength(4);
    for (const waybill of waybills) {
      const cancelled = await inject('POST', `/api/v1/waybills/${waybill.id}/cancel`, ctx.admin, {
        reason: 'лишний бланк: день ведётся недельным ЭСМ-2',
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
    }

    const released = await requestCard(request.id);
    expect(released.hasActiveWaybill).toBe(false);
    const rolled = await rollbackToNew(request.id, released.version);
    expect(rolled.statusCode, rolled.body).toBe(200);
    expect(rolled.json().status).toBe('new');
  });

  /**
   * The pre-check stands BEFORE the first write — and this is not about tidiness but about numbers.
   *
   * The `identity` of the «Р-» sequence is not rolled back with the transaction: a route created
   * before a refusal carries its number away forever. So everything that concerns the WHOLE batch
   * and is known in advance must refuse at the route, leaving `vehicle_routes` untouched.
   */
  describe('отказ предпроверки не оставляет в базе ни строки', () => {
    it('арендная машина: дней у такого заказа не бывает вовсе', async () => {
      // Rental is a boundary of the paper, not of the type (R10 of the plan): a waybill for a
      // rental vehicle is issued by the lessor. The rate is obligatory — without money such an
      // assignment is not accepted at all.
      const request = await requestInProgress({
        vehicleId: ctx.rentalVehicleId,
        pricePerHour: 1000,
      });
      const res = await batch(request.id);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toContain('арендной техникой');
      expect(res.json().fields.requestId).toBe('Дни недоступны');
      expect(await routesOfVehicle(ctx.rentalVehicleId)).toBe(0);
    });

    it('машина снята с линии: отказ приходит до первого рейса', async () => {
      /*
       * The vehicle is taken off the line AFTER the assignment — because otherwise it could not be
       * assigned at all: the assignment refuses in exactly the same words. And this is the real
       * life of such a request: it was taken into work with a sound vehicle, and by the time the
       * papers are issued it has left for repair.
       */
      const request = await requestInProgress({ vehicleId: ctx.inactiveVehicleId });
      await ctx.db.execute(
        sql`UPDATE vehicles SET status = 'maintenance' WHERE id = ${ctx.inactiveVehicleId}`,
      );

      const res = await batch(request.id);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toContain('Техника недоступна');
      expect(await routesOfVehicle(ctx.inactiveVehicleId)).toBe(0);
    });

    it('водителя нет — пачка не заводит рейсов со ссылкой на него', async () => {
      const vehicleId = ctx.vehicles[10]!;
      const request = await requestInProgress({ vehicleId });

      const res = await batch(request.id, { driverPersonId: randomUUID() });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().message).toContain('Водитель не найден');
      expect(await routesOfVehicle(vehicleId)).toBe(0);
    });

    it('прошедшие дни без причины и без ключа операции: два разных отказа, обе записи нулевые', async () => {
      const vehicleId = ctx.vehicles[11]!;
      const request = await requestInProgress({
        typeId: ctx.linearTypeId,
        vehicleId,
        dateFrom: shiftDateKey(ctx.today, -2),
        dateTo: shiftDateKey(ctx.today, -1),
        backdateReason: 'работы шли позавчера',
      });

      // The reason is one per batch and is asked before the first write: what gets explained is the
      // decision to paper the past period, not each day separately.
      const noReason = await batch(request.id, {}, ctx.dispatcher);
      expect(noReason.statusCode, noReason.body).toBe(422);
      expect(noReason.json().fields.reason).toBe('Нужна причина');
      expect(await routesOfVehicle(vehicleId)).toBe(0);

      // The key is required exactly where the batch will burn blank numbers with a past date: a
      // retry after a dropped connection must continue the former work, not issue a second stack.
      const noKey = await batch(request.id, { reason: 'оформляем позавчерашнее' }, ctx.dispatcher);
      expect(noKey.statusCode, noKey.body).toBe(422);
      expect(noKey.json().fields.operationId).toBe('Не передан ключ операции');
      expect(await routesOfVehicle(vehicleId)).toBe(0);
    });
  });

  /**
   * §11 in its current wording: the limit stands on the PORTION of a click, not on the term.
   *
   * Formerly a long term was refused whole (`dayBatchTermLimitMessage`), and that cut off from the
   * button the very case it was asked for — a quarterly request. Now a click takes the first
   * `DAY_BATCH_LIMIT` UNPLANNED days and says how many are left outside the window; the second
   * click picks up the tail, while days already done take up no room in the portion — otherwise the
   * button would be pressed endlessly while the paper stood still.
   *
   * No paper is asked for here on purpose: the subject of the case is the portion window and the
   * remainder, and half a hundred numbered blanks add nothing to that question.
   */
  it('срок длиннее предела проходится порциями: остаток назван, второе нажатие добирает хвост', async () => {
    const vehicleId = ctx.vehicles[9]!;
    // A quarterly request is exactly the case the button was asked for: ninety days.
    const term = 90;
    const tail = term - DAY_BATCH_LIMIT;
    const dateFrom = ctx.today;
    const dateTo = shiftDateKey(dateFrom, term - 1);
    const request = await requestInProgress({ vehicleId, dateFrom, dateTo });

    const first = await batchOk(request.id, { issueWaybills: false });
    expect(first.rows).toHaveLength(DAY_BATCH_LIMIT);
    expect(first.planned).toBe(DAY_BATCH_LIMIT);
    expect(first.skipped + first.failed + first.issued).toBe(0);
    // The tail is named by a number: without it a long term would break off silently at fifty days.
    expect(first.remaining).toBe(tail);
    expect(first.days.items).toHaveLength(DAY_BATCH_LIMIT + tail);
    expect(first.days.items.filter((item) => item.route !== null)).toHaveLength(DAY_BATCH_LIMIT);

    const second = await batchOk(request.id, { issueWaybills: false });

    // The second click picked up the tail: the days already done did not count into the portion,
    // and the window reached the end of the term.
    expect(second.planned).toBe(tail);
    expect(second.remaining).toBe(0);
    expect(second.rows).toHaveLength(DAY_BATCH_LIMIT + tail);
    // Days already walked cannot stay silent: the batch walked them and did nothing — silence would
    // read as "it did".
    expect(second.skipped).toBe(DAY_BATCH_LIMIT);
    for (const row of second.rows.slice(0, DAY_BATCH_LIMIT)) {
      expect(row.reason).toBe(DAY_BATCH_SKIP_PLANNED);
    }
    expect(second.days.items.filter((item) => item.route === null)).toHaveLength(0);
  });
});
