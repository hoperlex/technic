import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { focusManager, type QueryClient } from '@tanstack/react-query';
import { createTestQueryClient } from './render';
import { advanceClock, freezeClock, restoreClock, settle } from './query';
import {
  TABBED_SECTIONS,
  VISITED_TAB_ROUTES,
  mountSection,
  requestsSince,
  switchTab,
  type TabbedSection,
} from './section-requests';

/**
 * The price of decision R1 after the stage 5 profiles (plan §6): one browser-tab return with
 * visited panes still mounted. The current policy refetches SIGNAL; the proposed policy also
 * refetches LIVE. Dictionaries keep their own freshness term in either case.
 */

const AWAY_MS = 2 * 60_000;

function focusRefetchingClient(): QueryClient {
  const client = createTestQueryClient();
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, refetchOnWindowFocus: true },
  });
  return client;
}

/** Leaving the browser tab and coming back, as the library hears it. */
async function returnToBrowserTab(queryClient: QueryClient): Promise<void> {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle(queryClient);
}

async function returnCost(
  { page, section, user, first, neighbour }: TabbedSection,
  focusLive = true,
) {
  freezeClock();
  const { http, queryClient } = mountSection(page, section, user, {
    shell: true,
    routes: VISITED_TAB_ROUTES,
    queryClient: focusLive ? focusRefetchingClient() : createTestQueryClient(),
  });
  await settle(queryClient);
  if (neighbour) {
    await switchTab(queryClient, neighbour);
    await switchTab(queryClient, first);
  }
  advanceClock(AWAY_MS);
  const left = http.calls.length;
  await returnToBrowserTab(queryClient);
  return requestsSince(http, left);
}

/** One return with visited tabs mounted; dictionaries do not refetch on focus. */
const WITH_LIVE_FOCUS: Record<string, string[]> = {
  'Вывоз мусора, диспетчер (№1)': [
    'GET /waste-requests',
    'GET /waste-requests/present',
    'GET /waste-requests/summary',
    'GET /waste-requests/ticket-recognition/health',
  ],
  'Заказ ТС, диспетчер (№3)': [
    'GET /vehicle-requests/feed',
    'GET /vehicle-requests/on-site',
    'GET /vehicle-requests/on-site/summary',
    'GET /vehicle-requests/summary',
  ],
  'Механизация, диспетчер (№7)': [
    'GET /mech-requests',
    'GET /mech-requests',
    'GET /mech-requests/summary',
  ],
  'Орг.техника, ИТ-служба (№8)': [
    'GET /service-requests',
    'GET /service-requests/unread-count',
    'GET /service-requests/waiting-count',
    'GET /service-requests/warranties',
  ],
  'Орг.техника, диспетчер (№9)': ['GET /office-equipment', 'GET /office-equipment-consumables'],
  'Гараж, диспетчер (№6)': [
    'GET /auto-part-receipts/vehicles/snapshot',
    'GET /garage/drivers',
    'GET /garage/drivers/summary',
    'GET /garage/vehicles',
    'GET /garage/vehicles/summary',
    'GET /vehicle-maintenance/snapshot',
  ],
  'Справочники, directories.write (№10)': ['GET /departments', 'GET /objects'],
  'Справочники, только officeEquipment.write (№11)': [
    'GET /office-equipment',
    'GET /service-requests/unread-count',
    'GET /service-requests/waiting-count',
  ],
  'Администрирование, администратор (№12)': [
    'GET /service-requests/unread-count',
    'GET /service-requests/waiting-count',
    'GET /users',
    'GET /users/pending-count',
  ],
};

const CURRENT: Record<string, string[]> = {
  'Вывоз мусора, диспетчер (№1)': [],
  'Заказ ТС, диспетчер (№3)': [],
  'Механизация, диспетчер (№7)': [],
  'Орг.техника, ИТ-служба (№8)': [
    'GET /service-requests/unread-count',
    'GET /service-requests/waiting-count',
  ],
  'Орг.техника, диспетчер (№9)': [],
  'Гараж, диспетчер (№6)': [],
  'Справочники, directories.write (№10)': [],
  'Справочники, только officeEquipment.write (№11)': [
    'GET /service-requests/unread-count',
    'GET /service-requests/waiting-count',
  ],
  'Администрирование, администратор (№12)': [
    'GET /service-requests/unread-count',
    'GET /service-requests/waiting-count',
    'GET /users/pending-count',
  ],
};

afterEach(() => {
  // Unmount first: handing focus back to the document would otherwise refetch the mounted screen.
  cleanup();
  focusManager.setFocused(undefined);
  restoreClock();
});

describe('R1 browser-tab return request cost after query profiles', () => {
  it.each(TABBED_SECTIONS)('current $title', async (section) => {
    expect(await returnCost(section, false)).toEqual(CURRENT[section.title]);
  });

  it.each(TABBED_SECTIONS)('with LIVE focus $title', async (section) => {
    expect(await returnCost(section, true)).toEqual(WITH_LIVE_FOCUS[section.title]);
  });
});
