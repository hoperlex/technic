import { z } from 'zod';
import { uuidSchema } from './common';
import type { DriverReportFormat, ReadingSourceKind } from './driver-cabinet';
import { minutesToTime, TIME_FORMAT_MESSAGE, TIME_PATTERN, timeToMinutes } from './time';
import { shiftSpanMinutes } from './vehicle-request-shifts';

/**
 * Shift and stop times of a vehicle reading (ADR 0234, plan `docs/readings-shifts-merge-plan.md`
 * §7, owner decisions D5, D6, D8, D11).
 *
 * Every rule about these times lives here because both sides ask it: the driver cabinet previews it
 * while the driver types, the readings service enforces it on submit. A copy on either side would
 * drift, and the driver would be told one thing by the form and another by the server.
 *
 * Three shapes, by source:
 *
 * - an ESM-2 item has a start/end pair typed by the driver;
 * - a route item with stops has stop times: the arrival at stop 1 (the start of the shift) and a
 *   departure from every stop (the last one is the end). Its scalar pair is derived from the stops,
 *   never typed separately (`routeScalarTimes`);
 * - a relocation (a route without stops, D8) records no time at all.
 */

const MINUTES_PER_DAY = 24 * 60;

/** Stops of one reading: the same ceiling as route points (`vehicle_route_points_position_check`). */
export const READING_POINTS_MAX = 20;

/** A clock time `HH:mm` as the driver or staff typed it; the day is the reading's own day. */
export const readingTimeSchema = z.string().trim().regex(TIME_PATTERN, TIME_FORMAT_MESSAGE);

/**
 * One recorded stop on the wire.
 *
 * `position` is the stop's place among the stops of this reading, 1..N without gaps, in route
 * order — not the route point's own `position`, which has gaps where the task leaves out a point of
 * cancelled requests. `routePointId` names the live point the driver saw (`DriverAssignmentPoint.id`);
 * it is `null` for a saved stop whose live point was rebuilt away, and staff correct such a stop by
 * its position.
 *
 * The time keys default to `null` inside a stop: a point array always replaces the whole set, so a
 * missing key inside it means "no time", not "keep".
 */
export const readingPointInputSchema = z.object({
  position: z.number().int().min(1).max(READING_POINTS_MAX),
  routePointId: uuidSchema.nullable(),
  arrivedAt: readingTimeSchema.nullable().default(null),
  departedAt: readingTimeSchema.nullable().default(null),
});
export type ReadingPointInput = z.infer<typeof readingPointInputSchema>;

/**
 * The whole stop set of a reading. Positions run 1..N in order, so a missing or repeated stop is a
 * malformed body rather than something the server reorders; only stop 1 may carry an arrival —
 * every later stop starts where the previous departure ended (D6).
 */
export const readingPointsInputSchema = z
  .array(readingPointInputSchema)
  .max(READING_POINTS_MAX)
  .superRefine((points, ctx) => {
    points.forEach((point, index) => {
      if (point.position !== index + 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'Остановки нумеруются подряд с первой',
          path: [index, 'position'],
        });
      }
      if (index > 0 && point.arrivedAt !== null) {
        ctx.addIssue({
          code: 'custom',
          message: 'Время прибытия отмечается только на первой точке',
          path: [index, 'arrivedAt'],
        });
      }
    });
  });

/** A recorded stop as every reader receives it. Times are `HH:mm` or `null`. */
export interface VehicleReadingPointDto {
  position: number;
  routePointId: string | null;
  /** The address as the driver saw it: a snapshot that outlives a rebuild of the route. */
  location: string;
  arrivedAt: string | null;
  departedAt: string | null;
}

/** Times of one stop: what every rule below reads, whatever the source of the stop. */
export interface ReadingPointTimes {
  position: number;
  arrivedAt: string | null;
  departedAt: string | null;
}

/** The resolved times of a reading: saved values with the submitted keys applied. */
export interface ReadingTimes {
  startedAt: string | null;
  endedAt: string | null;
  points: readonly ReadingPointTimes[];
}

