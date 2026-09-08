import type { ReactNode } from 'react';
import { Checkbox, DatePicker, Input, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { FilterReset, type FilterDefinition } from '@shared/ui';

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
 * Один фильтр в панели десктопа. Обычная функция, а не компонент: она вызывается прямо из разметки
 * панели и своего состояния не имеет — объявленный внутри компонент пересоздавался бы на каждый
 * рендер и терял бы фокус поля при вводе.
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
    case 'toggle':
      // Флажком, а не переключателем: в панели десктопа он стоит в одном ряду с полями отбора, и
      // подпись должна читаться слева направо вместе с ними — как у архива в реестре техники.
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
      // Прочих видов у этого списка нет: описания собираются здесь же, и ветка-заглушка ловила бы
      // только собственную опечатку — молча и на экране.
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
      {filters.map(renderFilter)}
      <Input
        style={{ width: 160 }}
        allowClear
        placeholder="Поиск по № заявки"
        value={num.text}
        onChange={(e) => num.onChange(e.target.value)}
      />
      {reset ? <FilterReset {...reset} /> : null}
      {extra}
    </Space>
  );
}
