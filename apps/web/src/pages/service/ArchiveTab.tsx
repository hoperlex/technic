import { useState } from 'react';
import { App, Input, Space, Typography } from 'antd';
import { DeleteFilled, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  serviceRequestKeys,
  serviceRequestsApi,
  ServiceStatusTag,
} from '@entities/service-request';
import {
  actionsColumn,
  DataTable,
  PageTableLayout,
  RowActionButton,
  sortOptionsFrom,
  textColumn,
  type CardConfig,
} from '@shared/ui';
import { useListParams, useOpenedRecord } from '@shared/lib';
import { useActiveTabKey } from '../../components/PageTabs';
import { usePurgeAction } from '../../hooks/usePurgeAction';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';
import { ServiceRequestViewModal } from './ServiceRequestViewModal';

/**
 * Архив заявок на обслуживание (ADR 0070): удалённые заявки и два действия над ними — вернуть в
 * работу и снести насовсем.
 *
 * Своя вкладка, а не флажок «показать удалённые» в списке: в рабочем списке архивная строка —
 * помеха (её нельзя ни вести, ни закрыть), а вопросы к ней другие — когда удалили и что в ней
 * было. Вкладку показывает страница по `archive.read`, того же права требует и сама выдача.
 */
export function ServiceArchiveTab() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canRestore = can('archive.restore');
  const [viewRecord, setViewRecord] = useState<ServiceRequestDto | null>(null);

  /** Удалённая заявка, названная в адресе: ссылки на неё ведут в архив, а не в список. */
  const opened = useOpenedRecord<ServiceRequestDto>({
    active: useActiveTabKey() === 'archive',
    queryKey: (id) => serviceRequestKeys.detail(id),
    fetch: (id) => serviceRequestsApi.get(id),
  });

  const { params, setParams, setSort, onTableChange } = useListParams({}, { searchKeys: [] });

  /**
   * Поиск один на номер и на технику: «СО-14», «со-14» и просто «14» сервер разбирает как номер
   * (`parseServiceRequestNumberSearch`), остальное ищет по модели и номерам единицы. Отдельного
   * фильтра по номеру у списка нет намеренно — два поля, отвечающие на один вопрос, расходятся.
   */
  const applySearch = (raw: string) =>
    setParams((p) => ({ ...p, search: raw.trim() || undefined, page: 1 }));

  const query = {
    ...params,
    // Архив открывают вопросом «что снесли последним» — по нему и порядок по умолчанию.
    sortBy: params.sortBy ?? 'createdAt',
    archive: 'only',
  };
  const { data, isFetching } = useQuery({
    queryKey: serviceRequestKeys.list(query),
    queryFn: () => serviceRequestsApi.list(query),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => serviceRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Заявка восстановлена');
      setViewRecord(null);
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
    },
    // 409 «по этой технике уже есть открытая заявка» (Р21) — обычный ответ, а не сбой.
    onError: (e) => message.error(errorMessage(e)),
  });

  // Удаление насовсем — общий хук справочников и учёток (ADR 0060, ADR 0063): подтверждение
  // необратимого действия должно звучать везде одинаково.
  const purge = usePurgeAction({
    subject: 'заявку',
    purge: serviceRequestsApi.purge,
    invalidate: [serviceRequestKeys.root],
  });

  const removePermanently = (r: ServiceRequestDto) => {
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
      render: (_v: unknown, r: ServiceRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.displayNumber}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            завёл {r.createdByName}
          </Typography.Text>
        </div>
      ),
    },
    textColumn<ServiceRequestDto>({
      key: 'equipment',
      title: 'Техника',
      dataIndex: 'equipment',
      searchable: false,
      width: 260,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.equipment.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.object.code} — {r.object.name}
          </Typography.Text>
        </div>
      ),
    }),
    {
      // Статус на момент удаления: по нему видно, докуда заявку успели довести.
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 190,
      sorter: true,
      render: (_v: unknown, r: ServiceRequestDto) => <ServiceStatusTag status={r.status} />,
    },
    {
      key: 'deletedAt',
      title: 'Удалена',
      dataIndex: 'deletedAt',
      width: 180,
      render: (_v: unknown, r: ServiceRequestDto) => formatDateTime(r.deletedAt),
    },
    actionsColumn<ServiceRequestDto>(
      (r) => (
        <Space size={4}>
          {/* Карточка — единственное место, где видно, что в заявке было: строка архива несёт
              номер и технику, а решают по смете, документам и истории. */}
          <RowActionButton
            title="Открыть карточку"
            icon={<EyeOutlined />}
            onClick={() => setViewRecord(r)}
          />
          {canRestore ? (
            <RowActionButton
              title="Восстановить"
              icon={<ReloadOutlined />}
              onClick={() => restoreMutation.mutate(r.id)}
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

  const card: CardConfig<ServiceRequestDto> = {
    title: (r) => r.displayNumber,
    badge: (r) => <ServiceStatusTag status={r.status} />,
    primary: (r) => r.equipment.name,
    lines: [
      (r) => `${r.object.code} — ${r.object.name}`,
      (r) => `Удалена: ${formatDateTime(r.deletedAt)}`,
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
              onClick: () => restoreMutation.mutate(r.id),
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

  return (
    <PageTableLayout
      filters={
        <Space wrap>
          <Input
            allowClear
            style={{ width: 260 }}
            placeholder="СО-14, модель или номер техники"
            value={params.search ?? ''}
            onChange={(e) => applySearch(e.target.value)}
          />
        </Space>
      }
      mobile={{
        search: {
          value: params.search,
          placeholder: 'СО-14, модель или номер техники',
          onChange: (v) => applySearch(v ?? ''),
        },
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      <DataTable<ServiceRequestDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching || restoreMutation.isPending || purge.pending}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onRowClick={(r) => setViewRecord(r)}
        onChange={onTableChange}
      />

      {/* Карточка архивной заявки только на чтение: править её нечем, а вернуть и снести —
          действия строки. Правку карточка и не предлагает — обработчик ей не передан. */}
      <ServiceRequestViewModal
        request={viewRecord ?? opened.record}
        onClose={() => {
          setViewRecord(null);
          opened.clear();
        }}
      />
    </PageTableLayout>
  );
}
