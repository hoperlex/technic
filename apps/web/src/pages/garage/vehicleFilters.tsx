import type { ReactNode } from 'react';
import { Select, Space } from 'antd';
import {
  GARAGE_VEHICLE_STATES,
  garageVehicleStateLabels,
  type GarageVehicleState,
} from '@technic/contracts';
import type { FilterDefinition } from '@shared/ui';
import { useVehicleClassificationFilter } from '../../hooks/useVehicleClassificationFilter';
import { useObjectsFilter } from './objectsFilter';

/**
 * Полоса отбора вкладки «Техника»: состояние, показания, техника классификатора и площадка.
 *
 * Одним хуком, а не тремя порознь, потому что каждый фильтр отвечает дважды — полем на десктопе и
 * описанием для шита на телефоне (ADR 0030). Собранные в разных местах, две половины одного
 * фильтра однажды разойдутся: список вариантов поправят в одной и забудут в другой.
 *
 * Отдельным файлом, а не строками в `GarageVehiclesTab.tsx`: у вкладки бюджет длины
 * (`quality-budget.json`), и полоса с описаниями в него не помещалась.
 */

const STATE_OPTIONS = GARAGE_VEHICLE_STATES.map((state) => ({
  value: state,
  label: garageVehicleStateLabels[state],
}));

/**
 * Фильтр «не сданы» — главный вопрос к экрану следующего утра (Р27). Значение одно: обратного к
 * нему («покажи сданные») никто не задаёт, поэтому это переключатель, а не список из двух.
 */
const READINGS_OPTIONS = [{ value: 'pending', label: 'Показания не сданы' }];

/** Ключи отбора: ровно те, которыми ведает полоса. Страница и сортировка — дело списка. */
export type VehicleFilterParams = {
  state?: GarageVehicleState;
  readings?: 'pending';
  /** Техника классификатора набором: `t<uuid>` — весь тип, `c<uuid>` — одна его категория. */
  classifications?: string;
  /**
   * Площадки работы дня набором — `objects=<uuid>,<uuid>` (Р8): машина проходит, если хотя бы одна
   * её работа в этот день идёт по заявке одной из отобранных площадок.
   *
   * Ключа `forms` здесь нет и пустым он не заводится: отбор по бланку ведёт вкладка водителей, а
   * схема техники этот ключ прямо запрещает (Р20) — присланный, он отвечает 400.
   */
  objects?: string;
};

export function useVehicleFilters({
  params,
  applyFilter,
}: {
  /** Нынешний отбор вкладки: поля показывают выбранное, а не хранят его у себя. */
  params: VehicleFilterParams;
  /** Правка отбора вкладкой: она же возвращает список на первую страницу. */
  applyFilter: (patch: VehicleFilterParams) => void;
}): { filters: ReactNode; mobileFilters: FilterDefinition[] } {
  const classificationFilter = useVehicleClassificationFilter({
    classifications: params.classifications,
    onChange: applyFilter,
  });
  const objectsFilter = useObjectsFilter({ objects: params.objects, onChange: applyFilter });

  const filters = (
    <Space size={[12, 8]} wrap>
      <Select<GarageVehicleState>
        allowClear
        placeholder="Любое состояние"
        style={{ width: 190 }}
        options={STATE_OPTIONS}
        value={params.state}
        onChange={(v) => applyFilter({ state: v })}
      />
      <Select<'pending'>
        allowClear
        placeholder="Показания: любые"
        style={{ width: 200 }}
        options={READINGS_OPTIONS}
        value={params.readings}
        onChange={(v) => applyFilter({ readings: v })}
      />
      {classificationFilter.controls}
      {objectsFilter.controls}
    </Space>
  );

  const mobileFilters: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'state',
      label: 'Состояние',
      value: params.state,
      options: [...STATE_OPTIONS],
      placeholder: 'Любое состояние',
      onChange: (v) => applyFilter({ state: v as GarageVehicleState | undefined }),
    },
    {
      kind: 'select',
      key: 'readings',
      label: 'Показания',
      value: params.readings,
      options: READINGS_OPTIONS,
      placeholder: 'Любые',
      onChange: (v) => applyFilter({ readings: v as 'pending' | undefined }),
    },
    classificationFilter.mobileFilter,
    objectsFilter.mobileFilter,
  ];

  return { filters, mobileFilters };
}
