/**
 * How the shift time of a reading reads on screen (ADR 0234), shared by the driver cabinet and the
 * garage. The rules — order, requiredness, duration, the per-request split — and the wording of a
 * duration (`durationLabel`) live in `@technic/contracts`.
 */

/** «08:00–20:00» or «08:00–…» while the end is not recorded; `null` when there is no start. */
export function timeRangeText(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt) return null;
  return `${startedAt}–${endedAt ?? '…'}`;
}
