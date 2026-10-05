import { workedAmountLabel } from '@technic/contracts';

/**
 * The consequences list in preview dialogs — presentation shared by four dialogs.
 *
 * A module of its own, not lines in each dialog: closing by an actual date, a vehicle change, a
 * machinist change and an early end show consequences THE SAME way — the person moves between them
 * in one conversation, and diverging indents would read as different kinds of lists. It used to be
 * four copies of the style and two copies of the counting.
 *
 * Lives in the vehicle-request entity, not with any one dialog: it is pure preview presentation,
 * independent of the order data.
 */

/** Indent at the marker, and the list top pressed to its heading. */
export const listStyle = { margin: '4px 0 0', paddingInlineStart: 20 } as const;

/**
 * How much is removed in total — as a number, not a list length: the cost must read in one line.
 */
export function totalOf(days: readonly { hours: number }[]): string {
  const hours = days.reduce((sum, day) => sum + day.hours, 0);
  return `Всего дней: ${days.length} · ${workedAmountLabel('hours', hours)}`;
}
