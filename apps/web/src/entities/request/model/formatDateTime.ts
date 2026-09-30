import { formatDate, formatDateTime } from '@shared/lib';

/**
 * A request may have only its date agreed. Showing midnight in that case would claim a time the
 * requester did not specify, so the flag controls whether the time is part of the display value.
 */
export function formatDateTimeMaybe(
  iso: string | null | undefined,
  timeUnspecified: boolean,
): string {
  if (!iso) return '—';
  return timeUnspecified ? formatDate(iso) : formatDateTime(iso);
}
