import { sql } from 'drizzle-orm';
import {
  formatVehicleRouteNumber,
  moscowDateKeyOf,
  shiftDaysOf,
  SUBMITTED_REPORT_STATES,
  waybillDisplayNumber,
  type ReadingKind,
  type ReadingSourceKind,
  type RequestRouteTimeDto,
  type VehicleOwnership,
  type VehicleRequestType,
  type VehicleWorkUnit,
} from '@technic/contracts';
import { db } from '../db/client';
import { requestDayVehicleSql } from './assignment-read';
import { loadBrokenCounterPairs, counterPairKey, EXPECTED_ESM2_FILTER } from './readings-expected';
import { loadRequestRouteTimes } from './request-route-time';
import {
  loadDriverShiftDaysByRequest,
  loadFreightRouteReadings,
  type DriverShiftReading,
} from './shift-driver-days';

/**
 * The rows of the readings report (ADR 0240): the work of equipment by request days.
 *
 * A row is a request × day × vehicle. A day of a special-equipment request is a day of its term
 * (`shiftDaysOf`, the contracts' only day set) up to today, with the vehicle that stood on it
 * (`requestDayVehicleSql`); a day of a freight request is its route day with the route's vehicle.
 * A request day with a vehicle always has a row, with readings or not (decision 9). Readings come
 * by the readers of the request card: the special-equipment one (`loadDriverShiftDaysByRequest`,
 * an ESM-2 issued for the request or a linear route day) and the freight one
 * (`loadFreightRouteReadings`). A reading outside the term still lands on its request's row of
 * that date; a relocation route is a row of its source request; any other own-vehicle reading of
 * the period is a row «без заявки» (decision 10) — so the mileage over one vehicle sums to its
 * odometer growth.
 *
 * Every read is one query for the whole period, never a query per request or vehicle (the model is
 * `analytics/facts-vehicle.ts`). Nothing here decides how a row is printed: marks, hours and
 * formulas are the book builder's (`readings-admin-export.ts`), which keeps this module the single
 * answer to "which rows" and the builder testable on rows in memory.
 */

// ── Rows ──

export interface ReportVehicle {
  id: string;
  ownership: VehicleOwnership;
  typeName: string;
  modelName: string | null;
  categoryName: string | null;
  description: string;
  registrationNumber: string | null;
  inventoryNumber: string | null;
  lessorName: string | null;
}

/** One counter of a reading with its chain predecessor: the row's start and end. */
export interface CounterSnapshot {
  value: number | null;
  previous: number | null;
  previousDate: string | null;
  /**
   * The pair is continuous by the readings module's rule (Р13а): no expected shift of the vehicle
   * without numbers lies between the predecessor and this snapshot. `true` without a pair.
   */
  continuous: boolean;
}

export interface ReportReading {
  readingId: string;
  vehicleId: string;
  date: string;
  shiftOrder: number;
  kind: ReadingKind;
  noDataReason: string;
  personName: string;
  sourceKind: ReadingSourceKind;
  /** `Р-12` or `ЭСМ-2 № …`, as the registry and the cabinet name the source. */
  sourceLabel: string;
  odometer: CounterSnapshot;
  engineHours: CounterSnapshot;
  /** The engine-hour counter was reset at this snapshot: its delta is not work. */
  engineHoursReset: boolean;
}

export interface ReportTrip {
  from: string;
  to: string;
  cargo: string;
}

export interface ReportRequest {
  id: string;
  num: number;
  type: VehicleRequestType;
  /** The object; for a department request, the department's sites, or the department itself. */
  customerName: string;
  authorName: string | null;
  approverName: string | null;
  comment: string;
  trips: ReportTrip[];
  termFrom: string | null;
  termTo: string | null;
  assignment: {
    pricePerHour: number | null;
    pricePerShift: number | null;
    shiftHours: number | null;
  } | null;
  completion: {
    unit: VehicleWorkUnit;
    amount: number;
    workedHours: number | null;
    rate: number | null;
  } | null;
}

export type ReportRowKind = 'request' | 'relocation' | 'noRequest';

export interface ReportRow {
  kind: ReportRowKind;
  date: string;
  vehicle: ReportVehicle;
  request: ReportRequest | null;
  /** The readings whose counters this row carries, in shift order. */
  readings: ReportReading[];
  /**
   * The routes whose readings this row shares without carrying their counters: another request of
   * the route stops there first (decision 8), and the counters went to its row.
   */
  sharedRoutes: string[];
  /** Everyone who submitted a reading of this row's work, counters carried or not. */
  readingPersons: string[];
  /** The person of the source for a day without readings: the route driver or the machinist. */
  sourcePerson: string | null;
  /** The source of a «без заявки» row. */
  sourceLabel: string | null;
  relocation: { from: string; to: string } | null;
  /** A reading attributed to the request on a day outside its term. */
  outOfTerm: boolean;
  /** Readings of more than one vehicle for this request and day: one row per vehicle. */
  swapped: boolean;
  /** The site's row of the «Смены» tab for this day. */
  shift: {
    machineHours: number;
    signed: boolean;
    startedAt: string | null;
    endedAt: string | null;
  } | null;
  /** A rented vehicle's freight day: the request's share of the route time and its span. */
  routeTime: { seconds: number | null; startedAt: string | null; endedAt: string | null } | null;
}

