import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values of these modules are pulled in with `await import` after the environment
// has been prepared — the config validates it at import time and throws without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as RoutesNs from '../src/services/vehicle-routes';

/**
 * `hasActiveWaybill` OF THE REQUEST CARD — the field the rollback door reads
 * ([ADR 0207](../../../docs/adr/0207-vehicle-request-day-batch.md) refines
 * [ADR 0058](../../../docs/adr/0058-request-rollback-to-new.md)).
 *
 * Returning a request to "Новая" wipes its work, and the server refuses that to a request already
 * standing in an issued blank (`ROLLBACK_WAYBILL_MESSAGE`, `activeWaybillOfRequest`). The portal
 * used to ask `route.hasWaybill` instead — the blank of the request's OWN freight run. An order for
 * equipment on a site has no such run at all: its papers hang on the runs of its days, `route` is
 * empty, and the card promised a rollback the server then refused with a 409 over a reason already
 * typed in.
 *
 * So the field answers a different question — "does the request have any live paper at all" — and
 * counts the three ways of getting into one:
 *
 * 1. a composition row of a run — a freight slip or a DAY of an order for equipment on a site;
 * 2. the basis of a relocation run (`vehicle_routes.source_request_id`, ADR 0057);
 * 3. a blank issued before runs existed at all (`legacyWaybillOf`: `route_id IS NULL`).
 *
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY. Every scene checks the card field AND
 * `activeWaybillOfRequest` — the very function the refusal is built on — and demands they agree.
 * The one-place rule is the whole reason the field exists: two SQL texts answering one question
 * drift apart silently, and the drift is invisible from either side alone. A literal expectation
 * would keep a scene green while the two halves disagreed about it.
 *
 * WHY A LIVE DATABASE. The field is an expression of the list's SELECT, correlated by the columns
 * of an outer query with two dozen tables in its FROM (that is why it is written as three EXISTS
 * from the REQUEST and not as the function's join — measured with EXPLAIN). Nothing of that exists
 * outside Postgres, and a rewritten column list is exactly what silently breaks correlated
 * subqueries in single-source queries.
 *
 * WHY AN OWN DATABASE. Scenes are told apart by the paper of a particular request, and the shared
 * db-test database lies in both directions (see the header of `apps/api/scripts/quality-db.ts`):
 * a run left on the same unit and date by a neighbouring file is enough. The name is derived from
 * the main one so that a run killed halfway still takes its database with it — the `pnpm check:db`
 * cleanup drops everything named `<main>_%`.
 *
 * Run:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm --filter @technic/api exec vitest run vehicle-request-active-waybill.db
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = `${DB_URL?.replace(/^.*\//, '') ?? ''}_active_waybill`;
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const PASSWORD = 'db-active-waybill-password-123';
/** Tail of the run: the database is private, but directory codes are unique inside it too. */
const RUN = randomUUID().slice(0, 8);

/**
 * Scene days, far in the future and one per scene: a run belongs to the pair "vehicle + date", and
 * scenes sharing a date on one unit would see each other's paper. 2099-11-02 is a Monday — the
 * ESM-2 period must stay inside one calendar week (`waybills_period_check`).
 */
const DAYS = {
  /** A day of the order standing in a run with a 4-P over it. */
  day: '2099-11-04',
  /** A freight slip in the composition of a run with a 4-P over it. */
  freight: '2099-11-05',
  /** A relocation run of the order with a 4-P over it. */
  relocation: '2099-11-06',
  /** A day in a run with no paper at all. */
  bare: '2099-11-10',
  /** A day whose 4-P has been voided. */
  voided: '2099-11-11',
  /** The week of the weekly ESM-2, which holds no rollback. */
  weekFrom: '2099-11-16',
  weekTo: '2099-11-20',
};

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  activeWaybillOfRequest: (typeof RoutesNs)['activeWaybillOfRequest'];
  admin: Auth;
  /** Author of every fixture row: the same user the login above belongs to. */
  authorId: string;
  objectId: string;
  /** Ordered type of an order for equipment on a site — non-linear, as ADR 0207 decision 1 left it. */
  siteTypeId: string;
  /** Ordered type of a freight order: its request carries a slip, not days. */
  freightTypeId: string;
  organizationId: string;
  seriesId: string;
  driverId: string;
}

