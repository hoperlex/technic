import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { AuthUser } from '@technic/contracts';
import { MOBILE_PAGE_SIZE } from '@shared/config';
import { writeListParams } from '@shared/lib';
import { MechRequestsPage } from '../src/pages/mech';
import { AdministrationPage } from '../src/pages/admin';
import { ServiceRequestsPage } from '../src/pages/service';
import { VehicleRequestsPage } from '../src/pages/vehicle';
import { WasteRequestsPage } from '../src/pages/waste';
import { WaybillsPage } from '../src/pages/waybills';
import { json, type HttpMock } from './http';
import { settle } from './query';
import { LESSOR, NORTH, mountSection, requestsSince } from './section-requests';
import { MOBILE_VIEWPORT } from './viewport';
import { authUser, shtabUser } from './factories/auth';
import { list } from './factories/common';
import { SERVICE_COUNTERPARTY, serviceInHouseExecutor } from './factories/service';

/**
 * The first screen in the two states the cold, desktop, unfiltered table of the stage 5 plan (§1,
 * appendix A1) leaves out — a measurement, not a ban.
 *
 * Saved filters (rows №7–№9): the three lists that remember their filters between sessions
 * (ADR 0139) open with one and with two saved fields, each pointing at a dictionary. These sections
 * belong to wave 5b; until then, each dictionary is already requested, so a saved field changes
 * list parameters rather than the count. Wave 5b adds one directory request per saved field.
 *
 * The phone (rows №1–№5): the same sections in the mobile mode of ADR 0030.
 *
 * The composition changes only in the commits that may change the first screen (invariant 6 of the
 * plan, §3: wave 2б1 by the rows of appendix A2, waves 5а/5б by the rows of A1); the commit names
 * the row. Any other change is a regression.
 */

/** Saves a filter set the way the list itself saves it, before the section is opened. */
function saveFilters(user: AuthUser, scope: string, filters: Record<string, string>): void {
  writeListParams(
    { scope, userId: user.id, fields: Object.keys(filters) },
    { mode: 'desktop', filters },
  );
}

/**
 * The list went out with the saved set — and once: a saved value missing from its dictionary would
 * be pruned and the list asked again, which the composition shows as a second line.
 */
function expectSaved(http: HttpMock, route: string, filters: Record<string, string>): void {
  const query = http.lastCall(route)?.query;
  for (const [field, value] of Object.entries(filters)) expect(query?.get(field)).toBe(value);
}

/** The phone mode really took: the list asks the phone page size, not the desktop one. */
function expectPhonePage(http: HttpMock, route: string): void {
  expect(http.lastCall(route)?.query.get('pageSize')).toBe(String(MOBILE_PAGE_SIZE));
}

