import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
// Types only: the modules themselves are imported after the environment is set.
import type { db as AppDb } from '../src/db/client';
import type * as DriftCore from '../scripts/assignment-drift-core';
import type * as DriftTraces from '../scripts/assignment-drift-traces';
import { useReadModeDatabase } from './assignment-read-mode';

/**
 * Traces of the defective repair door and their cure — the report sections and `--fix=leak`,
 * `--fix=fill-paper` of `scripts/assignment-drift.ts` (ADR 0212, amendment of 29.09.2026 —
 * [0212](../../../docs/adr/0212-assignment-old-doors-write-history.md)).
 *
 * WHY THE SCENES ARE WRITTEN BY HAND. Each scene reproduces what the door left on production
 * before its defects were fixed: a fill without its `unknown_remainder`, a cancelled fill whose
 * blanks stayed active, a sheet burned without replacement, a repair of an archive. Driving the
 * door itself would stop reproducing them the moment the door is fixed, and the command exists
 * exactly for the data the old door already wrote. So the rows are inserted in the shape the old
 * door wrote them — the journal operation with its `payload.repair`, the fill row, the blanks
 * marked with the operation — and the paper itself comes from the real weekly sweep, so numbers,
 * series and snapshots are genuine.
 *
 * WHAT IS ASSERTED. The report finds every kind; the cure writes the returned boundary into the
 * fill's own group and cancels the leaked or orphaned blanks through the journal; it leaves
 * orphans, archived repairs and everything ambiguous untouched; a second run writes nothing.
 *
 * ЭСМ2-РАЗРЕЗ. One run is enough: the scenes lay paper with the legacy weekly sweep and then
 * examine only what the command reads — which operation minted or burned which blank. Sheet
 * borders are never written as numbers: each blank is addressed by the day it covers.
 */

const readMode = useReadModeDatabase('drift-traces');

const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: следы двери ремонта';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
/** Two worked weeks, the current one and the next: the fill covers the worked ones. */
const TERM_FROM = shiftDateKey(MONDAY, -14);
const TERM_TO = shiftDateKey(MONDAY, 13);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  core: typeof DriftCore;
  traces: typeof DriftTraces;
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
  ctx = {
    db,
    closeDb,
    core: await import('../scripts/assignment-drift-core'),
    traces: await import('../scripts/assignment-drift-traces'),
  } as Ctx;
  const one = async (q: Parameters<typeof db.execute>[0]): Promise<Record<string, string>> => {
    const [row] = (await db.execute<Record<string, string>>(q)).rows;
    if (!row) throw new Error('the directory is empty: the scene cannot be built');
    return row;
  };
  ctx.objectId = (await one(sql`SELECT id FROM construction_objects LIMIT 1`)).id!;
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
      VALUES (${`db-traces-${RUN}@example.invalid`}, 'Следов', 'Пров', '', 'x', 'admin', false)
      RETURNING id`)
  ).id!;
}, 240_000);

afterAll(async () => {
  // The database is the file's own and is dropped by `useReadModeDatabase`; only the pool is ours.
  if (!readMode.enabled || !ctx) return;
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

/**
 * A request in work for the whole term on A, history restored by the backfill with the machinist
 * unknown (the normal outcome where the paper named nobody), and weekly paper for the term naming
 * `person` — as the legacy sweep printed it.
 */
async function scene(
  person: string,
): Promise<{ id: string; num: number; unknownRowId: string; open: string }> {
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
  const [unknown] = (
    await ctx.db.execute<{ id: string; dimension: string }>(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
         change_group_id)
      VALUES (${requestId}, ${TERM_FROM}, 'vehicle', ${ctx.vehicleA}, NULL, NULL, 'backfill',
              ${group}),
             (${requestId}, ${TERM_FROM}, 'driver', NULL, NULL, 'unknown', 'backfill', ${group})
      RETURNING id, dimension`)
  ).rows.filter((r) => r.dimension === 'driver');
  await sweep(requestId, person, TERM_FROM);
  // The first day still covered by a cancellable blank: everything before it is the locked past a
  // fill may address. Read from the paper, not computed: a month border cuts the current week, and
  // then the first open blank starts later than Monday (ADR 0142).
  const [open] = (
    await ctx.db.execute<{ d: string }>(sql`
      SELECT min(period_from)::text AS d FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled'
         AND period_to >= ${TODAY}`)
  ).rows;
  return { id: requestId, num: Number(row!.num), unknownRowId: unknown!.id, open: open!.d };
}

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

