import {
  assignmentAcknowledgementsOf,
  assignmentIssueNeedsAcknowledgement,
  WAYBILL_ACK_REQUIRED_CODE,
  WAYBILL_WARNING_CODE_LABELS,
  type AssignmentPreviewDto,
  type EarlyEndApprovalPreviewDto,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { formatDateOnly } from '@shared/lib';
import { waybillWarningLines, type WarnedSheet } from '@entities/waybill';
import { ASSIGNMENT_PREVIEW_STALE } from './ReassignPreview';

/**
 * Per-sheet warning signatures of the assignment doors (B4) — the adapter between their preview and
 * the shared confirmation block of `@entities/waybill`.
 *
 * WHY THE WINDOWS NEED IT. In `history` read mode the history doors (repair, period, machinist,
 * completion, early end) issue ESM-2 blanks from their own plan and demand a signature for every
 * sheet with warnings; without one the command answers 409 `waybill_ack_required`. The portal used
 * to send none, so any plan with a warned sheet was a dead end in those windows: a toast and no way
 * forward.
 *
 * WHAT IS READ, NOT DECIDED. The warnings, the fingerprints and which sheets carry them all come
 * from the preview. "A sheet needs a signature iff its warning set is non-empty" is asked of the
 * contracts (`assignmentIssueNeedsAcknowledgement`), the same predicate the server checks with:
 * a signature for a clean sheet is rejected as superfluous, so the window must not choose.
 */

/** Warned sheets of a preview, named the way the consequences list names them. */
export function warnedSheetsOf(
  preview: Pick<AssignmentPreviewDto, 'plan' | 'issues'>,
): WarnedSheet[] {
  const planned = new Map(preview.plan.issue.map((sheet) => [sheet.issueKey, sheet]));
  return preview.issues.filter(assignmentIssueNeedsAcknowledgement).map((issue) => {
    const sheet = planned.get(issue.issueKey);
    return {
      // The contract's canonical key: the decimal `issueKey`, no leading zeros — `String` gives
      // exactly that, and a second spelling would sign the same sheet twice.
      key: String(issue.issueKey),
      // Composition, not just dates: a week can be split between people, and "the sheet for
      // 10–16 August" would not say whose documents the warning is about.
      title: sheet
        ? `Лист за ${formatDateOnly(sheet.from)} — ${formatDateOnly(sheet.to)}: ${sheet.vehicleName}, машинист ${sheet.driverName}`
        : `Лист № ${issue.issueKey + 1} плана`,
      lines: waybillWarningLines(issue.warnings),
      fingerprint: issue.warningFingerprint,
    };
  });
}

/**
 * Warned sheets of an early-end preview — anonymized: kinds of warnings, no texts, no names.
 *
 * Both early-end doors answer with the approver's projection (R26): the approver has no right to
 * the waybill journal, so neither the driver nor the blank is named, and the sheet is known only by
 * its place in the plan. The kind is still named in words from the contracts dictionary: a
 * signature under a bare code would be a signature in the dark.
 */
export function anonymousWarnedSheetsOf(
  preview: Pick<EarlyEndApprovalPreviewDto, 'issues'>,
): WarnedSheet[] {
  return preview.issues.filter(assignmentIssueNeedsAcknowledgement).map((issue) => ({
    key: String(issue.issueKey),
    title: `Выписываемый лист № ${issue.issueKey + 1}`,
    lines: issue.codes.map((code) => ({ key: code, text: WAYBILL_WARNING_CODE_LABELS[code] })),
    fingerprint: issue.warningFingerprint,
  }));
}

/**
 * The `acknowledgements` part of a command body, built by the contracts from the confirmed preview;
 * nothing at all when no sheet needs a signature.
 *
 * The field is omitted rather than sent empty for the same reason every other handshake of these
 * doors is: its presence is dictated by the server's answer, not by the client.
 */
export function acknowledgementsOf(issues: Parameters<typeof assignmentAcknowledgementsOf>[0]): {
  acknowledgements?: Record<string, string>;
} {
  const acknowledgements = assignmentAcknowledgementsOf(issues);
  return Object.keys(acknowledgements).length > 0 ? { acknowledgements } : {};
}

/**
 * Did the server refuse because the warning set is no longer the one the person confirmed?
 *
 * Two answers mean that. 409 `waybill_ack_required` — a warning appeared or its facts changed.
 * 422 on the `acknowledgements` field — a warning disappeared (someone completed the driver's
 * documents), so a signature now points at a sheet with nothing to confirm. Both are cured the same
 * way: recompute the preview and let the person read the new list, not by a toast.
 */
function warningsChanged(e: unknown): boolean {
  if (!isApiError(e)) return false;
  if (e.status === 409 && e.code === WAYBILL_ACK_REQUIRED_CODE) return true;
  return e.status === 422 && e.fields?.acknowledgements !== undefined;
}

/**
 * A refusal after which the window recomputes the consequences instead of showing an error, and the
 * words it explains the step back with; `null` — a real error for the caller to show.
 *
 * Shared by the repair and period windows so that both say the same thing about the same refusal.
 * Matched by code, not status: 409 at these doors is also a version conflict, which is cured by
 * reloading the list, not by reading the consequences again.
 */
export function recheckReasonOf(e: unknown): string | null {
  if (isApiError(e) && e.code === ASSIGNMENT_PREVIEW_STALE) {
    return 'Последствия изменились с того момента, как вы их смотрели, — вот что произойдёт теперь. Прочитайте и подтвердите заново.';
  }
  if (warningsChanged(e)) {
    return 'Предупреждения по листам изменились с того момента, как вы их смотрели, — вот актуальный перечень. Прочитайте и подтвердите заново.';
  }
  return null;
}
