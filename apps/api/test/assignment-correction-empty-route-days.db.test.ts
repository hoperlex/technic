import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { useReadModeDatabase } from './assignment-read-mode';
// Types only: the values of these modules are taken by `await import` after the environment is in
// place — the config is read at import time and dies without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * An assignment correction whose every signed day sits in a day route is EMPTY, and the door
 * refuses it (Р31) — the meeting point of two rules that live in different places.
 *
 * - Which sign-offs a correction clears is the single carrier of
 *   [ADR 0210](../../../docs/adr/0210-assignment-correction-shift-approvals-by-day.md),
 *   `approvalsClearedByAssignmentCorrection` in `services/shift-approval-scope.ts`: a day that sits
 *   in a day route keeps its sign-off, because the route names its own vehicle.
 * - The effective date of the correction (`planAssignmentCorrection` in `routes/vehicle-requests.ts`)
 *   is assembled from the sheets to reissue, the past weeks without paper and the sign-offs to
 *   clear — the latter taken from that same carrier. When all three are empty, the correction says
 *   nothing about the past and is refused with `ASSIGNMENT_CORRECTION_EMPTY_MESSAGE`.
 *
 * WHAT BREAKS IF THE TWO DRIFT. Were the effective date assembled from ALL sign-offs rather than
 * from the ones the carrier clears, a day that keeps its sign-off would still reach it: the
 * `correction` block would stop being empty and become exactly what Р31 forbids — a way past the
 * lock of approved days that corrects nothing, authorized by the depth of a day it does not touch.
 * `shift-approval-scope.db.test.ts` proves which days are cleared; this file proves the door does
 * not count the kept ones either.
 *
 * WHY A LINEAR ORDER. Not because linearity decides anything — ADR 0210 took it out of the rule.
 * A linear order has `esm2Mode = 'on_demand'`, so `esm2CorrectionScope` gives it no sheets and no
 * past weeks, and the effective date comes from the sign-offs alone. A non-linear order would bring
 * its auto-issued weekly sheets into the correction and make it non-empty for another reason.
 *
 * WHY A DATABASE. The sign-off is `vehicle_request_shifts.approved_at`, the fact "the day is in a
 * route" is `vehicle_route_requests.work_date` tied to the route's date by a composite FK, and the
 * refusal comes from a live HTTP door. None of that is reproducible on rules.
 *
 * Carried over from the parallel 4-П session's `assignment-correction-day-approvals.db.test.ts`,
 * re-pointed from its own carrier of the rule (which was not taken) to the ADR 0210 one. Its
 * second assertion — that the plain reassign door is locked by the same sign-off — is not carried:
 * the plain door's lock is being reworked to the same day rule, and pinning today's answer here
 * would fight that change instead of guarding this one.
 *
 * Run (the harness creates and migrates its own database, and drops it afterwards):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_test \
 *     npx vitest run test/assignment-correction-empty-route-days.db.test.ts
 *
 * Without `TEST_DATABASE_URL` the file is skipped, as every db test is.
 */

/*
 * Own database: the module's control row is one per database, and the doors under test read it
 * (`FOR SHARE`). This file pins it to `legacy` — the mode in which the reassign door's correction
 * is live — and a shared database would let a neighbour switch it mid-scene.
 */
const readMode = useReadModeDatabase('emptycorr');
/*
 * A scene is a chain of HTTP doors — an order opened backdated, its visa, take into work, the
 * hours, the signature, a day into a route, the correction — and each of them hashes, locks and
 * writes. Vitest's 5 s default does not cover that on a loaded machine, and a timeout here is worse
 * than a red line: vitest abandons the request while fastify keeps serving it, so its locks outlive
 * the failure. The hook needs room too: the harness drops the database `WITH (FORCE)` in `afterAll`.
 * At module scope because the hooks that need it are registered by `useReadModeDatabase` above.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 900_000 });
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

const ADMIN_EMAIL = 'db-empty-correction-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: пустая коррекция при днях в рейсах';
/**
 * Name starting with "Я": half of the db tests take a type of their kind by
 * `ORDER BY vt.name LIMIT 1`, and a type named with an "А" would drag their requests into another
 * document flow.
 */
const LINEAR_TYPE_NAME = 'Ямобуры тестовые (пустая коррекция, линейные)';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  objectId: string;
  /** The machine of the assignment: the order is taken into work on it. */
  vehicleId: string;
  /** The machine the correction moves the assignment to. */
  otherVehicleId: string;
  /** The machine that actually went out on the routed day — a third one, deliberately. */
  dayVehicleId: string;
  driverId: string;
  linearTypeId: string;
  /** A past day of the term that goes into a route of its own. */
  dayInRoute: string;
  termFrom: string;
  today: string;
}

let ctx: Ctx;

async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  await db.insert(schema.users).values({
    email: ADMIN_EMAIL,
    lastName: 'Тестовый',
    firstName: 'Администратор',
    middleName: '',
    passwordHash: await hashPassword(PASSWORD),
    role: 'admin',
    isActive: true,
  });
}

/** A machinist: a person with the "driver" specialization — without one no route is issued. */
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
    .values({
      lastName: 'Дневнов',
      firstName: 'Пётр',
      middleName: 'Тестович',
      comment: PERSON_MARK,
    })
    .returning({ id: schema.persons.id });
  await db.insert(schema.personSpecializations).values({
    personId: person!.id,
    specializationId: specialization.id,
    isPrimary: true,
    startedOn: '2024-01-15',
    endedOn: null,
  });
  return person!.id;
}

