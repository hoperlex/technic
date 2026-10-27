import type { ReadingPointTimes } from './reading-times';
import type { DriverReportState, ReadingKind } from './vehicle-readings';

/**
 * The actual time of a freight request (plan `docs/readings-shifts-merge-plan.md` §8, owner
 * decisions D6, D7, D10, D12): the stops of the request as the driver recorded them and the
 * request's share of the route time.
 *
 * The share is the D6 split (`routeTimeByRequest`) over the request snapshot taken when the stops
 * were captured (`vehicle_reading_point_requests`), never over the live roles: after a rebuild of
 * the route the live points no longer say whose work a recorded stop was. The server reads it; the
 * card shows it and the completion window proposes it, rounded up to a whole hour (D12).
 */

/**
 * Why a freight request has no route time to propose. One list for the card and the completion
 * window, so both explain the missing number with the same words:
 *
 * - `no_readings` — no submitted reading of the request's route yet;
 * - `no_data` — the shift was closed without values (`no_data`), so nothing was timed;
 * - `no_times` — a reading without stop times: recorded before times existed (`v2`) or entered by
 *   staff without them (D5);
 * - `incomplete` — the stops are timed partly: an interim reading, the evening not submitted yet;
 * - `order` — the recorded times do not run in route order (a saved legacy row; the write path
 *   refuses such a set today);
 * - `unassigned` — a recorded stop without any request, or a reading whose stops do not name this
 *   request: the time cannot be split without dropping a part of it (D6).
 */
export const ROUTE_TIME_ISSUES = [
  'no_readings',
  'no_data',
  'no_times',
  'incomplete',
  'order',
  'unassigned',
] as const;
export type RouteTimeIssue = (typeof ROUTE_TIME_ISSUES)[number];

export const routeTimeIssueLabels: Record<RouteTimeIssue, string> = {
  no_readings: 'водитель ещё не сдал показания по рейсу',
  no_data: 'смена рейса закрыта без показаний',
  no_times: 'в показаниях рейса нет времени по точкам',
  incomplete: 'время по точкам записано не полностью',
  order: 'время по точкам идёт не по порядку',
  unassigned: 'точки рейса не связаны с заявкой — время не делится',
};

/** One stop of this request in a recorded route, with the segment D6 gives it. */
export interface RequestRouteStopDto {
  position: number;
  /** The address as the driver saw it: a snapshot that outlives a rebuild of the route. */
  location: string;
  /** The arrival is recorded at stop 1 only — the start of the shift; `null` at any other stop. */
  arrivedAt: string | null;
  /**
   * Where the stop's segment starts (D6): the arrival for stop 1, the departure from the previous
   * stop otherwise. `null` while that time is not recorded.
   */
  segmentFrom: string | null;
  departedAt: string | null;
  /** Requests sharing this stop's segment equally (D6); 1 — the stop is this request's alone. */
  sharedBy: number;
}

/** One recorded route reading that served the request. */
export interface RequestRouteReadingDto {
  readingId: string;
  reportDate: string;
  /** Only the stops of this request, in route order. */
  stops: RequestRouteStopDto[];
  /** The request's share of this reading's route, in seconds; `null` — see `issue`. */
  seconds: number | null;
  issue: RouteTimeIssue | null;
}

/**
 * Who submitted the readings and what they said — for a principal with `vehicleReadings.read`
 * only (D10, docs/access-model.md §9.3). The times and the share above are everyone's: the request
 * reader is billed by them.
 */
export interface RequestRouteReadingDiagnosticsDto {
  readingId: string;
  personName: string;
  reportState: DriverReportState;
  kind: ReadingKind;
  noDataReason: string;
  comment: string;
}

/** `GET /vehicle-requests/:id/route-time`. */
export interface RequestRouteTimeDto {
  readings: RequestRouteReadingDto[];
  /**
   * «Время по заявке»: the request's exact D6 total in seconds over every reading; `null` when any
   * reading cannot be split or none exists — a partial sum would bill less than the work.
   */
  seconds: number | null;
  /** Every reason the total is missing, in the order of `ROUTE_TIME_ISSUES`. */
  issues: RouteTimeIssue[];
  /** Diagnostics, filled only for `vehicleReadings.read`. */
  driver?: { readings: RequestRouteReadingDiagnosticsDto[] } | null;
}

/** A recorded stop with the request snapshot it was captured with. */
export interface RouteStopWithRequests extends ReadingPointTimes {
  location: string;
  requestIds: readonly string[];
}

/**
 * The stops of one request in a recorded route, each with the start of its D6 segment: the arrival
 * for stop 1, otherwise the departure from the previous stop. The same boundaries
 * `routeTimeByRequest` splits by, so the card shows the segments the share was counted from.
 */
export function requestRouteStops(
  points: readonly RouteStopWithRequests[],
  requestId: string,
): RequestRouteStopDto[] {
  const stops: RequestRouteStopDto[] = [];
  points.forEach((point, index) => {
    const shared = new Set(point.requestIds);
    if (!shared.has(requestId)) return;
    stops.push({
      position: point.position,
      location: point.location,
      arrivedAt: index === 0 ? point.arrivedAt : null,
      segmentFrom: index === 0 ? point.arrivedAt : points[index - 1]!.departedAt,
      departedAt: point.departedAt,
      sharedBy: shared.size,
    });
  });
  return stops;
}

const SECONDS_PER_HOUR = 3600;

/**
 * Billed hours of a freight request (D12): its exact D6 total rounded UP to a whole hour, after
 * summing — 2 h 10 min is 3 h, exactly 2 h stays 2 h. Never per segment or per reading: rounding the
 * parts would bill a request with many short stops for hours nobody worked.
 */
export function routeHoursForCompletion(seconds: number): number {
  return Math.ceil(seconds / SECONDS_PER_HOUR);
}

/** «2 ч 10 мин», «45 мин», «3 ч» — the exact total as the card and the window show it. */
export function routeDurationLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return seconds > 0 ? 'меньше минуты' : '0 мин';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** What the completion window of a freight request starts from (D7, D12). */
export type RouteTimePrefill =
  | { ok: true; hours: number; seconds: number }
  | { ok: false; reason: string };

/**
 * The completion prefill of a freight request: unit "hours" and the request's route time rounded
 * up (D12), or the reason there is none. The window still lets the dispatcher change the amount:
 * the carrier's invoice may differ, and the completion must match the invoice (ADR 0029).
 *
 * A zero share proposes nothing: a completion of zero hours is refused, and "0 h" from the times
 * would only hide that the stops were recorded as instantaneous.
 */
export function routeTimePrefill(time: RequestRouteTimeDto): RouteTimePrefill {
  if (time.seconds === null) {
    return { ok: false, reason: routeTimeIssueLabels[time.issues[0] ?? 'no_readings'] };
  }
  const hours = routeHoursForCompletion(time.seconds);
  if (hours <= 0) return { ok: false, reason: 'по точкам заявке не досталось времени' };
  return { ok: true, hours, seconds: time.seconds };
}
