import { eq, inArray } from 'drizzle-orm';
import {
  approvedShiftsBlocker,
  formatVehicleRouteNumber,
  isRouteEditable,
  requestStatusLabels,
  ROLLBACK_WAYBILL_MESSAGE,
  shouldDetachOnStatus,
  type RequestStatus,
  type VehicleRequestDto,
  type VehicleRequestRollbackBlockerDto,
  type VehicleRequestRollbackPreviewDto,
} from '@technic/contracts';
import type { db } from '../db/client';
import { vehicleRequests, vehicleRoutes } from '../db/schema';
import { fingerprintOf } from './assignment-crew';
import { pendingEarlyEndOf } from './vehicle-request-period';
import { requestShiftRows } from './vehicle-request-shifts';
import {
  activeWaybillOfRequest,
  bumpRouteVersion,
  detachRequest,
  dropRelocations,
  planRelocationDrop,
  type PlannedRelocation,
  routesOfRequest,
  routeWaybill,
} from './vehicle-routes';
import { buildEsm2SyncPlan, esm2SheetPreviews } from './waybill-esm2';

/*
 * The rollback plan (ADR 0211): what returning a request from «В работе» to «Новая» erases, as
 * one value that both the preview and the status door get from the same builder.
 *
 * WHY A PLAN AND NOT A LIST IN THE PORTAL. The portal used to assemble «what the rollback erases»
 * from the request DTO (`rollbackErases`), i.e. a second carrier of a rule the server executes. It
 * drifted exactly the way AGENTS.md warns about: it kept silent about days in routes, shift drafts,
 * the pending early-end request and ESM-2 sheets, and promised to drop every relocation while one
 * with a waybill stays. The fix is not a better list but one builder: every consequence here is
 * decided by the function the door runs, read before any write.
 *
 * WHAT IS SHARED AND HOW. Places in routes and relocations — the door executes this very plan
 * (`applyStatusDetach`). Shifts, the early-end request, assignment and completion — the door deletes
 * them by request id, and the plan reads the same rows by the same key under the same locks.
 * ESM-2 — the plan asks the sweep's own builder with the status the door is about to write
 * (`assumeStatus`), and the door runs the sweep after writing it: same builder, same status, same
 * day (`asOf`), and nothing between the two touches the request's sheets. The one input that does
 * differ — the vehicle, gone with the deleted assignment — cannot change the outcome: under «Новая»
 * the mode is `none`, no week is wanted, and every sheet whose week is not over is cancelled
 * whatever the vehicle (`esm2SyncPlan`). Should the sweep ever start to care, the db-test comparing
 * preview and fact (`vehicle-request-rollback-preview.db.test.ts`) is what turns red.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The status the rollback writes. A constant, not a parameter: the plan describes one transition
 * (`transitionResetsWork`), and «a rollback plan for another target» would be a different plan.
 */
const ROLLBACK_TARGET: RequestStatus = 'new';

/** A place of the request in a route, with what the audit event and the preview need. */
export interface PlannedSeat {
  routeId: string;
  routeNumber: string;
  /** Work day of the row; `null` — a freight seat, whose day is the route's own. */
  workDate: string | null;
  /** Work day or, for a freight seat, the route date: the date the human knows the place by. */
  date: string;
}

/**
 * What a status change does to the request's routes: places to leave and relocations to delete.
 *
 * Shared by cancellation and the rollback: both take the request out of every route not frozen by
 * an active waybill and drop relocations without a waybill. The rollback adds the rest of the plan
 * on top; the cancellation executes just this part.
 */
export interface StatusDetachPlan {
  seats: { detach: PlannedSeat[]; frozen: PlannedSeat[] };
  relocations: { drop: PlannedRelocation[]; keep: PlannedRelocation[] };
}

const NO_DETACH: StatusDetachPlan = {
  seats: { detach: [], frozen: [] },
  relocations: { drop: [], keep: [] },
};

/**
 * Plan the detachment for a request leaving «В работе» to `next`.
 *
 * Decided by the same rules the door always used: `shouldDetachOnStatus` over the route's waybill
 * (`routeWaybill`, `isRouteEditable`) for places, `planRelocationDrop` for relocations. A frozen
 * place is listed only when it would have left otherwise — «stays because of the waybill» is the
 * one thing worth saying about it; under «Выполнена» nothing leaves and nothing is listed.
 *
 * Places are ordered by route id, the lock order of the module (Р17): the door detaches in this
 * order, as it did before the plan existed.
 */
