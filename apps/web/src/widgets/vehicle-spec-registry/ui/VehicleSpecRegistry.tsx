import { useState } from 'react';
import { Button, Input, Select, Space, Switch, Tag, Tooltip, type TableColumnType } from 'antd';
import { DeleteFilled, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_PAGE_SIZE, type VehicleSpecDto } from '@technic/contracts';
import { vehicleSpecKeys, vehicleSpecsApi } from '@entities/vehicle-type';
import {
  actionsColumn,
  DataTable,
  PageTableLayout,
  sortOptionsFrom,
  textColumn,
  type CardConfig,
  type FilterDefinition,
  type TableChange,
} from '@shared/ui';

interface SpecParams {
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  search?: string;
  isActive?: string;
  [key: string]: unknown;
}

interface Props {
  create: () => void;
  edit: (spec: VehicleSpecDto) => void;
  toggle: (spec: VehicleSpecDto, next: boolean) => void;
  togglePending: boolean;
  purge: {
    allowed: boolean;
    pending: boolean;
    confirm: (id: string, name: string) => void;
  };
}

/**
 * Specification directory (ADR 0016): the characteristics whose values make up the categories of
 * vehicle types. Read-only here; every write enters through an explicit action port. Deactivation
 * is forbidden while a spec is attached to types, and unit and precision freeze with the first
 * attachment because they are part of the meaning of existing categories.
 */
export function VehicleSpecRegistry({ create, edit, toggle, togglePending, purge }: Props) {
  const [params, setParams] = useState<SpecParams>({
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    sortBy: 'sortOrder',
    sortOrder: 'asc',
  });
  const patchParams = (patch: Partial<SpecParams>) =>
    setParams((current) => ({ ...current, ...patch, page: 1 }));
  const { data, isFetching } = useQuery({
    queryKey: vehicleSpecKeys.list(params),
    queryFn: () => vehicleSpecsApi.list(params),
  });
  const changeTable = (change: TableChange) =>
    setParams((current) => ({
      ...current,
      page: change.page,
      pageSize: change.pageSize,
      sortBy: change.sortBy ?? 'sortOrder',
      sortOrder: change.sortOrder ?? 'asc',
    }));

  const columns: TableColumnType<VehicleSpecDto>[] = [
    textColumn<VehicleSpecDto>({
      key: 'name',
      title: 'Характеристика',
      dataIndex: 'name',
      searchable: false,
    }),
    textColumn<VehicleSpecDto>({
      key: 'unit',
      title: 'Ед. изм.',
      dataIndex: 'unit',
      searchable: false,
      width: 110,
      render: (value) => (value as string) || '—',
    }),
    { key: 'decimals', title: 'Знаков', dataIndex: 'decimals', width: 90, sorter: false },
    {
      key: 'bounds',
      title: 'Границы',
      width: 140,
      render: (_value, spec) =>
        spec.minValue == null && spec.maxValue == null
          ? '—'
          : `${spec.minValue ?? '…'} — ${spec.maxValue ?? '…'}`,
    },
    {
      key: 'usedInTypes',
      title: 'В типах',
      dataIndex: 'usedInTypes',
      width: 100,
      sorter: false,
      render: (value: number) => (value > 0 ? <Tag color="blue">{value}</Tag> : <Tag>0</Tag>),
    },
    {
      key: 'isActive',
      title: 'Активен',
      dataIndex: 'isActive',
      width: 110,
      sorter: true,
      render: (value: boolean, spec) => (
        // An attached spec cannot be switched off: detach it in the type card first.
        <Tooltip
          title={spec.usedInTypes > 0 ? 'ТТХ привязан к типам — сначала отвяжите' : undefined}
        >
          <Switch
            size="small"
            checked={value}
            disabled={value && spec.usedInTypes > 0}
            loading={togglePending}
            onChange={(next) => toggle(spec, next)}
          />
        </Tooltip>
      ),
    },
    actionsColumn<VehicleSpecDto>((spec) => (
      <Space size={4}>
        <Button size="small" icon={<EditOutlined />} onClick={() => edit(spec)} />
        {!spec.isActive && purge.allowed ? (
          <Button
            size="small"
            danger
            icon={<DeleteFilled />}
            title="Удалить окончательно"
            loading={purge.pending}
            onClick={() => purge.confirm(spec.id, spec.name)}
          />
        ) : null}
      </Space>
    )),
  ];

  const filters = (
    <Space wrap>
      <Input
        allowClear
        placeholder="Поиск (код/название/ед.)"
        style={{ width: 240 }}
        value={params.search}
        onChange={(event) => patchParams({ search: event.target.value || undefined })}
      />
      <Select
        allowClear
        placeholder="Активность"
        style={{ width: 150 }}
        options={[
          { value: 'true', label: 'Активные' },
          { value: 'false', label: 'Неактивные' },
        ]}
        value={params.isActive}
        onChange={(isActive) => patchParams({ isActive })}
      />
    </Space>
  );
  // The same filters as descriptions for the phone sheet (ADR 0030). No search here: it is a line
  // in the list panel (ADR 0042), and a second field would ask the same thing.
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'isActive',
      label: 'Активность',
      value: params.isActive,
      options: [
        { value: 'true', label: 'Активные' },
        { value: 'false', label: 'Неактивные' },
      ],
      placeholder: 'Все',
      onChange: (isActive) => patchParams({ isActive }),
    },
  ];
  // Spec card on a phone (ADR 0042): the name with its unit is how the characteristic is called,
  // followed by value bounds and the number of types it is already attached to.
  const card: CardConfig<VehicleSpecDto> = {
    title: (spec) => spec.name,
    badge: (spec) => (
      <Tag color={spec.isActive ? 'green' : 'default'}>{spec.isActive ? 'Да' : 'Нет'}</Tag>
    ),
    primary: (spec) => (spec.unit ? `Единица: ${spec.unit}` : 'Без единицы измерения'),
    lines: [
      (spec) =>
        spec.minValue == null && spec.maxValue == null
          ? null
          : `Границы: ${spec.minValue ?? '…'} — ${spec.maxValue ?? '…'}`,
      (spec) =>
        spec.usedInTypes > 0 ? `Привязан к типам: ${spec.usedInTypes}` : 'Не привязан к типам',
    ],
    onOpen: edit,
    actions: (spec) => [
      { key: 'edit', label: 'Редактировать', onClick: () => edit(spec) },
      {
        key: 'toggle',
        label: spec.isActive ? 'Деактивировать' : 'Активировать',
        danger: spec.isActive,
        // An attached spec is not switched off: it is detached in the type card first.
        disabled: spec.isActive && spec.usedInTypes > 0,
        onClick: () => toggle(spec, !spec.isActive),
      },
      ...(!spec.isActive && purge.allowed
        ? [
            {
              key: 'purge',
              label: 'Удалить окончательно',
              danger: true,
              onClick: () => purge.confirm(spec.id, spec.name),
            },
          ]
        : []),
    ],
  };

  return (
    <PageTableLayout
      filters={filters}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={create}>
          Добавить
        </Button>
      }
      mobile={{
        search: {
          value: params.search,
          placeholder: 'Код, название, единица',
          onChange: (search) => patchParams({ search }),
        },
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: (sortBy, sortOrder) =>
            patchParams({ sortBy: sortBy ?? 'sortOrder', sortOrder: sortOrder ?? 'asc' }),
        },
        primaryAction: { label: 'Добавить ТТХ', icon: <PlusOutlined />, onClick: create },
      }}
    >
      <DataTable<VehicleSpecDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={changeTable}
      />
    </PageTableLayout>
  );
}
