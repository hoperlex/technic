import { asc, inArray } from 'drizzle-orm';
import type { VehicleReadingPointDto } from '@technic/contracts';
import type { db } from '../db/client';
import { vehicleReadingPointRequests, vehicleReadingPoints } from '../db/schema';
import type { Tx } from './readings-chain';

/**
 * The read side of a reading's stops (ADR 0234): the saved stops with the request snapshot they were
 * captured with. Apart from `reading-times.ts` because the readers of a request day — the shift
 * table and the freight route time — must not import the write path: it brings the database client
 * at module load, and the pure rule tests of those readers load without an environment.
 */

type Reader = Tx | typeof db;

/** A saved stop with the request snapshot it was captured with. */
export interface StoredPoint extends VehicleReadingPointDto {
  /** Distinct request ids served at the stop at capture, sorted; kept through every time edit. */
  requestIds: string[];
}

/** `time` comes back from PostgreSQL as `HH:mm:ss`; the portal speaks `HH:mm` everywhere. */
export function clockTime(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

/** Saved stops of several readings, two queries for any number of them. */
export async function loadReadingPoints(
  reader: Reader,
  readingIds: readonly string[],
): Promise<Map<string, StoredPoint[]>> {
  const ids = [...new Set(readingIds)];
  const result = new Map<string, StoredPoint[]>();
  if (ids.length === 0) return result;
  const [points, requests] = await Promise.all([
    reader
      .select()
      .from(vehicleReadingPoints)
      .where(inArray(vehicleReadingPoints.readingId, ids))
      .orderBy(asc(vehicleReadingPoints.readingId), asc(vehicleReadingPoints.position)),
    reader
      .select()
      .from(vehicleReadingPointRequests)
      .where(inArray(vehicleReadingPointRequests.readingId, ids))
      .orderBy(asc(vehicleReadingPointRequests.requestId)),
  ]);
  const requestIds = new Map<string, string[]>();
  for (const row of requests) {
    const key = `${row.readingId}|${row.position}`;
    const list = requestIds.get(key) ?? [];
    list.push(row.requestId);
    requestIds.set(key, list);
  }
  for (const row of points) {
    const list = result.get(row.readingId) ?? [];
    list.push({
      position: row.position,
      routePointId: row.routePointId,
      location: row.location,
      arrivedAt: clockTime(row.arrivedAt),
      departedAt: clockTime(row.departedAt),
      requestIds: requestIds.get(`${row.readingId}|${row.position}`) ?? [],
    });
    result.set(row.readingId, list);
  }
  return result;
}
