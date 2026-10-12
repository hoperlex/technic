import { and, eq } from 'drizzle-orm';
import type { MechExtensionDropReason } from '@technic/contracts';
import { mechRequestExtensions } from '../db/schema';
import { writeAuditTx } from '../lib/audit';
import type { MechTx } from './mech-request-dto';
import { mechExtendDropChanges } from './mech-request-diff';

// The extension request row of a rental (ADR 0171, stage 3). Read and written only under the lock
// of its request (`lockMechRequest` first): every path — the three extension routes and the two
// automatic drops — takes the locks in the order "request → extension", so a decision and a drop
// cannot deadlock on each other, and the parent's version stays the single etag of the card.

export type MechExtensionRow = typeof mechRequestExtensions.$inferSelect;

/** The current extension row of a request; the caller already holds the request's lock. */
export async function loadMechExtension(
  tx: MechTx,
  requestId: string,
): Promise<MechExtensionRow | undefined> {
  const [row] = await tx
    .select()
    .from(mechRequestExtensions)
    .where(eq(mechRequestExtensions.requestId, requestId));
  return row;
}

/**
 * Drops the pending request of a rental, if there is one, and writes `mech_request.extend_drop` in
 * the same transaction. Returns whether something was dropped.
 *
 * Called when the request is withdrawn and when the rental ends under it — completion and the
 * revoked issue mark. Without the automatic drop the card of a closed rental would show "waiting
 * for your visa" forever, and the visa would answer with a refusal to the very button it drew.
 * Decided rows are not touched: they are the last answer, and the next request overwrites them.
 *
 * The event is strict (`writeAuditTx`): after the delete nothing but this record remembers that the
 * request existed and why it went away. The parent's version is bumped by the caller — the drop is
 * always a part of a mutation that bumps it anyway.
 */
export async function dropPendingMechExtension(
  tx: MechTx,
  actorUserId: string,
  requestId: string,
  reason: MechExtensionDropReason,
): Promise<boolean> {
  const dropped = await tx
    .delete(mechRequestExtensions)
    .where(
      and(
        eq(mechRequestExtensions.requestId, requestId),
        eq(mechRequestExtensions.status, 'pending'),
      ),
    )
    .returning({ requestId: mechRequestExtensions.requestId });
  if (dropped.length === 0) return false;
  await writeAuditTx(tx, {
    actorUserId,
    action: 'mech_request.extend_drop',
    entityType: 'mech_request',
    entityId: requestId,
    metadata: { reason, changes: mechExtendDropChanges(reason) },
  });
  return true;
}
