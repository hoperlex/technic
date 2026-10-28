import { and, between, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  driverDayTime,
  MAX_MACHINE_HOURS,
  requestRouteSpan,
  routeScalarTimes,
  SUBMITTED_REPORT_STATES,
  type DiscrepancyKind,
  type DriverDayIssue,
  type DriverReportState,
  type ReadingAnomaly,
  type ReadingKind,
  type ReadingSourceKind,
  type ReadingTimes,
  type ShiftDriverDayDto,
  type ShiftDriverDiagnosticsDto,
} from '@technic/contracts';
import {
  driverDailyReportItems,
  driverDailyReports,
  persons,
  vehicleReadings,
  vehicleRouteRequests,
  waybills,
} from '../db/schema';
import { sha256hex } from '../lib/crypto';
import { clockTime, loadReadingPoints } from './reading-points';
import { counterPairKey, loadBrokenCounterPairs, servedRequestSql } from './readings-expected';
import {
  findDiscrepancies,
  itemRef,
  loadDecisions,
  loadLiveSources,
  resolutionOf,
  sourceKey,
  type DiscrepancyItem,
  type ReadingsReader,
} from './readings-discrepancies';

/**
 * The driver's readings as the numbers of a special-equipment request day (readings-shifts-merge
 * plan §6.1–§6.3, ADR 0184 section "Driver readings as the day's numbers").
 *
 * A request day is a view, not a second store (D1): nothing is copied into the shift table when a
 * driver submits. The shift table reads this module for every day of the term and keeps its own
 * row only for the site's sign-off, a manual record and the site's time and comment.
 */

/**
 * Discrepancy kinds that make a day non-clean while unresolved (§6.1). `driver` is not among them:
 * the counter belongs to the vehicle, and the garage counts the vehicle's shift, not the person's
 * (`EXPECTED_ROUTE_FILTER`) — an ESM-2 reissued to a substitute machinist is the ordinary case.
 * `missing_source` describes a source without an item and never applies to an existing reading.
 */
const BLOCKING_DISCREPANCIES: ReadonlySet<DiscrepancyKind> = new Set([
  'vehicle',
  'date',
  'source_state',
]);

/** One submitted reading of a request day with what the day's rule needs to judge it. */
export interface DriverShiftReading {
  readingId: string;
  version: number;
  itemId: string;
  reportState: DriverReportState;
  personName: string;
  sourceKind: ReadingSourceKind;
  sourceId: string;
  sourceLabel: string;
  kind: ReadingKind;
  engineHours: number | null;
  engineHoursAnomaly: ReadingAnomaly | null;
  /** The engine-hour chain link (`previous_engine_hours_id`); never searched for again here. */
  previousId: string | null;
  previousEngineHours: number | null;
  previousDate: string | null;
  /**
   * The engine-hour pair is continuous by the readings module's rule (Р13а, D16): no expected shift
   * of the vehicle without numbers lies between the predecessor and this day
   * (`counterPairBrokenSql`, the month aggregate's own definition). `true` when there is no pair to
   * judge: a first snapshot, a missing counter or a reset are issues of their own.
   */
  continuous: boolean;
  fuelFilledLiters: number | null;
  noDataReason: string;
  comment: string;
  discrepancies: { kind: DiscrepancyKind; resolved: boolean }[];
  /**
   * The reading's shift time for THIS request (ADR 0234, D13): an ESM-2 pair, or the request's own
   * span of a recorded route (`requestRouteSpan`) — a route's duration is read by its steps, never
   * from the pair alone.
   */
  times: ReadingTimes;
  /** A route reading whose route serves other requests too (D13); always `false` for an ESM-2. */
  sharedRoute: boolean;
}

/** The driver's day: its public numbers (D10), the issues and the readings behind them. */
export interface DriverShiftDay extends ShiftDriverDayDto {
  date: string;
  issues: DriverDayIssue[];
  readings: DriverShiftReading[];
}

/**
 * Hours of one reading: the delta to its engine-hour predecessor when both counters exist and the
 * counter was not reset. Counted in tenths — the column's scale — so a sum of deltas carries no
 * binary noise into the 0..24 check or the fingerprint.
 */
function tenthsOf(value: number): number {
  return Math.round(value * 10);
}

function readingHours(r: DriverShiftReading): number | null {
  if (r.kind !== 'values' || r.engineHours === null || r.previousEngineHours === null) return null;
  if (r.engineHoursAnomaly === 'counter_reset') return null;
  return (tenthsOf(r.engineHours) - tenthsOf(r.previousEngineHours)) / 10;
}

