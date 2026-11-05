import { eq, sql } from 'drizzle-orm';
import type { db } from '../db/client';
import { vehicleRequestWorkingDays } from '../db/schema';
import { writeAuditTx } from '../lib/audit';
import { changeSet, dateKeyRu, EMPTY } from './request-diff';

/**
 * The lifecycle of working Sunday marks (ADR 0246, plan docs/rest-days-plan.md §5.1). A mark
 * belongs to a request and a date; it outlives a reassignment and a paper reissue, and goes with:
 *
 * - a term that no longer holds the day — every term writer calls `afterWorkPeriodChanged`, which
 *   calls `dropWorkingDaysOutsideTerm` in the same transaction, so a later extension cannot bring
 *   an old choice back;
 * - the work reset of a return to «Новая» and a change of the request type (`dropAllWorkingDays`);
 * - a physical deletion of the request (the foreign key cascades).
 *
 * A cancelled or archived request keeps its marks as history, but they give no demand
 * (`servedRequestSql` in the expected-shift rule).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Drops the marks outside the request's effective term and records it in the request history in
 * the same transaction (`writeAuditTx`): the term change itself is history, and the marks it took
 * away must be found next to it, not lost to a failed after-commit write. Returns the dropped dates.
 */
export async function dropWorkingDaysOutsideTerm(
  tx: Tx,
  requestId: string,
  actorUserId: string,
): Promise<string[]> {
  const result = await tx.execute<{ work_date: string }>(sql`
    DELETE FROM vehicle_request_working_days wd
     USING special_equipment_request_details d
     WHERE wd.request_id = ${requestId}
       AND d.request_id = wd.request_id
       AND (wd.work_date < d.date_from OR wd.work_date > coalesce(d.date_to, d.date_from))
    RETURNING wd.work_date::text AS work_date`);
  const dropped = result.rows.map((row) => row.work_date).sort();
  if (dropped.length > 0) {
    const diff = changeSet();
    for (const date of dropped) diff.changed('workingDay', dateKeyRu(date), EMPTY);
    await writeAuditTx(tx, {
      actorUserId,
      action: 'vehicle_request.working_day_remove',
      entityType: 'vehicle_request',
      entityId: requestId,
      metadata: { changes: diff.changes, reason: 'срок заявки больше не включает этот день' },
    });
  }
  return dropped;
}

/** Drops every mark of the request: the work reset of «Новая» and a change of the request type. */
export async function dropAllWorkingDays(tx: Tx, requestId: string): Promise<void> {
  await tx
    .delete(vehicleRequestWorkingDays)
    .where(eq(vehicleRequestWorkingDays.requestId, requestId));
}
