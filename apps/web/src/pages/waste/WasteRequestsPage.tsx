import { lazy } from 'react';
import { useSearchParams } from 'react-router';
import { roleScopeAxis } from '@technic/contracts';
import { useAuth } from '@entities/session';
import { wasteRequestKeys } from '@entities/waste-request';
import { TicketAuditModal } from '@features/ticket-audit';
import { BlindCheckQueue } from '@features/waste-ticket-review';
import { PageTabs } from '@shared/ui';

const WasteRequestsTab = lazy(() =>
  import('./WasteRequestsTab').then((module) => ({ default: module.WasteRequestsTab })),
);
const OnSiteTab = lazy(() =>
  import('./OnSiteTab').then((module) => ({ default: module.OnSiteTab })),
);
const WasteArchiveTab = lazy(() =>
  import('./WasteArchiveTab').then((module) => ({ default: module.WasteArchiveTab })),
);
const WasteHistoryTab = lazy(() =>
  import('./WasteHistoryTab').then((module) => ({ default: module.WasteHistoryTab })),
);
const WasteStatsTab = lazy(() =>
  import('./WasteStatsTab').then((module) => ({ default: module.WasteStatsTab })),
);

// The tab lives in the URL, not in state: links from neighbouring sections (the install request
// number in the sites list) arrive with a ready answer which tab to show and what to open on it.
const TABS = ['requests', 'on-site', 'history', 'blind-check', 'archive', 'stats'] as const;

/** Route-level owner: tabs, URL selection and permission-gated tab composition. */
export function WasteRequestsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { can, user } = useAuth();
  // Recognition audit (ADR 0137) is a modal over the registry, not a tab: the permission is strong
  // and rare. It is mounted here, above the tabs, because a ?ticketAudit=1 link may arrive on any
  // tab; mounted inside one tab it would open only when that tab happened to be active.
  const canAuditTickets = can('wasteRequests.ticketAudit');
  // The stats tab (ADR 0193) shares the list permission but has a narrower audience: counterparty
  // executors and person-scoped accounts get no answer, because a summary of other sites is not
  // theirs to read. The check asks the role scope axis with the same predicate the server uses
  // (assertWasteStatsAudience in apps/api/src/services/waste-stats.ts); if the two drifted apart,
  // the tab would lead straight into a 403.
  const statsAxis = roleScopeAxis(user?.role ?? null);
  const items = [
    { key: 'requests', label: 'Заявки', children: <WasteRequestsTab /> },
    { key: 'on-site', label: 'На объекте', children: <OnSiteTab /> },
    // History (ADR 0135) lists done and cancelled requests and is open to everyone who sees the
    // module: a closed request carries the same information as a working one, and the server
    // narrows the result with the same scope as the working list.
    { key: 'history', label: 'История', children: <WasteHistoryTab /> },
    // Blind re-check is a second person's work (ADR 0114, R31): they read the ticket without seeing
    // the recognized or confirmed values. It is a tab rather than a section because the scope and
    // the permission are the same as ticket review.
    ...(can('wasteRequests.ticketReview')
      ? [{ key: 'blind-check', label: 'Перепроверка', children: <BlindCheckQueue /> }]
      : []),
    // The archive holds deleted requests (ADR 0070). It is gated by the archive.read permission,
    // never by a role name: the server closes the archive listing with the same permission, and a
    // role-based check would either lead to an empty list or hide an archive the user may read.
    ...(can('archive.read')
      ? [{ key: 'archive', label: 'Архив', children: <WasteArchiveTab /> }]
      : []),
    // Stats stay last: the first tabs are the daily request work people come here for, and a tab
    // inserted in the middle would shift familiar positions instead of extending the strip.
    ...(statsAxis !== 'counterparty' && statsAxis !== 'person'
      ? [{ key: 'stats', label: 'Статистика', children: <WasteStatsTab /> }]
      : []),
  ];
  const rawTab = searchParams.get('tab') ?? '';
  // A link to a hidden tab falls back to the registry instead of an empty page, so saved URLs
  // survive a role change.
  const activeTab =
    (TABS as readonly string[]).includes(rawTab) && items.some((item) => item.key === rawTab)
      ? rawTab
      : 'requests';

  return (
    <div style={{ height: '100%' }}>
      <TicketAuditModal allowed={canAuditTickets} />
      <PageTabs
        activeKey={activeTab}
        // Manual tab selection intentionally drops card deep-link parameters: the URL keeps only
        // tab, and the open parameter of a card opened by link goes away with the switch.
        onChange={(tab) => setSearchParams({ tab })}
        refreshQueryKey={wasteRequestKeys.root}
        items={items}
      />
    </div>
  );
}
