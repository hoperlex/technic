import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  dayBatchApplySchema,
  uuidSchema,
  type VehicleRequestDayBatchResultDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import { vehicleRequestAssignments, vehicleRequests, vehicles } from '../db/schema';
import { assertArchiveVisible, assertLessorScope, assertRequestScope } from '../lib/access';
import { err } from '../lib/errors';
import { runVehicleRequestDayBatch } from '../services/vehicle-request-day-batch';

/**
 * The day batch of a special-equipment request on a site — `POST /vehicle-requests/:id/days/batch`
 * ([ADR 0207](../../../../docs/adr/0207-vehicle-request-day-batch.md)).
 *
 * WHY A SEPARATE ROUTE MODULE. By the same device that keeps the assignment-history doors and the
 * term edit standing beside it: `vehicle-requests.ts` is a barrier file that several doors want at
 * once, and doors appended to it conflict in any order of work. The prefix is the same —
 * `/api/v1/vehicle-requests`: the portal's addresses do not change because of the split, and the
 * batch stands exactly where the per-day door stands (`/:id/days/:date/route`).
 *
 * ONE DOOR, CALLED FROM TWO PLACES (ADR 0207 §4): the "and issue the waybills" checkbox in the
 * window that takes a request into work, and the button in the request card — for an extended term
 * and for picking up what was missed. On the route's side there is no such door and there will not
 * be: a route does not know the request's term.
 *
 * THE RIGHTS ARE THE SAME PAIR AS THE PER-DAY DOOR'S: `waybills.read` (the driver is visible in the
 * route) and `vehicleRequests.status` (planning days is the progress of work on the request). The
 * batch deliberately has no third right: `waybills.correct` is asked not by the guard but by
 * `backdateGuard` inside — for EVERY day and against the shared date. Put it on the route, and a
 * batch over a future term, which needs no past at all, would become unavailable to everyone but
 * the correction roles; and a day deeper than the limit demands `waybills.correctBeyondLimit` on
 * top, which a guard reading the request body does not see at all.
 */

const idParams = z.object({ id: uuidSchema });

/**
 * The request is visible to this account and is run by it.
 *
 * The scope is asked BEFORE any work and by the same rules as the per-day door's: an object role
 * and a department role work with their own, a lessor with its own vehicles. This is not carried
 * inside the batch: day transactions are already running there, and a refusal by scope would mean
 * locks taken and released at once — and that in the middle of issued paper.
 *
 * `assertObjectRoleEditable` is absent here, and that is not an omission: a site role edits a
 * request only while it is new, whereas the batch works on a request IN WORK — `linearDaysBlocker`
 * will not let it any further anyway, and a second refusal would say the same thing in different
 * words.
 */
async function assertBatchAllowed(p: Principal, requestId: string): Promise<void> {
  const [row] = await db
    .select({
      objectId: vehicleRequests.objectId,
      departmentId: vehicleRequests.departmentId,
      deletedAt: vehicleRequests.deletedAt,
      lessorId: vehicles.lessorId,
    })
    .from(vehicleRequests)
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .leftJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .where(eq(vehicleRequests.id, requestId));
  if (!row) throw err.notFound('Заявка не найдена');
  assertArchiveVisible(p, row.deletedAt, 'Заявка не найдена');
  assertRequestScope(p, row);
  // A lessor runs its own requests (ADR 0038), but somebody else's fleet and its drivers are not
  // its business: the days of a request are filled with vehicles and people of the own fleet.
  assertLessorScope(p, row.lessorId);
}

export default async function vehicleRequestDayBatchRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Issue a 4-П for the whole term of the request: day after day — a route of the assigned vehicle
   * and, if asked, a waybill on it.
   *
   * Answers 200 with a PER-DAY REPORT even when part of the days did not pass: the batch does
   * everything it can and tells what it could not (ADR 0207 §7). The route refuses only with what
   * concerns the whole batch and is known before the first write: the request has no days at all
   * (422 with the text of `linearDaysBlocker`), there is no reason for past days, or no operation
   * key for them. The length of the term is never a refusal: beyond the limit the batch takes a
   * portion and names the remainder in the response (`remaining`), which is picked up by clicking
   * again — decision 11 of ADR 0207.
   *
   * A retry with the same operation key and the same body continues the work: a day already placed
   * is cut off by `assertDayPlannable` and leaves as a skip in the report, and a route already
   * frozen by a waybill — by `isRouteEditable`. The unique indexes behind both (the day's own and
   * `waybills_route_unique`) are the last line against a race, and a breach of either becomes a
   * failure row, not a skip: naming them as the cause sends the reader past the real check. A retry
   * with a different body runs into the operation check — and so it must: the key answers only
   * "a retry?".
   */
  r.post(
    '/:id/days/batch',
    {
      preHandler: [
        app.authenticate,
        app.requirePermission('waybills.read'),
        app.requirePermission('vehicleRequests.status', 'Недостаточно прав для смены статуса'),
      ],
      schema: { params: idParams, body: dayBatchApplySchema },
    },
    async (req): Promise<VehicleRequestDayBatchResultDto> => {
      const p = requirePrincipal(req);
      await assertBatchAllowed(p, req.params.id);
      return runVehicleRequestDayBatch({
        requestId: req.params.id,
        actor: p,
        input: req.body,
      });
    },
  );
}
