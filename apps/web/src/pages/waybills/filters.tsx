import type { ReactNode } from 'react';
import { DatePicker, Input, Select, Space } from 'antd';
import dayjs from 'dayjs';
import {
  WAYBILL_FORM_CODES,
  WAYBILL_STATUSES,
  waybillFormLabels,
  waybillStatusLabels,
} from '@technic/contracts';
import type { FilterDefinition, FilterOption } from '@shared/ui';

/**
 * Waybill journal filters: a field bar for desktop and the same values as descriptions for the
 * phone sheet (ADR 0079, ADR 0030).
 *
 * A separate file because every filter is built twice — bar and sheet; keeping both sets in the
 * page would bury the journal's own logic (printing, cancellation, batch selection) under them.
 */

/**
 * Filter values the journal sends to the server, without paging and sorting.
 *
 * The index signature matches the list params (`BaseParams`): values come straight from them and
 * go back as a patch, and without it the two descriptions of one set would not type-check.
 */
export interface WaybillFilterValues {
  search?: string;
  formCode?: string;
  status?: string;
  objectId?: string;
  vehicleId?: string;
  driverPersonId?: string;
  /**
   * Corrections (ADR 0101 item 20) as the string `'true'`/`'false'`, like other portal list flags:
   * filter values go into the request URL as is, and a boolean would need converting both ways.
   */
  correction?: string;
  [key: string]: unknown;
}

/** Both bounds are optional: people look a sheet up by number without knowing its date. */
export type WaybillDateRange = [dayjs.Dayjs | null, dayjs.Dayjs | null] | null;

/**
 * Options of a directory-backed filter. `null` means the filter is absent altogether: the reader
 * has no right to the directory, and a filter answering with an empty list is worse than none —
 * it reads as "there are no drivers/sites in the portal".
 */
type DirectoryFilter = { options: FilterOption[]; loading: boolean } | null;

interface Options {
  values: WaybillFilterValues;
  onChange: (patch: WaybillFilterValues) => void;
  /** Kept separately because the searched number also arrives from outside (`?number=…` link). */
  searchText: string;
  onSearchTextChange: (text: string) => void;
  range: WaybillDateRange;
  onRangeChange: (range: WaybillDateRange) => void;
  vehicles: { options: FilterOption[]; loading: boolean };
  /** Holders of the "view and print" grant have no `drivers.read` (ADR 0192). */
  drivers: DirectoryFilter;
  /** Sites of the orders the sheet serves; `null` without `directories.read`. */
  objects: DirectoryFilter;
}

const DATE = 'YYYY-MM-DD';

const formOptions = WAYBILL_FORM_CODES.map((code) => ({
  value: code,
  label: waybillFormLabels[code],
}));
const statusOptions = WAYBILL_STATUSES.map((status) => ({
  value: status,
  label: waybillStatusLabels[status],
}));

/** Two-sided on purpose (ADR 0101 item 20): "ordinary only" is asked as often as the reverse. */
const correctionOptions = [
  { value: 'true', label: 'Только коррекции' },
  { value: 'false', label: 'Без коррекций' },
];

export function waybillFiltersBar(o: Options): ReactNode {
  return (
    <Space size={[12, 8]} wrap>
      <Input.Search
        allowClear
        // Matches both the full number and its tail: "00000004897" is called "4897" on paper.
        placeholder="Номер листа"
        style={{ width: 220 }}
        value={o.searchText}
        onChange={(e) => o.onSearchTextChange(e.target.value)}
        onSearch={(v) => o.onChange({ search: v.trim() || undefined })}
      />
      <Select
        allowClear
        placeholder="Все бланки"
        style={{ width: 260 }}
        options={formOptions}
        value={o.values.formCode}
        onChange={(v: string | undefined) => o.onChange({ formCode: v })}
      />
      <Select
        allowClear
        placeholder="Все статусы"
        style={{ width: 160 }}
        options={statusOptions}
        value={o.values.status}
        onChange={(v: string | undefined) => o.onChange({ status: v })}
      />
      {o.objects && (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все площадки"
          style={{ width: 260 }}
          options={o.objects.options}
          loading={o.objects.loading}
          value={o.values.objectId}
          onChange={(v: string | undefined) => o.onChange({ objectId: v })}
        />
      )}
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Вся техника"
        style={{ width: 220 }}
        options={o.vehicles.options}
        loading={o.vehicles.loading}
        value={o.values.vehicleId}
        onChange={(v: string | undefined) => o.onChange({ vehicleId: v })}
      />
      {o.drivers && (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все водители"
          style={{ width: 220 }}
          options={o.drivers.options}
          loading={o.drivers.loading}
          value={o.values.driverPersonId}
          onChange={(v: string | undefined) => o.onChange({ driverPersonId: v })}
        />
      )}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['На дату с', 'по']}
        value={o.range}
        onChange={(v) => o.onRangeChange(v as WaybillDateRange)}
      />
      {/* A select, not a checkbox: the filter is two-sided, and a checkbox can express only one
        side, making "ordinary only" unreachable. */}
      <Select
        allowClear
        placeholder="Все листы"
        style={{ width: 190 }}
        options={correctionOptions}
        value={o.values.correction}
        onChange={(v: string | undefined) => o.onChange({ correction: v })}
      />
    </Space>
  );
}

export function waybillMobileFilters(o: Options): FilterDefinition[] {
  return [
    {
      kind: 'select',
      key: 'formCode',
      label: 'Бланк',
      value: o.values.formCode,
      options: formOptions,
      placeholder: 'Все бланки',
      onChange: (v) => o.onChange({ formCode: v }),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: o.values.status,
      options: statusOptions,
      placeholder: 'Все статусы',
      onChange: (v) => o.onChange({ status: v }),
    },
    ...(o.objects
      ? [
          {
            kind: 'select' as const,
            key: 'objectId',
            label: 'Площадка',
            value: o.values.objectId,
            options: o.objects.options,
            placeholder: 'Все площадки',
            loading: o.objects.loading,
            onChange: (v: string | undefined) => o.onChange({ objectId: v }),
          },
        ]
      : []),
    {
      kind: 'select',
      key: 'vehicleId',
      label: 'Техника',
      value: o.values.vehicleId,
      options: o.vehicles.options,
      placeholder: 'Вся техника',
      loading: o.vehicles.loading,
      onChange: (v) => o.onChange({ vehicleId: v }),
    },
    ...(o.drivers
      ? [
          {
            kind: 'select' as const,
            key: 'driverPersonId',
            label: 'Водитель',
            value: o.values.driverPersonId,
            options: o.drivers.options,
            placeholder: 'Все водители',
            loading: o.drivers.loading,
            onChange: (v: string | undefined) => o.onChange({ driverPersonId: v }),
          },
        ]
      : []),
    {
      // A select for the same reason as on desktop: a switch's "off" means "unset", not "false".
      kind: 'select',
      key: 'correction',
      label: 'Коррекции',
      value: o.values.correction,
      options: correctionOptions,
      placeholder: 'Все листы',
      onChange: (v) => o.onChange({ correction: v }),
    },
    {
      kind: 'dateRange',
      key: 'range',
      label: 'На дату',
      from: o.range?.[0]?.format(DATE),
      to: o.range?.[1]?.format(DATE),
      onChange: (from, to) =>
        o.onRangeChange(from || to ? [from ? dayjs(from) : null, to ? dayjs(to) : null] : null),
    },
  ];
}
