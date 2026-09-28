import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type AccessSubject,
  type AssignmentPreviewDto,
  type AssignmentVehicleCorrectionInput,
  type VehicleRequestDto,
} from '@technic/contracts';
import { useReadModeDatabase } from './assignment-read-mode';
// Types only: the values are imported with `await import` once the environment is set — the config
// validates it at import time and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as AssignmentCommand from '../src/services/assignment-command';
import type * as AssignmentCorrection from '../src/services/assignment-correction';
import type * as AssignmentWrite from '../src/services/assignment-write';

/**
 * Object sign-offs under an assignment correction — the rule of ADR 0210, end to end.
 *
 * WHAT IS PROVEN. One rule, three callers, one answer:
 *
 * - the reassign door's correction (`PATCH /vehicle-requests/:id/assignment` with `correction`)
 *   clears the sign-off of a route-less day and keeps the sign-off of a day that sits in a day
 *   route, for a linear and a non-linear request alike;
 * - its preview (`POST …/assignment/preview`) names exactly the days the door then clears — and the
 *   door accepts the preview's fingerprint, which it recomputes under its own locks: had the two
 *   sets differed, the command would have answered 409;
 * - the period correction (`assignment-correction.ts`) applies the same rule inside its own
 *   `approvalClearRange`;
 * - a plain reassignment is locked by exactly the same days: an approved day in its own route does
 *   not lock it, a route-less one does, and a rented next vehicle makes every approved day lock —
 *   the summary the portal reads, the preview and the door agree;
 * - the correction re-asks its set under its locks: a sign-off appearing between the plan and the
 *   transaction ends in 409, not in clearing a set nobody saw;
 * - the plain reassignment re-asks its lock under its locks from a snapshot proven current: a
 *   sign-off landing while it queues locks it, even when the sign door did not touch the request
 *   row.
 *
 * WHY A DATABASE. The carrier of "the day had a route" is a composition row
 * (`vehicle_route_requests.work_date`) tied to its route by a composite FK; the sign-off is
 * `vehicle_request_shifts.approved_at`; the snapshot lives in `waybill_corrections`. None of these
 * is reproducible on objects in memory, and the preview/door agreement is a property of two
 * separate transactions.
 *
 * WHY ITS OWN DATABASE. The assignment doors take the module's control row (`FOR SHARE`), and a
 * neighbour file switching the read mode on the shared base would change what they do. The file
 * runs in `legacy` only: the rule does not depend on the read mode, and the paper half of these
 * doors — which does — is covered by `assignment-reassign.db.test.ts` and
 * `assignment-correction.db.test.ts`.
 *
 * Run:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_test \
 *     npx vitest run test/shift-approval-scope.db.test.ts
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like every `*.db.test.ts`.
 */

const readMode = useReadModeDatabase('apprscope');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const ADMIN_EMAIL = `db-apprscope-${RUN}@example.invalid`;
const PASSWORD = 'db-test-password-123';
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: подписи объекта при коррекции назначения';
const TYPE_PREFIX = 'apprscope_';
/** Late in the alphabet, so neighbours picking "the first type of a kind" never pick these. */
const LINEAR_TYPE_NAME = 'Ямобуры тестовые (подписи, линейные)';
const PLAIN_TYPE_NAME = 'Ямобуры тестовые (подписи, обычные)';
/** Every test here runs several HTTP doors on a loaded machine: five seconds is not the subject. */
const SLOW = 120_000;

// ── Calendar ──
//
// Everything counts from this week's Monday: the previous week is worked out whatever day the run
// happens on, so its days can be filled, signed off and corrected.

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
const PAST_FROM = shiftDateKey(MONDAY, -7);
/** Signed off and put into a day route of another vehicle — its sign-off must survive. */
const ROUTE_DAY = shiftDateKey(PAST_FROM, 1);
/** Signed off with no route — worked by the assignment's vehicle, its sign-off must go. */
const PLAIN_DAY = shiftDateKey(PAST_FROM, 2);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  command: typeof AssignmentCommand;
  correction: typeof AssignmentCorrection;
  auth: { authorization: string };
  adminId: string;
  objectId: string;
  /** Own special equipment: A is assigned, B drives the day route, C is what "really worked". */
  vehicleA: string;
  vehicleB: string;
  vehicleC: string;
  /** A rented unit: correcting to it sweeps the day routes (`dayRoutesKeptWith`). */
  rentalVehicle: string;
  driver: string;
  linearTypeId: string;
  plainTypeId: string;
}

