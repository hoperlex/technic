import type { ReactNode } from 'react';
import { Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { vehicleOptionLabel } from '@technic/contracts';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';
import type { FilterDefinition } from '@shared/ui';
import { objectsApi, objectKeys } from '@entities/object';

export { VehicleRequestAssignmentCell } from '@entities/vehicle-request';

/** Опции активных объектов для Select (грузятся разом, pageSize=500). */
export function useObjectOptions() {
  const { data, isFetching } = useQuery({
    queryKey: objectKeys.options({ activeOnly: true }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  return {
    options: (data?.items ?? []).map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` })),
    loading: isFetching,
  };
}

/**
 * Фильтр по назначенной машине — для списка заказов и журнала закрытых (ADR 0098).
 *
 * Спрашивает единицу парка, а не позицию классификатора: «где сейчас мой КамАЗ» и «какие заявки им
 * закрыли» — вопросы к конкретной машине, и рядом стоящий фильтр по типу на них не отвечает.
 * Классификатор остаётся своим фильтром (`useVehicleClassificationFilter`) — он отвечает на «какую
 * технику заказывали», а заказывают тип, а не машину.
 *
 * В списке и своя техника, и арендная: заявку закрывают любой — арендную берут ровно тогда, когда
 * своей не хватило, — и искать по ней надо тем же полем. Отбор списанных и стоящих в ремонте не
 * убирает, как и в фильтре маршрутов: вчерашние заявки никуда не делись.
 *
 * Заявка без назначенной машины под такой фильтр не попадает — машины у неё ещё нет, а не «строка
 * пропала»: «Новая» заявка отвечает на «что заказали», и техники в ней не бывает по существу.
 */
export function useVehicleFilter({
  vehicleId,
  onChange,
}: {
  vehicleId: string | undefined;
  onChange: (patch: { vehicleId?: string }) => void;
}): { controls: ReactNode; mobileFilter: FilterDefinition } {
  const { data, isFetching } = useQuery({
    queryKey: vehicleKeys.allOptions(),
    queryFn: () => vehiclesApi.list({ page: 1, pageSize: 500, sortBy: 'createdAt' }),
  });
  // Порядок — по подписи, а не по заведению в справочнике: машину ищут глазами по госномеру.
  const options = (data?.items ?? [])
    .map((v) => ({ value: v.id, label: vehicleOptionLabel(v) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));

  const controls = (
    <Select
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder="Вся техника"
      style={{ width: 240 }}
      options={options}
      loading={isFetching}
      value={vehicleId}
      onChange={(v: string | undefined) => onChange({ vehicleId: v })}
    />
  );

  /** Тот же фильтр описанием — для шита на телефоне (ADR 0030). */
  const mobileFilter: FilterDefinition = {
    kind: 'select',
    key: 'vehicleId',
    label: 'Техника',
    value: vehicleId,
    options,
    placeholder: 'Вся техника',
    loading: isFetching,
    onChange: (v) => onChange({ vehicleId: v }),
  };

  return { controls, mobileFilter };
}

/**
 * Арендодатели для фильтра журнала — контрагенты роли «Арендодатель (ТС)»: по ним и сводят расходы
 * на аренду. Неактивные из списка не убираем: журнал читают и про тех, с кем уже не работают.
 *
 * Живёт здесь, рядом с прочими опциями фильтров раздела, а не в самом журнале: список читается
 * теми же двумя строками, что объекты и водители, и в странице он был запросом посреди экрана.
 */
export function useLessorOptions() {
  const { data, isFetching } = useQuery({
    queryKey: counterpartyKeys.vehicleLessorOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'vehicle_lessor',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  return {
    options: (data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
    loading: isFetching,
  };
}