// ── Queries ──

const LIVE_REQUEST = sql`q.deleted_at IS NULL AND q.status <> 'cancelled'`;

function num(value: string | number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function uuidArray(ids: readonly string[]) {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;
}

type ReadingSqlRow = {
  reading_id: string;
  vehicle_id: string;
  date: string;
  shift_order: number;
  kind: ReadingKind;
  no_data_reason: string;
  person_name: string | null;
  source_kind: ReadingSourceKind;
  route_id: string | null;
  route_num: number | null;
  route_purpose: 'freight' | 'delivery' | 'pickup' | null;
  route_source_request: string | null;
  route_vehicle: string | null;
  waybill_number: number | null;
  waybill_prefix: string | null;
  waybill_width: number | null;
  waybill_request: string | null;
  odometer_km: number | null;
  previous_odometer_km: number | null;
  previous_odometer_date: string | null;
  engine_hours: string | null;
  previous_engine_hours: string | null;
  previous_engine_hours_date: string | null;
  engine_hours_anomaly: string | null;
  linear_requests: string[] | null;
};

interface PeriodReading extends ReportReading {
  routeId: string | null;
  routeNum: number | null;
  routePurpose: 'freight' | 'delivery' | 'pickup' | null;
  routeSourceRequest: string | null;
  routeVehicle: string | null;
  waybillRequest: string | null;
  linearRequests: string[];
}

function sourceLabelOf(row: ReadingSqlRow): string {
  if (row.source_kind === 'route') {
    return row.route_num === null ? 'Рейс удалён' : formatVehicleRouteNumber(row.route_num);
  }
  if (row.waybill_number === null) return 'Лист удалён';
  return `ЭСМ-2 № ${waybillDisplayNumber(row.waybill_prefix ?? '', row.waybill_number, row.waybill_width ?? 0)}`;
}

/**
 * Every submitted reading of the period (D2: `submitted`, `accepted`, `needs_reacceptance`; never a
 * draft or a voided report), with both counters' chain predecessors and what attribution needs:
 * the route and its purpose, the waybill's request and the linear requests of the route day.
 */
async function loadPeriodReadings(from: string, to: string): Promise<PeriodReading[]> {
  const result = await db.execute<ReadingSqlRow>(sql`
SELECT vr.id::text                AS reading_id,
       vr.vehicle_id::text        AS vehicle_id,
       vr.report_date::text       AS date,
       vr.shift_order             AS shift_order,
       vr.kind::text              AS kind,
       vr.no_data_reason          AS no_data_reason,
       p.full_name                AS person_name,
       i.source_kind::text        AS source_kind,
       i.route_id::text           AS route_id,
       rt.num                     AS route_num,
       rt.purpose                 AS route_purpose,
       rt.source_request_id::text AS route_source_request,
       rt.vehicle_id::text        AS route_vehicle,
       wb.number                  AS waybill_number,
       ws.prefix                  AS waybill_prefix,
       ws.number_width            AS waybill_width,
       wb.source_request_id::text AS waybill_request,
       vr.odometer_km             AS odometer_km,
       po.odometer_km             AS previous_odometer_km,
       po.report_date::text       AS previous_odometer_date,
       vr.engine_hours            AS engine_hours,
       pe.engine_hours            AS previous_engine_hours,
       pe.report_date::text       AS previous_engine_hours_date,
       vr.engine_hours_anomaly::text AS engine_hours_anomaly,
       (SELECT array_agg(rr.request_id::text)
          FROM vehicle_route_requests rr
         WHERE rr.route_id = i.route_id
           AND rr.work_date = i.report_date) AS linear_requests
  FROM vehicle_readings vr
  JOIN driver_daily_report_items i ON i.id = vr.item_id
  JOIN driver_daily_reports rep     ON rep.id = i.report_id
  LEFT JOIN persons p               ON p.id = rep.person_id
  LEFT JOIN vehicle_readings po     ON po.id = vr.previous_odometer_id
  LEFT JOIN vehicle_readings pe     ON pe.id = vr.previous_engine_hours_id
  LEFT JOIN vehicle_routes rt       ON rt.id = i.route_id
  LEFT JOIN waybills wb             ON wb.id = i.waybill_id
  LEFT JOIN waybill_series ws       ON ws.id = wb.series_id
 WHERE rep.state::text = ANY(${sql.param([...SUBMITTED_REPORT_STATES])}::text[])
   AND vr.report_date BETWEEN ${from}::date AND ${to}::date
 ORDER BY vr.vehicle_id, vr.report_date, vr.shift_order, vr.id`);

  const readings = result.rows.map((row): PeriodReading => ({
    readingId: row.reading_id,
    vehicleId: row.vehicle_id,
    date: row.date,
    shiftOrder: row.shift_order,
    kind: row.kind,
    noDataReason: row.no_data_reason ?? '',
    personName: row.person_name ?? '',
    sourceKind: row.source_kind,
    sourceLabel: sourceLabelOf(row),
    odometer: {
      value: row.odometer_km,
      previous: row.previous_odometer_km,
      previousDate: row.previous_odometer_date,
      continuous: true,
    },
    engineHours: {
      value: num(row.engine_hours),
      previous: num(row.previous_engine_hours),
      previousDate: row.previous_engine_hours_date,
      continuous: true,
    },
    engineHoursReset: row.engine_hours_anomaly === 'counter_reset',
    routeId: row.route_id,
    routeNum: row.route_num,
    routePurpose: row.route_purpose,
    routeSourceRequest: row.route_source_request,
    routeVehicle: row.route_vehicle,
    waybillRequest: row.waybill_request,
    linearRequests: row.linear_requests ?? [],
  }));
  await markContinuity(readings);
  return readings;
}

/**
 * Judges both counter pairs of every reading by the garage's continuity rule (Р13а): one query
 * per counter for all readings. A broken pair keeps its start (decision 11) — the row only says
 * where the start comes from.
 */
async function markContinuity(readings: readonly PeriodReading[]): Promise<void> {
  for (const counter of ['odometer', 'engineHours'] as const) {
    const judged = readings.flatMap((reading) => {
      const snapshot = reading[counter];
      return snapshot.value !== null && snapshot.previous !== null && snapshot.previousDate !== null
        ? [
            {
              snapshot,
              pair: {
                vehicleId: reading.vehicleId,
                previousDate: snapshot.previousDate,
                date: reading.date,
              },
            },
          ]
        : [];
    });
    if (judged.length === 0) continue;
    const broken = await loadBrokenCounterPairs(
      db,
      counter,
      judged.map(({ pair }) => pair),
    );
    for (const { snapshot, pair } of judged) {
      snapshot.continuous = !broken.has(counterPairKey(pair));
    }
  }
}

type SkeletonSqlRow = {
  kind: 'term' | 'freight' | 'relocation';
  request_id: string;
  date: string;
  vehicle_id: string | null;
  route_id: string | null;
  move_from: string | null;
  move_to: string | null;
};

/**
 * The request days of the period up to today, before any reading: term days of special equipment
 * with the vehicle of the day, freight route days with the route's vehicle, relocation routes.
 * The SQL lays a term out in days only to answer "which vehicle stood that day"; the set of days is
 * `shiftDaysOf`'s, filtered by the caller.
 */
async function loadSkeleton(from: string, to: string): Promise<SkeletonSqlRow[]> {
  const result = await db.execute<SkeletonSqlRow>(sql`
WITH term AS (
    SELECT q.id AS request_id, gs.day::date AS d
      FROM vehicle_requests q
      JOIN special_equipment_request_details sed ON sed.request_id = q.id
      CROSS JOIN LATERAL generate_series(
             greatest(sed.date_from, ${from}::date),
             least(coalesce(sed.date_to, sed.date_from), ${to}::date),
             interval '1 day') AS gs(day)
     WHERE q.request_type = 'special_equipment'
       AND ${LIVE_REQUEST}
       AND sed.date_from <= ${to}::date
       AND coalesce(sed.date_to, sed.date_from) >= ${from}::date
)
SELECT 'term'::text AS kind, t.request_id::text AS request_id, t.d::text AS date,
       (${requestDayVehicleSql(sql`t.request_id`, sql`asg.vehicle_id`, sql`t.d`)})::text AS vehicle_id,
       NULL::text AS route_id, NULL::text AS move_from, NULL::text AS move_to
  FROM term t
  LEFT JOIN vehicle_request_assignments asg ON asg.request_id = t.request_id
UNION ALL
SELECT 'freight', rr.request_id::text, r.route_date::text, r.vehicle_id::text, r.id::text,
       NULL, NULL
  FROM vehicle_routes r
  JOIN vehicle_route_requests rr ON rr.route_id = r.id AND rr.work_date IS NULL
  JOIN vehicle_requests q        ON q.id = rr.request_id
 WHERE r.purpose = 'freight'
   AND r.route_date BETWEEN ${from}::date AND ${to}::date
   AND q.request_type = 'freight_transport'
   AND ${LIVE_REQUEST}
UNION ALL
SELECT 'relocation', r.source_request_id::text, r.route_date::text, r.vehicle_id::text,
       r.id::text, r.move_from, r.move_to
  FROM vehicle_routes r
  JOIN vehicle_requests q ON q.id = r.source_request_id
 WHERE r.purpose IN ('delivery', 'pickup')
   AND r.route_date BETWEEN ${from}::date AND ${to}::date
   AND ${LIVE_REQUEST}`);
  return [...result.rows];
}

type RequestSqlRow = {
  id: string;
  num: number;
  request_type: VehicleRequestType;
  live: boolean;
  comment: string;
  customer_name: string | null;
  author_name: string | null;
  approver_name: string | null;
  term_from: string | null;
  term_to: string | null;
  has_assignment: boolean;
  price_per_hour: string | null;
  price_per_shift: string | null;
  shift_hours: number | null;
  worked_unit: VehicleWorkUnit | null;
  worked_amount: string | null;
  worked_hours: string | null;
  rate: string | null;
  trips: { from: string; to: string; cargo: string }[] | null;
};

/** What the rows print about their requests, for every request found, in one query. */
async function loadRequests(ids: readonly string[]): Promise<Map<string, RequestSqlRow>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute<RequestSqlRow>(sql`
SELECT q.id::text                           AS id,
       q.num                                AS num,
       q.request_type::text                 AS request_type,
       (${LIVE_REQUEST})                    AS live,
       q.comment                            AS comment,
       coalesce(o.name,
                (SELECT string_agg(dco.name, '; ' ORDER BY dco.name)
                   FROM department_construction_objects dcl
                   JOIN construction_objects dco ON dco.id = dcl.construction_object_id
                  WHERE dcl.department_id = q.department_id),
                d.name)                     AS customer_name,
       au.full_name                         AS author_name,
       ap.full_name                         AS approver_name,
       sed.date_from::text                  AS term_from,
       sed.date_to::text                    AS term_to,
       (asg.request_id IS NOT NULL)         AS has_assignment,
       asg.price_per_hour                   AS price_per_hour,
       asg.price_per_shift                  AS price_per_shift,
       asg.shift_hours                      AS shift_hours,
       comp.worked_unit::text               AS worked_unit,
       comp.worked_amount                   AS worked_amount,
       comp.worked_hours                    AS worked_hours,
       comp.rate                            AS rate,
       (SELECT json_agg(json_build_object('from', t.from_location, 'to', t.to_location,
                                          'cargo', t.cargo_name) ORDER BY t.num)
          FROM vehicle_request_trips t
         WHERE t.request_id = q.id AND t.deleted_at IS NULL) AS trips
  FROM vehicle_requests q
  LEFT JOIN construction_objects o                ON o.id = q.object_id
  LEFT JOIN departments d                         ON d.id = q.department_id
  LEFT JOIN users au                              ON au.id = q.created_by
  LEFT JOIN users ap                              ON ap.id = q.approved_by
  LEFT JOIN special_equipment_request_details sed ON sed.request_id = q.id
  LEFT JOIN vehicle_request_assignments asg       ON asg.request_id = q.id
  LEFT JOIN vehicle_request_completions comp      ON comp.request_id = q.id
 WHERE q.id = ANY(${uuidArray(ids)})`);
  return new Map(result.rows.map((row) => [row.id, row]));
}