export const READING_TIME_ISSUE_CODES = [
  'start_missing',
  'end_missing',
  'equal_times',
  'arrival_missing',
  'departure_missing',
  'order',
  'too_long',
  'points_not_allowed',
] as const;
export type ReadingTimeIssueCode = (typeof READING_TIME_ISSUE_CODES)[number];

/**
 * What is wrong with the times, with a ready sentence. `position` names the stop the issue belongs
 * to, so the cabinet can put the message under the right field; `null` — the shift as a whole.
 */
export interface ReadingTimeIssue {
  code: ReadingTimeIssueCode;
  message: string;
  position: number | null;
}

/**
 * Whether the reading carries an end-of-shift value: odometer, engine hours or the fuel left at the
 * end. It is the cabinet's "the evening part is filled" signal (ADR 0163, plan Р8), and D11 makes it
 * the moment the end time becomes required: no explicit finish action exists.
 */
export function readingHasShiftEnd(values: {
  odometerKm: number | null;
  engineHours: number | null;
  fuelEndLiters?: number | null;
}): boolean {
  return (
    values.odometerKm !== null ||
    values.engineHours !== null ||
    (values.fuelEndLiters !== undefined && values.fuelEndLiters !== null)
  );
}

function minutesOf(time: string | null): number | null {
  if (time === null) return null;
  return timeToMinutes(time) ?? null;
}

/** The clock marks of a route in order: arrival at stop 1, then each stop's departure. */
function routeMarks(points: readonly ReadingPointTimes[]): { minute: number; position: number }[] {
  const marks: { minute: number; position: number }[] = [];
  points.forEach((point, index) => {
    const arrival = index === 0 ? minutesOf(point.arrivedAt) : null;
    if (arrival !== null) marks.push({ minute: arrival, position: point.position });
    const departure = minutesOf(point.departedAt);
    if (departure !== null) marks.push({ minute: departure, position: point.position });
  });
  return marks;
}

/**
 * Elapsed time of a route, in minutes: the sum of its consecutive steps. An equal next time is a
 * zero step, a smaller one is the single allowed midnight wrap, and the whole route fits in 24 h.
 *
 * Steps, not "last minus first": the pair reading (`shiftSpanMinutes`) gives 24 h for equal clock
 * times, while a route whose every step is zero lasted no time at all — only the sequence tells
 * them apart. `minutes` is `null` until the route is complete (arrival at stop 1 and every
 * departure); a gap in the middle is still checked for order on the times that are present.
 */
export function routeElapsed(points: readonly ReadingPointTimes[]): {
  minutes: number | null;
  issue: ReadingTimeIssue | null;
} {
  const marks = routeMarks(points);
  let total = 0;
  let wraps = 0;
  for (let i = 1; i < marks.length; i += 1) {
    const step = marks[i]!.minute - marks[i - 1]!.minute;
    if (step < 0) wraps += 1;
    if (wraps > 1) {
      return {
        minutes: null,
        issue: {
          code: 'order',
          message:
            'Время отправления идёт по порядку остановок: через полночь — не больше одного раза',
          position: marks[i]!.position,
        },
      };
    }
    total += step < 0 ? step + MINUTES_PER_DAY : step;
  }
  if (total > MINUTES_PER_DAY) {
    return {
      minutes: null,
      issue: {
        code: 'too_long',
        message: 'От прибытия на первую точку до отправления с последней — не больше 24 часов',
        position: null,
      },
    };
  }
  const complete =
    points.length > 0 &&
    minutesOf(points[0]!.arrivedAt) !== null &&
    points.every((point) => minutesOf(point.departedAt) !== null);
  return { minutes: complete ? total : null, issue: null };
}

/**
 * The scalar pair of a route reading, derived from its stops (Q2: kept on every reading, written in
 * the same transaction as the stops). The start is the arrival at stop 1; the end is the departure
 * from the last stop once every stop has one, so a present pair always means a complete route.
 */
