import type { ReactNode } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import type { QueryClient } from '@tanstack/react-query';
import { type AuthUser, type PortalShellSectionId, SHELL_SECTIONS } from '@technic/contracts';
import { AsyncContent } from '@shared/ui';
import { AppLayout } from '../src/app/layout';
import { AdministrationPage } from '../src/pages/admin';
import { DirectoriesPage } from '../src/pages/directories';
import { GaragePage } from '../src/pages/garage';
import { MechRequestsPage } from '../src/pages/mech';
import { ServiceRequestsPage } from '../src/pages/service';
import { VehicleRequestsPage } from '../src/pages/vehicle';
import { WasteRequestsPage } from '../src/pages/waste';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { settle } from './query';
import type { Viewport } from './viewport';
import { emptyList, list } from './factories/common';
import { garageVehicle, garageVehicleList, garageVehiclesSummary } from './factories/garage';
import { authUser } from './factories/auth';
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
 * Mounting a portal section and reading what it asked the API — the common ground of the stage 5
 * request measurements (plan §6): the first screen, saved filters, the phone, a tab switch, a return
 * to the browser tab and the freshness of a dictionary all mount the same pages over the same
 * answers, so a difference between two measurements is the state measured, not the fixture.
 *
 * Responses are minimal but not empty where emptiness would hide a request: the garage asks for
 * maintenance and parts snapshots of the visible page, and an empty page would drop both. No
 * first-screen composition depends on dictionary content today (the same lists come out with every
 * dictionary empty), so dictionaries answer with one entry or none — except where a measurement
 * restores a saved filter: its value has to be among the options, or the screen prunes it and asks
 * the list a second time (`usePruneMissingFilters`).
 */

/*
 * Sites carry their waste operators: the sites tab of Directories renders them in a column, and a
 * site without the field would throw there and leave the tab to the error boundary — measured as
 * a screen that asked nothing more, not as the screen the user sees.
 */