/** Issues of one reading by D3, D16 and §6.1; the day sums them with its own range check. */
function readingIssues(r: DriverShiftReading): DriverDayIssue[] {
  if (r.kind === 'no_data') return ['no_data'];
  const issues: DriverDayIssue[] = [];
  if (r.engineHours === null) issues.push('missing_engine_hours');
  else if (r.engineHoursAnomaly === 'counter_reset') issues.push('counter_reset');
  else if (r.previousId === null || r.previousEngineHours === null) issues.push('first_snapshot');
  // D16 replaced D3's "the previous snapshot is from this or the previous calendar day" with the
  // garage's own continuity: the delta must not cover an expected shift that has no numbers.
  if (!r.continuous) issues.push('gap');
  if (r.discrepancies.some((d) => !d.resolved && BLOCKING_DISCREPANCIES.has(d.kind))) {
    issues.push('discrepancy');
  }
  return issues;
}

/**
 * The fingerprint of what is signed (§6.4): the candidate readings with their versions, their
 * predecessors and sources, and the computed numbers. The report state is deliberately absent — a
 * dispatcher accepting the report changes no number, and a 409 for it would answer the site's
 * click for nothing. A composition correction that moves a route out of the request changes the
 * candidate set and therefore the fingerprint.
 */
function dayFingerprint(
  readings: readonly DriverShiftReading[],
  machineHours: number | null,
  refuelLiters: number | null,
  time: { startedAt: string | null; endedAt: string | null },
): string {
  const parts = [...readings]
    .sort((a, b) => a.readingId.localeCompare(b.readingId))
    .map((r) =>
      [r.readingId, r.version, r.previousId ?? '', `${r.sourceKind}:${r.sourceId}`, r.itemId].join(
        '\u0001',
      ),
    );
  parts.push(`hours:${machineHours ?? ''}`, `refuel:${refuelLiters ?? ''}`);
  // The driver's interval is signed with the numbers (plan §8). Appended only when there is one, so
  // a day without driver times keeps the fingerprint an open tab of stage 1 already holds.
  if (time.startedAt !== null && time.endedAt !== null) {
    parts.push(`time:${time.startedAt}-${time.endedAt}`);
  }
  return `v1:${sha256hex(parts.join('\u0002'))}`;
}

/**
 * The driver's day from its readings (§6.2). Clean means signable in one click: every reading has
 * hours over a continuous pair (D16), no blocking discrepancy, and the sum lies in
 * `0..MAX_MACHINE_HOURS`. Otherwise the day keeps the sum it has, the oldest predecessor of a broken
 * pair and its issues, and never replaces the site's numbers.
 *
 * An empty refill reads as "not refuelled", as the readings module reads it (the month aggregate
 * and the readings book): the driver form cannot say "unknown" apart from empty, and reading `null`
 * as unknown here would put the request card and the garage at odds. Refuelling therefore never
 * affects cleanliness.
 */
export function driverShiftDayOf(
  date: string,
  readings: readonly DriverShiftReading[],
): DriverShiftDay {
  const issues = new Set<DriverDayIssue>();
  let hoursTenths: number | null = null;
  let refuelTenths: number | null = null;
  const gaps: string[] = [];
  for (const r of readings) {
    for (const issue of readingIssues(r)) issues.add(issue);
    const hours = readingHours(r);
    if (hours !== null) hoursTenths = (hoursTenths ?? 0) + tenthsOf(hours);
    if (r.kind === 'values') refuelTenths = (refuelTenths ?? 0) + tenthsOf(r.fuelFilledLiters ?? 0);
    if (!r.continuous && r.previousDate !== null) gaps.push(r.previousDate);
  }
  const since = gaps.length === 0 ? null : gaps.sort()[0]!;
  const machineHours = hoursTenths === null ? null : hoursTenths / 10;
  if (machineHours !== null && (machineHours < 0 || machineHours > MAX_MACHINE_HOURS)) {
    issues.add('out_of_range');
  }
  const refuelLiters = refuelTenths === null ? null : refuelTenths / 10;
  // The time does not decide cleanliness: a clean day without one interval keeps the site's time
  // (plan §8), it does not stop being signable by its numbers.
  const time = driverDayTime(readings.map((r) => ({ sourceKind: r.sourceKind, times: r.times })));
  return {
    date,
    machineHours,
    refuelLiters,
    clean: readings.length > 0 && issues.size === 0,
    since,
    fingerprint: dayFingerprint(readings, machineHours, refuelLiters, time),
    startedAt: time.startedAt,
    endedAt: time.endedAt,
    intervals: time.intervals,
    timeIssue: time.issue,
    sharedRoute: readings.some((r) => r.sharedRoute),
    issues: [...issues],
    readings: [...readings],
  };
}

