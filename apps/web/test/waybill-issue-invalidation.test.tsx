import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { moscowDateKeyOf, type VehicleRouteDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { RouteModalProvider } from '../src/pages/vehicle/routeModal';

/**
 * Журнал путевых листов после выдачи листа из карточки рейса.
 *
 * Лист рождается ручкой рейса (`POST /vehicle-routes/:id/waybill`), а печатают его из журнала — и
 * диспетчер идёт туда сразу же, следом за выдачей. Гасились в кэше рейсы и заявки, но не журнал,
 * поэтому лист, только что выписанный, там не появлялся: `staleTime` в приложении десять секунд,
 * и это ровно то время, за которое переходят на соседний экран.
 *
 * Как и у смены статуса заказа, проверяется пометка кэша, а не перерисовка журнала: у тестового
 * `QueryClient` `staleTime` равен нулю, поэтому журнал перезапросился бы при открытии сам — и
 * сценарий «перешли и увидели свежее» проходил бы даже с невыполненной инвалидацией.
 *
 * Карточку открывает провайдер окон (ADR 0120), и поднимается он здесь целиком — вместе с разбором
 * адреса. Раньше сцену держала вкладка «Маршруты», которой больше нет, а сама карточка о журнале
 * не знает и знать не должна: она сообщает о перемене (`onChanged`), а гасит ключи тот, кто эти
 * окна держит. Подставь тесту свой `onChanged` — он проверял бы собственную заглушку, и настоящая
 * инвалидация могла бы пропасть незамеченной. Отсюда и адрес: рейс назван в нём (`?route=`), как
 * его называет ссылка из строки заявки, из гаража и из журнала листов.
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
  /**
   * День рейса — сегодняшний, и это существенно (ADR 0101, дыра 1). Выписка на **прошедший** день
   * с тех пор идёт через окно коррекции: она спрашивает право, причину и ключ операции, и кнопка
   * «Выписать лист» мутацию сама не запускает. Здесь проверяется не коррекция, а инвалидация
   * журнала после обычной выдачи, поэтому дата берётся живой.
   *
   * Константой её вернуть нельзя: зафиксированный день рано или поздно окажется в прошлом, и тест
   * начнёт падать на пустом месте — ровно так он и упал, когда коррекция появилась.
   */
  routeDate: moscowDateKeyOf(new Date()),
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

/**
 * Провайдер — элемент маршрутизации: он рисует `<Outlet/>`, а окна кладёт поверх. Под ним поэтому
 * стоит пустая страница: сценарию важно не то, что под окном, а то, что рейс, названный в адресе,
 * открылся карточкой на любой странице портала.
 */
function renderRouteCard() {
  const http = mockHttp({
    'GET /vehicle-routes/:id': () => json(ROUTE),
    // Карточка предлагает заявки в состав рейса — сценарию они не нужны, но экран их спросит.
    'GET /vehicle-requests': () => json(emptyList()),
    [ISSUE_ROUTE]: () =>
      json({ ...ROUTE, waybill: { id: 'wb-1', number: '000123', status: 'issued' }, version: 2 }),
  });

  const { queryClient } = renderWithUser(
    <Routes>
      <Route element={<RouteModalProvider />}>
        <Route path="/vehicle-requests" element={<div />} />
      </Route>
    </Routes>,
    { user: authUser({ role: 'admin' }), route: '/vehicle-requests?route=route-1' },
  );
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
    const { http, queryClient } = renderRouteCard();

    // Журнал открыт до выдачи и лежит в кэше свежим — так его застаёт диспетчер, идущий печатать.
    queryClient.setQueryData(WAYBILLS_KEY, { items: [], total: 0 });
    expect(queryClient.getQueryState(WAYBILLS_KEY)?.isInvalidated).toBe(false);

    // Карточка открыта самим адресом: `?route=route-1` — тот самый адрес, который печатает ссылка
    // на рейс и который приходит письмом.
    expect(await screen.findByText(/Маршрут Р-12/)).toBeDefined();

    clickButton('Выписать лист');
    await waitFor(() => expect(http.countOf(ISSUE_ROUTE)).toBe(1));

    await waitFor(() => expect(queryClient.getQueryState(WAYBILLS_KEY)?.isInvalidated).toBe(true));
  });
});
