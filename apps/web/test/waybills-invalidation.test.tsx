import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import {
  approvedVehicleRequest,
  classification,
  rollbackPreview,
  vehicleFeed,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * The waybill journal after a vehicle order changes status.
 *
 * A status change does more than move the request: the server rebuilds its ESM-2 right away
 * (ADR 0037) — the same `PATCH /vehicle-requests/:id/status` writes to the waybill table through
 * the `waybill-esm2` service. The tab, however, invalidated only requests and routes, so the
 * journal opened next showed the state before the transition. The front end cannot see this link
 * at all — it exists only in the server's transaction — so a test guards it.
 *
 * The check reads the cache mark rather than re-rendering the journal, because the mark is the
 * whole fix: an invalidated entry is refetched on the next mount however young it is, while an
 * unmarked one is shown from the cache for the ten seconds of the LIVE term — exactly the window
 * in which the dispatcher saw a stale journal. The test client keeps that term
 * (`createTestQueryClient`); a client that let everything go stale at once used to make "went
 * there and saw fresh data" pass even with the invalidation missing.
 */

/** Заявка в работе: у неё уже есть машина и место в рейсе — значит есть и путевой лист. */
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

/** Ключ журнала — тот же, что у страницы листов: `['waybills', <фильтры>]`. */
const WAYBILLS_KEY = ['waybills', {}];

function renderTab() {
  const http = mockHttp({
    'GET /vehicle-requests/feed': () => json(vehicleFeed([IN_WORK])),
    'GET /vehicle-requests/summary': () => json(vehicleSummary({ confirmed: 1 })),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    // Справочник техники — фильтр по назначенной машине (ADR 0098); списку заявок он не важен.
    'GET /vehicles': () => json(emptyList()),
    // What the return removes is computed by the server (ADR 0211): the dialog asks on opening and
    // holds the click until the answer. The scenario only cares that the dialog opened and let go.
    'POST /vehicle-requests/:id/rollback/preview': () =>
      json(rollbackPreview({ assignment: true })),
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

describe('журнал путевых листов после смены статуса заказа техники', () => {
  it('смена статуса помечает журнал устаревшим', async () => {
    const { http, queryClient } = renderTab();
    expect(await screen.findByText('Т-42')).toBeDefined();

    // Журнал открыт до перехода и лежит в кэше свежим — ровно так его застаёт диспетчер,
    // вернувшийся к листам сразу после смены статуса.
    queryClient.setQueryData(WAYBILLS_KEY, { items: [], total: 0 });
    expect(queryClient.getQueryState(WAYBILLS_KEY)?.isInvalidated).toBe(false);

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
    // Until the consequences arrive the button shows a wait and the click does not go out.
    await screen.findByText('Заявка вернётся в состояние только что заведённой');
    const reason = document.querySelector('textarea');
    expect(reason, 'поле причины').toBeTruthy();
    fireEvent.change(reason!, { target: { value: 'Заказчик перенёс работы' } });
    clickButton('Вернуть в «Новую»');

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/status')).toBe(1));

    await waitFor(() => expect(queryClient.getQueryState(WAYBILLS_KEY)?.isInvalidated).toBe(true));
  });
});
