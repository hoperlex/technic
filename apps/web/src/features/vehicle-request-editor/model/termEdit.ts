import type { PeriodApplyBody, PeriodPreviewDto, RequestStatus } from '@technic/contracts';
import type { FormValues } from './requestFormValues';
import type { VehiclePeriodCommand } from './types';

/**
 * The work term of an on-site order as an edit sees it (K3a of the assignment periods plan; owner
 * surveys S-21 and S-22 of 12.10.2026): the term moves through its own door
 * (`PATCH /vehicle-requests/:id/period`), and the wide `PATCH /vehicle-requests/:id` carries
 * everything else — except the one case `termRidesWideEdit` names.
 *
 * `version` travels with the term because the door bumps it: the rest of the edit must go with the
 * version the door returned, or the server answers 409 to an edit the person has already started.
 */
export interface EditorTerm {
  version: number;
  dateFrom: string;
  dateTo: string | null;
}

/**
 * Whether this edit sends the term in the wide PATCH instead of the door (S-22 of 12.10.2026).
 *
 * The door is guarded by `waybills.read`: its preview shows sheet numbers and the people on them,
 * and the owner kept that right as is. The customer roles — the site and the department, who edit
 * their own «Новая» orders — hold `vehicleRequests.update` without the journal (ADR 0192), so for
 * them the door is closed by design, not by an oversight. A «Новая» order has no vehicle, no paper
 * and no history, so the door has nothing to show them either, and the owner decided that its term
 * stays on the wide route: release R2 removes the dates from the wide PATCH only for orders in work.
 *
 * Both halves are needed. Without the status, a customer would send dates for an order in work,
 * which R2 refuses; without the right, a dispatcher's «Новая» edit would skip the door that still
 * serves him (and keeps the legacy-call metric honest). The right comes from the server's list
 * (`can`, ADR 0223), the same list the door's guard reads.
 */
export function termRidesWideEdit(status: RequestStatus, canReadJournal: boolean): boolean {
  return status === 'new' && !canReadJournal;
}

/**
 * What the term door is asked to do, or `null` when the form leaves the term as it is.
 *
 * `null` is load-bearing, not a shortcut: the door refuses an empty command (it would bump the
 * version and leave a journal row with no subject), so an edit of the comment or the contact must
 * not touch the door at all. Compared with `term`, not with the request as opened: after a partial
 * save the term already applied in this edit is the base, and asking the door for it again would be
 * that very empty command.
 */
export function termCommandOf(values: FormValues, term: EditorTerm): VehiclePeriodCommand | null {
  if (values.requestType !== 'special_equipment' || !values.dateFrom) return null;
  const dateFrom = values.dateFrom.format('YYYY-MM-DD');
  const dateTo = values.dateTo ? values.dateTo.format('YYYY-MM-DD') : null;
  if (dateFrom === term.dateFrom && dateTo === term.dateTo) return null;
  return { dateFrom, dateTo };
}

/**
 * The term preview has nothing to show and nothing to confirm, so the edit applies it at once,
 * without the consequences window — the same rule as the silent vehicle change
 * (`reassignPreviewIsSilent`): "nothing will happen, press again" teaches people to press without
 * reading.
 *
 * Nothing burns or gets issued, no worked sheet is re-issued, no sheet asks for a signature, and no
 * vehicle decision is cancelled. An operation requirement (a backdated move) does not make the
 * preview loud by itself: its only demand is a reason, and the form has already asked it of the
 * person (`backdateReason`) — by the same `movedRequestDateKey` rule the door uses. Without a typed
 * reason the window asks for one.
 */
export function termPreviewIsSilent(preview: PeriodPreviewDto, reason: string): boolean {
  return (
    preview.plan.cancel.length === 0 &&
    preview.plan.issue.length === 0 &&
    preview.requiredUnlocks.length === 0 &&
    preview.issues.length === 0 &&
    preview.cancelGroups.length === 0 &&
    preview.cancelGroupsFingerprint === null &&
    (preview.operationRequirement === null || reason !== '')
  );
}

/**
 * The apply body of a silent preview. Every confirmation the server asked for travels back, and
 * none it did not ask for: an extra fingerprint is refused as strictly as a missing one. The unlock
 * fingerprint may be present over an empty set — a backdated outcome confirms "no worked sheet is
 * re-issued" (D4) — and goes back as is.
 */
export function silentTermApplyBody(
  term: EditorTerm,
  command: VehiclePeriodCommand,
  preview: PeriodPreviewDto,
  operation: { operationId: string; reason: string },
): PeriodApplyBody {
  return {
    version: term.version,
    ...command,
    previewFingerprint: preview.fingerprint,
    ...(preview.unlockFingerprint !== null ? { unlockFingerprint: preview.unlockFingerprint } : {}),
    ...(preview.operationRequirement ? { operation } : {}),
  };
}
