import type { ReactNode } from 'react';
import { Checkbox, DatePicker, Input, Select, Space } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { vehicleOptionLabel } from '@technic/contracts';
import { ownVehicleKeys } from '@entities/auto-part-receipt';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { FilterReset, type FilterDefinition } from '@shared/ui';
import { usePruneMissingFilters } from '@shared/lib';
import { vehiclesApi } from '../../api/resources';

/**
 * Отбор ленты чеков — **одним описанием** на десктоп и телефон (план
 * `docs/auto-part-receipts-plan.md`, §8; ADR 0030).
 *
 * Обычно панель над таблицей собирается разметкой, а шит на телефоне — списком описаний, и две
 * копии расходятся при первой же правке. Здесь описание одно, а панель десктопа рисуется по нему
 * же (`ReceiptFilterBar`) — забыть половину нельзя.
 *
 * Отдельным модулем от самой вкладки: у той бюджет длины (`quality-budget.json`), а перечень машин
 * с его запросом и уборкой исчезнувших значений в него не помещался.
 */

const DATE = 'YYYY-MM-DD';

/** Что вкладка спрашивает сверх базовых параметров списка (§6, `receiptFilterShape`). */
export interface ReceiptFilters {
  /** Границы периода по **дате чека**, а не по дню внесения в портал (Р13). */
  from?: string;
  to?: string;
  /** Чеки, в которых есть строка на эту машину; сам чек при этом остаётся целым. */
  vehicleId?: string;
  /**
   * «Помеченные к удалению» строкой `'true'`, а не булевым: значением распоряжаются трое сразу —
   * запрос (`booleanFlagSchema` ждёт `true`/`false`), память набора (ADR 0139 пишет только строки)
   * и «Сбросить» (снимает в `undefined`). Булево `false` из хранилища не вернулось бы, и утром
   * отбор молча оказывался бы снятым.
   */
  deletionMarked?: string;
}

/**
 * Ключи отборов перечнем: по ним хук списка запоминает набор между сеансами (ADR 0139), строит
 * «Сбросить» и решает, задан ли отбор вообще. Тип сторожит совпадение — поле, добавленное в отбор
 * и забытое здесь, перестало бы запоминаться молча.
 *
 * Поиска здесь нет намеренно: «где этот чек» — разовый вопрос, и строка, встретившая человека
 * утром, читалась бы как поломка списка, а не как его собственный вчерашний ввод.
 */
export const RECEIPT_FILTER_FIELDS = [
  'from',
  'to',
  'vehicleId',
  'deletionMarked',
] as const satisfies readonly (keyof ReceiptFilters)[];

export function useReceiptFilters({
  params,
  apply,
}: {
  params: ReceiptFilters;
  apply: (patch: ReceiptFilters) => void;
}): FilterDefinition[] {
  /**
   * Перечень собственной техники.
   *
   * Только `own`: строка чека ссылается на собственную машину, и проверяет это сервер (Р21) — в
   * отборе арендной техники не бывает по построению предмета. Списанные и стоящие в ремонте из
   * перечня не убираются: чек законно выписан на машину, которую позже вывели из парка, и фильтр,
   * не находящий её, читался бы как поломка.
   */
  const {
    data: vehicles,
    isFetching: vehiclesLoading,
    isSuccess: vehiclesReady,
  } = useQuery({
    queryKey: ownVehicleKeys.options(),
    queryFn: () =>
      vehiclesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        ownership: 'own',
        sortBy: 'createdAt',
      }),
  });
  // Порядок — по подписи, а не по заведению в справочнике: машину ищут глазами по госномеру.
  const vehicleOptions = (vehicles?.items ?? [])
    .map((v) => ({ value: v.id, label: vehicleOptionLabel(v) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));

  /**
   * Восстановленный набор мог пережить сам предмет отбора: машину удалили из справочника
   * (ADR 0139). Такое значение уходит в запрос, но в поле показывается сырым идентификатором —
   * человек остаётся с пустым списком и без причины. Снимаем.
   */
  usePruneMissingFilters(
    [{ key: 'vehicleId', value: params.vehicleId, options: vehicleOptions, ready: vehiclesReady }],
    (keys) => apply(Object.fromEntries(keys.map((key) => [key, undefined]))),
  );

  return [
    {
      // Период — по дате чека (Р13): «сколько потратили в августе» спрашивают бумагой, а не днём,
      // когда её внесли в портал. Обе границы необязательны: «за всё время» — законный вопрос к
      // разделу, который только что завели.
      kind: 'dateRange',
      key: 'period',
      label: 'Период',
      from: params.from,
      to: params.to,
      onChange: (from, to) => apply({ from, to }),
    },
    {
      kind: 'select',
      key: 'vehicleId',
      label: 'Машина',
      value: params.vehicleId,
      options: vehicleOptions,
      loading: vehiclesLoading,
      placeholder: 'Вся техника',
      onChange: (v) => apply({ vehicleId: v }),
    },
    {
      /*
       * Отбор сервера, а не подсветка строк: пометка живёт полем записи, и посчитать очередь на
       * клиенте можно было бы только по приехавшей странице — то есть ответить «помеченных нет»,
       * пока они на второй.
       */
      kind: 'toggle',
      key: 'deletionMarked',
      label: 'Помеченные к удалению',
      value: params.deletionMarked === 'true',
      onChange: (checked) => apply({ deletionMarked: checked ? 'true' : undefined }),
    },
  ];
}

