import { useState } from 'react';
import {
  DatePicker,
  Input,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  type TableColumnType,
} from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  assignmentTitle,
  CLOSED_REQUEST_STATUSES,
  isObjectScopedRole,
  parseVehicleRequestNumberSearch,
  type RequestStatus,
  requestStatusColors,
  requestStatusLabels,
  VEHICLE_REQUEST_TYPES,
  vehicleClassificationLabel,
  type VehicleRequestDto,
  vehicleRequestTypeColors,
  vehicleRequestTypeLabels,
  type VehicleRequestType,
  workedAmountLabel,
} from '@technic/contracts';
import { counterpartiesApi, vehicleRequestsApi } from '../../api/resources';
import { DataTable } from '../../components/DataTable';
import { PageTableLayout } from '../../components/PageTableLayout';
import { TabsExtra } from '../../components/PageTabs';
import { SummaryBar } from '../../components/SummaryBar';
import { actionsColumn, textColumn } from '../../components/columns';
import { UserAvatar } from '../../components/UserAvatar';
import { useListParams } from '../../hooks/useListParams';
import { useAuth } from '../../auth/AuthContext';
import { formatDate, formatDateTimeMaybe, formatMoney } from '../../utils/format';
import { calendarDayCount } from '../../utils/date';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import { formatDateOnly, useObjectOptions } from './shared';

/**
 * Журнал закрытых заказов техники (ADR 0029). Первая вкладка отвечает на «что сейчас в работе»,
 * эта — на вопросы, которые задают потом: когда и на какой объект брали технику, на сколько, кто
 * согласовал заказ, у какого арендодателя брали и во сколько это обошлось.
 *
 * Поэтому строка журнала — не строка списка заявок: вместо кнопок статуса и визы в ней стоят факт
 * выполнения (отработанное и стоимость) и обе фамилии — завизировавшего заказ и назначившего
 * машину. Открытых заявок здесь нет: пока заявку ведут, итога у неё не бывает, а хронология
 * событий каждой заявки живёт в её карточке (ADR 0015).
 */

/** Срок работ: у спецтехники период с числом заказанных дней, у грузоперевозки — дата подачи. */
function termCell(r: VehicleRequestDto) {
  if (r.requestType !== 'special_equipment') {
    return <div>{formatDateTimeMaybe(r.scheduledAt, r.scheduledTimeUnspecified)}</div>;
  }
  const days = calendarDayCount(r.dateFrom, r.dateTo);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>
        {r.dateTo
          ? `${formatDateOnly(r.dateFrom)} – ${formatDateOnly(r.dateTo)}`
          : formatDateOnly(r.dateFrom)}
      </div>
      {days != null && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          заказано {days} дн.
        </Typography.Text>
      )}
    </div>
  );
}

const dash = <Typography.Text type="secondary">—</Typography.Text>;

