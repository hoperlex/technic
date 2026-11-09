import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  attachMechLessorReceiptSchema,
  decideMechLessorReceiptSchema,
  type MechLessorReceiptReplyDto,
  waiveMechLessorReceiptSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { requirePrincipal } from '../auth/plugin';
import {
  attachMechLessorReceipt,
  decideMechLessorReceipt,
  waiveMechLessorReceipt,
} from '../services/mech-lessor-receipt';

/*
 * The lessor's receipt of a rental (plan `docs/mechanization-lessor-receipt-plan.md`, P5–P7): three
 * doors, registered on the mechanization routes' own Fastify instance next to the extension doors,
 * so whatever guards that instance — the lessor guard of P11 among them — covers them too.
 *
 * Attaching is `mechRequests.lessorReceipt` (the office, and the lessor from his own account);
 * deciding and the «без чека» visa are `mechRequests.approve` plus the request visa circle, asked of
 * the locked row in the service. The doors reply `{ version, lessorReceipt }` for the caller's
 * audience, not the whole request: the reply then needs no request-level audience switch, and the
 * portal invalidates its queries.
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * A mechanization door open to a mechanization lessor (plan P11). The module refuses
     * counterparty-scoped principals by default; only a route marked here lets the lessor through —
     * a route added tomorrow stays closed to him unless someone marks it. Read by the module's
     * `preValidation` guard.
     */
    mechLessorDoor?: boolean;
  }
}

const idParams = z.object({ id: z.string().uuid() });

export async function registerMechLessorReceiptRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canAttach = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'mechRequests.lessorReceipt',
        'Недостаточно прав, чтобы прикрепить чек арендодателя',
      ),
    ],
  };
  // The visa permission only; "is it this rental's visa holder" is a question of the row
  // (`canApproveMechRequest`), answered in the service after the version check.
  const canDecide = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'mechRequests.approve',
        'Недостаточно прав для визирования чека арендодателя',
      ),
    ],
  };

  /** Attach a receipt, or replace the current version (P7). The lessor's one write door. */
  r.post(
    '/:id/lessor-receipt',
    {
      ...canAttach,
      config: { mechLessorDoor: true },
      schema: { params: idParams, body: attachMechLessorReceiptSchema },
    },
    async (req): Promise<MechLessorReceiptReplyDto> => {
      const p = requirePrincipal(req);
      return db.transaction((tx) => attachMechLessorReceipt(tx, p, req.params.id, req.body));
    },
  );

  /** Approve, reject or revoke the version the holder saw (P5). */
  r.patch(
    '/:id/lessor-receipt',
    { ...canDecide, schema: { params: idParams, body: decideMechLessorReceiptSchema } },
    async (req): Promise<MechLessorReceiptReplyDto> => {
      const p = requirePrincipal(req);
      return db.transaction((tx) => decideMechLessorReceipt(tx, p, req.params.id, req.body));
    },
  );

  /** The «без чека» visa (P6, O10). */
  r.post(
    '/:id/lessor-receipt/waiver',
    { ...canDecide, schema: { params: idParams, body: waiveMechLessorReceiptSchema } },
    async (req): Promise<MechLessorReceiptReplyDto> => {
      const p = requirePrincipal(req);
      return db.transaction((tx) => waiveMechLessorReceipt(tx, p, req.params.id, req.body));
    },
  );
}
