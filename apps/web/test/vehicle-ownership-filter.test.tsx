import { describe, expect, it } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import type { CounterpartyDto } from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { classification, vehicleFeed, vehicleSummary } from './factories/vehicle';
import { VehicleRequestsHistoryTab } from '../src/pages/vehicle/VehicleRequestsHistoryTab';
import { VehicleRequestsOnSiteTab } from '../src/pages/vehicle/VehicleRequestsOnSiteTab';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';
import { PageTabs } from '../src/shared/ui';

/**
 * Фильтр «Принадлежность» заказа ТС — своя техника или аренда — на трёх вкладках, где его видно
 * сразу (общий хук `useOwnershipFilter`; архив подключён тем же хуком).
 *
 * Проверяется то, что можно сломать на стороне портала: параметр уезжает в список **и** в сводку над
 * ним (цифры обязаны считаться по тем же строкам), выбор возвращает список на первую страницу, а
 * в журнале «Собственная» убирает арендодателя — пара «своя машина + арендодатель» всегда пуста. Сам
 * отбор проверяет db-тест API; здесь он замокан.
 */

const ADMIN = authUser({ role: 'admin' });
/** Арендодатель видит только свои арендные строки — спрашивать «своя или аренда» ему не о чем. */
const LESSOR = authUser({ role: 'operator', counterpartyType: 'vehicle_lessor' });

const LESSOR_COUNTERPARTY = { id: 'cp-1', name: 'ООО «Ромашка»' } as CounterpartyDto;

const OWNERSHIP_PLACEHOLDER = 'Своя и аренда';
const LESSOR_PLACEHOLDER = 'Все арендодатели';

/** Поле панели опознаётся своей подсказкой: подписи у фильтров нет, её место занимает placeholder. */
async function openFilter(placeholder: string) {
  const field = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.ant-select')].find(
      (el) => el.textContent?.trim() === placeholder,
    );
    if (!found) throw new Error(`фильтра «${placeholder}» на экране нет`);
    return found;
  });
  fireEvent.mouseDown(field.querySelector('.ant-select-selector') ?? field);
}

/** Вариант ищется по точному тексту: у соседних списков бывают варианты со схожими словами. */
async function toggleOption(option: string) {
  await waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
      (o) => o.textContent?.trim() === option,
    );
    expect(match, `вариант «${option}»`).toBeTruthy();
    fireEvent.click(match!);
  });
}

async function pickFilter(placeholder: string, option: string) {
  await openFilter(placeholder);
  await toggleOption(option);
}

/** Есть ли на панели поле с такой подсказкой: пустым оно показывает именно её. */
function hasFilter(placeholder: string): boolean {
  return [...document.querySelectorAll<HTMLElement>('.ant-select')].some(
    (el) => el.textContent?.trim() === placeholder,
  );
}

function renderHistory(user = ADMIN) {
  const http = mockHttp({
    'GET /vehicle-requests/history': () => json(emptyList()),
    'GET /vehicle-requests/history/summary': () =>
      json({ total: 0, done: 0, cancelled: 0, totalCost: 0, withoutCost: 0 }),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    'GET /counterparties': () => json(list([LESSOR_COUNTERPARTY])),
    'GET /vehicles': () => json(emptyList()),
  });
  renderWithUser(<VehicleRequestsHistoryTab />, { user });
  return http;
}

