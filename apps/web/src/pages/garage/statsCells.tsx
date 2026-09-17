import dayjs from 'dayjs';
import { Space, Tooltip, Typography } from 'antd';
import { fuelDeviation, type VehicleReadingStatsRow } from '@technic/contracts';
import { decimal } from './readingNumbers';

/** Дата снимка печатается человеку, а не машине: тем же форматом, что и поле периода вкладки. */
const SHOWN_DATE = 'DD.MM.YYYY';

/**
 * Ячейки сводки показаний: снимок счётчика, норма по приказу и отклонение от неё.
 *
 * Стоят своим файлом по тому же порядку, что и остальные колонки гаража (`odometerColumn`,
 * `licenseCell`, `maintenanceColumn`): вкладка отвечает за отбор и раскладку, ячейка — за то, как
 * читается одно число. Здесь это особенно нужно: у каждой из трёх ячеек есть прочерк, и значит он
 * везде одно и то же — «портал не знает», а не «ноль».
 */

/**
 * Снимок счётчика за период: число и день, за который его сняли (Р17). Считает его сервер, портал
 * только печатает пришедшее — своего выбора «последнего» у него нет и быть не должно.
 *
 * Прочерк — не ноль на приборе: числового показания в периоде не сдавали вовсе. Дата второй
 * строкой обязательна по той же причине, что и в колонке гаража: снимок без даты читается как
 * сегодняшний и врёт тем сильнее, чем дольше машина стояла.
 */
export function snapshotCell(
  last: { value: number; measuredOn: string } | null,
  text: (value: number) => string,
) {
  if (!last) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space orientation="vertical" size={0}>
      <span>{text(last.value)}</span>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        снято {dayjs(last.measuredOn).format(SHOWN_DATE)}
      </Typography.Text>
    </Space>
  );
}

/**
 * Ячейка нормы: число, а под ним охват или причина его отсутствия (план `docs/fuel-norms-plan.md`,
 * Р15а). Три состояния, и они отвечают разным людям:
 *
 * - нормы не заводили — вопрос к тому, кто ведёт справочник;
 * - норма есть, а сверять нечего (остатков в баке не сдают) — вопрос к тому, кто принимает
 *   показания;
 * - норма есть и сверка состоялась — тогда рядом стоит охват: по скольким сменам из скольких.
 *
 * Ноль здесь печатается прочерком осознанно: складываться числам нужно, а «0 л» в клетке читается
 * как «норма нулевая», чего не бывает.
 */
export function normCell(row: VehicleReadingStatsRow) {
  if (!row.hasNorm) {
    return (
      <Tooltip title="Норма расхода для этой машины не заведена — справочник норм открывается из «Техники»">
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  }
  if (row.verifiedShifts === 0) {
    return (
      <Tooltip title="Нет смен, годных для сверки: не сдавали остатки топлива либо ряд снимков рвался">
        <Typography.Text type="secondary">—</Typography.Text>
      </Tooltip>
    );
  }
  return (
    <Space orientation="vertical" size={0} style={{ alignItems: 'flex-end' }}>
      <span>{decimal(row.fuelNormLiters)}</span>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        сверено {row.verifiedShifts} из {row.shiftsWithFuel}
      </Typography.Text>
    </Space>
  );
}

/**
 * Отклонение: литры и процент одной ячейкой (Р12а). Считается общей функцией контрактов — той же,
 * какой считают полоса, отбор и книги: два одинаковых с виду расчёта расходятся на первом же
 * округлении.
 */
export function deviationCell(row: VehicleReadingStatsRow, tolerancePercent: number) {
  const dev = fuelDeviation(row.fuelSpentLiters, row.fuelNormLiters, tolerancePercent);
  if (dev.liters === null || dev.percent === null) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  const sign = dev.liters > 0 ? '+' : '';
  return (
    <Space orientation="vertical" size={0} style={{ alignItems: 'flex-end' }}>
      <Typography.Text type={dev.exceeded ? 'danger' : undefined} strong={dev.exceeded}>
        {sign}
        {decimal(dev.liters)} л
      </Typography.Text>
      <Typography.Text type={dev.exceeded ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
        {sign}
        {decimal(dev.percent)}%
      </Typography.Text>
    </Space>
  );
}

/** Итог по парку: суммы известного. Прочерки в сумму не идут — они не нули. */
export function totalOf(
  rows: readonly VehicleReadingStatsRow[],
  pick: (row: VehicleReadingStatsRow) => number | null,
) {
  return rows.reduce((sum, row) => sum + (pick(row) ?? 0), 0);
}
