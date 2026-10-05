import { useState, type ReactNode } from 'react';
import { DatePicker, Input, Select, Space, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  actsForCounterparty,
  CLOSED_REQUEST_STATUSES,
  parseVehicleRequestNumberSearch,
  type RequestStatus,
  requestStatusLabels,
  type VehicleRequestDto,
  VEHICLE_REQUEST_TYPES,
  vehicleRequestTypeLabels,
  type VehicleRequestType,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { useVehicleClassificationFilter } from '@entities/vehicle-type';
import { useRequestCustomerDefaults, useRequestCustomerFilter } from '@features/request-customer';
import { useLessorOptions, useVehicleFilter } from '@features/vehicle-request-filters';
import { formatMoney, useListParams, useOpenedRecord } from '@shared/lib';
import {
  DataTable,
  type FilterDefinition,
  PageTableLayout,
  sortOptionsFrom,
  SummaryBar,
  TabsExtra,
  useActiveTabKey,
} from '@shared/ui';
import { historyCard } from './historyCard';
import { historyColumns } from './historyColumns';

interface HistoryParams {
  requestType?: string;
  status?: string;
  /** Request customer (ADR 0040): the "Object/department" picker fills exactly one of the two. */
  objectId?: string;
  departmentId?: string;
  /**
   * Ordered equipment (ADR 0028) as a set: t<uuid> is a whole type, c<uuid> one of its categories.
   */
  classifications?: string;
  /** The vehicle that closed the request (ADR 0098), next to "rented from whom". */
  vehicleId?: string;
  lessorId?: string;
  num?: number;
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Journal of closed vehicle orders (ADR 0029). The first tab answers "what is in work now"; this
 * one answers the later questions: when and for which site equipment was taken, for how long, who
 * approved the order, which lessor it was rented from and what it cost.
 *
 * So a journal row is not a request-list row: instead of status and approval buttons it carries the
 * completion fact (worked amount and cost) and both names, the one who approved the order and the
 * one who assigned the vehicle. Open requests are not here: while a request is run it has no
 * outcome, and each request's event chronology lives in its card (ADR 0015).
 *
 * The card itself is injected (renderRequest) because the page adapter binds it to the work-day tab
 * that still lives in pages/vehicle.
 */
export function VehicleRequestHistory({
  renderRequest,
}: {
  renderRequest: (request: VehicleRequestDto | null, onClose: () => void) => ReactNode;
}) {
  const { user } = useAuth();
  const customerDefaults = useRequestCustomerDefaults();
  // A lessor sees only its own requests (ADR 0038): the "rented from whom" filter would repeat its
  // single option, and the list of other lessors is none of its business.
  const isLessor = actsForCounterparty(user, 'vehicle_lessor');
  const { params, setParams, setSort, onTableChange } = useListParams<HistoryParams>(
    // The default is the account's predetermined customer: the object of an object role (ADR 0039)
    // or the department of a department role (ADR 0040), and nothing for a department with sites
    // (ADR 0201). The server returns only the caller's scope anyway; the journal just does not make
    // people pick what is already decided.
    {
      objectId: customerDefaults.objectId,
      departmentId: customerDefaults.departmentId,
    },
    { searchKeys: ['comment'] },
  );
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((previous) => ({ ...previous, ...patch, page: 1 }));

  const classificationFilter = useVehicleClassificationFilter({
    classifications: params.classifications,
    onChange: applyFilter,
  });
  // "Which vehicle" is a question separate from "rented from whom" (the lessor filter below): one
  // unit is rented from one lessor, and one lessor rents out different units (ADR 0098).
  const vehicleFilter = useVehicleFilter({ vehicleId: params.vehicleId, onChange: applyFilter });
  /*
   * The "Object/department" picker replaced the former object filter
   * (docs/department-requests-plan.md, R9), using the module-wide filter: closed department
   * requests sit in the journal alongside object ones, and the journal had no second axis at all.
   * The options are computed by the same hook as the form, by the account's axis; a reader without
   * an axis of their own (observer, lessor) sees both groups, which is not an access extension: the
   * server narrows the result, not the filter.
   */
  const customerFilter = useRequestCustomerFilter({
    objectId: params.objectId,
    departmentId: params.departmentId,
    onChange: applyFilter,
    // Longer than the shared label: next to the request-type and vehicle filters a short
    // "Customer" would get lost.
    label: 'Объект/отдел',
    placeholder: 'Все объекты и отделы',
  });
  const { options: lessorOptions } = useLessorOptions();
  const { data, isFetching } = useQuery({
    queryKey: vehicleRequestKeys.closedList(params),
    queryFn: () => vehicleRequestsApi.historyList(params),
  });
  // The summary uses the same filters as the table: a total that is not about what the person sees
  // misleads more surely than no total at all.
  const { data: summary } = useQuery({
    queryKey: vehicleRequestKeys.closedSummary(params),
    queryFn: () => vehicleRequestsApi.historySummary(params),
  });

  const [viewRecord, setViewRecord] = useState<VehicleRequestDto | null>(null);
  // A closed request named in the URL: links from a route's composition or the waybill journal lead
  // here, because the request list no longer holds a closed request (ADR 0029).
  const opened = useOpenedRecord<VehicleRequestDto>({
    active: useActiveTabKey() === 'history',
    queryKey: (id) => vehicleRequestKeys.detail(id),
    fetch: (id) => vehicleRequestsApi.get(id),
  });
  const columns = historyColumns(setViewRecord);
  const card = historyCard(setViewRecord);
  const summaryItems = [
    { label: 'Закрыто', value: summary?.total ?? 0 },
    { label: requestStatusLabels.done, value: summary?.done ?? 0 },
    { label: requestStatusLabels.cancelled, value: summary?.cancelled ?? 0 },
    {
      label: 'Стоимость',
      value: (
        <Space size={6}>
          <span>{formatMoney(summary?.totalCost ?? 0)}</span>
          {/* Without this caveat the total reads as "this is all we spent", while part of the work
              is closed with own vehicles that are not counted in money. */}
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

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select
        allowClear
        placeholder="Все типы заявок"
        style={{ width: 200 }}
        options={VEHICLE_REQUEST_TYPES.map((type) => ({
          value: type,
          label: vehicleRequestTypeLabels[type],
        }))}
        value={params.requestType as VehicleRequestType | undefined}
        onChange={(value: VehicleRequestType | undefined) => applyFilter({ requestType: value })}
      />
      <Select
        allowClear
        placeholder="Выполненные и отменённые"
        style={{ width: 215 }}
        options={CLOSED_REQUEST_STATUSES.map((status) => ({
          value: status,
          label: requestStatusLabels[status],
        }))}
        value={params.status as RequestStatus | undefined}
        onChange={(value: RequestStatus | undefined) => applyFilter({ status: value })}
      />
      {/* An empty filter value means "all", so the field does not pre-fill a single option by
          itself: the default comes from the pair above. */}
      {customerFilter.controls}
      {/* Ordered equipment: a whole type or one of its categories (ADR 0028). */}
      {classificationFilter.controls}
      {/* The vehicle that closed the request (ADR 0098). */}
      {vehicleFilter.controls}
      {!isLessor && (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все арендодатели"
          style={{ width: 220 }}
          options={lessorOptions}
          value={params.lessorId}
          onChange={(value: string | undefined) => applyFilter({ lessorId: value })}
        />
      )}
      {/* The period is by work term: a monthly journal means "what worked this month", not "what
          got closed in it". */}
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
        onSearch={(value) => applyFilter({ num: parseVehicleRequestNumberSearch(value) })}
      />
    </Space>
  );

  // The same filters as descriptions for the phone filter sheet (ADR 0030).
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'requestType',
      label: 'Тип заявки',
      value: params.requestType,
      options: VEHICLE_REQUEST_TYPES.map((type) => ({
        value: type,
        label: vehicleRequestTypeLabels[type],
      })),
      placeholder: 'Все типы заявок',
      onChange: (value) => applyFilter({ requestType: value }),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Чем закончилась',
      value: params.status,
      options: CLOSED_REQUEST_STATUSES.map((status) => ({
        value: status,
        label: requestStatusLabels[status],
      })),
      placeholder: 'Выполненные и отменённые',
      onChange: (value) => applyFilter({ status: value }),
    },
    customerFilter.mobileFilter,
    classificationFilter.mobileFilter,
    vehicleFilter.mobileFilter,
    ...(isLessor
      ? []
      : [
          {
            kind: 'select' as const,
            key: 'lessorId',
            label: 'Арендодатель',
            value: params.lessorId,
            options: lessorOptions,
            placeholder: 'Все арендодатели',
            onChange: (value: string | undefined) => applyFilter({ lessorId: value }),
          },
        ]),
    {
      // By work term, as on the desktop panel.
      kind: 'dateRange',
      key: 'period',
      label: 'Период работ',
      from: params.dateFrom,
      to: params.dateTo,
      onChange: (dateFrom, dateTo) => applyFilter({ dateFrom, dateTo }),
    },
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: params.num != null ? String(params.num) : undefined,
      placeholder: 'Например, ТС-123',
      onChange: (value) => applyFilter({ num: parseVehicleRequestNumberSearch(value ?? '') }),
    },
  ];

  return (
    <PageTableLayout
      filters={filters}
      mobile={{
        filters: mobileFilters,
        sort: {
          options: sortOptionsFrom(columns, { num: 'Номер заявки', term: 'Срок работ' }),
          sortBy: params.sortBy,
          sortOrder: params.sortOrder,
          onChange: setSort,
        },
      }}
    >
      {/* The summary sits at tab level above the filters: it is about the whole journal. */}
      <TabsExtra tabKey="history">
        <SummaryBar title="За период" items={summaryItems} />
      </TabsExtra>
      <DataTable<VehicleRequestDto>
        columns={columns}
        card={card}
        data={data?.items ?? []}
        total={data?.total ?? 0}
        loading={isFetching}
        page={params.page}
        pageSize={params.pageSize}
        sortBy={params.sortBy}
        sortOrder={params.sortOrder}
        onChange={onTableChange}
      />
      {renderRequest(viewRecord ?? opened.record, () => {
        setViewRecord(null);
        opened.clear();
      })}
    </PageTableLayout>
  );
}