/** A journal operation of the repair door, with the snapshot the door writes (`payload.repair`). */
async function repairOperation(
  requestId: string,
  repair: {
    fills?: { from: string; to: string; personId: string }[];
    anchors?: { effectiveDate: string; driverPersonId: string }[];
    cancelledFillGroup?: string | null;
  },
  extra: { restore?: boolean; stateBefore?: string; stateAfter?: string } = {},
): Promise<{ id: string; createdAt: string }> {
  const payload = {
    effects: {},
    repair: {
      anchors: repair.anchors ?? [],
      fills: repair.fills ?? [],
      cancelledFillGroup: repair.cancelledFillGroup ?? null,
      tail: null,
    },
    restore: extra.restore ?? false,
    blockersBefore: 'test',
    stateBefore: extra.stateBefore ?? 'materialized',
    stateAfter: extra.stateAfter ?? 'ready',
  };
  const scope = {
    schemaVersion: 1,
    requiresCorrect: true,
    requiresCorrectBeyondLimit: false,
    requiresArchiveRestore: false,
    effectiveDate: TERM_FROM,
    authorizedAsOf: TODAY,
  };
  const [op] = (
    await ctx.db.execute<{ id: string; created_at: string }>(sql`
      INSERT INTO waybill_corrections (operation_id, fingerprint, kind, reason, actor_user_id,
                                       authorization_scope, payload)
      VALUES (${randomUUID()}, 'test', 'crew', 'test repair', ${ctx.userId},
              ${JSON.stringify(scope)}::jsonb, ${JSON.stringify(payload)}::jsonb)
      RETURNING id, created_at::text AS created_at`)
  ).rows;
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_corrections (correction_id, request_id)
    VALUES (${op!.id}, ${requestId})`);
  return { id: op!.id, createdAt: op!.created_at };
}

/**
 * The fill as the old door wrote it: the `set` replaces the backfill `unknown` on `from` and goes
 * into its own group — and, when `remainder` is false, nothing marks where it ends (D3).
 */
async function knownFill(
  requestId: string,
  replaces: string,
  fill: { from: string; to: string; personId: string },
  operationId: string,
  remainder: boolean,
): Promise<string> {
  const group = randomUUID();
  await ctx.db.execute(sql`
    UPDATE vehicle_request_assignment_changes
       SET superseded_at = now(), superseded_by_user = ${ctx.userId}, superseded_kind = 'replaced'
     WHERE id = ${replaces}`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, driver_person_id, driver_state, origin,
       change_group_id, correction_id, created_by, supersedes_change_id)
    VALUES (${requestId}, ${fill.from}, 'driver', ${fill.personId}, 'set', 'known_fill', ${group},
            ${operationId}, ${ctx.userId}, ${replaces})`);
  if (remainder) {
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, driver_state, origin, change_group_id,
         correction_id, created_by)
      VALUES (${requestId}, ${shiftDateKey(fill.to, 1)}, 'driver', 'unknown', 'unknown_remainder',
              ${group}, ${operationId}, ${ctx.userId})`);
  }
  return group;
}

/** Blanks covering `from…to` are marked as minted by the operation, as the door's paper step did. */
async function mintedBy(requestId: string, operationId: string, from: string, to: string) {
  await ctx.db.execute(sql`
    UPDATE waybills SET correction_id = ${operationId}, correction_reason = 'test repair'
     WHERE source_request_id = ${requestId} AND status <> 'cancelled'
       AND period_to >= ${from} AND period_from <= ${to}`);
}

async function burnedBy(requestId: string, operationId: string, day: string) {
  await ctx.db.execute(sql`
    UPDATE waybills
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${ctx.userId},
           cancel_reason = 'test repair', cancel_correction_id = ${operationId}
     WHERE source_request_id = ${requestId} AND status <> 'cancelled'
       AND period_from <= ${day} AND period_to >= ${day}`);
}

async function signShift(requestId: string, day: string) {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_shifts (request_id, shift_date, machine_hours, filled_by,
                                        approved_by, approved_at)
    VALUES (${requestId}, ${day}, 8, ${ctx.userId}, ${ctx.userId}, now())`);
}

async function inspect(requestId: string): Promise<DriftTraces.RequestTraces> {
  return ctx.db.transaction(async (tx) => ctx.traces.inspectTraces(tx as never, requestId, TODAY));
}

