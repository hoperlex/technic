import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { VehicleRouteDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { VehicleRoutesTab } from '../src/pages/vehicle/VehicleRoutesTab';

/**
 * Журнал путевых листов после выдачи листа из карточки рейса.
 *
 * Лист рождается ручкой рейса (`POST /vehicle-routes/:id/waybill`), а печатают его из журнала — и
 * диспетчер идёт туда сразу же, следом за выдачей. Вкладка гасила в кэше рейсы и заявки, но не
 * журнал, поэтому лист, только что выписанный, там не появлялся: `staleTime` в приложении десять
 * секунд, и это ровно то время, за которое переходят на соседний экран.
 *
 * Как и у смены статуса заказа, проверяется пометка кэша, а не перерисовка журнала: у тестового
 * `QueryClient` `staleTime` равен нулю, поэтому журнал перезапросился бы при открытии сам — и
 * сценарий «перешли и увидели свежее» проходил бы даже с невыполненной инвалидацией.
 */

/**
 * Перегон с водителем: состава у него нет по устройству — вместо талонов заказчиков он держит
 * заявку, ради которой едет. Поэтому лист по нему выписывается без вопросов о пустом бланке.
 */
const ROUTE: VehicleRouteDto = {
  id: 'route-1',
  displayNumber: 'Р-12',
  purpose: 'delivery',
  formCode: '4p',
  routeDate: '2026-08-07',
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  vehicleKindId: 'kind-freight',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
  vehicleCategorySpecs: null,
  driverPersonId: 'p-1',
  driverName: 'Иванов И. И.',
  driverGaps: [],
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '00000389',
  communicationKind: 'городское',
  transportationKind: '',
  comment: '',
  requests: [],
  sourceRequest: {
    requestId: 'vr-1',
    displayNumber: 'Т-42',
    status: 'confirmed',
    customerName: 'ЖК Северный',
  },
  moveFrom: 'База, Каширское ш., 12',
  moveTo: 'ЖК Северный',
  waybill: null,
  createdByName: 'Диспетчеров Д. П.',
  createdAt: '2026-08-06T09:00:00.000Z',
  version: 1,
} as unknown as VehicleRouteDto;

/** Ключ журнала — тот же, что у страницы листов: `['waybills', <фильтры>]`. */
const WAYBILLS_KEY = ['waybills', {}];

const ISSUE_ROUTE = 'POST /vehicle-routes/:id/waybill';

function renderTab() {
  const http = mockHttp({
    'GET /vehicle-routes': () => json(list([ROUTE])),
    'GET /vehicle-routes/:id': () => json(ROUTE),
    'GET /vehicles': () => json(emptyList()),
    'GET /drivers': () => json(list([{ id: 'p-1', fullName: 'Иванов Иван Иванович' } as never])),
    // Карточка предлагает заявки в состав рейса — сценарию они не нужны, но экран их спросит.
    'GET /vehicle-requests': () => json(emptyList()),
    'GET /vehicle-requests/feed': () => json(emptyList()),
    [ISSUE_ROUTE]: () =>
      json({ ...ROUTE, waybill: { id: 'wb-1', number: '000123', status: 'issued' }, version: 2 }),
  });

  const { queryClient } = renderWithUser(<VehicleRoutesTab />, {
    user: authUser({ role: 'admin' }),
  });
  return { http, queryClient };
}

/** Кнопка по видимой подписи: `*ByRole` на таблице antd считает доступные имена всему дереву. */
function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((el) => el.textContent === label);
  expect(button, `кнопка «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

describe('журнал путевых листов после выдачи листа', () => {
  it('выдача листа из карточки рейса помечает журнал устаревшим', async () => {
    const { http, queryClient } = renderTab();

    // Журнал открыт до выдачи и лежит в кэше свежим — так его застаёт диспетчер, идущий печатать.
    queryClient.setQueryData(WAYBILLS_KEY, { items: [], total: 0 });
    expect(queryClient.getQueryState(WAYBILLS_KEY)?.isInvalidated).toBe(false);

    // Карточку открывает кнопка действия строки, а не сам номер. Подпись у неё в `Tooltip`, в
    // разметку не попадает — поэтому кнопка опознаётся по своей иконке.
    const open = await waitFor(() => {
      const found = document.querySelector('.anticon-eye')?.closest('button');
      expect(found, 'кнопка «Открыть маршрут»').toBeTruthy();
      return found!;
    });
    fireEvent.click(open);
    expect(await screen.findByText(/Маршрут Р-12/)).toBeDefined();

    clickButton('Выписать лист');
    await waitFor(() => expect(http.countOf(ISSUE_ROUTE)).toBe(1));

    await waitFor(() => expect(queryClient.getQueryState(WAYBILLS_KEY)?.isInvalidated).toBe(true));
  });
});
