import dayjs from 'dayjs';
import {
  readingAnomalyLabels,
  type DriverAssignmentEntry,
  type DriverPreviousReading,
  type DriverReportDto,
  type ReportItemDto,
} from '@technic/contracts';
import {
  parseReadingNumber,
  readingWarnings,
  type ReadingValue,
  type ReadingWarning,
} from '@entities/vehicle-reading';
import type { DraftItem } from './api';
import { emptyItem, sourceKey } from './readingsDraft';

/**
 * What a reading block is checked against and what it says about the input (ADR 0237).
 *
 * One module for the block (to show) and for the submit (to refuse or ask), as `readingWarnings`
 * itself is: two copies of the rule would diverge on the first day, and the form would warn about
 * one thing while the submit window asked about another. Pure — no state, no network.
 */

/** The five numbers of a block as the form reads them: a number, empty or an unreadable «145 3.». */
export function readingNumbers(value: DraftItem) {
  return {
    odometerKm: parseReadingNumber(value.odometerKm),
    engineHours: parseReadingNumber(value.engineHours),
    fuelStartLiters: parseReadingNumber(value.fuelStartLiters),
    fuelFilledLiters: parseReadingNumber(value.fuelFilledLiters),
    fuelEndLiters: parseReadingNumber(value.fuelEndLiters),
  };
}

/** A parsed number, or `null` for empty and for unreadable (the form refuses the latter earlier). */
export const numberOrNull = (value: ReadingValue): number | null =>
  typeof value === 'number' ? value : null;

/**
 * The previous shift of a block: the one its counters and its fuel start are compared with.
 *
 * The server names it per vehicle (`DriverAssignmentEntry.previous`: the latest saved reading before
 * this shift, the same day's earlier shift included). It cannot know what the driver has typed into
 * an EARLIER block of the same report and not sent yet — a day with two shifts of one vehicle is
 * filled and sent in one go — so such a block wins when it carries a number: the second shift opens
 * with what the first one is about to say it left. A block with no counter and no fuel end is not a
 * shift with data and is passed over, as the server passes over `no_data`.
 *
 * Like the server's snapshot, it is one row: a field the earlier block left empty is `null`
 * ("nothing to compare with"), not the value of an older shift.
 */
export function previousOfItem(
  item: ReportItemDto,
  report: DriverReportDto,
  values: Record<string, DraftItem>,
  entry: DriverAssignmentEntry | null,
): DriverPreviousReading | null {
  const earlier = report.items
    .filter((other) => other.vehicleId === item.vehicleId && other.shiftOrder < item.shiftOrder)
    .sort((a, b) => b.shiftOrder - a.shiftOrder);
  for (const other of earlier) {
    const typed = readingNumbers(values[sourceKey(other)] ?? emptyItem());
    const snapshot = {
      odometerKm: numberOrNull(typed.odometerKm),
      engineHours: numberOrNull(typed.engineHours),
      fuelEndLiters: numberOrNull(typed.fuelEndLiters),
    };
    if (Object.values(snapshot).some((number) => number !== null)) {
      return { ...snapshot, measuredOn: report.reportDate, daysAgo: 0 };
    }
  }
  return entry?.previous ?? null;
}

/**
 * Anomalies of a saved reading that the server recorded on an earlier submit and nobody confirmed,
 * in words and with the value they were compared with. These are in the ledger and wait for an
 * answer; the warnings of the input are computed here while typing. The driver does not care who
 * doubted first, so both are shown together.
 */
export function anomalyNotes(item: ReportItemDto): string[] {
  const reading = item.reading;
  if (!reading) return [];
  const counters = [
    { name: 'Одометр', anomaly: reading.odometerAnomaly },
    { name: 'Моточасы', anomaly: reading.engineHoursAnomaly },
  ];
  return counters
    .filter((counter) => counter.anomaly && !counter.anomaly.confirmed)
    .map(({ name, anomaly }) => {
      const previous =
        anomaly?.previousValue != null
          ? ` (предыдущее ${anomaly.previousValue}${
              anomaly.previousDate ? ` от ${dayjs(anomaly.previousDate).format('DD.MM.YYYY')}` : ''
            })`
          : '';
      return `${name}: ${anomaly ? readingAnomalyLabels[anomaly.kind] : ''}${previous}`;
    });
}

export interface BlockChecks {
  /** Outside the absolute bounds: a typo in a digit, the submit is refused whatever is confirmed. */
  hard: ReadingWarning[];
  /**
   * Discrepancies the driver confirms in the submit window. A block the driver CHANGES is judged by
   * its own numbers — the server recomputes the anomalies from them on this submit, so a stored one
   * is stale — while a block resent unchanged can only carry what the server already recorded and
   * nobody confirmed. Judging an unchanged block by its numbers would ask again, on every later
   * submit of the day, about a discrepancy confirmed five minutes ago.
   */
  notes: string[];
}

export function blockChecks(
  item: ReportItemDto,
  value: DraftItem,
  previous: DriverPreviousReading | null,
  changed: boolean,
): BlockChecks {
  const warnings = readingWarnings(readingNumbers(value), previous);
  return {
    hard: warnings.filter((warning) => warning.hard),
    notes: changed
      ? warnings.filter((warning) => !warning.hard).map((warning) => warning.text)
      : anomalyNotes(item),
  };
}