let ctx: Ctx;

describe.skipIf(!DB_URL)('подписи объекта при коррекции назначения (ADR 0210)', () => {
  beforeAll(async () => {
    const { buildApp: build } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');

    const [admin] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${ADMIN_EMAIL}, 'Подписев', 'Пров', '', ${await hashPassword(PASSWORD)}, 'admin',
                true, now())
        RETURNING id`)
    ).rows;
    const app = await build();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    const fleet = async (ownership: 'own' | 'rental', limit: number) =>
      (
        await db.execute<{ id: string; kind_id: string }>(sql`
          SELECT v.id, vt.kind_id FROM vehicles v
            JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
            JOIN vehicle_kinds vk ON vk.id = vt.kind_id
           WHERE v.ownership = ${ownership} AND v.status = 'active' AND v.deleted_at IS NULL
             AND vk.code = 'special_equipment'
           ORDER BY v.registration_number, v.id
           LIMIT ${limit}`)
      ).rows;
    const own = await fleet('own', 3);
    const [rental] = await fleet('rental', 1);
    const [object] = (
      await db.execute<{ id: string }>(
        sql`SELECT id FROM construction_objects WHERE is_active ORDER BY code LIMIT 1`,
      )
    ).rows;
    if (own.length < 3 || !rental || !object) {
      throw new Error('the seed has no three own special vehicles, a rented one or an object');
    }

    ctx = {
      app,
      db,
      closeDb,
      command: await import('../src/services/assignment-command'),
      correction: await import('../src/services/assignment-correction'),
      auth: { authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}` },
      adminId: admin!.id,
      objectId: object.id,
      vehicleA: own[0]!.id,
      vehicleB: own[1]!.id,
      vehicleC: own[2]!.id,
      rentalVehicle: rental.id,
      driver: '',
      linearTypeId: '',
      plainTypeId: '',
    };
    ctx.driver = await seedDriver();
    ctx.linearTypeId = await createType(own[0]!.kind_id, true);
    ctx.plainTypeId = await createType(own[0]!.kind_id, false);
  }, SLOW);

  afterAll(async () => {
    // No row cleanup: the base is the file's own and `useReadModeDatabase` drops it right after
    // this hook. What must happen here is closing the pool — the drop is `WITH (FORCE)`, and a pool
    // still open would have its connections killed under it and surface as uncaught 57P01 errors.
    await ctx?.app.close();
    await ctx?.closeDb();
  }, SLOW);

  // ── The reassign door and its preview ──

  it(
    'обычный заказ: подпись дня в рейсе другой машины остаётся, дня без рейса — снимается',
    async () => {
      const request = await confirmed(ctx.plainTypeId, { driverPersonId: ctx.driver });
      await signOff(request.id, ROUTE_DAY);
      await signOff(request.id, PLAIN_DAY);
      // The day went out on vehicle B's route while the assignment says A — the per-day door allows
      // exactly that and only marks the mismatch (ADR 0207 §5).
      await putIntoRoute(request.id, ROUTE_DAY, ctx.vehicleB);

      const cleared = await correctAndCompare(request, ctx.vehicleC);
      expect(cleared).toEqual([PLAIN_DAY]);

      expect(await approvedDays(request.id)).toEqual([ROUTE_DAY]);
      // Hours stay on both days: the correction disputes the vehicle, not the work.
      expect(await hoursOf(request.id)).toEqual({ [ROUTE_DAY]: 8, [PLAIN_DAY]: 8 });
      // The snapshot keeps exactly the cleared sign-off with its previous signer.
      const snapshot = await snapshotApprovals(request.id);
      expect(snapshot.map((a) => a.date)).toEqual([PLAIN_DAY]);
      expect(snapshot[0]!.approvedBy).toBe(ctx.adminId);
      // And so does the audit feed.
      expect(await auditedClearedDays(request.id)).toEqual([PLAIN_DAY]);
    },
    SLOW,
  );

  it(
    'линейный заказ больше не исключение: подпись дня без рейса снимается, дня в рейсе — остаётся',
    async () => {
      // Before ADR 0210 a linear request lost no sign-off at all, route or not. The linear type no
      // longer decides: a route-less day of a linear request is worked by the default vehicle.
      const request = await confirmed(ctx.linearTypeId);
      await signOff(request.id, ROUTE_DAY);
      await signOff(request.id, PLAIN_DAY);
      await putIntoRoute(request.id, ROUTE_DAY, ctx.vehicleB);

      const cleared = await correctAndCompare(request, ctx.vehicleC);
      expect(cleared).toEqual([PLAIN_DAY]);
      expect(await approvedDays(request.id)).toEqual([ROUTE_DAY]);
      // The day route itself is untouched: the correction rewrote the default, not the day.
      expect(await routeDays(request.id)).toEqual([ROUTE_DAY]);
    },
    SLOW,
  );

  it(
    'коррекция на арендную машину снимает и подпись дня в рейсе: рейсы дня уходят вместе с ней',
    async () => {
      // A rented vehicle does not go on routes, so the door's own day sync takes the day off B's
      // route. The day then falls under the assignment — keeping its sign-off would leave hours the
      // object accepted for B attributed to the rented unit.
      const request = await confirmed(ctx.linearTypeId);
      await signOff(request.id, ROUTE_DAY);
      await signOff(request.id, PLAIN_DAY);
      await putIntoRoute(request.id, ROUTE_DAY, ctx.vehicleB);

      const cleared = await correctAndCompare(request, ctx.rentalVehicle, { pricePerHour: 1000 });
      expect(cleared).toEqual([ROUTE_DAY, PLAIN_DAY]);
      expect(await approvedDays(request.id)).toEqual([]);
      expect(await routeDays(request.id)).toEqual([]);
    },
    SLOW,
  );

  // ── The lock of a plain reassignment ──

  it(
    'обычная смена: подписи только дней в рейсах не запирают — и портал, и дверь',
    async () => {
      const request = await confirmed(ctx.plainTypeId, { driverPersonId: ctx.driver });
      await signOff(request.id, ROUTE_DAY);
      await putIntoRoute(request.id, ROUTE_DAY, ctx.vehicleB);

      // The summary the portal locks by: one approved day, none of them the assignment's.
      const dto = await requestDto(request.id);
      expect(dto.shifts).toMatchObject({ approvedDays: 1, approvedDaysWithoutRoute: 0 });

      const preview = await previewPlain(request, ctx.vehicleC);
      expect(preview.blockedShiftDays).toEqual([]);
      const res = await reassignPlain(request, ctx.vehicleC, preview.fingerprint);
      expect(res.statusCode, res.body).toBe(200);
      // The route day keeps its sign-off: a plain reassignment never clears one.
      expect(await approvedDays(request.id)).toEqual([ROUTE_DAY]);
    },
    SLOW,
  );

  it(
    'обычная смена: подписанный день без рейса запирает',
    async () => {
      const request = await confirmed(ctx.plainTypeId, { driverPersonId: ctx.driver });
      await signOff(request.id, ROUTE_DAY);
      await signOff(request.id, PLAIN_DAY);
      await putIntoRoute(request.id, ROUTE_DAY, ctx.vehicleB);

      const dto = await requestDto(request.id);
      expect(dto.shifts).toMatchObject({ approvedDays: 2, approvedDaysWithoutRoute: 1 });
      const preview = await previewPlain(request, ctx.vehicleC);
      expect(preview.blockedShiftDays.map((day) => day.date)).toEqual([PLAIN_DAY]);

      const res = await reassignPlain(request, ctx.vehicleC);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json<{ message: string }>().message).toContain('согласовано смен: 1');
      expect(await assignedVehicle(request.id)).toBe(ctx.vehicleA);
    },
    SLOW,
  );

  it(
    'линейный заказ: тот же замок — день в рейсе не запирает, день без рейса запирает',
    async () => {
      const routed = await confirmed(ctx.linearTypeId);
      await signOff(routed.id, ROUTE_DAY);
      await putIntoRoute(routed.id, ROUTE_DAY, ctx.vehicleB);
      const passed = await reassignPlain(routed, ctx.vehicleC);
      expect(passed.statusCode, passed.body).toBe(200);

      const plain = await confirmed(ctx.linearTypeId);
      await signOff(plain.id, PLAIN_DAY);
      const refused = await reassignPlain(plain, ctx.vehicleC);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json<{ message: string }>().message).toContain('подтверждённые дни');
    },
    SLOW,
  );

  it(
    'обычная смена на арендную машину запирается и днём в рейсе: рейсы уйдут вместе с ней',
    async () => {
      // The portal offers the button (it cannot know the next vehicle), the door refuses: with a
      // rented vehicle the day sync sweeps the route, and the approved day would fall under it.
      const request = await confirmed(ctx.linearTypeId);
      await signOff(request.id, ROUTE_DAY);
      await putIntoRoute(request.id, ROUTE_DAY, ctx.vehicleB);

      const preview = await previewPlain(request, ctx.rentalVehicle, { pricePerHour: 1000 });
      expect(preview.blockedShiftDays.map((day) => day.date)).toEqual([ROUTE_DAY]);
      const res = await reassignPlain(request, ctx.rentalVehicle, undefined, {
        pricePerHour: 1000,
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(await routeDays(request.id)).toEqual([ROUTE_DAY]);
    },
    SLOW,
  );

  // ── The correction's set is re-asked under its locks ──

  it(
    'подпись, появившаяся между планом коррекции и её транзакцией, даёт 409 и ничего не снимает',
    async () => {
      const request = await confirmed(ctx.plainTypeId, { driverPersonId: ctx.driver });
      await signOff(request.id, PLAIN_DAY);
      const LATE_DAY = shiftDateKey(PAST_FROM, 3);

      // The holder takes the request row the way every shift door does; the correction plans on the
      // pool, then queues behind it. The late sign-off lands while it waits — after its plan.
      const holder = new pg.Client({ connectionString: readMode.url });
      const probe = new pg.Client({ connectionString: readMode.url });
      await holder.connect();
      await probe.connect();
      let res: Awaited<ReturnType<typeof ctx.app.inject>>;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM vehicle_requests WHERE id = $1 FOR UPDATE', [
          request.id,
        ]);
        const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
        const inFlight = ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/vehicle-requests/${request.id}/assignment`,
          headers: ctx.auth,
          payload: {
            vehicleId: ctx.vehicleC,
            // Named so that the command, once let through, would really run to the end: the
            // correction issues the past week afresh and needs a machinist for it.
            driverPersonId: ctx.driver,
            version: request.version,
            correction: {
              operationId: randomUUID(),
              reason: 'На объекте работала другая машина',
              unlockWaybillIds: [],
            },
          },
        });
        await waitUntilBlocked(probe, holderPid);
        await holder.query(
          `INSERT INTO vehicle_request_shifts (request_id, shift_date, machine_hours, comment,
                                               filled_by, approved_by, approved_at)
           VALUES ($1, $2, 8, '', $3, $3, now())`,
          [request.id, LATE_DAY, ctx.adminId],
        );
        await holder.query('COMMIT');
        res = await inFlight;
      } finally {
        await holder.end();
        await probe.end();
      }

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('assignment_preview_stale');
      // Nothing cleared, nothing reassigned: the refusal came before the first write.
      expect(await approvedDays(request.id)).toEqual([PLAIN_DAY, LATE_DAY].sort());
      expect(await assignedVehicle(request.id)).toBe(ctx.vehicleA);
    },
    SLOW,
  );

  it(
    'подпись дня без рейса, поставленная пока обычная смена ждёт блокировку, запирает её',
    async () => {
      /*
       * The mechanism the lock must survive (ADR 0210 §8): the plain reassignment runs under
       * `REPEATABLE READ`, its snapshot is taken before it queues for the request row, and the sign
       * door touches that row only to raise the dirty mark — not at all when the mark is already
       * up. The holder below plays such a sign door: it takes the request row, signs a day that was
       * filled earlier (an UPDATE of an existing shift row, as `setShiftApproval` does) and leaves
       * the request row untouched. Without the locking read the swap answered 200 from its old
       * snapshot, over the fresh signature.
       */
      const request = await confirmed(ctx.plainTypeId, { driverPersonId: ctx.driver });
      await ctx.db.execute(sql`
        INSERT INTO vehicle_request_shifts (request_id, shift_date, machine_hours, comment, filled_by)
        VALUES (${request.id}, ${PLAIN_DAY}, 8, '', ${ctx.adminId})`);
      await ctx.db.execute(
        sql`UPDATE vehicle_requests SET assignment_history_dirty = true WHERE id = ${request.id}`,
      );
      const version = (await requestDto(request.id)).version;

      const holder = new pg.Client({ connectionString: readMode.url });
      const probe = new pg.Client({ connectionString: readMode.url });
      await holder.connect();
      await probe.connect();
      let res: Awaited<ReturnType<typeof ctx.app.inject>>;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM vehicle_requests WHERE id = $1 FOR UPDATE', [
          request.id,
        ]);
        const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
        const inFlight = reassignPlain({ id: request.id, version }, ctx.vehicleC);
        await waitUntilBlocked(probe, holderPid);
        await holder.query(
          `UPDATE vehicle_request_shifts SET approved_by = $3, approved_at = now()
            WHERE request_id = $1 AND shift_date = $2`,
          [request.id, PLAIN_DAY, ctx.adminId],
        );
        await holder.query('COMMIT');
        res = await inFlight;
      } finally {
        await holder.end();
        await probe.end();
      }

      expect(res.statusCode, res.body).toBe(422);
      expect(res.json<{ message: string }>().message).toContain('согласовано смен: 1');
      expect(await assignedVehicle(request.id)).toBe(ctx.vehicleA);
      expect(await approvedDays(request.id)).toEqual([PLAIN_DAY]);
    },
    SLOW,
  );

  // ── The period correction ──

  it(
    'периодная коррекция: то же правило внутри своего диапазона',
    async () => {
      await inPeriodScene(async (tx, scene) => {
        const body: AssignmentVehicleCorrectionInput = {
          target: { dimension: 'vehicle', effectiveDate: PAST_FROM },
          vehicleId: scene.vehicleC,
          version: 0,
        };
        const preview =
          await ctx.command.previewAssignmentCommand<AssignmentCorrection.VehicleCorrectionPlan>(
            executorOf(tx),
            {
              requestId: scene.requestId,
              actor: { id: ctx.adminId },
              asOf: scene.asOf,
              plan: (planCtx) => ctx.correction.planVehicleCorrection(planCtx, body),
            },
          );
        const dto = ctx.correction.correctionPreviewDto(
          preview.effects,
          preview.plan,
          preview.fingerprint,
          preview.asOf,
        );
        // The range is the corrected segment — last week — and the route day inside it is spared.
        expect(dto.approvalClearRange).toEqual([{ from: PAST_FROM, to: shiftDateKey(MONDAY, -1) }]);
        expect(dto.clearedApprovals.map((a) => a.date)).toEqual([PLAIN_DAY]);

        const outcome = await ctx.command.runAssignmentCommand<
          AssignmentCorrection.VehicleCorrectionPlan,
          AssignmentWrite.AssignmentWriteResult,
          AssignmentCorrection.CorrectionPaper
        >(
          executorOf(tx),
          ctx.correction.vehicleCorrectionSpec({
            requestId: scene.requestId,
            actor: { ...DISPATCHER, id: ctx.adminId },
            // The fingerprint carries the cleared days: had the command computed another set, it
            // would have answered 409 instead of running.
            input: {
              ...body,
              previewFingerprint: dto.fingerprint,
              operation: { operationId: randomUUID(), reason: 'в наряде была другая машина' },
            },
            asOf: scene.asOf,
          }),
        );
        expect(outcome.paper!.clearedApprovals).toEqual([PLAIN_DAY]);

        const approved = (
          await tx.execute<{ shift_date: string }>(sql`
          SELECT shift_date::text FROM vehicle_request_shifts
           WHERE request_id = ${scene.requestId} AND approved_at IS NOT NULL
           ORDER BY shift_date`)
        ).rows.map((row) => row.shift_date);
        // The route day keeps its sign-off; so does the day of the second segment, which lies
        // outside the range and was worked by another vehicle in the first place.
        expect(approved).toEqual([ROUTE_DAY, MONDAY]);
      });
    },
    SLOW,
  );
});

// ── Helpers ──

/** The dispatcher has `waybills.correct` — enough for a correction a week deep (ADR 0101 §7). */
const DISPATCHER: AccessSubject = { role: 'dispatcher' };

async function seedDriver(): Promise<string> {
  const [person] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO persons (last_name, first_name, middle_name, comment)
      VALUES ('Подписев', 'Машинист', 'Тестович', ${PERSON_MARK}) RETURNING id`)
  ).rows;
  const [spec] = (
    await ctx.db.execute<{ id: string }>(sql`SELECT id FROM specializations WHERE code = 'driver'`)
  ).rows;
  await ctx.db.execute(sql`
    INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
    VALUES (${person!.id}, ${spec!.id}, true, ${shiftDateKey(PAST_FROM, -400)})`);
  return person!.id;
}

