import {
  type BackdateAccess,
  formatWeeklyRequestNumber,
  moscowDateKeyOf,
  pastSelectableWeeks,
  type Permission,
  selectableWeeks,
  weekStartKey,
  type WeeklyPreviousWeekDto,
  weeklyWeekLabel,
} from '@technic/contracts';

/*
 * Weekly-request vocabulary shared by every portal entry: page path, week options, composition
 * labels. There are two creation entries (the weekly requests tab and the "On site" tab), and if
 * they lived in two files they would drift in behaviour too: one would open the existing draft,
 * the other would get the UNIQUE (object_id, week_start) refusal.
 *
 * The notion of a week comes only from contracts (selectableWeeks, pastSelectableWeeks,
 * weeklyWeekLabel): there must be no second implementation on the client, otherwise the portal
 * would promise waybills other than those that will appear.
 */

/** Weekly request page path: a separate page rather than a modal window (section 5 step 1). */
export const weeklyRequestPath = (id: string): string => `/vehicle-requests/weekly/${id}`;

/**
 * Today in Moscow, by the same expression as the server (moscowDateKeyOf): a dispatcher in another
 * region has a different day boundary, and their "this week" would diverge from the API exactly
 * when deciding whether an overdue draft can still be submitted.
 */
export const weeklyToday = (): string => moscowDateKeyOf(new Date());

/**
 * What the account may do retroactively (ADR 0101): the past right and its depth, as the same pair
 * the server asks (backdateAccessOf). One helper for the whole weekly module because three callers
 * ask it (week select, request page, conduct window), and three hand-made objects would drift on
 * the first rule change.
 */
export function weeklyBackdateAccess(can: (permission: Permission) => boolean): BackdateAccess {
  return {
    correct: can('waybills.correct'),
    beyondLimit: can('waybills.correctBeyondLimit'),
  };
}

/** Weeks a request can be created for, labelled for humans ("10–16 августа 2026"). */
export function weekSelectOptions(today = weeklyToday()) {
  return selectableWeeks(today).map((week) => ({ value: week, label: weeklyWeekLabel(week) }));
}

/**
 * Past weeks available to the past right, the second half of the same choice (ADR 0101).
 *
 * They are labelled differently from future ones on purpose: a request for a past week is
 * conducted retroactively, with a reason, an operation record and burnt form numbers, and nobody
 * should land there by missing the neighbouring row. Without the right the list is empty and the
 * select gets no group at all: an unavailable option would promise what the endpoint refuses.
 *
 * The weeks and their depth are computed by the contract (pastSelectableWeeks): an expression of
 * our own would offer a week the approval then calls "too long ago".
 */
export function pastWeekSelectOptions(access: BackdateAccess, today = weeklyToday()) {
  const current = weekStartKey(today);
  return pastSelectableWeeks(today, access).map((week) => ({
    value: week,
    // The current week is called current, not past: it is still running, and "past" would be a lie.
    // The rule for both is the same, hence one group.
    label: `${weeklyWeekLabel(week)} — ${week === current ? 'текущая, уже началась' : 'прошедшая'}`,
  }));
}

/**
 * "прошла" (passed) or "началась" (started), by the same comparison the server refusal uses
 * (weeklyWeekBlocker): a week whose Monday is before the current one passed entirely, other overdue
 * weeks have started. Only the word differs (right, depth and price are the same), but telling a
 * site that a week which ended a month ago "has started" would lie in the banner's first sentence.
 */
export function weeklyOverdueWord(weekStart: string, today = weeklyToday()): string {
  return weekStart < weekStartKey(today) ? 'прошла' : 'началась';
}

// Russian count-word declension: 1 продление, 2 продления, 5 продлений.
function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 100;
  const last = n % 10;
  if (tail >= 11 && tail <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * The previous week in one line: "Из НЗ-15 (10–16 августа 2026): 6 позиций продлеваются, 2 выбыли —
 * ТС-341 — заказ закрыт фактом; ТС-352 — вывоз оформлен рейсом Р-12".
 *
 * Dropped orders are listed by name with a reason rather than counted: "2 dropped" would make the
 * site office reconcile the composition with last week by eye, exactly what continuity was meant to
 * spare. Reasons come from the server in the same texts as the module's other refusals.
 */
export function weeklyPreviousText(previous: WeeklyPreviousWeekDto): string {
  const from = `Из ${formatWeeklyRequestNumber(previous.num)} (${previous.weekLabel})`;
  const carried =
    previous.carried === 0
      ? 'ни одна позиция не продлевается'
      : `${previous.carried} ${plural(
          previous.carried,
          'позиция продлевается',
          'позиции продлеваются',
          'позиций продлеваются',
        )}`;
  if (previous.dropped.length === 0) return `${from}: ${carried}`;
  const dropped = previous.dropped
    .map((item) => `${item.displayNumber} — ${item.reason}`)
    .join('; ');
  return (
    `${from}: ${carried}, ${previous.dropped.length} ` +
    `${plural(previous.dropped.length, 'выбыла', 'выбыли', 'выбыли')} — ${dropped}`
  );
}
