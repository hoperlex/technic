import { vehicleClassificationsForSelectQuery } from '../api/queries';
import { useQuery } from '@tanstack/react-query';
import { isCurrentPickAnswer, QUERY_PROFILE } from '@shared/config';
import {
  classificationFilterKey,
  classificationPriceHint,
  vehicleClassificationKey,
  type VehicleClassificationDto,
} from '@technic/contracts';

// The server decides which classifier positions are selectable (ADR 0028); this module only groups
// those positions by vehicle kind.

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
 * по типу.
 *
 * Значение варианта — **ключ фильтра** (`t<тип>` / `c<категория>`), а не ключ позиции
 * `тип:категория` из формы заявки. Ключа два, потому что вопроса два: форма выбирает одну конечную
 * позицию и обязана назвать оба уровня, а фильтр набирает несколько позиций сразу и объединяет их
 * по ИЛИ — пара на его месте позволяла бы прислать несуществующее сочетание `типA:категорияB` и
 * получить молча переосмысленный ответ вместо отказа.
 *
 * Ключ при этом один на все три места сразу: значение `Select`, черновик мобильного шита и
 * параметр запроса. Разойдись они — выбранное значение нечем было бы показать, пока справочник
 * грузится: подпись берётся из загруженных вариантов, и до ответа сервера поле стояло бы пустым
 * при заданном отборе.
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
        value: classificationFilterKey(c.vehicleTypeId, null),
        label: `${c.typeName} — все категории`,
      });
    }
    group.options.push({
      value: classificationFilterKey(c.vehicleTypeId, c.vehicleCategoryId),
      label: c.label,
    });
  }
  return groups;
}

/**
 * Active classifier positions grouped by vehicle kind. The request type is chosen separately:
 * on-site work can use any kind, while freight transport accepts cargo kinds.
 */
export function useVehicleClassifications(enabled = true, pick = false) {
  const { data, dataUpdatedAt, isFetching, isLoading, isStale, isSuccess } = useQuery({
    ...vehicleClassificationsForSelectQuery(),
    ...(pick ? QUERY_PROFILE.PICK : {}),
    enabled,
  });
  const items = data?.items ?? [];

  const byKey = new Map(items.map((c) => [c.key, c]));

  return {
    items,
    byKey,
    groups: classificationGroups(items),
    /** The same positions for list filters, including the whole-type option and its filter key. */
    filterGroups: classificationFilterGroups(items),
    loading: isLoading,
    ready: isSuccess,
    // A disabled PICK observer may expose an older successful answer while the next opening
    // refetches it. Copying from that answer could submit a position since deactivated.
    // Disabled observers report isStale=false even for data older than PICK. The age check keeps
    // that old answer from looking fresh during the transition to an open editor.
    fresh:
      pick && enabled && isCurrentPickAnswer({ isSuccess, isFetching, isStale, dataUpdatedAt }),
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