let typeNo = 0;
async function createType(kindId: string, isLinear: boolean): Promise<string> {
  typeNo += 1;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-types',
    headers: ctx.auth,
    payload: {
      kindId,
      code: `${TYPE_PREFIX}${RUN}_${typeNo}`,
      name: isLinear ? LINEAR_TYPE_NAME : PLAIN_TYPE_NAME,
      isLinear,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

/**
 * A site order entered backdated from last Monday (ADR 0101 §4), approved and taken into work on
 * vehicle A — through the portal's own doors, so the request is exactly what they produce.
 */
async function confirmed(
  typeId: string,
  options: { driverPersonId?: string } = {},
): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: typeId,
      dateFrom: PAST_FROM,
      dateTo: TODAY,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      backdateReason: 'Техника вышла раньше, чем оформили заявку',
      operationId: randomUUID(),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json<{ id: string; version: number }>();

  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);

  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: approved.json<{ version: number }>().version,
      assignment: {
        vehicleId: ctx.vehicleA,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        ...(options.driverPersonId ? { driverPersonId: options.driverPersonId } : {}),
      },
      schedule: { requestType: 'special_equipment', dateFrom: PAST_FROM, dateTo: TODAY },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { id: request.id, version: res.json<{ version: number }>().version };
}

/** The request as the portal reads it — the shift summary is what its lock predicate sees. */
async function requestDto(requestId: string): Promise<VehicleRequestDto> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/${requestId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<VehicleRequestDto>();
}

