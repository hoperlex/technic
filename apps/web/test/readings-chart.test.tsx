import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  ReadingMonthRow,
  ReadingTotals,
  VehicleReadingCardDto,
  VehicleReadingJournalDto,
} from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { maintenanceSummary } from './factories/maintenance';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Диаграмма помесячной динамики в карточке машины (план «Показания техники», Р17, Р28, §7).
 *
 * Проверяется не факт монтирования, а числа. Ряд обязан отвечать выбранному счётчику: переключение
 * «Пробег → Наработка» — это другой вопрос к тем же месяцам, и столбики должны стать другими, а не
 * перекраситься. И главное — поведение при разрыве: месяц, в котором ряд рвался, помечается, а не
 * рисуется нулём. Нулевой столбик утверждал бы «машина стояла», чего никто не измерял.
 *
 * Разрывов на диаграмме два вида, и показаны они по-разному:
 *   — чисел нет вовсе (`distanceKm === null`) — столбика нет, под месяцем стоит прочерк;
 *   — числа есть, но ряд рвался (`odometerGaps > 0`) — столбик заштрихован, над ним «≥».
 */

const STATS = 'GET /vehicle-readings/stats';
const CARD = 'GET /vehicle-readings/vehicles/:vehicleId/card';
const JOURNAL = 'GET /vehicle-readings/journal/:vehicleId';
const MAINTENANCE = 'GET /vehicle-maintenance/vehicles/:vehicleId/summary';
const MAINTENANCE_HISTORY = 'GET /vehicle-maintenance/vehicles/:vehicleId/history';

const DAY = '2026-07-24';
const LABEL = 'КамАЗ 65115 · А123ВС799';

/**
 * Размер контейнера диаграммы в jsdom.
 *
 * `ResponsiveContainer` меряет свой узел `getBoundingClientRect`, а в jsdom раскладки нет — все
 * размеры нулевые, и recharts честно не рисует ничего (нулевая ширина графика бессмысленна). Без
 * подмены тест проверял бы пустой `<div>`. Подменяется ровно контейнер диаграммы: обычные узлы
 * продолжают отвечать своими нулями, иначе замеры antd начали бы видеть чужую ширину.
 */
const CHART_BOX = {
  width: 800,
  height: 300,
  top: 0,
  left: 0,
  right: 800,
  bottom: 300,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

const NATIVE_RECT = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function measured(this: Element): DOMRect {
    return this.classList.contains('recharts-responsive-container')
      ? CHART_BOX
      : NATIVE_RECT.call(this);
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = NATIVE_RECT;
});

function totals(over: Partial<ReadingTotals> = {}): ReadingTotals {
  return {
    distanceKm: 1800,
    engineHours: 68.5,
    fuelFilledLiters: 900,
    odometerGaps: 2,
    engineHoursGaps: 0,
    missingReadings: 4,
    shifts: 30,
    unacceptedShifts: 6,
    ...over,
  };
}

function month(name: string, over: Partial<ReadingTotals>): ReadingMonthRow {
  return { month: name, ...totals(over) };
}

/**
 * Три месяца — по одному на каждый случай: обычный, заниженный (ряд рвался) и без чисел вовсе.
 * Наработка при этом известна во всех трёх: переключение счётчика обязано вернуть третьему месяцу
 * столбик, а это и есть доказательство, что ряд пересчитывается, а не перекрашивается.
 */
const MONTHS: ReadingMonthRow[] = [
  month('2026-05', { distanceKm: 800, odometerGaps: 0, engineHours: 20 }),
  month('2026-06', { distanceKm: 1000, odometerGaps: 2, engineHours: 30 }),
  month('2026-07', { distanceKm: null, odometerGaps: 1, engineHours: 18.5 }),
];

function cardDto(over: Partial<VehicleReadingCardDto> = {}): VehicleReadingCardDto {
  return {
    vehicleId: 'v-1',
    vehicleLabel: LABEL,
    from: '2026-05-01',
    to: '2026-07-24',
    total: totals(),
    months: MONTHS,
    lastOdometer: { km: 128400, measuredOn: '2026-07-22' },
    lastEngineHours: { value: 1240.5, measuredOn: '2026-07-22' },
    ...over,
  };
}

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
const JOURNAL_PAGE: VehicleReadingJournalDto = {
  vehicleId: 'v-1',
  vehicleLabel: LABEL,
  from: '2026-06-24',
  to: '2026-07-24',
  total: 0,
  page: 1,
  pageSize: 100,
  items: [],
};

