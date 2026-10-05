import { lazy, useState } from 'react';
import { Segmented, Space, Spin, Typography } from 'antd';
import { AsyncContent } from '@shared/ui';
import type { ReadingMonthRow, ReadingTotals } from '@technic/contracts';
import { LOWER_BOUND_HINT, decimal, isLowerBound, monthLabel, monthShort } from './readingNumbers';
import type { ChartPoint } from './ReadingMonthsBars';

/**
 * Monthly dynamics with a meter selector (equipment readings plan, R17, §7).
 *
 * The table gives exact amounts; bars reveal a dip or an isolated spike at a glance. Use a
 * selector rather than three adjacent plots: kilometres, engine hours and litres are not
 * comparable on one axis, and the reader asks about one measure at a time.
 *
 * Recharts stays in a separate chunk (R17), wholly inside ReadingMonthsBars. This module has only
 * a lazy import and an erased point type: only people opening the card pay for the library, not
 * everyone entering the portal, especially drivers using phones in the cab.
 *
 * Keep the selector outside the async boundary so it and the heading appear before the chunk.
 * Only the plot gets a fixed-height placeholder, preventing a layout jump while loading.
 */

const CHART_HEIGHT = 280;

type MetricKey = 'distanceKm' | 'engineHours' | 'fuelFilledLiters';

interface Metric {
  /** Include the unit so the selector also explains the plot's axis. */
  label: string;
  unit: string;
  digits: number;
  value: (row: ReadingTotals) => number | null;
  /**
   * Gaps belong to this meter's chain. Fuel is a sum of fills, not a difference between readings,
   * so resetting the odometer cannot reduce it. Zero is a domain assertion, not a placeholder:
   * meter gaps never make the filled amount a lower bound.
   */
  gaps: (row: ReadingTotals) => number;
}

/** Match the table's order: distance, engine hours, fuel. */
const METRIC_ORDER: MetricKey[] = ['distanceKm', 'engineHours', 'fuelFilledLiters'];

const METRICS: Record<MetricKey, Metric> = {
  distanceKm: {
    label: 'Пробег, км',
    unit: 'км',
    digits: 0,
    value: (r) => r.distanceKm,
    gaps: (r) => r.odometerGaps,
  },
  engineHours: {
    label: 'Наработка, м/ч',
    unit: 'м/ч',
    digits: 1,
    value: (r) => r.engineHours,
    gaps: (r) => r.engineHoursGaps,
  },
  fuelFilledLiters: {
    label: 'Заправлено, л',
    unit: 'л',
    digits: 1,
    value: (r) => r.fuelFilledLiters,
    gaps: () => 0,
  },
};

const ReadingMonthsBars = lazy(() =>
  import('./ReadingMonthsBars').then((m) => ({ default: m.ReadingMonthsBars })),
);

/** Missing pairs are not a zero; explain what the dash cannot tell the reader. */
const NO_PAIRS_NOTE =
  'Пар снимков в месяце не осталось: считать не по чему. Это не ноль — про то, ездила машина или ' +
  'стояла, месяц не говорит.';

/**
 * Format points before passing them to the plot: the drawing module must not own reading rules.
 */
function pointOf(row: ReadingMonthRow, metric: Metric): ChartPoint {
  const value = metric.value(row);
  const lowerBound = isLowerBound(value, metric.gaps(row));
  return {
    month: row.month,
    label: monthShort(row.month),
    full: monthLabel(row.month),
    value,
    // A missing value has no bar or value label; a dash below the axis marks its position.
    text: value === null ? '' : `${lowerBound ? '≥ ' : ''}${decimal(value, metric.digits)}`,
    lowerBound,
    note: value === null ? NO_PAIRS_NOTE : lowerBound ? LOWER_BOUND_HINT : null,
  };
}

export function ReadingCardChart({ months }: { months: readonly ReadingMonthRow[] }) {
  const [metricKey, setMetricKey] = useState<MetricKey>('distanceKm');
  const metric = METRICS[metricKey];

  // Empty axes would promise a history that does not exist.
  if (months.length === 0) return null;

  const points = months.map((row) => pointOf(row, metric));
  const hasGaps = points.some((point) => point.lowerBound);
  const hasEmpty = points.some((point) => point.value === null);

  return (
    <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
      <Space size={12} wrap>
        <Typography.Text strong>Помесячно</Typography.Text>
        <Segmented<MetricKey>
          value={metricKey}
          onChange={setMetricKey}
          options={METRIC_ORDER.map((key) => ({ value: key, label: METRICS[key].label }))}
        />
      </Space>
      <AsyncContent
        fallback={
          <div
            style={{
              height: CHART_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Space orientation="vertical" align="center" size={8}>
              <Spin />
              <Typography.Text type="secondary">Диаграмма загружается</Typography.Text>
            </Space>
          </div>
        }
      >
        <ReadingMonthsBars
          points={points}
          unit={metric.unit}
          digits={metric.digits}
          height={CHART_HEIGHT}
        />
      </AsyncContent>
      {/* Explain only marks present in this plot; a hatching legend beneath an unbroken series
          would be noise the reader learns to ignore. */}
      {hasEmpty || hasGaps ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hasEmpty
            ? 'Прочерк под месяцем — пар снимков в нём не осталось: столбика нет, потому что нулём это не является. '
            : ''}
          {hasGaps
            ? 'Штриховка и «≥» — ряд в этом месяце рвался: показанное занижено, на деле не меньше.'
            : ''}
        </Typography.Text>
      ) : null}
    </Space>
  );
}
