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
  vehicleFeed,
  vehicleSummary,
} from './factories/vehicle';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * Журнал путевых листов после смены статуса заказа техники.
 *
 * Смена статуса не только двигает заявку: сервер тут же сводит заново её ЭСМ-2 (ADR 0037) — та же
 * ручка `PATCH /vehicle-requests/:id/status` пишет в таблицу листов через сервис `waybill-esm2`.
 * Вкладка же гасила в кэше только заявки и рейсы, поэтому открытый следом журнал показывал
 * состояние до перехода. Со стороны фронта такую связь не видно вовсе — она есть только в
 * транзакции сервера, и потому стережётся тестом.
 *
 * Проверяется пометка кэша, а не перерисовка журнала. Причина в подмене, на которой такой тест
 * обычно и обманывает: у тестового `QueryClient` `staleTime` равен нулю, поэтому журнал
 * перезапросился бы при открытии сам — и сценарий «перешли и увидели свежее» проходил бы даже с
 * невыполненной инвалидацией. В приложении `staleTime` десять секунд, и как раз в это окно
 * диспетчер видит устаревший журнал.
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
    const reason = document.querySelector('textarea');
    expect(reason, 'поле причины').toBeTruthy();
    fireEvent.change(reason!, { target: { value: 'Заказчик перенёс работы' } });
    clickButton('Вернуть в «Новую»');

    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id/status')).toBe(1));

    await waitFor(() => expect(queryClient.getQueryState(WAYBILLS_KEY)?.isInvalidated).toBe(true));
  });
});