let ctx: Ctx;
let nextWaybillNumber = 1;
let nextVehicleNumber = 1;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  // S3 takes no part in these scenes, but the config demands it — the stubs are knowingly dead.
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  process.env.MAIL_ENABLED ??= 'false';
}

/** The own database from scratch: created, migrated and dropped in `afterAll`. */
async function createOwnDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_DB });
  await admin.connect();
  try {
    // FORCE is against connections of a PREVIOUS run abandoned by a killed process: without it
    // yesterday's leftover session prevents the CREATE, and the file goes red not by its own fault.
    await admin.query(`DROP DATABASE IF EXISTS "${OWN_DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${OWN_DB_NAME}"`);
  } finally {
    await admin.end();
  }
  const client = new pg.Client({ connectionString: OWN_DB });
  await client.connect();
  try {
    // The portal's migrations lean on these three from the very first numbers; on production the
    // cluster administrator installs them, which is why no migration does it itself.
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

// ── Fixtures ──

async function newVehicle(): Promise<string> {
  const plate = `Х${String(nextVehicleNumber).padStart(3, '0')}АЛ${RUN.slice(0, 2)}`;
  nextVehicleNumber += 1;
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'own',
      vehicleTypeId: ctx.siteTypeId,
      registrationNumber: plate,
      status: 'active',
      note: 'ТЕСТОВЫЕ ДАННЫЕ: бумага заявки',
    })
    .returning({ id: ctx.schema.vehicles.id });
  return vehicle!.id;
}

/** An order for equipment on a site: the request whose paper hangs on the runs of its days. */
async function newSiteOrder(tag: string): Promise<string> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.siteTypeId,
      status: 'confirmed',
      comment: `Работы по графику (${tag})`,
      createdBy: ctx.authorId,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  await ctx.db.insert(ctx.schema.specialEquipmentRequestDetails).values({
    requestId: request!.id,
    dateFrom: DAYS.day,
    dateTo: DAYS.weekTo,
    responsibleName: 'Прорабов Пётр Петрович',
    responsiblePhone: '9001234567',
  });
  return request!.id;
}

/** A freight order: the one whose composition row carries no day at all (`work_date` is NULL). */
async function newFreightOrder(tag: string): Promise<string> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.freightTypeId,
      status: 'confirmed',
      comment: `Перевозка (${tag})`,
      createdBy: ctx.authorId,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  await ctx.db.insert(ctx.schema.freightTransportRequestDetails).values({
    requestId: request!.id,
    scheduledAt: new Date(`${DAYS.freight}T05:30:00Z`),
  });
  return request!.id;
}

/** A run of the vehicle on that date; `workDate` set turns the composition row into a day. */
async function newRoute(input: {
  requestId: string;
  vehicleId: string;
  date: string;
  workDate: string | null;
}): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId: input.vehicleId,
      routeDate: input.date,
      purpose: 'freight',
      driverPersonId: ctx.driverId,
      createdBy: ctx.authorId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  await ctx.db.insert(ctx.schema.vehicleRouteRequests).values({
    routeId: route!.id,
    requestId: input.requestId,
    position: 1,
    workDate: input.workDate,
  });
  return route!.id;
}

/** A relocation run: its request is the basis (ADR 0057), and it has no composition row. */
async function newRelocationRoute(input: {
  requestId: string;
  vehicleId: string;
  date: string;
}): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId: input.vehicleId,
      routeDate: input.date,
      purpose: 'delivery',
      sourceRequestId: input.requestId,
      moveFrom: 'База',
      moveTo: 'Объект',
      driverPersonId: ctx.driverId,
      createdBy: ctx.authorId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  return route!.id;
}

/**
 * A 4-P over a run; voided is the same row with a status and a reason for it.
 *
 * No talon rows (`waybill_requests`) are written, and no scene loses anything by that: the only
 * branch that reads them — the third EXISTS of the field and `legacyWaybillOf` — also demands
 * `route_id IS NULL`, which a 4-P over a run never has. That branch is covered by the last scene,
 * which proves the schema refuses the only row it could match.
 */
