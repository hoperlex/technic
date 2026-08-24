import { formatWaybillDate } from '@technic/contracts';

/**
 * Дата с талона человеку: `17.08.2026`.
 *
 * Не через `formatDate` из `utils/format`: тот переводит момент времени в московскую зону, а дата
 * талона — **календарный день на бумаге**, а не момент. Зональный перевод сдвинул бы его на сутки
 * там, где браузер живёт западнее Москвы, — и портал спорил бы с бланком, который человек держит
 * в руке.
 */
export function ticketDate(iso: string | null | undefined): string {
  return iso ? formatWaybillDate(iso) : '—';
}
