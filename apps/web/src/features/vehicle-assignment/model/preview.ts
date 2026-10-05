import type { AssignmentPreviewDto } from '@technic/contracts';
import { isApiError } from '@shared/api';

/**
 * The vehicle-change preview contract on the client: the cost of a change read by the person
 * **before** the click (wave 4a of `docs/assignment-periods-plan.md`, §7) — which ESM-2 numbers
 * burn and which are issued, which site signatures drop, which days the machinist lacks.
 *
 * Nothing is computed here: everything comes ready from the server
 * (`POST /vehicle-requests/:id/assignment/preview`), computed by the same planner that will then
 * run (`planReassignCommand`). A second computation in the portal would drift from the first, and
 * the dialog would promise something other than what happens.
 */

/** A 409 on which the dialog does not complain but asks again: consequences changed (R32, И5). */
export const ASSIGNMENT_PREVIEW_STALE = 'assignment_preview_stale';
/**
 * A 409 for a client without a fingerprint — after the read switch (И5). Wave 4a of the portal
 * always sends one, except when the server turned out older and has no preview handler at all.
 * Then this refusal arrives, and it is cured like a stale fingerprint: by looking at consequences.
 */
export const ASSIGNMENT_CLIENT_UPGRADE = 'client_upgrade_required';

/**
 * A refusal after which the dialog returns the person to the consequences, and the words that
 * explain the return. `null` — someone else's refusal, which the dialog cannot show: whoever sent
 * the command reports it.
 *
 * Matched by code, not status: a 409 from this handler is also a request version conflict, which is
 * cured by reloading the list, not by reviewing consequences.
 */
export function reassignStaleReason(error: unknown): string | null {
  if (!isApiError(error)) return null;
  if (error.code === ASSIGNMENT_PREVIEW_STALE) {
    return 'Последствия изменились с того момента, как вы их смотрели, — вот что произойдёт теперь. Прочитайте и подтвердите заново.';
  }
  /*
   * The status is checked here too, although the other branch uses the code alone. The same
   * literal is now carried by the client version gate refusal (ADR 0146, decision 7) — but with
   * status 426 and a different conversation: a page reload cures it, not a preview. Taking it as
   * its own, the dialog would offer a preview instead of the demand to update.
   */
  if (error.status === 409 && error.code === ASSIGNMENT_CLIENT_UPGRADE) {
    return 'Смена техники теперь идёт через просмотр последствий — вот они. Прочитайте и подтвердите.';
  }
  return null;
}

/**
 * Nothing to say: paper stays untouched, signatures stay, no gaps, nothing goes to the journal. The
 * dialog sends such a change at once without a second screen — "nothing will happen, press again"
 * teaches people to press without reading, and then the screen fails the one time it has something
 * to say.
 *
 * The fingerprint still travels with the command: the preview happened, it just did not bother the
 * person.
 */
export function reassignPreviewIsSilent(preview: AssignmentPreviewDto): boolean {
  return (
    preview.plan.cancel.length === 0 &&
    preview.plan.issue.length === 0 &&
    preview.requiredUnlocks.length === 0 &&
    preview.blockedShiftDays.length === 0 &&
    preview.clearedShiftDays.length === 0 &&
    preview.requiredAnchors.length === 0 &&
    preview.operationRequirement === null
  );
}

/**
 * There will be no command: these days' hours are signed by the site, and swapping the vehicle
 * would rewrite retroactively what carries a signature. The server answers on the same condition
 * (422 "there are approved shifts"), so the button is disabled — the dialog must not lead the
 * person into a refusal.
 */
export function reassignPreviewBlocked(preview: AssignmentPreviewDto): boolean {
  return preview.blockedShiftDays.length > 0;
}
