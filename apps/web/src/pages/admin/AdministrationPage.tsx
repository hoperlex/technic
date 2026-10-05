import { lazy } from 'react';
import { AsyncTabs } from '@shared/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '@entities/session';

const UsersTab = lazy(() => import('./UsersTab').then((module) => ({ default: module.UsersTab })));
const AccessTab = lazy(() =>
  import('./AccessTab').then((module) => ({ default: module.AccessTab })),
);
const MailingsTab = lazy(() =>
  import('./MailingsTab').then((module) => ({ default: module.MailingsTab })),
);
const DirectoryTransferTab = lazy(() =>
  import('./DirectoryTransferTab').then((module) => ({ default: module.DirectoryTransferTab })),
);
const ManualsTab = lazy(() =>
  import('./ManualsTab').then((module) => ({ default: module.ManualsTab })),
);
const ExportsTab = lazy(() =>
  import('./ExportsTab').then((module) => ({ default: module.ExportsTab })),
);

export function AdministrationPage() {
  // Compact phone tabs match directories: at 360 px the regular strip takes height the list needs.
  const isMobile = useIsMobile();
  const { can } = useAuth();
  const qc = useQueryClient();
  /**
   * As in directories, hidden tabs stay mounted and would show stale cache on return. These
   * relationships are direct: grants issued on Users appear in Access, and directory imports
   * change data shown throughout the portal.
   */
  const refreshOnSwitch = () => void qc.invalidateQueries();
  // Gate tabs by permission, not role: notification management and access management need not
  // belong to the same person.
  const items = [
    ...(can('users.manage')
      ? [{ key: 'users', label: 'Пользователи', children: <UsersTab /> }]
      : []),
    // The access display (docs/permissions-tab-plan.md) shares the account-management grant:
    // users issue access next door and inspect its result here. With no actions of its own,
    // the display needs no separate permission.
    ...(can('users.manage') ? [{ key: 'access', label: 'Права', children: <AccessTab /> }] : []),
    ...(can('mailings.read')
      ? [{ key: 'mailings', label: 'Рассылки', children: <MailingsTab /> }]
      : []),
    // File-based directory exchange (ADR 0073) has one owner here, not an action on each
    // directory tab. It also covers directories without tabs: vehicle kinds, models,
    // qualification categories and specification bindings.
    ...(can('directories.export')
      ? [
          {
            key: 'directory-transfer',
            label: 'Обмен справочниками',
            children: <DirectoryTransferTab />,
          },
        ]
      : []),
    // Manual authors need not be administrators (docs/manuals-plan.md): manuals.manage is
    // assignable and independently opens this page through ADMIN_PAGE_PERMISSIONS, the common
    // source for all three entry gates (§3.6).
    ...(can('manuals.manage')
      ? [{ key: 'manuals', label: 'Руководства', children: <ManualsTab /> }]
      : []),
    // Operational exports share one tab (docs/analytics-summary-export-plan.md, R1); its own
    // registry selects the workbook. The two grants are independent and neither belongs to
    // role bundles, so either must open the tab; its registry decides which books are visible.
    // Both belong to ADMIN_PAGE_PERMISSIONS and independently open the section, just like
    // manuals.manage.
    ...(can('vehicleReadings.export') || can('analytics.export')
      ? [{ key: 'exports', label: 'Выгрузки', children: <ExportsTab /> }]
      : []),
  ];
  return (
    <div style={{ height: '100%' }}>
      <AsyncTabs
        className="full-height-tabs"
        size={isMobile ? 'small' : undefined}
        defaultActiveKey={items[0]?.key}
        onChange={refreshOnSwitch}
        items={items}
      />
    </div>
  );
}