export function routeScalarTimes(points: readonly ReadingPointTimes[]): {
  startedAt: string | null;
  endedAt: string | null;
} {
  const first = points[0];
  const startedAt = first?.arrivedAt ?? null;
  const complete = points.length > 0 && points.every((point) => point.departedAt !== null);
  return {
    startedAt,
    endedAt: startedAt !== null && complete ? points[points.length - 1]!.departedAt : null,
  };
}

/**
 * Shift duration of a reading in minutes, or `null` while the times are incomplete. One answer for
 * every reader (the readings book, stage 3 of the plan): an ESM-2 pair through `shiftSpanMinutes`,
 * a route through its steps.
 */
export function readingShiftMinutes(
  sourceKind: ReadingSourceKind,
  times: ReadingTimes,
): number | null {
  if (sourceKind === 'esm2') return shiftSpanMinutes(times.startedAt, times.endedAt);
  if (times.points.length === 0) return null;
  return routeElapsed(times.points).minutes;
}

/**
 * The same duration in hours to two decimals — the «Длительность, ч» column of every readings
 * book, rounded as the site's pair is (`shiftSpanHours`). `null` while the times are incomplete:
 * an interim reading has no duration yet, and a zero would read as "did not work".
 */
export function readingShiftHours(
  sourceKind: ReadingSourceKind,
  times: ReadingTimes,
): number | null {
  const minutes = readingShiftMinutes(sourceKind, times);
  return minutes === null ? null : Math.round((minutes / 60) * 100) / 100;
}

/**
 * Shape and order of the times, for every author: the driver, staff entering on a driver's behalf
 * and staff correcting a saved reading. Required fields are not checked here — staff may leave
 * every time empty (D5); `driverReadingTimeIssues` adds the driver's rule on top.
 */
export function readingTimeIssues(
  sourceKind: ReadingSourceKind,
  times: ReadingTimes,
): ReadingTimeIssue[] {
  if (sourceKind === 'esm2') {
    const issues: ReadingTimeIssue[] = [];
    if (times.points.length > 0) {
      issues.push({
        code: 'points_not_allowed',
        message: 'У недельного листа остановок нет: время записывается началом и концом смены',
        position: null,
      });
    }
    if (times.endedAt !== null && times.startedAt === null) {
      issues.push({ code: 'start_missing', message: 'Укажите время начала смены', position: null });
    }
    return issues;
  }
  const { issue } = routeElapsed(times.points);
  return issue ? [issue] : [];
}

/**
 * The driver's requiredness (D11): "finished" is derived from the evening values, not from a
 * button.
 *
 * - Every driver submit of an ESM-2 item carries the start time; of a route item with stops, the
 *   arrival at stop 1. A morning-only interim reading therefore has its start already.
 * - A submit that carries an end-of-shift value (`readingHasShiftEnd`) also carries the end time,
 *   or every departure of a route.
 * - The driver's ESM-2 pair may not have equal start and end: `shiftSpanMinutes` would read it as
 *   24 h, and asking is cheaper than guessing (plan §7.2).
 *
 * A relocation (`hasStops = false` on a route) and a `no_data` reading need no time and are not
 * passed here. Applies only to reports opened under the `v3` draft format: a `v2` report finishes
 * under the rules it was opened with.
 */
export function driverReadingTimeIssues(params: {
  sourceKind: ReadingSourceKind;
  /** A route item whose task has stops; ignored for an ESM-2 item. */
  hasStops: boolean;
  values: { odometerKm: number | null; engineHours: number | null; fuelEndLiters?: number | null };
  times: ReadingTimes;
}): ReadingTimeIssue[] {
  const { sourceKind, hasStops, values, times } = params;
  const ended = readingHasShiftEnd(values);
  const issues: ReadingTimeIssue[] = [];
  if (sourceKind === 'esm2') {
    if (times.startedAt === null) {
      issues.push({ code: 'start_missing', message: 'Укажите время начала смены', position: null });
    }
    if (ended && times.endedAt === null) {
      issues.push({
        code: 'end_missing',
        message: 'Переданы показания конца смены — укажите время её окончания',
        position: null,
      });
    }
    if (times.startedAt !== null && times.startedAt === times.endedAt) {
      issues.push({
        code: 'equal_times',
        message: 'Начало и конец смены совпадают',
        position: null,
      });
    }
    return issues;
  }
  if (!hasStops) return issues;
  if ((times.points[0]?.arrivedAt ?? null) === null) {
    issues.push({
      code: 'arrival_missing',
      message: 'Укажите время прибытия на первую точку',
      position: 1,
    });
  }
  if (ended) {
    for (const point of times.points) {
      if (point.departedAt !== null) continue;
      issues.push({
        code: 'departure_missing',
        message: `Переданы показания конца смены — укажите время отправления с точки ${point.position}`,
        position: point.position,
      });
    }
  }
  return issues;
}

