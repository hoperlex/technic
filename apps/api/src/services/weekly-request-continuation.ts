import { and, eq, isNull, sql } from 'drizzle-orm';
import { formatVehicleRequestNumber, vehicleStatusLabels } from '@technic/contracts';
import type { db } from '../db/client';
import {
  specialEquipmentRequestDetails,
  vehicleRequestAssignments,
  vehicleRequests,
  vehicleRequestStatusHistory,
  vehicles,
} from '../db/schema';
import { err } from '../lib/errors';
import type { AssignmentCommandTx } from './assignment-command';
import { historyIsAuthoritative, type AssignmentModeSnapshot } from './assignment-mode';
import { enterWorkWithHistory } from './assignment-work-entry';
import { createSpecialEquipmentRequest } from './vehicle-request-create';
import { syncLinearRouteDays } from './vehicle-request-days';
import { syncEsm2Waybills } from './waybill-esm2';

/**
 * The order a weekly visa opens for the part of a rental extension past the month border (ADR 0238).
 *
 * WHY THE VISA PUTS IT INTO WORK ITSELF. The month report takes a rental order as one piece, so the
 * extension of a rented vehicle does not cross the last day of the month. What lies beyond it is the
 * same rented vehicle for the same site on the same terms — the dispatcher has already agreed the
 * vehicle and the rates on the order being extended, and a visa extends an order without the
 * dispatcher in the same way (ADR 0085 item 9). A «Новая» order here would be a task "put the same
 * machine on it again" that nobody is asked a question by.
 *
 * WHAT IS COPIED. The site, the ordered position, the contact and the assignment: the vehicle and
 * the rates of the order being extended. Not copied: the delivery (the machine is already on the
 * site), the closing, the documents, the shifts. For a rental the only thing assigned on our side
 * is the lessor's vehicle, so there is no machinist and no paper of ours (`esm2Mode` is `none`).
 *
 * WHAT IF THE ASSIGNMENT CANNOT BE COPIED. The vehicle was written off or archived, or stopped
 * being a rental one, or the rates are gone. The order is still opened — as «Новая» with no vehicle
 * and a note in the visa result — instead of failing the whole week or silently losing the days
 * past the border. The dispatcher takes it into work the usual way.
 *
 * ONE TRANSACTION WITH THE VISA, in the order of the status door (`PATCH /:id/status`, `new` →
 * `confirmed`): assignment, status and its history row, history of the assignment or the weekly
 * sweep, the day plan. The door itself lives in a route handler, and only the steps a rental
 * needs are repeated here; the rule of what each step writes lives in the shared services.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface OpenedContinuation {
  requestId: string;
  num: number;
  /** Whether the vehicle of the extended order stands on the new one and it is «В работе». */
  assigned: boolean;
  /** Why the assignment was not copied; empty when it was. */
  note: string;
}

export interface OpenContinuationParams {
  /** The order being extended; locked `FOR UPDATE` by the caller. */
  sourceId: string;
  sourceNum: number;
  period: { dateFrom: string; dateTo: string };
  actor: { id: string };
  /** The moment of the visa: the new order is born approved by it (ADR 0085 item 5). */
  approvedAt: Date;
  /** "Today" of the visa — one value for the whole week, as the paper plans use it. */
  asOf: string;
  mode: AssignmentModeSnapshot;
  /** «Недельная заявка НЗ-12 (…)»: the base of every history comment the order gets. */
  reason: string;
  /**
   * The reason of the correction operation when the week is conducted overdue (ADR 0116): an order
   * born for past days is explained in its own history, as the order of a `new` row is.
   */
  correctionReason?: string;
}

/**
 * Why the assignment of `sourceId` cannot be copied to a new order; `null` — it can.
 *
 * Checks what `resolveAssignment` (the status door) checks for a rental, minus the rates being
 * typed: they are copied. A vehicle in service or written off «does not go out however many times
 * it is assigned», and a rental without any rate would leave the price to be found out later.
 */
function assignmentBlocker(
  vehicle: { status: keyof typeof vehicleStatusLabels; deletedAt: Date | null; ownership: string },
  rates: { pricePerHour: string | null; pricePerShift: string | null },
): string | null {
  if (vehicle.deletedAt) return 'машина удалена из справочника';
  if (vehicle.status !== 'active') {
    return `машина недоступна: ${vehicleStatusLabels[vehicle.status].toLowerCase()}`;
  }
  if (vehicle.ownership !== 'rental') return 'машина больше не арендная';
  if (rates.pricePerHour == null && rates.pricePerShift == null) {
    return 'у заказа не осталось ставки аренды';
  }
  return null;
}

