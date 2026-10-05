import { lazy } from 'react';
import { AsyncTabs } from '@shared/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '@entities/session';

const ObjectsTab = lazy(() =>
  import('./ObjectsTab').then((module) => ({ default: module.ObjectsTab })),
);
const DepartmentsTab = lazy(() =>
  import('./DepartmentsTab').then((module) => ({ default: module.DepartmentsTab })),
);
const CounterpartiesTab = lazy(() =>
  import('./CounterpartiesTab').then((module) => ({ default: module.CounterpartiesTab })),
);
const WarehousesTab = lazy(() =>
  import('./WarehousesTab').then((module) => ({ default: module.WarehousesTab })),
);
const MechModelsTab = lazy(() =>
  import('./MechModelsTab').then((module) => ({ default: module.MechModelsTab })),
);
const ContainerTypesTab = lazy(() =>
  import('./ContainerTypesTab').then((module) => ({ default: module.ContainerTypesTab })),
);
const WasteTariffsTab = lazy(() =>
  import('./WasteTariffsTab').then((module) => ({ default: module.WasteTariffsTab })),
);
const VehicleTypesTab = lazy(() =>
  import('./VehicleTypesTab').then((module) => ({ default: module.VehicleTypesTab })),
);
const VehicleSpecsTab = lazy(() =>
  import('./VehicleSpecsTab').then((module) => ({ default: module.VehicleSpecsTab })),
);
const VehiclesTab = lazy(() =>
  import('./VehiclesTab').then((module) => ({ default: module.VehiclesTab })),
);
const TrailersTab = lazy(() =>
  import('./TrailersTab').then((module) => ({ default: module.TrailersTab })),
);
const OfficeEquipmentTab = lazy(() =>
  import('./OfficeEquipmentTab').then((module) => ({ default: module.OfficeEquipmentTab })),
);
const DriversTab = lazy(() =>
  import('./DriversTab').then((module) => ({ default: module.DriversTab })),
);

export function DirectoriesPage() {
  // The long tab strip scrolls on phones; compact tabs leave more room. The last tab, Drivers,
  // requires its own permission because its cards contain personal data: directory access alone
  // must not expose it (ADR 0037).
  const isMobile = useIsMobile();
  const { can } = useAuth();
  const qc = useQueryClient();
  /**
   * Switching tabs means "show it as it is now": hidden tabs stay mounted and would otherwise
   * show cache from before work on a neighbour. Directories reference each other, and the server
   * embeds neighbouring fields in lists: vehicle type/category names and tariff container volumes.
   * Renaming a type then returning to the vehicle list would leave the old name until reload,
   * not merely for a short polling interval.
   *
   * Invalidate the whole cache, not just the destination root: manually enumerating embedded
   * relationships after every server change would recreate the defect as soon as one is missed.
   * This does not eagerly fetch every directory: active observers refetch, while inactive queries
   * are only marked stale until they are used again.
   */
  const refreshOnSwitch = () => void qc.invalidateQueries();
  /**
   * Two permissions open this section (R7): directories.write exposes all directories, while
   * officeEquipment.write exposes one tab. The main group must therefore stay conditional:
   * an equipment manager without directories.write must not get sites, counterparties and waste
   * tariffs along with printers.
   */
  const canDirectories = can('directories.write');
  /**
   * Office equipment opens for anyone with work to do there, not just the permission that
   * happened to be the first historical condition.
   *
   * Three jobs have different permissions (consumables plan, R10): equipment management uses
   * officeEquipment.write, all directories use directories.write, and consumable nomenclature
   * and stock adjustment have their own permissions. Their cartridge/toner window exists only
   * here; omitting these grants would leave an allowed button inside an inaccessible tab.
   *
   * The tab still has readable data: both consumable grants require officeEquipment.read
   * (grants.ts), and filter sites/departments use directories.read, shared by all roles.
   * Opening the tab does not grant equipment edits: creation, type/model windows and row actions
   * each check officeEquipment.write themselves.
   */
  const canOfficeEquipment =
    can('officeEquipment.write') ||
    canDirectories ||
    can('officeEquipmentConsumables.manage') ||
    can('officeEquipmentConsumables.stock');
  const items = [
    ...(canDirectories
      ? [
          { key: 'objects', label: 'Объекты', children: <ObjectsTab /> },
          // Departments are the second scope axis (ADR 0040), beside construction sites.
          { key: 'departments', label: 'Отделы', children: <DepartmentsTab /> },
          { key: 'counterparties', label: 'Контрагенты', children: <CounterpartiesTab /> },
          // Warehouses follow counterparties: only suppliers own them (ADR 0051), and creation
          // follows the same order, first the counterparty and then its addresses.
          { key: 'warehouses', label: 'Склады', children: <WarehousesTab /> },
          // Small-equipment models (docs/mechanization-models-directory-plan.md) are another
          // simple directory table. Keep them before container types, not between types and
          // tariffs: the two waste-related tabs are read together.
          { key: 'mech-models', label: 'Модели механизации', children: <MechModelsTab /> },
          { key: 'types', label: 'Типы контейнеров', children: <ContainerTypesTab /> },
          // There is no separate waste-types tab (ADR 0017): types are managed in the tariff
          // matrix because a type without a price has no independent use.
          {
            key: 'waste-tariffs',
            label: 'Стоимость вывоза мусора',
            children: <WasteTariffsTab />,
          },
          { key: 'vehicle-types', label: 'Типы ТС', children: <VehicleTypesTab /> },
          { key: 'vehicle-specs', label: 'ТТХ', children: <VehicleSpecsTab /> },
          { key: 'vehicles', label: 'Техника', children: <VehiclesTab /> },
          // Trailers follow vehicles for joint reading, but live in their own table: a trailer
          // is not a vehicle (docs/vehicle-trailers-plan.md, R7).
          { key: 'vehicle-trailers', label: 'Прицепы', children: <TrailersTab /> },
        ]
      : []),
    // Office equipment (ADR 0085) follows vehicles: the same people manage both fleets.
    // It needs its own gate (R7): directories.read belongs to all roles, but these cards also
    // disclose service history, so use the explicit condition above.
    ...(canOfficeEquipment
      ? [{ key: 'office-equipment', label: 'Оргтехника', children: <OfficeEquipmentTab /> }]
      : []),
    ...(can('drivers.read')
      ? [{ key: 'drivers', label: 'Водители', children: <DriversTab /> }]
      : []),
  ];
  return (
    <div style={{ height: '100%' }}>
      <AsyncTabs
        className="full-height-tabs"
        // Pick the first available tab, not a fixed Objects key: a missing key would leave an
        // empty body for users who cannot access sites.
        defaultActiveKey={items[0]?.key}
        onChange={refreshOnSwitch}
        size={isMobile ? 'small' : undefined}
        items={items}
      />
    </div>
  );
}