/**
 * The effective day is the driver's: a clean day has its hours, and nothing else of the driver's is
 * ever signable in one click. One question for the shift table, its write doors, the summary book
 * and the garage occupancy (D14, D15), so a day cannot count as the driver's in one reader and not
 * in another.
 */
export function isDriverDaySignable(
  day: DriverShiftDay | null | undefined,
): day is DriverShiftDay & { machineHours: number } {
  return !!day?.clean && day.machineHours !== null;
}

/** The public part of a driver day (D10): numbers, the clean flag, `since` and the fingerprint. */
export function driverDayDto(day: DriverShiftDay): ShiftDriverDayDto {
  return {
    machineHours: day.machineHours,
    refuelLiters: day.refuelLiters,
    clean: day.clean,
    since: day.since,
    fingerprint: day.fingerprint,
    startedAt: day.startedAt ?? null,
    endedAt: day.endedAt ?? null,
    intervals: day.intervals ?? [],
    timeIssue: day.timeIssue ?? null,
    sharedRoute: day.sharedRoute ?? false,
  };
}

/** The diagnostic block, for a principal with `vehicleReadings.read` only (D10). */
export function driverDiagnosticsDto(day: DriverShiftDay): ShiftDriverDiagnosticsDto {
  return {
    issues: day.issues,
    readings: day.readings.map((r) => ({
      readingId: r.readingId,
      personName: r.personName,
      reportState: r.reportState,
      sourceKind: r.sourceKind,
      sourceLabel: r.sourceLabel,
      kind: r.kind,
      machineHours: readingHours(r),
      refuelLiters: r.kind === 'values' ? (r.fuelFilledLiters ?? 0) : null,
      previousDate: r.previousDate,
      noDataReason: r.noDataReason,
      comment: r.comment,
      discrepancies: r.discrepancies,
    })),
  };
}

const previous = alias(vehicleReadings, 'previous_engine_hours');

/** pg returns `numeric` as a string; an empty counter stays empty, not zero. */
function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** What one submitted reading brings from the database, whichever request branch found it. */
const readingColumns = {
  readingId: vehicleReadings.id,
  version: vehicleReadings.version,
  kind: vehicleReadings.kind,
  engineHours: vehicleReadings.engineHours,
  engineHoursAnomaly: vehicleReadings.engineHoursAnomaly,
  fuelFilledLiters: vehicleReadings.fuelFilledLiters,
  noDataReason: vehicleReadings.noDataReason,
  comment: vehicleReadings.comment,
  startedAt: vehicleReadings.startedAt,
  endedAt: vehicleReadings.endedAt,
  previousId: vehicleReadings.previousEngineHoursId,
  previousEngineHours: previous.engineHours,
  previousDate: previous.reportDate,
  itemId: driverDailyReportItems.id,
  sourceKind: driverDailyReportItems.sourceKind,
  routeId: driverDailyReportItems.routeId,
  waybillId: driverDailyReportItems.waybillId,
  vehicleId: driverDailyReportItems.vehicleId,
  reportDate: driverDailyReportItems.reportDate,
  reportId: driverDailyReports.id,
  reportState: driverDailyReports.state,
  personId: driverDailyReports.personId,
  personName: persons.fullName,
};

/** The route row that makes a route reading a request's: the linear day of `work_date`. */
const member = alias(vehicleRouteRequests, 'sd_member');

/**
 * The driver days of several requests over one range of days, by request and day (§6.1): the
 * summary book and the garage occupancy read many requests at once (D14, D15), and a query per
 * request would put a loop of queries under every period they cover. The shift table of one
 * request asks the same reader (`loadDriverShiftDays`), so the rule cannot differ between them.
 *
 * A reading belongs to request `R` and day `D` when its report is submitted
 * (`SUBMITTED_REPORT_STATES`, D2), its item is of day `D`, and either the item's ESM-2 was issued
 * for `R` (`waybills.source_request_id`) or its route serves `R` on `D`
 * (`vehicle_route_requests.work_date`). Both branches, not only the expected one: the garage
 * suppresses a day route under a weekly ESM-2 of the same day, but a report composed before the
 * suppression may still hold the route item, and its reading is still the vehicle's work here. A
 * route reading serving two linear requests of the day belongs to both, each with its own span.
 *
 * Route membership is read live: the item has the route ID but no request snapshot, and a
 * composition correction (`detachRequest`) can move an unsigned day between requests. The
 * fingerprint covers the candidate set, so such a move invalidates a stale approval; a signed row
 * stays the accepted snapshot. This is not historical attribution — the stop snapshot is, and the
 * day's time is read from it (D13).
 */
