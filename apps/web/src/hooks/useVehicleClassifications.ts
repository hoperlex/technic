import { useQuery } from '@tanstack/react-query';
import {
  classificationPriceHint,
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
  options: VehicleClassificationOption[];
}

export interface VehicleClassificationOption {
  value: string;
  label: string;
  disabled?: boolean;
  /**
   * Порядок цены позиции («~ 2 400 ₽/час»), которую список показывает справа от наименования.
   * Отдельным полем, а не внутри `label`: по label идёт поиск и им же подписывается выбранное
   * значение, а цена в обоих случаях лишняя. `undefined` — цен у позиции нет.
   */
  priceHint?: string;
}

/** Группа вида ТС, к которой относится позиция; заводится при первой позиции этого вида. */
function kindGroupOf(
  groups: VehicleClassificationGroup[],
  c: VehicleClassificationDto,
): VehicleClassificationGroup {
  let group = groups.find((g) => g.kindCode === c.kindCode);
  if (!group) {
    group = { label: c.kindName, kindCode: c.kindCode, options: [] };
    groups.push(group);
  }
  return group;
}

/**
 * Позиции для выбора в форме — как их отдал сервер, по видам ТС. Рядом с наименованием идёт
 * порядок цены: заказывают, глядя на список, и «во сколько обойдётся» — второй вопрос после «что
 * нужно», а не отдельный поход в прайс.
 */
export function classificationGroups(
  items: VehicleClassificationDto[],
): VehicleClassificationGroup[] {
  const groups: VehicleClassificationGroup[] = [];
  for (const c of items) {
    kindGroupOf(groups, c).options.push({
      value: c.key,
      label: c.label,
      priceHint: classificationPriceHint(c) ?? undefined,
    });
  }
  return groups;
}

/**
 * Варианты фильтра «тип/категория» для списков: те же позиции, но у типа с категориями впереди
 * стоит он сам целиком.
 *
 * Заказывают всегда конечную позицию (ADR 0028) — «просто автокран» не заказывают. У списка же
 * спрашивают оба уровня: «сколько заказывали автокранов» — вопрос не реже, чем «сколько на 130 т»,
 * а заявка, заведённая до появления категорий, конечной позиции не имеет вовсе и находится только
 * по типу. Значение варианта — тот же ключ позиции: `тип:` целиком, `тип:категория` — категория.
 */
export function classificationFilterGroups(
  items: VehicleClassificationDto[],
): VehicleClassificationGroup[] {
  const groups: VehicleClassificationGroup[] = [];
  const wholeTypeAdded = new Set<string>();
  for (const c of items) {
    const group = kindGroupOf(groups, c);
    // У типа без категорий он сам и есть конечная позиция — второй строкой «весь тип» не нужен.
    if (c.vehicleCategoryId && !wholeTypeAdded.has(c.vehicleTypeId)) {
      wholeTypeAdded.add(c.vehicleTypeId);
      group.options.push({
        value: vehicleClassificationKey(c.vehicleTypeId, null),
        label: `${c.typeName} — все категории`,
      });
    }
    group.options.push({ value: c.key, label: c.label });
  }
  return groups;
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

  return {
    items,
    byKey,
    groups: classificationGroups(items),
    /** Те же позиции для фильтра списка — с вариантом «весь тип» (classificationFilterGroups). */
    filterGroups: classificationFilterGroups(items),
    loading: isFetching,
  };
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
