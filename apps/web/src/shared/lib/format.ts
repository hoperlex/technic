import dayjs from 'dayjs';
import { MOSCOW_TZ } from '@shared/config';

/*
 * How a value is printed to a person: a moment, a size, a sum of money.
 *
 * In the foundation rather than in a slice because there is no portal rule here — only typography
 * shared by every screen. These four used to live in `utils/format`, a directory outside the FSD
 * layers: slices could not import it, so they wrote their own copies instead.
 *
 * Those copies are STILL HERE, and they are the reason this module exists rather than proof that
 * the job is done. `formatMoney` is spelled out by hand in at least `entities/mech-request`
 * (`mechMoney`), `entities/service-request/ui/ServiceEstimateTable.tsx` and
 * `pages/directories/vehicleRegistryColumns.tsx` — and the last of the three has already drifted:
 * it prints no kopecks where the rest of the portal prints two. Moving the helper here only made
 * the copies reachable for merging; each merge is its own change, because each one may shift what a
 * screen shows.
 *
 * Moments are rendered in the portal's timezone, not the browser's: a dispatcher in another region
 * must read the same hour as the one who agreed it, or the agreed hour silently becomes theirs.
 *
 * Precondition: `.tz()` needs the dayjs timezone plugin, installed by `setupDayjs()` (`./dayjs`).
 * The application calls it at start-up; a test that renders nothing but calls these helpers must
 * call it too, or the moment helpers throw «dayjs(...).tz is not a function».
 */

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dayjs(iso).tz(MOSCOW_TZ).format('DD.MM.YYYY HH:mm');
}

/** The date alone, without the hour. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dayjs(iso).tz(MOSCOW_TZ).format('DD.MM.YYYY');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

/** A sum in roubles: «15 000,00 ₽». */
export function formatMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}
