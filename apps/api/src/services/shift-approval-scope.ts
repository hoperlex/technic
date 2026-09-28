import { and, eq, isNotNull, not, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema';
import { users, vehicleRequestShifts, vehicleRouteRequests } from '../db/schema';
import type { ShiftsTx } from './assignment-shifts';
import type { DateRangeSet } from './esm2-plan';
import type { ShiftApproval } from './vehicle-route-correction';

/**
 * Which object sign-offs stand under the assignment's vehicle — the single carrier of that rule
 * (ADR 0210). Those are the sign-offs a backdated correction of the vehicle clears, and the same
 * ones that lock a plain reassignment (ADR 0184 §7): one question, "whose work did the object
 * accept", asked by two operations.
 *
 * WHO ASKS IT. Every place below must answer the same way, so none of them spells the rule itself:
 *
 * - the reassign door's backdated correction (`planAssignmentCorrection` in
 *   `routes/vehicle-requests.ts`) clears exactly `approvalsUnderAssignment`;
 * - its preview and fingerprint (`planReassignCommand`, `assignment-reassign.ts`) show the same set
 *   as `clearedShiftDays` for a correction and as `blockedShiftDays` for a plain reassignment. The
 *   executing door recomputes the fingerprint under its locks, so a second copy of the rule would
 *   turn every command into a 409 the moment the copies diverged — or show one set and act on
 *   another;
 * - the period correction (`planVehicleCorrection`, `assignment-correction.ts`) clears the same set
 *   inside its own `approvalClearRange`;
 * - the shift summary of a list row (`shiftSummaries`, `vehicle-request-shifts.ts`) counts it as
 *   `approvedDaysWithoutRoute` through `shiftDayHasOwnRouteSql`; the contract predicates
 *   `canReassignVehicle` / `reassignApprovedShiftsBlocker` lock the button and the door by it.
 *
 * Before ADR 0210 these were separate hand-written variants and had drifted apart: the reassign
 * door skipped linear requests, the preview read linearity by another expression, the period
 * correction looked at neither linearity nor day routes, and the lock counted every approved day.
 *
 * THE RULE. A sign-off stands under the work of the vehicle that actually went out that day.
 *
 * - A day that sits in its own day route (`vehicle_route_requests.work_date`, ADR 0100 §2) was
 *   worked by the route's vehicle, whatever the assignment says: since ADR 0207 any request on a
 *   site may have day routes, and the per-day door accepts any own vehicle and only marks the
 *   mismatch (`otherVehicle`). Changing the assignment does not contradict such a day — its
 *   sign-off neither locks the change nor is cleared by a correction; the route correction owns it
 *   (`approvedShiftsOfComposition`).
 * - A day without a route was worked by the assignment's vehicle — exactly what both operations
 *   change — so its sign-off locks a plain reassignment and is cleared by a correction.
 *
 * Linearity is deliberately NOT part of the rule. It used to be (ADR 0100 §4), but that premise is
 * about the route, not the type: a linear day without a route is worked by the default vehicle
 * like any other, and a non-linear day in a route is not.
 *
 * WHAT BREAKS IF THIS IS BYPASSED. Treating a route day as the assignment's makes the object
 * re-approve hours nobody disputed and locks reassignments for nothing; treating a route-less day
 * as the route's leaves accepted hours attributed to a vehicle the operation has just replaced.
 * Both are silent — the table shows "approved" either way.
 */

type AppDatabase = NodePgDatabase<typeof schema>;
/** Pool or transaction: the reassign door plans before its transaction, the other callers inside. */
type Reader = AppDatabase | ShiftsTx;

/**
 * "This shift day sits in its own day route" — the one expression of the carrier, correlated to the
 * `vehicle_request_shifts` row of the surrounding query. It reads the same composition row the day
 * table and the day sync read (`plannedDayRows`, `hasPlannedDays` in `vehicle-request-days.ts`).
 *
 * A composition row exists exactly while its route does: routes are deleted physically and the row
 * goes by cascade, so there is no "deleted route" to filter out.
 *
 * The correlation is written against the table chunk (`${vehicleRequestShifts}."request_id"`), not
 * the column object. In a single-table select drizzle rewrites top-level column references in the
 * select list to bare identifiers, and inside this subquery a bare `"request_id"` would silently
 * bind to `own_route` itself — a tautology that makes every day "routed". Both current callers put
 * it where the rewrite does not happen (a `WHERE`, a joined select), but the next one may not;
 * `shift-approval-scope.test.ts` pins the rendered SQL.
 */
export function shiftDayHasOwnRouteSql(): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${vehicleRouteRequests} own_route
     WHERE own_route.request_id = ${vehicleRequestShifts}."request_id"
       AND own_route.work_date = ${vehicleRequestShifts}."shift_date")`;
}

export interface ShiftApprovalScope {
  requestId: string;
  /** "ТС-123": the operation snapshot names the request by it. */
  displayNumber: string;
  /**
   * Days the command re-attributes to another vehicle. `null` — the whole request: the reassign
   * door rewrites the single assignment for the entire term. An empty set means "nothing", not
   * "everything" — a period correction whose range is empty clears no sign-off.
   */
  range: DateRangeSet | null;
  /**
   * Whether the request's day routes outlive the command (`dayRoutesKeptWith` in the contracts):
   * when the command's own day sync takes the days off their routes, those days become route-less
   * and fall under the assignment's vehicle.
   */
  dayRoutesKept: boolean;
}

/**
 * The approved days that stand under the assignment's vehicle, with the previous `approvedBy` /
 * `approvedAt`.
 *
 * The previous signer is read together with the day: after a correction clears it, the table no
 * longer holds it, and "who accepted 11.5 machine hours for August 12" is asked two months later —
 * the operation's snapshot is the only answer left.
 *
 * Every approved row counts, inside the term or not: a correction has always cleared all of them.
 * The lock of a plain reassignment is narrower — the term, like the rest of the shift summary — and
 * callers that answer for the lock filter by the term themselves.
 *
 * Ordered by date: the preview hashes the set into its fingerprint and names it to a person, and a
 * list that reorders between two identical reads would read as a different list.
 */
export async function approvalsUnderAssignment(
  reader: Reader,
  scope: ShiftApprovalScope,
): Promise<ShiftApproval[]> {
  if (scope.range !== null && scope.range.length === 0) return [];
  const rows = await reader
    .select({
      shiftDate: vehicleRequestShifts.shiftDate,
      approvedBy: vehicleRequestShifts.approvedBy,
      approvedByName: users.fullName,
      approvedAt: vehicleRequestShifts.approvedAt,
    })
    .from(vehicleRequestShifts)
    .innerJoin(users, eq(users.id, vehicleRequestShifts.approvedBy))
    .where(
      and(
        eq(vehicleRequestShifts.requestId, scope.requestId),
        isNotNull(vehicleRequestShifts.approvedAt),
        scope.dayRoutesKept ? not(shiftDayHasOwnRouteSql()) : undefined,
      ),
    )
    .orderBy(vehicleRequestShifts.shiftDate);
  const range = scope.range;
  return rows.flatMap((row) =>
    row.approvedBy &&
    row.approvedAt &&
    (range === null || range.some((r) => r.from <= row.shiftDate && row.shiftDate <= r.to))
      ? [
          {
            requestId: scope.requestId,
            displayNumber: scope.displayNumber,
            date: row.shiftDate,
            approvedBy: row.approvedBy,
            approvedByName: row.approvedByName,
            approvedAt: row.approvedAt.toISOString(),
          },
        ]
      : [],
  );
}