function previewPlain(
  request: { id: string; version: number },
  vehicleId: string,
  rates: { pricePerHour?: number } = {},
): Promise<AssignmentPreviewDto> {
  return ctx.app
    .inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${request.id}/assignment/preview`,
      headers: ctx.auth,
      payload: { vehicleId, version: request.version, ...rates },
    })
    .then((res) => {
      expect(res.statusCode, res.body).toBe(200);
      return res.json<AssignmentPreviewDto>();
    });
}

/**
 * A plain reassignment. The fingerprint is optional: the file runs in `legacy`, where the door
 * checks it only when it comes — the lock itself must hold without it.
 */
function reassignPlain(
  request: { id: string; version: number },
  vehicleId: string,
  previewFingerprint?: string,
  rates: { pricePerHour?: number } = {},
) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/assignment`,
    headers: ctx.auth,
    payload: {
      vehicleId,
      version: request.version,
      ...rates,
      ...(previewFingerprint ? { previewFingerprint } : {}),
    },
  });
}

async function assignedVehicle(requestId: string): Promise<string> {
  return (
    await ctx.db.execute<{ vehicle_id: string }>(
      sql`SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${requestId}`,
    )
  ).rows[0]!.vehicle_id;
}

/** Wait until some backend is blocked by the holder — the command has reached its locks. */
async function waitUntilBlocked(probe: pg.Client, holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { rows } = await probe.query<{ n: string }>(
      'SELECT count(*) AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
      [holderPid],
    );
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the command never queued behind the holder');
}

