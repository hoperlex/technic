import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  dateKeysBetween,
  driverScheduleSummary,
  driverShiftReadingStatus,
  type DriverReportState,
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  type GarageDriverScheduleDto,
  type GarageDriverShiftDto,
  monthRange,
  moscowDateKeyOf,
  type ReadingKind,
  vehicleLabel,
  type VehicleOwnership,
  waybillDisplayNumber,
  type WaybillFormCode,
} from '@technic/contracts';
import { db } from '../db/client';
import { requestIsLinearRawSql } from '../db/linear-mode';
import { persons, vehicleCategories, vehicleModels, vehicles, vehicleTypes } from '../db/schema';
import { assignmentSegments } from './assignment-history';
import { ASSIGNMENT_READINESS_POPULATION } from './assignment-mode';
import { readActualChanges, readHistoryIsAuthoritative } from './assignment-read';
import { driverCondition } from './drivers';
import { routeHasWork } from './garage';
import { EXPECTED_ESM2_FILTER, EXPECTED_ROUTE_FILTER } from './readings-expected';

/**
 * A driver's month for the garage's «График» window (owner's decisions of 28.10.2026; contract in
 * `garage-driver-schedule.ts`).
 *
 * The shifts due a reading are asked with the readings module's own fragments
 * (`readings-expected.ts`), never a copy: `EXPECTED_ROUTE_FILTER` for a route,
 * `EXPECTED_ESM2_FILTER` with one row per calendar day of the sheet. Those are the rule the intake
 * registry, the statistics and the "not submitted" filter share, and the driver cabinet builds the
 * same set (`driver-assignment.ts`); a window with its own rule would show a day as missing that
 * nobody else expects, or hide one the registry chases.
 *
 * A reading belongs to the shift only when it sits on the person's own report of that day, on the
 * same vehicle and date as the live source — the intake registry's "aligned" coordinate
 * (`expectedRelationCte`). A row a reassignment left in someone else's report is that person's
 * reading until staff rebase it, and counting it here would close a shift the registry still shows
 * open.
 */

/** Row of the shift query: the three branches share one shape so one mapper reads them. */
type ShiftSqlRow = {
  source: 'route' | 'esm2' | 'no_paper';
  route_id: string | null;
  route_num: number | null;
  day: string;
  vehicle_id: string;
  waybill_id: string | null;
  form_code: WaybillFormCode | null;
  waybill_number: number | null;
  waybill_prefix: string | null;
  waybill_number_width: number | null;
  report_id: string | null;
  report_state: DriverReportState | null;
  reading_kind: ReadingKind | null;
  no_data_reason: string | null;
};

/**
 * Routes due a reading, weekly-sheet days due a reading, and routes of this person without a
 * waybill on him. One statement, because the month of one person is a few dozen rows.
 *
 * The third branch is the route half of «без листа». A route counts when it has work
 * (`routeHasWork`, the garage's rule: a relocation, a composition of live requests or a live
 * waybill) and no live waybill names this driver — either none was issued yet, or the issued one
 * names someone else and the reassignment was not reissued. Nothing is expected of such a route
 * (`EXPECTED_ROUTE_FILTER` rejects it), so its reading columns stay empty.
 */
