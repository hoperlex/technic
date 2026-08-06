import type { ReactNode } from 'react';
import { Select } from 'antd';
import { parseVehicleClassificationKey, vehicleClassificationKey } from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';
import { useVehicleClassifications } from './useVehicleClassifications';

/**
 * Фильтр по технике классификатора — общий для списка заявок, журнала и гаража: вопрос «какая это
 * техника» в них один и тот же.
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
 */
export function useVehicleClassificationFilter({
  vehicleTypeId,
  vehicleCategoryId,
  onChange,
}: {
  vehicleTypeId: string | undefined;
  vehicleCategoryId: string | undefined;
  /** В параметры списка уходит пара полей: ключ позиции — только вид выбора, не запрос. */
  onChange: (patch: { vehicleTypeId?: string; vehicleCategoryId?: string }) => void;
}): { controls: ReactNode; mobileFilter: FilterDefinition } {
  const { filterGroups, loading } = useVehicleClassifications();
  const value = vehicleTypeId
    ? vehicleClassificationKey(vehicleTypeId, vehicleCategoryId)
    : undefined;
  const pick = (key: string | undefined) => {
    const picked = parseVehicleClassificationKey(key);
    onChange({
      vehicleTypeId: picked?.vehicleTypeId,
      vehicleCategoryId: picked?.vehicleCategoryId ?? undefined,
    });
  };

  const controls = (
    <Select
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder="Вся техника"
      style={{ width: 250 }}
      options={filterGroups}
      loading={loading}
      value={value}
      onChange={pick}
    />
  );

  /** Тот же фильтр описанием — для шита на телефоне (ADR 0030). */
  const mobileFilter: FilterDefinition = {
    kind: 'select',
    key: 'classification',
    label: 'Тип/категория ТС',
    value,
    options: filterGroups,
    placeholder: 'Вся техника',
    loading,
    onChange: pick,
  };

  return { controls, mobileFilter };
}
