import { and, eq } from 'drizzle-orm';
import {
  canReturnWeeklyRequest,
  formatWeeklyRequestNumber,
  WEEKLY_RETURN_CORRECTION_REQUIRED_MESSAGE,
  weeklyReturnHeaderBlocker,
  weeklyWeekLabel,
  type WeeklyReversalResultDto,
} from '@technic/contracts';
import type { db } from '../db/client';
import {
  weeklyVehicleRequestHistory,
  weeklyVehicleRequestItems,
  weeklyVehicleRequests,
} from '../db/schema';
import { err } from '../lib/errors';
import {
  reverseWeeklyEffects,
  weeklyReversalPayload,
  type WeeklyReversalParams,
  type WeeklyReversalSpec,
} from './weekly-request-annul';

/**
 * Return of an applied weekly request for re-approval (ADR 0219).
 *
 * The dispatcher finds that the applied week lacks equipment the site needs. The consequences are
 * reversed by the annulment engine (`reverseWeeklyEffects`), and the week goes back to "awaiting
 * approval" as an ordinary pending request: the site adds what was forgotten, and the construction
 * manager approves it through the unchanged apply (`weekly-request-apply.ts`).
 *
 * WHY ROLL BACK AND NOT FREEZE. Keeping the extensions and created orders alive while the document
 * waits for a second approval would need a new state — "applied rows inside an unapproved
 * document" — that every reader of the weekly status (the table of ADR 0218) would have to learn,
 * plus an apply by difference. Reversing reuses the engine as it is and keeps one invariant intact:
 * an approved week is exactly an applied one, and a pending week has no consequences.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Reverse the consequences, then hand the week back for approval.
 *
 * The header loses the approval: the two lifecycle CHECKs bind `approved_by` and `applied_at` to
 * the applied states, and a pending week with an approval is exactly the state they forbid. The
 * rows go back to `pending` with their snapshots cleared, because the next approval applies them
 * from scratch and the shape CHECKs allow a snapshot only next to a result. What the first approval
 * did — who approved, when, and the result of every row — moves to the history event instead.
 */
export async function applyWeeklyReturn(
  tx: Tx,
  params: WeeklyReversalParams,
): Promise<WeeklyReversalResultDto> {
  const { plan, actor } = params;
  const now = new Date();
  const weekLabel = weeklyWeekLabel(plan.header.weekStart);
  const weeklyNumber = formatWeeklyRequestNumber(plan.header.num);
  const effects = await reverseWeeklyEffects(tx, {
    ...params,
    door: 'weekly_return',
    baseReason: `Недельная заявка ${weeklyNumber} (${weekLabel}) возвращена на согласование: ${params.reason}`,
  });

  // The approval the return erases, read before the header is rewritten: the plan has locked the
  // row, so this is the approval the reversal actually undoes.
  const [approval] = await tx
    .select({
      approvedBy: weeklyVehicleRequests.approvedBy,
      approvedAt: weeklyVehicleRequests.approvedAt,
      appliedAt: weeklyVehicleRequests.appliedAt,
    })
    .from(weeklyVehicleRequests)
    .where(eq(weeklyVehicleRequests.id, plan.header.id));

  const [bumped] = await tx
    .update(weeklyVehicleRequests)
    .set({
      status: 'pending',
      approvedBy: null,
      approvedAt: null,
      appliedAt: null,
      updatedBy: actor.id,
      updatedAt: now,
      version: plan.header.version + 1,
    })
    .where(
      and(
        eq(weeklyVehicleRequests.id, plan.header.id),
        eq(weeklyVehicleRequests.version, plan.header.version),
      ),
    )
    .returning({ id: weeklyVehicleRequests.id });
  if (!bumped) throw err.conflict();

  const rows = await tx
    .update(weeklyVehicleRequestItems)
    .set({
      result: 'pending',
      skipReason: '',
      previousDateTo: null,
      appliedSourceVersion: null,
      snapshotVehicleId: null,
      // `weekly_items_created_check` allows the link only next to `created`; the cancelled order
      // stays explained by its own status history, which names the week and the reason.
      createdRequestId: null,
    })
    .where(eq(weeklyVehicleRequestItems.weeklyRequestId, plan.header.id))
    .returning({ id: weeklyVehicleRequestItems.id });

  // History in the same transaction (ADR 0085 item 16). The payload carries what the rows lose:
  // after the reset only this event answers "what did the first approval do".
  await tx.insert(weeklyVehicleRequestHistory).values({
    weeklyRequestId: plan.header.id,
    event: 'status',
    fromStatus: 'applied',
    toStatus: 'pending',
    changedBy: actor.id,
    comment: params.reason,
    payload: {
      ...weeklyReversalPayload(plan, effects, params.correctionId),
      returned: true,
      approval: approval
        ? {
            approvedBy: approval.approvedBy,
            approvedAt: approval.approvedAt?.toISOString() ?? null,
            appliedAt: approval.appliedAt?.toISOString() ?? null,
          }
        : null,
      items: plan.items.map((item) => ({
        itemId: item.id,
        kind: item.kind,
        result: item.result,
        previousDateTo: item.previousDateTo,
        orderId: item.sourceRequestId ?? item.createdRequestId,
      })),
      reset: rows.length,
    },
  });

  return { weeklyRequestId: plan.header.id, status: 'pending', ...effects };
}

/**
 * The return command (ADR 0219): `waybills.correct` in both branches (survey 06.10.2026, R3), so
 * the site scope is never asked — the right has none.
 */
export const WEEKLY_RETURN_SPEC: WeeklyReversalSpec = {
  door: 'weekly_return',
  kind: 'weekly_return',
  auditAction: 'weekly_request.return',
  canRun: (subject) => canReturnWeeklyRequest(subject),
  needsSiteScope: () => false,
  rightRefusal: () =>
    'Вернуть применённую неделю на согласование может диспетчер или администратор',
  scopeRefusal: '',
  headerBlocker: weeklyReturnHeaderBlocker,
  refusalLead: 'Вернуть неделю на согласование нельзя',
  nothingToReverse: 'Возвращать нечего: ни одна строка этой недели не применилась',
  correctionRequired: WEEKLY_RETURN_CORRECTION_REQUIRED_MESSAGE,
  apply: applyWeeklyReturn,
};
