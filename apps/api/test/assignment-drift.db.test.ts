import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
// Types only: the modules themselves are imported after the environment is set.
import type { db as AppDb } from '../src/db/client';
import type * as DriftCore from '../scripts/assignment-drift-core';
import { useReadModeDatabase } from './assignment-read-mode';

/**
 * Repair of history that drifted from the issued paper (ADR 0212, decision 5 —
 * [0212](../../../docs/adr/0212-assignment-old-doors-write-history.md)), the core of
 * `scripts/assignment-drift.ts`.
 *
 * Each scene reproduces what the old doors left behind before ADR 0212: the assignment is changed
 * and the paper re-issued by the weekly sweep, while history keeps the previous pair. The repair
 * must make history follow the issued sheets from the first one that disagrees (the user's
 * decision В1), bring the tail to the assignment, write nothing when the paper itself names the
 * previous vehicle, and leave paper and the assignment untouched.
 *
 * The repair does not depend on the read mode, so the file runs once; it takes its own database
 * all the same, because the scenes change the fleet's assignments and paper.
 *
 * ЭСМ2-РАЗРЕЗ. One run is enough: the repair compares history with whatever sheets exist and
 * writes only history, the same in both read modes. Sheet borders are never written as numbers —
 * each boundary the assertions expect is read from the scene's own sheets (the first sheet on the
 * new vehicle, the day after the last sheet), so the week or month cut of the paper cannot make
 * the file lie.
 */

const readMode = useReadModeDatabase('drift');

const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: починка истории по листам';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
const TERM_FROM = shiftDateKey(MONDAY, -7);
const TERM_TO = shiftDateKey(MONDAY, 13);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  core: typeof DriftCore;
  objectId: string;
  typeId: string;
  vehicleA: string;
  vehicleB: string;
  userId: string;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!readMode.enabled) return;
  const { db, closeDb } = await import('../src/db/client');
  ctx = { db, closeDb, core: await import('../scripts/assignment-drift-core') } as Ctx;
  const one = async (q: Parameters<typeof db.execute>[0]): Promise<Record<string, string>> => {
    const [row] = (await db.execute<Record<string, string>>(q)).rows;
    if (!row) throw new Error('the directory is empty: the scene cannot be built');
    return row;
  };
  ctx.objectId = (await one(sql`SELECT id FROM construction_objects LIMIT 1`)).id!;
  // Two own units of one non-linear type: the assignment is swapped between them without touching
  // the ordered type.
  const type = await one(sql`
    SELECT v.vehicle_type_id FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
     WHERE v.deleted_at IS NULL AND v.ownership = 'own' AND vk.code = 'special_equipment'
       AND vt.is_linear = false
     GROUP BY v.vehicle_type_id HAVING count(*) >= 2 ORDER BY v.vehicle_type_id LIMIT 1`);
  ctx.typeId = type.vehicle_type_id!;
  const units = (
    await db.execute<{ id: string }>(sql`
      SELECT id FROM vehicles WHERE deleted_at IS NULL AND ownership = 'own'
         AND vehicle_type_id = ${ctx.typeId} ORDER BY id LIMIT 2`)
  ).rows;
  ctx.vehicleA = units[0]!.id;
  ctx.vehicleB = units[1]!.id;
  ctx.userId = (
    await one(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
      VALUES (${`db-drift-${RUN}@example.invalid`}, 'Сверов', 'Пров', '', 'x', 'admin', false)
      RETURNING id`)
  ).id!;
}, 240_000);

afterAll(async () => {
  if (!readMode.enabled || !ctx) return;
  const db = ctx.db;
  await db.execute(sql`
    DELETE FROM audit_log WHERE entity_type = 'vehicle_request' AND entity_id IN (
      SELECT id::text FROM vehicle_requests WHERE comment = ${MARK})`);
  await db.execute(sql`
    DELETE FROM waybills WHERE source_request_id IN (
      SELECT id FROM vehicle_requests WHERE comment = ${MARK})`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${MARK}`);
  await db.execute(sql`DELETE FROM vehicles WHERE description LIKE ${`${MARK}%`}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ctx.userId}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${MARK}`);
  await ctx.closeDb?.();
});

