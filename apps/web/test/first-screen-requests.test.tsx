import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { AdministrationPage } from '../src/pages/admin';
import { DirectoriesPage } from '../src/pages/directories';
import { GaragePage } from '../src/pages/garage';
import { MechRequestsPage } from '../src/pages/mech';
import { ServiceRequestsPage } from '../src/pages/service';
import { VehicleRequestsPage } from '../src/pages/vehicle';
import { WasteRequestsPage } from '../src/pages/waste';
import { WaybillsPage } from '../src/pages/waybills';
import { firstScreen } from './section-requests';
import { authUser, shtabUser } from './factories/auth';
import { serviceInHouseExecutor, serviceOperator } from './factories/service';

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
 * Answers and mounting are shared with the other request measurements (`./section-requests`), so
 * the states they measure — saved filters, the phone, a tab switch — differ from this table by the
 * state alone.
 */

describe('первый экран раздела: запросы до первого действия', () => {
  it('№1 Вывоз мусора, диспетчер — 3', async () => {
    expect(await firstScreen(<WasteRequestsPage />, 'waste', authUser())).toEqual([
      'GET /waste-requests',
      'GET /waste-requests/summary',
      // The recognition banner (ADR 0114, R29): a silent recognition must not look like a calm day.
      // It costs one request per portal; the request card shares the answer.
      'GET /waste-requests/ticket-recognition/health',
    ]);
  });

  it('№2 Вывоз мусора, штаб площадки — 3: свой объект подписан сразу', async () => {
    expect(await firstScreen(<WasteRequestsPage />, 'waste', shtabUser('obj-1'))).toEqual([
      'GET /objects',
      'GET /waste-requests',
      'GET /waste-requests/summary',
    ]);
    expect(screen.getByText('ОБ-1 — ЖК Северный — г. Москва, ул. Северная, 1')).toBeDefined();
  });

  it('№3 Заказ ТС, диспетчер — 4', async () => {
    expect(await firstScreen(<VehicleRequestsPage />, 'vehicle-requests', authUser())).toEqual([
      'GET /departments',
      'GET /objects',
      'GET /vehicle-requests/feed',
      'GET /vehicle-requests/summary',
    ]);
  });

  it('№4 Заказ ТС, штаб площадки — 3', async () => {
    expect(
      await firstScreen(<VehicleRequestsPage />, 'vehicle-requests', shtabUser('obj-1')),
    ).toEqual(['GET /objects', 'GET /vehicle-requests/feed', 'GET /vehicle-requests/summary']);
  });

  it('№5 Путевые листы, диспетчер — 1', async () => {
    expect(await firstScreen(<WaybillsPage />, 'waybills', authUser())).toEqual(['GET /waybills']);
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

  it('№12 Администрирование «Пользователи», администратор — 2', async () => {
    const admin = authUser({ role: 'admin' });
    expect(await firstScreen(<AdministrationPage />, 'admin', admin)).toEqual([
      'GET /users',
      'GET /users/pending-count',
    ]);
  });
});
