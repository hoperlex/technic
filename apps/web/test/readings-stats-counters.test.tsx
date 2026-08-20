import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type {
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  VehicleReadingStatsRow,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Колонки последних показаний в сводке за период (план «Правки гаража», Р17).
 *
 * Проверяется различение двух величин, которые в разговоре зовут одинаково. Снимок счётчика —
 * что показывал прибор в последний день периода, когда его снимали; сумма — сколько за период
 * наработано. Стоят они парами («Одометр» рядом с «Пробегом», «Моточасы» рядом с «Наработкой»),
 * и порядок колонок здесь — предмет проверки, а не оформление: перепутанные местами снимок и
 * сумма читаются как одно число, потому что подписи у них похожи.
 *
 * Второе утверждение — про прочерк. Пусто в колонке снимка значит «числового показания в периоде
 * не сдавали», а не «ноль на приборе»: у машины, которую весь месяц не открывали, одометр не
 * обнулился, о нём просто нечего сказать. Дата снятия рядом с числом обязательна по той же
 * причине, что и в колонке гаража: снимок без даты читается как сегодняшний.
 */

const STATS = 'GET /vehicle-readings/stats';

const DAY = '2026-07-24';
const ROUTE = `/garage?tab=readings&sub=stats&date=${DAY}&from=2026-07-01&to=2026-07-24`;

const RIDDEN = 'КамАЗ 65115 · А123ВС799';
const IDLE = 'Экскаватор · 0002 ММ 77';

const ROWS: VehicleReadingStatsRow[] = [
  {
    vehicleId: 'v-1',
    vehicleLabel: RIDDEN,
    distanceKm: 1240,
    engineHours: 38.5,
    lastOdometer: { value: 128_400, measuredOn: '2026-07-20' },
    lastEngineHours: { value: 5120.5, measuredOn: '2026-07-20' },
    fuelFilledLiters: 620,
    gaps: 1,
  },
  {
    /*
     * Машина, которую в периоде ждали со сменами, но чисел по ней не сдали: в сводке она стоит
     * (Р26в), а сказать о её счётчиках нечего — ни снимка, ни разности.
     */
    vehicleId: 'v-2',
    vehicleLabel: IDLE,
    distanceKm: null,
    engineHours: null,
    lastOdometer: null,
    lastEngineHours: null,
    fuelFilledLiters: 0,
    gaps: 0,
  },
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

function renderGarage(): HttpMock {
  const http = mockHttp({
    [STATS]: ({ query }) =>
      json({ items: ROWS, from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    // Соседняя вкладка: она монтируется при переключении, и без её ручек запрос ушёл бы в пустоту.
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
  });
  renderWithUser(<GaragePage />, { route: ROUTE });
  return http;
}

/** Неразрывные пробелы внутри чисел на экране — в обычные: проверяется число, а не его вёрстка. */
const plain = (text: string): string => text.replace(/\u00a0/gu, ' ');

/** Ячейки строки машины по порядку колонок: им и проверяется, что где стоит. */
function cellsOf(label: string): string[] {
  const row = screen.getByText(label).closest('tr');
  expect(row, `строка «${label}»`).not.toBeNull();
  return within(row as HTMLElement)
    .getAllByRole('cell')
    .map((cell) => plain(cell.textContent ?? ''));
}

describe('сводка показаний: снимки счётчиков за период', () => {
  it('снимок стоит рядом со своей суммой и подписан датой снятия', async () => {
    renderGarage();
    await screen.findByText(RIDDEN);

    // Порядок колонок — часть утверждения: снимок и сумма одного счётчика читаются вместе, а
    // разнесённые по разным концам строки они превращаются в четыре похожих числа.
    const headers = [...document.querySelectorAll('.ant-table-thead th')].map((th) =>
      plain(th.textContent ?? ''),
    );
    expect(headers).toEqual([
      'Техника',
      'Одометр',
      'Пробег, км',
      'Моточасы',
      'Наработка, м/ч',
      'Заправлено топлива, л',
      'Разрывов ряда',
    ]);

    expect(cellsOf(RIDDEN)).toEqual([
      RIDDEN,
      '128 400 кмснято 20.07.2026',
      '1240',
      '5120,5 м/чснято 20.07.2026',
      '38,5',
      '620,0',
      '1',
    ]);
  });

  it('без показаний в периоде в колонках снимков стоит прочерк, а не ноль', async () => {
    renderGarage();
    await screen.findByText(IDLE);

    /*
     * Прочерки стоят ровно там, где сказать нечего: снимков нет, пар для разности нет. Ноль в
     * колонке одометра означал бы обнулённый счётчик — утверждение, которого никто не делал; ноль
     * в литрах, наоборот, законен: заправок в периоде действительно не было.
     */
    expect(cellsOf(IDLE)).toEqual([IDLE, '—', '—', '—', '—', '0,0', '—']);
  });
});
