import { Button, Space } from 'antd';
import { DashboardOutlined, PlusOutlined } from '@ant-design/icons';
import type { VehicleDto } from '@technic/contracts';
import { useFuelNormDirectory } from '@features/fuel-norm-management';
import { useVehicleMaintenanceAction } from '@features/vehicle-maintenance';
import { DataTable, PageTableLayout, sortOptionsFrom } from '@shared/ui';
import { useVehicleRegistry } from '../model/useVehicleRegistry';
import type { VehicleRegistryActions } from '../model/types';
import { vehicleRegistryCard } from './vehicleRegistryCard';
import { vehicleRegistryColumns } from './vehicleRegistryColumns';

/**
 * Owned vehicles and rental offers share a registry because operators compare them side by side
 * (ADR 0007/0018). Ownership filters also hide inapplicable columns, not just rows: rentals have
 * no registration/model, while owned vehicles have no offer rates.
 */
export function VehicleRegistry(actions: VehicleRegistryActions) {
  const model = useVehicleRegistry();
  // Maintenance uses the same URL-backed feature from both the garage and this registry.
  const maintenance = useVehicleMaintenanceAction();
  // Both entry points share one fuel-norm modal and therefore one selected vehicle target.
  const fuelNorms = useFuelNormDirectory();

  const columns = vehicleRegistryColumns({
    ownershipFilter: model.ownershipFilter,
    showOwnColumns: model.showOwnColumns,
    showRentalColumns: model.showRentalColumns,
    canRestore: actions.canRestore,
    restore: actions.restore,
    purge: actions.purge,
    maintenanceButton: maintenance.button,
    onFuelNorms: fuelNorms.open,
    onEdit: actions.edit,
    onDelete: actions.remove,
  });
  const card = vehicleRegistryCard(actions, {
    maintenanceItems: maintenance.items,
    openFuelNorms: fuelNorms.open,
  });

  return (
    <PageTableLayout
      filters={model.filters}
      extra={
        <Space>
          <Button icon={<DashboardOutlined />} onClick={() => fuelNorms.open({ id: null })}>
            Нормы расхода
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => actions.create(model.ownershipFilter)}
          >
            Добавить технику
          </Button>
        </Space>
      }
      mobile={{
        search: {
          value: model.params.search,
          placeholder: 'Госномер, марка, арендодатель',
          onChange: (search) => model.setParams((current) => ({ ...current, search, page: 1 })),
        },
        filters: model.mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: model.params.sortBy,
          sortOrder: model.params.sortOrder,
          onChange: model.setSort,
        },
        primaryAction: {
          label: 'Добавить технику',
          icon: <PlusOutlined />,
          onClick: () => actions.create(model.ownershipFilter),
        },
        // Create is the single primary phone action; the directory-wide norm list stays secondary.
        secondaryActions: [
          {
            label: 'Нормы расхода',
            icon: <DashboardOutlined />,
            onClick: () => fuelNorms.open({ id: null }),
          },
        ],
      }}
    >
      <DataTable<VehicleDto>
        columns={columns}
        card={card}
        data={model.data?.items ?? []}
        total={model.data?.total ?? 0}
        loading={model.isFetching}
        page={model.params.page}
        pageSize={model.params.pageSize}
        sortBy={model.params.sortBy}
        sortOrder={model.params.sortOrder}
        onChange={model.onTableChange}
      />
      {fuelNorms.node}
      {maintenance.modal}
    </PageTableLayout>
  );
}
