/**
 * Calendar days: a day key as people read it, and the length of a period in days.
 *
 * Kept apart from the moment helpers in `format.ts` on purpose. A day key (`YYYY-MM-DD`) carries no
 * hour at all, so it must never be pushed through a timezone: doing so on a browser east of Moscow
 * moves the end of an equipment order one day back. The length is counted the same way — by
 * subtracting day keys, never by subtracting moments, because a day with a DST shift is not 24
 * hours long and the difference would lose it.
 */

/** A day key (`YYYY-MM-DD`) as written, with no timezone conversion — see the note above. */
export function formatDateOnly(value: string): string {
  const [y, m, d] = value.split('-');
  return y && m && d ? `${d}.${m}.${y}` : value;
}

/**
 * Length of a period in calendar days, both ends counted. `null` means the period does not add up
 * (the end is before the start), and then there is nothing to hint at.
 */
export function calendarDayCount(fromKey: string, toKey?: string | null): number | null {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey || fromKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * The length spelled out — «5 календарных дней». Counting calendar days in one's head is easy to
 * get wrong, especially across a month boundary, while equipment is ordered and rent is charged in
 * exactly those days — so the hint stands both in the request form and in its card.
 */
export function calendarDaysLabel(fromKey: string, toKey?: string | null): string | null {
  const days = calendarDayCount(fromKey, toKey);
  if (days === null) return null;
  // Russian agreement: 1 день, 2–4 дня, 5–20 дней; 11–14 always take «дней».
  const tail = days % 100;
  const last = days % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'календарных дней'
      : last === 1
        ? 'календарный день'
        : last >= 2 && last <= 4
          ? 'календарных дня'
          : 'календарных дней';
  return `${days} ${form}`;
}
