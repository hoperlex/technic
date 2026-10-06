import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { type AuthUser, type PortalShellSectionId, SHELL_SECTIONS } from '@technic/contracts';
import { AsyncContent } from '@shared/ui';
import { AdministrationPage } from '../src/pages/admin';
import { DirectoriesPage } from '../src/pages/directories';
import { GaragePage } from '../src/pages/garage';
import { MechRequestsPage } from '../src/pages/mech';
import { ServiceRequestsPage } from '../src/pages/service';
import { VehicleRequestsPage } from '../src/pages/vehicle';
import { WasteRequestsPage } from '../src/pages/waste';
import { WaybillsPage } from '../src/pages/waybills';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { settle } from './query';
import { authUser, shtabUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { garageVehicle, garageVehicleList, garageVehiclesSummary } from './factories/garage';
import { account } from './factories/grants';
import { mechRequest, mechSummary } from './factories/mech';
import { officeEquipmentUnit } from './factories/officeEquipment';
import {
  SERVICE_COUNTERPARTY,
  serviceInHouseExecutor,
  serviceOperator,
  serviceRequest,
} from './factories/service';
import {
  classification,
  fleetVehicle,
  machinist,
  vehicleFeed,
  vehicleRequest,
  vehicleSummary,
} from './factories/vehicle';
import {
  containerType,
  objectDto,
  operator,
  wasteRequest,
  wasteSummary,
  wasteType,
} from './factories/waste';
import { waybill } from './factories/waybill';

/**
 * What each portal section asks the API before the user does anything — a measurement, not a ban.
 *
 * Conditions are those of the stage 5 queries plan (first-screen table and its appendix A1):
 * desktop, cold cache (a fresh production query client per test, `createTestQueryClient`), no
 * filters in the URL and none saved. The section page is mounted the way the router mounts it — its public
 * lazy entry under `AsyncContent` — and the shell is left out: menu badges and the session are
 * asked once per portal, not per section. Every test names its row (`№1`–`№12`) of that table and
 * pins the exact composition, sorted by method and path.
 *
 * The composition is allowed to change in two kinds of commits only, and the commit message names
 * the row (invariant 6 of the plan, §3):
 *   - wave 2б1, by the rows of appendix A2 — one HTTP request read under several cache keys
 *     becomes one key;
 *   - waves 5а/5б, by the rows of appendix A1 (and A2 №11) — a dictionary that only a filter or a
 *     form needs is asked when that filter is expanded or that form is opened.
 * Any other change of a list below is a regression: a request nobody decided to add to the first
 * screen, or a deferred one that came back. A new request fails here as an extra line; an
 * unmocked one fails the whole test through the unmatched-request check of `mockHttp`.
 *
 * Responses are minimal but not empty where emptiness would hide a request: the garage asks for
 * maintenance and parts snapshots of the visible page, and an empty page would drop both. No
 * composition here depends on dictionary content today (the same lists come out with every
 * dictionary empty), so dictionaries answer with one entry or none.
 */

const NORTH = objectDto({ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' });
const SOUTH = objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' });
const COUNTERPARTIES = [
  operator(),
  operator({ id: 'cp-lessor', name: 'СтройАренда', type: 'mech_lessor' }),
  operator({ ...SERVICE_COUNTERPARTY, type: 'service' }),
];

/** Every route a first screen below may ask; a test asserts which of them it actually did. */
function firstScreenRoutes(user: AuthUser): RouteMap {
  // The server narrows sites to the account's scope: a site staff member sees exactly their own.
  const scope = user.constructionObjectIds;
  const sites = [NORTH, SOUTH].filter((site) => scope.length === 0 || scope.includes(site.id));
  return {
    'GET /objects': () => json(list(sites)),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': ({ query }) =>
      json(list(COUNTERPARTIES.filter((c) => !query.get('type') || c.type === query.get('type')))),

    'GET /waste-requests': () => json(list([wasteRequest()])),
    'GET /waste-requests/summary': () => json(wasteSummary()),
    'GET /waste-requests/ticket-recognition/health': () =>
      json({ state: 'ok', since: null, code: '', attempts: 0, failed: 0, waiting: 0 }),
    'GET /container-types': () => json(list([containerType()])),
    'GET /waste-types': () => json(list([wasteType()])),

    'GET /vehicle-requests/feed': () => json(vehicleFeed([vehicleRequest()])),
    'GET /vehicle-requests/summary': () => json(vehicleSummary()),
    'GET /vehicle-classifications': () => json(list([classification()])),
    'GET /vehicles': () => json(list([fleetVehicle()])),
    'GET /drivers': () => json(list([machinist()])),
    'GET /waybills': () => json(list([waybill()])),

    'GET /garage/vehicles': ({ query }) =>
      json(garageVehicleList([garageVehicle()], query.get('on') ?? '')),
    'GET /garage/vehicles/summary': ({ query }) =>
      json(garageVehiclesSummary(query.get('on') ?? '')),
    'GET /vehicle-maintenance/snapshot': ({ query }) =>
      json({ on: query.get('on') ?? '', items: [] }),
    'GET /auto-part-receipts/vehicles/snapshot': ({ query }) =>
      json({ to: query.get('to') ?? '', items: [] }),

    'GET /mech-requests': () => json(list([mechRequest()])),
    'GET /mech-requests/summary': () => json(mechSummary()),
    'GET /mech-models': () => json(emptyList()),

    'GET /service-requests': () => json(list([serviceRequest()])),
    'GET /office-equipment': () => json(list([officeEquipmentUnit()])),
    'GET /office-equipment-types': () => json(emptyList()),

    'GET /users': () => json(list([account()])),
    'GET /users/pending-count': () => json({ count: 0 }),
  };
}

/** The section's address comes from the shell registry, the only owner of section paths. */
function sectionPath(id: PortalShellSectionId): string {
  const section = SHELL_SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`no shell section «${id}»`);
  return section.path;
}

/** Mounts the section page cold and returns what it asked, once the screen is quiet. */
async function firstScreen(
  page: ReactNode,
  section: PortalShellSectionId,
  user: AuthUser,
): Promise<string[]> {
  const http = mockHttp(firstScreenRoutes(user));
  const { queryClient } = renderWithUser(<AsyncContent>{page}</AsyncContent>, {
    user,
    route: sectionPath(section),
  });
  await settle(queryClient);
  return http.calls.map((call) => `${call.method} ${call.path}`).sort();
}

describe('первый экран раздела: запросы до первого действия', () => {
  it('№1 Вывоз мусора, диспетчер — 7', async () => {
    expect(await firstScreen(<WasteRequestsPage />, 'waste', authUser())).toEqual([
      'GET /container-types',
      // Operators: the dispatcher assigns the executor, so the operator filter and the assignment
      // window are his alone — the fullest set of any role.
      'GET /counterparties',
      'GET /objects',
      'GET /waste-requests',
      'GET /waste-requests/summary',
      // The recognition banner (ADR 0114, R29): a silent recognition must not look like a calm day.
      // It costs one request per portal; the request card shares the answer.
      'GET /waste-requests/ticket-recognition/health',
      'GET /waste-types',
    ]);
  });

  it('№2 Вывоз мусора, штаб площадки — 5: ни операторов, ни состояния распознавания', async () => {
    expect(await firstScreen(<WasteRequestsPage />, 'waste', shtabUser('obj-1'))).toEqual([
      'GET /container-types',
      'GET /objects',
      'GET /waste-requests',
      'GET /waste-requests/summary',
      'GET /waste-types',
    ]);
  });

  it('№3 Заказ ТС, диспетчер — 6', async () => {
    expect(await firstScreen(<VehicleRequestsPage />, 'vehicle-requests', authUser())).toEqual([
      'GET /departments',
      'GET /objects',
      'GET /vehicle-classifications',
      'GET /vehicle-requests/feed',
      'GET /vehicle-requests/summary',
      'GET /vehicles',
    ]);
  });

  it('№4 Заказ ТС, штаб площадки — 6, тот же состав', async () => {
    expect(
      await firstScreen(<VehicleRequestsPage />, 'vehicle-requests', shtabUser('obj-1')),
    ).toEqual([
      // Departments for a site role as well: the request editor's controller is mounted with the
      // dialog closed and reads department platforms (`departmentPlatformQuery`).
      'GET /departments',
      'GET /objects',
      'GET /vehicle-classifications',
      'GET /vehicle-requests/feed',
      'GET /vehicle-requests/summary',
      'GET /vehicles',
    ]);
  });

  it('№5 Путевые листы, диспетчер — 4', async () => {
    expect(await firstScreen(<WaybillsPage />, 'waybills', authUser())).toEqual([
      'GET /drivers',
      'GET /objects',
      'GET /vehicles',
      'GET /waybills',
    ]);
  });

  it('№6 Гараж, диспетчер — 6', async () => {
    expect(await firstScreen(<GaragePage />, 'garage', authUser())).toEqual([
      'GET /auto-part-receipts/vehicles/snapshot',
      'GET /garage/vehicles',
      'GET /garage/vehicles/summary',
      'GET /objects',
      'GET /vehicle-classifications',
      'GET /vehicle-maintenance/snapshot',
    ]);
  });

  it('№7 Механизация, диспетчер — 7', async () => {
    expect(await firstScreen(<MechRequestsPage />, 'mechanization', authUser())).toEqual([
      // Lessors.
      'GET /counterparties',
      'GET /departments',
      'GET /mech-models',
      'GET /mech-requests',
      'GET /mech-requests/summary',
      // Sites twice, under two keys: the filter reads closed sites too (`activeOnly: false`), the
      // mounted closed form reads active ones.
      'GET /objects',
      'GET /objects',
    ]);
  });

  it('№8 Орг.техника «Заявки», ИТ-служба — 6', async () => {
    expect(
      await firstScreen(<ServiceRequestsPage />, 'office-equipment', serviceInHouseExecutor()),
    ).toEqual([
      // Service companies.
      'GET /counterparties',
      'GET /departments',
      // Sites twice, as in Mechanization: the filter (`activeOnly: false`) and the customer
      // options of the mounted closed request form (`activeOnly: true`).
      'GET /objects',
      'GET /objects',
      'GET /office-equipment-types',
      'GET /service-requests',
    ]);
  });

  it('№9 Орг.техника «Техника», диспетчер — 4', async () => {
    // Without `serviceRequests.read` the dispatcher's first tab is the equipment registry.
    expect(await firstScreen(<ServiceRequestsPage />, 'office-equipment', authUser())).toEqual([
      'GET /departments',
      'GET /objects',
      'GET /office-equipment',
      'GET /office-equipment-types',
    ]);
  });

  it('№10 Справочники «Объекты», диспетчер (directories.write) — 2', async () => {
    expect(await firstScreen(<DirectoriesPage />, 'directories', authUser())).toEqual([
      // Operators of the site form, asked although the form is not open.
      'GET /counterparties',
      'GET /objects',
    ]);
  });

  it('№11 Справочники «Оргтехника», только officeEquipment.write — 4', async () => {
    // Without `directories.write` the equipment tab is the only one, and so the first.
    expect(await firstScreen(<DirectoriesPage />, 'directories', serviceOperator())).toEqual([
      'GET /departments',
      'GET /objects',
      'GET /office-equipment',
      'GET /office-equipment-types',
    ]);
  });

  it('№12 Администрирование «Пользователи», администратор — 5', async () => {
    const admin = authUser({ role: 'admin' });
    expect(await firstScreen(<AdministrationPage />, 'admin', admin)).toEqual([
      'GET /counterparties',
      'GET /departments',
      'GET /objects',
      'GET /users',
      'GET /users/pending-count',
    ]);
  });
});
