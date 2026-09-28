import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  formatVehicleRouteNumber,
  moscowDateKeyOf,
  shiftDateKey,
  type VehicleRequestRollbackPreviewDto,
  weekStartKey,
} from '@technic/contracts';
import {
  describeReadModes,
  inLegacy,
  type TestReadMode,
  useReadModeDatabase,
} from './assignment-read-mode';
import { issueRouteWaybill } from './waybill-issue-helper';
// Types only: the values of these modules are imported with `await import` after the environment
// is set — the config checks it at import time and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Preview of the rollback «В работе» → «Новая» (ADR 0211) against what the door then really does.
 *
 * WHY A LIVE DATABASE. The subject is not a rule but the equality of two paths: the preview reads
 * the plan, the door executes it and deletes rows by the same keys. Only the database can say that
 * the places, relocations, shifts, the early-end request and the ESM-2 sheets the preview named are
 * exactly the ones gone after the rollback — and that the ones it promised to keep are still there.
 * This also closes a gap older than the preview: nothing proved that the rollback detaches the days,
 * drops the shifts and the pending early end, and cancels ESM-2 — only the approval was covered
 * (`vehicle-request-rollback.db.test.ts`).
 *
 * What is proven:
 *
 * - **every consequence of the preview equals the fact** — places in routes, relocations dropped and
 *   kept, shift rows, the pending early end, ESM-2 cancelled and kept, the assignment; and the audit
 *   event of the door names the same days and relocations;
 * - **a worked ESM-2 week stays active**, a current one is cancelled — `canCancelWaybill` through
 *   the sweep's own builder;
 * - **a relocation with a waybill stays even when the waybill is cancelled** — the old portal list
 *   promised to drop it;
 * - **sheet numbers only with `waybills.read`**: a holder of the rollback right without the journal
 *   gets the same counters and the same fingerprint, but no numbers;
 * - **the fingerprint is optional**: wrong — 409 and nothing changed; absent — the rollback passes;
 * - **every part of the fingerprint catches its own change**: after the preview a day is planned, a
 *   relocation gets a waybill, a shift draft appears, an early end is requested and withdrawn, an
 *   ESM-2 sheet is cancelled by its own handle, the vehicle type is switched under the order — each
 *   time the request version stays the one the tab holds or is re-read, so only the fingerprint can
 *   refuse, and it answers 409 with nothing erased. A fixed garbage fingerprint would not prove this:
 *   it fails for any plan, including one that forgot half of its consequences;
 * - **blockers are the door's own words**: an approved shift (422) and an active route waybill (409)
 *   are named by the preview with exactly the message the door answers;
 * - **the route's bounds**: another rollback («Отменена» → «Новая») erases nothing and gets 422,
 *   a subject without the rollback right gets 403.
 *
 * OWN DATABASE. The file runs on its own database, created and dropped by the read-mode harness
 * (`useReadModeDatabase`, name `<main>_rm_rbprev_<run>`): the shared db-test base lies both ways
 * (`apps/api/scripts/quality-db.ts`), and the scene counts routes of a VEHICLE ON A DATE — a route
 * from a neighbouring file on the same unit and day would change what the day planning does.
 *
 * TWO READ MODES. Every case runs under `read_mode = legacy` and `history` (`describeReadModes`).
 * The halves are expected to coincide, and that is the claim being checked, not a formality: the
 * door writes the paper with the same weekly sweep in both modes, the backstop it calls reads the
 * status already written as «Новая» (paper mode `none`) and stays silent, and the preview reads no
 * history at all. The scene itself — taking into work, the correction of a worked week, days,
 * relocations, shifts, early end — is prepared in `legacy` (`inLegacy`): in `history` those doors
 * answer by the assignment history, which is not the subject here; only the preview and the
 * rollback run in the mode under test.
 *
 * Run:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm --filter @technic/api exec vitest run vehicle-request-rollback-preview.db
 */

/*
 * Registered first, before the file's own hooks: the harness sets the environment in its
 * `beforeAll` before anything imports `../src/...`, and drops the database in an `afterAll` that
 * runs after the file has closed its pool (hooks run in reverse order).
 */
const readMode = useReadModeDatabase('rbprev');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

const PASSWORD = 'db-rollback-preview-password-123';
const RUN = randomUUID().slice(0, 8);
/**
 * Object code with «яя»: half of the code picks an object by `ORDER BY … LIMIT 1`, and a record that
 * became the first would steal other requests onto the test site.
 */
