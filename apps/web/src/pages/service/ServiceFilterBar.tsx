import type { ReactNode } from 'react';
import { Checkbox, DatePicker, Input, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { FilterReset, type FilterDefinition } from '@shared/ui';

const DATE = 'YYYY-MM-DD';

/**
 * ПАНЕЛЬ ОТБОРОВ ДЕСКТОПА — рисование по тем же описаниям, что уходят в шит телефона (§9.2).
 *
 * ОТДЕЛЬНЫМ ФАЙЛОМ ОТ САМИХ ОПИСАНИЙ, и это не деление ради числа строк. Здесь нет ни одного
 * решения о том, КАКИЕ отборы у списка заявок бывают и кому какой положен: файл не знает ни про
 * права, ни про справочники, ни про заявки вовсе — он умеет нарисовать четыре вида описания и
 * кнопку сброса. Решения живут в `serviceRequestFilters.tsx`, и именно поэтому «одно описание на
 * десктоп и телефон» осталось целым: расходятся не рисование и рисование, а описание и описание,
 * а описание здесь по-прежнему одно.
 *
 * Оба читателя (`RequestsTab`, `WarrantiesTab`) берут отсюда готовую панель и ничего не собирают
 * разметкой сами.
 */
/**
 * Один фильтр в панели десктопа. Обычная функция, а не компонент: она вызывается прямо из
 * разметки панели и своего состояния не имеет — объявленный внутри компонент пересоздавался бы
 * на каждый рендер и терял бы фокус поля при вводе.
 */
function renderFilter(filter: FilterDefinition): ReactNode {
  switch (filter.kind) {
    case 'select':
      return (
        <Select
          key={filter.key}
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 200 }}
          placeholder={filter.placeholder ?? filter.label}
          options={filter.options}
          loading={filter.loading}
          disabled={filter.disabled}
          value={filter.value}
          onChange={(v) => filter.onChange(v)}
        />
      );
    case 'text':
      return (
        <Input
          key={filter.key}
          allowClear
          style={{ width: 180 }}
          placeholder={filter.placeholder ?? filter.label}
          value={filter.value}
          onChange={(e) => filter.onChange(e.target.value || undefined)}
        />
      );
    case 'toggle':
      return (
        <Checkbox
          key={filter.key}
          checked={filter.value}
          disabled={filter.disabled}
          onChange={(e) => filter.onChange(e.target.checked)}
        >
          {filter.label}
        </Checkbox>
      );
    case 'dateRange':
      return (
        <DatePicker.RangePicker
          key={filter.key}
          format="DD.MM.YYYY"
          allowEmpty={[true, true]}
          value={[filter.from ? dayjs(filter.from) : null, filter.to ? dayjs(filter.to) : null]}
          onChange={(range) =>
            filter.onChange(
              range?.[0] ? range[0].format(DATE) : undefined,
              range?.[1] ? range[1].format(DATE) : undefined,
            )
          }
        />
      );
  }
}

/**
 * Панель фильтров десктопа из тех же описаний, что уходят в шит телефона.
 *
 * `reset` — выход из набора одним движением (ADR 0139). Не передан — кнопки нет: список, отборы
 * которого живут один сеанс, разбирается теми же крестиками, что и собран.
 */
export function ServiceFilterBar({
  filters,
  reset,
}: {
  filters: FilterDefinition[];
  reset?: { active: boolean; onClick: () => void };
}) {
  return (
    <Space wrap>
      {filters.map(renderFilter)}
      {reset ? <FilterReset {...reset} /> : null}
    </Space>
  );
}
