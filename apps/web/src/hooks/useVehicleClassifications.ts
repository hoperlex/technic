import { useQuery } from '@tanstack/react-query';
import {
  vehicleClassificationKey,
  type VehicleClassificationDto,
} from '@technic/contracts';
import { vehicleClassificationsApi } from '../api/resources';

// Классификатор ТС для списков выбора (ADR 0028): позиции — категории типа, а у типа без ТТХ
// сам тип. Правило «общий тип при наличии категорий не выводится» держит сервер, клиент только
// раскладывает готовые позиции по видам ТС.

/** Позиции одного вида ТС — группа в Select. `kindCode` нужен, чтобы сузить список типом заявки. */
export interface VehicleClassificationGroup {
  label: string;
  kindCode: string;
  options: { value: string; label: string; disabled?: boolean }[];
}

/**
 * Все активные позиции классификатора, сгруппированные по виду ТС.
 *
 * Вид ТС не задаёт тип заявки — его выбирают в форме явно: техникой любого вида работают на
 * объекте, а грузоперевозку выполняют только грузовым видом.
 */
export function useVehicleClassifications() {
  const { data, isFetching } = useQuery({
    queryKey: ['vehicle-classifications', 'for-select'],
    queryFn: () =>
      vehicleClassificationsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
  });
  const items = data?.items ?? [];

  const byKey = new Map(items.map((c) => [c.key, c]));
  const groups: VehicleClassificationGroup[] = [];
  for (const c of items) {
    let group = groups.find((g) => g.kindCode === c.kindCode);
    if (!group) {
      group = { label: c.kindName, kindCode: c.kindCode, options: [] };
      groups.push(group);
    }
    group.options.push({ value: c.key, label: c.label });
  }

  return { items, byKey, groups, loading: isFetching };
}

/**
 * Позиция, которую нужно показать у уже сохранённой записи. Обычно она есть в списке, но не
 * всегда: позицию могли деактивировать, а у записи, заведённой до появления категорий, её может
 * не быть вовсе. Без этой добавки Select показал бы сырой ключ вместо наименования.
 */
export function withSavedClassification(
  groups: VehicleClassificationGroup[],
  saved: {
    vehicleTypeId: string;
    vehicleCategoryId: string | null;
    typeName: string;
    categoryName: string | null;
  } | null,
): VehicleClassificationGroup[] {
  if (!saved) return groups;
  const key = vehicleClassificationKey(saved.vehicleTypeId, saved.vehicleCategoryId);
  if (groups.some((g) => g.options.some((o) => o.value === key))) return groups;
  const label = saved.categoryName || saved.typeName;
  return [
    ...groups,
    {
      label: 'Выбрано ранее',
      kindCode: '',
      // Отдельной группой и заблокированной: позиции нет в справочнике — её либо выключили,
      // либо запись старше категорий. Показать её нужно (иначе поле выглядит пустым или сырым
      // ключом), а выбрать заново нельзя — сохранить такое сервер всё равно не даст.
      options: [{ value: key, label: `${label} (недоступна для выбора)`, disabled: true }],
    },
  ];
}

/** Ключ позиции у сохранённой записи — им форма показывает уже сделанный выбор. */
export function classificationKeyOf(v: {
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
}): string {
  return vehicleClassificationKey(v.vehicleTypeId, v.vehicleCategoryId);
}

export type { VehicleClassificationDto };
