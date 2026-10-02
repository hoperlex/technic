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
  objectId?: string;
  departmentId?: string;
  classifications?: string;
  vehicleId?: string;
  lessorId?: string;
  num?: number;
  dateFrom?: string;
  dateTo?: string;
}

/** Closed vehicle-request journal with desktop table and mobile cards. */
export function VehicleRequestHistory({
  renderRequest,
}: {
  renderRequest: (request: VehicleRequestDto | null, onClose: () => void) => ReactNode;
}) {
  const { user } = useAuth();
  const customerDefaults = useRequestCustomerDefaults();
  const isLessor = actsForCounterparty(user, 'vehicle_lessor');
  const { params, setParams, setSort, onTableChange } = useListParams<HistoryParams>(
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
  const vehicleFilter = useVehicleFilter({ vehicleId: params.vehicleId, onChange: applyFilter });
  const customerFilter = useRequestCustomerFilter({
    objectId: params.objectId,
    departmentId: params.departmentId,
    onChange: applyFilter,
    label: 'Объект/отдел',
    placeholder: 'Все объекты и отделы',
  });
  const { options: lessorOptions } = useLessorOptions();
  const { data, isFetching } = useQuery({
    queryKey: vehicleRequestKeys.closedList(params),
    queryFn: () => vehicleRequestsApi.historyList(params),
  });
  const { data: summary } = useQuery({
    queryKey: vehicleRequestKeys.closedSummary(params),
    queryFn: () => vehicleRequestsApi.historySummary(params),
  });

  const [viewRecord, setViewRecord] = useState<VehicleRequestDto | null>(null);
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
      {customerFilter.controls}
      {classificationFilter.controls}
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
