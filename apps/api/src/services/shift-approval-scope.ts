import { and, eq, isNotNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { VehicleOwnership } from '@technic/contracts';
import type * as schema from '../db/schema';
import { users, vehicleRequestShifts, vehicleRouteRequests } from '../db/schema';
import type { ShiftsTx } from './assignment-shifts';
import type { DateRangeSet } from './esm2-plan';
import type { ShiftApproval } from './vehicle-route-correction';

/**
 * Which object sign-offs an assignment correction clears — the single carrier of that rule
 * (ADR 0210).
 *
 * WHO CALLS IT. Three places decide the same question and must never answer it differently:
 *
 * - the reassign door's backdated correction (`PATCH /vehicle-requests/:id/assignment` with a
 *   `correction` block, `planAssignmentCorrection` in `routes/vehicle-requests.ts`) — it clears
 *   exactly this set;
 * - its preview and fingerprint (`planReassignCommand`, `assignment-reassign.ts`) — it shows this
 *   set as `clearedShiftDays` and hashes it. The executing door recomputes the fingerprint under its
 *   locks, so a second copy of the rule would turn every correction into a 409 the moment the two
 *   copies diverged — or, worse, show one set and clear another;
 * - the period correction (`planVehicleCorrection`, `assignment-correction.ts`) — the same rule
 *   inside its own `approvalClearRange`.
 *
 * Before ADR 0210 these were three hand-written variants, and they had already drifted apart: the
 * reassign door skipped linear requests entirely, the preview read linearity by another expression,
 * and the period correction looked at neither linearity nor day routes.
 *
 * THE RULE. A sign-off stands under the work of the vehicle that actually went out that day.
 *
 * - A day that sits in a day route (`vehicle_route_requests.work_date`, ADR 0100 §2) was worked by
 *   the route's vehicle, whatever the assignment says: since ADR 0207 any request on a site may
 *   have day routes, and the per-day door accepts any own vehicle and only marks the mismatch
 *   (`otherVehicle`). Rewriting the assignment does not contradict such a day, so its sign-off
 *   stays. The vehicle of that day is corrected by the route correction, which clears its own
 *   sign-offs (`approvedShiftsOfComposition`).
 * - A day without a route was worked by the assignment's vehicle — exactly what the correction
 *   rewrites — so its sign-off is cleared.
 *
 * Linearity is deliberately NOT part of the rule. It used to be (ADR 0100 §4: "the day's vehicle is
 * the route's vehicle"), but that premise is about the route, not about the type: a linear day
 * without a route is worked by the default vehicle just like any other, and a non-linear day in a
 * route is not. Reading the route directly answers the real question for both.
 *
 * WHAT BREAKS IF THIS IS BYPASSED. Clearing a route day's sign-off makes the object re-approve hours
 * nobody disputed; keeping a route-less day's sign-off leaves accepted hours attributed to a vehicle
 * the correction has just declared absent. Both are silent — the table shows "approved" either way.
 */

type AppDatabase = NodePgDatabase<typeof schema>;
/** Pool or transaction: the reassign door plans before its transaction, the other two inside. */
type Reader = AppDatabase | ShiftsTx;

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
   * Whether the request's day routes outlive the command. See `dayRoutesKeptWith`: when the
   * command's own day sync takes the days off their routes, those days become route-less and fall
   * under the assignment's vehicle — keeping their sign-offs would attach approved hours to a
   * vehicle nobody approved.
   */
  dayRoutesKept: boolean;
}

/**
 * Whether the reassign door keeps the request's day routes when it leaves a vehicle of this
 * ownership on the assignment.
 *
 * The door runs the day sync after writing the assignment (`syncLinearRouteDays`), and the sync
 * sweeps every day off its route once the assigned vehicle is rented (`linearDaysBlocker`: a
 * rented vehicle does not go on routes, its lessor issues the paper). A day frozen by an issued
 * waybill stays in its route, but a correction refuses such a command altogether (`days.frozen`),
 * so treating the whole set as swept only changes what a refused command would have shown.
 *
 * Days outside the term are also swept by that sync, and they are not modelled here: a filled day
 * outside the term only survives a term edit when its route was frozen at the time, and a sign-off
 * on it is a corner the rule accepts rather than reads the term for.
 */
export function dayRoutesKeptWith(ownershipAfter: VehicleOwnership): boolean {
  return ownershipAfter === 'own';
}

/**
 * Whether a correction clears the sign-off of this day. Pure: the preview and the door feed it the
 * same reads, and a unit test pins the rule without a database.
 */
export function assignmentCorrectionClearsDay(
  date: string,
  scope: { routeDays: ReadonlySet<string>; range: DateRangeSet | null },
): boolean {
  if (scope.routeDays.has(date)) return false;
  return scope.range === null || scope.range.some((r) => r.from <= date && date <= r.to);
}

/**
 * The sign-offs an assignment correction clears, with the previous `approvedBy`/`approvedAt`.
 *
 * The previous signer is read together with the day: after clearing, the table no longer holds it,
 * and "who accepted 11.5 machine hours for August 12" is asked two months later — the operation's
 * snapshot is the only answer left.
 *
 * Ordered by date: the preview hashes the set into its fingerprint and names it to a person, and a
 * list that reorders between two identical reads would read as a different list.
 */
export async function approvalsClearedByAssignmentCorrection(
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
      ),
    )
    .orderBy(vehicleRequestShifts.shiftDate);
  if (rows.length === 0) return [];

  const routeDays = scope.dayRoutesKept
    ? await dayRouteDates(reader, scope.requestId)
    : new Set<string>();
  return rows.flatMap((row) =>
    row.approvedBy &&
    row.approvedAt &&
    assignmentCorrectionClearsDay(row.shiftDate, { routeDays, range: scope.range })
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

/**
 * Days of the request that sit in a route — the same carrier the day table and the day sync read
 * (`plannedDayRows`, `hasPlannedDays` in `vehicle-request-days.ts`).
 *
 * A composition row exists exactly while its route does: routes are deleted physically and the row
 * goes by cascade, so there is no "deleted route" to filter out. Two queries instead of a
 * correlated `NOT EXISTS`: a correlated subquery in a single-table drizzle select silently loses
 * its correlation, and the request has at most as many rows here as days in its term.
 */
async function dayRouteDates(reader: Reader, requestId: string): Promise<Set<string>> {
  const rows = await reader
    .select({ workDate: vehicleRouteRequests.workDate })
    .from(vehicleRouteRequests)
    .where(
      and(eq(vehicleRouteRequests.requestId, requestId), isNotNull(vehicleRouteRequests.workDate)),
    );
  return new Set(rows.flatMap((row) => (row.workDate ? [row.workDate] : [])));
}