/** Eight hours signed off by the object — the row the shift doors would have written. */
async function signOff(requestId: string, date: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_shifts (request_id, shift_date, machine_hours, comment, filled_by,
                                        approved_by, approved_at)
    VALUES (${requestId}, ${date}, 8, '', ${ctx.adminId}, ${ctx.adminId}, now())`);
}

/**
 * Put one day of the request into a route of `vehicleId` — the carrier ADR 0210 reads.
 *
 * Written directly rather than through the per-day door: the subject is what the correction does
 * with such a day, not how the day got there, and the door would demand a driver and a backdate
 * reason that change nothing here.
 */
async function putIntoRoute(requestId: string, date: string, vehicleId: string): Promise<void> {
  const [route] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_routes (vehicle_id, route_date, created_by)
      VALUES (${vehicleId}, ${date}, ${ctx.adminId}) RETURNING id`)
  ).rows;
  await ctx.db.execute(sql`
    INSERT INTO vehicle_route_requests (route_id, request_id, position, work_date)
    VALUES (${route!.id}, ${requestId}, 1, ${date})`);
}

/**
 * Preview the correction, run it with the preview's fingerprint and return the days whose sign-off
 * the preview promised to clear — after checking the door cleared exactly those.
 *
 * The fingerprint is the proof of agreement: the door recomputes it under its locks from the same
 * rule, and a different set of days would have made it answer 409.
 */
