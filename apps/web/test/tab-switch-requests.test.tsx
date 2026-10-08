import { describe, expect, it } from 'vitest';
import { settle } from './query';
import {
  TABBED_SECTIONS,
  VISITED_TAB_ROUTES,
  mountSection,
  requestsSince,
  switchTab,
  tabLabels,
  type TabbedSection,
} from './section-requests';

/**
 * What switching a section's tab asks the API — a measurement, not a ban (stage 5 plan, §6; the
 * numbers for Directories and Administration are the price of decision R5, §9).
 *
 * Visited tabs stay mounted, so a switch by itself refetches nothing: every request below comes
 * from the clearing on the switch. Sections on `PageTabs` clear their own root
 * (`refreshQueryKey`); Directories and Administration refresh active reads but exclude shell
 * signals and release notes. Active entries in visited panes refetch at once. The shell is
 * mounted here so an accidental broad invalidation changes this measurement.
 *
 * The walk: the first screen, then the neighbour tab (its first visit: the clearing plus the
 * neighbour's own first screen), then back (both tabs mounted: the clearing alone, the cost of one
 * switch). The neighbours answer empty lists (`VISITED_TAB_ROUTES`).
 *
 * Only these waves change the expected lists: 3а (`PageTabs` stops clearing the SIGNAL badges) and
 * 3б (the clearing of Directories and Administration by R5); the commit says which.
 */

/** One switch there and back, as sorted request lists; `back` is the cost of a switch. */
const EXPECTED: Record<string, { visit: string[]; back: string[] }> = {
  'Вывоз мусора, диспетчер (№1)': {
    visit: ['GET /waste-requests', 'GET /waste-requests/present', 'GET /waste-requests/summary'],
    back: ['GET /waste-requests', 'GET /waste-requests/present', 'GET /waste-requests/summary'],
  },
  'Заказ ТС, диспетчер (№3)': {
    visit: [
      'GET /vehicle-requests/feed',
      'GET /vehicle-requests/on-site',
      'GET /vehicle-requests/on-site/summary',
      'GET /vehicle-requests/summary',
    ],
    back: [
      'GET /vehicle-requests/feed',
      'GET /vehicle-requests/on-site',
      'GET /vehicle-requests/on-site/summary',
      'GET /vehicle-requests/summary',
    ],
  },
  'Механизация, диспетчер (№7)': {
    // The rentals tab reads the same list endpoint with its own parameters.
    visit: ['GET /mech-requests', 'GET /mech-requests', 'GET /mech-requests/summary'],
    back: ['GET /mech-requests', 'GET /mech-requests', 'GET /mech-requests/summary'],
  },
  'Орг.техника, ИТ-служба (№8)': {
    // The two SIGNAL shell badges remain fresh on a section-tab switch (wave 3a1, R2).
    visit: ['GET /service-requests', 'GET /service-requests/warranties'],
    back: ['GET /service-requests', 'GET /service-requests/warranties'],
  },
  'Орг.техника, диспетчер (№9)': {
    // Equipment and consumables live outside the cleared root (`service-requests`): a switch
    // between them costs nothing, and the first visit asks only the neighbour's own data.
    visit: ['GET /office-equipment-consumables', 'GET /office-equipment-models'],
    back: [],
  },
  'Гараж, диспетчер (№6)': {
    // The garage root covers the day slice of both tabs; the maintenance and parts snapshots of
    // the vehicle rows are other roots and stay.
    visit: [
      'GET /garage/drivers',
      'GET /garage/drivers/summary',
      'GET /garage/vehicles',
      'GET /garage/vehicles/summary',
    ],
    back: [
      'GET /garage/drivers',
      'GET /garage/drivers/summary',
      'GET /garage/vehicles',
      'GET /garage/vehicles/summary',
    ],
  },
  'Справочники, directories.write (№10)': {
    // Both visited tabs refresh; the shell's release notes keep their own freshness policy.
    visit: [
      'GET /counterparties',
      'GET /departments',
      'GET /objects',
      'GET /objects',
      'GET /users',
      'GET /users',
    ],
    back: [
      'GET /counterparties',
      'GET /departments',
      'GET /objects',
      'GET /objects',
      'GET /users',
      'GET /users',
    ],
  },
  'Администрирование, администратор (№12)': {
    // Both visited tabs refresh; three shell badges and release notes stay fresh.
    visit: ['GET /counterparties', 'GET /departments', 'GET /objects', 'GET /users', 'GET /users'],
    back: ['GET /counterparties', 'GET /departments', 'GET /objects', 'GET /users', 'GET /users'],
  },
};

async function walk({ page, section, user, first, neighbour }: TabbedSection) {
  const { http, queryClient } = mountSection(page, section, user, {
    shell: true,
    routes: VISITED_TAB_ROUTES,
  });
  await settle(queryClient);
  const opened = http.calls.length;
  await switchTab(queryClient, neighbour!);
  const visited = http.calls.length;
  await switchTab(queryClient, first);
  return { visit: requestsSince(http, opened, visited), back: requestsSince(http, visited) };
}

const SWITCHABLE = TABBED_SECTIONS.filter((section) => section.neighbour !== null);

describe('запросы на смену вкладки раздела', () => {
  it.each(SWITCHABLE)('$title: $first → $neighbour → $first', async (section) => {
    expect(await walk(section)).toEqual(EXPECTED[section.title]);
  });

  it('Справочники, только officeEquipment.write (№11): вкладка одна, менять не на что', async () => {
    const only = TABBED_SECTIONS.find((section) => section.neighbour === null)!;
    const { queryClient } = mountSection(only.page, only.section, only.user, { shell: true });
    await settle(queryClient);
    expect(tabLabels()).toEqual([only.first]);
  });
});
