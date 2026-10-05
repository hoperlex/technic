import {
  canCorrectAssignment,
  canReassignVehicle,
  esm2Mode,
  type Permission,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDto,
} from '@technic/contracts';

/**
 * Availability rules of the specialist request operations offered from the feed and the request
 * card. Kept next to `useVehicleRequestOperations` (and out of it only for the file-length budget);
 * every state check is a contracts predicate the server answers with, so a button never offers a
 * certain refusal.
 */
export function vehicleRequestOperationRules(can: (permission: Permission) => boolean) {
  // Running the request's course: taking into work and, by the same right, changing the assigned
  // vehicle (ADR 0048).
  const canChangeStatus = can('vehicleRequests.status');

  /**
   * Change the assigned vehicle (ADR 0048). The right is the one used to take the request into
   * work: choosing equipment is the dispatcher's decision, not the author's. The state is asked by
   * the contracts predicate the server answers with, so the button does not offer a refusal.
   */
  const canReassign = (request: VehicleRequestDto) =>
    canChangeStatus && canReassignVehicle(request);

  /**
   * Change the machinist within the request term (`docs/assignment-periods-plan.md`, §9).
   *
   * The rights are those the door itself is opened with: run the request state and read waybills.
   * Correction rights (`waybills.correct` and deeper than thirty days) are deliberately not asked:
   * the server asks them **by the computed outcome**, not by the calendar (R32) — a planned change
   * from Monday is ordinary dispatcher work, and forbidding it to someone without the correction
   * right would take away a working action. A refusal by outcome is put into words by the dialog.
   *
   * The request state is asked by the same predicates as a vehicle change, and the paper mode by
   * the `esm2Mode` contract: a linear order names its machinist when each form is issued (ADR 0100
   * §6), and for a rented vehicle the lessor issues the form — no person history is kept there, and
   * the door refuses such a command.
   */
  const canChangeMachinist = (request: VehicleRequestDto): request is SpecialEquipmentRequestDto =>
    canChangeStatus &&
    can('waybills.read') &&
    request.requestType === 'special_equipment' &&
    canCorrectAssignment(request) &&
    esm2Mode({
      requestType: request.requestType,
      status: request.status,
      ownership: request.assignment?.ownership ?? null,
      deletedAt: request.deletedAt,
      isLinear: request.isLinear,
    }) === 'auto';

  /**
   * History repair (sub-stage 6a of `docs/assignment-periods-plan.md`, R29).
   *
   * The same conditions as the machinist change **plus the archive**: an archived request with
   * non-empty paper is exactly the case the repair door exists for (assignment correction is
   * forbidden in the archive, and nothing else can open it). Hence `canCorrectAssignment` is not
   * asked here — it rejects deleted requests.
   *
   * The item is shown by the door's applicability, not by whether there is work: only the
   * inspection knows "is there anything to repair", and asking it for every list row would send a
   * request per page row. "Nothing to repair" is said by the dialog in words — more honest than a
   * hidden menu item.
   */
  const canRepairHistory = (request: VehicleRequestDto): request is SpecialEquipmentRequestDto =>
    canChangeStatus &&
    can('waybills.read') &&
    request.requestType === 'special_equipment' &&
    request.status === 'confirmed' &&
    !!request.assignment &&
    !request.isLinear &&
    (request.assignment.ownership ?? 'own') === 'own';

  // Moving the request to another route (ADR 0052) — by the same right as the request's course:
  // the route is the course of work on it.
  const canTransfer = (request: VehicleRequestDto) =>
    canChangeStatus && !!request.route && !request.route.hasWaybill;

  // Equipment relocation (migration 0082) — by the same right as the request's course. Offered for
  // an on-site order in work: delivery and pickup are issued to the assigned vehicle, which neither
  // a new request nor a rental has.
  const canRelocate = (request: VehicleRequestDto) =>
    canChangeStatus &&
    request.requestType === 'special_equipment' &&
    request.status === 'confirmed' &&
    request.assignment?.ownership === 'own';

  // Weekly ESM-2 on demand (ADR 0100 decision 6) — with the same rights as issuing a waybill from a
  // route: the same document and the same decision corridor, no separate right was created. Only a
  // linear order in work on an own vehicle: an ordinary request issues its forms itself, and the
  // lessor issues forms for rentals.
  const canIssueEsm2 = (request: VehicleRequestDto) =>
    request.requestType === 'special_equipment' &&
    request.isLinear &&
    request.status === 'confirmed' &&
    request.assignment?.ownership === 'own' &&
    canChangeStatus &&
    can('waybills.read');

  return {
    canChangeMachinist,
    canChangeStatus,
    canIssueEsm2,
    canReassign,
    canRelocate,
    canRepairHistory,
    canTransfer,
  };
}
