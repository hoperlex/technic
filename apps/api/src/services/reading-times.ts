import { eq } from 'drizzle-orm';
import {
  routeScalarTimes,
  type ReadingInput,
  type ReadingPointInput,
  type ReadingSourceKind,
  type ReadingTimes,
  type VehicleReadingPointDto,
} from '@technic/contracts';
import {
  vehicleReadingPointRequests,
  vehicleReadingPoints,
  type VehicleReadingRow,
} from '../db/schema';
import { err } from '../lib/errors';
import { loadReadingStops } from './driver-assignment';
import type { Tx } from './readings-chain';
import { clockTime, type StoredPoint } from './reading-points';

/*
 * The read side lives in `reading-points.ts`: readers of the request day import it without pulling
 * the write path and its database client along. Re-exported so the write path's callers keep one
 * address.
 */
export { clockTime, loadReadingPoints, type StoredPoint } from './reading-points';

/**
 * Write side of the shift and stop times of a reading (ADR 0234, migration 0389). The
 * rules themselves — order, requiredness, the D6 split — live in `@technic/contracts`
 * (`reading-times.ts`); this file only resolves the wire keys against what is saved and moves rows.
 */

/** The times of a reading as they are about to be written. */
export interface ResolvedReadingTimes {
  startedAt: string | null;
  endedAt: string | null;
  points: StoredPoint[];
}

/** The rules read times only; the address and the snapshot do not take part in them. */
export function timesOf(resolved: ResolvedReadingTimes): ReadingTimes {
  return {
    startedAt: resolved.startedAt,
    endedAt: resolved.endedAt,
    points: resolved.points.map(({ position, arrivedAt, departedAt }) => ({
      position,
      arrivedAt,
      departedAt,
    })),
  };
}

export function pointDto(point: StoredPoint): VehicleReadingPointDto {
  return {
    position: point.position,
    routePointId: point.routePointId,
    location: point.location,
    arrivedAt: point.arrivedAt,
    departedAt: point.departedAt,
  };
}

/**
 * Replaces the stop set of a reading in the transaction that writes its scalar columns (Q2): the
 * derived pair and the stops it was derived from never exist apart. Request rows go with their
 * stop through the cascade and come back from the resolved snapshot.
 */
export async function writeReadingPoints(
  tx: Tx,
  readingId: string,
  points: readonly StoredPoint[],
): Promise<void> {
  await tx.delete(vehicleReadingPoints).where(eq(vehicleReadingPoints.readingId, readingId));
  if (points.length === 0) return;
  await tx.insert(vehicleReadingPoints).values(
    points.map((point) => ({
      readingId,
      position: point.position,
      routePointId: point.routePointId,
      location: point.location,
      arrivedAt: point.arrivedAt,
      departedAt: point.departedAt,
    })),
  );
  const requests = points.flatMap((point) =>
    point.requestIds.map((requestId) => ({ readingId, position: point.position, requestId })),
  );
  if (requests.length > 0) await tx.insert(vehicleReadingPointRequests).values(requests);
}

/**
 * Applies the submitted keys to the saved times: an absent key keeps, `null` clears, a stop array
 * replaces the whole set (ADR 0163 Р13 precedent). The rules then read the RESOLVED value, never the
 * incoming fragment alone — an evening submit that sends only the end time is checked against the
 * start sent in the morning.
 *
 * The stop set has two lives. Its first capture is compared with the live route under the route
 * lock the submit already holds (`lockSources`), and the served requests of every stop are
 * snapshotted then — for the garage's staff entry exactly as for the cabinet: both send back the
 * live stops the report item names (`ReportItemDto.stops`), and only requiredness is the actor's. Every later edit addresses the SAVED stops by position: after a rebuild the
 * live point ids are gone (`ON DELETE SET NULL`), and staff still correct the times the driver
 * recorded without inheriting the new plan's allocation. Moving such a reading onto the new plan is
 * explicit: clear the stops, then capture them again.
 */