async function new4p(input: {
  routeId: string;
  vehicleId: string;
  date: string;
  voided?: boolean;
}): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: nextWaybillNumber,
      formCode: '4p',
      status: input.voided ? 'cancelled' : 'issued',
      organizationId: ctx.organizationId,
      vehicleId: input.vehicleId,
      driverPersonId: ctx.driverId,
      issuedForDate: input.date,
      routeId: input.routeId,
      issuedBy: ctx.authorId,
      ...(input.voided
        ? {
            cancelledAt: new Date(),
            cancelledBy: ctx.authorId,
            cancelReason: 'Испорчен при печати',
          }
        : {}),
    })
    .returning({ id: ctx.schema.waybills.id, number: ctx.schema.waybills.number });
  nextWaybillNumber += 1;
  return String(row!.number).padStart(8, '0');
}

/*
 * ЭСМ2-РАЗРЕЗ. The weekly ESM-2: no run of its own, an order as its basis and a period of work.
 *
 * The bounds (Monday to Friday of one week) are there only so that the row passes
 * `waybills_form_source_check`, which demands both bounds inside one calendar week; no assertion
 * reads them. What keeps the ESM-2 out of the request's paper is its ATTACHMENT, not its dates:
 * `activeWaybillOfRequest` joins a waybill to a run by `route_id`, empty on an ESM-2, and the third
 * branch of `has_active_waybill` excludes it by form. A sheet cut into segments after the
 * read-mode switch still hangs on the request and not on a run, so the answer does not move.
 */
async function newEsm2(input: { requestId: string; vehicleId: string }): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: nextWaybillNumber,
      formCode: 'esm2',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId: input.vehicleId,
      driverPersonId: ctx.driverId,
      issuedForDate: DAYS.weekFrom,
      sourceRequestId: input.requestId,
      periodFrom: DAYS.weekFrom,
      periodTo: DAYS.weekTo,
      issuedBy: ctx.authorId,
    })
    .returning({ id: ctx.schema.waybills.id, number: ctx.schema.waybills.number });
  nextWaybillNumber += 1;
  return String(row!.number).padStart(8, '0');
}

// ── Readers ──

function inject(method: 'GET', url: string, auth: Auth): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method, url, headers: auth });
}

/**
 * The name of the constraint a refusal came from, or `null` if the error is not one.
 *
 * The chain is walked instead of the message being matched: drizzle wraps the driver's error into
 * its own with the query text and the parameters, and the constraint name lives only in the cause.
 * A match over the text would go green on any other broken insert of the same row.
 */
function constraintOf(error: unknown): string | null {
  for (let cursor = error; cursor instanceof Error; cursor = cursor.cause) {
    const name = (cursor as { constraint?: unknown }).constraint;
    if (typeof name === 'string') return name;
  }
  return null;
}

/**
 * The paper of the request as both sides of the one-place rule see it.
 *
 * `card` is the DTO field the portal decides the rollback door by; `server` is the number the
 * refusal itself is built on. `route` comes along because it is what the portal asked before the
 * wave: an order for equipment on a site has no freight run, and a scene where the card knows
 * about the paper while `route` is empty is exactly the defect being closed.
 */
async function paperOf(requestId: string): Promise<{
  card: boolean;
  server: string | null;
  route: { hasWaybill: boolean } | null;
}> {
  const res = await inject('GET', `/api/v1/vehicle-requests/${requestId}`, ctx.admin);
  expect(res.statusCode, res.body).toBe(200);
  const dto = res.json();
  return {
    card: dto.hasActiveWaybill as boolean,
    server: await ctx.activeWaybillOfRequest(ctx.db, requestId),
    route: (dto.route as { hasWaybill: boolean } | null) ?? null,
  };
}

