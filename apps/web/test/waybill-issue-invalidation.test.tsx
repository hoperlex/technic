import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { moscowDateKeyOf, type VehicleRouteDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { RouteModalProvider } from '@app/route-windows';

/**
 * The waybill journal after a waybill is issued from the route card.
 *
 * The waybill is born by the route endpoint (`POST /vehicle-routes/:id/waybill`) but printed from
 * the journal — and the dispatcher goes there right after issuing it. The cache invalidated routes
 * and requests but not the journal, so a waybill just issued did not show up there: `staleTime` is
 * ten seconds, exactly the time it takes to move to the next screen.
 *
 * As with the order status change (`waybills-invalidation`), the check reads the cache mark
 * rather than re-rendering the journal: the mark is the whole fix. An invalidated entry is
 * refetched on the next mount however young it is, and an unmarked one is shown from the cache
 * for the ten seconds of the LIVE term, which the test client keeps as well
 * (`createTestQueryClient`).
 *
 * The card is opened by the window provider (ADR 0120), and it is mounted here whole, together with
 * parsing the address. The scene used to belong to the "Routes" tab, which is gone, and the card
 * itself does not and must not know about the journal: it reports a change (`onChanged`), and the
 * keys are invalidated by whoever holds these windows. Hand the test its own `onChanged`, and it
 * would check its own stub while the real invalidation could vanish unnoticed. Hence the address:
 * the route is named in it (`?route=`), the way the links from a request row, the garage and the
 * waybill journal name it.
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
