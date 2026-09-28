import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import {
  approvedShiftsBlocker,
  canReassignVehicle,
  dayRoutesKeptWith,
  reassignApprovedShiftsBlocker,
  reassignLockingApprovedDays,
  type VehicleRequestShiftsSummaryDto,
} from '@technic/contracts';
import * as schema from '../src/db/schema';
import {
  approvalLockingReassignmentSql,
  shiftDayHasOwnRouteSql,
} from '../src/services/shift-approval-scope';

/**
 * The rule of ADR 0210 without a database: which approved days stand under the assignment's
 * vehicle — they lock a plain reassignment and are what a correction clears.
 *
 * The db suite (`shift-approval-scope.db.test.ts`) proves that the doors ask this rule and agree
 * with each other; here the contract half is pinned (the lock the portal and the door share, and
 * its behaviour against an older server), and so is the shape of the one SQL expression that says
 * "this day sits in its own route".
 */

const summary = (
  approvedDays: number,
  approvedDaysWithoutRoute?: number,
): VehicleRequestShiftsSummaryDto => ({
  approvedDays,
  ...(approvedDaysWithoutRoute === undefined ? {} : { approvedDaysWithoutRoute }),
  unapprovedPastDays: 0,
});

const inWork = {
  requestType: 'special_equipment' as const,
  status: 'confirmed' as const,
  assignment: { vehicleId: 'v-1' } as never,
  deletedAt: null,
};

describe('lock of a plain reassignment (ADR 0210)', () => {
  it('a sign-off of a day in its own route does not lock; a route-less one does', () => {
    // Two approved days, both in routes: the assigned vehicle did not work them.
    expect(canReassignVehicle({ ...inWork, shifts: summary(2, 0) })).toBe(true);
    expect(reassignApprovedShiftsBlocker({ ...inWork, shifts: summary(2, 0) })).toBeNull();
    // One of them without a route: the assigned vehicle worked it, and a swap would rewrite it.
    expect(canReassignVehicle({ ...inWork, shifts: summary(2, 1) })).toBe(false);
    expect(reassignApprovedShiftsBlocker({ ...inWork, shifts: summary(2, 1) })).toMatch(
      /согласовано смен: 1/,
    );
  });

  it('a rented next vehicle sweeps the day routes, so every approved day locks again', () => {
    expect(dayRoutesKeptWith('own')).toBe(true);
    expect(dayRoutesKeptWith('rental')).toBe(false);
    expect(reassignLockingApprovedDays(summary(2, 0), 'rental')).toBe(2);
    expect(reassignApprovedShiftsBlocker({ ...inWork, shifts: summary(2, 0) }, 'rental')).toMatch(
      /согласовано смен: 2/,
    );
  });

  it('a summary from a server older than ADR 0210 locks by every approved day', () => {
    // No `approvedDaysWithoutRoute` means "unknown", not zero: offering the button would lead the
    // person into the old server's refusal.
    expect(reassignLockingApprovedDays(summary(1))).toBe(1);
    expect(canReassignVehicle({ ...inWork, shifts: summary(1) })).toBe(false);
    expect(canReassignVehicle({ ...inWork, shifts: summary(0) })).toBe(true);
  });

  it('the rollback lock stays wider: it erases the shifts themselves, route or not', () => {
    expect(approvedShiftsBlocker({ ...inWork, shifts: summary(2, 0) })).toMatch(
      /согласовано смен: 2/,
    );
  });
});

describe('"this day sits in its own route" keeps its correlation (drizzle rewrite trap)', () => {
  /**
   * The worst place for the expression: the select list of a single-table query, where drizzle
   * rewrites top-level column chunks to bare identifiers. A bare `"request_id"` inside the subquery
   * would bind to `own_route` itself and make every day "routed" — silently. No query is executed:
   * `toSQL()` only renders.
   */
  it('references the outer shift row by a qualified name', () => {
    const db = drizzle({ client: {} as never, schema, casing: 'snake_case' });
    const { sql: text } = db
      .select({ routed: shiftDayHasOwnRouteSql() })
      .from(schema.vehicleRequestShifts)
      .toSQL();
    expect(text).toContain('own_route.request_id = "vehicle_request_shifts"."request_id"');
    expect(text).toContain('own_route.work_date = "vehicle_request_shifts"."shift_date"');
  });

  it('the lock predicate carries the route rule and the term bound in one expression', () => {
    // The summary counts by it and the door re-reads by it: both halves must be inside, or the
    // two answers could differ. The term needs the details table, as both callers join it.
    const db = drizzle({ client: {} as never, schema, casing: 'snake_case' });
    const { sql: text } = db
      .select({ locks: approvalLockingReassignmentSql(true) })
      .from(schema.vehicleRequestShifts)
      .innerJoin(
        schema.specialEquipmentRequestDetails,
        eq(schema.specialEquipmentRequestDetails.requestId, schema.vehicleRequestShifts.requestId),
      )
      .toSQL();
    expect(text).toContain('"vehicle_request_shifts"."approved_at" IS NOT NULL');
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('"special_equipment_request_details"."date_from"');
    // With a rented vehicle the routes are swept, and the route clause drops out.
    const { sql: rented } = db
      .select({ locks: approvalLockingReassignmentSql(false) })
      .from(schema.vehicleRequestShifts)
      .innerJoin(
        schema.specialEquipmentRequestDetails,
        eq(schema.specialEquipmentRequestDetails.requestId, schema.vehicleRequestShifts.requestId),
      )
      .toSQL();
    expect(rented).not.toContain('own_route');
  });
});
