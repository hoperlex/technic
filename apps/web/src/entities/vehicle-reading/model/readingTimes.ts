/**
 * How shift and stop times of a reading read on screen (ADR 0234). The rules — order, requiredness,
 * duration, the per-request split — live in `@technic/contracts` (`reading-times.ts`); here is only
 * the wording, shared by the driver cabinet and the garage so that one shift never reads as
 * «4 ч 10 мин» in one and «4,17 ч» in the other.
 */

/**
 * «4 ч 10 мин», «25 мин». Minutes after hours are zero-padded («2 ч 05 мин»): durations stand in a
 * column under each other, and a padded column is compared at a glance. Rounded to whole minutes —
 * the times are typed to the minute, and a share of a split stop is the only thing with seconds.
 */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours === 0 ? `${rest} мин` : `${hours} ч ${String(rest).padStart(2, '0')} мин`;
}

/** «08:00–20:00» or «08:00–…» while the end is not recorded; `null` when there is no start. */
export function timeRangeText(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt) return null;
  return `${startedAt}–${endedAt ?? '…'}`;
}
