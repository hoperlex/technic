import type { PeriodApplyBody, PeriodPreviewDto } from '@technic/contracts';
import type { FormValues } from './requestFormValues';
import type { VehiclePeriodCommand } from './types';

/**
 * The work term of an on-site order as an edit sees it (K3a of the assignment periods plan, S-21 of
 * 12.10.2026): the term moves only through its own door (`PATCH /vehicle-requests/:id/period`),
 * and the wide `PATCH /vehicle-requests/:id` carries everything else.
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
