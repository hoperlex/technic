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

// Working statuses only (ADR 0135): completed and cancelled requests live in the "История" tab and
// the working endpoint does not return them at all; a filter option that ends in a refusal is
// worse than no option.
const statusOptions = OPEN_WASTE_STATUSES.map((status) => ({
  value: status,
  label: requestStatusLabels[status],
}));

/**
 * Desktop filter bar: object, type, status, subject, delivery period, operator, review and number.
 * The mobile definitions below are the same filters for the phone sheet (ADR 0030) and share their
 * values and handlers, so the two cannot drift.
 */
export function WasteRequestFeedFilterBar({ options }: { options: WasteFilterOptions }): ReactNode {
  return (
    <Space size={[12, 8]} wrap>
      {/* The field stays narrow so the bar does not spread, while the opened list is wider than
          the field: a site caption with its address is longer than any sensible filter, and cut
          by an ellipsis it stops answering "is this the right site". Popup width is governed by
          the portal-level rule in the root provider (ADR 0136), not duplicated here. */}
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
      {/* The period is by delivery date, as in the "История" journal: the list is read by when
          things were hauled, not when the request was created. Both bounds are optional: "since
          the start of the month" and "until Friday" are asked as often as a full range. Calendar
          dates here become inclusive instants in the API parameters. */}
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
      {/* The working registry of whoever checks the paper (ADR 0114, Р24), behind its own right
          (Р25). A request with no discrepancy at all is still selected while its tickets are
          unconfirmed: otherwise a correctly recognised ticket would stay unconfirmed forever, and
          an unconfirmed ticket does not reserve its number. The server filter (ticketReview =
          pending in the waste-requests route) selects pending work, not only discrepancies, and
          the tooltip text below describes exactly that. */}
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

/**
 * The same filters as definitions for the phone sheet (ADR 0030). The desktop bar stays a bar: it
 * is fully visible there, and rebuilding it from definitions would be a rewrite for uniformity's
 * sake. Values and handlers are shared with it, so there is nothing to drift.
 */
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
      // With one object the filter is shown but fixed; with several it chooses among the own ones.
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
