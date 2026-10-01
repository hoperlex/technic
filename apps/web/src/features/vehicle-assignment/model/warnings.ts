import {
  assignmentAcknowledgementsOf,
  assignmentIssueNeedsAcknowledgement,
  type AssignmentPreviewDto,
  type EarlyEndApprovalPreviewDto,
  WAYBILL_ACK_REQUIRED_CODE,
  WAYBILL_WARNING_CODE_LABELS,
} from '@technic/contracts';
import { waybillWarningLines, type WarnedSheet } from '@entities/waybill';
import { isApiError } from '@shared/api';
import { formatDateOnly } from '@shared/lib';
import { ASSIGNMENT_PREVIEW_STALE } from './preview';

/** Name warned sheets with the same composition shown by the consequences preview. */
export function warnedSheetsOf(
  preview: Pick<AssignmentPreviewDto, 'issues' | 'plan'>,
): WarnedSheet[] {
  const planned = new Map(preview.plan.issue.map((sheet) => [sheet.issueKey, sheet]));
  return preview.issues.filter(assignmentIssueNeedsAcknowledgement).map((issue) => {
    const sheet = planned.get(issue.issueKey);
    return {
      key: String(issue.issueKey),
      title: sheet
        ? `Лист за ${formatDateOnly(sheet.from)} — ${formatDateOnly(sheet.to)}: ${sheet.vehicleName}, машинист ${sheet.driverName}`
        : `Лист № ${issue.issueKey + 1} плана`,
      lines: waybillWarningLines(issue.warnings),
      fingerprint: issue.warningFingerprint,
    };
  });
}

/** Early-end approvers receive warning kinds without paper or driver identity. */
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

/** Omit the handshake entirely when the preview did not ask for one. */
export function acknowledgementsOf(issues: Parameters<typeof assignmentAcknowledgementsOf>[0]): {
  acknowledgements?: Record<string, string>;
} {
  const acknowledgements = assignmentAcknowledgementsOf(issues);
  return Object.keys(acknowledgements).length > 0 ? { acknowledgements } : {};
}

function warningsChanged(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.status === 409 && error.code === WAYBILL_ACK_REQUIRED_CODE) return true;
  return error.status === 422 && error.fields?.acknowledgements !== undefined;
}

/** Decide whether a command refusal should reopen a freshly recomputed preview. */
export function recheckReasonOf(error: unknown): string | null {
  if (isApiError(error) && error.code === ASSIGNMENT_PREVIEW_STALE) {
    return 'Последствия изменились с того момента, как вы их смотрели, — вот что произойдёт теперь. Прочитайте и подтвердите заново.';
  }
  if (warningsChanged(error)) {
    return 'Предупреждения по листам изменились с того момента, как вы их смотрели, — вот актуальный перечень. Прочитайте и подтвердите заново.';
  }
  return null;
}
