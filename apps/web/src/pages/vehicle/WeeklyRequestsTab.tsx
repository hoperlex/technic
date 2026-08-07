import { Button, Input, Select, Space, Tag, Typography, type TableColumnType } from 'antd';
import { EyeOutlined, PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  parseWeeklyRequestNumberSearch,
  WEEKLY_REQUEST_STATUSES,
  type WeeklyRequestStatus,
  weeklyRequestStatusLabels,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { weeklyRequestsApi } from '../../api/resources';
import { DataTable, type CardConfig } from '@shared/ui';
import { PageTableLayout } from '@shared/ui';
import { SummaryBar } from '@shared/ui';
import { actionsColumn, RowActionButton, textColumn } from '@shared/ui';
import { sortOptionsFrom, type FilterDefinition } from '@shared/ui';
import { useListParams } from '@shared/lib';
import { TabsExtra } from '../../components/PageTabs';
import { ObjectCell, OBJECT_COLUMN_WIDTH } from '../../components/ObjectCell';
import { UserAvatar } from '../../components/UserAvatar';
import { useAuth } from '../../auth/AuthContext';
import { useObjectScope } from '../../hooks/useObjectScope';
import { formatDateTime } from '../../utils/format';
import { useObjectOptions } from './shared';
import {
  useWeeklyRequestCreate,
  weekSelectOptions,
  weeklyCountsText,
  weeklyRequestPath,
  WeeklyStatusTag,
} from './weeklyShared';

/**
 * Недельные заявки на технику (ADR 0085): площадка заказывает не машину на срок, а неделю целиком.
 *
 * Список отвечает на два вопроса — «что собрано по площадкам на ближайшие недели» и «что ждёт моей
 * визы». Второй вынесен счётчиком в сводку: в очередь визы попадает только статус «Ждёт визы», и в
 * этом всё различие для руководителя строительства — черновик соседа его не касается (§10).
 *
 * Сборка живёт отдельной страницей с адресом (`/vehicle-requests/weekly/:id`), а не окном: три
 * блока состава, история и документы в модалку не помещаются, а ссылку на неделю нужно уметь
 * послать.
 */

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/** Виза: у применённой заявки — кто и когда, у ждущей — оранжевое ожидание, у прочих ничего. */
function approvalCell(r: WeeklyVehicleRequestDto) {
  if (r.status === 'pending') {
    return (
      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
        Ждёт визы
      </Tag>
    );
  }
  if (!r.approvedAt) return dash;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>{r.approvedByName ?? '—'}</div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {formatDateTime(r.approvedAt)}
      </Typography.Text>
    </div>
  );
}

