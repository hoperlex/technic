import type { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { shiftDateKey, type DriverState } from '@technic/contracts';
import * as schema from '../src/db/schema';
import {
  assignmentChangeTargetOf,
  ensureAssignmentHistory,
  readAssignmentHistorySnapshot,
  type AssignmentHistorySnapshot,
} from '../src/services/assignment-ensure';
import {
  assignmentStateOn,
  sameDriverState,
  type AssignmentChangeRow,
} from '../src/services/assignment-history';
import {
  applyAssignmentMutations,
  assertAssignmentDenormalization,
  type AssignmentChangeValue,
  type AssignmentWriteMutation,
} from '../src/services/assignment-write';

/**
 * Repair of history that drifted from the issued paper while history was read (ADR 0212, decision
 * 5): the core of `assignment-drift.ts`, kept apart so a db test can drive it without a CLI.
 *
 * WHERE THE DRIFT CAME FROM. Between the switch to `read_mode = history` and ADR 0212, "Change
 * vehicle" and a re-entry after a rollback to «Новая» rewrote the assignment and the ESM-2 sheets
 * but not history. Readers then showed the previous pair, and the next history command would issue
 * paper from it. The issued sheets are the strict-reporting truth of what was printed, so they are
 * the anchor of the repair — the user's decision В1: history follows the paper from the first sheet
 * where they part, not from the logged date of the change, and no sheet number is burned.
 *
 * WHAT IS REPAIRED. Only history; paper and the assignment are left exactly as they are
 * (denormalization intent `materialize`). From the start of the first drifting sheet every active
 * sheet's (vehicle, machinist) is written on its first day; after the last sheet the vehicle follows
 * the assignment (a rental one with `cleared` machinist). The result is re-checked in the same
 * transaction: history must agree with every sheet on every day and its tail must be the assigned
 * vehicle, or nothing is written.
 *
 * WHAT IS LEFT TO A HUMAN. Two cases the command reports and never writes:
 *
 * - `paper_follows_stale_tail` — history and paper agree, but both name a vehicle other than the
 *   assignment to the end of the term. That is a sheet already re-issued onto the previous vehicle
 *   by a history command after a lost reassignment (or a backfill tail warning, R30): which vehicle
 *   really works is a question about the paper, not about history;
 * - `unresolvable` — history contradicts the paper inside a sheet (a row in the middle of a sheet's
 *   days), and writing on sheet boundaries does not reconcile them;
 * - `no_paper` — the request has no active sheet at all: there is nothing issued to follow.
 */

type Handle = ReturnType<typeof drizzle<typeof schema>>;
type Tx = Parameters<Parameters<Handle['transaction']>[0]>[0];

/** A point of the target timeline: on `date` the vehicle (and, when named, the machinist) is this. */
export interface DriftPoint {
  date: string;
  vehicleId: string;
  /** `null` — the machinist is inherited from the previous day. */
  driver: DriverState | null;
}

/** A sheet whose pair differs from history on at least one of its days. */
export interface DriftSheet {
  waybillId: string;
  from: string;
  to: string;
  /** First day on which history names another pair. */
  day: string;
}

export type DriftVerdict =
  | { kind: 'clean' }
  | {
      kind: 'repair';
      /** First day history is rewritten from — the start of the first drifting sheet, or the tail. */
      boundary: string;
      points: DriftPoint[];
      sheets: DriftSheet[];
      mutations: AssignmentWriteMutation[];
    }
  | {
      kind: 'manual';
      reason: 'paper_follows_stale_tail' | 'unresolvable' | 'no_paper';
      sheets: DriftSheet[];
      historyTailVehicleId: string | null;
      assignmentVehicleId: string | null;
    };

/**
 * Requests to examine: in work or done, special equipment, not linear, with active history rows.
 * Linear requests are out: their paper is issued on demand per week and history only holds their
 * default vehicle (ADR 0100 §6), so a sheet on another vehicle is not a drift.
 */
export async function listDriftCandidates(
  db: Handle,
  params: { nums?: readonly number[] } = {},
): Promise<{ id: string; num: number }[]> {
  const rows = await db.execute<{ id: string; num: number }>(sql`
    SELECT r.id, r.num
      FROM vehicle_requests r
      JOIN special_equipment_request_details d ON d.request_id = r.id
      JOIN vehicle_types vt ON vt.id = r.vehicle_type_id
     WHERE r.request_type = 'special_equipment'
       AND r.status IN ('confirmed', 'done')
       AND r.deleted_at IS NULL
       AND d.date_from IS NOT NULL
       AND NOT coalesce(r.is_linear_frozen, vt.is_linear)
       AND EXISTS (SELECT 1 FROM vehicle_request_assignment_changes c
                    WHERE c.request_id = r.id AND c.superseded_at IS NULL)
       ${
         params.nums && params.nums.length > 0
           ? sql`AND r.num IN (${sql.join(
               params.nums.map((n) => sql`${n}`),
               sql`, `,
             )})`
           : sql``
       }
     ORDER BY r.num`);
  return [...rows.rows];
}

/** Calendar days of a sheet inside the term: history has no meaning outside it. */
function sheetDays(
  sheet: { periodFrom: string; periodTo: string },
  term: { dateFrom: string; dateTo: string | null },
): { from: string; to: string } | null {
  const last = term.dateTo || term.dateFrom;
  const from = sheet.periodFrom > term.dateFrom ? sheet.periodFrom : term.dateFrom;
  const to = sheet.periodTo < last ? sheet.periodTo : last;
  return from <= to ? { from, to } : null;
}

/** First day of the sheet on which history names another vehicle or machinist; `null` — agrees. */
function firstMismatch(
  rows: readonly AssignmentChangeRow[],
  sheet: AssignmentHistorySnapshot['sheets'][number],
  days: { from: string; to: string },
): string | null {
  for (let day = days.from; day <= days.to; day = shiftDateKey(day, 1)) {
    const state = assignmentStateOn(rows, day);
    if (state.vehicle?.vehicleId !== sheet.vehicleId) return day;
    if (sheet.driverPersonId) {
      const driver = state.driver;
      if (driver?.state !== 'set' || driver.personId !== sheet.driverPersonId) return day;
    }
  }
  return null;
}

function driftSheets(snapshot: AssignmentHistorySnapshot, rows: readonly AssignmentChangeRow[]) {
  const found: DriftSheet[] = [];
  for (const sheet of snapshot.sheets) {
    const days = sheetDays(sheet, snapshot.term);
    if (!days) continue;
    const day = firstMismatch(rows, sheet, days);
    if (day) found.push({ waybillId: sheet.id, from: days.from, to: days.to, day });
  }
  return found;
}

/**
 * What the repair of one request would write — reads only.
 *
 * The same function runs in the dry run and inside the writing transaction: the plan that is
 * applied is recomputed under the row lock, never carried over from the report.
 */
export async function planDriftRepair(tx: Tx, requestId: string): Promise<DriftVerdict> {
  const snapshot = await readAssignmentHistorySnapshot(tx, requestId);
  const rows: readonly AssignmentChangeRow[] = snapshot.changes;
  if (snapshot.isLinear || rows.length === 0) return { kind: 'clean' };
  const term = snapshot.term;
  const last = term.dateTo || term.dateFrom;
  const assigned = snapshot.assignmentVehicleId;
  const tailOf = (changes: readonly AssignmentChangeRow[]) =>
    assignmentStateOn(changes, last).vehicle?.vehicleId ?? null;

  const drifting = driftSheets(snapshot, rows);
  const covered = snapshot.sheets
    .map((sheet) => ({ sheet, days: sheetDays(sheet, term) }))
    .filter(
      (s): s is { sheet: (typeof snapshot.sheets)[number]; days: { from: string; to: string } } =>
        s.days !== null,
    )
    .sort((a, b) => (a.days.from < b.days.from ? -1 : a.days.from > b.days.from ? 1 : 0));
  const lastCovered = covered.length > 0 ? covered[covered.length - 1]! : null;

  if (drifting.length === 0 && (assigned === null || tailOf(rows) === assigned)) {
    return { kind: 'clean' };
  }
  const manual = (
    reason: 'paper_follows_stale_tail' | 'unresolvable' | 'no_paper',
  ): DriftVerdict => ({
    kind: 'manual',
    reason,
    sheets: drifting,
    historyTailVehicleId: tailOf(rows),
    assignmentVehicleId: assigned,
  });
  // History and paper agree to the end of the term, and both disagree with the assignment: the
  // paper itself was re-issued onto the previous vehicle. Rewriting history would contradict it.
  if (drifting.length === 0 && lastCovered && lastCovered.days.to >= last) {
    return manual('paper_follows_stale_tail');
  }
  // Without a single sheet there is nothing issued to follow; flattening history onto the
  // assignment from the start of the term would invent the past.
  if (!lastCovered) return manual('no_paper');

  const boundary =
    drifting.length > 0
      ? drifting.reduce((min, s) => (s.from < min ? s.from : min), drifting[0]!.from)
      : shiftDateKey(lastCovered.days.to, 1);
  const points: DriftPoint[] = covered
    .filter(({ days }) => days.from >= boundary)
    .map(({ sheet, days }) => ({
      date: days.from,
      vehicleId: sheet.vehicleId,
      driver: sheet.driverPersonId ? { state: 'set', personId: sheet.driverPersonId } : null,
    }));
  const afterPaper = shiftDateKey(lastCovered.days.to, 1);
  if (assigned && afterPaper <= last && afterPaper >= boundary) {
    points.push({
      date: afterPaper,
      vehicleId: assigned,
      driver: snapshot.ownershipByVehicle.get(assigned) === 'rental' ? { state: 'cleared' } : null,
    });
  }

  // The target timeline, applied in memory exactly as the write core will apply it.
  let after: AssignmentChangeRow[] = [...rows];
  const mutations: AssignmentWriteMutation[] = [];
  for (const point of points) {
    const vehicleChanges =
      assignmentStateOn(after, point.date).vehicle?.vehicleId !== point.vehicleId;
    const origin = vehicleChanges ? ('reassignment' as const) : ('machinist_change' as const);
    const put = (value: AssignmentChangeValue): void => {
      const state = assignmentStateOn(after, point.date);
      const unchanged =
        value.dimension === 'vehicle'
          ? state.vehicle?.vehicleId === value.vehicleId
          : sameDriverState(state.driver, value.driver);
      if (unchanged) return;
      const fields =
        value.dimension === 'vehicle'
          ? { vehicleId: value.vehicleId, driverPersonId: null, driverState: null }
          : {
              vehicleId: null,
              driverPersonId: value.driver.state === 'set' ? value.driver.personId : null,
              driverState: value.driver.state,
            };
      const row = after.find(
        (r) => r.dimension === value.dimension && r.effectiveDate === point.date,
      );
      const group = `drift:${point.date}`;
      if (row) {
        mutations.push({
          kind: 'replace',
          target: assignmentChangeTargetOf(row),
          value,
          origin,
          group,
        });
        after = after.map((r) => (r === row ? { ...r, ...fields, origin } : r));
        return;
      }
      mutations.push({ kind: 'insert', effectiveDate: point.date, value, origin, group });
      after = [
        ...after,
        {
          id: `planned-drift:${value.dimension}:${point.date}`,
          effectiveDate: point.date,
          dimension: value.dimension,
          ...fields,
          origin,
          changeGroupId: group,
          supersededAt: null,
        },
      ];
    };
    put({ dimension: 'vehicle', vehicleId: point.vehicleId });
    if (point.driver) put({ dimension: 'driver', driver: point.driver });
  }

  // Writing on sheet boundaries must reconcile everything; otherwise history contradicts the paper
  // inside a sheet, and that is not decided by a command.
  if (
    driftSheets(snapshot, after).length > 0 ||
    (assigned !== null && tailOf(after) !== assigned)
  ) {
    return manual('unresolvable');
  }
  return { kind: 'repair', boundary, points, sheets: drifting, mutations };
}

/**
 * Repair one request: one transaction, the row lock first, the plan recomputed under it, history
 * written, readiness recomputed, the result re-checked, an audit event written with it.
 */
export async function applyDriftRepair(
  db: Handle,
  params: { requestId: string; asOf: string; actorUserId: string; reason: string },
): Promise<DriftVerdict> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM vehicle_requests WHERE id = ${params.requestId}::uuid FOR UPDATE`,
    );
    const verdict = await planDriftRepair(tx, params.requestId);
    if (verdict.kind !== 'repair') return verdict;
    const write = await applyAssignmentMutations(tx, {
      requestId: params.requestId,
      actorUserId: params.actorUserId,
      correctionId: null,
      mutations: verdict.mutations,
      // History catches up with what was printed; the assignment is not touched.
      denormalization: { kind: 'materialize' },
    });
    await assertAssignmentDenormalization(tx, write.denormalization);
    await ensureAssignmentHistory(tx, { requestId: params.requestId, asOf: params.asOf });
    const recheck = await planDriftRepair(tx, params.requestId);
    if (recheck.kind !== 'clean') {
      throw new Error(
        `после починки история заявки ${params.requestId} по-прежнему расходится с бумагой — запись отменена`,
      );
    }
    await tx.insert(schema.auditLog).values({
      actorUserId: params.actorUserId,
      action: 'assignment.drift_repair',
      entityType: 'vehicle_request',
      entityId: params.requestId,
      metadata: {
        reason: params.reason,
        boundary: verdict.boundary,
        points: verdict.points,
        driftSheets: verdict.sheets,
        written: write.inserted.length,
        replaced: write.superseded.length,
      },
    });
    return verdict;
  });
}