function requestOf(row: RequestSqlRow): ReportRequest {
  return {
    id: row.id,
    num: row.num,
    type: row.request_type,
    customerName: row.customer_name ?? '',
    authorName: row.author_name,
    approverName: row.approver_name,
    comment: row.comment ?? '',
    trips: row.trips ?? [],
    termFrom: row.term_from,
    termTo: row.term_to,
    assignment: row.has_assignment
      ? {
          pricePerHour: num(row.price_per_hour),
          pricePerShift: num(row.price_per_shift),
          shiftHours: row.shift_hours,
        }
      : null,
    completion:
      row.worked_unit === null || row.worked_amount === null
        ? null
        : {
            unit: row.worked_unit,
            amount: num(row.worked_amount) ?? 0,
            workedHours: num(row.worked_hours),
            rate: num(row.rate),
          },
  };
}

type VehicleSqlRow = {
  id: string;
  ownership: VehicleOwnership;
  type_name: string | null;
  model_name: string | null;
  category_name: string | null;
  description: string | null;
  registration_number: string | null;
  inventory_number: string | null;
  lessor_name: string | null;
};

async function loadVehicles(ids: readonly string[]): Promise<Map<string, ReportVehicle>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute<VehicleSqlRow>(sql`
SELECT v.id::text            AS id,
       v.ownership::text     AS ownership,
       vt.name               AS type_name,
       vm.name               AS model_name,
       vc.name               AS category_name,
       v.description         AS description,
       v.registration_number AS registration_number,
       v.inventory_number    AS inventory_number,
       cp.name               AS lessor_name
  FROM vehicles v
  LEFT JOIN vehicle_types vt      ON vt.id = v.vehicle_type_id
  LEFT JOIN vehicle_models vm     ON vm.id = v.vehicle_model_id
  LEFT JOIN vehicle_categories vc ON vc.id = v.vehicle_category_id
  LEFT JOIN counterparties cp     ON cp.id = v.lessor_id
 WHERE v.id = ANY(${uuidArray(ids)})`);
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        ownership: row.ownership,
        typeName: row.type_name ?? '',
        modelName: row.model_name,
        categoryName: row.category_name,
        description: row.description ?? '',
        registrationNumber: row.registration_number,
        inventoryNumber: row.inventory_number,
        lessorName: row.lessor_name,
      },
    ]),
  );
}

