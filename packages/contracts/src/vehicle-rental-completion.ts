import type { VehicleOwnership } from './vehicles';
import {
  completionLabel,
  workedAmountLabel,
  type CompleteVehicleRequestInput,
  type VehicleRequestCompletionDto,
} from './vehicle-requests';

/**
 * Rules of a rental closing (plan `docs/vehicle-rental-completion-documents-plan.md`, D1–D4): both
 * counts, the average per shift and the labels that name them. Asked by the closing window, the
 * card, the journal and the server's resolver.
 *
 * A module of its own, not part of `vehicle-requests.ts`: that module is a chunk the portal's entry
 * loads on the first screen, so whatever is added there is downloaded by every section. These
 * rules are read only by the vehicle screens and the server, and here they travel with them.
 */

/**
 * Whether a closing asks for both counts and the delivery cost (D1, D3, D4): any request whose
 * assigned vehicle is rented, an on-site order and a freight request alike. The portal shows the
 * fields by it and the server refuses them by it on every other closing — a silently dropped amount
 * would read as accepted.
 */
export function completionAsksRentalFacts(
  assignment: { ownership: VehicleOwnership } | null | undefined,
): boolean {
  return assignment?.ownership === 'rental';
}

/**
 * Why the counts of a closing body contradict each other, as `{ field: message }`, or `null`.
 *
 * The count matching `workedUnit` is `workedAmount` itself, so a different number there is two
 * answers to one question; the database refuses the same row by CHECK, and this names the field
 * before it gets that far. Only a sent count is checked: an old tab sends neither (§4.3).
 */
export function completionCountsIssue(
  input: Pick<
    CompleteVehicleRequestInput,
    'workedUnit' | 'workedAmount' | 'workedHours' | 'workedShifts'
  >,
): Record<string, string> | null {
  const matching = input.workedUnit === 'hours' ? input.workedHours : input.workedShifts;
  if (matching == null || matching === input.workedAmount) return null;
  const field = input.workedUnit === 'hours' ? 'workedHours' : 'workedShifts';
  return { [field]: 'Не совпадает с отработанным количеством, по которому считается стоимость' };
}

/**
 * Hours per shift of a rental closing (D2): the hours divided between the worked shifts, shown live
 * under the hours field and in the card. `null` when either count is unknown. Rounded to one decimal
 * (P1): the average explains the hours, it is not billed.
 */
export function hoursPerShift(
  hours: number | null | undefined,
  shifts: number | null | undefined,
): number | null {
  if (hours == null || shifts == null || hours <= 0 || shifts <= 0) return null;
  return Math.round((hours / shifts) * 10) / 10;
}

/** «по 9 ч на смену»; `null` — делить нечего. */
export function hoursPerShiftLabel(
  hours: number | null | undefined,
  shifts: number | null | undefined,
): string | null {
  const avg = hoursPerShift(hours, shifts);
  return avg == null ? null : `по ${workedAmountLabel('hours', avg)} на смену`;
}

/**
 * Above this many hours per shift the window warns (P1): a shift is not longer than a day, but
 * fractional shifts make odd averages legal, so it is a warning and never a refusal.
 */
export const HOURS_PER_SHIFT_WARNING = 24;

/**
 * The count that is not billed, with the average per shift: «27 ч, по 9 ч на смену» after
 * «3 смены» (D1, D2); `null` — a closing with one count (before migration 0391, a non-rental, an old
 * tab). One label for the card, the journal, the rollback warning and the history diff, so they
 * cannot word the same closing differently.
 */
export function completionOtherCountLabel(
  c: Pick<
    VehicleRequestCompletionDto,
    'workedUnit' | 'workedAmount' | 'workedHours' | 'workedShifts'
  >,
): string | null {
  const hours = c.workedUnit === 'hours' ? c.workedAmount : c.workedHours;
  const shifts = c.workedUnit === 'shifts' ? c.workedAmount : c.workedShifts;
  const other = c.workedUnit === 'hours' ? shifts : hours;
  if (other == null) return null;
  const label = workedAmountLabel(c.workedUnit === 'hours' ? 'shifts' : 'hours', other);
  const avg = hoursPerShiftLabel(hours, shifts);
  return avg ? `${label}, ${avg}` : label;
}

/** What was worked, the billed count first: «3 смены · 27 ч, по 9 ч на смену». */
export function completionWorkedLabel(
  c: Pick<
    VehicleRequestCompletionDto,
    'workedUnit' | 'workedAmount' | 'workedHours' | 'workedShifts'
  >,
): string {
  const billed = workedAmountLabel(c.workedUnit, c.workedAmount);
  const other = completionOtherCountLabel(c);
  return other ? `${billed} · ${other}` : billed;
}

/**
 * The closing fact in one line with the second count of a rental: «3 смены × 18 000 ₽ · 27 ч, по
 * 9 ч на смену». The card and the rollback warning show it; without a second count it is
 * `completionLabel` as before.
 */
export function completionFactLabel(c: VehicleRequestCompletionDto): string {
  const other = completionOtherCountLabel(c);
  return other ? `${completionLabel(c)} · ${other}` : completionLabel(c);
}
