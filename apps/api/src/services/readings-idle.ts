import { sql } from 'drizzle-orm';
import {
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  type IntakeIssue,
  type ReadingSourceKind,
  waybillDisplayNumber,
} from '@technic/contracts';
import { db } from '../db/client';
import type { Tx } from './readings-chain';
import { ROUTE_TASK_FILTER, routeHasTripSql, servedRequestSql } from './readings-expected';

/**
 * What contradicts a «Не работал» shift (ADR 0244, plan docs/rest-days-plan.md §4.3, owner decision
 * D5): the garage accepts an `idle` reading as a submitted shift, green when nothing contradicts
 * it and yellow, with one line per contradiction, when something does.
 *
 * Four contradictions; the first came with the working-Sunday mark (ADR 0246):
 *
 * - `idle_marked` — a working mark stood on that day for a request the shift answers for;
 * - `idle_trip` — the source, or a route it suppresses, carries a trip (`routeHasTripSql`);
 * - `idle_signed` — the site recorded nonzero hours for a served request of the source that day;
 * - `idle_worked` — another submitted reading of the same vehicle that day has numbers.
 *
 * **The coverage context.** A weekly ESM-2 suppresses the site-day route of the same request,
 * vehicle and day (`EXPECTED_ROUTE_FILTER`, ADR 0207): the route asks for no reading of its own,
 * so the driver answers for both through the sheet. A route A+B suppressed by the ESM-2 of A is
 * still a real task of that day — its freight row is a trip, and B's site may have signed hours —
 * so the checks walk the suppressed routes too, on every weekday. The context only diagnoses: it
 * copies no reading and no hours between requests.
 *
 * Computed live on every read of the intake and again by the batch acceptance (`idleContradicted
 * Reports`), never trusted from the page: a site signing hours after the page loaded must take the
 * report out of the batch.
 */

/** One idle reading at its own (snapshot) coordinate and the source it answers for. */
export interface IdleShift {
  readingId: string;
  sourceKind: ReadingSourceKind;
  sourceId: string;
  vehicleId: string;
  day: string;
}

type ContradictionRow = {
  reading_id: string;
  kind: 'trip' | 'signed' | 'worked' | 'marked';
  route_num: number | null;
  request_num: number | null;
  hours: string | null;
  approved: boolean | null;
  source_kind: ReadingSourceKind | null;
  waybill_number: number | null;
  waybill_prefix: string | null;
  waybill_number_width: number | null;
};

type Reader = Tx | typeof db;

function hoursText(value: string | null): string {
  return Number(value ?? 0).toLocaleString('ru-RU');
}

function workedLabel(row: ContradictionRow): string {
  if (row.source_kind === 'route') {
    return row.route_num === null ? 'рейс' : formatVehicleRouteNumber(row.route_num);
  }
  if (row.waybill_number === null) return 'лист';
  return `ЭСМ-2 № ${waybillDisplayNumber(row.waybill_prefix ?? '', row.waybill_number, row.waybill_number_width ?? 0)}`;
}

/**
 * The contradictions of the given idle shifts, by reading id; a shift without any is absent. One
 * query for any number of shifts: the intake asks for the whole period at once.
 */