async function heal(
  requestId: string,
  fixes: DriftTraces.DriftFix[] = ['leak', 'fill-paper'],
): Promise<DriftTraces.TraceHealOutcome> {
  return ctx.traces.applyTraceHeal(ctx.db as never, {
    requestId,
    asOf: TODAY,
    actorUserId: ctx.userId,
    reason: 'db test: лечение следа',
    fixes: new Set(fixes),
  });
}

async function historyOf(requestId: string): Promise<string[]> {
  return (
    await ctx.db.execute<{
      d: string;
      dim: string;
      p: string | null;
      s: string | null;
      o: string;
      g: string;
    }>(sql`
      SELECT effective_date::text AS d, dimension AS dim, driver_person_id AS p,
             driver_state AS s, origin AS o, change_group_id AS g
        FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} AND superseded_at IS NULL
       ORDER BY effective_date, dimension DESC, origin`)
  ).rows.map((r) =>
    r.dim === 'vehicle'
      ? `${r.d} vehicle ${r.o}`
      : `${r.d} driver ${r.s === 'set' ? r.p : r.s} ${r.o}`,
  );
}

/** Every blank of the request with its status and provenance — the whole paper, not a projection. */
async function paperOf(requestId: string): Promise<string[]> {
  return (
    await ctx.db.execute<{
      id: string;
      f: string;
      t: string;
      st: string;
      c: string | null;
      x: string | null;
    }>(sql`
      SELECT id, period_from::text AS f, period_to::text AS t, status AS st,
             correction_id AS c, cancel_correction_id AS x
        FROM waybills WHERE source_request_id = ${requestId}
       ORDER BY period_from, id`)
  ).rows.map((r) => `${r.f}..${r.t} ${r.st} ${r.c ?? '-'} ${r.x ?? '-'}`);
}

async function journalOf(
  requestId: string,
): Promise<{ id: string; kind: string; scope: unknown }[]> {
  return (
    await ctx.db.execute<{ id: string; kind: string; scope: unknown }>(sql`
      SELECT c.id, c.kind, c.authorization_scope AS scope
        FROM waybill_corrections c
        JOIN vehicle_request_corrections l ON l.correction_id = c.id
       WHERE l.request_id = ${requestId} AND c.payload->>'door' = 'assignment-drift'
       ORDER BY c.created_at`)
  ).rows;
}

async function stateOf(requestId: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ s: string }>(sql`
      SELECT assignment_history_state AS s FROM vehicle_requests WHERE id = ${requestId}`)
  ).rows;
  return row!.s;
}

/** The leak scene (D3): the fill covers the two worked weeks and runs on into the current one. */
async function leakScene(options: { twoFills?: boolean } = {}) {
  const person = await newPerson('Протеков');
  const request = await scene(person);
  // The door's default address: the whole gap up to the last locked day (D3).
  const fill = { from: TERM_FROM, to: shiftDateKey(request.open, -1), personId: person };
  const fills = options.twoFills
    ? [fill, { from: shiftDateKey(MONDAY, 7), to: TERM_TO, personId: person }]
    : [fill];
  const op = await repairOperation(request.id, { fills });
  const group = await knownFill(request.id, request.unknownRowId, fill, op.id, false);
  // The door re-issued the whole term under the operation: the filled weeks and the leaked ones.
  await mintedBy(request.id, op.id, TERM_FROM, TERM_TO);
  return { request, person, op, group };
}

