import { Space, Tag, Typography } from 'antd';
import { readingShiftMinutes, type VehicleReadingJournalRow } from '@technic/contracts';
import { formatDuration, timeRangeText } from '@entities/vehicle-reading';

/**
 * Shift and stop times in the vehicle's readings journal (ADR 0234; plan
 * `docs/readings-shifts-merge-plan.md` §7.5).
 *
 * Three kinds of "no time" are told apart, because each answers a different question in the garage:
 *
 * - a `v2` reading — submitted before the cabinet asked for times: «до учёта времени», legacy and
 *   nobody's omission;
 * - a `v3` reading with a start and no end — the shift was recorded in parts and the evening part
 *   has not come yet: «смена не закончена»;
 * - a `v3` reading with no time at all — staff entered the numbers without times, which D5 allows:
 *   «время не указано».
 *
 * A relocation and a `no_data` reading record no time and show a dash.
 */

const secondary = { fontSize: 12 } as const;

const DASH = <Typography.Text type="secondary">—</Typography.Text>;

/** One stop: «1. Карьер — 07:40–08:30», «2. ул. Строителей — убытие 10:05». */
function stopLine(
  point: {
    position: number;
    location: string;
    arrivedAt: string | null;
    departedAt: string | null;
  },
  first: boolean,
): string {
  const departure = point.departedAt ?? '…';
  const times = first ? `${point.arrivedAt ?? '…'}–${departure}` : `убытие ${departure}`;
  return `${point.position}. ${point.location} — ${times}`;
}

export function ShiftTimeCell({ row }: { row: VehicleReadingJournalRow }) {
  const reading = row.reading;
  if (!reading || reading.kind === 'no_data') return DASH;
  const timed = reading.startedAt !== null || reading.points.length > 0;
  if (!timed) {
    if (row.draftFormat === 'v2') return <Tag style={{ marginInlineEnd: 0 }}>до учёта времени</Tag>;
    // A route without stops is a relocation (D8): it has no time to be missing.
    if (row.sourceKind === 'route') return DASH;
    return (
      <Typography.Text type="secondary" style={secondary}>
        время не указано
      </Typography.Text>
    );
  }
  const minutes = readingShiftMinutes(row.sourceKind, reading);
  return (
    <Space orientation="vertical" size={0}>
      <span>{timeRangeText(reading.startedAt, reading.endedAt) ?? '—'}</span>
      {minutes !== null ? (
        <Typography.Text type="secondary" style={secondary}>
          {formatDuration(minutes)}
        </Typography.Text>
      ) : (
        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
          смена не закончена
        </Tag>
      )}
      {reading.points.map((point, index) => (
        <Typography.Text key={point.position} type="secondary" style={secondary}>
          {stopLine(point, index === 0)}
        </Typography.Text>
      ))}
    </Space>
  );
}
