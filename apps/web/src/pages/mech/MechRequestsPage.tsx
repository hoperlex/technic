import { lazy } from 'react';
import { useSearchParams } from 'react-router';
import { isMechLessorSubject } from '@technic/contracts';
import { mechRequestKeys } from '@entities/mech-request';
import { useAuth } from '@entities/session';
import { AsyncContent, PageTabs } from '@shared/ui';
import { canSeeArchiveTab } from '@entities/request';
import { RequestsTab } from './RequestsTab';
import { RentalsTab } from './RentalsTab';
import { HistoryTab } from './HistoryTab';
import { MechArchiveTab } from './ArchiveTab';

/**
 * The lessor's page, in a chunk of its own: an office account never downloads it, and the office's
 * route chunk carries only this loader (lessor receipt plan, W4).
 */
const MechLessorRentalsPage = lazy(() =>
  import('./lessor/MechLessorRentalsPage').then((module) => ({
    default: module.MechLessorRentalsPage,
  })),
);

/**
 * The «Механизация» section (plan `docs/mechanization-module-plan.md`): rentals of plate
 * compactors, compressors, generators and heaters — everything that stands on a site for weeks and
 * costs money every day.
 *
 * Two pages behind one section, chosen by the account. A mechanization lessor (lessor receipt plan,
 * P12) gets his own list of rentals «В работе» and NEVER the office tabs: each of them calls doors
 * that answer him 403 (P11), and mounting one would greet him with an error instead of his work.
 * Everyone else gets the tabs.
 *
 * The right to the section itself is checked by the route (`RequireSection` by the registry row):
 * mechanization has one, `mechRequests.read`, and the scope matters here too. A department with no
 * sites attached does not see the section at all (R10): it has nowhere to rent to. For a lessor it
 * is the only section, hence his start page.
 */
export function MechRequestsPage() {
  const { user } = useAuth();
  if (isMechLessorSubject(user)) {
    return (
      <AsyncContent>
        <MechLessorRentalsPage />
      </AsyncContent>
    );
  }
  return <MechOfficeTabs />;
}

/**
 * Four tabs: «Заявки» — what is being run, «В аренде» — what stands on the sites right now
 * (presence by the R2 predicate), «История» — what is closed, with totals over the filter (E3), and
 * «Архив» — what was deleted.
 *
 * The order of the tabs is the order of the questions to the section: first «what to take into
 * work», then «what to return and extend», then «what did it cost us», and last the review of the
 * deleted. «В аренде» is second, not first, although it is opened more often: the first one greets
 * with the place where a request is filed — otherwise a site that came to order a plate compactor
 * would land on someone else's list without «Заказать технику». «История» follows it, not next to
 * «Архив»: a closed request is work done, the archive is the trace of a mistake, and putting them
 * side by side would pile them together.
 *
 * THE TAB LIST LIVES HERE, not in the section registry: the registry (ADR 0121) answers «which
 * sections the portal has», and what a section consists of is the section's own business.
 */
const TABS = ['requests', 'rentals', 'history', 'archive'] as const;

function MechOfficeTabs() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();

  // The archive is asked the same way as by the link (`utils/links`): were the two to differ, the
  // link would lead to a tab the role does not have.
  const showArchive = canSeeArchiveTab(can);

  const items = [
    { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
    // «В аренде» is visible to whoever sees the section: presence has no right of its own — it is
    // the same request list cut by a predicate, and the viewer's scope narrows it by the same
    // barrier.
    { key: 'rentals', label: 'В аренде', children: <RentalsTab /> },
    // «История» has no right of its own either: the same requests cut by the closed statuses, and
    // the viewer's scope narrows the journal by the same barrier as the list.
    { key: 'history', label: 'История', children: <HistoryTab /> },
    ...(showArchive ? [{ key: 'archive', label: 'Архив', children: <MechArchiveTab /> }] : []),
  ];

  /**
   * A link to an unavailable tab leads to the first available one, not to a hard-wired «Заявки»:
   * the address survives a change of role. Addresses of tabs the role does not have land here too:
   * a link to the archive opens the list, not an empty screen.
   */
  const raw = sp.get('tab') ?? '';
  const tab =
    (TABS as readonly string[]).includes(raw) && items.some((i) => i.key === raw)
      ? raw
      : (items[0]?.key ?? 'requests');

  return (
    <div style={{ height: '100%' }}>
      <PageTabs
        activeKey={tab}
        onChange={(k) => setSp({ tab: k })}
        refreshQueryKey={mechRequestKeys.root}
        items={items}
      />
    </div>
  );
}