export async function loadDriverShiftDaysByRequest(
  reader: ReadingsReader,
  requestIds: readonly string[],
  range: { from: string; to: string },
): Promise<Map<string, Map<string, DriverShiftDay>>> {
  const result = new Map<string, Map<string, DriverShiftDay>>();
  const ids = [...new Set(requestIds)];
  if (ids.length === 0 || range.to < range.from) return result;

  const common = and(
    inArray(driverDailyReports.state, [...SUBMITTED_REPORT_STATES]),
    between(driverDailyReportItems.reportDate, range.from, range.to),
  );
  const [esm2Rows, routeRows] = await Promise.all([
    reader
      .select({
        ...readingColumns,
        requestId: sql<string>`${waybills.sourceRequestId}`,
        routeServesOthers: sql<boolean>`false`,
      })
      .from(vehicleReadings)
      .innerJoin(driverDailyReportItems, eq(driverDailyReportItems.id, vehicleReadings.itemId))
      .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
      .innerJoin(persons, eq(persons.id, driverDailyReports.personId))
      .leftJoin(previous, eq(previous.id, vehicleReadings.previousEngineHoursId))
      .innerJoin(waybills, eq(waybills.id, driverDailyReportItems.waybillId))
      .where(
        and(
          common,
          eq(driverDailyReportItems.sourceKind, 'esm2'),
          inArray(waybills.sourceRequestId, ids),
        ),
      ),
    reader
      .select({
        ...readingColumns,
        requestId: member.requestId,
        // Whether the live composition holds another served request: the shared-route answer of a
        // reading whose stops were never captured (D13). A joined query: drizzle qualifies the
        // outer columns, so the correlation cannot collapse into a tautology.
        routeServesOthers: sql<boolean>`EXISTS (
          SELECT 1 FROM vehicle_route_requests sd_o
            JOIN vehicle_requests sd_q ON sd_q.id = sd_o.request_id
           WHERE sd_o.route_id = ${driverDailyReportItems.routeId}
             AND sd_o.request_id <> ${member.requestId}
             AND ${servedRequestSql('sd_q')})`,
      })
      .from(vehicleReadings)
      .innerJoin(driverDailyReportItems, eq(driverDailyReportItems.id, vehicleReadings.itemId))
      .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
      .innerJoin(persons, eq(persons.id, driverDailyReports.personId))
      .leftJoin(previous, eq(previous.id, vehicleReadings.previousEngineHoursId))
      .innerJoin(
        member,
        and(
          eq(member.routeId, driverDailyReportItems.routeId),
          eq(member.workDate, driverDailyReportItems.reportDate),
        ),
      )
      .where(
        and(common, eq(driverDailyReportItems.sourceKind, 'route'), inArray(member.requestId, ids)),
      ),
  ]);
  const rows = [...esm2Rows, ...routeRows];
  if (rows.length === 0) return result;

  // Everything below is per item or per reading, read once however many requests share them.
  const items = new Map<string, DiscrepancyItem & { reportId: string; personId: string }>();
  for (const row of rows) {
    items.set(row.itemId, {
      id: row.itemId,
      sourceKind: row.sourceKind,
      routeId: row.routeId,
      waybillId: row.waybillId,
      vehicleId: row.vehicleId,
      reportDate: row.reportDate,
      reportId: row.reportId,
      personId: row.personId,
    });
  }
  const live = await loadLiveSources(reader, [...items.values()].map(itemRef));
  const decisions = await loadDecisions(
    reader,
    [...items.values()].map((item) => item.reportId),
  );
  // A route's duration is the sum of its steps (ADR 0234), so its stops come along, with the request
  // snapshot that says whose work each stop was (D13); an ESM-2 pair is read by `shiftSpanMinutes`.
  const points = await loadReadingPoints(
    reader,
    rows.filter((row) => row.sourceKind === 'route').map((row) => row.readingId),
  );
  const discrepanciesByItem = new Map<string, { kind: DiscrepancyKind; resolved: boolean }[]>();
  for (const item of items.values()) {
    // No day refs: `missing_source` never applies to an item that exists (§6.1).
    const found = findDiscrepancies(item, [item], [], live);
    discrepanciesByItem.set(
      item.id,
      found.map((d) => ({
        kind: d.kind,
        resolved: resolutionOf(d, decisions.get(item.reportId)).resolved,
      })),
    );
  }

  const byRequestDate = new Map<string, Map<string, DriverShiftReading[]>>();
  const snapshots: SnapshotOf[] = [];
  for (const row of rows) {
    const ref = itemRef(row);
    const stored = points.get(row.readingId) ?? [];
    const scalar = { startedAt: clockTime(row.startedAt), endedAt: clockTime(row.endedAt) };
    // D13: a route reading with captured stops gives the request its own span; one without stops
    // has no attribution to cut by, keeps its scalar pair (no route duration without steps) and
    // answers "shared" by the live composition.
    const span =
      row.sourceKind === 'route' && stored.length > 0
        ? requestRouteSpan(stored, row.requestId)
        : null;
    const reading: DriverShiftReading = {
      readingId: row.readingId,
      version: row.version,
      itemId: row.itemId,
      reportState: row.reportState,
      personName: row.personName,
      sourceKind: row.sourceKind,
      sourceId: ref.id,
      sourceLabel: live.get(sourceKey(ref))?.label ?? '',
      kind: row.kind,
      engineHours: numberOrNull(row.engineHours),
      engineHoursAnomaly: row.engineHoursAnomaly,
      previousId: row.previousId,
      previousEngineHours: numberOrNull(row.previousEngineHours),
      previousDate: row.previousDate,
      continuous: true,
      fuelFilledLiters: numberOrNull(row.fuelFilledLiters),
      noDataReason: row.noDataReason,
      comment: row.comment,
      discrepancies: discrepanciesByItem.get(row.itemId) ?? [],
      times: span
        ? { ...routeScalarTimes(span.points), points: span.points }
        : { ...scalar, points: [] },
      sharedRoute: span ? span.shared : row.sourceKind === 'route' && row.routeServesOthers,
    };
    const days = byRequestDate.get(row.requestId) ?? new Map<string, DriverShiftReading[]>();
    byRequestDate.set(row.requestId, days);
    const list = days.get(row.reportDate);
    if (list) list.push(reading);
    else days.set(row.reportDate, [reading]);
    snapshots.push({ reading, vehicleId: row.vehicleId, date: row.reportDate });
  }
  await markBrokenPairs(reader, snapshots);
  for (const [requestId, days] of byRequestDate) {
    const byDay = new Map<string, DriverShiftDay>();
    for (const [date, readings] of days) byDay.set(date, driverShiftDayOf(date, readings));
    result.set(requestId, byDay);
  }
  return result;
}