function shiftRowsSql(personId: string, from: string, to: string) {
  return sql`
SELECT 'route'::text                AS source,
       vr.id                        AS route_id,
       vr.num                       AS route_num,
       vr.route_date::text          AS day,
       vr.vehicle_id,
       pw.id                        AS waybill_id,
       pw.form_code::text           AS form_code,
       pw.number                    AS waybill_number,
       pws.prefix                   AS waybill_prefix,
       pws.number_width             AS waybill_number_width,
       rep.id                       AS report_id,
       rep.state::text              AS report_state,
       rd.kind::text                AS reading_kind,
       rd.no_data_reason
  FROM vehicle_routes vr
  /* The filter guarantees exactly one live waybill on this driver: one per route by index. */
  JOIN LATERAL (SELECT sw.id, sw.form_code, sw.number, sw.series_id
                  FROM waybills sw
                 WHERE sw.route_id = vr.id
                   AND sw.status <> 'cancelled'
                   AND sw.driver_person_id = vr.driver_person_id) pw ON true
  JOIN waybill_series pws ON pws.id = pw.series_id
  LEFT JOIN driver_daily_reports rep
         ON rep.person_id = vr.driver_person_id
        AND rep.report_date = vr.route_date
        AND rep.state <> 'voided'
  LEFT JOIN driver_daily_report_items i
         ON i.report_id = rep.id
        AND i.route_id = vr.id
        AND i.vehicle_id = vr.vehicle_id
        AND i.report_date = vr.route_date
  LEFT JOIN vehicle_readings rd ON rd.item_id = i.id
 WHERE vr.driver_person_id = ${personId}::uuid
   AND vr.route_date BETWEEN ${from}::date AND ${to}::date
   AND ${EXPECTED_ROUTE_FILTER}
UNION ALL
SELECT 'esm2'::text, NULL, NULL, gs.day::date::text, w.vehicle_id,
       w.id, w.form_code::text, w.number, ws.prefix, ws.number_width,
       rep.id, rep.state::text, rd.kind::text, rd.no_data_reason
  FROM waybills w
  JOIN waybill_series ws ON ws.id = w.series_id
  /*
   * Clipped to the month, and cast to timestamp without a zone so that the day does not depend on
   * the session TimeZone; the same reading of a sheet as the intake registry's.
   */
  CROSS JOIN LATERAL generate_series(greatest(w.period_from, ${from}::date)::timestamp,
                                     least(w.period_to, ${to}::date)::timestamp,
                                     interval '1 day') AS gs(day)
  LEFT JOIN driver_daily_reports rep
         ON rep.person_id = w.driver_person_id
        AND rep.report_date = gs.day::date
        AND rep.state <> 'voided'
  LEFT JOIN driver_daily_report_items i
         ON i.report_id = rep.id
        AND i.waybill_id = w.id
        AND i.vehicle_id = w.vehicle_id
        AND i.report_date = gs.day::date
  LEFT JOIN vehicle_readings rd ON rd.item_id = i.id
 WHERE w.driver_person_id = ${personId}::uuid
   AND ${EXPECTED_ESM2_FILTER}
   AND w.period_from <= ${to}::date
   AND w.period_to >= ${from}::date
UNION ALL
SELECT 'no_paper'::text, vr.id, vr.num, vr.route_date::text, vr.vehicle_id,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM vehicle_routes vr
 WHERE vr.driver_person_id = ${personId}::uuid
   AND vr.route_date BETWEEN ${from}::date AND ${to}::date
   AND ${routeHasWork('vr')}
   AND NOT EXISTS (SELECT 1 FROM waybills nw
                    WHERE nw.route_id = vr.id
                      AND nw.status <> 'cancelled'
                      AND nw.driver_person_id = vr.driver_person_id)`;
}

/** A day a site order names this person machinist, before the paper check. */
interface OrderDay {
  requestId: string;
  requestNum: number;
  date: string;
  vehicleId: string;
}

/**
 * Days a site order's assignment history names this person machinist (ADR 0126): the fold of the
 * history (`assignmentSegments`), clipped to the order's term and to the month.
 *
 * Only in the `history` read mode, as the request's driver contact answers
 * (`driverByAssignmentHistory`): in `legacy` the portal knows a machinist from the paper alone,
 * and a day without paper has no machinist to name. The population is the history's own
 * (`ASSIGNMENT_READINESS_POPULATION`: a non-linear site order in work or done); a linear order is
 * run by its routes and has no history. A segment without a vehicle falls back to the assignment,
 * as `requestDayVehicleSql` reads the vehicle of a day.
 */