type ShiftSqlRow = {
  request_id: string;
  date: string;
  machine_hours: string;
  signed: boolean;
  started_at: string | null;
  ended_at: string | null;
};

/** The site's rows of the «Смены» tab of the found requests, by request and day. */
async function loadShifts(
  ids: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, ReportRow['shift']>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute<ShiftSqlRow>(sql`
SELECT s.request_id::text           AS request_id,
       s.shift_date::text           AS date,
       s.machine_hours              AS machine_hours,
       (s.approved_at IS NOT NULL)  AS signed,
       to_char(s.started_at, 'HH24:MI') AS started_at,
       to_char(s.ended_at, 'HH24:MI')   AS ended_at
  FROM vehicle_request_shifts s
 WHERE s.request_id = ANY(${uuidArray(ids)})
   AND s.shift_date BETWEEN ${from}::date AND ${to}::date`);
  return new Map(
    result.rows.map((row) => [
      `${row.request_id}|${row.date}`,
      {
        machineHours: num(row.machine_hours) ?? 0,
        signed: row.signed,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      },
    ]),
  );
}

type PersonSqlRow = {
  request_id: string;
  date: string;
  vehicle_id: string;
  person_name: string;
};

/**
 * Who the source names for a request day — the ESM-2 machinist or the route driver — so a day
 * without readings still says who was to work it. Assignments store no driver: a day without a
 * paper has nobody, and the row prints a dash.
 */
