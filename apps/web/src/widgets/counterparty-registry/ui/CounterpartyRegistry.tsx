import { Button, Checkbox, Select, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import type { CounterpartyDto } from '@technic/contracts';
import { counterpartyTypeOptions } from '@entities/counterparty';
import { DataTable, PageTableLayout, sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import type { CounterpartyRegistryActions } from '../model/types';
import { useCounterpartyRegistry } from '../model/useCounterpartyRegistry';
import { counterpartyRegistryCard, counterpartyRegistryColumns } from './counterpartyRegistryView';

/** Counterparty list, filters and responsive presentation; writes enter through feature ports. */
export function CounterpartyRegistry(actions: CounterpartyRegistryActions) {
  const model = useCounterpartyRegistry();
  const columns = counterpartyRegistryColumns(actions);
  const card = counterpartyRegistryCard(actions);

  const filters = (
    <Space wrap>
      <Select
        style={{ width: 260 }}
        value={model.typeFilter}
        onChange={model.applyTypeFilter}
        options={[{ value: '', label: 'Все типы' }, ...counterpartyTypeOptions]}
      />
      {actions.canSeeArchive ? (
        <Checkbox
          checked={model.params.includeDeleted === 'true'}
          onChange={(event) =>
            model.setParams((current) => ({
              ...current,
              includeDeleted: event.target.checked ? 'true' : undefined,
              page: 1,
            }))
          }
        >
          Показать архив
        </Checkbox>
      ) : null}
    </Space>
  );

  // The phone sheet uses the same state contract as the desktop toolbar (ADR 0030).
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'type',
      label: 'Тип контрагента',
      value: model.typeFilter || undefined,
      options: counterpartyTypeOptions,
      placeholder: 'Все типы',
      onChange: (value) => model.applyTypeFilter(value ?? ''),
    },
    {
      kind: 'select',
      key: 'isActive',
      label: 'Активность',
      value: model.params.isActive,
      options: [
        { value: 'true', label: 'Активные' },
        { value: 'false', label: 'Неактивные' },
      ],
      placeholder: 'Все',
      onChange: (value) => model.setParams((current) => ({ ...current, isActive: value, page: 1 })),
    },
    ...(actions.canSeeArchive
      ? [
          {
            kind: 'toggle' as const,
            key: 'includeDeleted',
            label: 'Показывать архив',
            value: model.params.includeDeleted === 'true',
            onChange: (checked: boolean) =>
              model.setParams((current) => ({
                ...current,
                includeDeleted: checked ? 'true' : undefined,
                page: 1,
              })),
          },
        ]
      : []),
  ];

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        search: {
          value: model.params.search,
          placeholder: 'Наименование или ИНН',
          onChange: (search) => model.setParams((current) => ({ ...current, search, page: 1 })),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { name: 'Наименование' }),
          sortBy: model.params.sortBy,
          sortOrder: model.params.sortOrder,
          onChange: model.setSort,
        },
        primaryAction: {
          label: 'Добавить контрагента',
          icon: <PlusOutlined />,
          onClick: actions.create,
        },
      }}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={actions.create}>
          Добавить контрагента
        </Button>
      }
    >
      <DataTable<CounterpartyDto>
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
    </PageTableLayout>
  );
}
