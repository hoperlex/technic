import type { ReactNode } from 'react';
import { Input, Select, Space } from 'antd';
import { parseVehicleRequestNumberSearch } from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';

/**
 * Отбор среза «На объекте»: полоса фильтров для стола и те же фильтры описаниями для шита на
 * телефоне (ADR 0030).
 *
 * Отдельным файлом, потому что описаний ровно столько же, сколько полей, и держать обе половины
 * рядом — единственный способ не дать им разойтись: фильтр, который есть на столе и пропал на
 * телефоне, читается как поломка. Вкладке остаются список, запросы и окна.
 */
export type OnSiteFiltersArgs = {
  objectOptions: { value: string; label: string }[];
  objectFieldDisabled: boolean;
  /**
   * Площадка одна, а не набором (Р20): расширять фильтр, о котором не просили, значит менять
   * чужой экран заодно — набором площадки спрашивают в гараже.
   */
  objectId: string | undefined;
  num: number | undefined;
  onChange: (patch: { objectId?: string; num?: number }) => void;
  /** Классификатор собран своим хуком — здесь его половины только встают по местам. */
  classificationFilter: { controls: ReactNode; mobileFilter: FilterDefinition };
  /**
   * Бланк работы дня — тем же приёмом своим хуком (`useWaybillFormFilter`): им спрашивают не
   * справочник техники, а чем этот день закрывается, и набор бланков считает сервер (Р5–Р7).
   */
  formFilter: { controls: ReactNode; mobileFilter: FilterDefinition };
};

export function onSiteFilters({
  objectOptions,
  objectFieldDisabled,
  objectId,
  num,
  onChange,
  classificationFilter,
  formFilter,
}: OnSiteFiltersArgs): { filters: ReactNode; mobileFilters: FilterDefinition[] } {
  const filters = (
    <Space size={[12, 8]} wrap>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Все объекты"
        style={{ width: 240 }}
        options={objectOptions}
        disabled={objectFieldDisabled}
        value={objectId}
        onChange={(v: string | undefined) => onChange({ objectId: v })}
      />
      {/* Заказанная техника: тип целиком либо одна его категория (ADR 0028). */}
      {classificationFilter.controls}
      {/* Чем закрывается сегодняшний день заявки: ЭСМ-2 у своей работы на объекте, бланк рейса у
        линейного заказа. Строка без работы в день среза (аренда, долговая) не проходит никакой
        отбор по бланку — бланка у неё нет вовсе (Р21). */}
      {formFilter.controls}
      <Input.Search
        allowClear
        placeholder="Поиск по № (ТС-123)"
        style={{ width: 180 }}
        onSearch={(val) => onChange({ num: parseVehicleRequestNumberSearch(val) })}
      />
    </Space>
  );

  /** Те же фильтры описаниями — для шита на телефоне (ADR 0030). */
  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: objectId,
      options: objectOptions,
      placeholder: 'Все объекты',
      disabled: objectFieldDisabled,
      onChange: (v) => onChange({ objectId: v }),
    },
    classificationFilter.mobileFilter,
    formFilter.mobileFilter,
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: num != null ? String(num) : undefined,
      placeholder: 'Например, ТС-123',
      onChange: (v) => onChange({ num: parseVehicleRequestNumberSearch(v ?? '') }),
    },
  ];

  return { filters, mobileFilters };
}