const PRINTERS = {
  id: 'oet-1',
  code: 'MFU',
  name: 'МФУ',
  sortOrder: 1,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('первый экран с сохранённым отбором (ADR 0139)', () => {
  // The saved fields point at the site filter's dictionary (`/objects`, closed sites included) and
  // at the lessors (`/counterparties?type=mech_lessor`).
  it.each([
    ['одно поле', { placeObjectId: NORTH.id }],
    ['два поля', { placeObjectId: NORTH.id, lessorId: LESSOR.id }],
  ])('№7 Механизация, диспетчер, %s — 7, как без отбора', async (_label, filters) => {
    const user = authUser();
    saveFilters(user, 'mech-requests', filters);
    const { http, queryClient } = mountSection(<MechRequestsPage />, 'mechanization', user);
    await settle(queryClient);

    expect(requestsSince(http)).toEqual([
      'GET /counterparties',
      'GET /departments',
      'GET /mech-models',
      'GET /mech-requests',
      'GET /mech-requests/summary',
      'GET /objects',
      'GET /objects',
    ]);
    expectSaved(http, 'GET /mech-requests', filters);
    // The summary knows one filter only, the site: a status or a lessor would narrow it to itself.
    expect(http.lastCall('GET /mech-requests/summary')?.query.get('placeObjectId')).toBe(NORTH.id);
  });

  // Sites and service companies (`/counterparties?type=service`).
  it.each([
    ['одно поле', { objectId: NORTH.id }],
    ['два поля', { objectId: NORTH.id, serviceCounterpartyId: SERVICE_COUNTERPARTY.id }],
  ])('№8 Орг.техника «Заявки», ИТ-служба, %s — 6, как без отбора', async (_label, filters) => {
    const user = serviceInHouseExecutor();
    saveFilters(user, 'service-requests', filters);
    const { http, queryClient } = mountSection(<ServiceRequestsPage />, 'office-equipment', user);
    await settle(queryClient);

    expect(requestsSince(http)).toEqual([
      'GET /counterparties',
      'GET /departments',
      'GET /objects',
      'GET /objects',
      'GET /office-equipment-types',
      'GET /service-requests',
    ]);
    expectSaved(http, 'GET /service-requests', filters);
  });

  // Sites and equipment types; the type has to exist, or the saved value would be pruned.
  it.each([
    ['одно поле', { objectId: NORTH.id }],
    ['два поля', { objectId: NORTH.id, equipmentTypeId: PRINTERS.id }],
  ])('№9 Орг.техника «Техника», диспетчер, %s — 4, как без отбора', async (_label, filters) => {
    const user = authUser();
    saveFilters(user, 'service-equipment', filters);
    const { http, queryClient } = mountSection(<ServiceRequestsPage />, 'office-equipment', user, {
      routes: { 'GET /office-equipment-types': () => json(list([PRINTERS])) },
    });
    await settle(queryClient);

    expect(requestsSince(http)).toEqual([
      'GET /departments',
      'GET /objects',
      'GET /office-equipment',
      'GET /office-equipment-types',
    ]);
    expectSaved(http, 'GET /office-equipment', filters);
  });
});

describe('первый экран на телефоне (ADR 0030)', () => {
  const phone = { viewport: MOBILE_VIEWPORT };

  it('№1 Вывоз мусора, диспетчер — 3, как на десктопе', async () => {
    const { http, queryClient } = mountSection(<WasteRequestsPage />, 'waste', authUser(), phone);
    await settle(queryClient);
    expect(requestsSince(http)).toEqual([
      'GET /waste-requests',
      'GET /waste-requests/summary',
      'GET /waste-requests/ticket-recognition/health',
    ]);
    expectPhonePage(http, 'GET /waste-requests');
  });

  it('№2 Вывоз мусора, штаб площадки — 3, как на десктопе', async () => {
    const { http, queryClient } = mountSection(
      <WasteRequestsPage />,
      'waste',
      shtabUser('obj-1'),
      phone,
    );
    await settle(queryClient);
    expect(requestsSince(http)).toEqual([
      'GET /objects',
      'GET /waste-requests',
      'GET /waste-requests/summary',
    ]);
    expectPhonePage(http, 'GET /waste-requests');
  });

  it('№3 Заказ ТС, диспетчер — 4, как на десктопе', async () => {
    const { http, queryClient } = mountSection(
      <VehicleRequestsPage />,
      'vehicle-requests',
      authUser(),
      phone,
    );
    await settle(queryClient);
    expect(requestsSince(http)).toEqual([
      'GET /departments',
      'GET /objects',
      'GET /vehicle-requests/feed',
      'GET /vehicle-requests/summary',
    ]);
    expectPhonePage(http, 'GET /vehicle-requests/feed');
  });

  it('№4 Заказ ТС, штаб площадки — 3, как на десктопе', async () => {
    const { http, queryClient } = mountSection(
      <VehicleRequestsPage />,
      'vehicle-requests',
      shtabUser('obj-1'),
      phone,
    );
    await settle(queryClient);
    expect(requestsSince(http)).toEqual([
      'GET /objects',
      'GET /vehicle-requests/feed',
      'GET /vehicle-requests/summary',
    ]);
    expectPhonePage(http, 'GET /vehicle-requests/feed');
  });

  it('№5 Путевые листы, диспетчер — 1, как на десктопе', async () => {
    const { http, queryClient } = mountSection(<WaybillsPage />, 'waybills', authUser(), phone);
    await settle(queryClient);
    expect(requestsSince(http)).toEqual(['GET /waybills']);
    expectPhonePage(http, 'GET /waybills');
  });
});

describe('телефонный шит впервые включает справочники фильтров (волна 5а)', () => {
  it.each([
    {
      name: 'Вывоз',
      page: <WasteRequestsPage />,
      section: 'waste' as const,
      user: authUser(),
      requested: ['GET /container-types', 'GET /counterparties', 'GET /objects'],
    },
    {
      name: 'Заказ ТС',
      page: <VehicleRequestsPage />,
      section: 'vehicle-requests' as const,
      user: authUser(),
      requested: ['GET /vehicle-classifications', 'GET /vehicles'],
    },
    {
      name: 'Путевые листы',
      page: <WaybillsPage />,
      section: 'waybills' as const,
      user: authUser(),
      requested: ['GET /drivers', 'GET /objects', 'GET /vehicles'],
    },
    {
      name: 'Пользователи',
      page: <AdministrationPage />,
      section: 'admin' as const,
      user: authUser({ role: 'admin' }),
      requested: ['GET /counterparties', 'GET /objects'],
    },
  ])('$name: opening the sheet starts only its missing dictionaries', async (scenario) => {
    const { http, queryClient } = mountSection(scenario.page, scenario.section, scenario.user, {
      viewport: MOBILE_VIEWPORT,
    });
    await settle(queryClient);
    const from = http.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Фильтры/ }));
    await settle(queryClient);
    expect(requestsSince(http, from)).toEqual(scenario.requested);
  });
});