async function loadSourcePersons(
  ids: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute<PersonSqlRow>(sql`
SELECT w.source_request_id::text AS request_id, gs.day::date::text AS date,
       w.vehicle_id::text AS vehicle_id, p.full_name AS person_name
  FROM waybills w
  CROSS JOIN LATERAL generate_series(greatest(w.period_from, ${from}::date)::timestamp,
                                     least(w.period_to, ${to}::date)::timestamp,
                                     interval '1 day') AS gs(day)
  JOIN persons p ON p.id = w.driver_person_id
 WHERE ${EXPECTED_ESM2_FILTER}
   AND w.source_request_id = ANY(${uuidArray(ids)})
   AND w.period_from <= ${to}::date
   AND w.period_to >= ${from}::date
UNION ALL
SELECT rr.request_id::text, r.route_date::text, r.vehicle_id::text, p.full_name
  FROM vehicle_routes r
  JOIN vehicle_route_requests rr ON rr.route_id = r.id
                                AND (rr.work_date IS NULL OR rr.work_date = r.route_date)
  JOIN persons p ON p.id = r.driver_person_id
 WHERE rr.request_id = ANY(${uuidArray(ids)})
   AND r.route_date BETWEEN ${from}::date AND ${to}::date
UNION ALL
SELECT r.source_request_id::text, r.route_date::text, r.vehicle_id::text, p.full_name
  FROM vehicle_routes r
  JOIN persons p ON p.id = r.driver_person_id
 WHERE r.purpose IN ('delivery', 'pickup')
   AND r.source_request_id = ANY(${uuidArray(ids)})
   AND r.route_date BETWEEN ${from}::date AND ${to}::date`);
  const persons = new Map<string, string>();
  for (const row of result.rows) {
    const key = `${row.request_id}|${row.date}|${row.vehicle_id}`;
    if (!persons.has(key)) persons.set(key, row.person_name);
  }
  return persons;
}

type StopSqlRow = {
  route_id: string;
  request_id: string;
  position: number;
  first_stop: number | null;
};