const OBJECT_CODE = `яя-rollback-preview-${RUN}`;
const TYPE_CODE = `rollback_preview_${RUN}`;

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Auth;
  /** Rollback right in a grant, without the waybill journal — the ADR 0106 composition. */
  rollbackNoJournal: Auth;
  /** Status right in a grant, without the rollback right: the preview must refuse like the door. */
  statusOnly: Auth;
  objectId: string;
  driverId: string;
  typeId: string;
  /** Kind of the test types: a case that switches linearity creates a type of its own. */
  kindId: string;
  /**
   * Own freight vehicles with the 4-П form — one per case and per read mode (`vehicleOf`): a route
   * belongs to «vehicle + date», and a case sharing a unit with another, or with its own run in the
   * other mode, would find that one's routes on its days.
   */
  vehicles: string[];
  today: string;
  /** Monday and Sunday of the previous calendar week: worked at whatever day the test runs. */
  pastFrom: string;
  pastTo: string;
}

let ctx: Ctx;

/**
 * A user; with `grant` the rights come in an assigned grant (ADR 0106), inserted directly — the
 * grant API is not the subject here, the principal composed from role and grant is.
 */
async function seedUser(
  suffix: string,
  role: 'admin' | 'observer',
  grant: readonly string[] = [],
): Promise<string> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const email = `db-rollback-preview-${suffix}@example.invalid`;
  const [user] = (
    await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
      VALUES (${email}, 'Тестовый', ${suffix}, '', ${await hashPassword(PASSWORD)}, ${role}::role, true)
      RETURNING id`)
  ).rows;
  if (grant.length > 0) {
    const [row] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, description)
        VALUES (${`rollback_preview_${suffix}_${RUN}`}, ${`Тестовый набор (${suffix})`}, '')
        RETURNING id`)
    ).rows;
    for (const permission of grant) {
      await db.execute(sql`
        INSERT INTO grant_permissions (grant_id, permission) VALUES (${row!.id}, ${permission})`);
    }
    await db.execute(sql`INSERT INTO grant_roles (grant_id, role) VALUES (${row!.id}, ${role})`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id) VALUES (${user!.id}, ${row!.id})`);
  }
  return email;
}

/** A driver: a person with the «driver» specialization; enough for the route and the ESM-2 sheet. */
async function seedDriver(): Promise<string> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    WITH person AS (
      INSERT INTO persons (last_name, first_name, middle_name, comment)
      VALUES ('Откатов', 'Тест', 'Предпросмотрович', 'ТЕСТОВЫЕ ДАННЫЕ: предпросмотр отката')
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

async function ok(
  res: Promise<LightMyRequestResponse>,
  code = 200,
): Promise<LightMyRequestResponse> {
  const done = await res;
  expect(done.statusCode, done.body).toBe(code);
  return done;
}

async function versionOf(requestId: string): Promise<number> {
  const res = await ok(inject('GET', `/api/v1/vehicle-requests/${requestId}`, ctx.admin));
  return res.json().version as number;
}

/**
 * An on-site order taken into work: created (in the past when `dateFrom` is — then with a declared
 * reason), approved and confirmed with a vehicle and a machinist, so the sweep issues ESM-2.
 */
async function requestInProgress(options: {
  vehicleId: string;
  dateFrom: string;
  dateTo: string;
  typeId?: string;
}): Promise<string> {
  const { vehicleId, dateFrom, dateTo } = options;
  const backdated = dateFrom < ctx.today;
  const created = await ok(
    inject('POST', '/api/v1/vehicle-requests', ctx.admin, {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: options.typeId ?? ctx.typeId,
      dateFrom,
      dateTo,
      responsibleName: 'Прорабов Пётр Петрович',
      responsiblePhone: '9007770761',
      comment: 'Планировка площадки',
      ...(backdated
        ? { backdateReason: 'Техника вышла раньше, чем оформили', operationId: randomUUID() }
        : {}),
    }),
    201,
  );
  const request = created.json() as { id: string; version: number };
  const approved = await ok(
    inject('PATCH', `/api/v1/vehicle-requests/${request.id}/approval`, ctx.admin, {
      approved: true,
      version: request.version,
    }),
  );
  await ok(
    inject('PATCH', `/api/v1/vehicle-requests/${request.id}/status`, ctx.admin, {
      status: 'confirmed',
      comment: '',
      version: approved.json().version,
      assignment: {
        vehicleId,
        pricePerHour: 3000,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.driverId,
      },
      schedule: { requestType: 'special_equipment', dateFrom, dateTo },
    }),
  );
  return request.id;
}

/** A day of the order in a new route of its vehicle; returns the route id. */
async function planDay(requestId: string, date: string, vehicleId: string): Promise<string> {
  const res = await ok(
    inject('POST', `/api/v1/vehicle-requests/${requestId}/days/${date}/route`, ctx.admin, {
      newRoute: { vehicleId, driverPersonId: ctx.driverId },
      reason: 'подготовка обстановки теста',
    }),
  );
  return (res.json().items as { date: string; route: { id: string } | null }[]).find(
    (item) => item.date === date,
  )!.route!.id;
}

async function routeVersion(routeId: string): Promise<number> {
  const res = await ok(inject('GET', `/api/v1/vehicle-routes/${routeId}`, ctx.admin));
  return res.json().version as number;
}

/** Issue a route waybill (with the handshake the portal does) and return its id. */
async function issueWaybill(routeId: string): Promise<string> {
  await issueRouteWaybill({
    app: ctx.app,
    headers: { ...ctx.admin },
    routeId,
    payload: { version: await routeVersion(routeId) },
  });
  const rows = await ctx.db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM waybills WHERE route_id = ${routeId} AND status <> 'cancelled'`);
  return rows.rows[0]!.id;
}