/** The driver days of one request over a range of days, by day: the batch reader for one. */
export async function loadDriverShiftDays(
  reader: ReadingsReader,
  requestId: string,
  range: { from: string; to: string },
): Promise<Map<string, DriverShiftDay>> {
  return (
    (await loadDriverShiftDaysByRequest(reader, [requestId], range)).get(requestId) ?? new Map()
  );
}

/**
 * Judges the engine-hour pair of every reading that has hours by the readings module's continuity
 * rule (D16): one query for all of them, the same fragment the month aggregate checks its fuel norm
 * by. A reading without hours is not asked — its own issue already keeps the day manual.
 */
async function markBrokenPairs(
  reader: ReadingsReader,
  snapshots: readonly SnapshotOf[],
): Promise<void> {
  const judged = snapshots.flatMap(({ reading, vehicleId, date }) =>
    readingHours(reading) !== null && reading.previousDate !== null
      ? [{ reading, pair: { vehicleId, previousDate: reading.previousDate, date } }]
      : [],
  );
  const broken = await loadBrokenCounterPairs(
    reader,
    'engineHours',
    judged.map(({ pair }) => pair),
  );
  for (const { reading, pair } of judged) reading.continuous = !broken.has(counterPairKey(pair));
}

/** A reading with the coordinates of its snapshot: the vehicle and the day of its item. */
interface SnapshotOf {
  reading: DriverShiftReading;
  vehicleId: string;
  date: string;
}
