import { useMemo } from 'react';
import { Alert, Button, Select, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { WasteTariffDto, WasteTypeDto } from '@technic/contracts';
import { counterpartyOperatorGridQuery } from '@entities/counterparty';
import {
  buildWasteTariffGrid,
  type WasteTariffGridRow,
  wasteTariffKeys,
  wasteTariffsApi,
} from '@entities/waste-tariff';
import { wasteTypeOptionsQuery } from '@entities/waste-type';
import { useIsMobile, useListParams } from '@shared/lib';
import { DataTable, PageTableLayout, type FilterDefinition } from '@shared/ui';
import { buildWasteTariffColumns } from '../model/columns';

/** The matrix must be assembled from all prices; paginating tariff positions would split columns. */
const MAX_TARIFFS = 500;

interface Props {
  onCreate: () => void;
  onCreateFor: (row: WasteTariffGridRow, operatorCounterpartyId: string) => void;
  onEdit: (tariff: WasteTariffDto) => void;
  onEditWasteType: (wasteType: WasteTypeDto) => void;
  onToggle: (tariff: WasteTariffDto, next: boolean) => void;
  togglePending: boolean;
}

/**
 * Tariff registry (ADR 0009, 0014, 0017, 0026). It owns the complete pair-by-operator read model;
 * every write enters through a feature action port so mutations and cache effects stay together.
 */
export function WasteTariffRegistry({
  onCreate,
  onCreateFor,
  onEdit,
  onEditWasteType,
  onToggle,
  togglePending,
}: Props) {
  const isMobile = useIsMobile();
  const { params, setParams, onTableChange } = useListParams<{
    wasteTypeId?: string;
    isActive?: string;
  }>({}, { searchKeys: [] });
  const { data, isFetching } = useQuery({
    queryKey: wasteTariffKeys.grid({
      wasteTypeId: params.wasteTypeId,
      isActive: params.isActive,
    }),
    queryFn: () =>
      wasteTariffsApi.list({
        page: 1,
        pageSize: MAX_TARIFFS,
        ...(params.wasteTypeId ? { wasteTypeId: params.wasteTypeId } : {}),
        ...(params.isActive ? { isActive: params.isActive } : {}),
      }),
  });
  // Selects include inactive records because an existing tariff must retain a readable value when
  // edited after either side of the pair leaves active use.
  const { data: wasteTypesData, isLoading: wasteTypesLoading } = useQuery(
    wasteTypeOptionsQuery({ pricedOnly: false }),
  );
  const { data: operatorsData, isLoading: operatorsLoading } = useQuery(
    counterpartyOperatorGridQuery(),
  );

  const wasteTypes = wasteTypesData?.items ?? [];
  const wasteTypeById = new Map(wasteTypes.map((type) => [type.id, type]));
  const wasteTypeOptions = wasteTypes.map((type) => ({
    value: type.id,
    label: type.isActive ? type.name : `${type.name} (неактивен)`,
  }));
  const operators = useMemo(() => operatorsData?.items ?? [], [operatorsData]);
  const tariffs = useMemo(() => data?.items ?? [], [data]);
  const rows = useMemo(() => buildWasteTariffGrid(tariffs), [tariffs]);
  // Table pagination applies to assembled pairs, not tariff positions.
  const pageRows = rows.slice(
    (params.page - 1) * params.pageSize,
    (params.page - 1) * params.pageSize + params.pageSize,
  );
  const truncated = (data?.total ?? 0) > tariffs.length;
  const columns = buildWasteTariffColumns({
    operators,
    tariffs,
    wasteTypeById,
    isMobile,
    togglePending,
    onCreateFor,
    onEdit,
    onEditWasteType,
    onToggle,
  });

  const filters = (
    <Space wrap>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все типы мусора"
        style={{ width: 280 }}
        options={wasteTypeOptions}
        value={params.wasteTypeId}
        onChange={(wasteTypeId) => setParams((old) => ({ ...old, wasteTypeId, page: 1 }))}
      />
      <Select
        allowClear
        placeholder="Все цены"
        style={{ width: 200 }}
        options={[
          { value: 'true', label: 'Только действующие' },
          { value: 'false', label: 'Только отключённые' },
        ]}
        value={params.isActive}
        onChange={(isActive) => setParams((old) => ({ ...old, isActive, page: 1 }))}
      />
    </Space>
  );
  /** The same filter contract drives the phone sheet (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'wasteTypeId',
      label: 'Тип мусора',
      value: params.wasteTypeId,
      options: wasteTypeOptions,
      placeholder: 'Все типы мусора',
      loading: wasteTypesLoading,
      onChange: (wasteTypeId) => setParams((old) => ({ ...old, wasteTypeId, page: 1 })),
    },
    {
      kind: 'select',
      key: 'isActive',
      label: 'Действие цены',
      value: params.isActive,
      options: [
        { value: 'true', label: 'Только действующие' },
        { value: 'false', label: 'Только отключённые' },
      ],
      placeholder: 'Все цены',
      onChange: (isActive) => setParams((old) => ({ ...old, isActive, page: 1 })),
    },
  ];

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
          Добавить цену
        </Button>
      }
      mobile={{
        filters: mobileFilters,
        primaryAction: { label: 'Добавить цену', icon: <PlusOutlined />, onClick: onCreate },
      }}
    >
      {operators.length === 0 && !operatorsLoading && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Операторы не заведены"
          description="Цена вывоза принадлежит оператору — заведите контрагента типа «Оператор» в справочнике контрагентов."
        />
      )}
      {truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={`Показаны первые ${tariffs.length} позиций прайса из ${data?.total ?? 0}`}
          description="Отфильтруйте справочник по типу мусора — иначе часть цен в таблицу не попала."
        />
      )}
      <DataTable<WasteTariffGridRow>
        rowKey="key"
        columns={columns}
        data={pageRows}
        total={rows.length}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />
    </PageTableLayout>
  );
}
