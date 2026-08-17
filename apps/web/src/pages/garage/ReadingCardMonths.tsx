import type { ReactNode } from 'react';
import { Table, Tooltip, Typography, type TableColumnType } from 'antd';
import type { ReadingMonthRow, ReadingTotals } from '@technic/contracts';
import {
  LOWER_BOUND_HINT,
  boundedDecimal,
  decimal,
  isLowerBound,
  monthLabel,
} from './readingNumbers';

/**
 * Помесячная таблица карточки: те же показатели, что в итоге, плюс разрывы (Р4, Р28).
 *
 * Строка «Итого» берёт числа **из итога ответа**, а не складывает столбцы на портале. Сумма месяцев
 * равна итогу периода по устройству расчёта (пара разностей засчитывается в месяц текущего снимка,
 * Р4) — но проверять это свойство сложением в браузере значило бы иметь два ответа на один вопрос:
 * при расхождении портал показал бы своё, и расхождение осталось бы незамеченным. Здесь шапка итога
 * и нижняя строка таблицы — буквально одно число, показанное дважды.
 *
 * Разрывы стоят в тех же строках не для полноты: ими измеряется, насколько соседним числам можно
 * верить. Три разных числа, а не одно (Р28): цепочки одометра и моточасов независимы, а «смена без
 * показания» живёт вообще на другой координате — она про ожидание, а не про оборвавшийся ряд.
 */

/** Ноль разрывов — это «их нет»: серый прочерк тише нуля, и глаз цепляется за ненулевые строки. */
function count(value: number): ReactNode {
  return value === 0 ? <Typography.Text type="secondary">—</Typography.Text> : value;
}

/**
 * Показатель месяца с оговоркой, если ряд в нём рвался.
 *
 * Соседняя колонка «Разрывов одометра» ту же правду говорит, но другим числом и в другом месте:
 * связать «2» в одной ячейке с заниженным пробегом в другой читатель обязан сам, и обычно не
 * связывает. Оговорка стоит там, где стоит число, — и в той же формулировке, что в итоге периода.
 */
function bounded(value: number | null, gaps: number, digits: number): ReactNode {
  const text = boundedDecimal(value, gaps, digits);
  if (!isLowerBound(value, gaps)) return text;
  return (
    <Tooltip title={LOWER_BOUND_HINT}>
      <span>{text}</span>
    </Tooltip>
  );
}

interface Metric {
  key: string;
  title: string;
  hint?: string;
  width: number;
  value: (row: ReadingTotals) => ReactNode;
}

/**
 * Показатели месяца — одним списком, из которого строятся и колонки, и строка «Итого». Разъехаться
 * они поэтому не могут: порядок, подписи и формат у них общие.
 */
const METRICS: Metric[] = [
  {
    key: 'shifts',
    title: 'Смен',
    hint: 'Ожидаемые смены месяца: рейсы и ЭСМ-2, с которых ждут показания',
    width: 90,
    value: (r) => count(r.shifts),
  },
  {
    key: 'distanceKm',
    title: 'Пробег, км',
    width: 150,
    value: (r) => bounded(r.distanceKm, r.odometerGaps, 0),
  },
  {
    key: 'engineHours',
    title: 'Наработка, м/ч',
    width: 160,
    value: (r) => bounded(r.engineHours, r.engineHoursGaps, 1),
  },
  {
    key: 'fuelFilledLiters',
    title: 'Заправлено, л',
    width: 130,
    // Оговорки нет намеренно: литры — сумма заправок за смены, разрыв цепочки их не занижает.
    value: (r) => decimal(r.fuelFilledLiters),
  },
  {
    key: 'odometerGaps',
    title: 'Разрывов одометра',
    hint: 'Сброшенный одометр: переход через сброс неизвестен, и участок в пробег не идёт',
    width: 150,
    value: (r) => count(r.odometerGaps),
  },
  {
    key: 'engineHoursGaps',
    title: 'Разрывов моточасов',
    hint: 'Сброшенный счётчик моточасов: тот же разрыв, но у своей цепочки',
    width: 155,
    value: (r) => count(r.engineHoursGaps),
  },
  {
    key: 'missingReadings',
    title: 'Без показаний',
    hint: 'Ожидаемая смена, по которой чисел не передали',
    width: 130,
    value: (r) => count(r.missingReadings),
  },
  {
    key: 'unacceptedShifts',
    title: 'Не принято',
    hint: 'Показания переданы, день ещё не принят — в числа месяца они всё равно вошли',
    width: 120,
    value: (r) => count(r.unacceptedShifts),
  },
];

const columns: TableColumnType<ReadingMonthRow>[] = [
  {
    key: 'month',
    title: 'Месяц',
    width: 140,
    fixed: 'left',
    render: (_v, r) => monthLabel(r.month),
  },
  ...METRICS.map<TableColumnType<ReadingMonthRow>>((metric) => ({
    key: metric.key,
    title: metric.hint ? (
      <Tooltip title={metric.hint}>
        <span>{metric.title}</span>
      </Tooltip>
    ) : (
      metric.title
    ),
    width: metric.width,
    align: 'right',
    render: (_v, r) => metric.value(r),
  })),
];

export function ReadingCardMonths({
  months,
  total,
}: {
  months: readonly ReadingMonthRow[];
  /** Итог периода из ответа: он же и стоит строкой «Итого» — своего сложения у портала нет. */
  total: ReadingTotals;
}) {
  return (
    <Table<ReadingMonthRow>
      rowKey="month"
      size="small"
      columns={columns}
      dataSource={[...months]}
      pagination={false}
      // Месяцев в периоде не больше года (`MAX_PERIOD_DAYS`), и страницы им не нужны; ширину
      // забирают колонки, поэтому таблица прокручивается вбок, а месяц остаётся на месте.
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: 'За период не пришло ни одного месяца' }}
      summary={() =>
        months.length === 0 ? null : (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>
              <Typography.Text strong>Итого</Typography.Text>
            </Table.Summary.Cell>
            {METRICS.map((metric, index) => (
              <Table.Summary.Cell key={metric.key} index={index + 1} align="right">
                <Typography.Text strong>{metric.value(total)}</Typography.Text>
              </Table.Summary.Cell>
            ))}
          </Table.Summary.Row>
        )
      }
    />
  );
}