async function addRelocation(
  requestId: string,
  purpose: 'delivery' | 'pickup',
  routeDate: string,
): Promise<string> {
  const res = await ok(
    inject('POST', `/api/v1/vehicle-requests/${requestId}/relocations`, ctx.admin, {
      purpose,
      routeDate,
      driverPersonId: ctx.driverId,
      moveFrom: 'База, ул. Автомобильная, 3',
      moveTo: 'Объект, площадка',
    }),
    201,
  );
  return res.json().id as string;
}

async function fillShift(requestId: string, date: string): Promise<void> {
  await ok(
    inject('PUT', `/api/v1/vehicle-requests/${requestId}/shifts/${date}`, ctx.admin, {
      machineHours: 8,
      refuel: '',
      comment: '',
    }),
  );
}

function preview(requestId: string, version: number, auth: Auth = ctx.admin) {
  return inject('POST', `/api/v1/vehicle-requests/${requestId}/rollback/preview`, auth, {
    version,
  });
}

async function previewOk(
  requestId: string,
  auth: Auth = ctx.admin,
): Promise<VehicleRequestRollbackPreviewDto> {
  const res = await ok(preview(requestId, await versionOf(requestId), auth));
  return res.json() as VehicleRequestRollbackPreviewDto;
}

function rollback(requestId: string, version: number, previewFingerprint?: string) {
  return inject('PATCH', `/api/v1/vehicle-requests/${requestId}/status`, ctx.admin, {
    status: 'new',
    comment: 'Исполнитель отказался',
    version,
    ...(previewFingerprint !== undefined ? { previewFingerprint } : {}),
  });
}

// ── Questions to the database ──

interface RequestState {
  status: string;
  approved: boolean;
  isLinearFrozen: boolean | null;
  assignment: boolean;
  completion: boolean;
  /** Places in routes: route number and the day, as the preview names them. */
  seats: { routeNumber: string; date: string }[];
  relocations: { id: string; routeNumber: string; purpose: string; routeDate: string }[];
  shifts: { date: string; approved: boolean }[];
  earlyEnd: { status: string; newDateTo: string } | null;
  esm2: { id: string; status: string; from: string; to: string }[];
}

/** Everything the rollback may touch, read straight from the tables it touches. */
async function stateOf(requestId: string): Promise<RequestState> {
  const one = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    (await ctx.db.execute<T>(query)).rows;
  const [request] = await one<{
    status: string;
    approved: boolean;
    is_linear_frozen: boolean | null;
    assignment: boolean;
    completion: boolean;
  }>(sql`
    SELECT r.status::text AS status, r.approved_at IS NOT NULL AS approved, r.is_linear_frozen,
           EXISTS (SELECT 1 FROM vehicle_request_assignments a WHERE a.request_id = r.id) AS assignment,
           EXISTS (SELECT 1 FROM vehicle_request_completions c WHERE c.request_id = r.id) AS completion
      FROM vehicle_requests r WHERE r.id = ${requestId}`);
  const seats = await one<{ num: number; date: string }>(sql`
    SELECT vr.num, coalesce(rr.work_date, vr.route_date)::text AS date
      FROM vehicle_route_requests rr JOIN vehicle_routes vr ON vr.id = rr.route_id
     WHERE rr.request_id = ${requestId}
     ORDER BY vr.id`);
  const relocations = await one<{ id: string; num: number; purpose: string; route_date: string }>(
    sql`
    SELECT id::text AS id, num, purpose, route_date::text AS route_date
      FROM vehicle_routes WHERE source_request_id = ${requestId} ORDER BY id`,
  );
  const shifts = await one<{ date: string; approved: boolean }>(sql`
    SELECT shift_date::text AS date, approved_at IS NOT NULL AS approved
      FROM vehicle_request_shifts WHERE request_id = ${requestId} ORDER BY shift_date`);
  const [earlyEnd] = await one<{ status: string; new_date_to: string }>(sql`
    SELECT status::text AS status, new_date_to::text AS new_date_to
      FROM vehicle_request_early_endings WHERE request_id = ${requestId}`);
  const esm2 = await one<{ id: string; status: string; period_from: string; period_to: string }>(
    sql`
    SELECT id::text AS id, status::text AS status, period_from::text AS period_from,
           period_to::text AS period_to
      FROM waybills WHERE source_request_id = ${requestId} AND form_code = 'esm2'
     ORDER BY period_from, id`,
  );
  return {
    status: request!.status,
    approved: request!.approved,
    isLinearFrozen: request!.is_linear_frozen,
    assignment: request!.assignment,
    completion: request!.completion,
    seats: seats.map((row) => ({ routeNumber: formatVehicleRouteNumber(row.num), date: row.date })),
    relocations: relocations.map((row) => ({
      id: row.id,
      routeNumber: formatVehicleRouteNumber(row.num),
      purpose: row.purpose,
      routeDate: row.route_date,
    })),
    shifts,
    earlyEnd: earlyEnd ? { status: earlyEnd.status, newDateTo: earlyEnd.new_date_to } : null,
    esm2: esm2.map((row) => ({
      id: row.id,
      status: row.status,
      from: row.period_from,
      to: row.period_to,
    })),
  };
}

