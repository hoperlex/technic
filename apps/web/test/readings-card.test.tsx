import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router';
import type {
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  ReadingMonthRow,
  ReadingTotals,
  VehicleReadingCardDto,
  VehicleReadingJournalDto,
  VehicleReadingStatsRow,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { maintenanceRecord, maintenanceSummary } from './factories/maintenance';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Карточка машины в сводке показаний (ADR 0103; план «Показания техники», §7, Р2, Р4, Р16, Р27).
 *
 * Проверяется то, ради чего карточку заводили. Строка сводки отвечает «4 200 км за июль», а
 * следующий вопрос всегда один — из чего они сложились; на него отвечает карточка, и открывается
 * она из строки и по ссылке одинаково: предмет живёт в адресе (Р29), поэтому «назад» её закрывает,
 * а не уносит со страницы.
 *
 * Дальше — правила чисел, ради которых экран и расписан: прочерк вместо нуля (период без пары
 * снимков о пробеге не говорит), помесячная разбивка с итогом, который обязан совпасть с шапкой
 * (Р4), и качество данных цифрами рядом с итогом, а не мелким шрифтом внизу (Р27). Плюс отдельное
 * утверждение о том, чем карточка собрана: блок ТО приходит своей ручкой под своим правом (Р14а),
 * а не полем ответа статистики — само же обслуживание проверяется в maintenance-card.test.tsx.
 */

const STATS = 'GET /vehicle-readings/stats';
const CARD = 'GET /vehicle-readings/vehicles/:vehicleId/card';
const JOURNAL = 'GET /vehicle-readings/journal/:vehicleId';
const MAINTENANCE = 'GET /vehicle-maintenance/vehicles/:vehicleId/summary';
const MAINTENANCE_HISTORY = 'GET /vehicle-maintenance/vehicles/:vehicleId/history';

/** День среза страницы: от него отсчитывается умолчание периода сводки. */
const DAY = '2026-07-24';
const LABEL = 'КамАЗ 65115 · А123ВС799';

const ROWS: VehicleReadingStatsRow[] = [
  {
    vehicleId: 'v-1',
    vehicleLabel: LABEL,
    distanceKm: 1240,
    engineHours: 38.5,
    lastOdometer: { value: 128_400, measuredOn: '2026-07-20' },
    lastEngineHours: { value: 5120.5, measuredOn: '2026-07-20' },
    fuelFilledLiters: 620,
    gaps: 1,
  },
  {
    vehicleId: 'v-2',
    vehicleLabel: 'Экскаватор · 0002 ММ 77',
    distanceKm: null,
    engineHours: 12,
    lastOdometer: null,
    lastEngineHours: null,
    fuelFilledLiters: 90,
    gaps: 2,
  },
];

function totals(over: Partial<ReadingTotals> = {}): ReadingTotals {
  return {
    distanceKm: 1240,
    engineHours: 38.5,
    fuelFilledLiters: 620,
    odometerGaps: 1,
    engineHoursGaps: 0,
    missingReadings: 4,
    shifts: 30,
    unacceptedShifts: 6,
    ...over,
  };
}

function month(name: string, over: Partial<ReadingTotals> = {}): ReadingMonthRow {
  return { month: name, ...totals(over) };
}

/** Ответ карточки: границы — те, что спросили, чтобы по нему было видно ушедший период. */
function cardDto(over: Partial<VehicleReadingCardDto> = {}): VehicleReadingCardDto {
  return {
    vehicleId: 'v-1',
    vehicleLabel: LABEL,
    from: '2026-06-01',
    to: '2026-07-24',
    total: totals(),
    months: [
      month('2026-06', { distanceKm: 1000, engineHours: 20, fuelFilledLiters: 500, shifts: 18 }),
      month('2026-07', { distanceKm: 240, engineHours: 18.5, fuelFilledLiters: 120, shifts: 12 }),
    ],
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

/** Адрес и «назад» браузера видны тесту: карточка — переход, а не состояние экрана (Р29). */
function AddressProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="address">{`${location.pathname}${location.search}`}</div>
      <button onClick={() => navigate(-1)}>Назад браузера</button>
    </>
  );
}

function renderGarage(route: string, over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    [STATS]: ({ query }) =>
      json({ items: ROWS, from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    [CARD]: ({ query }) =>
      json(cardDto({ from: query.get('from') ?? '', to: query.get('to') ?? '' })),
    [JOURNAL]: () => json(JOURNAL_PAGE),
    // Обслуживание — своя ручка под своим правом (Р14а): у диспетчера оно есть, поэтому карточка
    // спрашивает её вместе со статистикой. Проверки самого блока — в maintenance-card.test.tsx.
    [MAINTENANCE]: () => json(maintenanceSummary()),
    [MAINTENANCE_HISTORY]: () => json({ items: [maintenanceRecord()] }),
    // Блок «Автозапчасти» стоит в той же карточке и спрашивает своё под `garage.read` (план чеков
    // на автозапчасти, Р16): без ответа его запрос ушёл бы в пустоту. Проверяют блок свои тесты.
    'GET /auto-part-receipts/vehicles/:vehicleId': ({ params }) =>
      json({
        vehicleId: params.vehicleId,
        vehicleLabel: '',
        total: 0,
        totalAllTime: 0,
        rows: [],
      }),
    // Соседняя вкладка: она монтируется при переключении, и без её ручек запрос ушёл бы в пустоту.
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
    ...over,
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

const address = () => screen.getByTestId('address').textContent ?? '';

/** Открыта ли карточка: у неё единственный на портале итог периода со своей подписью. */
const cardOpen = () => screen.queryByText('Итог за период') !== null;

/** Окно карточки целиком — запросы внутрь идут через него, чтобы не поймать строку списка. */
const card = () => screen.getByText('Итог за период').closest('.ant-modal') as HTMLElement;

/**
 * Число из полосы счётчиков: подпись и значение стоят в одном блоке, и по подписи берётся ровно
 * та цифра, которая рядом с ней.
 */
function stat(label: string): string {
  const caption = within(card()).getByText(`${label}:`);
  return caption.parentElement?.textContent?.replace(`${label}: `, '') ?? '';
}

/** Клик по строке сводки — тот самый провал в машину (Р2). */
async function openFromRow(): Promise<void> {
  fireEvent.click(await screen.findByText(LABEL));
}

describe('карточка машины в сводке показаний', () => {
  it('открывается кликом по строке и называет машину в адресе', async () => {
    const http = renderGarage(`/garage?tab=readings&date=${DAY}&from=2026-06-01&to=2026-07-24`);
    await openFromRow();

    await waitFor(() => expect(http.countOf(CARD)).toBe(1));
    // Спрашивается своя машина за период сводки: карточка отвечает про тот же отрезок, из строки
    // которого её открыли.
    expect(http.lastCall(CARD)!.path).toBe('/vehicle-readings/vehicles/v-1/card');
    expect(http.lastCall(CARD)!.query.get('from')).toBe('2026-06-01');
    expect(http.lastCall(CARD)!.query.get('to')).toBe('2026-07-24');

    await waitFor(() => expect(cardOpen()).toBe(true));
    // Ради этого предмет и живёт в адресе: ссылку «эта машина за тот же период» отправляют соседу.
    expect(address()).toContain('vehicle=v-1');
    expect(address()).toContain('from=2026-06-01');
  });

  it('открывается прямо из адреса, без клика по списку', async () => {
    const http = renderGarage(
      `/garage?tab=readings&sub=stats&date=${DAY}&from=2026-06-01&to=2026-07-24&vehicle=v-1`,
    );

    await waitFor(() => expect(http.countOf(CARD)).toBe(1));
    expect(await screen.findByText('Итог за период')).toBeDefined();
  });

  it('«назад» закрывает карточку и возвращает к списку', async () => {
    renderGarage(`/garage?tab=readings&date=${DAY}&from=2026-06-01&to=2026-07-24`);
    await openFromRow();
    await waitFor(() => expect(cardOpen()).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Назад браузера' }));

    // Открытие пишется в историю, поэтому «назад» снимает именно карточку: страница остаётся той
    // же, период — тоже, уходит только предмет.
    await waitFor(() => expect(cardOpen()).toBe(false));
    expect(address()).not.toContain('vehicle=');
    expect(address()).toContain('tab=readings');
    expect(address()).toContain('from=2026-06-01');
    expect(screen.getByText(LABEL)).toBeDefined();
  });

  it('вместо неизвестного числа показывает прочерк, а не ноль', async () => {
    // Период, в котором не осталось ни одной пары снимков, о пробеге не говорит: ноль здесь был бы
    // утверждением «машина стояла», а его никто не делал.
    renderGarage(`/garage?tab=readings&date=${DAY}&vehicle=v-1`, {
      [CARD]: () =>
        json(
          cardDto({
            total: totals({ distanceKm: null, engineHours: null }),
            months: [month('2026-07', { distanceKm: null, engineHours: null })],
            lastOdometer: null,
          }),
        ),
    });

    await waitFor(() => expect(cardOpen()).toBe(true));
    expect(stat('Пробег, км')).toBe('—');
    expect(stat('Наработка, м/ч')).toBe('—');
    expect(stat('Пробег, км')).not.toBe('0');
    // Показаний за машиной не числится — шапка это и говорит, а не рисует нулевой одометр.
    expect(within(card()).getAllByText('— снимков нет').length).toBeGreaterThan(0);
  });

  it('показывает месяцы периода, а итог таблицы совпадает с шапкой итога', async () => {
    renderGarage(`/garage?tab=readings&date=${DAY}&from=2026-06-01&to=2026-07-24&vehicle=v-1`);
    await waitFor(() => expect(cardOpen()).toBe(true));

    expect(within(card()).getByText('июнь 2026')).toBeDefined();
    expect(within(card()).getByText('июль 2026')).toBeDefined();

    // Сумма месяцев равна итогу периода (Р4). Строка «Итого» берёт числа из того же итога, что и
    // шапка, — поэтому разойтись они не могут даже при ошибке в расчёте на сервере.
    const summary = card().querySelector('.ant-table-summary') as HTMLElement;
    expect(within(summary).getByText('Итого')).toBeDefined();
    // Пробег в этом периоде занижен (`odometerGaps: 1`), и оговорка стоит в обоих местах одними и
    // теми же словами: шапка и строка «Итого» — по-прежнему одно число, показанное дважды.
    expect(stat('Пробег, км').replace(/\u00a0/gu, ' ')).toBe('не меньше 1240');
    expect(within(summary).getByText('не меньше 1240')).toBeDefined();
    expect(within(summary).getByText('38,5')).toBeDefined();
  });

  it('качество данных стоит цифрами рядом с итогом', async () => {
    renderGarage(`/garage?tab=readings&date=${DAY}&vehicle=v-1`);
    await waitFor(() => expect(cardOpen()).toBe(true));

    // Статистика оперативная (Р27): непринятое считается наравне с принятым, и сказать, сколько
    // его, обязана сама карточка — предупреждением мелким шрифтом это не заменяется.
    expect(stat('Ожидалось смен')).toBe('30');
    expect(stat('Без показаний')).toBe('4');
    expect(stat('Не принято')).toBe('6');
  });

  it('блок ТО приходит своей ручкой, а не полем карточки', async () => {
    const http = renderGarage(`/garage?tab=readings&date=${DAY}&from=2026-06-01&to=2026-07-24`);
    await openFromRow();
    await waitFor(() => expect(cardOpen()).toBe(true));

    /*
     * Полная карточка диспетчера — композиция двух ответов (Р14а): статистика под
     * `vehicleReadings.read`, обслуживание под `vehicleMaintenance.read`. Оба запроса уходят на
     * одну и ту же машину, и оба видны в журнале — поля, исчезающего по чужому праву, здесь нет.
     */
    await waitFor(() => expect(http.countOf(MAINTENANCE)).toBe(1));
    expect(http.lastCall(MAINTENANCE)!.path).toBe('/vehicle-maintenance/vehicles/v-1/summary');
    // День среза блока — конец периода карточки (Р16): срез марта не показывает майское ТО.
    expect(http.lastCall(MAINTENANCE)!.query.get('on')).toBe('2026-07-24');
    expect(within(card()).getByText('Обслуживание')).toBeDefined();
  });

  it('детализация открывает существующее окно журнала', async () => {
    const http = renderGarage(`/garage?tab=readings&date=${DAY}&vehicle=v-1`);
    await waitFor(() => expect(cardOpen()).toBe(true));

    fireEvent.click(within(card()).getByRole('button', { name: 'Показания по сменам' }));

    // Журнал переиспользуется целиком, со своими страницами и своим периодом (Р25): второго
    // списка строк карточка не заводит.
    await waitFor(() => expect(http.countOf(JOURNAL)).toBe(1));
    expect(http.lastCall(JOURNAL)!.path).toBe('/vehicle-readings/journal/v-1');
    expect(await screen.findByText(`Показания — ${LABEL}`)).toBeDefined();
  });

  it('журнал открывается периодом карточки, а не своим месяцем назад', async () => {
    const http = renderGarage(
      `/garage?tab=readings&date=${DAY}&from=2026-01-15&to=2026-07-24&vehicle=v-1`,
    );
    await waitFor(() => expect(cardOpen()).toBe(true));

    fireEvent.click(within(card()).getByRole('button', { name: 'Показания по сменам' }));

    /*
     * Полгода, а не тридцать дней от конца: журнал открывают, чтобы увидеть, из чего сложились
     * числа карточки. Отсчитывай он свой месяц назад — детализация отвечала бы про другой отрезок,
     * и суммы наверху с ней бы не сошлись.
     */
    await waitFor(() => expect(http.countOf(JOURNAL)).toBe(1));
    const { query } = http.lastCall(JOURNAL)!;
    expect(query.get('from')).toBe('2026-01-15');
    expect(query.get('to')).toBe('2026-07-24');
  });
});