async function newPerson(lastName: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO persons (last_name, first_name, comment)
      VALUES (${lastName}, 'Пров', ${MARK}) RETURNING id`)
  ).rows;
  return row!.id;
}

/** A request in work since last Monday on A with `person`, history "A + person", paper for the term. */
async function scene(person: string): Promise<{ id: string; num: number }> {
  const [row] = (
    await ctx.db.execute<{ id: string; num: number }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                    created_by, assignment_history_state,
                                    assignment_history_validated_on)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.typeId}, 'confirmed', ${MARK},
              ${ctx.userId}, 'ready', ${TODAY})
      RETURNING id, num`)
  ).rows;
  const requestId = row!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${TERM_FROM}, ${TERM_TO})`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${ctx.vehicleA}, ${ctx.typeId}, ${ctx.typeId}, ${ctx.userId})`);
  const group = randomUUID();
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${requestId}, ${TERM_FROM}, 'vehicle', ${ctx.vehicleA}, NULL, NULL, 'assignment',
            ${group}),
           (${requestId}, ${TERM_FROM}, 'driver', NULL, ${person}, 'set', 'assignment', ${group})`);
  await sweep(requestId, person, TERM_FROM);
  return { id: requestId, num: Number(row!.num) };
}

/** The weekly sweep, as the old doors called it after rewriting the assignment. */
async function sweep(requestId: string, person: string | null, asOf: string): Promise<void> {
  const { syncEsm2Waybills } = await import('../src/services/waybill-esm2');
  await ctx.db.transaction(async (tx) => {
    await syncEsm2Waybills(tx, {
      requestId,
      actor: { id: ctx.userId },
      reason: 'test scene',
      driverPersonId: person,
      asOf,
    });
  });
}

/** What the old "Change vehicle" did: the assignment moves, the paper follows, history does not. */
async function lostReassignment(
  requestId: string,
  vehicleId: string,
  person: string | null,
): Promise<void> {
  await ctx.db.execute(sql`
    UPDATE vehicle_request_assignments
       SET vehicle_id = ${vehicleId},
           vehicle_type_id = (SELECT vehicle_type_id FROM vehicles WHERE id = ${vehicleId})
     WHERE request_id = ${requestId}`);
  await sweep(requestId, person, TODAY);
}

async function plan(requestId: string): Promise<DriftCore.DriftVerdict> {
  return ctx.db.transaction(async (tx) => ctx.core.planDriftRepair(tx as never, requestId));
}

async function repair(requestId: string): Promise<DriftCore.DriftVerdict> {
  return ctx.core.applyDriftRepair(ctx.db as never, {
    requestId,
    asOf: TODAY,
    actorUserId: ctx.userId,
    reason: 'db test',
  });
}

async function rowsOf(requestId: string): Promise<string[]> {
  return (
    await ctx.db.execute<{
      d: string;
      dim: string;
      v: string | null;
      p: string | null;
      s: string | null;
      o: string;
    }>(sql`
      SELECT effective_date::text AS d, dimension AS dim, vehicle_id AS v, driver_person_id AS p,
             driver_state AS s, origin AS o
        FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} AND superseded_at IS NULL
       ORDER BY effective_date, dimension DESC`)
  ).rows.map((r) =>
    r.dim === 'vehicle'
      ? `${r.d} vehicle ${r.v === ctx.vehicleA ? 'A' : r.v === ctx.vehicleB ? 'B' : 'R'} ${r.o}`
      : `${r.d} driver ${r.s === 'set' ? (r.p ?? '') : r.s} ${r.o}`,
  );
}

async function sheetsOf(requestId: string): Promise<string[]> {
  return (
    await ctx.db.execute<{ f: string; t: string; v: string; p: string | null }>(sql`
      SELECT period_from::text AS f, period_to::text AS t, vehicle_id AS v, driver_person_id AS p
        FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled' AND period_from IS NOT NULL
       ORDER BY period_from, id`)
  ).rows.map((r) => `${r.f}..${r.t} ${r.v} ${r.p}`);
}

async function assignedOf(requestId: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ v: string }>(sql`
      SELECT vehicle_id AS v FROM vehicle_request_assignments WHERE request_id = ${requestId}`)
  ).rows;
  return row!.v;
}

async function firstSheetOn(requestId: string, vehicleId: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ f: string }>(sql`
      SELECT min(greatest(period_from, ${TERM_FROM}::date))::text AS f FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled' AND vehicle_id = ${vehicleId}`)
  ).rows;
  return row!.f;
}