async function loadOrderDays(personId: string, from: string, to: string): Promise<OrderDay[]> {
  if (!(await readHistoryIsAuthoritative())) return [];
  const requests = await db.execute<{
    id: string;
    num: number;
    date_from: string;
    date_to: string | null;
    assigned_vehicle_id: string | null;
  }>(sql`
    SELECT r.id, r.num, d.date_from::text AS date_from, d.date_to::text AS date_to,
           a.vehicle_id AS assigned_vehicle_id
      FROM vehicle_requests r
      JOIN special_equipment_request_details d ON d.request_id = r.id
      JOIN vehicle_types vt ON vt.id = r.vehicle_type_id
      LEFT JOIN vehicle_request_assignments a ON a.request_id = r.id
     WHERE ${ASSIGNMENT_READINESS_POPULATION}
       AND r.deleted_at IS NULL
       AND NOT ${requestIsLinearRawSql('r', 'vt')}
       AND d.date_from <= ${to}::date
       AND coalesce(d.date_to, d.date_from) >= ${from}::date
       AND EXISTS (SELECT 1 FROM vehicle_request_assignment_changes c
                    WHERE c.request_id = r.id
                      AND c.dimension = 'driver'
                      AND c.superseded_at IS NULL
                      AND c.driver_person_id = ${personId}::uuid)`);
  if (requests.rows.length === 0) return [];

  const changes = await readActualChanges(requests.rows.map((r) => r.id));
  const days: OrderDay[] = [];
  for (const request of requests.rows) {
    const term = { dateFrom: request.date_from, dateTo: request.date_to };
    for (const segment of assignmentSegments(changes.get(request.id) ?? [], term)) {
      if (segment.driver?.state !== 'set' || segment.driver.personId !== personId) continue;
      const vehicleId = segment.vehicle?.vehicleId ?? request.assigned_vehicle_id;
      if (!vehicleId) continue;
      const first = segment.from > from ? segment.from : from;
      const last = segment.to < to ? segment.to : to;
      for (const date of dateKeysBetween(first, last)) {
        days.push({ requestId: request.id, requestNum: request.num, date, vehicleId });
      }
    }
  }
  return days;
}

/** Labels and ownership of the month's vehicles: one query for the window, not one per row. */
async function loadVehicles(
  ids: readonly string[],
): Promise<Map<string, { label: string; ownership: VehicleOwnership }>> {
  const map = new Map<string, { label: string; ownership: VehicleOwnership }>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      id: vehicles.id,
      ownership: vehicles.ownership,
      description: vehicles.description,
      registrationNumber: vehicles.registrationNumber,
      typeName: vehicleTypes.name,
      categoryName: vehicleCategories.name,
      modelName: vehicleModels.name,
    })
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
    .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
    .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
    .where(inArray(vehicles.id, [...ids]));
  for (const row of rows) map.set(row.id, { label: vehicleLabel(row), ownership: row.ownership });
  return map;
}

/** Order inside a day: routes by number, then the weekly sheet, then days without paper. */
const SOURCE_RANK: Record<GarageDriverShiftDto['source'], number> = {
  route: 0,
  esm2: 1,
  no_paper: 2,
};

function compareShifts(
  a: GarageDriverShiftDto & { order: number },
  b: GarageDriverShiftDto & { order: number },
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  return rank !== 0 ? rank : a.order - b.order;
}

/**
 * The month of a driver; `null` when the person is not one the garage lists — the same set as the
 * «Водители» tab (`driverCondition`, not deleted), so the window opens for exactly the rows of the
 * list and a guessed identifier of anyone else reads as "not found".
 */
