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

/** The canonical route of the weekly request workspace. */
export const weeklyRequestPath = (id: string): string => `/vehicle-requests/weekly/${id}`;

/** Moscow's date boundary is shared with the server-side weekly-request guards. */
export const weeklyToday = (): string => moscowDateKeyOf(new Date());

/** Build the exact permission pair consumed by the contract's backdate guards. */
export function weeklyBackdateAccess(can: (permission: Permission) => boolean): BackdateAccess {
  return {
    correct: can('waybills.correct'),
    beyondLimit: can('waybills.correctBeyondLimit'),
  };
}

/** Future weeks available for a new request, with the contract-owned human-readable label. */
export function weekSelectOptions(today = weeklyToday()) {
  return selectableWeeks(today).map((week) => ({ value: week, label: weeklyWeekLabel(week) }));
}

/** Past weeks allowed by the caller's correction depth. */
export function pastWeekSelectOptions(access: BackdateAccess, today = weeklyToday()) {
  const current = weekStartKey(today);
  return pastSelectableWeeks(today, access).map((week) => ({
    value: week,
    label: `${weeklyWeekLabel(week)} — ${week === current ? 'текущая, уже началась' : 'прошедшая'}`,
  }));
}

/** Distinguish a fully elapsed week from the current week that has already started. */
export function weeklyOverdueWord(weekStart: string, today = weeklyToday()): string {
  return weekStart < weekStartKey(today) ? 'прошла' : 'началась';
}

function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 100;
  const last = n % 10;
  if (tail >= 11 && tail <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** Summarize the previous week without hiding which orders dropped out or why. */
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
