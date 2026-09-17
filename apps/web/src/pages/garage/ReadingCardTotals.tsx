import type { ReactNode } from 'react';
import { Space, Tooltip, Typography } from 'antd';
import { fuelDeviation, type ReadingTotals } from '@technic/contracts';
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
 * Сверка с нормой расхода стоит **третьей полосой**, а не в итоге периода (план
 * `docs/fuel-norms-plan.md`, §4.2): в «Итоге» уже три показателя рядом с полосой качества, и
 * шестью счётчиками ряд перестаёт читаться. Полоса появляется только у машины с нормой — сверять
 * без неё нечего, и пустая полоса из прочерков сообщала бы лишь о своём существовании.
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

export function ReadingCardTotals({
  total,
  hasNorm,
  tolerancePercent,
}: {
  total: ReadingTotals;
  /** У машины есть норма, действующая в периоде: без неё полосы сверки нет вовсе (Р15а). */
  hasNorm: boolean;
  /** Допуск приезжает вместе с числами (Р12б): своей ручки настроек у карточки нет. */
  tolerancePercent: number;
}) {
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

  /**
   * Сверка: расход сверяемых смен, норма по ним же и отклонение между ними. Отклонение считается
   * общей функцией контрактов — той же, какой его считают сводка, полоса парка и книги.
   */
  const dev = fuelDeviation(total.fuelSpentLiters, total.fuelNormLiters, tolerancePercent);
  const deviationText =
    dev.liters === null || dev.percent === null
      ? '—'
      : `${dev.liters > 0 ? '+' : ''}${decimal(dev.liters)} л · ${dev.percent > 0 ? '+' : ''}${decimal(dev.percent)}%`;
  const check = [
    {
      label: 'Расход, л',
      value: hinted(
        total.verifiedShifts === 0 ? '—' : decimal(total.fuelSpentLiters),
        'Расход смен, прошедших сверку: остатки в баке сданы, пара снимков непрерывна',
      ),
    },
    { label: 'Норма, л', value: total.verifiedShifts === 0 ? '—' : decimal(total.fuelNormLiters) },
    {
      label: 'Отклонение',
      value: (
        <Typography.Text type={dev.exceeded ? 'danger' : undefined} strong={dev.exceeded}>
          {deviationText}
        </Typography.Text>
      ),
    },
    {
      label: 'Охват',
      value: hinted(
        `${total.verifiedShifts} из ${total.shiftsWithFuel}`,
        'Сколько смен прошло сверку из тех, по которым посчитан расход',
      ),
    },
  ];

  return (
    <Space orientation="vertical" size={6} style={{ display: 'flex' }}>
      {/* Полосы переносятся, а не сжимаются: на телефоне они встают одна под другой, и качество
          данных остаётся на том же экране, что и итог. Счётчики внутри полосы не переносятся
          никогда («Пробег, км: 1 240» не должен ломаться посреди числа), поэтому узкому экрану
          оставлена прокрутка вбок — она честнее сжатого до нечитаемости ряда. */}
      <div style={{ overflowX: 'auto' }}>
        <Space size={12} wrap>
          <SummaryBar title="Итог за период" items={period} />
          <SummaryBar title="Качество данных" items={quality} />
          {hasNorm && <SummaryBar title="Сверка с нормой" items={check} />}
        </Space>
      </div>
      <Typography.Text type="secondary" style={secondary}>
        Считаются все неаннулированные показания, включая непринятые: приём дня сам по себе чисел не
        меняет.
      </Typography.Text>
    </Space>
  );
}