export function VehicleRequestsHistoryTab() {
  const { user } = useAuth();
  const isObjectRole = isObjectScopedRole(user?.role);
  // Штабу объект зафиксирован на его собственном — как и в списке заявок; сервер всё равно
  // отдаёт только свой объект (requestVisibilityWhere).
  const ownObjectId = isObjectRole ? (user?.constructionObjectId ?? '') : '';

  const { params, setParams, onTableChange } = useListParams<{
    requestType?: string;
    status?: string;
    objectId?: string;
    lessorId?: string;
    num?: number;
    dateFrom?: string;
    dateTo?: string;
  }>({ objectId: ownObjectId || undefined }, { searchKeys: ['comment'] });

  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((p) => ({ ...p, ...patch, page: 1 }));

  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-requests', 'history', params],
    queryFn: () => vehicleRequestsApi.historyList(params),
  });

  // Итог считается по тем же фильтрам, что и таблица: сводка, отвечающая не про то, что человек
  // видит перед собой, вводит в заблуждение вернее, чем её отсутствие.
  const { data: summary } = useQuery({
    queryKey: ['vehicle-requests', 'history-summary', params],
    queryFn: () => vehicleRequestsApi.historySummary(params),
  });

  const { options: objectOptions } = useObjectOptions();

  // Арендодатели — контрагенты роли «Арендодатель (ТС)»: по ним и сводят расходы на аренду.
  // Неактивные из списка не убираем: журнал читают и про тех, с кем уже не работают.
  const { data: lessorsData } = useQuery({
    queryKey: ['counterparties', 'vehicle-lessors', 'all'],
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'vehicle_lessor',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  const lessorOptions = (lessorsData?.items ?? []).map((c) => ({ value: c.id, label: c.name }));

  const [viewRecord, setViewRecord] = useState<VehicleRequestDto | null>(null);

  const summaryItems = [
    { label: 'Закрыто', value: summary?.total ?? 0 },
    { label: requestStatusLabels.done, value: summary?.done ?? 0 },
    { label: requestStatusLabels.cancelled, value: summary?.cancelled ?? 0 },
    {
      label: 'Стоимость',
      value: (
        <Space size={6}>
          <span>{formatMoney(summary?.totalCost ?? 0)}</span>
          {/* Без этой оговорки итог читается как «столько всего и потратили», а часть работ
              закрывают своей техникой, которую в деньгах не считают. */}
          {!!summary?.withoutCost && (
            <Tooltip
              title={`Выполненных заявок без суммы: ${summary.withoutCost}. Своя техника без ставки либо закрытие до появления учёта стоимости`}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                (без суммы: {summary.withoutCost})
              </Typography.Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  // Ключ колонки — он же поле сортировки на сервере (VEHICLE_REQUEST_SORT_FIELDS).
  const columns: TableColumnType<VehicleRequestDto>[] = [
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 170,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>{r.displayNumber}</div>
          <Space size={6}>
            <UserAvatar name={r.createdByName} size={18} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.createdByName}
            </Typography.Text>
          </Space>
        </div>
      ),
    },
    {
      // Журнал открывается сроком работ, а не датой закрытия: «когда техника была на объекте» —
      // то, по чему его и сводят с табелем и со счетами.
      key: 'term',
      title: 'Когда',
      width: 175,
      sorter: true,
      defaultSortOrder: 'descend',
      render: (_v, r) => termCell(r),
    },
    textColumn({
      key: 'objectName',
      title: 'Объект',
      dataIndex: 'objectName',
      searchable: false,
      width: 220,
      ellipsis: true,
    }),
    {
      key: 'vehicleTypeName',
      title: 'Заказано',
      dataIndex: 'vehicleTypeName',
      width: 190,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          {/* Заказанная позиция классификатора (ADR 0028): категория, а без неё — сам тип. */}
          <div>
            {vehicleClassificationLabel({
              typeName: r.vehicleTypeName,
              categoryName: r.vehicleCategoryName,
            })}
          </div>
          <Tag
            color={vehicleRequestTypeColors[r.requestType]}
            style={{
              whiteSpace: 'normal',
              lineHeight: 1.25,
              maxWidth: '100%',
              wordBreak: 'break-word',
              marginTop: 2,
            }}
          >
            {vehicleRequestTypeLabels[r.requestType]}
          </Tag>
        </div>
      ),
    },
    {
      // Чем работали и у кого брали. Арендодатель второй строкой: по нему сводят расходы на
      // аренду, а у собственной машины на этом месте так и написано.
      key: 'lessorName',
      title: 'Техника',
      width: 210,
      sorter: true,
      render: (_v, r) =>
        r.assignment ? (
          <div style={{ lineHeight: 1.35 }}>
            <div>{assignmentTitle(r.assignment)}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.assignment.lessorName ?? 'Своя техника'}
            </Typography.Text>
          </div>
        ) : (
          dash
        ),
    },
    {
      // «На сколько» по факту, а не по заказу: заказывали три дня — отработала полторы смены.
      key: 'worked',
      title: 'Отработано',
      width: 130,
      render: (_v, r) =>
        r.completion ? (
          <div style={{ lineHeight: 1.35 }}>
            <div>{workedAmountLabel(r.completion.workedUnit, r.completion.workedAmount)}</div>
            {r.completion.rate != null && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                по {formatMoney(r.completion.rate)}
              </Typography.Text>
            )}
          </div>
        ) : (
          dash
        ),
    },
    {
      key: 'totalCost',
      title: 'Стоимость',
      width: 150,
      sorter: true,
      align: 'right',
      render: (_v, r) =>
        r.completion?.totalCost != null ? (
          <Typography.Text strong>{formatMoney(r.completion.totalCost)}</Typography.Text>
        ) : (
          dash
        ),
    },
    {
      // «Кто подтвердил» — это две разные подписи: руководитель строительства согласовал сам
      // заказ (ADR 0025), диспетчер взял его в работу конкретной машиной и ценой (ADR 0027).
      // В журнале нужны обе: по одной непонятно, с кого спрашивать за заказ, по другой — за цену.
      key: 'approval',
      title: 'Подтвердили',
      width: 220,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          {r.approvedAt ? (
            <Tooltip title={`Завизировал ${r.approvedByName ?? '—'} · ${formatDate(r.approvedAt)}`}>
              <Space size={4}>
                <CheckCircleOutlined style={{ color: '#52c41a' }} />
                <span>{r.approvedByName ?? '—'}</span>
              </Space>
            </Tooltip>
          ) : (
            <Typography.Text type="secondary">без визы</Typography.Text>
          )}
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.assignment ? `назначил ${r.assignment.assignedByName || '—'}` : 'не назначалась'}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      title: 'Чем закончилась',
      dataIndex: 'status',
      width: 165,
      sorter: true,
      render: (_v, r) => (
        <div style={{ lineHeight: 1.35 }}>
          {/* Причина отмены — подсказкой на теге: столбца под неё нет, а без причины отменённая
              строка журнала не отвечает на «почему не поехали». */}
          <Tooltip title={r.cancelReason ? `Причина отмены: ${r.cancelReason}` : undefined}>
            <Tag color={requestStatusColors[r.status]} style={{ marginInlineEnd: 0 }}>
              {requestStatusLabels[r.status]}
            </Tag>
          </Tooltip>
          {r.completion && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatDate(r.completion.completedAt)} · {r.completion.completedByName || '—'}
              </Typography.Text>
            </div>
          )}
        </div>
      ),
    },
    actionsColumn<VehicleRequestDto>(
      (r) => (
        // Карточка — единственное место, где видны адреса, файлы и вся хронология заявки
        // (ADR 0015). Строка журнала отвечает «что было», карточка — «как к этому пришли».
        <Typography.Link onClick={() => setViewRecord(r)}>Карточка</Typography.Link>
      ),
      110,
    ),
  ];

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select
        allowClear
        placeholder="Все типы заявок"
        style={{ width: 200 }}
        options={VEHICLE_REQUEST_TYPES.map((t) => ({
          value: t,
          label: vehicleRequestTypeLabels[t],
        }))}
        value={params.requestType as VehicleRequestType | undefined}
        onChange={(v: VehicleRequestType | undefined) => applyFilter({ requestType: v })}
      />
      <Select
        allowClear
        placeholder="Выполненные и отменённые"
        style={{ width: 215 }}
        options={CLOSED_REQUEST_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s] }))}
        value={params.status as RequestStatus | undefined}
        onChange={(v: RequestStatus | undefined) => applyFilter({ status: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 240 }}
        options={objectOptions}
        disabled={isObjectRole}
        value={params.objectId}
        onChange={(v: string | undefined) => applyFilter({ objectId: v })}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все арендодатели"
        style={{ width: 220 }}
        options={lessorOptions}
        value={params.lessorId}
        onChange={(v: string | undefined) => applyFilter({ lessorId: v })}
      />
      {/* Период — по сроку работ: журнал за месяц это «что работало в этом месяце», а не
          «что в нём успели закрыть». */}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        value={[
          params.dateFrom ? dayjs(params.dateFrom) : null,
          params.dateTo ? dayjs(params.dateTo) : null,
        ]}
        onChange={(range) =>
          applyFilter({
            dateFrom: range?.[0]?.format('YYYY-MM-DD'),
            dateTo: range?.[1]?.format('YYYY-MM-DD'),
          })
        }
      />
      <Input.Search
        allowClear
        placeholder="Поиск по № (ТС-123)"
        style={{ width: 180 }}
        onSearch={(val) => applyFilter({ num: parseVehicleRequestNumberSearch(val) })}
      />
    </Space>
  );

  return (
    <PageTableLayout filters={filters}>
      {/* Сводка — на уровне вкладок, над фильтрами: она относится ко всему журналу. */}
      <TabsExtra tabKey="history">
        <SummaryBar title="За период" items={summaryItems} />
      </TabsExtra>

      <DataTable<VehicleRequestDto>
        columns={columns}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        onChange={onTableChange}
      />

      {/* Правка из журнала не предлагается: закрытую заявку не редактируют. */}
      <VehicleRequestViewModal request={viewRecord} onClose={() => setViewRecord(null)} />
    </PageTableLayout>
  );
}
