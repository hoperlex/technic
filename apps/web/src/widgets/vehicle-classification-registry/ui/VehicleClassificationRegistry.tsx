import { Button, Input, Select, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { VehicleClassificationDto, VehicleTypeDto } from '@technic/contracts';
import { DataTable, PageTableLayout, sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useVehicleClassificationRegistry } from '../model/useVehicleClassificationRegistry';
import { classificationCard, classificationColumns } from './classificationPresentation';

interface Props {
  onCreate: () => void;
  onEdit: (type: VehicleTypeDto) => void;
  onOpenCard: (type: VehicleTypeDto) => void;
  onToggle: (row: VehicleClassificationDto, next: boolean) => void;
  togglePending: boolean;
}

const activityOptions = [
  { value: 'true', label: 'Активные' },
  { value: 'false', label: 'Неактивные' },
];

/** The two-level vehicle classifier rendered as one server-backed registry (ADR 0028). */
export function VehicleClassificationRegistry({
  onCreate,
  onEdit,
  onOpenCard,
  onToggle,
  togglePending,
}: Props) {
  const registry = useVehicleClassificationRegistry();
  const columns = classificationColumns({
    typeById: registry.typeById,
    togglePending,
    onToggle,
    onEdit,
    onOpenCard,
  });
  const card = classificationCard({
    typeById: registry.typeById,
    togglePending,
    onToggle,
    onEdit,
    onOpenCard,
  });

  const filters = (
    <Space wrap>
      <Input
        allowClear
        placeholder="Поиск (код, тип, категория)"
        style={{ width: 220 }}
        value={registry.params.search}
        onChange={(event) => registry.patchParams({ search: event.target.value || undefined })}
      />
      <Select
        allowClear
        placeholder="Вид"
        style={{ width: 200 }}
        options={registry.kindOptions}
        value={registry.params.kindId}
        onChange={(kindId) => registry.patchParams({ kindId })}
      />
      <Select
        allowClear
        placeholder="Активность"
        style={{ width: 150 }}
        options={activityOptions}
        value={registry.params.isActive}
        onChange={(isActive) => registry.patchParams({ isActive })}
      />
    </Space>
  );

  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'kindId',
      label: 'Вид техники',
      value: registry.params.kindId,
      options: registry.kindOptions,
      placeholder: 'Любой вид',
      onChange: (kindId) => registry.patchParams({ kindId }),
    },
    {
      kind: 'select',
      key: 'isActive',
      label: 'Активность',
      value: registry.params.isActive,
      options: activityOptions,
      placeholder: 'Все',
      onChange: (isActive) => registry.patchParams({ isActive }),
    },
  ];

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
          Добавить
        </Button>
      }
      mobile={{
        search: {
          value: registry.params.search,
          placeholder: 'Код, тип, категория',
          onChange: (search) => registry.patchParams({ search }),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { label: 'Тип/категория' }),
          sortBy: registry.params.sortBy,
          sortOrder: registry.params.sortOrder,
          onChange: (sortBy, sortOrder) =>
            registry.setParams((current) => ({
              ...current,
              sortBy: sortBy ?? 'sortOrder',
              sortOrder: sortOrder ?? 'asc',
              page: 1,
            })),
        },
        primaryAction: { label: 'Добавить тип', icon: <PlusOutlined />, onClick: onCreate },
      }}
    >
      <DataTable
        columns={columns}
        card={card}
        rowKey="key"
        data={registry.rows}
        total={registry.total}
        loading={registry.loading}
        page={registry.params.page}
        pageSize={registry.params.pageSize}
        sortBy={registry.params.sortBy}
        sortOrder={registry.params.sortOrder}
        onChange={registry.changeTable}
      />
    </PageTableLayout>
  );
}
