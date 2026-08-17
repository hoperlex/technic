import type { ReactNode } from 'react';
import { Space, Tooltip, Typography } from 'antd';
import type { ReadingTotals } from '@technic/contracts';
import { SummaryBar } from '@shared/ui';
import { LOWER_BOUND_HINT, boundedDecimal, decimal, isLowerBound } from './readingNumbers';

/**
 * Итог периода и качество данных — рядом, одной высоты, одинаковыми цифрами (Р27).
 *
 * Статистика оперативная: считаются все неаннулированные показания, и принятый день от
 * непринятого в числах ничем не отличается. Поэтому «сколько смен ждали, сколько пришло без чисел
 * и сколько ещё не принято» — не предупреждение мелким шрифтом внизу карточки, а вторая половина
 * ответа: 4 200 км за 30 ожидаемых смен и те же 4 200 км за 30 смен, из которых 12 без показаний, —
 * это разные утверждения, и различить их должно быть можно, не листая журнал.
 *
 * Производных показателей здесь нет ни одного: ничего, поделённого на пробег или наработку
 * (см. `readingNumbers`).
 */

const secondary = { fontSize: 12 } as const;

/** Число рядом с итогом под подсказкой. Ноль — это ответ «ни одной», и прочерком он не притворяется. */
function hinted(value: ReactNode, hint: string) {
  return (
    <Tooltip title={hint}>
      <span>{value}</span>
    </Tooltip>
  );
}

/**
 * Показатель периода с оговоркой, если он занижен. Три состояния вместо двух: прочерк («пар
 * снимков не осталось»), точное число и «не меньше N» — участок ряда потерян, но остальное
 * посчитано. Раньше третье выглядело как второе, и заниженный пробег читался как точный.
 */
function bounded(value: number | null, gaps: number, digits: number): ReactNode {
  const text = boundedDecimal(value, gaps, digits);
  return isLowerBound(value, gaps) ? hinted(text, LOWER_BOUND_HINT) : text;
}

export function ReadingCardTotals({ total }: { total: ReadingTotals }) {
  const period = [
    // Пробег и наработка бывают неизвестны целиком: прочерк — это «пары снимков в периоде не
    // осталось», а не «машина стояла».
    { label: 'Пробег, км', value: bounded(total.distanceKm, total.odometerGaps, 0) },
    { label: 'Наработка, м/ч', value: bounded(total.engineHours, total.engineHoursGaps, 1) },
    // Заправленное — сумма заправок за смены, а не разность снимков: разрыв цепочки счётчика его
    // не занижает, и оговорки здесь не будет никогда.
    { label: 'Заправлено, л', value: decimal(total.fuelFilledLiters) },
  ];

  const quality = [
    {
      label: 'Ожидалось смен',
      value: hinted(total.shifts, 'Смены периода по рейсам и ЭСМ-2 — их и ждут с показаниями'),
    },
    {
      label: 'Без показаний',
      value: hinted(total.missingReadings, 'Смена была, чисел по ней не передали'),
    },
    {
      label: 'Не принято',
      value: hinted(
        total.unacceptedShifts,
        'Показание передано, но день ещё не принят: в итог оно идёт наравне с принятым',
      ),
    },
  ];

  return (
    <Space direction="vertical" size={6} style={{ display: 'flex' }}>
      {/* Полосы переносятся, а не сжимаются: на телефоне они встают одна под другой, и качество
          данных остаётся на том же экране, что и итог. Счётчики внутри полосы не переносятся
          никогда («Пробег, км: 1 240» не должен ломаться посреди числа), поэтому узкому экрану
          оставлена прокрутка вбок — она честнее сжатого до нечитаемости ряда. */}
      <div style={{ overflowX: 'auto' }}>
        <Space size={12} wrap>
          <SummaryBar title="Итог за период" items={period} />
          <SummaryBar title="Качество данных" items={quality} />
        </Space>
      </div>
      <Typography.Text type="secondary" style={secondary}>
        Считаются все неаннулированные показания, включая непринятые: приём дня сам по себе чисел не
        меняет.
      </Typography.Text>
    </Space>
  );
}