/**
 * Whether the driver's time rule (`driverReadingTimeIssues`) applies to a report: every format from
 * `v3` on, while a `v2` report opened before the release finishes under the rules it was opened with
 * (ADR 0234, decision 6). The cabinet previews the rule by the report's STORED format, not by its
 * own build: a new build finishing an old `v2` report must not refuse what the server accepts.
 */
export function reportRequiresDriverTimes(format: DriverReportFormat): boolean {
  return format !== 'v2';
}

/**
 * Whether the driver's time rule applies to ONE line of a driver's submit: the report's format asks
 * for it and the line is the driver's own word in this submit — a new reading, or a saved one whose
 * content changes. A line resent unchanged is not judged again.
 *
 * The cabinet sends back every block that has a reading. Without this condition a reading staff
 * entered without times (D5 allows it) or a reading a rebase moved into the day would hold the
 * driver's whole day until he made up times for a row he never wrote — the same "one foreign block
 * must not hold the day" rule the cabinet keeps for a staff `no_data` line. Shape and order
 * (`readingTimeIssues`) still apply to every line.
 *
 * "Changes" is the readings service's content comparison (numbers to the column's tenth, times,
 * stops, comment; files never count); the cabinet previews it against the saved reading.
 */
export function lineRequiresDriverTimes(format: DriverReportFormat, changed: boolean): boolean {
  return changed && reportRequiresDriverTimes(format);
}

/** Route time split by request (D6): seconds per request id, or why it cannot be split. */
export type RouteTimeAllocation =
  | { ok: true; totalSeconds: number; byRequest: Record<string, number> }
  | { ok: false; reason: 'incomplete' | 'order' | 'unassigned' };

/**
 * The D6 split of a route's time between requests.
 *
 * The segment from the previous departure (the arrival for stop 1) to the departure from a stop
 * belongs to the requests that have a role at that stop, in equal shares. Shares are over DISTINCT
 * request ids: two trips of one request at one stop are one share. The split is in integer seconds,
 * and the indivisible remainder goes one second at a time to the requests in ascending id order, so
 * the per-request totals add up exactly to the route's duration. Rounding for display or billing
 * happens only after summing per request (D12), never per segment.
 *
 * A stop without any request is `unassigned` and blocks the whole allocation: dropping its time
 * would make the requests' sum disagree with the shift. `requestIdsByPosition` comes from the
 * request snapshot taken at capture (`vehicle_reading_point_requests`), never from live roles.
 */
export function routeTimeByRequest(
  points: readonly ReadingPointTimes[],
  requestIdsByPosition: ReadonlyMap<number, readonly string[]>,
): RouteTimeAllocation {
  if (points.length === 0) return { ok: false, reason: 'incomplete' };
  const elapsed = routeElapsed(points);
  if (elapsed.issue) return { ok: false, reason: 'order' };
  if (elapsed.minutes === null) return { ok: false, reason: 'incomplete' };

  const byRequest: Record<string, number> = {};
  let previous = minutesOf(points[0]!.arrivedAt)!;
  for (const point of points) {
    const ids = [...new Set(requestIdsByPosition.get(point.position) ?? [])].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (ids.length === 0) return { ok: false, reason: 'unassigned' };
    const departure = minutesOf(point.departedAt)!;
    const minutes =
      departure >= previous ? departure - previous : departure + MINUTES_PER_DAY - previous;
    const seconds = minutes * 60;
    const share = Math.floor(seconds / ids.length);
    const remainder = seconds - share * ids.length;
    ids.forEach((id, index) => {
      byRequest[id] = (byRequest[id] ?? 0) + share + (index < remainder ? 1 : 0);
    });
    previous = departure;
  }
  return { ok: true, totalSeconds: elapsed.minutes * 60, byRequest };
}

