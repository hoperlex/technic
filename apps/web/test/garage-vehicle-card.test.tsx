import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router';
import type {
  GarageVehicleDto,
  GarageVehicleListDto,
  GarageVehiclesSummaryDto,
  ReadingTotals,
  VehicleReadingCardDto,
  VehicleReadingStatsRow,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { maintenanceRecord, maintenanceSummary } from './factories/maintenance';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { GaragePage } from '../src/pages/GaragePage';

/**
 * Гараж → «Техника»: переход из строки в карточку машины (план «Показания техники», §7, Р2, Р29).
 *
 * Третий путь строки. Первые два — окно журнала (`garage-journal`) и сводка ТО
 * (`garage-maintenance`) — были написаны сразу, а этот нет: из гаража в статистику машины попасть
 * было нельзя вовсе, хотя обратный путь (из сводки ТО в карточку) существовал с самого начала.
 *
 * Проверяется здесь адрес перехода, а не содержимое карточки: числа, разбивку по месяцам и блок ТО
 * спрашивает свой тест (`readings-card`). У перехода два собственных утверждения.
 *
 * **Период карточки — умолчание сводки от дня среза**, то есть месяц по этот день включительно, и
 * написан он в адресе числами. Одним днём карточку открывать нечем — она отвечает на вопрос «из
 * чего сложился пробег», — а конец периода обязан совпасть с днём среза: одометр и ТО в той же
 * строке показаны не позже него (Р16).
 *
 * **«Назад» возвращает в гараж.** Переход идёт в историю, поэтому шаг назад — это возврат к срезу
 * того же дня, а не уход со страницы и не открытая заново карточка.
 */

const STATS = 'GET /vehicle-readings/stats';
const CARD = 'GET /vehicle-readings/vehicles/:vehicleId/card';
const SNAPSHOT = 'GET /vehicle-maintenance/snapshot';
const MAINTENANCE = 'GET /vehicle-maintenance/vehicles/:vehicleId/summary';
const MAINTENANCE_HISTORY = 'GET /vehicle-maintenance/vehicles/:vehicleId/history';

/** День среза гаража: от него отсчитывается период карточки, открытой из строки. */
const ON_DATE = '2026-07-24';
const MONTH_START = '2026-07-01';

const LABEL = 'Е646СК799';

/** Строка среза плюс состояние показаний: сервер отдаёт его вместе с колонкой (ADR 0103, Р27). */
type Row = GarageVehicleDto & { readingState: string };

const ROW: Row = {
  id: 'v1',
  label: LABEL,
  state: 'free',
  status: 'active',
  registrationNumber: LABEL,
  garageNumber: '',
  modelName: null,
  vehicleTypeId: 'vt-1',
  typeName: 'Самосвалы',
  vehicleCategoryId: null,
  categoryName: null,
  drivers: [],
  busy: [],
  readingState: 'reported',
  lastOdometer: null,
};

const VEHICLES: GarageVehicleListDto = {
  items: [ROW],
  total: 1,
  page: 1,
  pageSize: 50,
  onDate: ON_DATE,
};

const GARAGE_SUMMARY: GarageVehiclesSummaryDto = {
  total: 1,
  free: 1,
  onRoute: 0,
  onSite: 0,
  unavailable: 0,
  routesWithoutDriver: 0,
  onDate: ON_DATE,
};

const STATS_ROW: VehicleReadingStatsRow = {
  vehicleId: 'v1',
  vehicleLabel: LABEL,
  distanceKm: 1240,
  engineHours: 38.5,
  fuelFilledLiters: 620,
  gaps: 0,
};

function totals(): ReadingTotals {
  return {
    distanceKm: 1240,
    engineHours: 38.5,
    fuelFilledLiters: 620,
    odometerGaps: 0,
    engineHoursGaps: 0,
    missingReadings: 0,
    shifts: 20,
    unacceptedShifts: 0,
  };
}

/** Ответ карточки: границы — те, что спросили, чтобы по нему было видно ушедший период. */
function cardDto(from: string, to: string): VehicleReadingCardDto {
  return {
    vehicleId: 'v1',
    vehicleLabel: LABEL,
    from,
    to,
    total: totals(),
    months: [{ month: '2026-07', ...totals() }],
    lastOdometer: { km: 128400, measuredOn: '2026-07-22' },
    lastEngineHours: { value: 1240.5, measuredOn: '2026-07-22' },
  };
}

function renderPage(options: { user?: ReturnType<typeof authUser>; viewport?: Viewport } = {}) {
  const http = mockHttp({
    'GET /garage/vehicles': () => json(VEHICLES),
    'GET /garage/vehicles/summary': () => json(GARAGE_SUMMARY),
    'GET /garage/drivers': () => json(emptyList()),
    'GET /garage/drivers/summary': () =>
      json({ ...GARAGE_SUMMARY, assigned: 0, documentsIncomplete: 0 }),
    'GET /vehicle-classifications': () => json(emptyList()),
    // Соседняя колонка «ТО» спрашивает своё состояние пакетом (Р16): спрашивают с неё свои тесты.
    [SNAPSHOT]: ({ query }) => json({ on: query.get('on') ?? '', items: [] }),
    [STATS]: ({ query }) =>
      json({ items: [STATS_ROW], from: query.get('from') ?? '', to: query.get('to') ?? '' }),
    [CARD]: ({ query }) => json(cardDto(query.get('from') ?? '', query.get('to') ?? '')),
    // Блок ТО внутри карточки — своя ручка под своим правом (Р14а); проверяют его свои тесты.
    [MAINTENANCE]: () => json(maintenanceSummary({ vehicleId: 'v1', vehicleLabel: LABEL })),
    [MAINTENANCE_HISTORY]: () => json({ items: [maintenanceRecord({ vehicleId: 'v1' })] }),
  });
  renderWithUser(
    <>
      <GaragePage />
      <AddressProbe />
    </>,
    {
      user: options.user,
      viewport: options.viewport,
      route: `/garage?tab=vehicles&date=${ON_DATE}`,
    },
  );
  return http;
}

/** Адрес и шаг назад по истории: карточка живёт в адресе, и «назад» обязано вернуть к срезу. */
function AddressProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="address">{`${location.pathname}${location.search}`}</div>
      <button onClick={() => navigate(-1)}>Шаг назад</button>
    </>
  );
}