describe.skipIf(!readMode.enabled)(
  'починка истории по выданным листам (ADR 0212, решение 5)',
  () => {
    it('сходящийся заказ не трогается', async () => {
      const personA = await newPerson('Сходов');
      const request = await scene(personA);
      expect((await plan(request.id)).kind).toBe('clean');
    });

    it('потерянная смена техники: история догоняет листы с первого листа на новой машине', async () => {
      const personA = await newPerson('Прежнев');
      const request = await scene(personA);
      await lostReassignment(request.id, ctx.vehicleB, null);
      const boundary = await firstSheetOn(request.id, ctx.vehicleB);
      const sheets = await sheetsOf(request.id);

      const verdict = await plan(request.id);
      expect(verdict.kind).toBe('repair');
      if (verdict.kind === 'repair') expect(verdict.boundary).toBe(boundary);

      expect((await repair(request.id)).kind).toBe('repair');
      expect(await rowsOf(request.id)).toEqual([
        `${TERM_FROM} vehicle A assignment`,
        `${TERM_FROM} driver ${personA} assignment`,
        `${boundary} vehicle B reassignment`,
      ]);
      // Paper and the assignment are exactly as they were; only history moved.
      expect(await sheetsOf(request.id)).toEqual(sheets);
      expect(await assignedOf(request.id)).toBe(ctx.vehicleB);
      expect((await plan(request.id)).kind).toBe('clean');
    });

    it('повторный перевод с новым машинистом: история берёт и машину, и человека из листов', async () => {
      const personA = await newPerson('Первов');
      const personB = await newPerson('Вторев');
      const request = await scene(personA);
      await lostReassignment(request.id, ctx.vehicleB, personB);
      const boundary = await firstSheetOn(request.id, ctx.vehicleB);

      expect((await repair(request.id)).kind).toBe('repair');
      expect(await rowsOf(request.id)).toEqual([
        `${TERM_FROM} vehicle A assignment`,
        `${TERM_FROM} driver ${personA} assignment`,
        `${boundary} vehicle B reassignment`,
        `${boundary} driver ${personB} reassignment`,
      ]);
      expect((await plan(request.id)).kind).toBe('clean');
    });

    it('листы уже перевыписаны на прежнюю машину — в ручной список, без записи', async () => {
      const personA = await newPerson('Возвратов');
      const request = await scene(personA);
      // The assignment moved, but the paper names A to the end of the term, as history does.
      await ctx.db.execute(sql`
      UPDATE vehicle_request_assignments SET vehicle_id = ${ctx.vehicleB}
       WHERE request_id = ${request.id}`);
      const rows = await rowsOf(request.id);

      const verdict = await repair(request.id);
      expect(verdict).toMatchObject({ kind: 'manual', reason: 'paper_follows_stale_tail' });
      expect(await rowsOf(request.id)).toEqual(rows);
    });

    it('смена на аренду: после последнего листа — арендная машина и снятый машинист', async () => {
      const personA = await newPerson('Арендов');
      const request = await scene(personA);
      const [lessor] = (
        await ctx.db.execute<{ id: string }>(sql`
        SELECT id FROM counterparties WHERE type = 'vehicle_lessor' ORDER BY id LIMIT 1`)
      ).rows;
      expect(lessor, 'the seed has a vehicle lessor').toBeDefined();
      const [rental] = (
        await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO vehicles (vehicle_type_id, ownership, lessor_id, lessor_type, lessor_is_active,
                              description, price_per_shift, shift_hours, status)
        VALUES (${ctx.typeId}, 'rental', ${lessor!.id}, 'vehicle_lessor', true,
                ${`${MARK} ${RUN}`}, 12000, 8, 'active')
        RETURNING id`)
      ).rows;
      await lostReassignment(request.id, rental!.id, null);
      const [lastSheet] = (
        await ctx.db.execute<{ t: string }>(sql`
        SELECT max(period_to)::text AS t FROM waybills
         WHERE source_request_id = ${request.id} AND status <> 'cancelled'`)
      ).rows;
      const after = shiftDateKey(lastSheet!.t, 1);

      expect((await repair(request.id)).kind).toBe('repair');
      expect(await rowsOf(request.id)).toEqual([
        `${TERM_FROM} vehicle A assignment`,
        `${TERM_FROM} driver ${personA} assignment`,
        `${after} vehicle R reassignment`,
        `${after} driver cleared reassignment`,
      ]);
      expect((await plan(request.id)).kind).toBe('clean');
    });

    it('новая своя машина после последнего листа: машинист не протягивается, а «не знаем»', async () => {
      const personA = await newPerson('Хвостов');
      const request = await scene(personA);
      // The lost reassignment moved the assignment after the paper had ended: the blanks from the
      // current week on are gone, and nothing was printed on B.
      await ctx.db.execute(sql`
        UPDATE waybills
           SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${ctx.userId},
               cancel_reason = 'test scene'
         WHERE source_request_id = ${request.id} AND period_to >= ${TODAY}`);
      await ctx.db.execute(sql`
        UPDATE vehicle_request_assignments SET vehicle_id = ${ctx.vehicleB}
         WHERE request_id = ${request.id}`);
      const [lastSheet] = (
        await ctx.db.execute<{ t: string }>(sql`
          SELECT max(period_to)::text AS t FROM waybills
           WHERE source_request_id = ${request.id} AND status <> 'cancelled'`)
      ).rows;
      const after = shiftDateKey(lastSheet!.t, 1);

      expect((await repair(request.id)).kind).toBe('repair');
      // Before 29.09.2026 the tail carried `driver: null`, and A's machinist ran on onto B through
      // days no blank names; the backfill's tail rule says `unknown` for an own unit instead.
      expect(await rowsOf(request.id)).toEqual([
        `${TERM_FROM} vehicle A assignment`,
        `${TERM_FROM} driver ${personA} assignment`,
        `${after} vehicle B reassignment`,
        `${after} driver unknown backfill`,
      ]);
      expect((await plan(request.id)).kind).toBe('clean');
      // The mutable days after the paper have nobody on B: the request asks for an anchor.
      const [state] = (
        await ctx.db.execute<{ s: string }>(sql`
          SELECT assignment_history_state AS s FROM vehicle_requests WHERE id = ${request.id}`)
      ).rows;
      expect(state!.s).toBe('materialized');
    });

    it('«не знаем» под напечатанным человеком — не расхождение (Р19)', async () => {
      const personA = await newPerson('Незнаев');
      const request = await scene(personA);
      // Paper older than history: the blanks name the person, history admits it does not know.
      await ctx.db.execute(sql`
        UPDATE vehicle_request_assignment_changes
           SET driver_state = 'unknown', driver_person_id = NULL, origin = 'backfill'
         WHERE request_id = ${request.id} AND dimension = 'driver'`);
      const rows = await rowsOf(request.id);

      expect((await plan(request.id)).kind).toBe('clean');
      expect((await repair(request.id)).kind).toBe('clean');
      expect(await rowsOf(request.id)).toEqual(rows);
    });

    it('архивная заявка — в отчёт с тем, что было бы починено, без записи', async () => {
      const personA = await newPerson('Архивнов');
      const request = await scene(personA);
      await lostReassignment(request.id, ctx.vehicleB, null);
      await ctx.db.execute(sql`
        UPDATE vehicle_requests SET deleted_at = now(), deleted_by = ${ctx.userId}
         WHERE id = ${request.id}`);
      const boundary = await firstSheetOn(request.id, ctx.vehicleB);
      const rows = await rowsOf(request.id);

      const candidates = await ctx.core.listDriftCandidates(ctx.db as never, {
        nums: [request.num],
      });
      expect(candidates).toEqual([{ id: request.id, num: request.num, archived: true }]);
      const verdict = await repair(request.id);
      expect(verdict).toMatchObject({ kind: 'manual', reason: 'archived' });
      if (verdict.kind === 'manual') expect(verdict.withheld?.boundary).toBe(boundary);
      expect(await rowsOf(request.id)).toEqual(rows);
    });
  },
);