export const NORTH = objectDto({ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный', operators: [] });
export const SOUTH = objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный', operators: [] });
export const LESSOR = operator({ id: 'cp-lessor', name: 'СтройАренда', type: 'mech_lessor' });
const COUNTERPARTIES = [operator(), LESSOR, operator({ ...SERVICE_COUNTERPARTY, type: 'service' })];

/** Every route a measured section may ask on its first screen; a test asserts which it did. */
export function sectionRoutes(user: AuthUser): RouteMap {
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

/**
 * What the shell asks on its own: the release notes for everyone (ADR 0077) and the two office
 * equipment badges for those with a step in a request (ADR 0085, ADR 0141). The registration
 * badge (`/users/pending-count`) is among the section routes: Administration asks it too.
 */
const SHELL_ROUTES: RouteMap = {
  'GET /releases': () => json([]),
  'GET /service-requests/waiting-count': () => json({ count: 0 }),
  'GET /service-requests/unread-count': () => json({ count: 0 }),
};

/**
 * Tabs a measurement visits after the first screen. They answer empty: a tab switch and a return
 * to the browser tab refetch what is mounted, and none of these tabs asks more for a row it shows.
 */
export const VISITED_TAB_ROUTES: RouteMap = {
  'GET /waste-requests/present': () => json(emptyList()),
  'GET /vehicle-requests/on-site': () => json({ ...emptyList(), onDate: '2026-10-06' }),
  'GET /vehicle-requests/on-site/summary': () =>
    json({
      total: 0,
      objects: 0,
      arrivedToday: 0,
      leavingToday: 0,
      earlyEndPending: 0,
      shiftsPending: 0,
    }),
  'GET /service-requests/warranties': () => json(emptyList()),
  'GET /office-equipment-consumables': () => json(emptyList()),
  'GET /office-equipment-models': () => json(emptyList()),
  'GET /garage/drivers': ({ query }) => json({ ...emptyList(), onDate: query.get('on') ?? '' }),
  'GET /garage/drivers/summary': ({ query }) =>
    json({ total: 0, free: 0, assigned: 0, documentsIncomplete: 0, onDate: query.get('on') ?? '' }),
};

/** The section's address comes from the shell registry, the only owner of section paths. */
export function sectionPath(id: PortalShellSectionId): string {
  const section = SHELL_SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`no shell section «${id}»`);
  return section.path;
}

export interface MountSectionOptions {
  /** Device mode (ADR 0030); desktop by default. */
  viewport?: Viewport;
  queryClient?: QueryClient;
  /** Routes beyond the first screen — neighbour tabs, the shell — or answers replacing its own. */
  routes?: RouteMap;
  /** Query string of the section address, with `?`: the tab a link opens. */
  search?: string;
  /**
   * Mount the portal shell around the page. A measurement that clears more than the section's own
   * cache (the whole cache, or a root the shell badges share) needs it: those badges are refetched
   * with the page, and leaving the shell out would undercount exactly what the clearing costs.
   */
  shell?: boolean;
}

/** Mounts the section page cold, the way the router mounts it: its lazy entry under `AsyncContent`. */
export function mountSection(
  page: ReactNode,
  section: PortalShellSectionId,
  user: AuthUser,
  options: MountSectionOptions = {},
): ReturnType<typeof renderWithUser> & { http: HttpMock } {
  const http = mockHttp({
    ...sectionRoutes(user),
    ...(options.shell ? SHELL_ROUTES : {}),
    ...options.routes,
  });
  const path = sectionPath(section);
  const body = <AsyncContent>{page}</AsyncContent>;
  const result = renderWithUser(
    options.shell ? (
      <Routes>
        <Route element={<AppLayout />}>
          <Route path={path} element={body} />
        </Route>
      </Routes>
    ) : (
      body
    ),
    {
      user,
      route: `${path}${options.search ?? ''}`,
      viewport: options.viewport,
      queryClient: options.queryClient,
    },
  );
  return { ...result, http };
}

/** Requests logged from index `from` up to `to` (the end by default), sorted by method and path. */
export function requestsSince(http: HttpMock, from = 0, to?: number): string[] {
  return http.calls
    .slice(from, to)
    .map((call) => `${call.method} ${call.path}`)
    .sort();
}

/** Mounts the section page cold and returns what it asked, once the screen is quiet. */
export async function firstScreen(
  page: ReactNode,
  section: PortalShellSectionId,
  user: AuthUser,
  options: MountSectionOptions = {},
): Promise<string[]> {
  const { http, queryClient } = mountSection(page, section, user, options);
  await settle(queryClient);
  return requestsSince(http);
}

/**
 * A section with tabs, the role that opens it and the two tabs a measurement walks between: the
 * first tab of that role and its neighbour. Roles are those of the first-screen table (§1).
 */
export interface TabbedSection {
  title: string;
  page: ReactNode;
  section: PortalShellSectionId;
  user: AuthUser;
  first: string;
  neighbour: string | null;
}

export const TABBED_SECTIONS: readonly TabbedSection[] = [
  {
    title: 'Вывоз мусора, диспетчер (№1)',
    page: <WasteRequestsPage />,
    section: 'waste',
    user: authUser(),
    first: 'Заявки',
    neighbour: 'На объекте',
  },
  {
    title: 'Заказ ТС, диспетчер (№3)',
    page: <VehicleRequestsPage />,
    section: 'vehicle-requests',
    user: authUser(),
    first: 'Заказ автотехники',
    neighbour: 'На объекте',
  },
  {
    title: 'Механизация, диспетчер (№7)',
    page: <MechRequestsPage />,
    section: 'mechanization',
    user: authUser(),
    first: 'Заявки',
    neighbour: 'В аренде',
  },
  {
    title: 'Орг.техника, ИТ-служба (№8)',
    page: <ServiceRequestsPage />,
    section: 'office-equipment',
    user: serviceInHouseExecutor(),
    first: 'Заявки',
    neighbour: 'Гарантии',
  },
  {
    title: 'Орг.техника, диспетчер (№9)',
    page: <ServiceRequestsPage />,
    section: 'office-equipment',
    user: authUser(),
    first: 'Техника',
    neighbour: 'Расходники',
  },
  {
    title: 'Гараж, диспетчер (№6)',
    page: <GaragePage />,
    section: 'garage',
    user: authUser(),
    first: 'Техника',
    neighbour: 'Водители',
  },
  {
    title: 'Справочники, directories.write (№10)',
    page: <DirectoriesPage />,
    section: 'directories',
    user: authUser(),
    first: 'Объекты',
    neighbour: 'Отделы',
  },
  {
    // Without `directories.write` the equipment tab is the only one: there is nothing to switch to.
    title: 'Справочники, только officeEquipment.write (№11)',
    page: <DirectoriesPage />,
    section: 'directories',
    user: serviceOperator(),
    first: 'Оргтехника',
    neighbour: null,
  },
  {
    title: 'Администрирование, администратор (№12)',
    page: <AdministrationPage />,
    section: 'admin',
    user: authUser({ role: 'admin' }),
    first: 'Пользователи',
    neighbour: 'Права',
  },
];

/**
 * Opens a tab of the section the way a user does and waits until the screen is quiet. The tab is
 * found by its text within the tab role, not by a role query: with the shell and several tabs
 * mounted, computing accessible names over the whole document takes seconds per call.
 */
export async function switchTab(queryClient: QueryClient, name: string): Promise<void> {
  fireEvent.click(screen.getByText(name, { selector: '[role="tab"]' }));
  await settle(queryClient);
}

/** Labels of the section's tabs, in strip order. */
export function tabLabels(): string[] {
  return [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? '');
}