export async function openRentalContinuation(
  tx: Tx,
  params: OpenContinuationParams,
): Promise<OpenedContinuation> {
  const [source] = await tx
    .select({
      objectId: vehicleRequests.objectId,
      vehicleTypeId: vehicleRequests.vehicleTypeId,
      vehicleCategoryId: vehicleRequests.vehicleCategoryId,
      responsibleName: specialEquipmentRequestDetails.responsibleName,
      responsiblePhone: specialEquipmentRequestDetails.responsiblePhone,
    })
    .from(vehicleRequests)
    .innerJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequests.id),
    )
    .where(eq(vehicleRequests.id, params.sourceId));
  if (!source?.objectId) throw err.notFound('Заказ техники не найден');

  const sourceLabel = formatVehicleRequestNumber(params.sourceNum);
  const requestId = await createSpecialEquipmentRequest(tx, {
    objectId: source.objectId,
    vehicleTypeId: source.vehicleTypeId,
    vehicleCategoryId: source.vehicleCategoryId,
    dateFrom: params.period.dateFrom,
    dateTo: params.period.dateTo,
    responsibleName: source.responsibleName,
    responsiblePhone: source.responsiblePhone,
    comment: `Продолжение заказа ${sourceLabel}: аренда не идёт за границу месяца`,
    createdBy: params.actor.id,
    approvedBy: params.actor.id,
    approvedAt: params.approvedAt,
  });
  const [created] = await tx
    .select({ num: vehicleRequests.num })
    .from(vehicleRequests)
    .where(eq(vehicleRequests.id, requestId));
  if (!created) throw err.notFound('Заказ техники не найден');
  if (params.correctionReason) {
    // The same explanation the order of a `new` row gets: "created today for last week" is read
    // from nothing else (ADR 0101 item 8).
    await tx
      .update(vehicleRequestStatusHistory)
      .set({
        comment: `${params.reason}: заказ заведён задним числом — ${params.correctionReason}`,
      })
      .where(
        and(
          eq(vehicleRequestStatusHistory.vehicleRequestId, requestId),
          isNull(vehicleRequestStatusHistory.fromStatus),
        ),
      );
  }

  const [assignment] = await tx
    .select({
      vehicleId: vehicleRequestAssignments.vehicleId,
      pricePerHour: vehicleRequestAssignments.pricePerHour,
      pricePerShift: vehicleRequestAssignments.pricePerShift,
      shiftHours: vehicleRequestAssignments.shiftHours,
    })
    .from(vehicleRequestAssignments)
    .where(eq(vehicleRequestAssignments.requestId, params.sourceId));
  const [vehicle] = assignment
    ? await tx
        .select({
          typeId: vehicles.vehicleTypeId,
          status: vehicles.status,
          deletedAt: vehicles.deletedAt,
          ownership: vehicles.ownership,
        })
        .from(vehicles)
        .where(eq(vehicles.id, assignment.vehicleId))
    : [];
  const blocker =
    assignment && vehicle ? assignmentBlocker(vehicle, assignment) : 'машина не найдена';
  if (blocker !== null || !assignment || !vehicle) {
    return {
      requestId,
      num: created.num,
      assigned: false,
      note: `Машину заказа ${sourceLabel} на новый заказ не поставить: ${blocker} — назначьте её вручную`,
    };
  }

  const reason = `${params.reason}: продолжение заказа ${sourceLabel} за границей месяца`;
  await tx.insert(vehicleRequestAssignments).values({
    requestId,
    vehicleId: assignment.vehicleId,
    // The vehicle's own type and the ordered one are written apart (migration 0083, ADR 0059): the
    // first is the target of the vehicle FK, the second of the request FK.
    vehicleTypeId: vehicle.typeId,
    orderedVehicleTypeId: source.vehicleTypeId,
    pricePerHour: assignment.pricePerHour,
    pricePerShift: assignment.pricePerShift,
    shiftHours: assignment.shiftHours,
    assignedBy: params.actor.id,
  });
  const [updated] = await tx
    .update(vehicleRequests)
    .set({
      status: 'confirmed',
      updatedBy: params.actor.id,
      version: sql`${vehicleRequests.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(vehicleRequests.id, requestId), eq(vehicleRequests.status, 'new')))
    .returning({ id: vehicleRequests.id });
  // Born a moment ago inside this transaction: a mismatch is a programming error, not a race.
  if (!updated) throw err.conflict();
  await tx.insert(vehicleRequestStatusHistory).values({
    vehicleRequestId: requestId,
    fromStatus: 'new',
    toStatus: 'confirmed',
    changedBy: params.actor.id,
    comment: reason,
  });

  // The same two doors the status handler uses to take an order into work. For a rental both are
  // quiet on paper (`esm2Mode` is `none`): history is what they write.
  if (historyIsAuthoritative(params.mode)) {
    await enterWorkWithHistory(tx as AssignmentCommandTx, {
      requestId,
      actor: params.actor,
      asOf: params.asOf,
      mode: params.mode,
      driverPersonId: null,
      reason,
    });
  } else {
    await syncEsm2Waybills(tx, {
      requestId,
      actor: params.actor,
      reason,
      driverPersonId: null,
      asOf: params.asOf,
    });
  }
  await syncLinearRouteDays(tx, { requestId, actor: params.actor, reason });

  return { requestId, num: created.num, assigned: true, note: '' };
}
