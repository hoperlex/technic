import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  requestRouteStops,
  ROUTE_TIME_ISSUES,
  routeTimeByRequest,
  SUBMITTED_REPORT_STATES,
  type RequestRouteReadingDto,
  type ReadingKind,
  type RequestRouteTimeDto,
} from '@technic/contracts';
import { driverDailyReportItems, driverDailyReports, persons, vehicleReadings } from '../db/schema';
import { loadReadingPoints, type StoredPoint } from './reading-points';
import type { ReadingsReader } from './readings-discrepancies';

/**
 * The actual time of a freight request (readings-shifts-merge plan §8, owner decisions D6, D7, D10,
 * D12): its stops as the driver recorded them and its share of the route time.
 *
 * WHICH READINGS. Every reading of a submitted report (`SUBMITTED_REPORT_STATES`, D2) that either
 * names the request in its stop snapshot (`vehicle_reading_point_requests`), or belongs to the route
 * the request stands in now. The snapshot is the attribution: it was taken under the route lock
 * when the stops were first captured, and after a rebuild of the route the live roles no longer say
 * whose work a recorded stop was. The live route only FINDS readings that cannot carry a snapshot —
 * a `no_data` shift, a reading recorded before times existed, a request attached after the capture —
 * so the card says why there is no time instead of showing nothing.
 *
 * WHY ALL OR NOTHING. The total is `null` as soon as one reading cannot be split: a partial sum
 * would propose a completion for less than the work, and the dispatcher would not see the gap.
 */

/** One candidate reading with what the D6 split and the diagnostics need. */
interface CandidateRow {
  readingId: string;
  kind: ReadingKind;
  reportDate: string;
}

/** The request's part of one reading: its stops, its share and why there is none. */
export function readingRouteFact(
  row: CandidateRow,
  points: readonly StoredPoint[],
  requestId: string,
): RequestRouteReadingDto {
  const base = { readingId: row.readingId, reportDate: row.reportDate };
  if (row.kind === 'no_data') return { ...base, stops: [], seconds: null, issue: 'no_data' };
  if (points.length === 0) return { ...base, stops: [], seconds: null, issue: 'no_times' };
  const stops = requestRouteStops(points, requestId);
  // The live route serves the request, but the recorded stops do not name it: the time was
  // captured before the request joined, and splitting it now would invent the attribution.
  if (stops.length === 0) return { ...base, stops, seconds: null, issue: 'unassigned' };
  const allocation = routeTimeByRequest(
    points,
    new Map(points.map((point) => [point.position, point.requestIds])),
  );
  if (!allocation.ok) return { ...base, stops, seconds: null, issue: allocation.reason };
  return { ...base, stops, seconds: allocation.byRequest[requestId] ?? 0, issue: null };
}

/**
 * The route time of a freight request: the facts of every reading, the exact total in seconds and
 * the reasons it is missing. Diagnostics (names, report states, the `no_data` reason and the
 * reading comment) only for a principal with `vehicleReadings.read` (D10).
 */
export async function loadRequestRouteTime(
  reader: ReadingsReader,
  requestId: string,
  options: { diagnostics?: boolean } = {},
): Promise<RequestRouteTimeDto> {
  const rows = await reader
    .select({
      readingId: vehicleReadings.id,
      kind: vehicleReadings.kind,
      noDataReason: vehicleReadings.noDataReason,
      comment: vehicleReadings.comment,
      reportDate: driverDailyReportItems.reportDate,
      reportState: driverDailyReports.state,
      personName: persons.fullName,
    })
    .from(vehicleReadings)
    .innerJoin(driverDailyReportItems, eq(driverDailyReportItems.id, vehicleReadings.itemId))
    .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
    .innerJoin(persons, eq(persons.id, driverDailyReports.personId))
    .where(
      and(
        inArray(driverDailyReports.state, [...SUBMITTED_REPORT_STATES]),
        // A joined query: drizzle qualifies the outer columns, so the correlations below cannot
        // collapse into a tautology (the single-table trap of `buildSelection`).
        or(
          sql`EXISTS (SELECT 1 FROM vehicle_reading_point_requests rt_pr
                       WHERE rt_pr.reading_id = ${vehicleReadings.id}
                         AND rt_pr.request_id = ${requestId})`,
          and(
            eq(driverDailyReportItems.sourceKind, 'route'),
            sql`EXISTS (SELECT 1 FROM vehicle_route_requests rt_rr
                         WHERE rt_rr.route_id = ${driverDailyReportItems.routeId}
                           AND rt_rr.request_id = ${requestId})`,
          ),
        ),
      ),
    )
    .orderBy(
      asc(driverDailyReportItems.reportDate),
      asc(driverDailyReportItems.shiftOrder),
      asc(vehicleReadings.id),
    );

  const points = await loadReadingPoints(
    reader,
    rows.map((row) => row.readingId),
  );
  const readings = rows.map((row) =>
    readingRouteFact(row, points.get(row.readingId) ?? [], requestId),
  );
  const issues =
    readings.length === 0
      ? (['no_readings'] as const)
      : ROUTE_TIME_ISSUES.filter((issue) => readings.some((reading) => reading.issue === issue));
  const seconds =
    issues.length === 0 ? readings.reduce((sum, reading) => sum + (reading.seconds ?? 0), 0) : null;

  return {
    readings,
    seconds,
    issues: [...issues],
    ...(options.diagnostics
      ? {
          driver: {
            readings: rows.map((row) => ({
              readingId: row.readingId,
              personName: row.personName,
              reportState: row.reportState,
              kind: row.kind,
              noDataReason: row.noDataReason,
              comment: row.comment,
            })),
          },
        }
      : {}),
  };
}
