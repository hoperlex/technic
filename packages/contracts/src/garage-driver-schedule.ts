import { z } from 'zod';
import { monthSchema } from './common';
import {
  SUBMITTED_REPORT_STATES,
  type DriverReportState,
  type ReadingKind,
} from './vehicle-readings';
import type { WaybillFormCode } from './waybills';

/**
 * A driver's month in the garage: the «График» window of the «Водители» tab (owner's request and
 * survey decisions of 28.10.2026).
 *
 * The window answers one question — "which shifts was this person due to report, and what became
 * of each" — so a shift here is exactly what the readings module expects a reading for: a route
 * with a live waybill on this driver and every calendar day of his weekly ESM-2. The server takes
 * that set from the readings module's own fragments (`EXPECTED_ROUTE_FILTER`,
 * `EXPECTED_ESM2_FILTER`); a second rule would let the window call a day missing that the intake
 * registry does not expect, or the reverse.
 *
 * Beside them the window lists the days the person is named for work that has no paper on him
 * yet (`no_paper`, shown «без листа»): a route he drives without his waybill, a day a site order's
 * assignment history names him machinist with no weekly sheet on him. No reading is expected for
 * such a day — the cabinet does not show it either — so it never counts as missing.
 *
 * The month, its bounds and "today" are the server's, by Moscow: the browser's clock may be off,
 * and east of Moscow a day starts earlier, so a window computed on the client would mark a day
 * «день не наступил» that the registry already counts as overdue.
 */

// ── Query ──

/** No month means the current Moscow month; the server answers with the month it used. */
export const garageDriverScheduleQuerySchema = z.object({ month: monthSchema.optional() }).strict();
export type GarageDriverScheduleQuery = z.infer<typeof garageDriverScheduleQuerySchema>;

// ── Shift ──

/**
 * Where a shift comes from. `route` and `esm2` are the two sources a reading belongs to (ADR 0103,
 * decision 2); `no_paper` is work the person is named for without a waybill on him.
 */
export const GARAGE_DRIVER_SHIFT_SOURCES = ['route', 'esm2', 'no_paper'] as const;
export type GarageDriverShiftSource = (typeof GARAGE_DRIVER_SHIFT_SOURCES)[number];

/**
 * What became of the shift's reading. The first five follow the reading and its report; the last
 * two say why there is nothing to follow: the day is still ahead, or no reading is due at all.
 */
export const DRIVER_SHIFT_READING_STATUSES = [
  'not_submitted',
  'submitted',
  'accepted',
  'needs_reacceptance',
  'no_data',
  'upcoming',
  'not_expected',
] as const;
export type DriverShiftReadingStatus = (typeof DRIVER_SHIFT_READING_STATUSES)[number];

export const driverShiftReadingStatusLabels: Record<DriverShiftReadingStatus, string> = {
  not_submitted: 'не передано',
  submitted: 'передано',
  accepted: 'принято',
  needs_reacceptance: 'требует повторного приёма',
  no_data: 'нет данных',
  upcoming: 'день не наступил',
  not_expected: 'показаний не ждут',
};

/**
 * «Принято» and «требует повторного приёма» must differ at a glance, as on the report card; a
 * missing reading is the one colour the month is scanned for.
 */
export const driverShiftReadingStatusColors: Record<DriverShiftReadingStatus, string> = {
  not_submitted: 'red',
  submitted: 'blue',
  accepted: 'green',
  needs_reacceptance: 'orange',
  no_data: 'gold',
  upcoming: 'default',
  not_expected: 'default',
};

/** Statuses of a shift whose reading has been handed in; `no_data` is an answer, not a gap. */
const HANDED_IN: ReadonlySet<DriverShiftReadingStatus> = new Set([
  'submitted',
  'accepted',
  'needs_reacceptance',
  'no_data',
]);