async function correctAndCompare(
  request: { id: string; version: number },
  vehicleId: string,
  rates: { pricePerHour?: number } = {},
): Promise<string[]> {
  const before = await approvedDays(request.id);
  const body = {
    vehicleId,
    version: request.version,
    ...rates,
    correction: {
      operationId: randomUUID(),
      reason: 'На объекте работала другая машина — проверено по журналу',
      unlockWaybillIds: [],
    },
  };
  const preview = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${request.id}/assignment/preview`,
    headers: ctx.auth,
    payload: body,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const dto = preview.json<AssignmentPreviewDto>();
  const promised = dto.clearedShiftDays.map((day) => day.date);
  // Hours travel with each day: the preview shows the price of confirming, not just the dates.
  expect(dto.clearedShiftDays.every((day) => day.hours === 8)).toBe(true);
  expect(dto.clearedShiftsFingerprint === null).toBe(promised.length === 0);

  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/assignment`,
    headers: ctx.auth,
    payload: { ...body, previewFingerprint: dto.fingerprint },
  });
  expect(res.statusCode, res.body).toBe(200);

  const after = await approvedDays(request.id);
  expect(before.filter((day) => !after.includes(day))).toEqual(promised);
  return promised;
}

async function approvedDays(requestId: string): Promise<string[]> {
  return (
    await ctx.db.execute<{ shift_date: string }>(sql`
      SELECT shift_date::text FROM vehicle_request_shifts
       WHERE request_id = ${requestId} AND approved_at IS NOT NULL
       ORDER BY shift_date`)
  ).rows.map((row) => row.shift_date);
}