async function createLinearType(kindId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
    payload: {
      kindId,
      code: `empty_corr_${Date.now()}`,
      name: LINEAR_TYPE_NAME,
      isLinear: true,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/**
 * An on-site order opened BACKDATED and taken into work at once.
 *
 * Backdated because the case has nowhere else to get a worked day: an order that starts today has
 * no past day to sign, and the sign-off of a future day is what a correction never touches.
 */
async function orderInWork(): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.linearTypeId,
      dateFrom: ctx.termFrom,
      dateTo: ctx.today,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      backdateReason: 'Техника вышла раньше, чем оформили заявку',
      operationId: crypto.randomUUID(),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();

  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: approved.json().version,
      assignment: {
        vehicleId: ctx.vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
      },
      schedule: {
        requestType: 'special_equipment',
        dateFrom: ctx.termFrom,
        dateTo: ctx.today,
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return { id: request.id as string, version: confirmed.json().version as number };
}

/** Hours of the day and the site's sign-off under them — the thing the correction argues about. */
async function signDay(requestId: string, date: string): Promise<void> {
  const filled = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/vehicle-requests/${requestId}/shifts/${date}`,
    headers: ctx.auth,
    payload: { machineHours: 11.5, refuel: '', comment: '' },
  });
  expect(filled.statusCode, filled.body).toBe(200);
  const approved = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/shifts/${date}/approval`,
    headers: ctx.auth,
    payload: { approved: true },
  });
  expect(approved.statusCode, approved.body).toBe(200);
}

/**
 * Put the day into a route of its own, on the machine that really went out.
 *
 * A past day is planned with a stated reason — the door asks for it under `waybills.correct`
 * (ADR 0101 п. 4): "allowed" has not meant "silently" since.
 */
async function planDayInRoute(requestId: string, date: string, vehicleId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    headers: ctx.auth,
    payload: {
      newRoute: { vehicleId, driverPersonId: ctx.driverId },
      reason: 'Выезд оформляем по факту — машина отработала день',
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const day = res
    .json()
    .items.find((item: { date: string; route: unknown }) => item.date === date) as {
    route: { id: string } | null;
  };
  expect(day.route, 'день обязан стоять в рейсе — иначе сцена проверяет не то').not.toBeNull();
}

function correctAssignment(
  request: { id: string; version: number },
  vehicleId: string,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/assignment`,
    headers: ctx.auth,
    payload: {
      vehicleId,
      version: request.version,
      correction: { operationId: crypto.randomUUID(), reason: 'Править нечего' },
    },
  });
}

/** Days of the request with their sign-offs, as the table holds them. */
async function signedDaysOf(requestId: string): Promise<Record<string, boolean>> {
  const res = await ctx.db.execute<{ shift_date: string; signed: boolean }>(sql`
    SELECT shift_date::text, approved_at IS NOT NULL AS signed
    FROM vehicle_request_shifts
    WHERE request_id = ${requestId}
    ORDER BY shift_date`);
  return Object.fromEntries(res.rows.map((row) => [row.shift_date, row.signed]));
}

describe.skipIf(!DB_URL)('коррекция назначения при днях в рейсах (живая схема)', () => {
  beforeAll(async () => {
    // The environment and the own database are ready by the harness hook — the admin is all that
    // is left to seed.
    await seedAdmin();
    // Pinned explicitly: the door under test is the legacy one, and the default of the control row
    // is not a reason to guess which mode the scene ran in.
    await readMode.setReadMode('legacy');

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    const vehicles = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vk.code = 'special_equipment'
      ORDER BY v.registration_number
      LIMIT 3`);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
    );
    const [first, second, third] = vehicles.rows;
    const object = objects.rows[0];
    if (!first || !second || !third || !object) {
      throw new Error('в базе нет трёх своих спецмашин или объекта: миграции не применены');
    }

    const today = moscowDateKeyOf(new Date());
    const monday = weekStartKey(today);
    ctx = {
      app,
      db,
      closeDb,
      auth,
      objectId: object.id,
      vehicleId: first.id,
      otherVehicleId: second.id,
      dayVehicleId: third.id,
      driverId: await seedDriver(),
      linearTypeId: '',
      // A day of the past calendar week: worked whichever day the run happens on, and inside the
      // term of the order.
      dayInRoute: shiftDateKey(monday, -2),
      termFrom: shiftDateKey(monday, -7),
      today,
    };
    ctx.linearTypeId = await createLinearType(first.kind_id);
  }, 180_000);

  afterAll(async () => {
    /*
     * Nothing is cleaned up by hand: the database belongs to this file alone and the harness drops
     * it. Its own connections are closed here, before that — a dropped database tears them off
     * from the outside, and `pg` throws `57P01` with nobody to catch it.
     */
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('коррекция, у которой все подписанные дни стоят в рейсах, пуста и отклоняется', async () => {
    const request = await orderInWork();
    await signDay(request.id, ctx.dayInRoute);
    await planDayInRoute(request.id, ctx.dayInRoute, ctx.dayVehicleId);

    const res = await correctAssignment(request, ctx.otherVehicleId);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().message).toContain('ничего не правит задним числом');
    // Refused whole: the kept sign-off is still in the table, and nothing else moved either.
    expect(await signedDaysOf(request.id)).toEqual({ [ctx.dayInRoute]: true });
    const assigned = await ctx.db.execute<{ vehicle_id: string }>(sql`
      SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${request.id}`);
    expect(assigned.rows.map((row) => row.vehicle_id)).toEqual([ctx.vehicleId]);
  });
});