export async function loadIdleContradictions(
  shifts: readonly IdleShift[],
  reader: Reader = db,
): Promise<Map<string, IntakeIssue[]>> {
  const found = new Map<string, IntakeIssue[]>();
  if (shifts.length === 0) return found;
  const values = sql.join(
    shifts.map(
      (s) =>
        sql`(${s.readingId}::uuid, ${s.sourceKind}::text, ${s.sourceId}::uuid, ${s.vehicleId}::uuid, ${s.day}::date)`,
    ),
    sql`, `,
  );
  const result = await reader.execute<ContradictionRow>(sql`
WITH idle_shift (reading_id, source_kind, source_id, vehicle_id, day) AS (VALUES ${values}),
/* The routes the shift stands for: the route itself, or the routes its ESM-2 suppresses that day. */
covered AS (
    SELECT i.reading_id, vr.id AS route_id
      FROM idle_shift i
      JOIN vehicle_routes vr ON i.source_kind = 'route' AND vr.id = i.source_id
    UNION
    SELECT i.reading_id, vr.id
      FROM idle_shift i
      JOIN waybills ew ON i.source_kind = 'esm2' AND ew.id = i.source_id
      JOIN vehicle_routes vr ON vr.vehicle_id = ew.vehicle_id AND vr.route_date = i.day
     WHERE ew.period_from <= i.day
       AND ew.period_to >= i.day
       AND ${ROUTE_TASK_FILTER}
       AND EXISTS (SELECT 1
                     FROM vehicle_route_requests err
                    WHERE err.route_id = vr.id
                      AND err.request_id = ew.source_request_id
                      AND err.work_date = vr.route_date)
),
/* The served requests of the shift: those of the covered routes and the ESM-2's own. */
requests AS (
    SELECT c.reading_id, rr.request_id
      FROM covered c
      JOIN vehicle_route_requests rr ON rr.route_id = c.route_id
      JOIN vehicle_requests q ON q.id = rr.request_id
     WHERE ${servedRequestSql('q')}
    UNION
    SELECT i.reading_id, ew.source_request_id
      FROM idle_shift i
      JOIN waybills ew ON i.source_kind = 'esm2' AND ew.id = i.source_id
      JOIN vehicle_requests q ON q.id = ew.source_request_id
     WHERE ${servedRequestSql('q')}
),
/*
 * The requests whose working mark makes the day a working one (ADR 0246): a covered route's
 * member whose row carries the day, and the sheet's own request — the rule of restDayShiftSql.
 */
day_requests AS (
    SELECT c.reading_id, rr.request_id
      FROM covered c
      JOIN idle_shift i ON i.reading_id = c.reading_id
      JOIN vehicle_route_requests rr ON rr.route_id = c.route_id AND rr.work_date = i.day
      JOIN vehicle_requests q ON q.id = rr.request_id
     WHERE ${servedRequestSql('q')}
    UNION
    SELECT i.reading_id, ew.source_request_id
      FROM idle_shift i
      JOIN waybills ew ON i.source_kind = 'esm2' AND ew.id = i.source_id
      JOIN vehicle_requests q ON q.id = ew.source_request_id
     WHERE ${servedRequestSql('q')}
)
SELECT c.reading_id, 'trip'::text AS kind, vr.num AS route_num, NULL::integer AS request_num,
       NULL::numeric AS hours, NULL::boolean AS approved, NULL::text AS source_kind,
       NULL::integer AS waybill_number, NULL::text AS waybill_prefix,
       NULL::integer AS waybill_number_width
  FROM covered c
  JOIN vehicle_routes vr ON vr.id = c.route_id
 WHERE ${routeHasTripSql('vr')}
UNION ALL
SELECT r.reading_id, 'signed', NULL, q.num, s.machine_hours, s.approved_at IS NOT NULL,
       NULL, NULL, NULL, NULL
  FROM requests r
  JOIN idle_shift i ON i.reading_id = r.reading_id
  JOIN vehicle_requests q ON q.id = r.request_id
  JOIN vehicle_request_shifts s ON s.request_id = r.request_id AND s.shift_date = i.day
 WHERE s.machine_hours > 0
UNION ALL
SELECT i.reading_id, 'worked', rt.num, NULL, NULL, NULL, oi.source_kind::text,
       wb.number, ws.prefix, ws.number_width
  FROM idle_shift i
  JOIN vehicle_readings ov
    ON ov.vehicle_id = i.vehicle_id AND ov.report_date = i.day
   AND ov.kind = 'values' AND ov.id <> i.reading_id
  JOIN driver_daily_reports orep ON orep.id = ov.report_id AND orep.state <> 'voided'
  JOIN driver_daily_report_items oi ON oi.id = ov.item_id
  LEFT JOIN vehicle_routes rt ON rt.id = oi.route_id
  LEFT JOIN waybills wb ON wb.id = oi.waybill_id
  LEFT JOIN waybill_series ws ON ws.id = wb.series_id
UNION ALL
SELECT d.reading_id, 'marked', NULL, q.num, NULL, NULL, NULL, NULL, NULL, NULL
  FROM day_requests d
  JOIN idle_shift i ON i.reading_id = d.reading_id
  JOIN vehicle_requests q ON q.id = d.request_id
  JOIN vehicle_request_working_days wd ON wd.request_id = d.request_id AND wd.work_date = i.day
 ORDER BY 1, 2, 3, 4`);

  for (const row of result.rows) {
    const issue: IntakeIssue =
      row.kind === 'trip'
        ? {
            code: 'idle_trip',
            level: 'yellow',
            message: `назначен рейс${row.route_num === null ? '' : ` ${formatVehicleRouteNumber(row.route_num)}`}, водитель отметил: не работал`,
          }
        : row.kind === 'marked'
          ? {
              code: 'idle_marked',
              level: 'yellow',
              message:
                `на этот день стояла рабочая смена по заявке ${row.request_num === null ? '' : formatVehicleRequestNumber(row.request_num)}`.trim(),
            }
          : row.kind === 'signed'
            ? {
                code: 'idle_signed',
                level: 'yellow',
                message:
                  `объект ${row.approved ? 'подписал' : 'записал'} ${hoursText(row.hours)} ч по заявке ${row.request_num === null ? '' : formatVehicleRequestNumber(row.request_num)}`.trim(),
              }
            : {
                code: 'idle_worked',
                level: 'yellow',
                message: `машина в этот день работала: ${workedLabel(row)}`,
              };
    const list = found.get(row.reading_id) ?? [];
    if (!list.some((known) => known.message === issue.message)) list.push(issue);
    found.set(row.reading_id, list);
  }
  return found;
}

/**
 * The reports among the given ones that hold a contradicted «Не работал» right now. The batch
 * acceptance refuses them: a yellow row stays singly acceptable, but the batch takes only reports
 * whose every row is green (Р8), and that must hold at the moment of acceptance, not at the moment
 * the page was drawn.
 */
export async function idleContradictedReports(reportIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(reportIds)];
  const contradicted = new Set<string>();
  if (ids.length === 0) return contradicted;
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await db.execute<{
    reading_id: string;
    report_id: string;
    source_kind: ReadingSourceKind;
    source_id: string;
    vehicle_id: string;
    day: string;
  }>(sql`
SELECT v.id AS reading_id, i.report_id, i.source_kind::text AS source_kind,
       coalesce(i.route_id, i.waybill_id) AS source_id, i.vehicle_id, i.report_date::text AS day
  FROM vehicle_readings v
  JOIN driver_daily_report_items i ON i.id = v.item_id
 WHERE v.kind = 'idle' AND i.report_id IN (${list})`);
  const shifts = result.rows.map((row) => ({
    readingId: row.reading_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    vehicleId: row.vehicle_id,
    day: row.day,
  }));
  const issues = await loadIdleContradictions(shifts);
  for (const row of result.rows) {
    if ((issues.get(row.reading_id) ?? []).length > 0) contradicted.add(row.report_id);
  }
  return contradicted;
}
