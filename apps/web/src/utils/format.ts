import dayjs from 'dayjs';
import { MOSCOW_TZ } from '../theme';
import { isApiError } from '../api/client';

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dayjs(iso).tz(MOSCOW_TZ).format('DD.MM.YYYY HH:mm');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

/** Человекочитаемое сообщение об ошибке из ApiError/Error. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return 'Произошла ошибка';
}
