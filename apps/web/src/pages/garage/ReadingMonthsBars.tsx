import { useId } from 'react';
import { theme } from 'antd';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
  type XAxisTickContentProps,
} from 'recharts';

/**
 * Столбики помесячной динамики — единственный модуль портала, который тянет `recharts` (Р17).
 *
 * Он отделён от [ReadingCardChart](./ReadingCardChart.tsx) ровно ради этого: там переключатель,
 * подписи и разбор чисел, здесь — рисование. Граница проходит по импорту библиотеки, поэтому
 * ленивый чанк получается настоящим: в основной бандл не попадает ни строки `recharts`, и водитель,
 * открывающий кабину с телефона, её не скачивает.
 *
 * Ряд приходит готовым (`ChartPoint`): числа, подписи и объяснения считает вызывающий. Здесь нет
 * ни одного правила про данные — иначе «прочерк вместо нуля» жил бы в двух редакциях, экранной и
 * диаграммной, и разошёлся бы при первой правке.
 *
 * Цвета берутся из токенов темы (`theme.useToken()`), а не прописаны шестнадцатеричными: тёмной
 * темы у портала сегодня нет, но и светлая живёт в `ConfigProvider`, и перекрашенный `colorPrimary`
 * обязан перекрасить столбики вместе со всем остальным.
 */

export interface ChartPoint {
  /** `YYYY-MM` — ключ ряда; подписью не служит. */
  month: string;
  /** «июнь 26» — подпись под столбиком и ключ поиска в подсказке. */
  label: string;
  /** «июнь 2026» — в подсказке, где места хватает. */
  full: string;
  /** Число выбранного счётчика; `null` — пар снимков в месяце не осталось. */
  value: number | null;
  /** Подпись над столбиком: «1240» либо «≥ 1240», если число занижено. Пусто — столбика нет. */
  text: string;
  /** Занижено ли число: ряд рвался, участок в сумму не пошёл. */
  lowerBound: boolean;
  /** Разъяснение для подсказки — почему прочерк или почему «не меньше». */
  note: string | null;
}

const TICK_FONT = 12;
/** Две строки подписи: месяц и, если ряд рвался целиком, прочерк под ним. */
const X_AXIS_HEIGHT = 44;

interface TickProps extends XAxisTickContentProps {
  byLabel: Map<string, ChartPoint>;
  labelColor: string;
  dashColor: string;
}

/**
 * Подпись месяца под осью. Второй строкой — прочерк у месяца, в котором чисел нет вовсе.
 *
 * Это и есть ответ на «месяц с разрывом помечается, а не рисуется нулём»: столбика нет, потому что
 * рисовать нечего, но пустое место под осью читалось бы как «машина стояла». Прочерк — тот же
 * знак, что в помесячной таблице, и стоит он там же, где стоял бы столбик.
 *
 * Точка ищется по подписи, а не по индексу тика: месяцы в периоде уникальны, а индексы recharts
 * считает по своим тикам, и их соответствие строкам ряда — не то свойство, на которое стоит
 * опираться.
 */
function MonthTick({ x, y, payload, byLabel, labelColor, dashColor }: TickProps) {
  const label = String(payload.value);
  const point = byLabel.get(label);
  return (
    <g transform={`translate(${Number(x)},${Number(y)})`}>
      <text textAnchor="middle" dy={14} fontSize={TICK_FONT} fill={labelColor}>
        {label}
      </text>
      {point && point.value === null ? (
        <text textAnchor="middle" dy={30} fontSize={TICK_FONT} fill={dashColor}>
          —
        </text>
      ) : null}
    </g>
  );
}