export function WeeklyRequestsTab() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { soleObjectId, objectFieldDisabled, limitObjectOptions } = useObjectScope();
  const create = useWeeklyRequestCreate();
  const canCreate = can('weeklyRequests.create');

  const { params, setParams, setSort, onTableChange } = useListParams<{
    objectId?: string;
    status?: WeeklyRequestStatus;
    weekStart?: string;
    num?: number;
  }>({ objectId: soleObjectId ?? undefined }, { searchKeys: [] });

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const { data, isFetching } = useQuery({
    queryKey: ['weekly-vehicle-requests', 'list', params],
    queryFn: () => weeklyRequestsApi.list(params),
  });

  const { options: allObjectOptions } = useObjectOptions();
  const objectOptions = limitObjectOptions(allObjectOptions);

  const open = (r: WeeklyVehicleRequestDto) => void navigate(weeklyRequestPath(r.id));

  const summaryItems = [
    { label: 'Заявок', value: data?.total ?? 0 },
    // Цифра, ради которой список открывает руководитель строительства: неделя площадки стоит и
    // ждёт решения, а сроки продлятся только визой (Р6).
    { label: 'Ждут визы', value: data?.pendingCount ?? 0 },
  ];

  // Ключ колонки — он же поле сортировки на сервере; сортируются только те, по которым список и
  // читают: номер документа и неделя.
  const columns: TableColumnType<WeeklyVehicleRequestDto>[] = [
    textColumn<WeeklyVehicleRequestDto>({
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      searchable: false,
      width: 110,
    }),
    {
      key: 'objectName',
      title: 'Объект',
      dataIndex: 'objectName',
      width: OBJECT_COLUMN_WIDTH,
      render: (_v, r) => <ObjectCell name={r.objectName} address={r.objectCode} />,
    },
    {
      key: 'weekStart',
      title: 'Неделя',
      dataIndex: 'weekLabel',
      width: 190,
      sorter: true,
      // Подпись недели приходит с сервера готовой (`weeklyWeekLabel`): второго понятия недели в
      // портале быть не должно, и складывать её здесь заново значило бы завести второе.
      render: (_v, r) => r.weekLabel,
    },
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 120,
      render: (_v, r) => <WeeklyStatusTag status={r.status} />,
    },
    {
      key: 'counts',
      title: 'Состав',
      width: 260,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{weeklyCountsText(r.counts)}</div>
          {!!r.cancelReason && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Причина снятия: {r.cancelReason}
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      key: 'createdByName',
      title: 'Автор',
      dataIndex: 'createdByName',
      width: 190,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <Space size={6}>
            <UserAvatar name={r.createdByName} size={18} />
            <span>{r.createdByName}</span>
          </Space>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDateTime(r.createdAt)}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      key: 'approval',
      title: 'Виза',
      width: 160,
      render: (_v, r) => approvalCell(r),
    },
    actionsColumn<WeeklyVehicleRequestDto>(
      // Действие у списка ровно одно: открыть неделю. Состав правят, визируют и снимают на самой
      // странице — там же, где видно, что именно согласуют.
      (r) => (
        <RowActionButton title="Открыть неделю" icon={<EyeOutlined />} onClick={() => open(r)} />
      ),
      80,
    ),
  ];

  const statusOptions = WEEKLY_REQUEST_STATUSES.map((s) => ({
    value: s,
    label: weeklyRequestStatusLabels[s],
  }));
  // В фильтр попадают те же недели, что предлагаются при заведении: прошедшие ищут по номеру —
  // список недель, растущий с каждой неделей, к концу года стал бы нечитаемым.
  const weekOptions = weekSelectOptions();

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 240 }}
        options={objectOptions}
        disabled={objectFieldDisabled}
        value={params.objectId}
        onChange={(v: string | undefined) => applyFilter({ objectId: v })}
      />
      <Select
        allowClear
        placeholder="Все статусы"
        style={{ width: 160 }}
        options={statusOptions}
        value={params.status}
        onChange={(v: WeeklyRequestStatus | undefined) => applyFilter({ status: v })}
      />
      <Select
        allowClear
        placeholder="Все недели"
        style={{ width: 210 }}
        options={weekOptions}
        value={params.weekStart}
        onChange={(v: string | undefined) => applyFilter({ weekStart: v })}
      />
      <Input.Search
        allowClear
        placeholder="Поиск по № (НЗ-12)"
        style={{ width: 180 }}
        onSearch={(val) => applyFilter({ num: parseWeeklyRequestNumberSearch(val) })}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: params.objectId,
      options: objectOptions,
      placeholder: 'Все объекты',
      disabled: objectFieldDisabled,
      onChange: (v) => applyFilter({ objectId: v }),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: params.status,
      options: statusOptions,
      placeholder: 'Все статусы',
      onChange: (v) => applyFilter({ status: v as WeeklyRequestStatus | undefined }),
    },
    {
      kind: 'select',
      key: 'weekStart',
      label: 'Неделя',
      value: params.weekStart,
      options: weekOptions,
      placeholder: 'Все недели',
      onChange: (v) => applyFilter({ weekStart: v }),
    },
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: params.num != null ? String(params.num) : undefined,
      placeholder: 'Например, НЗ-12',
      onChange: (v) => applyFilter({ num: parseWeeklyRequestNumberSearch(v ?? '') }),
    },
  ];

  /** Карточка списка на телефоне (ADR 0030): неделя и объект — то, чем заявку и называют. */
  const card: CardConfig<WeeklyVehicleRequestDto> = {
    title: (r) => r.displayNumber,
    badge: (r) => <WeeklyStatusTag status={r.status} />,
    primary: (r) => r.weekLabel,
    lines: [
      (r) => r.objectName,
      (r) => weeklyCountsText(r.counts),
      (r) => (r.status === 'pending' ? 'Ждёт визы' : null),
      (r) => (r.cancelReason ? `Причина снятия: ${r.cancelReason}` : null),
      (r) => `${r.createdByName} · ${formatDateTime(r.createdAt)}`,
    ],
    onOpen: open,
    actions: (r) => [
      { key: 'open', label: 'Открыть неделю', icon: <EyeOutlined />, onClick: () => open(r) },
    ],
  };

  return (
    <PageTableLayout
      filters={filters}
      extra={
        canCreate ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={create.open}>
            Заявка на неделю
          </Button>
        ) : null
      }
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { weekStart: 'Неделя' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
        primaryAction: canCreate
          ? { label: 'Заявка на неделю', icon: <PlusOutlined />, onClick: create.open }
          : undefined,
      }}
    >
      {/* Сводка — на уровне вкладок, над фильтрами: она относится ко всему списку. */}
      <TabsExtra tabKey="weekly">
        <SummaryBar title="Недельные заявки" items={summaryItems} />
      </TabsExtra>

      <DataTable<WeeklyVehicleRequestDto>
        columns={columns}
        card={card}
        onRowClick={open}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />
      {create.node}
    </PageTableLayout>
  );
}
