import {
  driverReadingTimeIssues,
  readingTimeIssues,
  TIME_FORMAT_MESSAGE,
  type ReadingPointInput,
  type ReadingTimeIssue,
  type ReadingTimes,
  type ReportItemDto,
} from '@technic/contracts';
import type { ReadingValue } from '@entities/vehicle-reading';
import type { DraftItem } from './api';
import { parseTime, stopPointTimes, type ShownStop } from './readingStops';

/**
 * Shift and stop times of one row in the submit body, and the refusals under their fields (ADR
 * 0234; plan `docs/readings-shifts-merge-plan.md` §7, owner decision D11).
 *
 * The rules are the contract's: `readingTimeIssues` (shape and order, for every author) and
 * `driverReadingTimeIssues` (the driver's requiredness) — the same functions the readings service
 * applies on submit. The cabinet only runs them earlier, so that a refusal stands under its field
 * before the day leaves the phone instead of coming back from the server as one sentence.
 */

/** Field names of the time refusals: the form looks them up under the same names. */
export const timeFields = {
  startedAt: 'startedAt',
  endedAt: 'endedAt',
  arrival: (position: number) => `arrivedAt:${position}`,
  departure: (position: number) => `departedAt:${position}`,
  /** A refusal about the route as a whole («не больше 24 часов»): under the route block. */
  route: 'route',
} as const;

/** Where a contract issue stands on screen. */
function issueField(issue: ReadingTimeIssue): string {
  switch (issue.code) {
    case 'start_missing':
      return timeFields.startedAt;
    case 'end_missing':
    case 'equal_times':
      return timeFields.endedAt;
    case 'arrival_missing':
      return timeFields.arrival(issue.position ?? 1);
    case 'departure_missing':
    case 'order':
      return issue.position === null ? timeFields.route : timeFields.departure(issue.position);
    default:
      return timeFields.route;
  }
}

type Numbers = Record<'odometerKm' | 'engineHours' | 'fuelEndLiters', ReadingValue>;

export interface BuiltTimes {
  /** Something time-like was typed: a row with only a time is not a blank row. */
  typed: boolean;
  errors: Record<string, string>;
  /** Keys for the reading: absent keeps, `null` clears, an array replaces the stops (ADR 0163 Р13). */
  keys: { startedAt?: string | null; endedAt?: string | null; points?: ReadingPointInput[] };
}

export function buildTimes(params: {
  item: ReportItemDto;
  value: DraftItem;
  stops: readonly ShownStop[];
  /** The driver's rule judges this line (`lineRequiresDriverTimes`: format and change). */
  required: boolean;
  numbers: Numbers;
}): BuiltTimes {
  const { item, value, stops, required, numbers } = params;
  const errors: Record<string, string> = {};
  const read = (raw: string, field: string): string | null => {
    const time = parseTime(raw);
    if (time !== 'invalid') return time;
    errors[field] = TIME_FORMAT_MESSAGE;
    return null;
  };

  let times: ReadingTimes;
  let keys: BuiltTimes['keys'];
  let typed: boolean;
  if (item.sourceKind === 'esm2') {
    const startedAt = read(value.startedAt, timeFields.startedAt);
    const endedAt = read(value.endedAt, timeFields.endedAt);
    typed = Boolean(value.startedAt.trim() || value.endedAt.trim());
    times = { startedAt, endedAt, points: [] };
    // Sent always, empty as `null`: the form shows the saved pair, so an emptied field is the
    // driver's decision to clear it, not a build that does not know the key.
    keys = { startedAt, endedAt };
  } else if (stops.length > 0) {
    stops.forEach((stop, index) => {
      const own = value.stops[stop.key];
      if (index === 0) read(own?.arrivedAt ?? '', timeFields.arrival(stop.position));
      read(own?.departedAt ?? '', timeFields.departure(stop.position));
    });
    const points = stopPointTimes(stops, value.stops);
    typed = points.some((point) => point.arrivedAt !== null || point.departedAt !== null);
    times = { startedAt: null, endedAt: null, points };
    // An untouched route without saved stops sends no stops at all: an empty set captured now
    // would freeze the request snapshot of a route nobody timed yet.
    const send = typed || (item.reading?.points.length ?? 0) > 0;
    keys = send
      ? {
          points: stops.map((stop, index) => ({
            position: stop.position,
            routePointId: stop.routePointId,
            arrivedAt: points[index]!.arrivedAt,
            departedAt: points[index]!.departedAt,
          })),
        }
      : {};
  } else {
    // A relocation records no time (D8): no fields, no keys, no rule.
    return { typed: false, errors, keys: {} };
  }

  const valid = (number: ReadingValue) => (number === 'invalid' ? null : number);
  const issues = [
    ...readingTimeIssues(item.sourceKind, times),
    ...(required
      ? driverReadingTimeIssues({
          sourceKind: item.sourceKind,
          hasStops: stops.length > 0,
          // The cabinet sends whole shifts only (ADR 0237): the end and every departure are due
          // even when a half-typed block has no evening number yet, so all refusals show at once.
          complete: true,
          values: {
            odometerKm: valid(numbers.odometerKm),
            engineHours: valid(numbers.engineHours),
            fuelEndLiters: valid(numbers.fuelEndLiters),
          },
          times,
        })
      : []),
  ];
  // The first refusal of a field wins: an unreadable time already says what is wrong with it.
  for (const issue of issues) errors[issueField(issue)] ??= issue.message;
  return { typed, errors, keys };
}
