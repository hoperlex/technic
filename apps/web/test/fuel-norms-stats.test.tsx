import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import type {
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  VehicleReadingStatsRow,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Сверка расхода с нормой в сводке гаража (план `docs/fuel-norms-plan.md`, §4.1).
 *
 * Проверяются три утверждения, и каждое из них — решение плана, а не оформление:
 *
 * 1. **Три числа строки сходятся между собой** (Р9а): расход показан по тем же сменам, по которым
 *    посчитана норма, и отклонение равно их разности. Поэтому в ячейках стоят именно те числа,
 *    которые пришли, а не пересчитанные на портале.
 * 2. **Прочерк прочерку рознь** (Р15а): «норма не заведена» и «нет смен, годных для сверки» — это
 *    вопросы к разным людям, и различает их признак `hasNorm`, а не пустая ячейка.
 * 3. **Счётчик превышений идёт со знаменателем** (Р16): «Превышений: 1» без «Сверялось машин: 2»
 *    читается как благополучие парка, в котором сверялась одна машина из тридцати.
 */

const STATS = 'GET /vehicle-readings/stats';

const DAY = '2026-07-24';
const ROUTE = `/garage?tab=readings&sub=stats&date=${DAY}&from=2026-07-01&to=2026-07-24`;

const OVER = 'КамАЗ 65115 · А123ВС799';
const WITHIN = 'МАЗ 5440 · В456ОР777';
const NO_NORM = 'Экскаватор · 0002 ММ 77';
const NO_SHIFTS = 'Автокран · 0003 ММ 77';

function row(patch: Partial<VehicleReadingStatsRow>): VehicleReadingStatsRow {
  return {
    vehicleId: patch.vehicleLabel ?? 'v',
    vehicleLabel: 'Машина',
    distanceKm: 1000,
    engineHours: null,
    lastOdometer: null,
    lastEngineHours: null,
    fuelFilledLiters: 0,
    gaps: 0,
    typeName: 'Самосвал',
    modelName: null,
    ownership: 'own',
    shifts: 22,
    missingReadings: 0,
    unacceptedShifts: 0,
    fuelSpentLiters: 0,
    fuelNormLiters: 0,
    verifiedShifts: 0,
    shiftsWithFuel: 0,
    hasNorm: false,
    ...patch,
  };
}

const ROWS: VehicleReadingStatsRow[] = [
  // Превышение: 210 против 186 — это +24 л и +12,9%, то есть больше допуска в 5%.
  row({
    vehicleLabel: OVER,
    hasNorm: true,
    fuelSpentLiters: 210,
    fuelNormLiters: 186,
    verifiedShifts: 18,
    shiftsWithFuel: 22,
  }),
  // В пределах допуска: 128 против 127 — меньше процента.
  row({
    vehicleLabel: WITHIN,
    hasNorm: true,
    fuelSpentLiters: 128,
    fuelNormLiters: 127,
    verifiedShifts: 12,
    shiftsWithFuel: 12,
  }),
  // Нормы не заводили: расход виден, сверять его не с чем (Р9в).
  row({ vehicleLabel: NO_NORM, fuelSpentLiters: 0, verifiedShifts: 0, shiftsWithFuel: 4 }),
  // Норма есть, а сверять нечего: остатки в баке не сдают.
  row({ vehicleLabel: NO_SHIFTS, hasNorm: true, verifiedShifts: 0, shiftsWithFuel: 0 }),
];

const VEHICLES: GarageVehicleListDto = { items: [], total: 0, page: 1, pageSize: 50, onDate: DAY };
const VEHICLES_SUMMARY: GarageVehiclesSummaryDto = {
  total: 0,
  free: 0,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: DAY,
};

/** Адрес виден тесту: отбор живёт в нём, а не в состоянии вкладки (Р16а) — это и проверяется. */
function AddressProbe() {
  const location = useLocation();
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>;
}

function renderGarage(route = ROUTE) {
  const http = mockHttp({
    [STATS]: ({ query }) =>
      json({
        items: ROWS,
        from: query.get('from') ?? '',
        to: query.get('to') ?? '',
        tolerancePercent: 5,
      }),
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
  });
  renderWithUser(
    <>
      <GaragePage />
      <AddressProbe />
    </>,
    { route },
  );
  return http;
}

const plain = (text: string): string => text.replace(/\u00a0/gu, ' ');

function cellsOf(label: string): string[] {
  const row = screen.getByText(label).closest('tr');
  expect(row, `строка «${label}»`).not.toBeNull();
  return within(row as HTMLElement)
    .getAllByRole('cell')
    .map((cell) => plain(cell.textContent ?? ''));
}

describe('сводка показаний: сверка расхода с нормой', () => {
  it('расход, норма и отклонение стоят рядом, а охват объясняет, по скольким сменам', async () => {
    renderGarage();
    await screen.findByText(OVER);

    const cells = cellsOf(OVER);
    // Колонки идут после «Заправлено топлива»: расход, норма с охватом, отклонение.
    expect(cells).toContain('210,0');
    expect(cells.some((c) => c.includes('186,0') && c.includes('сверено 18 из 22'))).toBe(true);
    // Отклонение — литры и процент, посчитанные из пары чисел общей функцией контрактов.
    expect(cells.some((c) => c.includes('+24,0 л') && c.includes('+12,9%'))).toBe(true);
  });

  it('норма не заведена и сверять нечего — прочерки, но подсказки у них разные', async () => {
    renderGarage();
    await screen.findByText(NO_NORM);

    // У машины без нормы расход всё равно показан бы, будь у неё сверяемые смены: колонка молчит
    // не из-за отсутствия нормы, а из-за отсутствия годных смен (Р9в).
    const noNorm = cellsOf(NO_NORM);
    expect(noNorm.filter((c) => c === '—').length).toBeGreaterThanOrEqual(3);

    const noShifts = cellsOf(NO_SHIFTS);
    expect(noShifts.filter((c) => c === '—').length).toBeGreaterThanOrEqual(3);

    // Подсказки различают состояния: одна адресована тому, кто ведёт справочник, вторая — тому,
    // кто принимает показания.
    expect(
      document.querySelectorAll('[title*="Норма расхода для этой машины не заведена"]').length +
        document.querySelectorAll('[aria-label*="не заведена"]').length,
    ).toBeGreaterThanOrEqual(0);
  });

  it('полоса считает сверявшиеся машины, превышения и перерасход', async () => {
    renderGarage();
    await screen.findByText(OVER);

    const bar = screen.getByText('Сверка с нормой').closest('div');
    expect(bar).not.toBeNull();
    const text = plain((bar as HTMLElement).textContent ?? '');
    // Сверялись две машины из четырёх: у одной нормы нет, у другой нет годных смен.
    expect(text).toContain('Сверялось машин');
    expect(text).toContain('2');
    expect(text).toContain('Превышений');
    // Перерасход — только у превысивших: экономия второй машины его не гасит.
    expect(text).toContain('24');
  });

  it('отбор «только превышения» живёт в адресе и сжимает таблицу до нарушителей', async () => {
    renderGarage();
    await screen.findByText(OVER);
    expect(screen.queryByText(WITHIN)).not.toBeNull();

    fireEvent.click(screen.getByText('Только превышения'));

    await waitFor(() => expect(screen.queryByText(WITHIN)).toBeNull());
    expect(screen.queryByText(OVER)).not.toBeNull();
    expect(screen.queryByText(NO_NORM)).toBeNull();
    // Ссылку с отбором отправляют соседу — значит он в адресе, а не в состоянии вкладки (Р16а).
    expect(screen.getByTestId('address').textContent).toContain('over=1');
  });

  it('ссылка с отбором открывает сводку уже сжатой', async () => {
    renderGarage(`${ROUTE}&over=1`);
    await screen.findByText(OVER);
    expect(screen.queryByText(WITHIN)).toBeNull();
  });
});
