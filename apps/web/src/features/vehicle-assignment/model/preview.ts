import type { AssignmentPreviewDto } from '@technic/contracts';
import { isApiError } from '@shared/api';

export const ASSIGNMENT_PREVIEW_STALE = 'assignment_preview_stale';
export const ASSIGNMENT_CLIENT_UPGRADE = 'client_upgrade_required';

/**
 * Convert only assignment-preview conflicts into a reason to recompute. A generic version conflict
 * belongs to the list refresh flow, and the same client-upgrade code with HTTP 426 belongs to the
 * application update flow.
 */
export function reassignStaleReason(error: unknown): string | null {
  if (!isApiError(error)) return null;
  if (error.code === ASSIGNMENT_PREVIEW_STALE) {
    return 'Последствия изменились с того момента, как вы их смотрели, — вот что произойдёт теперь. Прочитайте и подтвердите заново.';
  }
  if (error.status === 409 && error.code === ASSIGNMENT_CLIENT_UPGRADE) {
    return 'Смена техники теперь идёт через просмотр последствий — вот они. Прочитайте и подтвердите.';
  }
  return null;
}

/** A silent preview still contributes its fingerprint but does not need a redundant second step. */
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

/** Signed work days block reassignment until an explicit historical correction removes the lock. */
export function reassignPreviewBlocked(preview: AssignmentPreviewDto): boolean {
  return preview.blockedShiftDays.length > 0;
}
