import type { ReactNode } from 'react';
import { Checkbox, DatePicker, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { DeferredSearchInput, FilterReset, type FilterDefinition } from '@shared/ui';

/**
 * Панель отбора аренд на десктопе: как выглядят фильтры, описанные соседним
 * [mechRequestFilters](mechRequestFilters.tsx).
 *
 * Отдельным файлом от самих описаний — по границе вопроса, а не ради числа строк: там считают,
 * какие фильтры у списка есть и что они значат, здесь рисуют их в ряд. Описание при этом
 * по-прежнему одно на десктоп и телефон (ADR 0030): шит собирает по нему же свои поля, и забыть
 * половину нельзя.
 */

const DATE = 'YYYY-MM-DD';

/**
 * One filter in the desktop bar. A plain function, not a component: it is called right from the
 * bar's markup and has no state of its own — a component declared inside would be recreated on
 * every render and lose the field's focus while typing.
 *
 * Exported for the lessor's list (lessor receipt plan, P12): his two filters are drawn by the same
 * controls, while the office bar's number search does not fit him.
 */
export function renderMechFilter(filter: FilterDefinition): ReactNode {
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
          onOpenChange={(open) => open && filter.onOpen?.()}
          onChange={(v) => filter.onChange(v)}
        />
      );
    case 'toggle':
      // A checkbox, not a switch: in the desktop bar it stands in one row with the filter fields,
      // and its label must read left to right with them — as the archive's in the vehicle registry.
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
          style={{ width: 250 }}
          allowEmpty={[true, true]}
          placeholder={['Аренда с', 'по']}
          value={[filter.from ? dayjs(filter.from) : null, filter.to ? dayjs(filter.to) : null]}
          onChange={(range) =>
            filter.onChange(
              range?.[0] ? range[0].format(DATE) : undefined,
              range?.[1] ? range[1].format(DATE) : undefined,
            )
          }
        />
      );
    default:
      // The module's lists have no other kinds: the descriptions are built next door, and a stub
      // branch would catch only their own typo — silently and on screen.
      return null;
  }
}

/**
 * Панель фильтров десктопа из тех же описаний, что уходят в шит телефона, плюс поиск по номеру.
 *
 * Номер стоит в панели, а не в шите: «МХ-42» набирают, придя из переписки, — это разовый вопрос к
 * списку, а не срез, в котором работают.
 */
export function MechFilterBar({
  filters,
  num,
  reset,
  extra,
}: {
  filters: FilterDefinition[];
  num: { text: string; onChange: (raw: string) => void };
  reset?: { active: boolean; onClick: () => void };
  /**
   * Действие над тем же срезом — выгрузка журнала. В этом же ряду, а не в шапке страницы: кнопка
   * скачивает ровно то, что задано соседними полями, и уехав от них, она читалась бы как «выгрузи
   * всё».
   */
  extra?: ReactNode;
}) {
  return (
    <Space wrap>
      {filters.map(renderMechFilter)}
      <DeferredSearchInput
        style={{ width: 160 }}
        allowClear
        placeholder="Поиск по № заявки"
        value={num.text}
        onChange={(value) => num.onChange(value ?? '')}
      />
      {reset ? <FilterReset {...reset} /> : null}
      {extra}
    </Space>
  );
}
