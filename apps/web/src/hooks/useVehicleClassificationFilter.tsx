import type { ReactNode } from 'react';
import { Select } from 'antd';
import { CLASSIFICATION_FILTER_MAX, serializeClassificationFilter } from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';
import { useVehicleClassifications } from './useVehicleClassifications';

/**
 * Фильтр по технике классификатора — общий для списка заявок, журнала и гаража: вопрос «какая это
 * техника» в них один и тот же.
 *
 * Выбирают несколько позиций сразу, объединяемых по ИЛИ: «покажи автокраны и самосвалы» — один
 * вопрос к списку, а не два захода с переписыванием фильтра между ними. Позиция при этом та же,
 * что и раньше, — тип целиком («Автокраны — все категории») либо одна его категория.
 *
 * Один список на оба уровня, а не «тип, затем категория» двумя полями: выбор и в форме заявки
 * один (ADR 0028), и в фильтре читается так же — «Автокраны — все категории» рядом с «Автокраны,
 * г/п 130 т». Каскад из двух полей стоил бы двух касаний в шите на телефоне (ADR 0030), где
 * второе поле появлялось бы только после «Применить».
 *
 * Список не сужается ничем: фильтры независимы, а пустой результат читается сам.
 *
 * Живёт рядом с `useVehicleClassifications`, а не в странице заказа ТС: раздел «Гараж» (ADR 0076)
 * спрашивает тот же фильтр, а импорт из соседней страницы запрещён границами слоёв — и правильно
 * запрещён: общее двух разделов не может принадлежать одному из них.
 *
 * Подсказка называет классификатор, а не технику вообще (ADR 0098). «Вся техника» в соседних
 * списках раздела — «Маршруты», журнал путевых листов, а теперь и сам «Заказ автотехники» —
 * означает единицу парка, конкретную машину с госномером. Одна подсказка на два разных вопроса
 * читалась бы как поломка фильтра: человек ищет свой КамАЗ, а список предлагает «Самосвалы».
 */
export function useVehicleClassificationFilter({
  classifications,
  onChange,
}: {
  /** Набор канонической строкой — ровно тем, что уходит в запрос: разбирать его тут и негде. */
  classifications: string | undefined;
  /**
   * Пустой набор отдаётся как `undefined` (`serializeClassificationFilter`): пустая строка и
   * отсутствие параметра означают для списка одно, а лишний параметр — ещё один ключ кэша и ещё
   * один запрос за тем же самым.
   */
  onChange: (patch: { classifications?: string }) => void;
}): { controls: ReactNode; mobileFilter: FilterDefinition } {
  const { filterGroups, loading } = useVehicleClassifications();
  // Значение поля — тот же набор массивом. Ключи самодостаточны, и показать выбранное можно, не
  // дожидаясь справочника: подписи подтянутся, когда он придёт.
  const value = classifications ? classifications.split(',') : [];
  const pick = (keys: string[]) =>
    onChange({ classifications: serializeClassificationFilter(keys) });

  const controls = (
    <Select
      mode="multiple"
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder="Любой тип ТС"
      // Шире прежнего одиночного поля: набор показывается тегами, и в 250 они схлопывались бы в
      // «+N» уже на второй позиции. Дальше их прячет `responsive` — по месту, которое реально есть.
      style={{ width: 320 }}
      maxTagCount="responsive"
      // Потолок держится полем, а не только схемой: упереться в предел выбора понятнее, чем
      // получить 400 на уже собранный набор.
      maxCount={CLASSIFICATION_FILTER_MAX}
      options={filterGroups}
      loading={loading}
      value={value}
      onChange={pick}
    />
  );

  /** Тот же фильтр описанием — для шита на телефоне (ADR 0030). */
  const mobileFilter: FilterDefinition = {
    kind: 'multiSelect',
    key: 'classification',
    label: 'Тип/категория ТС',
    value,
    options: filterGroups,
    placeholder: 'Любой тип ТС',
    loading,
    // Фиксированные четыре, а не `responsive`: в drawer поле во всю ширину, и теги растут вниз —
    // десяток выбранных позиций вытеснил бы с экрана остальные фильтры и саму кнопку «Применить».
    maxTagCount: 4,
    maxCount: CLASSIFICATION_FILTER_MAX,
    onChange: pick,
  };

  return { controls, mobileFilter };
}
