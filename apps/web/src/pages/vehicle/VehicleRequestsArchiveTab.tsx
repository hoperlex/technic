import { useState } from 'react';
import { App, Input, Space, Tag, Typography } from 'antd';
import { DeleteFilled, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  parseVehicleRequestNumberSearch,
  requestCustomerLabel,
  requestStatusColors,
  requestStatusLabels,
  vehicleClassificationLabel,
  type VehicleRequestDto,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { DataTable, type CardConfig } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { actionsColumn, RowActionButton, textColumn } from '@shared/ui';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '../../components/ObjectCell';
import { useListParams } from '@shared/lib';
import { useOpenedRecord } from '@shared/lib';
import { useActiveTabKey } from '../../components/PageTabs';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import { WEEKLY_QUERY_KEY } from './weeklyShared';

/**
 * Архив заказов техники (ADR 0070) — удалённые заявки и два действия над ними: вернуть в работу
 * и снести насовсем.
 *
 * Своя вкладка, а не флажок «показать удалённые» в списке: в рабочем списке архивная строка —
 * помеха (её нельзя ни вести, ни закрыть), а вопросы к ней другие — когда удалили, кто и что в
 * ней было. Флажком же удаление насовсем оказалось бы в одном меню с обычным удалением, а между
 * ними вся разница: первое необратимо.
 *
 * Вкладка видна только праву `archive.read`, то есть администратору: показывает её страница
 * раздела, а сервер того же права требует от самой выдачи (`archive=only`).
 */
export function VehicleRequestsArchiveTab() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canRestore = can('archive.restore');
  const [viewRecord, setViewRecord] = useState<VehicleRequestDto | null>(null);

  /** Удалённая заявка, названная в адресе: ссылки на неё ведут в архив, а не в список. */
  const opened = useOpenedRecord<VehicleRequestDto>({
    active: useActiveTabKey() === 'archive',
    queryKey: (id) => ['vehicle-requests', id],
    fetch: (id) => vehicleRequestsApi.get(id),
  });

  const { params, setParams, setSort, onTableChange } = useListParams<{ num?: number }>(
    {},
    { searchKeys: ['comment'] },
  );
  const [numInput, setNumInput] = useState('');
  const applyNumFilter = (raw: string) => {
    setNumInput(raw);
    setParams((p) => ({ ...p, num: parseVehicleRequestNumberSearch(raw), page: 1 }));
  };

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-requests', 'archive', params],
    queryFn: () =>
      vehicleRequestsApi.list({
        ...params,
        // Порядок по времени удаления, пока столбец не выбрали руками: архив открывают вопросом
        // «что снесли последним», а умолчание списка (дата создания) отвечает не на него.
        sortBy: params.sortBy ?? 'deletedAt',
        archive: 'only',
      }),
  });

  /**
   * Возврат из архива. Гасится корень `['vehicle-requests']`: восстановленная заявка исчезает
   * отсюда и появляется в рабочем списке — обновить нужно оба, а заодно и сводку над ним.
   */
  const restoreMut = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Заявка восстановлена');
      setViewRecord(null);
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем — общий хук справочников и учёток (ADR 0060, ADR 0063): подтверждение
  // необратимого действия должно звучать везде одинаково. Заодно сервер снимает строки «остаётся»
  // и «уезжает» неприменённых недельных заявок, ссылавшиеся на этот заказ (ADR 0085 Р15).
  const purge = usePurgeAction({
    subject: 'заявку',
    purge: vehicleRequestsApi.purge,
    invalidate: [['vehicle-requests'], WEEKLY_QUERY_KEY],
  });

  const removePermanently = (r: VehicleRequestDto) => {
    setViewRecord(null);
    purge.confirm(r.id, r.displayNumber);
  };

  const columns = [
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 130,
      sorter: true,
      render: (_v: unknown, r: VehicleRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.displayNumber}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            завёл {r.createdByName}
          </Typography.Text>
        </div>
      ),
    },
    // Заказчик заявки: объект или отдел (ADR 0040) — одна колонка на обе оси, как в списке.
    textColumn<VehicleRequestDto>({
      key: 'objectName',
      title: 'Заказчик',
      dataIndex: 'objectName',
      searchable: false,
      width: OBJECT_COLUMN_WIDTH,
      render: (_v, r) => {
        const customer = requestCustomerLabel(r);
        return <ObjectCell name={customer.text} hint={customer.hint} address={r.objectAddress} />;
      },
    }),
    {
      key: 'vehicleTypeName',
      title: 'Заказано',
      dataIndex: 'vehicleTypeName',
      width: 190,
      sorter: true,
      render: (_v: unknown, r: VehicleRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>
            {vehicleClassificationLabel({
              typeName: r.vehicleTypeName,
              categoryName: r.vehicleCategoryName,
            })}
          </div>
          <Tag color={vehicleRequestTypeColors[r.requestType]} style={{ marginTop: 2 }}>
            {vehicleRequestTypeLabels[r.requestType]}
          </Tag>
        </div>
      ),
    },
    {
      // Статус на момент удаления: «Новую» заявку удаление стирает сразу (soft delete до архива
      // не доводит), поэтому здесь всегда строка, по которой уже шла работа.
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 120,
      sorter: true,
      render: (_v: unknown, r: VehicleRequestDto) => (
        <Tag color={requestStatusColors[r.status]}>{requestStatusLabels[r.status]}</Tag>
      ),
    },
    {
      key: 'deletedAt',
      title: 'Удалена',
      dataIndex: 'deletedAt',
      width: 190,
      sorter: true,
      defaultSortOrder: 'descend' as const,
      render: (_v: unknown, r: VehicleRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{formatDateTime(r.deletedAt)}</div>
          {/* Кто удалил: пусто у заявок, удалённых до ADR 0070, и там, где учётку снесли. */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.deletedByName ?? 'автор не сохранён'}
          </Typography.Text>
        </div>
      ),
    },
    actionsColumn<VehicleRequestDto>(
      (r) => (
        <Space size={4}>
          {/* Карточка — единственное место, где видно, что в заявке было: строка архива несёт
              номер и заказчика, а решают по истории, срокам и технике. */}
          <RowActionButton
            title="Открыть карточку"
            icon={<EyeOutlined />}
            onClick={() => setViewRecord(r)}
          />
          {canRestore ? (
            <RowActionButton
              title="Восстановить"
              icon={<ReloadOutlined />}
              onClick={() => restoreMut.mutate(r.id)}
            />
          ) : null}
          {purge.allowed ? (
            <RowActionButton
              title="Удалить окончательно"
              icon={<DeleteFilled />}
              danger
              onClick={() => removePermanently(r)}
            />
          ) : null}
        </Space>
      ),
      140,
    ),
  ];

  /** Строка архива на телефоне (ADR 0030): когда удалили и кто — то, ради чего сюда заходят. */
  const card: CardConfig<VehicleRequestDto> = {
    title: (r) => r.displayNumber,
    badge: (r) => <Tag color={requestStatusColors[r.status]}>{requestStatusLabels[r.status]}</Tag>,
    primary: (r) => requestCustomerLabel(r).text,
    lines: [
      (r) =>
        vehicleClassificationLabel({
          typeName: r.vehicleTypeName,
          categoryName: r.vehicleCategoryName,
        }),
      (r) => `Удалена: ${formatDateTime(r.deletedAt)}`,
      (r) => (r.deletedByName ? `Удалил: ${r.deletedByName}` : null),
    ],
    onOpen: (r) => setViewRecord(r),
    actions: (r) => [
      {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => setViewRecord(r),
      },
      ...(canRestore
        ? [
            {
              key: 'restore',
              label: 'Восстановить',
              icon: <ReloadOutlined />,
              onClick: () => restoreMut.mutate(r.id),
            },
          ]
        : []),
      ...(purge.allowed
        ? [
            {
              key: 'purge',
              label: 'Удалить окончательно',
              icon: <DeleteFilled />,
              danger: true,
              onClick: () => removePermanently(r),
            },
          ]
        : []),
    ],
  };

  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: params.num != null ? String(params.num) : undefined,
      placeholder: 'Например, ТС-123',
      onChange: (v) => applyNumFilter(v ?? ''),
    },
  ];

  return (
    <PageTableLayout
      filters={
        <Space wrap>
          <Input
            allowClear
            style={{ width: 180 }}
            placeholder="№ заявки"
            value={numInput}
            onChange={(e) => applyNumFilter(e.target.value)}
          />
        </Space>
      }
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <DataTable<VehicleRequestDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching || restoreMut.isPending || purge.pending}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onRowClick={(r) => setViewRecord(r)}
        onChange={onTableChange}
      />

      {/* Карточка архивной заявки только на чтение: править её нечем, а вернуть и снести —
          действия строки. Правку карточка и не предлагает — обработчик ей не передан. */}
      <VehicleRequestViewModal
        request={viewRecord ?? opened.record}
        onClose={() => {
          setViewRecord(null);
          opened.clear();
        }}
      />
    </PageTableLayout>
  );
}