/**
 * Where each request of a shared route stops first: the counters of a shared reading go to the
 * request with the earliest stop (decision 8). The route's points name the request at its stops;
 * a request without points falls back to its place in the composition.
 */
async function loadStopOrder(routeIds: readonly string[]): Promise<Map<string, number>> {
  if (routeIds.length === 0) return new Map();
  const result = await db.execute<StopSqlRow>(sql`
SELECT rr.route_id::text   AS route_id,
       rr.request_id::text AS request_id,
       rr.position         AS position,
       (SELECT min(rp.position)
          FROM vehicle_route_point_trips pt
          JOIN vehicle_route_points rp ON rp.id = pt.point_id
         WHERE pt.route_id = rr.route_id
           AND pt.request_id = rr.request_id) AS first_stop
  FROM vehicle_route_requests rr
 WHERE rr.route_id = ANY(${uuidArray(routeIds)})`);
  return new Map(
    result.rows.map((row) => [
      `${row.route_id}|${row.request_id}`,
      // A stop of the points outranks any composition place: points exist only for recorded stops.
      row.first_stop ?? 100 + row.position,
    ]),
  );
}

// ── Assembly ──

/** Today in Moscow: days after it are not rows (decision 9). */
export function reportToday(now: Date = new Date()): string {
  return moscowDateKeyOf(now);
}

interface Attribution {
  requestId: string;
  date: string;
  readingId: string;
}

interface Draft {
  kind: ReportRowKind;
  requestId: string | null;
  date: string;
  vehicleId: string;
  /** Readings of this row's work, counters carried or not. */
  readingIds: Set<string>;
  sourceLabel: string | null;
  relocation: { from: string; to: string } | null;
  routeId: string | null;
}

function draftKey(
  kind: ReportRowKind,
  requestId: string | null,
  date: string,
  vehicleId: string,
  source: string | null,
) {
  return `${kind}|${requestId ?? ''}|${date}|${vehicleId}|${source ?? ''}`;
}

export interface ReportRowsResult {
  rows: ReportRow[];
  /** The last day the rows cover: the period's end or today, whichever is earlier. */
  coveredTo: string;
}

/**
 * The rows of the period. `today` is a parameter so a test pins it; the route passes nothing.
 */
