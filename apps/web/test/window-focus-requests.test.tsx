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
 * The price of decision R1 (stage 5 plan, §9): how many requests one return to the browser tab
 * would cost if lists refetched on focus — a measurement, not a ban, and a preliminary one. The
 * final number is measured after wave 3а (§6): until the profiles exist, dictionaries refetch on
 * focus too and inflate it.
 *
 * The portal does not refetch on focus (`QUERY_PROFILE.LIVE`); the client here is the production
 * one with that single option turned on, for this measurement only. The section is opened with the
 * shell, its neighbour tab is visited and left, the user is away `AWAY_MS` — longer than every
 * term up to a minute, so LIVE data and the 60-second badges are stale — and comes back.
 *
 * Wave 3в replaces the expected lists with the measurement after the profiles and decides R1.
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

/**
 * One return, as a sorted request list. Everything mounted and stale refetches: both visited tabs,
 * their dictionaries (`/objects`, `/departments`, `/counterparties`, types, models — the inflation
 * wave 3а removes) and the shell badges with their 60-second term; the release notes (30 min) stay.
 */
const EXPECTED: Record<string, string[]> = {
  'Вывоз мусора, диспетчер (№1)': [
    'GET /container-types',
    'GET /counterparties',
    'GET /objects',
    'GET /waste-requests',
    'GET /waste-requests/present',
    'GET /waste-requests/summary',
    'GET /waste-requests/ticket-recognition/health',
    'GET /waste-types',
  ],
  'Заказ ТС, диспетчер (№3)': [
    'GET /departments',
    'GET /objects',
    'GET /vehicle-classifications',
    'GET /vehicle-requests/feed',
    'GET /vehicle-requests/on-site',
    'GET /vehicle-requests/on-site/summary',
    'GET /vehicle-requests/summary',
    'GET /vehicles',
  ],
  'Механизация, диспетчер (№7)': [
    'GET /counterparties',
    'GET /departments',
    'GET /mech-models',
    'GET /mech-requests',
    'GET /mech-requests',
    'GET /mech-requests/summary',
    'GET /objects',
    'GET /objects',
  ],
  'Орг.техника, ИТ-служба (№8)': [
    'GET /counterparties',
    'GET /departments',
    'GET /objects',
    'GET /objects',
    'GET /office-equipment-types',
    'GET /service-requests',
    'GET /service-requests/unread-count',
    'GET /service-requests/waiting-count',
    'GET /service-requests/warranties',
  ],
  'Орг.техника, диспетчер (№9)': [
    'GET /departments',
    'GET /objects',
    'GET /office-equipment',
    'GET /office-equipment-consumables',
    'GET /office-equipment-models',
    'GET /office-equipment-types',
  ],
  'Гараж, диспетчер (№6)': [
    'GET /auto-part-receipts/vehicles/snapshot',
    'GET /garage/drivers',
    'GET /garage/drivers/summary',
    'GET /garage/vehicles',
    'GET /garage/vehicles/summary',
    'GET /objects',
    'GET /vehicle-classifications',
    'GET /vehicle-maintenance/snapshot',
  ],
  'Справочники, directories.write (№10)': [
    'GET /counterparties',
    'GET /departments',
    'GET /objects',
    'GET /objects',
    'GET /users',
    'GET /users',
  ],
  'Справочники, только officeEquipment.write (№11)': [
    'GET /departments',
    'GET /objects',
    'GET /office-equipment',
    'GET /office-equipment-types',
    'GET /service-requests/unread-count',
    'GET /service-requests/waiting-count',
  ],
  'Администрирование, администратор (№12)': [
    'GET /counterparties',
    'GET /departments',
    'GET /objects',
    'GET /service-requests/unread-count',
    'GET /service-requests/waiting-count',
    'GET /users',
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

describe('цена Р1: запросов на один возврат во вкладку браузера (предварительно, до 3а)', () => {
  it.each(TABBED_SECTIONS)('$title', async (section) => {
    expect(await returnCost(section)).toEqual(EXPECTED[section.title]);
  });
});