describe.skipIf(!readMode.enabled)('следы двери ремонта и их лечение (ADR 0212, поправка)', () => {
  it('В: протекание находится, лечение возвращает границу в группу и гасит бланки вперёд', async () => {
    const { request, person, op, group } = await leakScene();

    const found = await inspect(request.id);
    expect(ctx.traces.traceKindsOf(found)).toEqual(['leak']);
    const leak = found.leaks[0]!;
    expect(leak).toMatchObject({
      day: request.open,
      through: TERM_TO,
      changeGroupId: group,
      manual: [],
      stateBefore: 'materialized',
      stateAfter: 'ready',
    });
    // Forward blanks are the ones on the leaked days only; the filled weeks keep theirs.
    expect(leak.forward.every((sheet) => sheet.from >= request.open)).toBe(true);
    expect(leak.forward.length).toBeGreaterThan(0);
    // History and its own blanks agree, so the drift verdict alone would call this clean.
    const verdict = await ctx.db.transaction(async (tx) =>
      ctx.core.planDriftRepair(tx as never, request.id, { asOf: TODAY }),
    );
    expect(verdict.kind).toBe('clean');

    const outcome = await heal(request.id, ['leak']);
    expect(outcome.correctionId).not.toBeNull();
    expect(await historyOf(request.id)).toEqual([
      `${TERM_FROM} vehicle backfill`,
      `${TERM_FROM} driver ${person} known_fill`,
      `${request.open} driver unknown unknown_remainder`,
    ]);
    // The boundary is the missing member of the fill's own group: `cancel_fill` finds a
    // well-formed group again.
    const [member] = (
      await ctx.db.execute<{ g: string; c: string }>(sql`
        SELECT change_group_id AS g, correction_id AS c FROM vehicle_request_assignment_changes
         WHERE request_id = ${request.id} AND origin = 'unknown_remainder'`)
    ).rows;
    expect(member).toEqual({ g: group, c: outcome.correctionId });
    const paper = await paperOf(request.id);
    for (const line of paper) {
      const [period, status, minted, burned] = line.split(' ');
      const from = period!.split('..')[0]!;
      if (from >= request.open) {
        expect([status, minted, burned]).toEqual(['cancelled', op.id, outcome.correctionId]);
      } else {
        expect([status, burned]).toEqual(['issued', '-']);
      }
    }
    const journal = await journalOf(request.id);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ id: outcome.correctionId, kind: 'crew' });
    // The leaked mutable days are `unknown` again: the request asks for an anchor.
    expect(await stateOf(request.id)).toBe('materialized');
    const [audit] = (
      await ctx.db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM audit_log
         WHERE entity_id = ${request.id} AND action = ${ctx.traces.HEAL_AUDIT_ACTION}`)
    ).rows;
    expect(audit!.n).toBe('1');

    // Idempotent: the healed leak is no longer a leak.
    const history = await historyOf(request.id);
    const second = await heal(request.id, ['leak']);
    expect(second.correctionId).toBeNull();
    expect(await historyOf(request.id)).toEqual(history);
    expect(await paperOf(request.id)).toEqual(paper);
    expect(await journalOf(request.id)).toHaveLength(1);
    expect(ctx.traces.traceKindsOf(await inspect(request.id))).toEqual([]);
  });

  it('В без выбранного --fix=leak ничего не пишет', async () => {
    const { request } = await leakScene();
    const history = await historyOf(request.id);
    const paper = await paperOf(request.id);
    const outcome = await heal(request.id, ['fill-paper']);
    expect(outcome.correctionId).toBeNull();
    expect(await historyOf(request.id)).toEqual(history);
    expect(await paperOf(request.id)).toEqual(paper);
  });

  it('В с подписанной сменой на протекших днях — вручную, ничего не пишется', async () => {
    const { request } = await leakScene();
    await signShift(request.id, request.open);
    const found = await inspect(request.id);
    expect(found.leaks[0]!.manual.join(' ')).toMatch(/подписана/u);

    const history = await historyOf(request.id);
    const paper = await paperOf(request.id);
    const outcome = await heal(request.id);
    expect(outcome.correctionId).toBeNull();
    expect(await historyOf(request.id)).toEqual(history);
    expect(await paperOf(request.id)).toEqual(paper);
    expect(await journalOf(request.id)).toEqual([]);
  });

  it('В: два заполнения одной операцией — вручную', async () => {
    const { request } = await leakScene({ twoFills: true });
    const found = await inspect(request.id);
    expect(found.leaks).toHaveLength(1);
    expect(found.leaks[0]!.manual.join(' ')).toMatch(/2 отрезка/u);
    expect((await heal(request.id)).correctionId).toBeNull();
  });

  it('А: живые бланки отменённого заполнения гасятся задним числом, подписанный остаётся', async () => {
    const person = await newPerson('Отменов');
    const request = await scene(person);
    const fill = { from: TERM_FROM, to: shiftDateKey(request.open, -1), personId: person };
    const op = await repairOperation(request.id, { fills: [fill] });
    const group = await knownFill(request.id, request.unknownRowId, fill, op.id, true);
    await mintedBy(request.id, op.id, TERM_FROM, fill.to);
    // `cancel_fill` as the old door ran it: the group is gone, the head returns to `unknown`, the
    // blanks stay active (D4).
    const cancel = await repairOperation(request.id, { cancelledFillGroup: group });
    await ctx.db.execute(sql`
      UPDATE vehicle_request_assignment_changes
         SET superseded_at = now(), superseded_by_user = ${ctx.userId},
             superseded_kind = 'cancelled'
       WHERE request_id = ${request.id} AND change_group_id = ${group}`);
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, driver_state, origin, correction_id, created_by)
      VALUES (${request.id}, ${TERM_FROM}, 'driver', 'unknown', 'unknown_remainder',
              ${cancel.id}, ${ctx.userId})`);
    const signed = shiftDateKey(MONDAY, -3);
    await signShift(request.id, signed);

    const found = await inspect(request.id);
    expect(ctx.traces.traceKindsOf(found)).toEqual(['cancelled_fill']);
    const items = found.cancelledFills[0]!.sheets;
    expect(items.length).toBeGreaterThan(1);
    const signedSheet = items.find((item) => item.sheet.from <= signed && signed <= item.sheet.to)!;
    expect(signedSheet.manual).toMatch(/подписана/u);
    expect(items.filter((item) => item.manual === null).length).toBe(items.length - 1);

    const outcome = await heal(request.id, ['fill-paper']);
    expect(outcome.correctionId).not.toBeNull();
    const paper = await paperOf(request.id);
    for (const line of paper) {
      const [period, status, minted, burned] = line.split(' ');
      const [from, to] = period!.split('..');
      if (minted !== op.id) continue;
      if (from! <= signed && signed <= to!) expect([status, burned]).toEqual(['issued', '-']);
      else expect([status, burned]).toEqual(['cancelled', outcome.correctionId]);
    }
    const [journal] = await journalOf(request.id);
    // The cancelled blanks lie in the worked past: the operation is a correction back in time.
    expect(journal!.scope).toMatchObject({ requiresCorrect: true, requiresArchiveRestore: false });

    // The signed blank keeps the trace alive, and the second run writes nothing more.
    const again = await heal(request.id, ['fill-paper']);
    expect(again.correctionId).toBeNull();
    expect(await paperOf(request.id)).toEqual(paper);
    expect(ctx.traces.traceKindsOf(await inspect(request.id))).toEqual(['cancelled_fill']);
  });

  it('Б: лист, сожжённый заполнением без замены, — только отчёт; сверка по бумаге ждёт', async () => {
    const person = await newPerson('Сиротов');
    const request = await scene(person);
    const fill = { from: TERM_FROM, to: shiftDateKey(request.open, -1), personId: person };
    const op = await repairOperation(request.id, { fills: [fill] });
    await knownFill(request.id, request.unknownRowId, fill, op.id, true);
    const burnedDay = shiftDateKey(MONDAY, -3);
    await burnedBy(request.id, op.id, burnedDay);
    // A lost reassignment on top: the drift repair would follow the new paper — and must wait.
    await ctx.db.execute(sql`
      UPDATE vehicle_request_assignments SET vehicle_id = ${ctx.vehicleB}
       WHERE request_id = ${request.id}`);
    await sweep(request.id, person, TODAY);

    const found = await inspect(request.id);
    expect(ctx.traces.traceKindsOf(found)).toEqual(['orphan']);
    const orphan = found.orphans[0]!;
    expect(orphan.how).toBe('burned');
    expect(orphan.uncovered.every((range) => range.locked)).toBe(true);
    expect(orphan.uncovered.some((r) => r.from <= burnedDay && burnedDay <= r.to)).toBe(true);

    const history = await historyOf(request.id);
    const paper = await paperOf(request.id);
    expect((await heal(request.id)).correctionId).toBeNull();
    const verdict = await ctx.core.applyDriftRepair(ctx.db as never, {
      requestId: request.id,
      asOf: TODAY,
      actorUserId: ctx.userId,
      reason: 'db test',
    });
    expect(verdict).toMatchObject({ kind: 'manual', reason: 'trace_first', traces: ['orphan'] });
    if (verdict.kind === 'manual') expect(verdict.withheld?.boundary).toBeDefined();
    expect(await historyOf(request.id)).toEqual(history);
    expect(await paperOf(request.id)).toEqual(paper);
  });

  it('Г: ремонт архивной заявки без восстановления — только отчёт', async () => {
    const person = await newPerson('Архивов');
    const request = await scene(person);
    await ctx.db.execute(sql`
      UPDATE vehicle_requests SET deleted_at = now(), deleted_by = ${ctx.userId}
       WHERE id = ${request.id}`);
    // The operation and its audit event share one transaction, so they share `now()`.
    const op = await ctx.db.transaction(async (tx) => {
      const [row] = (
        await tx.execute<{ id: string }>(sql`
          INSERT INTO waybill_corrections (operation_id, fingerprint, kind, reason, actor_user_id,
                                           authorization_scope, payload)
          VALUES (${randomUUID()}, 'test', 'crew', 'test repair', ${ctx.userId},
                  ${JSON.stringify({
                    schemaVersion: 1,
                    requiresCorrect: true,
                    requiresCorrectBeyondLimit: false,
                    requiresArchiveRestore: false,
                    effectiveDate: TERM_FROM,
                    authorizedAsOf: TODAY,
                  })}::jsonb,
                  ${JSON.stringify({
                    repair: { anchors: [], fills: [], cancelledFillGroup: null, tail: null },
                    restore: false,
                  })}::jsonb)
          RETURNING id`)
      ).rows;
      await tx.execute(sql`
        INSERT INTO vehicle_request_corrections (correction_id, request_id)
        VALUES (${row!.id}, ${request.id})`);
      await tx.execute(sql`
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES (${ctx.userId}, 'vehicle_request.assignment_repair', 'vehicle_request',
                ${request.id}, ${JSON.stringify({ archived: true })}::jsonb)`);
      return row!;
    });
    await mintedBy(request.id, op.id, request.open, request.open);

    const candidates = await ctx.traces.listTraceCandidates(ctx.db as never, {
      nums: [request.num],
    });
    expect(candidates.map((c) => c.id)).toEqual([request.id]);
    const found = await inspect(request.id);
    expect(ctx.traces.traceKindsOf(found)).toEqual(['archived_repair']);
    expect(found.archivedRepairs[0]!.issued).toHaveLength(1);

    const paper = await paperOf(request.id);
    expect((await heal(request.id)).correctionId).toBeNull();
    expect(await paperOf(request.id)).toEqual(paper);
  });

  it('команда: отчёт без env портала, --apply --fix=leak лечит, повтор чист', async () => {
    const { request: leaking } = await leakScene();
    const person = await newPerson('Сиротин');
    const orphaned = await scene(person);
    const fill = { from: TERM_FROM, to: shiftDateKey(orphaned.open, -1), personId: person };
    const op = await repairOperation(orphaned.id, { fills: [fill] });
    await knownFill(orphaned.id, orphaned.unknownRowId, fill, op.id, true);
    await burnedBy(orphaned.id, op.id, shiftDateKey(MONDAY, -3));
    const only = `--request=${leaking.num},${orphaned.num}`;

    // The report reads nothing of the portal's configuration: the journal module is not loaded.
    const report = runDrift([only], { DATABASE_URL: undefined });
    expect(report.stdout).toContain('отчёт (ничего не пишется)');
    expect(report.stdout).toMatch(
      /В\. Протекание[^\n]*:\n[^\n]*ТС-\d+[^\n]*\n\s+→ лечится --fix=leak/u,
    );
    expect(report.stdout).toMatch(/Б\. Листы, сожжённые[^\n]*:\n[^\n]*сожжён/u);
    // The orphan needs a human: code 3.
    expect(report.status).toBe(3);
    const untouched = await historyOf(leaking.id);

    const apply = runDrift([
      only,
      '--apply',
      '--fix=leak',
      `--actor=db-traces-${RUN}@example.invalid`,
    ]);
    expect(apply.stdout).toContain('→ ВЫЛЕЧЕНО: граница «не знаем»');
    expect(apply.status).toBe(3);
    expect(await historyOf(leaking.id)).not.toEqual(untouched);
    expect(await historyOf(leaking.id)).toContain(
      `${leaking.open} driver unknown unknown_remainder`,
    );

    const again = runDrift([only], { DATABASE_URL: undefined });
    expect(again.stdout).toMatch(/В\. Протекание[^\n]*: нет/u);
    expect(again.status).toBe(3);
  }, 180_000);
});

const TSX = resolve(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)));
const API_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = 'scripts/assignment-drift.ts';

/** The command as the operator runs it: its own process, maintenance credentials to the database. */
function runDrift(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): { status: number; stdout: string } {
  const result = spawnSync(TSX, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_MAINTENANCE_URL: readMode.url,
      DATABASE_MIGRATION_URL: undefined,
      ...env,
    },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: `${result.stdout}${result.stderr}` };
}