/**
 * Один фильтр в панели десктопа. Обычная функция, а не компонент: она вызывается прямо из разметки
 * панели и своего состояния не имеет — объявленный внутри компонент пересоздавался бы на каждый
 * рендер и терял бы фокус поля при вводе.
 */
function renderFilter(filter: FilterDefinition): ReactNode {
  switch (filter.kind) {
    case 'dateRange':
      return (
        <DatePicker.RangePicker
          key={filter.key}
          format="DD.MM.YYYY"
          style={{ width: 260 }}
          allowEmpty={[true, true]}
          placeholder={['Чеки с', 'по']}
          value={[filter.from ? dayjs(filter.from) : null, filter.to ? dayjs(filter.to) : null]}
          onChange={(range) =>
            filter.onChange(
              range?.[0] ? range[0].format(DATE) : undefined,
              range?.[1] ? range[1].format(DATE) : undefined,
            )
          }
        />
      );
    case 'select':
      return (
        <Select
          key={filter.key}
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: 260 }}
          placeholder={filter.placeholder ?? filter.label}
          options={filter.options}
          loading={filter.loading}
          value={filter.value}
          onChange={(v) => filter.onChange(v)}
        />
      );
    case 'toggle':
      // Флажком, а не переключателем: в панели десктопа он стоит в одном ряду с полями отбора, и
      // подпись должна читаться слева направо вместе с ними.
      return (
        <Checkbox
          key={filter.key}
          checked={filter.value}
          onChange={(e) => filter.onChange(e.target.checked)}
        >
          {filter.label}
        </Checkbox>
      );
    default:
      // Прочих видов у этого списка нет: описания собираются здесь же, и ветка-заглушка ловила бы
      // только собственную опечатку — молча и на экране.
      return null;
  }
}

/** Строка поиска ленты: сервер ищет сразу по трём местам, где ищут одну и ту же покупку (§6). */
export const RECEIPT_SEARCH_PLACEHOLDER = 'Продавец, номер или наименование';

/**
 * Панель фильтров десктопа из тех же описаний, что уходят в шит телефона, плюс поиск и «Сбросить».
 *
 * Поиск стоит в панели, а не лупой в заголовке столбца: он идёт по продавцу, номеру чека и
 * наименованию строки сразу, и лупа у одного столбца обещала бы поиск только по нему.
 */
export function ReceiptFilterBar({
  filters,
  search,
  reset,
}: {
  filters: FilterDefinition[];
  search: { value: string | undefined; onSearch: (value: string | undefined) => void };
  reset: { active: boolean; onClick: () => void };
}) {
  return (
    <Space wrap>
      {filters.map(renderFilter)}
      <Input.Search
        allowClear
        placeholder={RECEIPT_SEARCH_PLACEHOLDER}
        style={{ width: 280 }}
        defaultValue={search.value}
        onSearch={(v) => search.onSearch(v.trim() || undefined)}
      />
      <FilterReset {...reset} />
    </Space>
  );
}
