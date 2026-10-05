import {
  canOrderVehicleRequestType,
  type Permission,
  type ScopedSubject,
  vehicleRequestCopyPath,
  type VehicleRequestType,
} from '@technic/contracts';

type Can = (permission: Permission) => boolean;

/**
 * May this account take a copy of the order — "Завести такую же" (ADR 0173 §2, ADR 0206 §1).
 *
 * Three conditions, and the status of the source is not among them: a copy sends no request to the
 * source at all, it opens the **create** form, so only the create gates apply — the right, the
 * account's corridor of request kinds (a department without places would be led straight to a
 * server refusal, ADR 0201) and the archive, where a withdrawn record carries no actions at all
 * (ADR 0070).
 *
 * One home for two screens: the order list, whose card opens the form in place, and the closed-order
 * journal, whose card leads to that same form by address. A second copy of the rule would show the
 * button on one screen and hide it on the other — and the screen that offered it by mistake would
 * end in a server refusal.
 *
 * The right is asked of `can`, that is of the list the server computed (ADR 0106), and not of the
 * role matrix: a permission assembled by an administrator is in the list and not in the matrix.
 */
export function canCopyVehicleRequest(
  can: Can,
  subject: ScopedSubject | null | undefined,
  request: { requestType: VehicleRequestType; deletedAt?: string | null },
): boolean {
  if (request.deletedAt) return false;
  return can('vehicleRequests.create') && canOrderVehicleRequestType(subject, request.requestType);
}

/**
 * Address of the copy form behind that same gate — the pairing this slice keeps for every portal
 * link (`model/links.ts`): the address lives in the contracts, the right to it lives here.
 *
 * `null` means the caller shows no action at all. The journal cannot open the form itself — the
 * section has one create form and it belongs to the order list — so its card hands the reader over
 * by address instead.
 */
export function vehicleRequestCopyLink(
  can: Can,
  subject: ScopedSubject | null | undefined,
  request: { id: string; requestType: VehicleRequestType; deletedAt?: string | null },
): string | null {
  return canCopyVehicleRequest(can, subject, request) ? vehicleRequestCopyPath(request.id) : null;
}
