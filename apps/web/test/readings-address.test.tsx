import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import type {
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  VehicleReadingStatsRow,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { emptyList } from './factories/common';
import { GaragePage } from '../src/pages/GaragePage';
import { useReadingsAddress } from '../src/pages/garage/readingsAddress';

/**
 * Адрес вкладки «Показания» (план «Показания техники», Р1 и Р29).
 *
 * Проверяется то, ради чего адрес и заводили: сводку пересылают ссылкой. «Вот этот парк за июль» —
 * половина пользы экрана, и период, живущий в `useState`, такой ссылки не даёт: он теряется от
 * перезагрузки, от «назад» и от пересылки. Отсюда четыре утверждения — умолчание считается от дня
 * среза, адрес period перебивает, мусор в нём открывает экран, а не ломает его, и выбранный
 * период в адрес возвращается.
 *
 * Пятое — про соседей: день среза («Техника» и «Водители») и период сводки живут в одном адресе и
 * не стирают друг друга. Раньше страница переписывала параметры списком из двух ключей, и первый
 * же шаг по дням уносил бы период вместе с подвкладкой.
 */

const STATS = 'GET /vehicle-readings/stats';

/** День среза страницы: от него отсчитывается умолчание периода сводки. */
const DAY = '2026-07-24';
const MONTH_START = '2026-07-01';

const ROW: VehicleReadingStatsRow = {
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65115 · А123ВС799',
  distanceKm: 1240.5,
  engineHours: 38,
  lastOdometer: { value: 128_400, measuredOn: '2026-07-20' },
  lastEngineHours: { value: 5120.5, measuredOn: '2026-07-20' },
  fuelFilledLiters: 620,
  gaps: 0,
};

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

/** Адрес виден тесту: предмет вкладки живёт именно в нём, а не в состоянии компонента (Р29). */
function AddressProbe() {
  const location = useLocation();
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>;
}

function renderGarage(route: string): HttpMock {
  const http = mockHttp({
    // Границы возвращаются те, что спросили: сводка отвечает про свой период, и по ответу видно,
    // какой отрезок в итоге ушёл на сервер.
    [STATS]: ({ query }) =>
      json({ items: [ROW], from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    // Соседняя вкладка: она монтируется при переключении, и без её ручек запрос ушёл бы в пустоту.
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(VEHICLES_SUMMARY),
    'GET /vehicle-classifications': () => json(emptyList()),
    // Справочник площадок наполняет фильтр отбора по объекту — своих строк среза он не даёт.
    'GET /objects': () => json(emptyList()),
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

/** Период запроса, ушедшего последним: им и проверяется, какой отрезок показан. */
function askedPeriod(http: HttpMock): [string, string] {
  const query = http.lastCall(STATS)!.query;
  return [query.get('from') ?? '', query.get('to') ?? ''];
}

/**
 * Период вводится руками: календарь в jsdom мышью не открывается, а набранное значение antd
 * принимает по Enter — тем же приёмом, что и в тестах журнала показаний.
 */
function typeRange(from: string, to: string): void {
  const inputs = [...document.querySelectorAll<HTMLInputElement>('.ant-picker-input input')];
  expect(inputs.length, 'поля периода').toBe(2);
  for (const [index, text] of [from, to].entries()) {
    const input = inputs[index]!;
    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', charCode: 13 });
  }
}

describe('сводка показаний: период и подвкладка в адресе', () => {
  it('без периода в адресе берёт месяц дня среза', async () => {
    const http = renderGarage(`/garage?tab=readings&date=${DAY}`);

    await waitFor(() => expect(http.countOf(STATS)).toBe(1));
    // Умолчание — начало месяца дня среза → сам день: сводку открывают вопросом «что в этом
    // месяце» про тот месяц, который смотрят на соседних вкладках.
    expect(askedPeriod(http)).toEqual([MONTH_START, DAY]);
  });

  it('период из адреса перебивает умолчание', async () => {
    const http = renderGarage(`/garage?tab=readings&date=${DAY}&from=2026-06-01&to=2026-06-30`);

    await waitFor(() => expect(http.countOf(STATS)).toBe(1));
    expect(askedPeriod(http)).toEqual(['2026-06-01', '2026-06-30']);
  });

  it('мусор и перевёрнутый период открывают экран умолчанием, а не пустотой', async () => {
    // Адрес приходит из закладки и из чужого сообщения — портал обязан открыться при любом.
    const http = renderGarage(`/garage?tab=readings&date=${DAY}&from=вчера&to=2026-06-30`);

    await waitFor(() => expect(http.countOf(STATS)).toBe(1));
    expect(askedPeriod(http)).toEqual([MONTH_START, DAY]);
  });

  it('перевёрнутый период целиком уходит в умолчание', async () => {
    // Сервер такой отрезок не примет, а «молча поменяли местами» — догадка за человека: обе
    // границы возвращаются к умолчанию, у ошибки в ссылке одна судьба, а не две.
    const http = renderGarage(`/garage?tab=readings&date=${DAY}&from=2026-07-20&to=2026-07-10`);

    await waitFor(() => expect(http.countOf(STATS)).toBe(1));
    expect(askedPeriod(http)).toEqual([MONTH_START, DAY]);
  });

  it('выбранный период возвращается в адрес и спрашивается у сервера', async () => {
    const http = renderGarage(`/garage?tab=readings&date=${DAY}`);
    await waitFor(() => expect(http.countOf(STATS)).toBe(1));

    typeRange('01.06.2026', '30.06.2026');

    await waitFor(() => expect(askedPeriod(http)).toEqual(['2026-06-01', '2026-06-30']));
    // Ради этого всё и затевалось: ссылку из строки адреса можно отправить соседу.
    expect(address()).toContain('from=2026-06-01');
    expect(address()).toContain('to=2026-06-30');
  });

  it('неизвестная подвкладка открывает статистику', async () => {
    // Умолчание Р1: подвкладок две, и любое третье значение ведёт на сводку — экран «такой
    // подвкладки нет» не отвечает ни на один вопрос. Проверяется именно мусор в ключе: адрес
    // приходит из закладки и из чужого сообщения, где ключи набирали руками.
    const http = renderGarage(`/garage?tab=readings&sub=archive&date=${DAY}`);

    await waitFor(() => expect(http.countOf(STATS)).toBe(1));
    expect(await screen.findByText(ROW.vehicleLabel)).toBeDefined();
  });

  it('день среза и период сводки не стирают друг друга', async () => {
    const http = renderGarage(`/garage?tab=readings&date=${DAY}&from=2026-06-01&to=2026-06-30`);
    await waitFor(() => expect(http.countOf(STATS)).toBe(1));

    // Уход на соседнюю вкладку и обратно: у неё свой день, у сводки свой период.
    fireEvent.click(screen.getByRole('tab', { name: 'Техника' }));
    await waitFor(() => expect(http.countOf('GET /garage/vehicles')).toBe(1));
    expect(address()).toContain(`date=${DAY}`);
    expect(address()).toContain('from=2026-06-01');
    // Подвкладка называется в адресе только там, где она есть.
    expect(address()).not.toContain('sub=');

    fireEvent.click(screen.getByRole('tab', { name: 'Показания' }));
    await waitFor(() => expect(address()).toContain('sub=stats'));
    expect(askedPeriod(http)).toEqual(['2026-06-01', '2026-06-30']);
  });
});

/**
 * Открытая карточка машины (`?vehicle=`, Р29). Экрана карточки ещё нет — он пишется следующим
 * шагом, — поэтому проверяется сама адресация, без него: ссылка «эта машина за июль» обязана
 * открыть ту же машину, а «назад» — закрыть карточку, а не увести со страницы.
 */
function VehicleProbe({ day }: { day: string }) {
  const { vehicleId, openVehicle } = useReadingsAddress(day);
  return (
    <>
      <div data-testid="vehicle">{vehicleId ?? 'карточки нет'}</div>
      <button onClick={() => openVehicle('v-2')}>Открыть</button>
      <button onClick={() => openVehicle(null)}>Закрыть</button>
    </>
  );
}

describe('карточка машины в адресе сводки', () => {
  const renderProbe = (route: string) =>
    renderWithUser(
      <>
        <VehicleProbe day={DAY} />
        <AddressProbe />
      </>,
      { route },
    );

  it('машина берётся из адреса', () => {
    renderProbe(`/garage?tab=readings&sub=stats&date=${DAY}&vehicle=v-1`);
    expect(screen.getByTestId('vehicle').textContent).toBe('v-1');
  });

  it('без параметра открытой карточки нет', () => {
    renderProbe(`/garage?tab=readings&date=${DAY}`);
    expect(screen.getByTestId('vehicle').textContent).toBe('карточки нет');
  });

  it('открытие и закрытие карточки правят адрес, а не состояние экрана', () => {
    renderProbe(`/garage?tab=readings&sub=stats&date=${DAY}&from=2026-06-01&to=2026-06-30`);

    fireEvent.click(screen.getByRole('button', { name: 'Открыть' }));
    expect(screen.getByTestId('vehicle').textContent).toBe('v-2');
    // Период остаётся при карточке: её открывают ссылкой «эта машина за тот же период».
    expect(address()).toContain('vehicle=v-2');
    expect(address()).toContain('from=2026-06-01');

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.getByTestId('vehicle').textContent).toBe('карточки нет');
    expect(address()).not.toContain('vehicle=');
    expect(address()).toContain('to=2026-06-30');
  });
});
