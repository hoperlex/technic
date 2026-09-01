import { lazy, Suspense, useState } from 'react';
import { Segmented, Space, Spin, Typography } from 'antd';
import type { ReadingMonthRow, ReadingTotals } from '@technic/contracts';
import { LOWER_BOUND_HINT, decimal, isLowerBound, monthLabel, monthShort } from './readingNumbers';
import type { ChartPoint } from './ReadingMonthsBars';

/**
 * Помесячная динамика столбиками с переключателем счётчика (план «Показания техники», Р17, §7).
 *
 * Таблица выше отвечает на «сколько именно», диаграмма — на «как шло»: провал в июле и ровный ряд
 * с одним всплеском выглядят в столбцах чисел одинаково, а на столбиках различаются с одного
 * взгляда. Переключатель, а не три диаграммы рядом: величины несопоставимы (километры, моточасы и
 * литры на одной оси дали бы ложное сравнение), а вопрос за раз задают один.
 *
 * **`recharts` грузится отдельным чанком** (Р17) и живёт целиком в
 * [ReadingMonthsBars](./ReadingMonthsBars.tsx). Здесь его нет ни одной строкой — только
 * `lazy`-импорт и тип точки ряда, который стирается при сборке. Цена библиотеки платится тем, кто
 * открыл карточку, а не каждым, кто зашёл на портал: водителю в кабине с телефона она не нужна
 * вовсе.
 *
 * Переключатель стоит **снаружи** ленивой границы намеренно: он и подпись видны сразу, до того как
 * чанк доехал, и заполнитель занимает место только самой картинки — блок не прыгает.
 */

const CHART_HEIGHT = 280;

type MetricKey = 'distanceKm' | 'engineHours' | 'fuelFilledLiters';

interface Metric {
  /** Подпись переключателя — с единицей: «Пробег, км» отвечает и на «в чём ось». */
  label: string;
  unit: string;
  digits: number;
  value: (row: ReadingTotals) => number | null;
  /**
   * Разрывы **своей** цепочки. У топлива их нет и быть не может: литры — не разность соседних
   * снимков, а сумма заправок за смены, и сброшенный одометр их не уменьшает. Ноль здесь — не
   * заглушка, а утверждение: заниженным заправленное от разрыва ряда не становится.
   */
  gaps: (row: ReadingTotals) => number;
}

/** Порядок в переключателе — тот же, что в таблице выше: пробег, наработка, топливо. */
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

/** Почему у месяца прочерк вместо столбика — словами, а не «нет данных». */
const NO_PAIRS_NOTE =
  'Пар снимков в месяце не осталось: считать не по чему. Это не ноль — про то, ездила машина или ' +
  'стояла, месяц не говорит.';

/**
 * Точка ряда — вся разметка чисел делается здесь, до передачи в диаграмму: рисующий модуль про
 * правила показаний ничего не знает и знать не должен.
 */
function pointOf(row: ReadingMonthRow, metric: Metric): ChartPoint {
  const value = metric.value(row);
  const lowerBound = isLowerBound(value, metric.gaps(row));
  return {
    month: row.month,
    label: monthShort(row.month),
    full: monthLabel(row.month),
    value,
    // Столбика у месяца без чисел нет — нет и подписи над ним; его место помечает прочерк под осью.
    text: value === null ? '' : `${lowerBound ? '≥ ' : ''}${decimal(value, metric.digits)}`,
    lowerBound,
    note: value === null ? NO_PAIRS_NOTE : lowerBound ? LOWER_BOUND_HINT : null,
  };
}

export function ReadingCardChart({ months }: { months: readonly ReadingMonthRow[] }) {
  const [metricKey, setMetricKey] = useState<MetricKey>('distanceKm');
  const metric = METRICS[metricKey];

  // Месяцев нет — нет и динамики. Пустые оси на месте диаграммы обещали бы данные, которых нет.
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
      <Suspense
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
      </Suspense>
      {/* Легенда объясняет ровно те знаки, которые на диаграмме сейчас есть: подпись про штриховку
          под ровным рядом без разрывов — шум, который перестают читать. */}
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
