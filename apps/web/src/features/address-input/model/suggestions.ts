import type { DirectoryGroup, DirectoryOption } from './useDirectoryOptions';

export const SUGGESTED_GROUP_LABEL = 'Подсказки';
export const OBJECTS_GROUP_LABEL = 'Объекты';
export const WAREHOUSES_GROUP_LABEL = 'Склады поставщиков';

/**
 * Группы выпадающего списка (ADR 0069).
 *
 * Пока поиск не начат, сверху стоит короткая группа подсказок: объект заявки, затем площадки
 * учётки — в девяти случаях из десяти машину заказывают именно туда, и листать ради этого весь
 * справочник незачем. Поле при этом остаётся пустым: подсказка — это первая строка списка, а не
 * подставленный ответ (заявка в соседний город обычна, и подстановку пришлось бы стирать).
 *
 * Как только человек начал набор, группа исчезает: он уже сказал, что ищет другое, и держать
 * сверху нерелевантное значит отодвигать найденное. Записи при этом никуда не деваются — они
 * остаются в общих группах, и оттуда же их находит поиск.
 *
 * Предложенные записи из общих групп вычитаются: одно и то же значение в `Select` дважды ломает
 * выбор и читается как две разные площадки.
 */
export function buildDirectoryGroups({
  objects,
  warehouses,
  suggestIds,
  searching,
}: {
  objects: DirectoryOption[];
  warehouses: DirectoryOption[];
  suggestIds: readonly string[];
  searching: boolean;
}): DirectoryGroup[] {
  const byId = new Map(objects.map((o) => [o.value, o]));
  // Порядок подсказок задаёт вызывающая сторона: первым идёт объект заявки, затем свои площадки.
  const suggested = searching
    ? []
    : [...new Set(suggestIds)].map((id) => byId.get(id)).filter((o): o is DirectoryOption => !!o);

  const suggestedIds = new Set(suggested.map((o) => o.value));
  const groups: DirectoryGroup[] = [];
  if (suggested.length) groups.push({ label: SUGGESTED_GROUP_LABEL, options: suggested });

  const restObjects = objects.filter((o) => !suggestedIds.has(o.value));
  if (restObjects.length) groups.push({ label: OBJECTS_GROUP_LABEL, options: restObjects });
  if (warehouses.length) groups.push({ label: WAREHOUSES_GROUP_LABEL, options: warehouses });
  return groups;
}