function renderCard(over: RouteMap = {}): void {
  mockHttp({
    [STATS]: ({ query }) =>
      json({ items: [], from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    [CARD]: () => json(cardDto()),
    [JOURNAL]: () => json(JOURNAL_PAGE),
    // Блок ТО стоит в той же карточке и спрашивает своё под своим правом (Р14а): диспетчеру оно
    // выдано, и без мока его запрос ушёл бы в пустоту. Диаграммы обслуживание не касается.
    [MAINTENANCE]: () => json(maintenanceSummary()),
    [MAINTENANCE_HISTORY]: () => json({ items: [] }),
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<GaragePage />, {
    route: `/garage?tab=readings&sub=stats&date=${DAY}&from=2026-05-01&to=2026-07-24&vehicle=v-1`,
  });
}

/** Окно карточки: у него единственный на портале итог периода со своей подписью. */
const card = () => screen.getByText('Итог за период').closest('.ant-modal') as HTMLElement;

/**
 * Полотно диаграммы. Запросы идут только внутрь него: те же числа стоят и в помесячной таблице
 * рядом, и без ограничения тест ловил бы её ячейки вместо столбиков.
 */
const surface = () => card().querySelector('.recharts-surface') as SVGElement;

/** Подписи над столбиками — то, что диаграмма сейчас показывает числами. */
function barLabels(): string[] {
  return [...surface().querySelectorAll('.recharts-label-list text')]
    .map((node) => node.textContent ?? '')
    .filter((text) => text !== '');
}

/** Столбики — по одному на месяц, в котором есть что рисовать. */
const bars = () => [...surface().querySelectorAll('.recharts-rectangle')];

/** Все подписи под осью месяцев, включая вторую строку с прочерком. */
function axisTexts(): string[] {
  return [...surface().querySelectorAll('.recharts-xAxis-tick-labels text')].map(
    (node) => node.textContent ?? '',
  );
}

/**
 * Текст узла с обычными пробелами. «не меньше 1240» портал печатает неразрывными — иначе оговорка
 * отрывается от числа при переносе, — а сравнивать в тесте удобнее видимым текстом.
 */
const plain = (node: HTMLElement | null) => (node?.textContent ?? '').replace(/\u00a0/gu, ' ');

/** Переключатель счётчика: те же подписи стоят и в шапке таблицы, поэтому берётся именно он. */
function switchTo(label: string): void {
  const segmented = card().querySelector('.ant-segmented') as HTMLElement;
  fireEvent.click(within(segmented).getByText(label));
}

async function openChart(): Promise<void> {
  await waitFor(() => expect(screen.queryByText('Итог за период')).not.toBeNull());
  // Диаграмма приезжает своим чанком (Р17): до его загрузки на её месте стоит заполнитель, и
  // ждать надо именно полотно.
  await waitFor(() => expect(surface()).not.toBeNull());
}

describe('диаграмма помесячной динамики в карточке машины', () => {
  it('рисует столбики по месяцам периода и подписывает их числами счётчика', async () => {
    renderCard();
    await openChart();

    // Подписи месяцев — короткие, но с годом: период умеет пересекать новый год.
    expect(axisTexts()).toContain('май 26');
    expect(axisTexts()).toContain('июнь 26');
    expect(axisTexts()).toContain('июль 26');

    // Столбиков два, а не три: у июля пробега нет вовсе, и рисовать там нечего.
    expect(bars()).toHaveLength(2);
    expect(barLabels()).toEqual(['800', '≥ 1000']);
  });

  it('переключение счётчика меняет ряд, а не только подписи', async () => {
    renderCard();
    await openChart();
    expect(barLabels()).toEqual(['800', '≥ 1000']);

    switchTo('Наработка, м/ч');

    // Наработка известна за все три месяца — включая тот, у которого нет пробега. Столбик там
    // появляется, и это доказывает, что ряд пересчитан по выбранному счётчику.
    await waitFor(() => expect(barLabels()).toEqual(['20,0', '30,0', '18,5']));
    expect(bars()).toHaveLength(3);
    // Разрывов моточасов в месяцах нет — значит нет и оговорки «≥»: она принадлежит своей цепочке
    // (Р28), а не строке месяца вообще.
    expect(barLabels().some((text) => text.startsWith('≥'))).toBe(false);
  });

  it('месяц без пары снимков помечается прочерком, а не нулевым столбиком', async () => {
    renderCard();
    await openChart();

    // Ноль здесь означал бы «машина стояла» — утверждение, которого никто не делал. Под месяцем
    // стоит тот же прочерк, что в помесячной таблице, и стоит он на месте столбика.
    const july = axisTexts().indexOf('июль 26');
    expect(july).toBeGreaterThanOrEqual(0);
    expect(axisTexts()[july + 1]).toBe('—');
    // У месяцев с числами второй строки нет: прочерк — пометка, а не оформление оси.
    expect(axisTexts().filter((text) => text === '—')).toHaveLength(1);
    expect(
      within(card()).getByText(/Прочерк под месяцем — пар снимков в нём не осталось/u),
    ).toBeDefined();
  });

  it('месяц с оборванным рядом заштрихован и подписан «не меньше»', async () => {
    renderCard();
    await openChart();

    // Штриховка объявлена своим `<pattern>`, и заштрихован ровно один столбик — тот, у которого
    // odometerGaps > 0. Сплошная заливка означала бы, что числу можно верить целиком.
    expect(surface().querySelector('defs pattern')).not.toBeNull();
    const hatched = bars().filter((bar) => (bar.getAttribute('fill') ?? '').startsWith('url(#'));
    expect(hatched).toHaveLength(1);
    expect(barLabels()).toContain('≥ 1000');
    expect(within(card()).getByText(/Штриховка и «≥» — ряд в этом месяце рвался/u)).toBeDefined();
  });

  it('месяцев нет — нет и диаграммы: пустые оси обещали бы данные', async () => {
    renderCard({ [CARD]: () => json(cardDto({ months: [] })) });
    await waitFor(() => expect(screen.queryByText('Итог за период')).not.toBeNull());

    expect(card().querySelector('.recharts-surface')).toBeNull();
    expect(within(card()).queryByText('Помесячно')).toBeNull();
  });
});

describe('заниженные числа в карточке машины', () => {
  it('итог периода называет пробег нижней границей, когда ряд рвался', async () => {
    renderCard();
    await openChart();

    // Пары снимков были, но две из них разорваны: показанные километры — не весь пробег, а его
    // нижняя граница. Без оговорки это число читают как точное и сверяют с путевыми листами.
    const distance = within(card()).getByText('Пробег, км:').parentElement;
    expect(plain(distance)).toContain('не меньше 1800');

    // У наработки разрывов своей цепочки нет — и оговорки нет: три числа независимы (Р28).
    const hours = within(card()).getByText('Наработка, м/ч:').parentElement;
    expect(plain(hours)).toContain('68,5');
    expect(plain(hours)).not.toContain('не меньше');

    // Заправленное — сумма заправок за смены, а не разность снимков: разрыв её не занижает.
    const fuel = within(card()).getByText('Заправлено, л:').parentElement;
    expect(plain(fuel)).not.toContain('не меньше');
  });

  it('то же правило и в помесячной таблице — оговорка стоит там же, где число', async () => {
    renderCard();
    await openChart();

    const rows = [...card().querySelectorAll('.ant-table-tbody tr')];
    const june = rows.find((row) => row.textContent?.includes('июнь 2026')) as HTMLElement;
    const may = rows.find((row) => row.textContent?.includes('май 2026')) as HTMLElement;

    // Июнь: разрывы одометра есть — пробег занижен. Май: разрывов нет — число точное, и лишней
    // оговорки на нём быть не должно, иначе она перестанет что-либо значить.
    expect(within(june).getByText('не меньше 1000')).toBeDefined();
    expect(plain(may)).toContain('800');
    expect(plain(may)).not.toContain('не меньше');
  });
});
