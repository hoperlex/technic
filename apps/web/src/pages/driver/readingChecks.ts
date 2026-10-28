import dayjs from 'dayjs';
import {
  readingAnomalyLabels,
  type DriverAssignmentEntry,
  type DriverPreviousReading,
  type DriverReportDto,
  type ReportItemDto,
} from '@technic/contracts';
import {
  FUEL_MAX_LITERS,
  formatReading,
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

const shortDate = (value: string): string => dayjs(value).format('DD.MM');

/**
 * What the fuel at the start of a shift must equal: the end of the previous one (ADR 0237). It is
 * the cabinet's rule alone and lives here, not with the shared input limits: the garage intake form
 * builds its previous snapshot from a reading's anomalies, which know no fuel, so the rule could
 * never fire there, and a shared copy would grow the bundle of every route that reads the limits.
 *
 * `undefined` when there is no previous shift or it left no fuel end: nothing to compare with.
 */
export function fuelStartHint(previous: DriverPreviousReading | null): string | undefined {
  const end = previous?.fuelEndLiters;
  if (!previous || end == null) return undefined;
  return `в конце прошлой смены: ${formatReading(end)} л (${shortDate(previous.measuredOn)})`;
}

/**
 * A soft warning that the fuel at the start is not the end of the previous shift. Compared to the
 * column's tenth, as the server stores it; a value outside the absolute bounds is a typo that the
 * shared hard check already refuses, and comparing a typo with anything is pointless.
 */
function fuelStartWarning(
  start: ReadingValue,
  previous: DriverPreviousReading | null,
): ReadingWarning | null {
  const end = previous?.fuelEndLiters;
  if (!previous || typeof end !== 'number' || typeof start !== 'number') return null;
  if (start < 0 || start > FUEL_MAX_LITERS) return null;
  if (Math.round(start * 10) === Math.round(end * 10)) return null;
  return {
    field: 'fuelStartLiters',
    hard: false,
    text: `Топливо на начало смены (${formatReading(start)} л) не совпадает с остатком на конец прошлой смены (${formatReading(end)} л, ${shortDate(previous.measuredOn)})`,
  };
}

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
  const numbers = readingNumbers(value);
  const warnings = readingWarnings(numbers, previous);
  const fuel = fuelStartWarning(numbers.fuelStartLiters, previous);
  if (fuel) warnings.push(fuel);
  return {
    hard: warnings.filter((warning) => warning.hard),
    notes: changed
      ? warnings.filter((warning) => !warning.hard).map((warning) => warning.text)
      : anomalyNotes(item),
  };
}