async function hoursOf(requestId: string): Promise<Record<string, number>> {
  const rows = (
    await ctx.db.execute<{ shift_date: string; machine_hours: string }>(sql`
      SELECT shift_date::text, machine_hours::text FROM vehicle_request_shifts
       WHERE request_id = ${requestId}`)
  ).rows;
  return Object.fromEntries(rows.map((row) => [row.shift_date, Number(row.machine_hours)]));
}

async function routeDays(requestId: string): Promise<string[]> {
  return (
    await ctx.db.execute<{ work_date: string }>(sql`
      SELECT work_date::text FROM vehicle_route_requests
       WHERE request_id = ${requestId} AND work_date IS NOT NULL
       ORDER BY work_date`)
  ).rows.map((row) => row.work_date);
}

/** Cleared sign-offs as the correction operation stored them (ADR 0101 §16). */
async function snapshotApprovals(
  requestId: string,
): Promise<{ date: string; approvedBy: string }[]> {
  const [row] = (
    await ctx.db.execute<{ approvals: string }>(sql`
      SELECT c.payload->>'shiftApprovals' AS approvals
        FROM waybill_corrections c
        JOIN vehicle_request_corrections l ON l.correction_id = c.id
       WHERE l.request_id = ${requestId}
       ORDER BY c.created_at DESC LIMIT 1`)
  ).rows;
  return JSON.parse(row!.approvals) as { date: string; approvedBy: string }[];
}

async function auditedClearedDays(requestId: string): Promise<string[]> {
  const [row] = (
    await ctx.db.execute<{ cleared: string[] | null }>(sql`
      SELECT (SELECT array_agg(value ORDER BY value)
                FROM jsonb_array_elements_text(metadata->'clearedShiftApprovals')) AS cleared
        FROM audit_log
       WHERE entity_type = 'vehicle_request' AND entity_id = ${requestId}::text
         AND action = 'vehicle_request.assign'
       ORDER BY created_at DESC LIMIT 1`)
  ).rows;
  return row?.cleared ?? [];
}

// ── Period correction scene ──

type SceneTx = Parameters<Parameters<(typeof AppDb)['transaction']>[0]>[0];