/** Подсказка месяца: число с единицей и, если есть чем, объяснение — почему оно такое. */
function MonthHint({
  point,
  unit,
  digits,
  token,
}: {
  point: ChartPoint;
  unit: string;
  digits: number;
  token: ReturnType<typeof theme.useToken>['token'];
}) {
  const value =
    point.value === null
      ? '—'
      : `${point.lowerBound ? 'не меньше ' : ''}${point.value.toFixed(digits).replace('.', ',')} ${unit}`;
  return (
    <div
      style={{
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
        boxShadow: token.boxShadowSecondary,
        padding: '6px 10px',
        maxWidth: 280,
      }}
    >
      <div style={{ color: token.colorText, fontWeight: 500 }}>{point.full}</div>
      <div style={{ color: token.colorText }}>{value}</div>
      {point.note ? (
        <div style={{ color: token.colorTextSecondary, fontSize: TICK_FONT, marginTop: 2 }}>
          {point.note}
        </div>
      ) : null}
    </div>
  );
}

export function ReadingMonthsBars({
  points,
  unit,
  digits,
  height,
}: {
  points: readonly ChartPoint[];
  /** Единица выбранного счётчика — она стоит в подсказке, а не в подписи каждого столбика. */
  unit: string;
  digits: number;
  height: number;
}) {
  const { token } = theme.useToken();
  /*
   * Штриховка объявляется своим `<pattern>` на каждую диаграмму: карточек на странице бывает
   * несколько (окно поверх окна), и общий идентификатор в документе развёл бы их фон. Двоеточия из
   * `useId` убираются — они законны в идентификаторе, но не во всяком разборе `url(#…)`.
   */
  const hatchId = `reading-gap-${useId().replace(/:/gu, '')}`;
  const byLabel = new Map(points.map((point) => [point.label, point]));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={[...points]} margin={{ top: 24, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {/*
            Штриховка — знак «число неполное». Заливкой другого цвета этого не скажешь: другой цвет
            читается как другой ряд, а диагональ поперёк столбика — как незакрашенная часть, чем
            она и является. Тот же приём, что на чертежах: сплошное — измеренное, штриховка —
            предполагаемое.
          */}
          <pattern
            id={hatchId}
            patternUnits="userSpaceOnUse"
            width={8}
            height={8}
            patternTransform="rotate(45)"
          >
            <rect width={8} height={8} fill={token.colorPrimaryBg} />
            <line x1={0} y1={0} x2={0} y2={8} stroke={token.colorPrimary} strokeWidth={4} />
          </pattern>
        </defs>
        <CartesianGrid stroke={token.colorSplit} vertical={false} />
        <XAxis
          dataKey="label"
          interval={0}
          height={X_AXIS_HEIGHT}
          tickLine={false}
          axisLine={{ stroke: token.colorBorderSecondary }}
          tick={(props: XAxisTickContentProps) => (
            <MonthTick
              {...props}
              byLabel={byLabel}
              labelColor={token.colorTextSecondary}
              dashColor={token.colorTextTertiary}
            />
          )}
        />
        <YAxis
          width={64}
          tickLine={false}
          axisLine={false}
          tick={{ fill: token.colorTextSecondary, fontSize: TICK_FONT }}
        />
        <ChartTooltip
          cursor={{ fill: token.colorFillTertiary }}
          content={({ payload }) => {
            const point = payload?.[0]?.payload as ChartPoint | undefined;
            if (!point) return null;
            return <MonthHint point={point} unit={unit} digits={digits} token={token} />;
          }}
        />
        <Bar
          dataKey="value"
          fill={token.colorPrimary}
          radius={[4, 4, 0, 0]}
          maxBarSize={64}
          /*
           * Анимации нет намеренно: карточку открывают, чтобы прочитать числа, а переключатель
           * счётчика меняет ряд целиком — «перетекание» столбиков между разными величинами
           * показывает движение, которого не было.
           */
          isAnimationActive={false}
        >
          {points.map((point) => (
            <Cell
              key={point.month}
              fill={point.lowerBound ? `url(#${hatchId})` : token.colorPrimary}
              stroke={point.lowerBound ? token.colorPrimary : undefined}
            />
          ))}
          {/*
            Подпись берётся полем ряда (`text`), а не значением: у заниженного числа перед ним
            стоит «≥», и вычислять эту разницу второй раз — значит завести второе правило.
          */}
          <LabelList
            dataKey="text"
            position="top"
            fill={token.colorText}
            fontSize={TICK_FONT}
            offset={6}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