const address = () => screen.getByTestId('address').textContent ?? '';

/** Открыта ли карточка: у неё единственный на портале итог периода со своей подписью. */
const cardOpen = () => screen.queryByText('Итог за период') !== null;

/** Строка таблицы по госномеру: из неё и открывают карточку. */
function row(label: string): HTMLElement {
  return screen.getByText(label).closest('tr') as HTMLElement;
}

describe('гараж: переход из строки в карточку машины', () => {
  it('ссылка строки называет машину и период в адресе', async () => {
    renderPage();

    expect(await screen.findByText(LABEL)).toBeDefined();
    // Ссылка ведёт по адресу, а не «куда-то»: её копируют и присылают, поэтому проверяется href.
    // Период написан числами — месяц по день среза, тот самый, которым откроется сводка.
    const link = within(row(LABEL)).getByText('статистика');
    expect(link.getAttribute('href')).toBe(
      `/garage?tab=readings&sub=stats&date=${ON_DATE}&vehicle=v1&from=${MONTH_START}&to=${ON_DATE}`,
    );
  });

  it('переход открывает карточку той же машины за месяц по день среза', async () => {
    const http = renderPage();

    expect(await screen.findByText(LABEL)).toBeDefined();
    fireEvent.click(within(row(LABEL)).getByText('статистика'));

    await waitFor(() => expect(http.countOf(CARD)).toBe(1));
    expect(http.lastCall(CARD)!.path).toBe('/vehicle-readings/vehicles/v1/card');
    // Конец периода — день среза, а не сегодняшний день браузера: одометр и ТО в строке, из
    // которой пришли, показаны не позже него (Р16).
    expect(http.lastCall(CARD)!.query.get('from')).toBe(MONTH_START);
    expect(http.lastCall(CARD)!.query.get('to')).toBe(ON_DATE);

    await waitFor(() => expect(cardOpen()).toBe(true));
    // Открылась подвкладка «Статистика», а не просто вкладка показаний: предмет назван целиком.
    expect(address()).toContain('tab=readings');
    expect(address()).toContain('sub=stats');
    expect(address()).toContain('vehicle=v1');
  });

  it('«назад» закрывает карточку и возвращает в гараж на тот же день', async () => {
    renderPage();

    expect(await screen.findByText(LABEL)).toBeDefined();
    fireEvent.click(within(row(LABEL)).getByText('статистика'));
    await waitFor(() => expect(cardOpen()).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Шаг назад' }));

    await waitFor(() => expect(cardOpen()).toBe(false));
    // Возврат именно в гараж: та же вкладка, тот же день — а не уход со страницы. Машину по
    // имени здесь уже не спросить: посещённая вкладка «Показания» остаётся смонтированной, и та же
    // строка стоит в её сводке.
    expect(address()).toContain('tab=vehicles');
    expect(address()).toContain(`date=${ON_DATE}`);
    expect(address()).not.toContain('vehicle=v1');
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Техника' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
  });

  it('без права на показания ссылки в строке нет', async () => {
    // Механику гараж положен (`garage.read`), показания — нет (Р14): статистика машины — это её
    // пробег, наработка и топливо, то есть данные модуля показаний.
    renderPage({ user: authUser({ role: 'mechanic' }) });

    expect(await screen.findByText(LABEL)).toBeDefined();
    expect(screen.queryByText('статистика')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Показания' })).toBeNull();
  });

  it('на телефоне тот же переход стоит пунктом действий строки', async () => {
    const http = renderPage({ viewport: MOBILE_VIEWPORT });

    expect(await screen.findByText(LABEL)).toBeDefined();
    // Касание по карточке занято журналом (ADR 0030), поэтому карточка машины — пунктом действий.
    fireEvent.click(screen.getAllByLabelText('Действия')[0]!);
    fireEvent.click(await screen.findByText('Статистика за период'));

    await waitFor(() => expect(http.countOf(CARD)).toBe(1));
    // Тот же адрес, что у ссылки на десктопе: присланная с телефона ссылка открывает у коллеги
    // ровно ту же машину за тот же период.
    expect(address()).toContain('sub=stats');
    expect(address()).toContain('vehicle=v1');
    expect(address()).toContain(`from=${MONTH_START}`);
  });
});
