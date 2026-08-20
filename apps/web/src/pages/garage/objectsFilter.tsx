import type { ReactNode } from 'react';
import { Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { GARAGE_OBJECT_FILTER_MAX } from '@technic/contracts';
import { objectOptionsQuery } from '@entities/object';
import type { FilterDefinition } from '@shared/ui';
import { useObjectScope } from '../../hooks/useObjectScope';

/**
 * Отбор среза дня по площадке — набором, обеим вкладкам гаража (план «Срезы дня», Р8–Р10).
 *
 * Площадка строки — это площадка её **работы в этот день**: заявки, по которой идёт рейс, заказа
 * спецтехники, накрывающего день, или заявки-основания недельного листа. Считает пересечение
 * сервер, портал шлёт набор идентификаторов; свободная машина и свободный человек фильтром
 * выпадают — площадки у дня без работы нет.
 *
 * Набором, а не одной площадкой, тем же приёмом, что фильтр позиций классификатора (ADR 0124):
 * «покажи всех на Северном и на Южном» — один вопрос к списку, а не два захода с переписыванием
 * фильтра между ними.
 *
 * Отделов в списке нет: заказчиком грузоперевозки бывает и отдел (ADR 0040), но у рейса по такой
 * заявке площадки нет вовсе, и набором площадок он не находится. Общий фильтр «Заказчик» — работа
 * другого размера и в этот отбор не входит.
 *
 * Живёт в странице, а не в `features`: спрашивают его только две вкладки гаража — «На объекте»
 * остаётся при своём одиночном `objectId` (Р20). Понадобится третьему экрану — уедет в слой фич.
 */

export function useObjectsFilter({
  objects,
  onChange,
}: {
  /** Набор канонической строкой — ровно тем, что уходит в запрос: разбирать его тут и негде. */
  objects: string | undefined;
  /** Правка отбора: страницу на первую возвращает вкладка, у неё же живут остальные параметры. */
  onChange: (patch: { objects?: string }) => void;
}): { controls: ReactNode; mobileFilter: FilterDefinition } {
  /*
   * Закрытые площадки в списке нужны, и это не послабление: день среза выбирается любой, в том
   * числе прошлогодний, а закрытая площадка при умолчании `activeOnly: true` не пришла бы вовсе —
   * исторический срез нельзя было бы отобрать по той самой площадке, ради которой его открыли.
   */
  const { data: options = [], isFetching } = useQuery(objectOptionsQuery({ activeOnly: false }));
  // Объектной роли чужие площадки и выбирать незачем: сервер их всё равно не покажет, а список
  // предлагал бы отбор, из которого не возвращается ни одной строки.
  const { limitObjectOptions } = useObjectScope();
  const own = limitObjectOptions(options);

  const value = objects ? objects.split(',') : [];
  const pick = (ids: string[]) => onChange({ objects: serializeObjectFilter(ids) });

  const controls = (
    <Select
      mode="multiple"
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder="Все объекты"
      // Шире соседей по полосе: площадка называет себя кодом и именем, и выбранное показывается
      // тегами. Дальше их прячет `responsive` — по месту, которое на экране реально есть.
      style={{ width: 300 }}
      maxTagCount="responsive"
      // Потолок держится полем, а не только схемой: упереться в предел выбора понятнее, чем
      // получить 400 на уже собранный набор.
      maxCount={GARAGE_OBJECT_FILTER_MAX}
      options={own}
      loading={isFetching}
      value={value}
      onChange={pick}
    />
  );

  /** Тот же фильтр описанием — для шита на телефоне (ADR 0030). */
  const mobileFilter: FilterDefinition = {
    kind: 'multiSelect',
    key: 'objects',
    label: 'Объект',
    value,
    options: own,
    placeholder: 'Все объекты',
    loading: isFetching,
    // Фиксированные четыре, а не `responsive`: в шите поле во всю ширину, и теги растут вниз —
    // десяток выбранных площадок вытеснил бы с экрана остальные фильтры и саму кнопку «Применить».
    maxTagCount: 4,
    maxCount: GARAGE_OBJECT_FILTER_MAX,
    onChange: pick,
  };

  return { controls, mobileFilter };
}

/**
 * Канонический вид набора для строки запроса: дедупликация, сортировка по самому ключу, запятая —
 * приёмом `serializeClassificationFilter`. Сортировка по ключу, а не по порядку в списке: список
 * площадок приходит запросом, и до его ответа один и тот же выбор давал бы две разные строки — два
 * ключа кэша и два запроса за одним ответом.
 *
 * Пустой набор даёт `undefined`, а не пустую строку: для сервера «фильтра нет» и «фильтр пуст» —
 * одно и то же, а лишний параметр — ещё один ключ кэша и ещё один запрос за тем же самым.
 */
function serializeObjectFilter(ids: string[]): string | undefined {
  const unique = [...new Set(ids)].sort();
  return unique.length === 0 ? undefined : unique.join(',');
}
