import { lazy } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { canOrderVehicleRequestType } from '@technic/contracts';
import { vehicleRequestKeys } from '@entities/vehicle-request';
import { useAuth } from '@entities/session';
import { PageTabs } from '@shared/ui';
import { canSeeArchiveTab } from '@entities/request';
import { VehicleRequestsHistoryTab } from './VehicleRequestsHistoryTab';

const VehicleRequestsTab = lazy(() =>
  import('./VehicleRequestsTab').then((module) => ({ default: module.VehicleRequestsTab })),
);
const VehicleRequestsOnSiteTab = lazy(() =>
  import('./VehicleRequestsOnSiteTab').then((module) => ({
    default: module.VehicleRequestsOnSiteTab,
  })),
);
const VehicleRequestsArchiveTab = lazy(() =>
  import('./VehicleRequestsArchiveTab').then((module) => ({
    default: module.VehicleRequestsArchiveTab,
  })),
);

// Special equipment, freight and weekly requests share one list: document kind is a column and
// filter, not a separate tab. Legacy tab keys redirect to that common list.
const TABS = ['requests', 'on-site', 'history', 'archive'] as const;

export function VehicleRequestsPage() {
  const { user, can } = useAuth();
  const [sp, setSp] = useSearchParams();

  /**
   * The old weekly-tab URL (?tab=weekly) opens the common list filtered to weekly requests.
   * Bookmarks and the weekly page's Back link still use it; silently showing all kinds would
   * look as if weekly requests had disappeared.
   *
   * Redirect during render, not in an effect: the list reads the kind from the URL only when
   * initializing filters. Mounting before the rewrite would permanently initialize all kinds.
   *
   * Replace history so Back returns to the previous screen, not the legacy URL just redirected.
   */
  if (sp.get('tab') === 'weekly') {
    return <Navigate to="/vehicle-requests?tab=requests&kind=weekly" replace />;
  }

  /**
   * Routes became windows over any portal page (ADR 0120), addressed by route/routes parameters.
   * Legacy tab URLs redirect during render with history replacement, just like weekly URLs.
   *
   * Redirecting is mandatory: old links are already in mailboxes, with waybill summaries linking
   * to the route list and request notices naming a route (?tab=routes&open=<id>). Falling back
   * to the request list would open unrelated work instead of the route named in that email.
   */
  if (sp.get('tab') === 'routes') {
    const openedRoute = sp.get('open');
    return (
      <Navigate
        to={
          openedRoute
            ? `/vehicle-requests?tab=requests&route=${openedRoute}`
            : '/vehicle-requests?tab=requests&routes=1'
        }
        replace
      />
    );
  }

  /**
   * On-site is the special-equipment snapshot (ADR 0036). Users without this request type would
   * always see an empty tab (ADR 0040). Ask the contract's type matrix, not role names, or a local
   * role list could silently drift from ROLE_VEHICLE_REQUEST_TYPES and expose a useless tab.
   */
  const showOnSite = canOrderVehicleRequestType(user, 'special_equipment');

  /**
   * Neighbouring lists link deleted request numbers to Archive. Use the same predicate as those
   * links; separate conditions could send users to an absent tab and an empty screen.
   */
  const showArchive = canSeeArchiveTab(can);

  const items = [
    { key: 'requests', label: 'Заказ автотехники', children: <VehicleRequestsTab /> },
    ...(showOnSite
      ? [{ key: 'on-site', label: 'На объекте', children: <VehicleRequestsOnSiteTab /> }]
      : []),
    { key: 'history', label: 'История', children: <VehicleRequestsHistoryTab /> },
    ...(showArchive
      ? [{ key: 'archive', label: 'Архив', children: <VehicleRequestsArchiveTab /> }]
      : []),
  ];

  const raw = sp.get('tab') ?? '';
  // Saved links survive role changes: an unavailable tab falls back to the list, not an empty body.
  const tab =
    (TABS as readonly string[]).includes(raw) && items.some((i) => i.key === raw)
      ? raw
      : 'requests';

  return (
    <div style={{ height: '100%' }}>
      <PageTabs
        activeKey={tab}
        onChange={(k) => setSp({ tab: k })}
        refreshQueryKey={vehicleRequestKeys.root}
        items={items}
      />
    </div>
  );
}
