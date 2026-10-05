import { Input, Select, Space } from 'antd';
import { REQUEST_STATUSES, requestStatusLabels, type RequestStatus } from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';
import type { VehicleRequestFeedFilters as FeedFilters } from '../model/types';

const approvalOptions = [
  { value: 'false', label: 'Ждут визы' },
  { value: 'true', label: 'Завизированные' },
];

const statusOptions = REQUEST_STATUSES.map((status) => ({
  value: status,
  label: requestStatusLabels[status],
}));

/** Desktop controls and the mobile definitions below are two renderings of the same filter port. */
export function VehicleRequestFeedFilterBar({ filters }: { filters: FeedFilters }) {
  return (
    <Space size={[12, 8]} wrap>
      <Select
        allowClear
        placeholder="Все типы заявок"
        style={{ width: 200 }}
        options={filters.documentTypeOptions}
        value={filters.documentTypeValue}
        onChange={filters.onDocumentTypeChange}
      />
      {/* The week filter belongs to one document kind and is shown only when that kind is
          selected: an order has no week at all, so a set week would cut off every order. */}
      {filters.kind === 'weekly' && (
        <Select
          allowClear
          placeholder="Все недели"
          style={{ width: 210 }}
          options={filters.weekOptions}
          value={filters.weekStart}
          onChange={filters.onWeekStartChange}
        />
      )}
      <Select
        allowClear
        placeholder="Все статусы"
        style={{ width: 150 }}
        options={statusOptions}
        value={filters.status as RequestStatus | undefined}
        onChange={filters.onStatusChange}
      />
      <Select
        allowClear
        placeholder="Любое согласование"
        style={{ width: 190 }}
        options={approvalOptions}
        value={filters.approved}
        onChange={filters.onApprovalChange}
      />
      {/* Customer, classification and assigned-vehicle selectors keep their domain hooks in the
          page; the widget owns where their desktop and mobile representations are composed.
          Customer is the same picker as in the form (docs/department-requests-plan.md, Р9): sites
          and departments in one field. There are never two customer filters side by side: a
          request has one customer, and the second filter would always yield nothing. */}
      {filters.customerControls}
      {/* Ordered equipment: a whole type or one of its categories (ADR 0028). */}
      {filters.classificationControls}
      {/* Assigned vehicle (ADR 0098): requests closed with this fleet unit. */}
      {filters.vehicleControls}
      <Input.Search
        allowClear
        placeholder="Поиск по № (ТС-123, НЗ-12)"
        style={{ width: 210 }}
        onSearch={filters.onNumberSearch}
      />
    </Space>
  );
}

/** The same filters as definitions for the phone filter sheet (ADR 0030). */
export function vehicleRequestFeedMobileFilters(filters: FeedFilters): FilterDefinition[] {
  return [
    {
      kind: 'select',
      key: 'requestType',
      label: 'Тип заявки',
      value: filters.documentTypeValue,
      options: filters.documentTypeOptions,
      placeholder: 'Все типы заявок',
      onChange: filters.onDocumentTypeChange,
    },
    // Week only for the selected document kind, as in the desktop bar: an order has no week, and
    // a set week filter would cut off every order.
    ...(filters.kind === 'weekly'
      ? [
          {
            kind: 'select',
            key: 'weekStart',
            label: 'Неделя',
            value: filters.weekStart,
            options: filters.weekOptions,
            placeholder: 'Все недели',
            onChange: filters.onWeekStartChange,
          } as const,
        ]
      : []),
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: filters.status,
      options: statusOptions,
      placeholder: 'Все статусы',
      onChange: (value) => filters.onStatusChange(value as RequestStatus | undefined),
    },
    {
      kind: 'select',
      key: 'approved',
      label: 'Согласование',
      value: filters.approved,
      options: approvalOptions,
      placeholder: 'Любое согласование',
      onChange: filters.onApprovalChange,
    },
    // The same customer picker as the desktop bar (Р9): a choice clears the other half of the
    // object/department pair here too.
    filters.customerMobileFilter,
    filters.classificationMobileFilter,
    filters.vehicleMobileFilter,
    {
      kind: 'text',
      key: 'num',
      label: '№ документа',
      value: filters.num != null ? String(filters.num) : undefined,
      placeholder: 'Например, ТС-123 или НЗ-12',
      onChange: (value) => filters.onNumberSearch(value ?? ''),
    },
  ];
}
