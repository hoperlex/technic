import dayjs from 'dayjs';
import { MOSCOW_TZ } from '@shared/config';

/**
 * How a value is printed to a person: a moment, a size, a sum of money.
 *
 * In the foundation rather than in a slice because there is no portal rule here — only typography
 * shared by every screen. The same four helpers were reachable before through `utils/format`, a
 * directory outside the FSD layers, and because the slices could not import it they grew their own
 * copies instead: the money helper alone was written out three times.
 *
 * Moments are rendered in the portal's timezone, not the browser's: a dispatcher in another region
 * must read the same hour as the one who agreed it, or the agreed hour silently becomes theirs.
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
