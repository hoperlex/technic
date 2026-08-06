import { useState } from 'react';
import { App, Input, Space, Tag, Typography } from 'antd';
import { DeleteFilled, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  parseWasteRequestNumberSearch,
  requestStatusColors,
  requestStatusLabels,
  requestTypeColors,
  requestTypeLabels,
  type WasteRequestDto,
} from '@technic/contracts';
import { wasteRequestsApi } from '../../api/resources';
import { DataTable, type CardConfig } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { actionsColumn, RowActionButton, textColumn } from '@shared/ui';
import { ObjectCell } from '../../components/ObjectCell';
import { useListParams } from '@shared/lib';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';
import { WasteRequestViewModal } from './WasteRequestViewModal';

/**
 * Архив заявок на вывоз (ADR 0070) — удалённые заявки и два действия над ними: вернуть в работу
 * и снести насовсем.
 *
 * Устроена так же, как архив заказов техники, и по тем же доводам: в рабочем списке архивная
 * строка — помеха, вопросы к ней другие («когда удалили и кто»), а удаление насовсем не должно
 * стоять в одном меню с обычным удалением — между ними вся разница, первое необратимо.
 *
 * Вкладка видна только праву `archive.read`, то есть администратору: показывает её страница
 * раздела, а сервер того же права требует от самой выдачи (`archive=only`).
 */
export function WasteArchiveTab() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canRestore = can('archive.restore');
  const [viewRecord, setViewRecord] = useState<WasteRequestDto | null>(null);

  const { params, setParams, setSort, onTableChange } = useListParams<{ num?: number }>(
    {},
    { searchKeys: ['comment'] },
  );
  const [numInput, setNumInput] = useState('');
  const applyNumFilter = (raw: string) => {
    setNumInput(raw);
    setParams((p) => ({ ...p, num: parseWasteRequestNumberSearch(raw), page: 1 }));
  };

  const { data, isFetching } = useQuery({
    queryKey: ['waste-requests', 'archive', params],
    queryFn: () =>
      wasteRequestsApi.list({
        ...params,
        // Порядок по времени удаления, пока столбец не выбрали руками: архив открывают вопросом
        // «что снесли последним», а умолчание списка (дата создания) отвечает не на него.
        sortBy: params.sortBy ?? 'deletedAt',
        archive: 'only',
      }),
  });

  /**
   * Возврат из архива. Гасится корень `['waste-requests']`: восстановленная заявка исчезает
   * отсюда и появляется в рабочем списке — обновить нужно оба, а заодно и сводку над ним.
   */
  const restoreMut = useMutation({
    mutationFn: (id: string) => wasteRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Заявка восстановлена');
      setViewRecord(null);
      void qc.invalidateQueries({ queryKey: ['waste-requests'] });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем — общий хук справочников и учёток (ADR 0060, ADR 0063): подтверждение
  // необратимого действия должно звучать везде одинаково.
  const purge = usePurgeAction({
    subject: 'заявку',
    purge: wasteRequestsApi.purge,
    invalidate: [['waste-requests']],
  });

  const removePermanently = (r: WasteRequestDto) => {
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
      render: (_v: unknown, r: WasteRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.displayNumber}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            завёл {r.createdByName}
          </Typography.Text>
        </div>
      ),
    },
    textColumn<WasteRequestDto>({
      key: 'objectName',
      title: 'Площадка',
      dataIndex: 'objectName',
      searchable: false,
      width: 220,
      render: (_v, r) => <ObjectCell name={r.objectName} address={r.objectAddress} />,
    }),
    {
      key: 'requestType',
      title: 'Тип заявки',
      dataIndex: 'requestType',
      width: 170,
      sorter: true,
      render: (_v: unknown, r: WasteRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <Tag color={requestTypeColors[r.requestType]} style={{ whiteSpace: 'normal' }}>
            {requestTypeLabels[r.requestType]}
          </Tag>
          {r.containerTypeName ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.containerTypeName}
            </Typography.Text>
          ) : null}
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
      render: (_v: unknown, r: WasteRequestDto) => (
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
      render: (_v: unknown, r: WasteRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{formatDateTime(r.deletedAt)}</div>
          {/* Кто удалил: пусто у заявок, удалённых до ADR 0070, и там, где учётку снесли. */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.deletedByName ?? 'автор не сохранён'}
          </Typography.Text>
        </div>
      ),
    },
    actionsColumn<WasteRequestDto>(
      (r) => (
        <Space size={4}>
          {/* Карточка — единственное место, где видно, что в заявке было: строка архива несёт
              номер и площадку, а решают по истории, объёму и талонам. */}
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
  const card: CardConfig<WasteRequestDto> = {
    title: (r) => r.displayNumber,
    badge: (r) => <Tag color={requestStatusColors[r.status]}>{requestStatusLabels[r.status]}</Tag>,
    primary: (r) => r.objectName,
    lines: [
      (r) => requestTypeLabels[r.requestType],
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
      placeholder: 'Например, М-128',
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
      <DataTable<WasteRequestDto>
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
      <WasteRequestViewModal request={viewRecord} onClose={() => setViewRecord(null)} />
    </PageTableLayout>
  );
}