/**
 * The reading status of one shift.
 *
 * A reading counts only inside a submitted report (`SUBMITTED_REPORT_STATES`): a draft carries
 * none, and a voided report gave its rows away. `no_data` wins over the report state because it
 * is the one status whose reason the reader needs, whatever acceptance followed. A day after
 * today with nothing handed in is «день не наступил» rather than missing — a reading is taken
 * from the instrument and cannot exist before the shift; today itself is already due.
 */
export function driverShiftReadingStatus(shift: {
  /** `false` for a day without paper on the person: nothing is asked of it. */
  expectsReading: boolean;
  date: string;
  /** Moscow today, from the server. */
  today: string;
  /** The person's report for that day; `null` when the day was never opened. */
  reportState: DriverReportState | null;
  /** The reading on this shift's report row; `null` when there is none. */
  readingKind: ReadingKind | null;
}): DriverShiftReadingStatus {
  if (!shift.expectsReading) return 'not_expected';
  const counted =
    shift.readingKind !== null &&
    shift.reportState !== null &&
    SUBMITTED_REPORT_STATES.includes(shift.reportState);
  if (counted) {
    if (shift.readingKind === 'no_data') return 'no_data';
    if (shift.reportState === 'accepted') return 'accepted';
    if (shift.reportState === 'needs_reacceptance') return 'needs_reacceptance';
    return 'submitted';
  }
  return shift.date > shift.today ? 'upcoming' : 'not_submitted';
}

/**
 * The month's three numbers. `expected` counts every shift a reading is due for, the days still
 * ahead included — the month's plan, not its past; `missing` counts only the due days without a
 * reading, so `expected − submitted − missing` is the days still ahead.
 */
export interface GarageDriverScheduleSummary {
  expected: number;
  submitted: number;
  missing: number;
}

export function driverScheduleSummary(
  statuses: readonly DriverShiftReadingStatus[],
): GarageDriverScheduleSummary {
  let expected = 0;
  let submitted = 0;
  let missing = 0;
  for (const status of statuses) {
    if (status === 'not_expected') continue;
    expected += 1;
    if (HANDED_IN.has(status)) submitted += 1;
    else if (status === 'not_submitted') missing += 1;
  }
  return { expected, submitted, missing };
}

/** One shift of the month. */
export interface GarageDriverShiftDto {
  /** Stable within the answer: a route, a waybill day, or a request day without paper. */
  key: string;
  date: string;
  source: GarageDriverShiftSource;
  routeId: string | null;
  /** «Р-142»; `null` on an ESM-2 day and on an order day without paper. */
  routeNumber: string | null;
  /** The route's waybill on this driver, or the weekly sheet; `null` without paper. */
  waybill: { id: string; formCode: WaybillFormCode; number: string } | null;
  /** The site order of a day without paper that has no route («ТС-40»); `null` otherwise. */
  request: { id: string; displayNumber: string } | null;
  vehicleId: string;
  vehicleLabel: string;
  readingStatus: DriverShiftReadingStatus;
  /**
   * The person's report of that day, the address the window opens in the intake registry; `null`
   * when the day was never opened (the registry opens it) and on a day without paper.
   */
  reportId: string | null;
  /**
   * Why the shift was closed without numbers. Absent altogether without `vehicleReadings.read`:
   * the reason is the readings module's content, like the odometer of the vehicles tab, and `null`
   * would claim there was no reason instead of staying silent about access. `null` when the
   * status is not `no_data`.
   */
  noDataReason?: string | null;
}

export interface GarageDriverScheduleDto {
  personId: string;
  fullName: string;
  /** The month answered, `YYYY-MM`: the one asked for, or the current Moscow month. */
  month: string;
  from: string;
  to: string;
  /** Moscow today the statuses were computed against. */
  today: string;
  /** By date, then route, weekly sheet, and days without paper. */
  shifts: GarageDriverShiftDto[];
  summary: GarageDriverScheduleSummary;
}