/** The command's executor is the scene's nested transaction: a real one, rolled back after. */
const executorOf = (tx: SceneTx): AssignmentCommand.AssignmentCommandExecutor =>
  ({
    transaction: (fn: (inner: unknown) => Promise<unknown>) => tx.transaction(fn as never),
  }) as unknown as AssignmentCommand.AssignmentCommandExecutor;

interface PeriodScene {
  requestId: string;
  vehicleC: string;
  asOf: string;
}

/**
 * A request with a split history — A from last Monday, B from this Monday — and three signed-off
 * days: ROUTE_DAY and PLAIN_DAY in the first segment, MONDAY in the second. ROUTE_DAY sits in a
 * route of B. Built by SQL inside a transaction that is always rolled back, exactly like the
 * scenes of `assignment-correction.db.test.ts`: the period door is reached through the command
 * frame, not HTTP.
 */
async function inPeriodScene(
  run: (tx: SceneTx, scene: PeriodScene) => Promise<void>,
): Promise<void> {
  const asOf = shiftDateKey(MONDAY, 2);
  const termTo = shiftDateKey(MONDAY, 13);
  await ctx.db
    .transaction(async (tx) => {
      const vehicleType = (
        await tx.execute<{ vehicle_type_id: string }>(
          sql`SELECT vehicle_type_id FROM vehicles WHERE id = ${ctx.vehicleA}`,
        )
      ).rows[0]!.vehicle_type_id;
      const [request] = (
        await tx.execute<{ id: string }>(sql`
          INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status,
                                        created_by, assignment_history_state,
                                        assignment_history_validated_on)
          VALUES ('special_equipment', ${ctx.objectId}, ${vehicleType}, 'confirmed',
                  ${ctx.adminId}, 'materialized', ${asOf})
          RETURNING id`)
      ).rows;
      const requestId = request!.id;
      await tx.execute(sql`
        INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
        VALUES (${requestId}, ${PAST_FROM}, ${termTo})`);
      // The denormalised assignment repeats the tail of the history (R17): B.
      await tx.execute(sql`
        INSERT INTO vehicle_request_assignments
          (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
        SELECT ${requestId}, v.id, v.vehicle_type_id, ${vehicleType}, ${ctx.adminId}
          FROM vehicles v WHERE v.id = ${ctx.vehicleB}`);
      const change = (
        effectiveDate: string,
        dimension: 'vehicle' | 'driver',
        value: { vehicleId?: string; driverPersonId?: string },
        origin: string,
      ) =>
        tx.execute(sql`
          INSERT INTO vehicle_request_assignment_changes
            (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state,
             origin, change_group_id)
          VALUES (${requestId}, ${effectiveDate}, ${dimension}, ${value.vehicleId ?? null},
                  ${value.driverPersonId ?? null}, ${dimension === 'driver' ? 'set' : null},
                  ${origin}, ${randomUUID()})`);
      await change(PAST_FROM, 'vehicle', { vehicleId: ctx.vehicleA }, 'assignment');
      await change(PAST_FROM, 'driver', { driverPersonId: ctx.driver }, 'assignment');
      await change(MONDAY, 'vehicle', { vehicleId: ctx.vehicleB }, 'reassignment');

      for (const date of [ROUTE_DAY, PLAIN_DAY, MONDAY]) {
        await tx.execute(sql`
          INSERT INTO vehicle_request_shifts
            (request_id, shift_date, machine_hours, comment, filled_by, approved_by, approved_at)
          VALUES (${requestId}, ${date}, 8, '', ${ctx.adminId}, ${ctx.adminId}, now())`);
      }
      const [route] = (
        await tx.execute<{ id: string }>(sql`
          INSERT INTO vehicle_routes (vehicle_id, route_date, created_by)
          VALUES (${ctx.vehicleB}, ${ROUTE_DAY}, ${ctx.adminId}) RETURNING id`)
      ).rows;
      await tx.execute(sql`
        INSERT INTO vehicle_route_requests (route_id, request_id, position, work_date)
        VALUES (${route!.id}, ${requestId}, 1, ${ROUTE_DAY})`);

      await run(tx, { requestId, vehicleC: ctx.vehicleC, asOf });
      throw new Error('rollback');
    })
    .catch((e: unknown) => {
      if ((e as Error).message !== 'rollback') throw e;
    });
}
