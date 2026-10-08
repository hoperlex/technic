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
 * The price of decision R1 after wave 3a1 profiles (stage 5 plan, §6): how many requests one
 * return to the browser tab would cost if LIVE lists also refetched on focus. The decision whether
 * to enable that is deferred to wave 3c. Dictionaries stay fresh; SIGNAL badges use focus already.
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

async function returnCost({ page, section, user, first, neighbour }: TabbedSection) {
  freezeClock();
  const { http, queryClient } = mountSection(page, section, user, {
    shell: true,
    routes: VISITED_TAB_ROUTES,
    queryClient: focusRefetchingClient(),
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
const EXPECTED: Record<string, string[]> = {
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

afterEach(() => {
  // Unmount first: handing focus back to the document would otherwise refetch the mounted screen.
  cleanup();
  focusManager.setFocused(undefined);
  restoreClock();
});

describe('цена Р1: запросов на возврат во вкладку после профилей 3а1', () => {
  it.each(TABBED_SECTIONS)('$title', async (section) => {
    expect(await returnCost(section)).toEqual(EXPECTED[section.title]);
  });
});
