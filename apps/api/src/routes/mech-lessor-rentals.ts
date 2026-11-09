import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, count, eq } from 'drizzle-orm';
import {
  isMechLessorRentalVisible,
  isMechLessorSubject,
  type ListResult,
  type MechLessorRentalDto,
  mechLessorRentalListQuerySchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { constructionObjects, mechModels, mechRequests } from '../db/schema';
import { err } from '../lib/errors';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import {
  lessorReceiptWhere,
  mechLessorRentalVisibleWhere,
  mechPeriodWhere,
} from '../services/mech-request-list';
import { loadMechLessorReceiptsByRequestIds } from '../services/mech-lessor-receipt';
import { mechLessorRentalQuery, toMechLessorRentalDto } from '../services/mech-lessor-rentals';

/*
 * The mechanization lessor's two read doors (lessor receipt plan, P12): his rentals «В работе» and
 * one of them. Registered on the mechanization instance, so the module's door guard runs first;
 * both are marked `mechLessorDoor`, the guard lets the lessor through, and the route's permission
 * guard then asks `mechRequests.read`.
 *
 * Only a mechanization lessor passes the handler: the office has the full list and card, and an
 * office reply in the lessor's shape would be a second card with its own rules. Visibility is the
 * one predicate (`isMechLessorRentalVisible` and its SQL twin): his counterparty, «В работе», not
 * archived. A foreign or closed rental is 404 — which request ids exist is not his business.
 */

const idParams = z.object({ id: z.string().uuid() });

/** The 403 of an office account at the lessor's doors: the reply would be the lessor's shape. */
export const MECH_LESSOR_RENTALS_ONLY_MESSAGE =
  'Список аренд арендодателя открыт только учётке арендодателя механизации';

function assertMechLessor(p: Principal): void {
  if (!isMechLessorSubject(p)) throw err.forbidden(MECH_LESSOR_RENTALS_ONLY_MESSAGE);
}

const sortColumns = { plannedTo: mechRequests.plannedTo };

export async function registerMechLessorRentalRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const lessorDoor = {
    preHandler: [app.authenticate, app.requirePermission('mechRequests.read')],
    config: { mechLessorDoor: true },
  };

  r.get(
    '/lessor-rentals',
    { ...lessorDoor, schema: { querystring: mechLessorRentalListQuerySchema } },
    async (req): Promise<ListResult<MechLessorRentalDto>> => {
      const p = requirePrincipal(req);
      assertMechLessor(p);
      const q = req.query;
      const where = and(
        mechLessorRentalVisibleWhere(p),
        mechPeriodWhere(q),
        lessorReceiptWhere(q.lessorReceipt),
        // Only what the lessor's card shows (see the query schema).
        searchCondition(q.search, [
          mechModels.name,
          constructionObjects.name,
          constructionObjects.address,
          mechRequests.responsibleName,
        ]),
      );
      const page = pageParams(q);
      const rows = await mechLessorRentalQuery(db)
        .where(where)
        // `num + id` complete the order: a sort by a non-unique column alone would shuffle rows
        // with the same return date between pages.
        .orderBy(
          orderByFrom(sortColumns, q.sortBy, q.sortOrder, 'plannedTo'),
          asc(mechRequests.num),
          asc(mechRequests.id),
        )
        .limit(page.limit)
        .offset(page.offset);
      const [totalRow] = await db
        .select({ c: count() })
        .from(mechRequests)
        .innerJoin(constructionObjects, eq(mechRequests.objectId, constructionObjects.id))
        .leftJoin(mechModels, eq(mechRequests.mechModelId, mechModels.id))
        .where(where);
      const versions = await loadMechLessorReceiptsByRequestIds(
        db,
        rows.map((row) => row.id),
      );
      return {
        items: rows.map((row) => toMechLessorRentalDto(p, row, versions.get(row.id) ?? [])),
        total: Number(totalRow!.c),
        page: page.page,
        pageSize: page.pageSize,
      };
    },
  );

  r.get(
    '/lessor-rentals/:id',
    { ...lessorDoor, schema: { params: idParams } },
    async (req): Promise<MechLessorRentalDto> => {
      const p = requirePrincipal(req);
      assertMechLessor(p);
      const [row] = await mechLessorRentalQuery(db).where(eq(mechRequests.id, req.params.id));
      // The predicate itself, not its SQL twin: the list asks the twin, the card the predicate,
      // and the scope suite pins the two against each other.
      if (
        !row ||
        !isMechLessorRentalVisible(p, {
          lessorId: row.lessorId,
          status: row.status,
          deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
        })
      ) {
        throw err.notFound('Заявка не найдена');
      }
      const versions = await loadMechLessorReceiptsByRequestIds(db, [row.id]);
      return toMechLessorRentalDto(p, row, versions.get(row.id) ?? []);
    },
  );
}
