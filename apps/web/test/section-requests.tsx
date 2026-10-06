import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import type { QueryClient } from '@tanstack/react-query';
import { type AuthUser, type PortalShellSectionId, SHELL_SECTIONS } from '@technic/contracts';
import { AsyncContent } from '@shared/ui';
import { AppLayout } from '../src/app/layout';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { settle } from './query';
import type { Viewport } from './viewport';
import { emptyList, list } from './factories/common';
import { garageVehicle, garageVehicleList, garageVehiclesSummary } from './factories/garage';
import { account } from './factories/grants';
import { mechRequest, mechSummary } from './factories/mech';
import { officeEquipmentUnit } from './factories/officeEquipment';
import { SERVICE_COUNTERPARTY, serviceRequest } from './factories/service';
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

export const NORTH = objectDto({ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' });
export const SOUTH = objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' });
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
  const http = mockHttp({ ...sectionRoutes(user), ...options.routes });
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

/** Requests logged since `from` (an index into the log), sorted by method and path. */
export function requestsSince(http: HttpMock, from = 0): string[] {
  return http.calls
    .slice(from)
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
