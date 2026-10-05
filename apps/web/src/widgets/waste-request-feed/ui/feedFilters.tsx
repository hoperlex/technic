import type { ReactNode } from 'react';
import { Button, DatePicker, Input, Select, Space, Tooltip } from 'antd';
import dayjs from 'dayjs';
import {
  OPEN_WASTE_STATUSES,
  REQUEST_TYPES,
  requestStatusLabels,
  requestTypeLabels,
} from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';
import type { WasteFilterOptions } from '../model/types';

const DATE = 'YYYY-MM-DD';
const requestTypeOptions = REQUEST_TYPES.map((type) => ({
  value: type,
  label: requestTypeLabels[type],
}));

// Completed and cancelled requests live in History, and the working endpoint rejects them.
const statusOptions = OPEN_WASTE_STATUSES.map((status) => ({
  value: status,
  label: requestStatusLabels[status],
}));

/** Desktop filters preserve the original order, dimensions and option semantics. */
export function WasteRequestFeedFilterBar({ options }: { options: WasteFilterOptions }): ReactNode {
  return (
    <Space size={[12, 8]} wrap>
      {/* Popup width is governed by the portal-level rule (ADR 0136), not duplicated here. */}
      <Select
        style={{ width: 240 }}
        value={options.objects.value}
        onChange={options.objects.onChange}
        options={[{ value: '', label: 'Все объекты' }, ...options.objects.options]}
        showSearch
        optionFilterProp="label"
        disabled={options.objects.disabled}
      />
      <Select
        style={{ width: 190 }}
        allowClear
        placeholder="Все типы заявок"
        options={requestTypeOptions}
        value={options.values.requestType}
        onChange={(value: string | undefined) => options.onChange({ requestType: value })}
      />
      <Select
        style={{ width: 150 }}
        allowClear
        placeholder="Все статусы"
        options={statusOptions}
        value={options.values.status}
        onChange={(value: string | undefined) => options.onChange({ status: value })}
      />
      <Select
        style={{ width: 200 }}
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Контейнер / машина"
        options={options.subject.options}
        value={options.subject.value}
        onChange={options.subject.onChange}
      />
      {/* Delivery is filtered by calendar dates while API parameters use inclusive instants. */}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['Подача с', 'по']}
        value={[
          options.values.deliveryFrom ? dayjs(options.values.deliveryFrom) : null,
          options.values.deliveryTo ? dayjs(options.values.deliveryTo) : null,
        ]}
        onChange={(range) =>
          options.onChange({
            deliveryFrom: range?.[0]?.format(DATE),
            deliveryTo: range?.[1]?.format(DATE),
          })
        }
      />
      {options.operators && (
        <Select
          style={{ width: 200 }}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все операторы"
          options={options.operators.options}
          loading={options.operators.loading}
          value={options.values.operatorCounterpartyId}
          onChange={(value: string | undefined) =>
            options.onChange({ operatorCounterpartyId: value })
          }
        />
      )}
      {/* The review registry uses the same server predicate and permission as the ticket badge. */}
      {options.ticketReview && (
        <Tooltip title="Заявки, где талоны ждут человека: не подтверждены, спорны, не прочитаны или расходятся с закрытием">
          <Button
            type={options.values.ticketReview ? 'primary' : 'default'}
            onClick={() =>
              options.onChange({
                ticketReview: options.values.ticketReview ? undefined : 'pending',
              })
            }
          >
            Требуют разбора
          </Button>
        </Tooltip>
      )}
      <Input
        style={{ width: 160 }}
        allowClear
        placeholder="Поиск по № заявки"
        value={options.num.text}
        onChange={(event) => options.num.onChange(event.target.value)}
      />
    </Space>
  );
}

/** Mobile filter descriptions share the same values and handlers as the desktop bar. */
export function wasteRequestFeedMobileFilters(options: WasteFilterOptions): FilterDefinition[] {
  return [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: options.objects.value || undefined,
      options: options.objects.options,
      placeholder: 'Все объекты',
      loading: options.objects.loading,
      disabled: options.objects.disabled,
      onChange: (value) => options.objects.onChange(value ?? ''),
    },
    {
      kind: 'select',
      key: 'requestType',
      label: 'Тип заявки',
      value: options.values.requestType,
      options: requestTypeOptions,
      placeholder: 'Все типы заявок',
      onChange: (value) => options.onChange({ requestType: value }),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: options.values.status,
      options: statusOptions,
      placeholder: 'Все статусы',
      onChange: (value) => options.onChange({ status: value }),
    },
    {
      kind: 'select',
      key: 'containerTypeId',
      label: 'Контейнер / машина',
      value: options.subject.value,
      options: options.subject.options,
      placeholder: 'Любой',
      onChange: options.subject.onChange,
    },
    {
      kind: 'dateRange',
      key: 'delivery',
      label: 'Период подачи',
      from: options.values.deliveryFrom,
      to: options.values.deliveryTo,
      onChange: (deliveryFrom, deliveryTo) => options.onChange({ deliveryFrom, deliveryTo }),
    },
    ...(options.operators
      ? [
          {
            kind: 'select' as const,
            key: 'operatorCounterpartyId',
            label: 'Оператор вывоза',
            value: options.values.operatorCounterpartyId,
            options: options.operators.options,
            placeholder: 'Все операторы',
            loading: options.operators.loading,
            onChange: (value: string | undefined) =>
              options.onChange({ operatorCounterpartyId: value }),
          },
        ]
      : []),
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: options.num.text || undefined,
      placeholder: 'Например, М-128',
      onChange: (value) => options.num.onChange(value ?? ''),
    },
    ...(options.ticketReview
      ? [
          {
            kind: 'toggle' as const,
            key: 'ticketReview',
            label: 'Требуют разбора',
            value: options.values.ticketReview === 'pending',
            onChange: (value: boolean) =>
              options.onChange({ ticketReview: value ? 'pending' : undefined }),
          },
        ]
      : []),
  ];
}