export async function loadReportRows(
  from: string,
  to: string,
  today: string = reportToday(),
): Promise<ReportRowsResult> {
  const coveredTo = to < today ? to : today;
  if (coveredTo < from) return { rows: [], coveredTo };

  const range = { from, to: coveredTo };
  const [readings, skeleton, freightReadings] = await Promise.all([
    loadPeriodReadings(from, coveredTo),
    loadSkeleton(from, coveredTo),
    loadFreightRouteReadings(db, range),
  ]);
  const readingById = new Map(readings.map((reading) => [reading.readingId, reading]));

  // Every request a row or a reading can point at, read once with its liveness.
  const candidateIds = new Set<string>();
  for (const row of skeleton) candidateIds.add(row.request_id);
  for (const reading of readings) {
    if (reading.waybillRequest) candidateIds.add(reading.waybillRequest);
    for (const id of reading.linearRequests) candidateIds.add(id);
    if (reading.routeSourceRequest) candidateIds.add(reading.routeSourceRequest);
  }
  for (const id of freightReadings.keys()) candidateIds.add(id);
  const requestRows = await loadRequests([...candidateIds]);
  const live = (id: string | null): id is string =>
    id !== null && requestRows.get(id)?.live === true;
  const special = [...requestRows.values()]
    .filter((row) => row.live && row.request_type === 'special_equipment')
    .map((row) => row.id);
  const specialReadings = await loadDriverShiftDaysByRequest(db, special, range);

  // Which request days each reading belongs to, by the card's readers.
  const attributions: Attribution[] = [];
  const collect = (byRequest: Map<string, Map<string, DriverShiftReading[]>>) => {
    for (const [requestId, days] of byRequest) {
      if (!live(requestId)) continue;
      for (const [date, list] of days) {
        for (const reading of list)
          attributions.push({ requestId, date, readingId: reading.readingId });
      }
    }
  };
  collect(
    new Map(
      [...specialReadings].map(([id, days]) => [
        id,
        new Map([...days].map(([date, day]) => [date, day.readings])),
      ]),
    ),
  );
  collect(freightReadings);

  const drafts = new Map<string, Draft>();
  const draft = (
    kind: ReportRowKind,
    requestId: string | null,
    date: string,
    vehicleId: string,
    extra: Partial<Pick<Draft, 'sourceLabel' | 'relocation' | 'routeId'>> = {},
  ): Draft => {
    // A «без заявки» row is one per source and day; request rows are one per request day.
    const key = draftKey(
      kind,
      requestId,
      date,
      vehicleId,
      kind === 'noRequest' ? (extra.sourceLabel ?? null) : null,
    );
    let found = drafts.get(key);
    if (!found) {
      found = {
        kind,
        requestId,
        date,
        vehicleId,
        readingIds: new Set(),
        sourceLabel: extra.sourceLabel ?? null,
        relocation: extra.relocation ?? null,
        routeId: extra.routeId ?? null,
      };
      drafts.set(key, found);
    }
    return found;
  };

  // Request days with readings: one row per vehicle that submitted for the request that day.
  const attributed = new Set<string>();
  const readingDays = new Map<string, Set<string>>();
  for (const { requestId, date, readingId } of attributions) {
    const reading = readingById.get(readingId);
    if (!reading) continue;
    attributed.add(readingId);
    draft('request', requestId, date, reading.vehicleId).readingIds.add(readingId);
    const key = `${requestId}|${date}`;
    const vehicles = readingDays.get(key) ?? new Set<string>();
    vehicles.add(reading.vehicleId);
    readingDays.set(key, vehicles);
  }

  // Request days without readings: the day's vehicle, when it has one (decision 9).
  const termDays = new Map<string, Set<string>>();
  for (const id of special) {
    const row = requestRows.get(id)!;
    termDays.set(
      id,
      new Set(shiftDaysOf({ dateFrom: row.term_from ?? undefined, dateTo: row.term_to })),
    );
  }
  const relocationByRoute = new Map<string, Draft>();
  for (const row of skeleton) {
    if (!live(row.request_id) || row.vehicle_id === null) continue;
    if (row.kind === 'relocation') {
      const relocation = draft('relocation', row.request_id, row.date, row.vehicle_id, {
        relocation: { from: row.move_from ?? '', to: row.move_to ?? '' },
        routeId: row.route_id,
      });
      if (row.route_id) relocationByRoute.set(row.route_id, relocation);
      continue;
    }
    if (row.kind === 'term' && !termDays.get(row.request_id)?.has(row.date)) continue;
    if (readingDays.has(`${row.request_id}|${row.date}`)) continue;
    draft('request', row.request_id, row.date, row.vehicle_id);
  }

  // Relocation readings: the relocation row of the source request, the route's own vehicle.
  for (const reading of readings) {
    if (attributed.has(reading.readingId)) continue;
    if (reading.routePurpose !== 'delivery' && reading.routePurpose !== 'pickup') continue;
    if (!live(reading.routeSourceRequest) || reading.routeVehicle === null) continue;
    const target =
      (reading.routeId ? relocationByRoute.get(reading.routeId) : undefined) ??
      draft('relocation', reading.routeSourceRequest, reading.date, reading.routeVehicle, {
        routeId: reading.routeId,
      });
    target.readingIds.add(reading.readingId);
    attributed.add(reading.readingId);
  }

  const vehicleIds = new Set<string>();
  for (const d of drafts.values()) vehicleIds.add(d.vehicleId);
  for (const reading of readings) vehicleIds.add(reading.vehicleId);
  const vehicles = await loadVehicles([...vehicleIds]);

  // «Без заявки»: any other reading of an own vehicle, one row per source and day.
  for (const reading of readings) {
    if (attributed.has(reading.readingId)) continue;
    if (vehicles.get(reading.vehicleId)?.ownership !== 'own') continue;
    draft('noRequest', null, reading.date, reading.vehicleId, {
      sourceLabel: reading.sourceLabel,
    }).readingIds.add(reading.readingId);
  }

  // Counters of a reading shared by several rows go to the first stop of its route (decision 8).
  const owners = new Map<string, Draft[]>();
  for (const d of drafts.values()) {
    for (const id of d.readingIds) {
      const list = owners.get(id) ?? [];
      list.push(d);
      owners.set(id, list);
    }
  }
  const sharedRouteIds = new Set<string>();
  for (const [readingId, list] of owners) {
    const routeId = readingById.get(readingId)?.routeId;
    if (list.length > 1 && routeId) sharedRouteIds.add(routeId);
  }
  const stopOrder = await loadStopOrder([...sharedRouteIds]);
  const carrierOf = new Map<string, Draft>();
  for (const [readingId, list] of owners) {
    const routeId = readingById.get(readingId)?.routeId ?? '';
    const ranked = [...list].sort((a, b) => {
      const stopA = stopOrder.get(`${routeId}|${a.requestId}`) ?? Number.MAX_SAFE_INTEGER;
      const stopB = stopOrder.get(`${routeId}|${b.requestId}`) ?? Number.MAX_SAFE_INTEGER;
      if (stopA !== stopB) return stopA - stopB;
      const numA = a.requestId ? (requestRows.get(a.requestId)?.num ?? 0) : 0;
      const numB = b.requestId ? (requestRows.get(b.requestId)?.num ?? 0) : 0;
      return numA - numB;
    });
    carrierOf.set(readingId, ranked[0]!);
  }

  const requestIds = [
    ...new Set([...drafts.values()].flatMap((d) => (d.requestId ? [d.requestId] : []))),
  ];
  const rentalFreight = [...drafts.values()].flatMap((d) =>
    d.kind === 'request' &&
    d.requestId &&
    requestRows.get(d.requestId)?.request_type === 'freight_transport' &&
    vehicles.get(d.vehicleId)?.ownership === 'rental'
      ? [d.requestId]
      : [],
  );
  const [shifts, persons, routeTimes] = await Promise.all([
    loadShifts(requestIds, from, coveredTo),
    loadSourcePersons(requestIds, from, coveredTo),
    loadRequestRouteTimes(db, [...new Set(rentalFreight)]),
  ]);

  const rows: ReportRow[] = [];
  for (const d of drafts.values()) {
    const vehicle = vehicles.get(d.vehicleId);
    if (!vehicle) continue;
    // Relocations and readings without a request are rows of own vehicles only (decision 10): a
    // lessor's carrier is billed by its invoice, not by the fleet's odometers.
    if (d.kind !== 'request' && vehicle.ownership !== 'own') continue;
    const requestRow = d.requestId ? requestRows.get(d.requestId) : undefined;
    const request = requestRow ? requestOf(requestRow) : null;
    const all = [...d.readingIds]
      .map((id) => readingById.get(id))
      .filter((reading): reading is PeriodReading => reading !== undefined)
      .sort((a, b) => a.shiftOrder - b.shiftOrder || a.readingId.localeCompare(b.readingId));
    const carried = all.filter((reading) => carrierOf.get(reading.readingId) === d);
    const shared = all.filter((reading) => carrierOf.get(reading.readingId) !== d);
    const vehiclesThatDay = d.requestId ? readingDays.get(`${d.requestId}|${d.date}`) : undefined;
    const routeTime =
      request?.type === 'freight_transport' &&
      vehicle.ownership === 'rental' &&
      d.kind === 'request'
        ? routeTimeOfDay(routeTimes.get(request.id), d.date)
        : null;
    rows.push({
      kind: d.kind,
      date: d.date,
      vehicle,
      request,
      readings: carried.map(stripReading),
      sharedRoutes: [
        ...new Set(
          shared.map((reading) =>
            reading.routeNum === null
              ? reading.sourceLabel
              : formatVehicleRouteNumber(reading.routeNum),
          ),
        ),
      ],
      readingPersons: [
        ...new Set(all.map((reading) => reading.personName).filter((name) => name !== '')),
      ],
      sourcePerson: d.requestId
        ? (persons.get(`${d.requestId}|${d.date}|${d.vehicleId}`) ?? null)
        : null,
      sourceLabel: d.sourceLabel,
      relocation: d.relocation,
      outOfTerm:
        d.kind === 'request' &&
        request?.type === 'special_equipment' &&
        !(termDays.get(request.id)?.has(d.date) ?? false),
      swapped: d.kind === 'request' && (vehiclesThatDay?.size ?? 0) > 1,
      shift:
        d.kind === 'request' && d.requestId
          ? (shifts.get(`${d.requestId}|${d.date}`) ?? null)
          : null,
      routeTime,
    });
  }
  return { rows, coveredTo };
}

function stripReading(reading: PeriodReading): ReportReading {
  return {
    readingId: reading.readingId,
    vehicleId: reading.vehicleId,
    date: reading.date,
    shiftOrder: reading.shiftOrder,
    kind: reading.kind,
    noDataReason: reading.noDataReason,
    personName: reading.personName,
    sourceKind: reading.sourceKind,
    sourceLabel: reading.sourceLabel,
    odometer: reading.odometer,
    engineHours: reading.engineHours,
    engineHoursReset: reading.engineHoursReset,
  };
}

/**
 * A freight day of a rented vehicle: the request's share of the route time (D6) and its span —
 * from where its first stop's segment starts to the departure from its last stop. `null` seconds
 * when any reading cannot be split, as the request card says.
 */
function routeTimeOfDay(
  time: RequestRouteTimeDto | undefined,
  date: string,
): ReportRow['routeTime'] {
  if (!time) return { seconds: null, startedAt: null, endedAt: null };
  const stops = time.readings
    .filter((reading) => reading.reportDate === date)
    .flatMap((reading) => reading.stops);
  return {
    seconds: time.seconds,
    startedAt: stops[0]?.segmentFrom ?? null,
    endedAt: stops[stops.length - 1]?.departedAt ?? null,
  };
}