describe('журнал закрытых заказов: принадлежность техники', () => {
  it('выбор уходит параметром и в журнал, и в итог над ним, и возвращает на первую страницу', async () => {
    const http = renderHistory();
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));
    expect(http.lastCall('GET /vehicle-requests/history')!.query.get('ownership')).toBeNull();

    await pickFilter(OWNERSHIP_PLACEHOLDER, 'Аренда');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/history')!;
      expect(call.query.get('ownership')).toBe('rental');
      expect(call.query.get('page')).toBe('1');
    });
    // Итог за период считается по тем же строкам, что и таблица.
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/history/summary')!.query.get('ownership')).toBe(
        'rental',
      ),
    );
  });

  it('«Собственная» убирает арендодателя: выбранный сбрасывается, поле скрыто, «Аренда» его возвращает', async () => {
    const http = renderHistory();
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));

    await pickFilter(LESSOR_PLACEHOLDER, 'ООО «Ромашка»');
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/history')!.query.get('lessorId')).toBe('cp-1'),
    );

    await pickFilter(OWNERSHIP_PLACEHOLDER, 'Собственная');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/history')!;
      expect(call.query.get('ownership')).toBe('own');
      // Арендодатель есть только у арендной машины: пара осталась бы заведомо пустым журналом.
      expect(call.query.get('lessorId')).toBeNull();
    });
    expect(hasFilter(LESSOR_PLACEHOLDER)).toBe(false);

    // Тот же выбор в другую сторону: у аренды арендодатель снова есть.
    await openFilter('Собственная');
    await toggleOption('Аренда');
    await waitFor(() => expect(hasFilter(LESSOR_PLACEHOLDER)).toBe(true));
  });

  it('арендодателю фильтра нет вовсе: все его строки арендные', async () => {
    const http = renderHistory(LESSOR);
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/history')).toBe(1));

    expect(hasFilter(OWNERSHIP_PLACEHOLDER)).toBe(false);
    expect(hasFilter(LESSOR_PLACEHOLDER)).toBe(false);
  });
});

describe('вкладка «Заявки»: принадлежность техники', () => {
  it('выбор уходит параметром и в ленту, и в сводку над ней', async () => {
    const http = mockHttp({
      'GET /vehicle-requests/feed': () => json(vehicleFeed([], [])),
      'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 1 })),
      'GET /objects': () => json(list([objectDto()])),
      'GET /departments': () => json(emptyList()),
      'GET /vehicle-classifications': () => json(list([classification()])),
      'GET /vehicles': () => json(emptyList()),
    } satisfies RouteMap);
    // Вкладка рисуется внутри `PageTabs`: сводка живёт на их уровне.
    renderWithUser(
      <PageTabs
        activeKey="requests"
        items={[{ key: 'requests', label: 'Заказ автотехники', children: <VehicleRequestsTab /> }]}
      />,
      { user: ADMIN, route: '/vehicle-requests' },
    );
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/feed')).toBe(1));
    expect(http.lastCall('GET /vehicle-requests/feed')!.query.get('ownership')).toBeNull();

    await pickFilter(OWNERSHIP_PLACEHOLDER, 'Собственная');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/feed')!;
      expect(call.query.get('ownership')).toBe('own');
      expect(call.query.get('page')).toBe('1');
    });
    // Цифры над таблицей считаются по тому же сужению, что и строки под ней.
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/summary')!.query.get('ownership')).toBe('own'),
    );
  });
});

describe('вкладка «На объекте»: принадлежность техники', () => {
  it('выбор уходит параметром и в срез, и в его сводку', async () => {
    const http = mockHttp({
      'GET /vehicle-requests/on-site': () =>
        json({ items: [], total: 0, page: 1, pageSize: 50, onDate: '2026-07-24' }),
      'GET /vehicle-requests/on-site/summary': () =>
        json({
          total: 0,
          objects: 0,
          arrivedToday: 0,
          leavingToday: 0,
          earlyEndPending: 0,
          awaitingShifts: 0,
        }),
      'GET /objects': () => json(emptyList()),
      'GET /vehicle-classifications': () => json(list([classification()])),
    } satisfies RouteMap);
    renderWithUser(<VehicleRequestsOnSiteTab />, { user: ADMIN });
    await waitFor(() => expect(http.countOf('GET /vehicle-requests/on-site')).toBe(1));
    expect(http.lastCall('GET /vehicle-requests/on-site')!.query.get('ownership')).toBeNull();

    await pickFilter(OWNERSHIP_PLACEHOLDER, 'Аренда');

    await waitFor(() => {
      const call = http.lastCall('GET /vehicle-requests/on-site')!;
      expect(call.query.get('ownership')).toBe('rental');
      expect(call.query.get('page')).toBe('1');
    });
    await waitFor(() =>
      expect(http.lastCall('GET /vehicle-requests/on-site/summary')!.query.get('ownership')).toBe(
        'rental',
      ),
    );
  });
});