export async function planStatusDetach(
  tx: Tx,
  requestId: string,
  next: RequestStatus,
): Promise<StatusDetachPlan> {
  const relocations =
    next === 'cancelled' || next === 'new'
      ? await planRelocationDrop(tx, requestId)
      : { drop: [], keep: [] };

  const rows = [...(await routesOfRequest(tx, requestId))].sort((a, b) =>
    a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0,
  );
  const decided: { routeId: string; workDate: string | null; detach: boolean }[] = [];
  for (const row of rows) {
    const waybill = await routeWaybill(tx, row.routeId);
    const frozen = !isRouteEditable(waybill?.status ?? null);
    if (shouldDetachOnStatus(next, frozen)) {
      decided.push({ routeId: row.routeId, workDate: row.workDate, detach: true });
    } else if (frozen && shouldDetachOnStatus(next, false)) {
      decided.push({ routeId: row.routeId, workDate: row.workDate, detach: false });
    }
  }
  if (decided.length === 0 && relocations.drop.length === 0 && relocations.keep.length === 0) {
    return NO_DETACH;
  }

  const routes = new Map(
    decided.length === 0
      ? []
      : (
          await tx
            .select({
              id: vehicleRoutes.id,
              num: vehicleRoutes.num,
              routeDate: vehicleRoutes.routeDate,
            })
            .from(vehicleRoutes)
            .where(
              inArray(
                vehicleRoutes.id,
                decided.map((item) => item.routeId),
              ),
            )
        ).map((route) => [route.id, route]),
  );
  const seatOf = (item: (typeof decided)[number]): PlannedSeat => {
    const route = routes.get(item.routeId)!;
    return {
      routeId: item.routeId,
      routeNumber: formatVehicleRouteNumber(route.num),
      workDate: item.workDate,
      date: item.workDate ?? route.routeDate,
    };
  };
  return {
    seats: {
      detach: decided.filter((item) => item.detach).map(seatOf),
      frozen: decided.filter((item) => !item.detach).map(seatOf),
    },
    relocations,
  };
}

/**
 * Execute the detachment plan: relocations first, then places — the order the door always had.
 *
 * Precondition, not a check: the caller holds every route of the request and then the request row
 * (`lockRequestRoutes`, `lockRequestRow`) in this transaction. The locked request row freezes the
 * set of its routes, so the plan read after the locks is exactly what gets executed.
 *
 * The route version is bumped even when the row was already gone: that is how the door behaved
 * before the plan, and the bump is what tells an open route card that its composition was touched.
 */
export async function applyStatusDetach(
  tx: Tx,
  requestId: string,
  plan: StatusDetachPlan,
  actorId: string,
): Promise<{ droppedRelocations: string[]; detachedDays: string[] }> {
  const droppedRelocations = await dropRelocations(tx, plan.relocations.drop);
  const detachedDays: string[] = [];
  for (const seat of plan.seats.detach) {
    const removed = await detachRequest(tx, seat.routeId, requestId);
    await bumpRouteVersion(tx, seat.routeId, actorId);
    if (removed?.workDate) detachedDays.push(removed.workDate);
  }
  return { droppedRelocations, detachedDays };
}

// ── The rollback plan ──

export interface VehicleRequestRollbackPlan {
  requestId: string;
  /**
   * Refusals the door would give right now — full texts, the ones the door throws. Kept in the plan
   * so the preview and the refusal cannot word the same obstacle differently.
   */
  blockers: {
    /** 422 in the door: days approved by the site are the work of exactly this vehicle. */
    approvedShifts: string | null;
    /** Display number of an active route waybill holding the request; 409 in the door. */
    activeWaybill: string | null;
  };
  assignment: boolean;
  completion: boolean;
  detach: StatusDetachPlan;
  shifts: { date: string; approved: boolean }[];
  earlyEnd: { newDateTo: string } | null;
  /** Sheet ids: `cancel` — the sweep cancels them; `keep` — active and untouched (week is over). */
  esm2: { cancel: string[]; keep: string[] };
  dropsLinearFreeze: boolean;
}

/**
 * The approved-shifts refusal of the rollback, worded once for the door and the preview.
 *
 * Asked from the request DTO on purpose, the same input the door has always used before its
 * transaction (`approvedShiftsBlocker` counts approved days inside the current term): a second
 * reading from the table would count out-of-term rows too and refuse where the door lets through.
 */
export function rollbackShiftsBlocker(request: VehicleRequestDto): string | null {
  const approved = approvedShiftsBlocker(request);
  if (!approved) return null;
  return `${approved}: возврат в «${requestStatusLabels.new}» снимает технику, а согласованные дни — это работа именно её`;
}

/** The active-waybill refusal of the rollback — the text the door answers 409 with. */
export function rollbackWaybillBlocker(displayNumber: string): string {
  return `${ROLLBACK_WAYBILL_MESSAGE} (${displayNumber})`;
}

/**
 * Build the rollback plan for a request in «В работе». Reads only, writes nothing.
 *
 * `request` is the DTO read before the transaction — the door and the preview both have it, and
 * the door's `version` check in its `UPDATE` catches a DTO that went stale. Everything else is read
 * here, inside the caller's transaction: in the door that is after the route and request locks, in
 * the preview a read-only snapshot.
 *
 * `asOf` is the day of the computation, captured once by the caller (Р12): the sweep splits worked
 * weeks from the rest by it, and a midnight between the plan and the sweep would give the door
 * another set of sheets than the one shown.
 */