/**
 * Why a request day has no single shift time from the driver (plan §8, stage 3):
 *
 * - `incomplete` — some reading of the day has no complete pair (a morning-only interim reading, a
 *   legacy `v2` reading recorded before times existed, a relocation without stops);
 * - `ambiguous` — the readings do not fold into one interval of the ordered day: their unfolded
 *   span is longer than 24 h, or it is empty and the site's pair would read equal clock times as a
 *   whole day (`shiftSpanMinutes`).
 *
 * Either way the site types the time itself; the portal never fabricates an interval.
 */
export const DRIVER_DAY_TIME_ISSUES = ['incomplete', 'ambiguous'] as const;
export type DriverDayTimeIssue = (typeof DRIVER_DAY_TIME_ISSUES)[number];

export const driverDayTimeIssueLabels: Record<DriverDayTimeIssue, string> = {
  incomplete: 'время смены записано не во всех показаниях дня',
  ambiguous: 'интервалы водителя не складываются в одну смену — время указывает объект',
};

/** One driver interval of a day, as clock times; the end may be on the next calendar day. */
export interface ShiftInterval {
  startedAt: string;
  endedAt: string;
}

/** The driver's time of a request day: one interval when it is unambiguous, and every interval. */
export interface DriverDayTime {
  /** The single interval of the day; `null` — no reading has times, or `issue` says why not. */
  startedAt: string | null;
  endedAt: string | null;
  /** Every complete pair of the day, in unfolded start order — shown when they cannot be merged. */
  intervals: ShiftInterval[];
  issue: DriverDayTimeIssue | null;
}

/**
 * The shift time of a request day from its readings (plan §8): an ESM-2 item's pair, a route
 * item's arrival at stop 1 and departure from the last stop.
 *
 * Every reading of the day starts on the day itself (`report_date`), so a start is unfolded as a
 * minute of that day and its end as the start plus the reading's own duration — the one duration
 * rule (`readingShiftMinutes`), which reads an ESM-2 end earlier than its start as the next day and
 * a route by its steps. The day's interval is the earliest start to the latest end, but only when
 * that span fits one ordered day with at most one midnight wrap (0 < span ≤ 24 h). Several
 * readings that do not fit are shown as they are and the site types the time: one invented
 * interval would put a shift under the signature that nobody worked.
 *
 * A day without readings has no time and no issue; a reading without a complete pair makes the
 * whole day `incomplete` — a partial union would claim a shift shorter than the work.
 */
export function driverDayTime(
  readings: readonly { sourceKind: ReadingSourceKind; times: ReadingTimes }[],
): DriverDayTime {
  const unfolded: { from: number; to: number; pair: ShiftInterval }[] = [];
  let complete = true;
  for (const { sourceKind, times } of readings) {
    const from = minutesOf(times.startedAt);
    const minutes = readingShiftMinutes(sourceKind, times);
    if (from === null || times.endedAt === null || minutes === null) {
      complete = false;
      continue;
    }
    unfolded.push({
      from,
      to: from + minutes,
      pair: { startedAt: times.startedAt!, endedAt: times.endedAt },
    });
  }
  unfolded.sort((a, b) => a.from - b.from || a.to - b.to);
  const intervals = unfolded.map((u) => u.pair);
  const none = { startedAt: null, endedAt: null, intervals };
  if (readings.length === 0) return { ...none, issue: null };
  if (!complete) return { ...none, issue: 'incomplete' };
  const from = unfolded[0]!.from;
  const to = Math.max(...unfolded.map((u) => u.to));
  if (to - from <= 0 || to - from > MINUTES_PER_DAY) return { ...none, issue: 'ambiguous' };
  return {
    startedAt: minutesToTime(from),
    endedAt: minutesToTime(to),
    intervals,
    issue: null,
  };
}
