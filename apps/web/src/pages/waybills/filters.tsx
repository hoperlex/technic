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
 * Отбор журнала путевых листов: полоса полей для десктопа и те же значения описаниями для шита
 * телефона (ADR 0079, ADR 0030).
 *
 * Отдельным файлом, потому что фильтров семь и собираются они дважды — панелью и шитом. Держать
 * два этих набора в самой странице значило бы утопить в них журнал: печать, аннулирование и выбор
 * пачки читаются рядом, а фильтры от них ничего не требуют, кроме значений.
 */

/**
 * Что журнал спрашивает у сервера: значения фильтров без страницы и сортировки.
 *
 * Индекс-сигнатура — та же, что у параметров списка (`BaseParams`): значения приходят прямо из них
 * и туда же уходят патчем, и без неё два описания одного набора не сошлись бы по типам.
 */
export interface WaybillFilterValues {
  search?: string;
  formCode?: string;
  status?: string;
  vehicleId?: string;
  driverPersonId?: string;
  /**
   * Только коррекции (ADR 0101 п. 20) — строкой `'true'`, как и прочие флаги списков портала:
   * значения фильтров уходят в адрес запроса как есть, и булев тип пришлось бы переводить туда и
   * обратно в двух местах.
   */
  correction?: string;
  [key: string]: unknown;
}

/** Период выдачи: обе границы необязательны — за номером листа приходят и без даты. */
export type WaybillDateRange = [dayjs.Dayjs | null, dayjs.Dayjs | null] | null;

interface Options {
  values: WaybillFilterValues;
  onChange: (patch: WaybillFilterValues) => void;
  /** Текст в поле поиска: искомое приходит и снаружи (ссылка `?number=…`), и его видно в поле. */
  searchText: string;
  onSearchTextChange: (text: string) => void;
  range: WaybillDateRange;
  onRangeChange: (range: WaybillDateRange) => void;
  vehicles: { options: FilterOption[]; loading: boolean };
  drivers: { options: FilterOption[]; loading: boolean };
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

/**
 * Коррекции — отбор двусторонний (ADR 0101 п. 20). Значения строковые, потому что фильтры живут в
 * адресной строке: `correction=true|false` уходит в запрос как есть, а снятый отбор не уходит вовсе.
 */
const correctionOptions = [
  { value: 'true', label: 'Только коррекции' },
  { value: 'false', label: 'Без коррекций' },
];

/** Полоса фильтров: номер, бланк, статус, машина, водитель, период выдачи и коррекции. */
export function waybillFiltersBar(o: Options): ReactNode {
  return (
    <Space size={[12, 8]} wrap>
      <Input.Search
        allowClear
        // Номер ищется и целиком, и хвостом: «00000004897» на бумаге называют «4897».
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
      {/* Период выдачи: журнал читают по дням, но в отличие от маршрутов не только по ним — за
        номером листа приходят и без даты, поэтому обе границы необязательны. */}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['На дату с', 'по']}
        value={o.range}
        onChange={(v) => o.onRangeChange(v as WaybillDateRange)}
      />
      {/* Коррекции (ADR 0101 п. 20): этим журнал читает бухгалтерия — «что правилось задним
        числом» — и им же объясняется день, в котором стоят два номера.

        Select, а не флажок: отбор двусторонний и на сервере, и в контракте. Вопрос «что шло
        обычным порядком» задают не реже обратного — им сверяют месяц, из которого коррекции
        вынуты, — а флажок отвечает только на один из двух и второй делает недостижимым. */}
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

/** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
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
    {
      kind: 'select',
      key: 'driverPersonId',
      label: 'Водитель',
      value: o.values.driverPersonId,
      options: o.drivers.options,
      placeholder: 'Все водители',
      loading: o.drivers.loading,
      onChange: (v) => o.onChange({ driverPersonId: v }),
    },
    {
      // Выбором из двух значений, а не переключателем: отбор двусторонний (см. полосу десктопа), а
      // переключатель второе значение выразить не может — «выключен» у него значит «не задан».
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