export async function buildRollbackPlan(
  tx: Tx,
  params: { request: VehicleRequestDto; asOf: string },
): Promise<VehicleRequestRollbackPlan> {
  const { request, asOf } = params;
  const requestId = request.id;

  const esm2 = await buildEsm2SyncPlan(tx, {
    requestId,
    asOf,
    assumeStatus: ROLLBACK_TARGET,
  });
  const cancel = esm2?.plan.cancel ?? [];
  // Trims cannot appear with an empty set of wanted weeks, but a sheet the sweep touches in any way
  // is not «kept as is», and the list must not claim otherwise if the sweep ever learns to.
  const touched = new Set([...cancel, ...(esm2?.plan.trim ?? []).map((item) => item.waybillId)]);
  const keep = (esm2?.input.existing ?? [])
    .map((sheet) => sheet.id)
    .filter((id) => !touched.has(id));

  const [row] = await tx
    .select({ isLinearFrozen: vehicleRequests.isLinearFrozen })
    .from(vehicleRequests)
    .where(eq(vehicleRequests.id, requestId));

  return {
    requestId,
    blockers: {
      approvedShifts: rollbackShiftsBlocker(request),
      activeWaybill: await activeWaybillOfRequest(tx, requestId),
    },
    assignment: request.assignment !== null,
    completion: request.completion !== null,
    detach: await planStatusDetach(tx, requestId, ROLLBACK_TARGET),
    shifts: await requestShiftRows(tx, requestId),
    earlyEnd: await pendingEarlyEndOf(tx, requestId),
    esm2: { cancel, keep },
    // The door drops the snapshot on any exit from «В работе»; the plan is built only for one.
    dropsLinearFreeze: (row?.isLinearFrozen ?? null) !== null,
  };
}

/**
 * Fingerprint of the consequences — content, not inputs.
 *
 * What the human confirms is «these places, these relocations, these sheets», so that is what is
 * hashed, with ids: a relocation that got a waybill between the preview and the click, a sheet
 * cancelled by its own handle, a new shift draft — each changes the plan and turns into 409. The
 * day of computation is not hashed by itself: a midnight that changes nothing in the consequences
 * is not a reason to ask again, and one that does (a week became worked) changes `esm2`.
 *
 * Blockers are left out: the door refuses on them before it ever compares fingerprints.
 */
export function rollbackPlanFingerprint(plan: VehicleRequestRollbackPlan): string {
  const seat = (item: PlannedSeat) => ({ routeId: item.routeId, workDate: item.workDate });
  return fingerprintOf({
    requestId: plan.requestId,
    assignment: plan.assignment,
    completion: plan.completion,
    seats: {
      detach: plan.detach.seats.detach.map(seat),
      frozen: plan.detach.seats.frozen.map(seat),
    },
    relocations: {
      drop: plan.detach.relocations.drop.map((item) => item.id),
      keep: plan.detach.relocations.keep.map((item) => item.id),
    },
    shifts: plan.shifts,
    earlyEnd: plan.earlyEnd,
    esm2: plan.esm2,
    dropsLinearFreeze: plan.dropsLinearFreeze,
  });
}

/**
 * The plan as the portal gets it. Sheet numbers only with `showSheetNumbers` (`waybills.read`):
 * the rollback right comes in grants without the waybill journal (ADR 0106), and counters answer
 * «will paper burn» without opening strict-accounting numbers to whoever may roll back.
 */
export async function rollbackPreviewOf(
  tx: Tx,
  plan: VehicleRequestRollbackPlan,
  options: { showSheetNumbers: boolean },
): Promise<VehicleRequestRollbackPreviewDto> {
  const blockers: VehicleRequestRollbackBlockerDto[] = [];
  if (plan.blockers.approvedShifts) {
    blockers.push({ code: 'approved_shifts', message: plan.blockers.approvedShifts });
  }
  if (plan.blockers.activeWaybill) {
    blockers.push({
      code: 'active_waybill',
      message: rollbackWaybillBlocker(plan.blockers.activeWaybill),
    });
  }
  const seat = (item: PlannedSeat) => ({ routeNumber: item.routeNumber, date: item.date });
  const relocation = (item: PlannedRelocation) => ({
    routeNumber: formatVehicleRouteNumber(item.num),
    purpose: item.purpose,
    routeDate: item.routeDate,
  });
  return {
    blockers,
    assignment: plan.assignment,
    completion: plan.completion,
    routes: {
      detach: plan.detach.seats.detach.map(seat),
      frozen: plan.detach.seats.frozen.map(seat),
    },
    relocations: {
      drop: plan.detach.relocations.drop.map(relocation),
      keep: plan.detach.relocations.keep.map(relocation),
    },
    shifts: plan.shifts,
    earlyEnd: plan.earlyEnd,
    esm2: {
      cancelCount: plan.esm2.cancel.length,
      keepCount: plan.esm2.keep.length,
      sheets: options.showSheetNumbers
        ? {
            cancel: await esm2SheetPreviews(tx, plan.esm2.cancel),
            keep: await esm2SheetPreviews(tx, plan.esm2.keep),
          }
        : null,
    },
    dropsLinearFreeze: plan.dropsLinearFreeze,
    fingerprint: rollbackPlanFingerprint(plan),
  };
}
