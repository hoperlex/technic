import { sql } from 'drizzle-orm';
import {
  requestRouteStops,
  ROUTE_TIME_ISSUES,
  routeTimeByRequest,
  SUBMITTED_REPORT_STATES,
  type DriverReportState,
  type RequestRouteReadingDto,
  type ReadingKind,
  type RequestRouteTimeDto,
} from '@technic/contracts';
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

/** A candidate reading of a request: what the D6 split and the diagnostics read from it. */
interface RequestReadingRow extends CandidateRow {
  requestId: string;
  noDataReason: string;
  comment: string;
  reportState: DriverReportState;
  personName: string;
}

/**
 * The candidate readings of several requests in one query, in report order per request. A reading
 * is a request's when its stop snapshot names the request, or when it belongs to the route the
 * request stands in now (see the module header). Both branches are matched against the asked ids,
 * so the readings report reads every freight request of a period without a query per request.
 */
async function loadCandidateRows(
  reader: ReadingsReader,
  requestIds: readonly string[],
): Promise<RequestReadingRow[]> {
  const ids = [...new Set(requestIds)];
  if (ids.length === 0) return [];
  const asked = sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
  const result = await reader.execute<{
    request_id: string;
    reading_id: string;
    kind: ReadingKind;
    no_data_reason: string;
    comment: string;
    report_date: string;
    report_state: DriverReportState;
    person_name: string;
  }>(sql`
WITH candidate AS (
    SELECT rt_pr.reading_id, rt_pr.request_id
      FROM vehicle_reading_point_requests rt_pr
     WHERE rt_pr.request_id = ANY(${asked})
    UNION
    SELECT vr.id, rt_rr.request_id
      FROM vehicle_readings vr
      JOIN driver_daily_report_items i ON i.id = vr.item_id
      JOIN vehicle_route_requests rt_rr ON rt_rr.route_id = i.route_id
     WHERE i.source_kind = 'route'
       AND rt_rr.request_id = ANY(${asked})
)
SELECT c.request_id::text   AS request_id,
       vr.id::text          AS reading_id,
       vr.kind::text        AS kind,
       vr.no_data_reason    AS no_data_reason,
       vr.comment           AS comment,
       i.report_date::text  AS report_date,
       rep.state::text      AS report_state,
       p.full_name          AS person_name
  FROM candidate c
  JOIN vehicle_readings vr          ON vr.id = c.reading_id
  JOIN driver_daily_report_items i  ON i.id = vr.item_id
  JOIN driver_daily_reports rep     ON rep.id = i.report_id
  JOIN persons p                    ON p.id = rep.person_id
 WHERE rep.state::text = ANY(${sql.param([...SUBMITTED_REPORT_STATES])}::text[])
 ORDER BY c.request_id, i.report_date, i.shift_order, vr.id`);
  return result.rows.map((row) => ({
    requestId: row.request_id,
    readingId: row.reading_id,
    kind: row.kind,
    noDataReason: row.no_data_reason,
    comment: row.comment,
    reportDate: row.report_date,
    reportState: row.report_state,
    personName: row.person_name,
  }));
}

/** The route time of one request from its candidate rows and the recorded stops. */
function routeTimeOf(
  requestId: string,
  rows: readonly RequestReadingRow[],
  points: ReadonlyMap<string, StoredPoint[]>,
): RequestRouteTimeDto {
  const readings = rows.map((row) =>
    readingRouteFact(row, points.get(row.readingId) ?? [], requestId),
  );
  const issues =
    readings.length === 0
      ? (['no_readings'] as const)
      : ROUTE_TIME_ISSUES.filter((issue) => readings.some((reading) => reading.issue === issue));
  const seconds =
    issues.length === 0 ? readings.reduce((sum, reading) => sum + (reading.seconds ?? 0), 0) : null;
  return { readings, seconds, issues: [...issues] };
}

/**
 * The route times of several freight requests, by request: one candidate query and one read of the
 * recorded stops for all of them. A request without readings answers `no_readings`, as one does.
 */
export async function loadRequestRouteTimes(
  reader: ReadingsReader,
  requestIds: readonly string[],
): Promise<Map<string, RequestRouteTimeDto>> {
  const rows = await loadCandidateRows(reader, requestIds);
  const points = await loadReadingPoints(reader, [...new Set(rows.map((row) => row.readingId))]);
  const byRequest = new Map<string, RequestReadingRow[]>();
  for (const row of rows) {
    const list = byRequest.get(row.requestId);
    if (list) list.push(row);
    else byRequest.set(row.requestId, [row]);
  }
  return new Map(
    [...new Set(requestIds)].map((id) => [id, routeTimeOf(id, byRequest.get(id) ?? [], points)]),
  );
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
  const rows = await loadCandidateRows(reader, [requestId]);
  const points = await loadReadingPoints(
    reader,
    rows.map((row) => row.readingId),
  );
  return {
    ...routeTimeOf(requestId, rows, points),
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
