import { driverReadingTimeIssues, type ReadingTimeIssue } from './reading-times';

/**
 * What a block the driver sends must carry (ADR 0237): the cabinet sends whole shifts at their end.
 *
 * A module of its own, not a function among the readings contract or the time rules: only the
 * cabinet imports it, so the bundler keeps it in the cabinet's chunk. In `vehicle-readings.ts` it
 * would sit in the chunk the garage shares and every garage screen would download it for nothing;
 * the bundle budget is byte-exact (`apps/web/bundle-budget.json`).
 */

/** The fields a driver's completeness refusal stands under: the form looks them up by these names. */
export type DriverReadingCompletenessField =
  'odometerKm' | 'engineHours' | 'fuelStartLiters' | 'fuelEndLiters';

/**
 * The driver's completeness rule: a reading block the driver submits is whole — the fuel at the
 * start and at the end of the shift, and ONE of the two counters. `fuelFilledLiters`, the comment and
 * the files stay optional: an empty "filled" means the vehicle was not refuelled.
 *
 * The odometer and the engine hours are one slot, not two: a vehicle often has only one of them
 * (an excavator has no odometer, a passenger van no engine-hours meter), and the form cannot know
 * which. Both fields get the refusal when neither is filled, so it stands under whichever the driver
 * looks at.
 *
 * Only the cabinet asks it, and only about a block the driver changes (a saved staff entry resent
 * untouched must not hold the day, as with `lineRequiresDriverTimes`). The server keeps accepting
 * part-filled readings: staff enter them, and a build older than ADR 0237 still submits morning
 * values — the rule is a form guard, not a ledger invariant.
 *
 * Values are the parsed numbers; an unreadable input is refused earlier by the form, so it never
 * reaches here.
 */
export function driverReadingCompletenessIssues(values: {
  odometerKm: number | null;
  engineHours: number | null;
  fuelStartLiters: number | null;
  fuelEndLiters: number | null;
}): Partial<Record<DriverReadingCompletenessField, string>> {
  const issues: Partial<Record<DriverReadingCompletenessField, string>> = {};
  if (values.fuelStartLiters === null) {
    issues.fuelStartLiters = 'Укажите остаток топлива на начало смены';
  }
  if (values.fuelEndLiters === null) {
    issues.fuelEndLiters = 'Укажите остаток топлива на конец смены';
  }
  if (values.odometerKm === null && values.engineHours === null) {
    const message = 'Укажите одометр или моточасы';
    issues.odometerKm = message;
    issues.engineHours = message;
  }
  return issues;
}

/**
 * The driver's time rule for a WHOLE shift (ADR 0237): the end time and every departure are due
 * whatever the numbers say, so a half-filled block shows its time refusals together with its number
 * refusals instead of after them.
 *
 * `driverReadingTimeIssues` derives "finished" from an evening value (D11). A whole shift has its
 * evening part by definition, so the call hands the rule the marker it reads — a counter at zero —
 * instead of growing the rule with a flag: the rule lives in the entry chunk, where a flag costs
 * every route a few bytes. The marker is never stored or sent; the real numbers go in the body.
 */
export function driverWholeShiftTimeIssues(
  params: Omit<Parameters<typeof driverReadingTimeIssues>[0], 'values'>,
): ReadingTimeIssue[] {
  return driverReadingTimeIssues({ ...params, values: { odometerKm: 0, engineHours: null } });
}
