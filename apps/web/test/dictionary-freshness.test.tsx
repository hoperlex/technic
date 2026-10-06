import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { Link, Route, Routes } from 'react-router';
import type { AuthUser } from '@technic/contracts';
import { AsyncContent } from '@shared/ui';
import { objectKeys } from '@entities/object';
import { DirectoriesPage } from '../src/pages/directories';
import { WasteRequestsPage } from '../src/pages/waste';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { advanceClock, cachedGcTime, freezeClock, restoreClock, settle } from './query';
import { NORTH, sectionPath, sectionRoutes } from './section-requests';
import { shtabUser } from './factories/auth';

/**
 * Freshness of a dictionary that stays on a first screen — a measurement, not a ban (stage 5 plan,
 * §6 "dictionary freshness scenario", criterion 2 of §8).
 *
 * The role is the site staff of Waste (first-screen row №2): the sites dictionary stays on that
 * screen after the dictionaries are deferred (appendix A1), because the locked site filter shows
 * the site's name. The user opens Waste, goes to another section and comes back after a pause; the
 * measurement is how many times the sites dictionary is asked on the way back. A mutation of the
 * sites directory in between has to be seen at once, whatever the freshness term.
 *
 * Only wave 3а changes this file, and only `EXPECTED`: today the sites dictionary is LIVE (stale
 * after 10 s, unobserved data kept 5 min), the DICTIONARY profile of the plan keeps it 30 min
 * (R3.1) and its unobserved entry 35 min. The scenario itself stays as it is.
 */
const EXPECTED = {
  /** Requests of the sites dictionary on the return to Waste, by the pause spent elsewhere. */
  returnAfter: [
    // A control: data younger than any term is reused under every profile.
    { pause: '1 с', ms: 1_000, requests: 0 },
    { pause: '11 с', ms: 11_000, requests: 1 },
    { pause: '6 мин', ms: 6 * 60_000, requests: 1 },
    { pause: '30 мин − 1 с', ms: 30 * 60_000 - 1_000, requests: 1 },
    { pause: '30 мин + 1 с', ms: 30 * 60_000 + 1_000, requests: 1 },
  ],
  /**
   * How long the unobserved sites entry stays in the cache. Faking the clock cannot show this — the
   * entry is dropped by a timer of the library — so the entry's own term is read instead (§6).
   * Today the client default: past 5 min the return above is a cold load, not a refetch.
   */
  gcTime: 5 * 60_000,
  /** Requests on the return right after the user's own sites mutation: one, under any profile. */
  afterMutation: 1,
};

/** The site's dictionary key on the Waste first screen: active sites. */
const SITES_KEY = objectKeys.options({ activeOnly: true });

/**
 * Three sections behind links, as the menu leads between them: Waste, a section that reads no
 * sites, and Directories, where a site is edited.
 */
function Portal() {
  return (
    <>
      <nav>
        <Link to={sectionPath('waste')}>Вывоз мусора</Link>
        <Link to="/elsewhere">Другой раздел</Link>
        <Link to={sectionPath('directories')}>Справочники</Link>
      </nav>
      <Routes>
        <Route
          path={sectionPath('waste')}
          element={
            <AsyncContent>
              <WasteRequestsPage />
            </AsyncContent>
          }
        />
        <Route path="/elsewhere" element={<p>Раздел без справочника объектов</p>} />
        <Route
          path={sectionPath('directories')}
          element={
            <AsyncContent>
              <DirectoriesPage />
            </AsyncContent>
          }
        />
      </Routes>
    </>
  );
}

function openPortal(user: AuthUser) {
  const http = mockHttp({
    ...sectionRoutes(user),
    'DELETE /objects/:id': () => json({ ...NORTH, isActive: false }),
  });
  const { queryClient } = renderWithUser(<Portal />, { user, route: sectionPath('waste') });
  const go = async (section: string) => {
    fireEvent.click(screen.getByText(section, { selector: 'a' }));
    await settle(queryClient);
  };
  return { http, queryClient, go };
}

/** Requests of the sites dictionary logged since `from`. */
function sitesAskedSince(http: HttpMock, from: number): number {
  return http.calls.slice(from).filter((call) => call.method === 'GET' && call.path === '/objects')
    .length;
}

afterEach(() => {
  restoreClock();
});

describe('свежесть справочника объектов у штаба вывоза', () => {
  it.each(EXPECTED.returnAfter)(
    'возврат в Вывоз через $pause — запросов объектов: $requests',
    async ({ ms, requests }) => {
      freezeClock();
      const { http, queryClient, go } = openPortal(shtabUser('obj-1'));
      await settle(queryClient);
      expect(sitesAskedSince(http, 0)).toBe(1);

      await go('Другой раздел');
      expect(cachedGcTime(queryClient, SITES_KEY)).toBe(EXPECTED.gcTime);
      advanceClock(ms);
      const returned = http.calls.length;
      await go('Вывоз мусора');

      expect(sitesAskedSince(http, returned)).toBe(requests);
    },
  );

  it('своя деактивация объекта видна при возврате сразу, без ожидания срока', async () => {
    freezeClock();
    // A site staff member who also keeps the sites directory: one person for both ends.
    const user = shtabUser('obj-1', { grantPermissions: ['directories.write'] });
    const { http, queryClient, go } = openPortal(user);
    await settle(queryClient);

    await go('Справочники');
    // Deactivation is the lightest site mutation to drive; every one of them clears the same root.
    const row = (await screen.findByText(NORTH.name)).closest('tr')!;
    // By label and text, not by role: a role query checks visibility through computed styles, and
    // with the portal's style sheets in the document one such query took a minute.
    fireEvent.click(within(row).getByLabelText('delete'));
    fireEvent.click(await screen.findByText('Деактивировать'));
    await settle(queryClient);
    expect(http.countOf('DELETE /objects/:id')).toBe(1);

    advanceClock(1_000);
    const returned = http.calls.length;
    await go('Вывоз мусора');

    expect(sitesAskedSince(http, returned)).toBe(EXPECTED.afterMutation);
  });
});
