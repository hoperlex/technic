import { and, between, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  MAX_MACHINE_HOURS,
  shiftDateKey,
  SUBMITTED_REPORT_STATES,
  type DiscrepancyKind,
  type DriverDayIssue,
  type DriverReportState,
  type ReadingAnomaly,
  type ReadingKind,
  type ReadingSourceKind,
  type ShiftDriverDayDto,
  type ShiftDriverDiagnosticsDto,
} from '@technic/contracts';
import { driverDailyReportItems, driverDailyReports, persons, vehicleReadings } from '../db/schema';
import { sha256hex } from '../lib/crypto';
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
  fuelFilledLiters: number | null;
  noDataReason: string;
  comment: string;
  discrepancies: { kind: DiscrepancyKind; resolved: boolean }[];
}

/** The driver's day: its public numbers (D10), the issues and the readings behind them. */
export interface DriverShiftDay extends ShiftDriverDayDto {
  date: string;
  issues: DriverDayIssue[];
  readings: DriverShiftReading[];
  /**
   * The driver's own word about the day — the first non-empty reading comment. An idle (zero-hour)
   * day signed from the readings takes it as its reason when the site wrote none (§6.5).
   */
  comment: string;
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

/** Issues of one reading by D3 and §6.1; the day sums them with its own range check. */
function readingIssues(r: DriverShiftReading, date: string): DriverDayIssue[] {
  if (r.kind === 'no_data') return ['no_data'];
  const issues: DriverDayIssue[] = [];
  if (r.engineHours === null) issues.push('missing_engine_hours');
  else if (r.engineHoursAnomaly === 'counter_reset') issues.push('counter_reset');
  else if (r.previousId === null || r.previousEngineHours === null) issues.push('first_snapshot');
  // D3: one click only when the previous snapshot is from this day or the previous calendar day.
  // Narrower than the garage's continuity (Р13а) on purpose — a Monday after a weekend without
  // readings asks the site to save the form consciously.
  if (r.previousDate !== null && r.previousDate < shiftDateKey(date, -1)) issues.push('gap');
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
): string {
  const parts = [...readings]
    .sort((a, b) => a.readingId.localeCompare(b.readingId))
    .map((r) =>
      [r.readingId, r.version, r.previousId ?? '', `${r.sourceKind}:${r.sourceId}`, r.itemId].join(
        '\u0001',
      ),
    );
  parts.push(`hours:${machineHours ?? ''}`, `refuel:${refuelLiters ?? ''}`);
  return `v1:${sha256hex(parts.join('\u0002'))}`;
}

/**
 * The driver's day from its readings (§6.2). Clean means signable in one click: every reading has
 * hours from a snapshot of this or the previous day, no blocking discrepancy, and the sum lies in
 * `0..MAX_MACHINE_HOURS`. Otherwise the day keeps the sum it has, the oldest predecessor date and
 * its issues, and never replaces the site's numbers.
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
  const yesterday = shiftDateKey(date, -1);
  const gaps: string[] = [];
  for (const r of readings) {
    for (const issue of readingIssues(r, date)) issues.add(issue);
    const hours = readingHours(r);
    if (hours !== null) hoursTenths = (hoursTenths ?? 0) + tenthsOf(hours);
    if (r.kind === 'values') refuelTenths = (refuelTenths ?? 0) + tenthsOf(r.fuelFilledLiters ?? 0);
    if (r.previousDate !== null && r.previousDate < yesterday) gaps.push(r.previousDate);
  }
  const since = gaps.length === 0 ? null : gaps.sort()[0]!;
  const machineHours = hoursTenths === null ? null : hoursTenths / 10;
  if (machineHours !== null && (machineHours < 0 || machineHours > MAX_MACHINE_HOURS)) {
    issues.add('out_of_range');
  }
  const refuelLiters = refuelTenths === null ? null : refuelTenths / 10;
  return {
    date,
    machineHours,
    refuelLiters,
    clean: readings.length > 0 && issues.size === 0,
    since,
    fingerprint: dayFingerprint(readings, machineHours, refuelLiters),
    issues: [...issues],
    readings: [...readings],
    comment: readings.map((r) => r.comment.trim()).find((c) => c !== '') ?? '',
  };
}

/** The public part of a driver day (D10): numbers, the clean flag, `since` and the fingerprint. */
export function driverDayDto(day: DriverShiftDay): ShiftDriverDayDto {
  return {
    machineHours: day.machineHours,
    refuelLiters: day.refuelLiters,
    clean: day.clean,
    since: day.since,
    fingerprint: day.fingerprint,
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

/**
 * The driver days of a request over a range of days, by day (§6.1).
 *
 * A reading belongs to request `R` and day `D` when its report is submitted
 * (`SUBMITTED_REPORT_STATES`, D2), its item is of day `D`, and either the item's ESM-2 was issued
 * for `R` (`waybills.source_request_id`) or its route serves `R` on `D`
 * (`vehicle_route_requests.work_date`). Both branches, not only the expected one: the garage
 * suppresses a day route under a weekly ESM-2 of the same day, but a report composed before the
 * suppression may still hold the route item, and its reading is still the vehicle's work here.
 *
 * Route membership is read live: the item has the route ID but no request snapshot, and a
 * composition correction (`detachRequest`) can move an unsigned day between requests. The
 * fingerprint covers the candidate set, so such a move invalidates a stale approval; a signed row
 * stays the accepted snapshot. This is not historical attribution.
 */
export async function loadDriverShiftDays(
  reader: ReadingsReader,
  requestId: string,
  range: { from: string; to: string },
): Promise<Map<string, DriverShiftDay>> {
  const days = new Map<string, DriverShiftDay>();
  if (range.to < range.from) return days;

  const rows = await reader
    .select({
      readingId: vehicleReadings.id,
      version: vehicleReadings.version,
      kind: vehicleReadings.kind,
      engineHours: vehicleReadings.engineHours,
      engineHoursAnomaly: vehicleReadings.engineHoursAnomaly,
      fuelFilledLiters: vehicleReadings.fuelFilledLiters,
      noDataReason: vehicleReadings.noDataReason,
      comment: vehicleReadings.comment,
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
    })
    .from(vehicleReadings)
    .innerJoin(driverDailyReportItems, eq(driverDailyReportItems.id, vehicleReadings.itemId))
    .innerJoin(driverDailyReports, eq(driverDailyReports.id, driverDailyReportItems.reportId))
    .innerJoin(persons, eq(persons.id, driverDailyReports.personId))
    .leftJoin(previous, eq(previous.id, vehicleReadings.previousEngineHoursId))
    .where(
      and(
        inArray(driverDailyReports.state, [...SUBMITTED_REPORT_STATES]),
        between(driverDailyReportItems.reportDate, range.from, range.to),
        // A joined query: drizzle qualifies these columns, so the correlation below cannot
        // collapse into a tautology (the single-table trap of `buildSelection`).
        or(
          and(
            eq(driverDailyReportItems.sourceKind, 'esm2'),
            sql`EXISTS (SELECT 1 FROM waybills sd_w
                         WHERE sd_w.id = ${driverDailyReportItems.waybillId}
                           AND sd_w.source_request_id = ${requestId})`,
          ),
          and(
            eq(driverDailyReportItems.sourceKind, 'route'),
            sql`EXISTS (SELECT 1 FROM vehicle_route_requests sd_rr
                         WHERE sd_rr.route_id = ${driverDailyReportItems.routeId}
                           AND sd_rr.request_id = ${requestId}
                           AND sd_rr.work_date = ${driverDailyReportItems.reportDate})`,
          ),
        ),
      ),
    );
  if (rows.length === 0) return days;

  const items: (DiscrepancyItem & { personId: string; reportId: string })[] = rows.map((row) => ({
    id: row.itemId,
    sourceKind: row.sourceKind,
    routeId: row.routeId,
    waybillId: row.waybillId,
    vehicleId: row.vehicleId,
    reportDate: row.reportDate,
    personId: row.personId,
    reportId: row.reportId,
  }));
  const live = await loadLiveSources(reader, items.map(itemRef));
  const decisions = await loadDecisions(
    reader,
    items.map((item) => item.reportId),
  );
  const discrepanciesByItem = new Map<string, { kind: DiscrepancyKind; resolved: boolean }[]>();
  for (const item of items) {
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

  const byDate = new Map<string, DriverShiftReading[]>();
  for (const row of rows) {
    const ref = itemRef(row);
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
      fuelFilledLiters: numberOrNull(row.fuelFilledLiters),
      noDataReason: row.noDataReason,
      comment: row.comment,
      discrepancies: discrepanciesByItem.get(row.itemId) ?? [],
    };
    const list = byDate.get(row.reportDate);
    if (list) list.push(reading);
    else byDate.set(row.reportDate, [reading]);
  }
  for (const [date, readings] of byDate) days.set(date, driverShiftDayOf(date, readings));
  return days;
}