describe.skipIf(!DB_URL)('бумага заявки на технику: признак карточки (живая схема)', () => {
  // Creating and migrating a private database is a minute of work, not the five seconds vitest
  // allows a hook by default.
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 900_000 });

  beforeAll(async () => {
    await createOwnDatabase();
    prepareEnv(OWN_DB!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { hashPassword } = await import('../src/auth/password');
    const routes = await import('../src/services/vehicle-routes');

    const email = `db-active-waybill-admin-${RUN}@example.invalid`;
    const [author] = await db
      .insert(schema.users)
      .values({
        email,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: '',
        passwordHash: await hashPassword(PASSWORD),
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `АЛ-${RUN}`,
        name: `Тестовая площадка (бумага заявки) ${RUN}`,
        address: 'г Москва, ул Бумажная, д 3',
      })
      .returning({ id: schema.constructionObjects.id });

    const siteTypes = await db.execute<{ id: string }>(sql`
      SELECT vt.id
        FROM vehicle_types vt
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE vk.code = 'special_equipment' AND vt.is_linear = false
       ORDER BY vt.code
       LIMIT 1`);
    const freightTypes = await db.execute<{ id: string }>(sql`
      SELECT vt.id
        FROM vehicle_types vt
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE vk.code = 'freight_transport'
       ORDER BY vt.code
       LIMIT 1`);
    const organizations = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
    );
    if (!siteTypes.rows[0] || !freightTypes.rows[0] || !organizations.rows[0]) {
      throw new Error('нет типов ТС или организации в справочниках: миграции не применены');
    }

    // An own series of blanks: numbers in the shared one are handed out by the issuing service,
    // and a test taking them by hand would leave holes in the register.
    const [series] = await db
      .insert(schema.waybillSeries)
      .values({
        code: `aw_${RUN}`,
        name: `Тестовая серия (бумага заявки) ${RUN}`,
        nextNumber: 1,
      })
      .returning({ id: schema.waybillSeries.id });

    const [driver] = await db
      .insert(schema.persons)
      .values({
        lastName: `Бумажный${RUN.slice(0, 4)}`,
        firstName: 'Иван',
        middleName: 'Петрович',
        phone: '9007654321',
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: бумага заявки',
      })
      .returning({ id: schema.persons.id });

    const { buildApp: build } = await import('../src/app');
    const app = await build();
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = {
      app,
      db,
      schema,
      closeDb,
      activeWaybillOfRequest: routes.activeWaybillOfRequest,
      admin: { authorization: `Bearer ${login.json().accessToken}` },
      authorId: author!.id,
      objectId: object!.id,
      siteTypeId: siteTypes.rows[0].id,
      freightTypeId: freightTypes.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: series!.id,
      driverId: driver!.id,
    };
  });

  afterAll(async () => {
    // No cleanup on purpose: the database is private and goes whole — there is nothing to sweep.
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
   * The branch the wave was written for: the paper of an order for equipment on a site hangs on
   * the run of its DAY, and the request has no freight run of its own — so `route` is empty while
   * the paper exists. This is the pair of answers that used to send the portal into a 409.
   */
  it('день заказа в рейсе с листом: бумага есть, а своего рейса у заявки нет', async () => {
    const requestId = await newSiteOrder('день в рейсе');
    const vehicleId = await newVehicle();
    const routeId = await newRoute({
      requestId,
      vehicleId,
      date: DAYS.day,
      workDate: DAYS.day,
    });
    await new4p({ routeId, vehicleId, date: DAYS.day });

    const paper = await paperOf(requestId);
    expect(paper.card).toBe(true);
    expect(paper.server).not.toBeNull();
    // The neighbouring field answers a different question and keeps silent here — which is why
    // the card was given its own one instead of being taught to reuse this one.
    expect(paper.route).toBeNull();
  });

  /**
   * The same branch through a freight slip: one composition row, one condition. Here `route` is
   * filled — the single row of the composition with no day — and both fields say "yes"; the point
   * of the scene is that the new field did not take anything away from the old one.
   */
  it('грузовая строка состава с листом: видят оба признака', async () => {
    const requestId = await newFreightOrder('строка состава');
    const vehicleId = await newVehicle();
    const routeId = await newRoute({
      requestId,
      vehicleId,
      date: DAYS.freight,
      workDate: null,
    });
    await new4p({ routeId, vehicleId, date: DAYS.freight });

    const paper = await paperOf(requestId);
    expect(paper.card).toBe(true);
    expect(paper.server).not.toBeNull();
    expect(paper.route?.hasWaybill).toBe(true);
  });

  /**
   * The second branch: the request is the BASIS of the run, not a row in its composition. A
   * relocation run has no composition at all, so the first branch cannot see it — and `route` is
   * empty here for the same reason as in the day scene.
   */
  it('рейс-перегон с листом держит бумагу заявки через основание', async () => {
    const requestId = await newSiteOrder('перегон');
    const vehicleId = await newVehicle();
    const routeId = await newRelocationRoute({ requestId, vehicleId, date: DAYS.relocation });
    await new4p({ routeId, vehicleId, date: DAYS.relocation });

    const paper = await paperOf(requestId);
    expect(paper.card).toBe(true);
    expect(paper.server).not.toBeNull();
    expect(paper.route).toBeNull();
  });

  /**
   * No paper at all, and the run is there on purpose: without it the scene would prove only that
   * an empty request has no blank, while the field is about the BLANK and not about the run. The
   * rollback door stays open exactly here.
   */
  it('день в рейсе без листа бумагой не считается', async () => {
    const requestId = await newSiteOrder('без листа');
    const vehicleId = await newVehicle();
    await newRoute({ requestId, vehicleId, date: DAYS.bare, workDate: DAYS.bare });

    const paper = await paperOf(requestId);
    expect(paper.card).toBe(false);
    expect(paper.server).toBeNull();
  });

  /** A voided blank is written off, and the work of the request no longer belongs to it. */
  it('аннулированный лист бумагой не считается', async () => {
    const requestId = await newSiteOrder('аннулированный');
    const vehicleId = await newVehicle();
    const routeId = await newRoute({
      requestId,
      vehicleId,
      date: DAYS.voided,
      workDate: DAYS.voided,
    });
    await new4p({ routeId, vehicleId, date: DAYS.voided, voided: true });

    const paper = await paperOf(requestId);
    expect(paper.card).toBe(false);
    expect(paper.server).toBeNull();
  });

  /**
   * The weekly ESM-2 holds no rollback, and not because a second paper for one day is impossible —
   * since ADR 0207 decision 2 there are two. What decides is the attachment: the ESM-2 hangs on the
   * request itself rather than on a run (migration 0087), the rollback takes nothing away from it
   * and leads the request into no second blank of that kind. Counting it would forbid the rollback
   * to every working order for equipment — that is, cancel ADR 0058 for half of the requests.
   */
  it('недельный ЭСМ-2 бумагой заявки не считается: он висит не на рейсе', async () => {
    const requestId = await newSiteOrder('недельный лист');
    const vehicleId = await newVehicle();
    const weekly = await newEsm2({ requestId, vehicleId });
    expect(weekly).toBeTruthy();

    const paper = await paperOf(requestId);
    expect(paper.card).toBe(false);
    expect(paper.server).toBeNull();
  });

  /**
   * THE THIRD BRANCH CANNOT BE REACHED, and this test is the proof plus the tripwire.
   *
   * `legacyWaybillOf` looks for a live blank of a form other than ESM-2 with an EMPTY `route_id` —
   * the mark of history not yet moved by `backfill:routes`. Since migration 0087
   * `waybills_form_source_check` forbids exactly that row: a non-ESM-2 form demands a filled
   * `route_id`. So neither the third EXISTS of `has_active_waybill` nor `legacyWaybillOf` can match
   * anything, here or on production, and there is no scene to write for them.
   *
   * The statement is pinned rather than left unsaid: relax the check — and the branch becomes live
   * again, this test goes red, and whoever relaxed it is told that the legacy way into paper now
   * needs coverage of its own.
   */
  it('легаси-лист без рейса база не принимает — третья ветвь условия недостижима', async () => {
    const requestId = await newSiteOrder('легаси');
    const vehicleId = await newVehicle();
    const refusal = await ctx.db
      .insert(ctx.schema.waybills)
      .values({
        seriesId: ctx.seriesId,
        number: nextWaybillNumber,
        formCode: '4p',
        status: 'issued',
        organizationId: ctx.organizationId,
        vehicleId,
        driverPersonId: ctx.driverId,
        issuedForDate: DAYS.day,
        routeId: null,
        issuedBy: ctx.authorId,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    nextWaybillNumber += 1;
    expect(constraintOf(refusal), 'отказ базы').toBe('waybills_form_source_check');

    const paper = await paperOf(requestId);
    expect(paper.card).toBe(false);
    expect(paper.server).toBeNull();
  });
});
