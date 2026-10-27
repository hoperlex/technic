import {
  normalizeTimeInput,
  routeElapsed,
  routeScalarTimes,
  routeTimeByRequest,
  type DriverAssignmentAction,
  type DriverAssignmentEntry,
  type ReadingPointTimes,
  type ReportItemDto,
} from '@technic/contracts';
import type { DraftItem, DraftStopTimes } from './api';

/**
 * Stops of a route item as the form shows them and the submit sends them back (ADR 0234; plan
 * `docs/readings-shifts-merge-plan.md` §7.4, owner decisions D6, D8, D9).
 *
 * Which stops: the reading's SAVED stops once it has them, otherwise the live stops of the task.
 * The server compares a first capture with the live route and every later edit with the saved set
 * by position, so the form has to send back exactly the set the server will compare with. After a
 * route rebuild the saved set is the only true one: the live task already shows the new plan.
 */

/** A stop on screen. */
export interface ShownStop {
  /** Key of the stop's times in the draft (`DraftItem.stops`), see `stopKey`. */
  key: string;
  /** 1..N among the shown stops: the reading point's position, not the route point's own. */
  position: number;
  routePointId: string | null;
  location: string;
  /** Planned arrival «08:30» or empty: what the dispatcher asked for, next to what happened. */
  plannedTime: string;
  /** What is done here, from the live task; empty for a saved stop whose point was rebuilt away. */
  actions: DriverAssignmentAction[];
}

/**
 * The draft key of a stop's times: the route point id, or the position of a saved stop that lost
 * its point in a rebuild. Never the bare order — a rebuilt route would move a typed time to the
 * stop that now stands in its place.
 */
export const stopKey = (point: { routePointId: string | null; position: number }): string =>
  point.routePointId ?? `position:${point.position}`;

export function stopsOf(item: ReportItemDto, entry: DriverAssignmentEntry | null): ShownStop[] {
  if (item.sourceKind !== 'route') return [];
  const live = entry?.points ?? [];
  const saved = item.reading?.points ?? [];
  if (saved.length > 0) {
    return saved.map((point) => {
      const match = live.find((stop) => stop.id === point.routePointId);
      return {
        key: stopKey(point),
        position: point.position,
        routePointId: point.routePointId,
        location: point.location,
        plannedTime: match?.arrivalTime ?? '',
        actions: match?.actions ?? [],
      };
    });
  }
  return live.map((point, index) => ({
    key: point.id,
    position: index + 1,
    routePointId: point.id,
    location: point.location,
    plannedTime: point.arrivalTime,
    actions: point.actions,
  }));
}

/** A typed time as the rules read it: `HH:mm`, `null` when empty, `'invalid'` when unreadable. */
export function parseTime(raw: string): string | null | 'invalid' {
  if (!raw.trim()) return null;
  return normalizeTimeInput(raw) ?? 'invalid';
}

/** Typed stop times in the shape the contract rules read; an unreadable time counts as missing. */
export function stopPointTimes(
  stops: readonly ShownStop[],
  times: Readonly<Record<string, DraftStopTimes>>,
): ReadingPointTimes[] {
  const valid = (raw: string | undefined) => {
    const time = parseTime(raw ?? '');
    return time === 'invalid' ? null : time;
  };
  return stops.map((stop, index) => ({
    position: stop.position,
    arrivedAt: index === 0 ? valid(times[stop.key]?.arrivedAt) : null,
    departedAt: valid(times[stop.key]?.departedAt),
  }));
}

/**
 * Typed stop times in words, in route order and by stop number: «точка 1: 07:40–08:30». A time
 * whose stop is not shown any more (the route was rebuilt) still reads, after the shown ones and
 * without a number — it is the person's input, and only its stop is gone.
 */
export function stopTimesText(item: DraftItem, stops: readonly ShownStop[]): string[] {
  const text = (times: DraftStopTimes) =>
    [times.arrivedAt, times.departedAt].filter(Boolean).join('–');
  const known = new Set(stops.map((stop) => stop.key));
  const shown = stops.flatMap((stop) => {
    const times = item.stops[stop.key];
    return times && text(times) ? [`точка ${stop.position}: ${text(times)}`] : [];
  });
  const rest = Object.entries(item.stops)
    .filter(([key, times]) => !known.has(key) && text(times))
    .map(([, times]) => `точка: ${text(times)}`);
  return [...shown, ...rest];
}

/**
 * The request an action serves, as a label: «ТС-40» of «ТС-40/2» and of «ТС-77 · 12.08». The task
 * carries no request id (the cabinet gets no directory ids), and the label is enough for a preview:
 * two trips of one request share one label, as they share one request in the server's snapshot.
 */
export function requestLabelOf(action: DriverAssignmentAction): string {
  return action.displayNumber.split(/\/| · /u)[0] ?? action.displayNumber;
}

/** «Время по заявкам» of the route block, or why it cannot be counted yet. */
export type RouteSummary =
  | {
      kind: 'ok';
      /** Requests in the order the route first meets them, with their minutes. */
      requests: { label: string; minutes: number }[];
      shift: { from: string; to: string; minutes: number };
      /** Stops served for several requests: the segment is split equally (D6). */
      shared: { position: number; shareMinutes: number }[];
    }
  | { kind: 'incomplete' | 'order' | 'unassigned' };

/**
 * The live preview of the D6 split while the driver types. The split itself is the contract's
 * `routeTimeByRequest` — the server's stage 3 reads the same function — and only its wording is
 * here. A stop without an action (a saved stop whose point was rebuilt away) has no request, and
 * the split refuses rather than drops its time.
 */
export function routeSummary(
  stops: readonly ShownStop[],
  times: Readonly<Record<string, DraftStopTimes>>,
): RouteSummary {
  const points = stopPointTimes(stops, times);
  const labels = new Map(
    stops.map((stop) => [stop.position, [...new Set(stop.actions.map(requestLabelOf))]]),
  );
  const split = routeTimeByRequest(points, labels);
  if (!split.ok) return { kind: split.reason };
  const { startedAt, endedAt } = routeScalarTimes(points);
  const order = [...new Set(stops.flatMap((stop) => labels.get(stop.position) ?? []))];
  // A shared stop's segment is the growth of the elapsed time over the route's prefix: the same
  // contract function measures both, so the note cannot disagree with the totals above it.
  const elapsedTo = (count: number) =>
    count === 0 ? 0 : (routeElapsed(points.slice(0, count)).minutes ?? 0);
  const shared = stops.flatMap((stop, index) => {
    const count = labels.get(stop.position)?.length ?? 0;
    if (count < 2) return [];
    const segment = elapsedTo(index + 1) - elapsedTo(index);
    return [{ position: stop.position, shareMinutes: segment / count }];
  });
  return {
    kind: 'ok',
    requests: order.map((label) => ({ label, minutes: (split.byRequest[label] ?? 0) / 60 })),
    shift: { from: startedAt ?? '', to: endedAt ?? '', minutes: split.totalSeconds / 60 },
    shared,
  };
}