export async function loadDriverSchedule(
  personId: string,
  month: string | undefined,
  options: { canReadReadings: boolean; now?: Date },
): Promise<GarageDriverScheduleDto | null> {
  const [person] = await db
    .select({ fullName: persons.fullName })
    .from(persons)
    .where(and(eq(persons.id, personId), isNull(persons.deletedAt), driverCondition()));
  if (!person) return null;

  const today = moscowDateKeyOf(options.now ?? new Date());
  // The month of a date key is its first seven characters: `YYYY-MM-DD` by construction.
  const answered = month ?? today.slice(0, 7);
  const { from, to } = monthRange(answered);

  const [result, orderDays] = await Promise.all([
    db.execute<ShiftSqlRow>(shiftRowsSql(personId, from, to)),
    loadOrderDays(personId, from, to),
  ]);
  const rows = result.rows;
  const vehicleInfo = await loadVehicles([
    ...new Set([...rows.map((r) => r.vehicle_id), ...orderDays.map((d) => d.vehicleId)]),
  ]);

  const shifts: (GarageDriverShiftDto & { order: number })[] = rows.map((row) => {
    const readingStatus = driverShiftReadingStatus({
      expectsReading: row.source !== 'no_paper',
      date: row.day,
      today,
      reportState: row.report_state,
      readingKind: row.reading_kind,
    });
    const waybill =
      row.waybill_id && row.form_code && row.waybill_number !== null
        ? {
            id: row.waybill_id,
            formCode: row.form_code,
            number: waybillDisplayNumber(
              row.waybill_prefix ?? '',
              row.waybill_number,
              row.waybill_number_width ?? 0,
            ),
          }
        : null;
    return {
      key:
        row.source === 'esm2'
          ? `esm2:${row.waybill_id}:${row.day}`
          : row.source === 'route'
            ? `route:${row.route_id}`
            : `no_paper:route:${row.route_id}`,
      date: row.day,
      source: row.source,
      routeId: row.route_id,
      routeNumber: row.route_num === null ? null : formatVehicleRouteNumber(row.route_num),
      waybill,
      request: null,
      vehicleId: row.vehicle_id,
      vehicleLabel: vehicleInfo.get(row.vehicle_id)?.label ?? '',
      readingStatus,
      reportId: row.source === 'no_paper' ? null : row.report_id,
      ...(options.canReadReadings
        ? { noDataReason: readingStatus === 'no_data' ? (row.no_data_reason ?? '') : null }
        : {}),
      order: row.route_num ?? row.waybill_number ?? 0,
    };
  });

  /*
   * An order day joins the month only when nothing of this person already stands on that vehicle
   * that day: a weekly sheet on him, a route with his waybill or his route without one are the
   * same work, and a second row would count it twice. A rental vehicle is skipped — its paper is
   * the lessor's, and «без листа» would claim a sheet the portal is going to issue.
   */
  const covered = new Set(shifts.map((s) => `${s.date}|${s.vehicleId}`));
  for (const day of orderDays) {
    const vehicle = vehicleInfo.get(day.vehicleId);
    if (vehicle?.ownership !== 'own' || covered.has(`${day.date}|${day.vehicleId}`)) continue;
    covered.add(`${day.date}|${day.vehicleId}`);
    shifts.push({
      key: `no_paper:request:${day.requestId}:${day.date}`,
      date: day.date,
      source: 'no_paper',
      routeId: null,
      routeNumber: null,
      waybill: null,
      request: { id: day.requestId, displayNumber: formatVehicleRequestNumber(day.requestNum) },
      vehicleId: day.vehicleId,
      vehicleLabel: vehicle.label,
      readingStatus: 'not_expected',
      reportId: null,
      ...(options.canReadReadings ? { noDataReason: null } : {}),
      order: day.requestNum,
    });
  }

  shifts.sort(compareShifts);
  const ordered: GarageDriverShiftDto[] = shifts.map(({ order: _order, ...shift }) => shift);
  return {
    personId,
    fullName: person.fullName,
    month: answered,
    from,
    to,
    today,
    shifts: ordered,
    summary: driverScheduleSummary(ordered.map((s) => s.readingStatus)),
  };
}
