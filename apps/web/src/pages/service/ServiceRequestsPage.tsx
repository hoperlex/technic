import { lazy } from 'react';
import { useSearchParams } from 'react-router';
import { serviceRequestKeys } from '@entities/service-request';
import { useAuth } from '@entities/session';
import { PageTabs } from '@shared/ui';
import { canSeeArchiveTab } from '@entities/request';

const RequestsTab = lazy(() =>
  import('./RequestsTab').then((module) => ({ default: module.RequestsTab })),
);
const WarrantiesTab = lazy(() =>
  import('./WarrantiesTab').then((module) => ({ default: module.WarrantiesTab })),
);
const ServiceArchiveTab = lazy(() =>
  import('./ArchiveTab').then((module) => ({ default: module.ServiceArchiveTab })),
);
const EquipmentTab = lazy(() =>
  import('./EquipmentTab').then((module) => ({ default: module.EquipmentTab })),
);
const ConsumablesTab = lazy(() =>
  import('./ConsumablesTab').then((module) => ({ default: module.ConsumablesTab })),
);

/**
 * Office equipment (ADR 0085): service requests and the equipment fleet.
 *
 * Two independent grants open the section (office-equipment-mail-and-history-plan.md, R72):
 * serviceRequests.read for request work and officeEquipment.read for equipment management.
 * Managers and dispatchers have the latter but not the former; a request-only route gate would
 * leave their equipment tab behind a closed door.
 *
 * Tabs answer different questions: current repairs, warranty coverage, history, equipment
 * locations and stock needs. Each checks its own grant: a service contractor may read requests
 * but not the fleet, since request snapshots already provide the equipment facts it needs (R7).
 *
 * Creation, editing and archiving remain in Directories; this section is for operation. The
 * consumables tab likewise uses officeEquipment.read (consumables/purchase plan, R14) but does
 * not create, edit or delete nomenclature: those actions stay in Directories → Office equipment
 * → Cartridges and toners.
 *
 * This page owns its tab list. The section registry (ADR 0121) names portal sections, not their
 * internal composition; copying these tabs into it would create a second owner.
 */
const TABS = ['requests', 'warranties', 'archive', 'equipment', 'consumables'] as const;

export function ServiceRequestsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();

  const canRequests = can('serviceRequests.read');
  const canEquipment = can('officeEquipment.read');
  // Share the archive predicate with links, or a link could target a tab the user cannot see.
  const showArchive = canRequests && canSeeArchiveTab(can);

  const items = [
    ...(canRequests
      ? [
          { key: 'requests', label: 'Заявки', children: <RequestsTab /> },
          { key: 'warranties', label: 'Гарантии', children: <WarrantiesTab /> },
        ]
      : []),
    ...(showArchive ? [{ key: 'archive', label: 'Архив', children: <ServiceArchiveTab /> }] : []),
    ...(canEquipment ? [{ key: 'equipment', label: 'Техника', children: <EquipmentTab /> }] : []),
    /*
     * Consumables share officeEquipment.read with equipment (R14): the same people manage the
     * fleet and cartridge stock. A separate read grant would expose item names but hide their
     * stock. Planned purchases inside the tab keep their own officeEquipmentPurchases.manage gate.
     */
    ...(canEquipment
      ? [{ key: 'consumables', label: 'Расходники', children: <ConsumablesTab /> }]
      : []),
  ];

  const raw = sp.get('tab') ?? '';
  /**
   * An unavailable tab falls back to the first accessible one, not a fixed Requests key: saved
   * URLs survive role changes, and request-denied users would otherwise get an empty screen
   * full of rejected API calls.
   */
  const tab =
    (TABS as readonly string[]).includes(raw) && items.some((i) => i.key === raw)
      ? raw
      : (items[0]?.key ?? 'requests');

  return (
    <div style={{ height: '100%' }}>
      <PageTabs
        activeKey={tab}
        onChange={(k) => setSp({ tab: k })}
        refreshQueryKey={serviceRequestKeys.root}
        items={items}
      />
    </div>
  );
}
