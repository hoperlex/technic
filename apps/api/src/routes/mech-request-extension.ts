import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  canApproveMechExtension,
  decideMechExtensionSchema,
  MECH_EXTEND_NOT_LATER_MESSAGE,
  MECH_EXTENSION_NOT_PENDING_MESSAGE,
  MECH_EXTENSION_SCOPE_MESSAGE,
  mechExtensionApprovalBlocker,
  mechExtensionRequestBlocker,
  type MechRequestDto,
  requestMechExtensionSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { mechRequestExtensions, mechRequests } from '../db/schema';
import { err } from '../lib/errors';
import { writeAuditTx } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { loadMechRequestDto, type MechTx } from '../services/mech-request-dto';
import {
  assertMechRequestLive,
  assertMechRequestOpenable,
  lockMechRequest,
  type LockedMechRequest,
} from '../services/mech-request-guards';
import { dropPendingMechExtension, loadMechExtension } from '../services/mech-request-extension';
import {
  mechExtendApprovalChanges,
  mechExtendChanges,
  mechExtendRejectChanges,
} from '../services/mech-request-diff';

/*
 * The extension visa of a running rental (ADR 0171, stage 3; plan
 * `docs/mechanization-approval-and-grants-plan.md`, R10, R12): the office asks, the site's visa
 * holder decides, and the return date moves in the same transaction as the approval.
 *
 * Three doors, one protocol — the module's R21: transaction → `FOR UPDATE` of the request first
 * (`lockMechRequest`) → existence, archive and scope (`assertMechRequestOpenable`) → the client's
 * version BEFORE the subject checks (409 "reread" stays distinct from 422 "the rule forbids") → the
 * extension row read and written under the request's lock → CAS on the request with `version + 1`.
 * Every door bumps the request's version even when only `updated_at` changes in it: the card shows
 * the extension, and a CAS on the child table without its own version does not exist — the
 * request's version is the one etag of the whole card.
 *
 * The old `PATCH /:id/extend` (immediate, no visa) lives on in `mech-requests.ts` only for tabs of
 * bundles with contract 6 or older; release R2 removes it under client floor 7 (ADR 0226, S-21).
 */

const idParams = z.object({ id: z.string().uuid() });

/** A `DELETE` carries no body, so the client's version comes in the query, as with deletion. */
const versionQuery = z.object({ version: z.coerce.number().int().nonnegative() });

/** CAS on the request: the version was matched under the lock, and only it is bumped here. */
async function bumpRequest(
  tx: MechTx,
  p: Principal,
  row: LockedMechRequest,
  version: number,
  plannedTo?: string,
): Promise<void> {
  const [updated] = await tx
    .update(mechRequests)
    .set({
      ...(plannedTo ? { plannedTo } : {}),
      updatedBy: p.id,
      version: row.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(mechRequests.id, row.id), eq(mechRequests.version, version)))
    .returning({ id: mechRequests.id });
  if (!updated) throw err.conflict();
}

