import { Tag, Typography } from 'antd';
import {
  driverDayInterval,
  driverDayIssueLabels,
  driverReportStateLabels,
  isShiftTimeFromDriver,
  shiftSourceOf,
  type VehicleRequestShiftDto,
  workedAmountLabel,
} from '@technic/contracts';

/** `YYYY-MM-DD` as the short «14.08» the note reads with. */
function dayMonth(key: string): string {
  const [, m, d] = key.split('-');
  return `${d}.${m}`;
}

/**
 * The driver's side of a day in words (readings-shifts-merge plan §6.7), or `null` when the day's
 * numbers already are the driver's or there is nothing to add:
 *
 * - a signed day whose readings now say otherwise — the difference, never a silent rewrite (D4);
 * - an unsigned day the driver cannot sign in one click — what the readings have and, when an
 *   expected shift without numbers lies inside the pair (D16), since when the hours are counted:
 *   «водитель: 23 ч с 14.08».
 */
export function shiftDriverNoteText(shift: VehicleRequestShiftDto): string | null {
  const day = shift.driverDay;
  if (!day || shiftSourceOf(shift) === 'driver') return null;
  if (shift.approvedAt) {
    if (day.machineHours === null || day.machineHours === shift.machineHours) return null;
    return `водитель сейчас: ${workedAmountLabel('hours', day.machineHours)}`;
  }
  if (day.clean) return null;
  const hours =
    day.machineHours === null ? 'моточасов нет' : workedAmountLabel('hours', day.machineHours);
  return `водитель: ${hours}${day.since ? ` с ${dayMonth(day.since)}` : ''}`;
}

/**
 * Why a day carries «рейс общий» next to its hours (D13): its route served other requests too, so
 * the hours are the whole route's — one engine-hour counter cannot be split by stops — while the
 * time is the day's own stops.
 */
const SHARED_ROUTE_HINT =
  'Машина в этот день возила и другие заявки: моточасы — за весь рейс, время — по точкам этой заявки';

/**
 * The driver mark of a day for the shift table and the shift window. Everyone who reads the
 * request sees the mark and the numbers (D10); the report state and the reasons a day is not
 * clean come only in the diagnostic block, which the server sends to `vehicleReadings.read`.
 */
export function ShiftDriverNote({ shift }: { shift: VehicleRequestShiftDto }) {
  const states = [
    ...new Set((shift.driver?.readings ?? []).map((r) => driverReportStateLabels[r.reportState])),
  ];
  const shared = shift.driverDay?.sharedRoute === true && (
    <Tag style={{ marginInlineEnd: 4 }} title={SHARED_ROUTE_HINT}>
      рейс общий
    </Tag>
  );
  if (shiftSourceOf(shift) === 'driver') {
    return (
      <div style={{ lineHeight: 1.35 }}>
        <Tag color="blue" style={{ marginInlineEnd: 4 }}>
          по водителю
        </Tag>
        {shared}
        {states.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            отчёт: {states.join(', ').toLowerCase()}
          </Typography.Text>
        )}
      </div>
    );
  }
  const text = shiftDriverNoteText(shift);
  if (!text) return shared ? <div>{shared}</div> : null;
  const issues = (shift.driver?.issues ?? []).map((issue) => driverDayIssueLabels[issue]);
  return (
    <div title={issues.length > 0 ? issues.join('; ') : undefined}>
      {shared}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {text}
      </Typography.Text>
    </div>
  );
}

/**
 * The driver's side of a day's shift time (plan §8), or `null` when there is nothing to add:
 *
 * - the time shown is the driver's — a short mark, it is corrected in the garage like the hours;
 * - a signed day whose readings now give another interval — the difference, never a rewrite;
 * - an unsigned driver day whose readings do not fold into one interval — the intervals, so the
 *   site types the time knowing what the drivers recorded instead of the portal inventing one.
 */
export function shiftTimeNoteText(shift: VehicleRequestShiftDto): string | null {
  const day = shift.driverDay;
  if (!day) return null;
  if (isShiftTimeFromDriver(shift)) return 'время по водителю';
  if (shift.approvedAt) {
    const now = driverDayInterval(day);
    if (!now || (now.startedAt === shift.startedAt && now.endedAt === shift.endedAt)) return null;
    return `водитель сейчас: ${now.startedAt} – ${now.endedAt}`;
  }
  if (shiftSourceOf(shift) !== 'driver' || day.timeIssue !== 'ambiguous') return null;
  const intervals = (day.intervals ?? []).map((i) => `${i.startedAt} – ${i.endedAt}`).join(', ');
  return `водитель: ${intervals} — время смены указывает объект`;
}

/** The driver note under a day's shift time, for the card's shift tab and the shift window. */
export function ShiftTimeNote({ shift }: { shift: VehicleRequestShiftDto }) {
  const text = shiftTimeNoteText(shift);
  if (!text) return null;
  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {text}
      </Typography.Text>
    </div>
  );
}
