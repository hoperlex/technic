import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  canSetWorkingSunday,
  dateOnlySchema,
  moscowDateKeyOf,
  termSundays,
  uuidSchema,
  workingDaySetSchema,
  workingSundayBlocker,
  type RequestStatus,
  type VehicleRequestType,
  type VehicleRequestWorkingDaysDto,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import type { Principal } from '../auth/principal';
import { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicleRequestWorkingDays,
  vehicles,
} from '../db/schema';
import { assertArchiveVisible, assertLessorScope, assertRequestScope } from '../lib/access';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { changeSet, dateKeyRu, EMPTY } from '../services/request-diff';

/**
 * Working Sundays of a vehicle request (ADR 0246, plan docs/rest-days-plan.md D2).
 *
 * The card lists the Sundays of the term and a switch on each; the switch sets or removes the mark
 * that makes that Sunday a working day of the request (`vehicle_request_working_days`). Who may and
 * when is the contracts' rule (`canSetWorkingSunday`, `workingSundayBlocker`); this file adds the
 * request's visibility — object or department scope, the lessor's own requests — and reads the
 * status and the term under the request lock, so a mark is never written against a term or a state
 * that changed meanwhile. The door touches no route, so the request row is its only lock (the
 * canonical order takes routes first only where routes are touched).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: uuidSchema });
const dayParams = z.object({ id: uuidSchema, date: dateOnlySchema });

const NOT_FOUND = 'Заявка не найдена';

interface Target {
  id: string;
  status: RequestStatus;
  requestType: VehicleRequestType;
  term: { dateFrom: string; dateTo: string } | null;
}

/** The request with what its visibility is decided by; `tx` given — the request row is locked. */
async function loadTarget(p: Principal, requestId: string, tx?: Tx): Promise<Target> {
  const query = (tx ?? db)
    .select({
      id: vehicleRequests.id,
      objectId: vehicleRequests.objectId,
      departmentId: vehicleRequests.departmentId,
      status: vehicleRequests.status,
      requestType: vehicleRequests.requestType,
      deletedAt: vehicleRequests.deletedAt,
      lessorId: vehicles.lessorId,
      dateFrom: specialEquipmentRequestDetails.dateFrom,
      dateTo: specialEquipmentRequestDetails.dateTo,
    })
    .from(vehicleRequests)
    .leftJoin(
      vehicleRequestAssignments,
      eq(vehicleRequestAssignments.requestId, vehicleRequests.id),
    )
    .leftJoin(vehicles, eq(vehicles.id, vehicleRequestAssignments.vehicleId))
    .leftJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .where(eq(vehicleRequests.id, requestId));
  const [row] = tx ? await query.for('update', { of: vehicleRequests }) : await query;
  if (!row) throw err.notFound(NOT_FOUND);
  if (tx && row.deletedAt) throw err.notFound(NOT_FOUND);
  assertArchiveVisible(p, row.deletedAt, NOT_FOUND);
  assertRequestScope(p, row);
  assertLessorScope(p, row.lessorId);
  return {
    id: row.id,
    status: row.status,
    requestType: row.requestType,
    // The effective term: a one-day request ends on its first day (`date_to` empty).
    term: row.dateFrom ? { dateFrom: row.dateFrom, dateTo: row.dateTo ?? row.dateFrom } : null,
  };
}

async function workingDaysOf(target: Target, reader: Tx | typeof db = db) {
  const today = moscowDateKeyOf(new Date());
  const marks = await reader
    .select({ date: vehicleRequestWorkingDays.workDate })
    .from(vehicleRequestWorkingDays)
    .where(eq(vehicleRequestWorkingDays.requestId, target.id))
    .orderBy(asc(vehicleRequestWorkingDays.workDate));
  const marked = new Set(marks.map((m) => m.date));
  const dto: VehicleRequestWorkingDaysDto = {
    today,
    sundays: target.term
      ? termSundays(target.term).map((date) => ({
          date,
          working: marked.has(date),
          blocker: workingSundayBlocker({
            date,
            today,
            term: target.term!,
            status: target.status,
            requestType: target.requestType,
          }),
        }))
      : [],
  };
  return dto;
}

export default async function vehicleRequestWorkingDayRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: [app.authenticate, app.requirePermission('vehicleRequests.read')] };
  // Setting a working Sunday is assigning the work (D2): the permission of the status corridor.
  const write = {
    preHandler: [
      app.authenticate,
      app.requirePermission(
        'vehicleRequests.status',
        'Рабочую смену отмечает тот, кто назначает технику',
      ),
    ],
  };

  r.get('/:id/working-days', { ...read, schema: { params: idParams } }, async (req) => {
    const p = requirePrincipal(req);
    return workingDaysOf(await loadTarget(p, req.params.id));
  });

  /**
   * Sets or removes the mark of one Sunday. A repeat is a no-op and writes no history: the mark is
   * a state, and «отметили дважды» is not an event.
   */
  r.put(
    '/:id/working-days/:date',
    { ...write, schema: { params: dayParams, body: workingDaySetSchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const { date } = req.params;
      const { working } = req.body;
      if (!canSetWorkingSunday(p))
        throw err.forbidden('Рабочую смену отмечает тот, кто назначает технику');
      const outcome = await db.transaction(async (tx) => {
        const target = await loadTarget(p, req.params.id, tx);
        const blocker = target.term
          ? workingSundayBlocker({
              date,
              today: moscowDateKeyOf(new Date()),
              term: target.term,
              status: target.status,
              requestType: target.requestType,
            })
          : 'У заявки нет срока работ';
        if (blocker) throw err.unprocessable(blocker);
        const changed = working
          ? await tx
              .insert(vehicleRequestWorkingDays)
              .values({ requestId: target.id, workDate: date, setBy: p.id })
              .onConflictDoNothing()
              .returning({ date: vehicleRequestWorkingDays.workDate })
          : await tx
              .delete(vehicleRequestWorkingDays)
              .where(
                and(
                  eq(vehicleRequestWorkingDays.requestId, target.id),
                  eq(vehicleRequestWorkingDays.workDate, date),
                ),
              )
              .returning({ date: vehicleRequestWorkingDays.workDate });
        return { target, changed: changed.length > 0 };
      });
      if (outcome.changed) {
        const diff = changeSet();
        diff.changed(
          'workingDay',
          working ? EMPTY : dateKeyRu(date),
          working ? dateKeyRu(date) : EMPTY,
        );
        await writeAudit({
          actorUserId: p.id,
          action: working
            ? 'vehicle_request.working_day_set'
            : 'vehicle_request.working_day_remove',
          entityType: 'vehicle_request',
          entityId: outcome.target.id,
          metadata: { changes: diff.changes, workDate: date },
        });
      }
      return workingDaysOf(outcome.target);
    },
  );
}