export async function registerMechExtensionRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // Asking and withdrawing are the dispatcher's (`.extend`): he calls the lessor and agrees to pay
  // further. Deciding is the visa holder's (`.approve`) — the permission does not move to the site,
  // the site signs the agreement instead of making it (R10).
  const canExtend = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'mechRequests.extend',
        'Недостаточно прав для запроса продления аренды',
      ),
    ],
  };
  const canApprove = {
    preHandler: [
      app.authenticate,
      app.requirePermission('mechRequests.approve', 'Недостаточно прав для визирования продления'),
    ],
  };

  /**
   * Request an extension, or change the pending one: a repeated request overwrites the row, whatever
   * it held (pending, approved, rejected), and the chain stays in the history. The snapshot of the
   * current return date is what the approval later compares with.
   */
  r.post(
    '/:id/extension',
    { ...canExtend, schema: { params: idParams, body: requestMechExtensionSchema } },
    async (req): Promise<MechRequestDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { plannedTo, reason, version } = req.body;
      return db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), version);
        assertMechRequestLive(row, 'запросить продление');
        const blocker = mechExtensionRequestBlocker(row, plannedTo);
        if (blocker) {
          throw err.unprocessable(
            blocker,
            blocker === MECH_EXTEND_NOT_LATER_MESSAGE
              ? { plannedTo: 'Позже прежней даты' }
              : undefined,
          );
        }
        const now = new Date();
        const values = {
          status: 'pending' as const,
          newPlannedTo: plannedTo,
          previousPlannedTo: row.plannedTo,
          reason,
          requestedBy: p.id,
          requestedAt: now,
          decidedBy: null,
          decidedAt: null,
          decisionComment: '',
          updatedAt: now,
        };
        await tx
          .insert(mechRequestExtensions)
          .values({ requestId: id, ...values })
          .onConflictDoUpdate({ target: mechRequestExtensions.requestId, set: values });
        await bumpRequest(tx, p, row, version);
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'mech_request.extend_request',
          entityType: 'mech_request',
          entityId: id,
          metadata: { changes: mechExtendChanges(row.plannedTo, plannedTo, reason) },
        });
        return (await loadMechRequestDto(tx, id))!;
      });
    },
  );

  /**
   * The visa holder's decision. The scope is checked after the module's scope, as in the request
   * visa: "another site" and "my site, but not mine to sign" are different answers. Approval
   * re-reads the rental under the lock — it must still run and still have the date the request was
   * filed against; the term moves in this same transaction, so "approved, term unchanged" never
   * exists. A refusal needs only a pending request and its reason (the schema requires it).
   *
   * The approval writes `mech_request.extend` — the event keeps its meaning "the term moved" and
   * its history kind `mechExtended`; old records do not change their meaning.
   */
  r.patch(
    '/:id/extension',
    { ...canApprove, schema: { params: idParams, body: decideMechExtensionSchema } },
    async (req): Promise<MechRequestDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { approved, comment, version } = req.body;
      return db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), version);
        assertMechRequestLive(row, 'решить продление');
        if (!canApproveMechExtension(p, row)) throw err.forbidden(MECH_EXTENSION_SCOPE_MESSAGE);
        const extension = await loadMechExtension(tx, id);
        if (!extension || extension.status !== 'pending') {
          throw err.unprocessable(MECH_EXTENSION_NOT_PENDING_MESSAGE);
        }
        if (approved) {
          const blocker = mechExtensionApprovalBlocker({ ...row, extension });
          if (blocker) throw err.unprocessable(blocker);
        }
        const now = new Date();
        await bumpRequest(tx, p, row, version, approved ? extension.newPlannedTo : undefined);
        await tx
          .update(mechRequestExtensions)
          .set({
            status: approved ? 'approved' : 'rejected',
            decidedBy: p.id,
            decidedAt: now,
            decisionComment: comment,
            updatedAt: now,
          })
          .where(eq(mechRequestExtensions.requestId, id));
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: approved ? 'mech_request.extend' : 'mech_request.extend_reject',
          entityType: 'mech_request',
          entityId: id,
          metadata: {
            changes: approved
              ? mechExtendApprovalChanges(
                  extension.previousPlannedTo,
                  extension.newPlannedTo,
                  extension.reason,
                  comment,
                )
              : mechExtendRejectChanges(comment),
          },
        });
        return (await loadMechRequestDto(tx, id))!;
      });
    },
  );

  /**
   * Withdraw the pending request. Any `.extend` holder may, not only its author: the dispatch office
   * keeps one queue, and a ban would leave a request hanging while its author is on leave or
   * blocked. A decided row is not deleted — it is the last answer, and only a new request replaces
   * it.
   */
  r.delete(
    '/:id/extension',
    { ...canExtend, schema: { params: idParams, querystring: versionQuery } },
    async (req): Promise<MechRequestDto> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { version } = req.query;
      return db.transaction(async (tx) => {
        const row = assertMechRequestOpenable(p, await lockMechRequest(tx, id), version);
        assertMechRequestLive(row, 'отозвать запрос продления');
        const dropped = await dropPendingMechExtension(tx, p.id, id, 'withdrawn');
        if (!dropped) throw err.unprocessable(MECH_EXTENSION_NOT_PENDING_MESSAGE);
        await bumpRequest(tx, p, row, version);
        return (await loadMechRequestDto(tx, id))!;
      });
    },
  );
}
