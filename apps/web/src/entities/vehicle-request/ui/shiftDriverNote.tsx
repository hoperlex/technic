import { Tag, Typography } from 'antd';
import {
  driverDayIssueLabels,
  driverReportStateLabels,
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
 * - an unsigned day the driver cannot sign in one click — what the readings have and since when
 *   (D3: «водитель: 23 ч с 14.08»).
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
 * The driver mark of a day for the shift table and the shift window. Everyone who reads the
 * request sees the mark and the numbers (D10); the report state and the reasons a day is not
 * clean come only in the diagnostic block, which the server sends to `vehicleReadings.read`.
 */
export function ShiftDriverNote({ shift }: { shift: VehicleRequestShiftDto }) {
  const states = [
    ...new Set((shift.driver?.readings ?? []).map((r) => driverReportStateLabels[r.reportState])),
  ];
  if (shiftSourceOf(shift) === 'driver') {
    return (
      <div style={{ lineHeight: 1.35 }}>
        <Tag color="blue" style={{ marginInlineEnd: 4 }}>
          по водителю
        </Tag>
        {states.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            отчёт: {states.join(', ').toLowerCase()}
          </Typography.Text>
        )}
      </div>
    );
  }
  const text = shiftDriverNoteText(shift);
  if (!text) return null;
  const issues = (shift.driver?.issues ?? []).map((issue) => driverDayIssueLabels[issue]);
  return (
    <div title={issues.length > 0 ? issues.join('; ') : undefined}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {text}
      </Typography.Text>
    </div>
  );
}