async function lastStatusAudit(requestId: string): Promise<Record<string, unknown>> {
  const rows = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId}
       AND action = 'vehicle_request.status'
     ORDER BY created_at DESC LIMIT 1`);
  return rows.rows[0]!.metadata;
}

const byDate = <T extends { date: string }>(items: readonly T[]) =>
  [...items].sort((a, b) => a.date.localeCompare(b.date));

/** Cases per read mode; each takes its own slot of `ctx.vehicles`. */
const CASES_PER_MODE = 4;

function vehicleOf(mode: TestReadMode, slot: number): string {
  const offset = mode === 'legacy' ? 0 : CASES_PER_MODE;
  return ctx.vehicles[offset + slot]!;
}

/** Scene preparation happens in `legacy` whatever the mode under test (see the file header). */
function prepare<T>(run: () => Promise<T>): Promise<T> {
  return inLegacy(readMode, run);
}

/**
 * One «the consequences changed after the preview» step: preview, change the world, then send the
 * rollback with the CURRENT version and the STALE fingerprint — so the version check cannot be what
 * refuses, only the fingerprint can. Checks 409 with the fingerprint's own words, nothing erased,
 * and a fresh preview that differs; the caller names what exactly differs.
 */
async function expectStaleAfter(
  requestId: string,
  change: () => Promise<void>,
  differs: (
    shown: VehicleRequestRollbackPreviewDto,
    fresh: VehicleRequestRollbackPreviewDto,
  ) => void,
): Promise<VehicleRequestRollbackPreviewDto> {
  const shown = await previewOk(requestId);
  await prepare(change);
  const changed = await stateOf(requestId);
  const res = await rollback(requestId, await versionOf(requestId), shown.fingerprint);
  expect(res.statusCode, res.body).toBe(409);
  expect(res.json().message).toContain('посмотрите заново');
  expect(await stateOf(requestId)).toEqual(changed);
  const fresh = await previewOk(requestId);
  expect(fresh.fingerprint).not.toBe(shown.fingerprint);
  differs(shown, fresh);
  return fresh;
}

describe.skipIf(!DB_URL)('предпросмотр возврата заказа в «Новую» (живая схема)', () => {
  // Scenes are built through real handlers, dozens of transactions each; five seconds is not it.
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 900_000 });

  beforeAll(async () => {
    // Environment and the own database are ready by the harness (`useReadModeDatabase`).
    process.env.MAIL_ENABLED ??= 'false';

    const { db, closeDb } = await import('../src/db/client');
    const adminEmail = await seedUser('admin', 'admin');
    // The rollback without the journal: exactly the grant composition ADR 0106 made possible.
    const noJournalEmail = await seedUser('nojournal', 'observer', [
      'vehicleRequests.status',
      'requests.rollbackStatus',
    ]);
    const statusOnlyEmail = await seedUser('statusonly', 'observer', ['vehicleRequests.status']);
    const driverId = await seedDriver();

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${OBJECT_CODE}, ${`Площадка предпросмотра отката ${RUN}`}, 'г Москва, ул Откатная, д 1')
      RETURNING id`);

    /*
     * Own freight vehicles with the 4-П form: a day of the order is printed by 4-П (ADR 0207), the
     * relocation too, and the weekly ESM-2 is issued to any own vehicle of an on-site order.
     */
    const needed = CASES_PER_MODE * 2;
    const own = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
         AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
       ORDER BY v.registration_number
       LIMIT ${needed}`);
    if (own.rows.length < needed) {
      throw new Error(`в базе нет ${needed} своих грузовых машин с 4-П: миграции не применены`);
    }

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

    const type = await app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-types',
      headers: admin,
      payload: {
        kindId: own.rows[0]!.kind_id,
        code: TYPE_CODE,
        name: `Ямобуры отката ${RUN}`,
        isLinear: false,
      },
    });
    expect(type.statusCode, type.body).toBe(201);

    const today = moscowDateKeyOf(new Date());
    const monday = weekStartKey(today);
    ctx = {
      app,
      db,
      closeDb,
      admin,
      rollbackNoJournal: await login(noJournalEmail),
      statusOnly: await login(statusOnlyEmail),
      objectId: objectRow.rows[0]!.id,
      driverId,
      typeId: type.json().id as string,
      kindId: own.rows[0]!.kind_id,
      vehicles: own.rows.map((row) => row.id),
      today,
      pastFrom: shiftDateKey(monday, -7),
      pastTo: shiftDateKey(monday, -1),
    };
  });

  afterAll(async () => {
    // No cleanup inside: the database is own and dropped whole by the harness right after this.
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  /*
   * Both read modes. The infrastructure (`beforeAll`/`afterAll`) stays outside: two blocks would
   * mean two `afterAll`, and the first would close the pool under the second.
   */
  describeReadModes(readMode, 'откат в «Новую» и его предпросмотр', (mode) => {
    /**
     * The whole scene: an order started last week, with days in routes, two relocations (one
     * without a waybill, one whose waybill was issued and cancelled), two shift drafts, a pending
     * early end, and ESM-2 of a worked week plus the current one. Preview, a garbage fingerprint,
     * the rollback — and every consequence compared with the preview item by item.
     */
    it('всё, что назвал предпросмотр, и есть то, что сделал откат', async () => {
      const vehicleId = vehicleOf(mode, 0);
      const dateTo = shiftDateKey(ctx.today, 6);
      const dayA = shiftDateKey(ctx.today, 1);
      const dayB = shiftDateKey(ctx.today, 2);

      const { requestId, pickupId } = await prepare(async () => {
        const id = await requestInProgress({ vehicleId, dateFrom: ctx.pastFrom, dateTo });
        // The worked week gets its sheet only by a correction (ADR 0101, Р21): same vehicle.
        await ok(
          inject('PATCH', `/api/v1/vehicle-requests/${id}/assignment`, ctx.admin, {
            vehicleId,
            version: await versionOf(id),
            correction: { operationId: randomUUID(), reason: 'Бумага за отработанную неделю' },
          }),
        );
        await planDay(id, dayA, vehicleId);
        await planDay(id, dayB, vehicleId);
        await addRelocation(id, 'delivery', ctx.today);
        // A relocation that once had a waybill: the waybill is cancelled, the route still stays.
        const pickup = await addRelocation(id, 'pickup', dateTo);
        const pickupWaybill = await issueWaybill(pickup);
        await ok(
          inject('POST', `/api/v1/waybills/${pickupWaybill}/cancel`, ctx.admin, {
            reason: 'бланк испорчен при печати',
          }),
        );
        await fillShift(id, shiftDateKey(ctx.pastFrom, 1));
        await fillShift(id, ctx.today);
        await ok(
          inject('POST', `/api/v1/vehicle-requests/${id}/early-end`, ctx.admin, {
            newDateTo: shiftDateKey(ctx.today, 4),
            reason: 'Работы на фундаменте закончены раньше',
            version: await versionOf(id),
          }),
        );
        return { requestId: id, pickupId: pickup };
      });

      const before = await stateOf(requestId);
      // The scene is what it claims to be — otherwise equality below would prove nothing.
      expect(before.status).toBe('confirmed');
      expect(before.seats.map((s) => s.date).sort()).toEqual([dayA, dayB]);
      expect(before.relocations).toHaveLength(2);
      expect(before.shifts).toHaveLength(2);
      expect(before.earlyEnd?.status).toBe('pending');
      const liveBefore = before.esm2.filter((s) => s.status !== 'cancelled');
      expect(liveBefore.some((s) => s.to < ctx.today)).toBe(true);
      expect(liveBefore.some((s) => s.to >= ctx.today)).toBe(true);

      const shown = await previewOk(requestId);
      // The preview writes nothing: the state is the same, to the version.
      expect(await stateOf(requestId)).toEqual(before);

      expect(shown.blockers).toEqual([]);
      expect(shown.assignment).toBe(true);
      expect(shown.completion).toBe(false);
      expect(byDate(shown.routes.detach)).toEqual(byDate(before.seats));
      expect(shown.routes.frozen).toEqual([]);
      const pickup = before.relocations.find((r) => r.id === pickupId)!;
      const delivery = before.relocations.find((r) => r.id !== pickupId)!;
      expect(shown.relocations.drop).toEqual([
        { routeNumber: delivery.routeNumber, purpose: 'delivery', routeDate: ctx.today },
      ]);
      expect(shown.relocations.keep).toEqual([
        { routeNumber: pickup.routeNumber, purpose: 'pickup', routeDate: dateTo },
      ]);
      expect(shown.shifts).toEqual(before.shifts);
      expect(shown.earlyEnd).toEqual({ newDateTo: before.earlyEnd!.newDateTo });
      expect(shown.dropsLinearFreeze).toBe(before.isLinearFrozen !== null);
      // ESM-2: the current and later weeks burn, the worked one stays (`canCancelWaybill`).
      const cancelIds = shown.esm2.sheets!.cancel.map((s) => s.id).sort();
      const keepIds = shown.esm2.sheets!.keep.map((s) => s.id).sort();
      expect(cancelIds).toEqual(
        liveBefore
          .filter((s) => s.to >= ctx.today)
          .map((s) => s.id)
          .sort(),
      );
      expect(keepIds).toEqual(
        liveBefore
          .filter((s) => s.to < ctx.today)
          .map((s) => s.id)
          .sort(),
      );
      expect(shown.esm2.cancelCount).toBe(cancelIds.length);
      expect(shown.esm2.keepCount).toBe(keepIds.length);
      for (const sheet of shown.esm2.sheets!.cancel) expect(sheet.number).toMatch(/\d/);

      // The rollback right without the journal: same plan, same fingerprint, no numbers.
      const blind = await previewOk(requestId, ctx.rollbackNoJournal);
      expect(blind.esm2.sheets).toBeNull();
      expect(blind.esm2.cancelCount).toBe(shown.esm2.cancelCount);
      expect(blind.esm2.keepCount).toBe(shown.esm2.keepCount);
      expect(blind.fingerprint).toBe(shown.fingerprint);
      expect({ ...blind, esm2: null }).toEqual({ ...shown, esm2: null });

      // A fingerprint that matches no plan at all — 409, and nothing is erased.
      const version = await versionOf(requestId);
      const garbage = await rollback(requestId, version, 'f'.repeat(64));
      expect(garbage.statusCode, garbage.body).toBe(409);
      expect(garbage.json().message).toContain('посмотрите заново');
      expect(await stateOf(requestId)).toEqual(before);

      await ok(rollback(requestId, version, shown.fingerprint));

      const after = await stateOf(requestId);
      expect(after.status).toBe('new');
      // The approval survives the rollback (ADR 0172) — the preview never listed it.
      expect(after.approved).toBe(true);
      expect(after.assignment).toBe(false);
      expect(after.completion).toBe(false);
      // Places: all the preview named are gone, none other existed.
      expect(after.seats).toEqual([]);
      // Relocations: exactly the kept ones remain.
      expect(after.relocations.map((r) => r.routeNumber)).toEqual(
        shown.relocations.keep.map((r) => r.routeNumber),
      );
      expect(after.shifts).toEqual([]);
      expect(after.earlyEnd).toBeNull();
      expect(after.isLinearFrozen).toBeNull();
      // ESM-2: named to cancel — cancelled; named to keep — active; no other sheet was touched.
      const statusById = new Map(after.esm2.map((s) => [s.id, s.status]));
      for (const id of cancelIds) expect(statusById.get(id)).toBe('cancelled');
      for (const id of keepIds) expect(statusById.get(id)).toBe('issued');
      expect(
        after.esm2
          .filter((s) => s.status !== 'cancelled')
          .map((s) => s.id)
          .sort(),
      ).toEqual(keepIds);
      expect(after.esm2.map((s) => s.id).sort()).toEqual(before.esm2.map((s) => s.id).sort());

      // The door's own audit names the same days and relocations the preview showed.
      const audit = await lastStatusAudit(requestId);
      expect(audit.reset).toBe(true);
      expect([...((audit.detachedDays as string[]) ?? [])].sort()).toEqual(
        shown.routes.detach.map((s) => s.date).sort(),
      );
      expect(audit.droppedRelocations).toEqual(shown.relocations.drop.map((r) => r.routeNumber));
    });

    /**
     * Each part of the fingerprint against its own real change after the preview (see
     * `expectStaleAfter`). The order is chosen so every step starts from a plan where its part is
     * present: the delivery relocation is still to drop, the early end still to be asked, and so on.
     * The order's own vehicle type is switched last: it changes nothing but the linearity snapshot.
     *
     * Not covered, because they cannot change while the version stays: `assignment` and
     * `completion` — both move only together with the status or the assignment door, which bump the
     * version, and a stale version is refused before the fingerprint is ever compared.
     */
    it('после просмотра изменилось последствие — 409, и ничего не стёрто', async () => {
      const vehicleId = vehicleOf(mode, 1);
      const dateTo = shiftDateKey(ctx.today, 13);
      const newDay = shiftDateKey(ctx.today, 1);
      const earlyEndTo = shiftDateKey(ctx.today, 4);

      const { requestId, typeId, deliveryId } = await prepare(async () => {
        // A type of its own: switching it must not touch the orders of the other cases.
        const created = await ok(
          inject('POST', '/api/v1/vehicle-types', ctx.admin, {
            kindId: ctx.kindId,
            code: `${TYPE_CODE}_${mode}`,
            name: `Ямобуры отката, переключаемые ${RUN} ${mode}`,
            isLinear: false,
          }),
          201,
        );
        const ownType = created.json().id as string;
        const id = await requestInProgress({
          vehicleId,
          dateFrom: ctx.today,
          dateTo,
          typeId: ownType,
        });
        const delivery = await addRelocation(id, 'delivery', ctx.today);
        return { requestId: id, typeId: ownType, deliveryId: delivery };
      });

      // Places in routes: a day planned after the preview.
      await expectStaleAfter(
        requestId,
        async () => {
          await planDay(requestId, newDay, vehicleId);
        },
        (shown, fresh) => {
          expect(shown.routes.detach).toEqual([]);
          expect(fresh.routes.detach.map((s) => s.date)).toEqual([newDay]);
        },
      );

      // Relocations: the delivery got a waybill (issued and cancelled — an active one would be a
      // blocker, refused before the fingerprint). It moves from «drop» to «keep».
      await expectStaleAfter(
        requestId,
        async () => {
          const waybill = await issueWaybill(deliveryId);
          await ok(
            inject('POST', `/api/v1/waybills/${waybill}/cancel`, ctx.admin, {
              reason: 'бланк испорчен при печати',
            }),
          );
        },
        (shown, fresh) => {
          expect(shown.relocations.drop).toHaveLength(1);
          expect(shown.relocations.keep).toEqual([]);
          expect(fresh.relocations.drop).toEqual([]);
          expect(fresh.relocations.keep).toEqual(shown.relocations.drop);
        },
      );

      // Shifts: a draft appeared.
      await expectStaleAfter(
        requestId,
        () => fillShift(requestId, ctx.today),
        (shown, fresh) => {
          expect(shown.shifts).toEqual([]);
          expect(fresh.shifts).toEqual([{ date: ctx.today, approved: false }]);
        },
      );

      // Early end: requested after the preview…
      await expectStaleAfter(
        requestId,
        async () => {
          await ok(
            inject('POST', `/api/v1/vehicle-requests/${requestId}/early-end`, ctx.admin, {
              newDateTo: earlyEndTo,
              reason: 'Работы закончены раньше',
              version: await versionOf(requestId),
            }),
          );
        },
        (shown, fresh) => {
          expect(shown.earlyEnd).toBeNull();
          expect(fresh.earlyEnd).toEqual({ newDateTo: earlyEndTo });
        },
      );
      // …and withdrawn after the next one.
      await expectStaleAfter(
        requestId,
        async () => {
          await ok(inject('DELETE', `/api/v1/vehicle-requests/${requestId}/early-end`, ctx.admin));
        },
        (shown, fresh) => {
          expect(shown.earlyEnd).toEqual({ newDateTo: earlyEndTo });
          expect(fresh.earlyEnd).toBeNull();
        },
      );

      // ESM-2: a sheet of a coming week cancelled by its own handle — the rollback has one less.
      let burned = '';
      await expectStaleAfter(
        requestId,
        async () => {
          const sheets = (await previewOk(requestId)).esm2.sheets!.cancel;
          burned = sheets[sheets.length - 1]!.id;
          await ok(
            inject('POST', `/api/v1/waybills/${burned}/cancel`, ctx.admin, {
              reason: 'бланк испорчен при печати',
            }),
          );
        },
        (shown, fresh) => {
          expect(shown.esm2.sheets!.cancel.map((s) => s.id)).toContain(burned);
          expect(fresh.esm2.sheets!.cancel.map((s) => s.id)).not.toContain(burned);
          expect(fresh.esm2.cancelCount).toBe(shown.esm2.cancelCount - 1);
        },
      );

      // Linearity snapshot: the order's type switched under it (ADR 0107). The switch writes the
      // snapshot without touching the request version — exactly the case only the fingerprint sees.
      await expectStaleAfter(
        requestId,
        async () => {
          const switchPreview = await ok(
            inject(
              'GET',
              `/api/v1/vehicle-types/${typeId}/linear-switch-preview?isLinear=true`,
              ctx.admin,
            ),
          );
          await ok(
            inject('POST', `/api/v1/vehicle-types/${typeId}/linear`, ctx.admin, {
              isLinear: true,
              fingerprint: switchPreview.json().fingerprint,
            }),
          );
        },
        (shown, fresh) => {
          expect(shown.dropsLinearFreeze).toBe(false);
          expect(fresh.dropsLinearFreeze).toBe(true);
        },
      );

      // With the fingerprint of what is true now, the rollback goes — and does exactly that.
      const last = await previewOk(requestId);
      await ok(rollback(requestId, await versionOf(requestId), last.fingerprint));
      const after = await stateOf(requestId);
      expect(after.status).toBe('new');
      expect(after.seats).toEqual([]);
      expect(after.relocations.map((r) => r.routeNumber)).toEqual(
        last.relocations.keep.map((r) => r.routeNumber),
      );
      expect(after.shifts).toEqual([]);
      expect(after.earlyEnd).toBeNull();
      expect(after.isLinearFrozen).toBeNull();
      expect(
        after.esm2
          .filter((s) => s.status !== 'cancelled')
          .map((s) => s.id)
          .sort(),
      ).toEqual(last.esm2.sheets!.keep.map((s) => s.id).sort());
    });

    /**
     * Blockers are the door's refusals, word for word: an approved shift answers 422, an active
     * waybill of a day's route answers 409 — and the preview names both with the same messages,
     * still describing the rest of the request, frozen day included.
     */
    it('блокировки предпросмотр называет словами двери', async () => {
      const vehicleId = vehicleOf(mode, 2);
      const frozenDay = shiftDateKey(ctx.today, 1);
      const requestId = await prepare(async () => {
        const id = await requestInProgress({
          vehicleId,
          dateFrom: ctx.today,
          dateTo: shiftDateKey(ctx.today, 3),
        });
        const frozenRoute = await planDay(id, frozenDay, vehicleId);
        await issueWaybill(frozenRoute);
        await fillShift(id, ctx.today);
        await ok(
          inject('POST', `/api/v1/vehicle-requests/${id}/shifts/${ctx.today}/approval`, ctx.admin, {
            approved: true,
          }),
        );
        return id;
      });

      const both = await previewOk(requestId);
      expect(both.blockers.map((b) => b.code)).toEqual(['approved_shifts', 'active_waybill']);
      expect(both.routes.detach).toEqual([]);
      expect(both.routes.frozen.map((s) => s.date)).toEqual([frozenDay]);
      expect(both.shifts).toEqual([{ date: ctx.today, approved: true }]);

      const refusedShifts = await rollback(requestId, await versionOf(requestId));
      expect(refusedShifts.statusCode, refusedShifts.body).toBe(422);
      expect(refusedShifts.json().message).toBe(both.blockers[0]!.message);

      await prepare(async () => {
        await ok(
          inject(
            'POST',
            `/api/v1/vehicle-requests/${requestId}/shifts/${ctx.today}/approval`,
            ctx.admin,
            { approved: false },
          ),
        );
      });
      const waybillOnly = await previewOk(requestId);
      expect(waybillOnly.blockers.map((b) => b.code)).toEqual(['active_waybill']);
      const refusedWaybill = await rollback(requestId, await versionOf(requestId));
      expect(refusedWaybill.statusCode, refusedWaybill.body).toBe(409);
      expect(refusedWaybill.json().message).toBe(waybillOnly.blockers[0]!.message);
      expect((await stateOf(requestId)).status).toBe('confirmed');
    });

    /**
     * The fingerprint is optional on the transition period: a tab opened before the preview
     * existed sends the rollback without it and must keep working. Plus the route's own bounds.
     */
    it('без отпечатка откат проходит; чужой возврат и чужое право — отказ', async () => {
      const requestId = await prepare(() =>
        requestInProgress({
          vehicleId: vehicleOf(mode, 3),
          dateFrom: ctx.today,
          dateTo: shiftDateKey(ctx.today, 2),
        }),
      );

      // Status right without the rollback right: the preview refuses exactly like the door.
      const forbidden = await preview(requestId, await versionOf(requestId), ctx.statusOnly);
      expect(forbidden.statusCode, forbidden.body).toBe(403);
      const doorForbidden = await inject(
        'PATCH',
        `/api/v1/vehicle-requests/${requestId}/status`,
        ctx.statusOnly,
        { status: 'new', comment: 'нет права', version: await versionOf(requestId) },
      );
      expect(doorForbidden.statusCode, doorForbidden.body).toBe(403);

      // A stale version is a conflict, as at the door.
      const staleVersion = await preview(requestId, (await versionOf(requestId)) - 1);
      expect(staleVersion.statusCode, staleVersion.body).toBe(409);

      const shown = await previewOk(requestId);
      expect(shown.esm2.cancelCount).toBeGreaterThan(0);
      const cancelIds = shown.esm2.sheets!.cancel.map((s) => s.id).sort();

      await ok(rollback(requestId, await versionOf(requestId)));
      const after = await stateOf(requestId);
      expect(after.status).toBe('new');
      expect(
        after.esm2
          .filter((s) => s.status === 'cancelled')
          .map((s) => s.id)
          .sort(),
      ).toEqual(cancelIds);

      // «Отменена» → «Новая» is a rollback that erases nothing: no plan to show.
      await prepare(async () => {
        await ok(
          inject('PATCH', `/api/v1/vehicle-requests/${requestId}/status`, ctx.admin, {
            status: 'cancelled',
            comment: 'Заказ снят',
            version: await versionOf(requestId),
          }),
        );
      });
      const fromCancelled = await preview(requestId, await versionOf(requestId));
      expect(fromCancelled.statusCode, fromCancelled.body).toBe(422);
    });
  });
});