export async function resolveReadingTimes(
  tx: Tx,
  params: {
    sourceKind: ReadingSourceKind;
    routeId: string | null;
    reading: ReadingInput;
    existing: VehicleReadingRow | null;
    saved: readonly StoredPoint[];
  },
): Promise<ResolvedReadingTimes> {
  const { sourceKind, routeId, reading, existing, saved } = params;
  // A shift closed without values was not timed either: the times go with the numbers.
  if (reading.kind === 'no_data') return { startedAt: null, endedAt: null, points: [] };

  if (sourceKind === 'esm2') {
    if (reading.points && reading.points.length > 0) {
      throw err.badRequest(
        'У недельного листа остановок нет: время записывается началом и концом смены',
      );
    }
    return {
      startedAt:
        reading.startedAt === undefined
          ? clockTime(existing?.startedAt ?? null)
          : reading.startedAt,
      endedAt:
        reading.endedAt === undefined ? clockTime(existing?.endedAt ?? null) : reading.endedAt,
      points: [],
    };
  }

  const points = await resolveRoutePoints(tx, routeId, reading.points, saved);
  const derived = routeScalarTimes(points);
  // The pair of a route is derived; a typed pair that disagrees with the stops would make the
  // scalar columns and the stop rows two answers to one question.
  if (
    (reading.startedAt !== undefined && reading.startedAt !== derived.startedAt) ||
    (reading.endedAt !== undefined && reading.endedAt !== derived.endedAt)
  ) {
    throw err.badRequest(
      'Время рейса задаётся по остановкам: прибытие на первую и отправление с последней',
    );
  }
  return { ...derived, points };
}

async function resolveRoutePoints(
  tx: Tx,
  routeId: string | null,
  input: readonly ReadingPointInput[] | null | undefined,
  saved: readonly StoredPoint[],
): Promise<StoredPoint[]> {
  if (input === undefined) return [...saved];
  if (input === null || input.length === 0) return [];

  if (saved.length > 0) {
    const matches =
      input.length === saved.length &&
      input.every((point, index) => {
        const stored = saved[index]!;
        return (
          point.position === stored.position &&
          (stored.routePointId === null || point.routePointId === stored.routePointId)
        );
      });
    if (!matches) {
      throw err.conflict(
        'Остановки рейса изменились после записи времени: время правится по сохранённым остановкам — обновите страницу',
      );
    }
    return saved.map((stored, index) => ({
      ...stored,
      arrivedAt: input[index]!.arrivedAt,
      departedAt: input[index]!.departedAt,
    }));
  }

  if (routeId === null)
    throw err.badRequest('У строки нет рейса — остановкам не к чему относиться');
  const live = await loadReadingStops(tx, routeId);
  const matches =
    input.length === live.length &&
    input.every((point, index) => point.routePointId === live[index]!.routePointId);
  if (!matches) {
    throw err.conflict('Остановки рейса изменились — обновите задание и повторите');
  }
  return live.map((stop, index) => ({
    position: index + 1,
    routePointId: stop.routePointId,
    location: stop.location,
    arrivedAt: input[index]!.arrivedAt,
    departedAt: input[index]!.departedAt,
    requestIds: [...stop.requestIds].sort(),
  }));
}

/** Whether a route item expects stops: the saved set if any, otherwise the live route. */
export async function routeHasStops(
  tx: Tx,
  routeId: string | null,
  resolved: readonly StoredPoint[],
): Promise<boolean> {
  if (resolved.length > 0) return true;
  if (routeId === null) return false;
  return (await loadReadingStops(tx, routeId)).length > 0;
}

/**
 * Times in the reading's history and change detection: the scalar pair, every stop with its
 * address, live reference and request snapshot. A time-only edit therefore changes the snapshot,
 * raises `content_version` and reopens an accepted report — times are content, as numbers are.
 */
export function timesSnapshot(resolved: ResolvedReadingTimes) {
  return {
    startedAt: resolved.startedAt,
    endedAt: resolved.endedAt,
    points: resolved.points.map((point) => ({
      position: point.position,
      routePointId: point.routePointId,
      location: point.location,
      arrivedAt: point.arrivedAt,
      departedAt: point.departedAt,
      requestIds: point.requestIds,
    })),
  };
}
