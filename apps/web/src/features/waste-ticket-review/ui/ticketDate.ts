import { formatWaybillDate } from '@technic/contracts';

/**
 * A ticket date as printed for a person: `17.08.2026`.
 *
 * Do not use `formatDate` from `@shared/lib`: it converts an instant to Moscow time, while a ticket
 * carries a **calendar date on paper**, not an instant. Timezone conversion could move it by one
 * day in a browser west of Moscow and make the portal disagree with the form in the user's hand.
 */
export function ticketDate(iso: string | null | undefined): string {
  return iso ? formatWaybillDate(iso) : '—';
}
