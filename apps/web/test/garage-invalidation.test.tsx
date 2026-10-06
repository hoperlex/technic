import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { garageKeys } from '@entities/garage';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  approvedVehicleRequest,
  classification,
  vehicleFeed,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * The garage slice after a vehicle order changes status.
 *
 * The garage has no tables of its own — the server builds the day from vehicles, routes, waybills
 * and orders (ADR 0076), so its cache goes stale from edits made elsewhere. Returning a request to
 * "New" releases the vehicle: in the garage it has to become free. The tab, however, invalidated
 * requests, routes and the waybill journal, while the `['garage']` root was invalidated by nobody —
 * the only refresh of the slice was switching tabs on the garage page itself. A dispatcher who
 * released a vehicle and came back to the slice within `staleTime` (ten seconds) saw it busy.
 *
 * The check reads the cache mark rather than re-rendering the slice, for the same reason as in
 * `waybills-invalidation`: the mark is the whole fix. An invalidated entry is refetched on the next
 * mount however young it is, and an unmarked one is shown from the cache for the ten seconds of the
 * LIVE term — the test client keeps that term too (`createTestQueryClient`). Mounting the garage
 * page on top would add its requests, not evidence.
 */

/** Заявка в работе: у неё есть машина и место в рейсе — в срезе дня эта машина занята. */
const IN_WORK = approvedVehicleRequest({
  id: 'vr-1',
  status: 'confirmed',
  version: 5,
  route: {
    id: 'route-3',
    displayNumber: 'Р-3',
    routeDate: '2026-08-05',
    position: 1,
    hasWaybill: false,
    version: 4,
  },
});

/** Ключ вкладки «Техника» гаража: день и фильтры приходят внутри параметров. */
const GARAGE_KEY = garageKeys.vehicles({ on: '2026-08-05' });

function renderTab() {
  const http = mockHttp({
    'GET /vehicle-requests/feed': () => json(vehicleFeed([IN_WORK])),
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ confirmed: 1 })),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
    'GET /vehicles': () => json(emptyList()),
    'GET /vehicle-requests/:id/relocations': () => json([]),
    'PATCH /vehicle-requests/:id/status': ({ params, body }) =>
      json(
        approvedVehicleRequest({
          ...IN_WORK,
          id: params.id,
          status: (body as { status: 'new' }).status,
          assignment: null,
          route: null,
          version: IN_WORK.version + 1,
        }),
      ),
  });

  // Откат в «Новую» доступен только администратору (`requests.rollbackStatus`, ADR 0021).
  const { queryClient } = renderWithUser(<VehicleRequestsTab />, {
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

describe('срез гаража после смены статуса заказа техники', () => {
  it('снятие машины с заявки помечает срез дня устаревшим', async () => {
    const { http, queryClient } = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    // Гараж открыт до перехода и лежит в кэше свежим — ровно так его застаёт диспетчер,
    // вернувшийся к срезу сразу после снятия машины.
    queryClient.setQueryData(GARAGE_KEY, { items: [], total: 0, onDate: '2026-08-05' });
    expect(queryClient.getQueryState(GARAGE_KEY)?.isInvalidated).toBe(false);

    // Тег статуса — кнопка с меню переходов, доступных роли.
    clickButton('В работе');
    const item = await waitFor(() => {
      const found = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
        (el) => el.textContent === 'Новая',
      );
      expect(found, 'пункт меню «Новая»').toBeTruthy();
      return found!;
    });
    fireEvent.click(item);

    // Возврат спрашивает причину: работу стирает подтверждение, а не промах по пункту меню.
    expect(await screen.findByText('Возврат заявки в «Новую»')).toBeDefined();
    const reason = document.querySelector('textarea');
    expect(reason, 'поле причины').toBeTruthy();
    fireEvent.change(reason!, { target: { value: 'Заказчик перенёс работы' } });
    clickButton('Вернуть в «Новую»');

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/status')).toBe(1));

    await waitFor(() => expect(queryClient.getQueryState(GARAGE_KEY)?.isInvalidated).toBe(true));
  });
});
