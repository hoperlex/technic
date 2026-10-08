import { queryOptions } from '@tanstack/react-query';
import {
  officeEquipmentTitle,
  type OfficeEquipmentDto,
  type OfficeEquipmentRequestOptionDto,
} from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE, QUERY_PROFILE, queryProfileOptions } from '@shared/config';
import {
  officeEquipmentApi,
  officeEquipmentConsumablesApi,
  officeEquipmentModelsApi,
  officeEquipmentSpecsApi,
  officeEquipmentTypesApi,
} from './officeEquipmentApi';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
  officeEquipmentTypeKeys,
} from './keys';

/**
 * Equipment types fit in one page in directory order. Inactive types remain in the picker because
 * existing equipment may still refer to them; their labels disclose that they cannot be used for
 * new equipment, so editing an old card does not appear to lose its type.
 */
export const officeEquipmentTypeOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: officeEquipmentTypeKeys.options(),
    queryFn: () =>
      officeEquipmentTypesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
    select: (r) =>
      r.items.map((t) => ({
        value: t.id,
        label: t.isActive ? t.name : `${t.name} (не используется)`,
      })),
  });

/**
 * Единица справочника в том виде, в каком её знает форма заявки. Собирается одним местом на оба
 * запроса ниже — выдачу поля и дочитку уже выбранной карточки: разойдись они, и выбранная единица
 * подписывалась бы иначе, чем та же единица в списке, а реквизиты под полем менялись бы от того,
 * каким путём она туда попала.
 *
 * Подпись собирает `officeEquipmentTitle` из контрактов — «Kyocera M3145 · инв. 0012345» обязано
 * читаться одинаково и в портале, и в письме.
 */
const equipmentOption = (item: OfficeEquipmentDto) => ({
  value: item.id,
  label: officeEquipmentTitle(item),
  warrantyUntil: item.warrantyUntil,
  // Реквизиты выбранной единицы форма заявки показывает отдельными строками (Р48): человек должен
  // увидеть, что именно уйдёт в заявку снимком, до отправки, а не после.
  name: item.name,
  serialNumber: item.serialNumber,
  inventoryNumber: item.inventoryNumber,
  typeName: item.type.name,
  objectLabel: `${item.object.code} — ${item.object.name}`,
  departmentName: item.department?.name ?? '',
  // Идентификаторы рядом с подписями — для поля заказчика (план `department-requests-plan.md`,
  // §9 п. 5): из объекта собирается ключ площадки (Р11а), а по отделу-владельцу считается
  // граница «площадка роли отдела только по технике своего отдела» (Р12). Неразмеченная
  // единица приходит с `null` — и площадку по ней сервер отвергает.
  objectId: item.object.id,
  departmentId: item.department?.id ?? null,
  location: item.location,
  // Модель — ею окно состава подбирает подходящие расходники (Н10). Приходит из того же ответа,
  // что и всё остальное: отдельный запрос за моделью спрашивал бы про ту же карточку второй раз.
  modelId: item.model?.id,
});

/** Единица справочника для поля заявки: подпись, реквизиты снимка и ключи площадки. */
export type OfficeEquipmentOption = ReturnType<typeof equipmentOption>;

/**
 * СТРАНИЦА ВЫДАЧИ ПОЛЯ — полсотни строк, а не весь справочник (план кандидата, Ф1). Отбор считает
 * сервер, и страница здесь ровно та, которую человек глазами и разбирает: списком длиннее полусотни
 * никто не пользуется — его доуточняют набором.
 */
const OPTIONS_PAGE_SIZE = 50;

/**
 * Единицы оргтехники для выбора техники в заявке на обслуживание (§9.3 плана, Ф1 плана кандидата).
 *
 * ИЩЕТ СЕРВЕР, А НЕ ПОЛЕ. Раньше выдача приходила одной страницей в пятьсот строк и резалась на
 * клиенте по подписи — и оба следствия были дефектами. Поиск по серийному номеру не находил
 * ничего у карточки с инвентарным (подпись печатает один номер из двух, `officeEquipmentTitle`),
 * а парк больше пятисот единиц не помещался в страницу целиком, и «ничего не нашлось» означало
 * «не поместилось». Сервер ищет по модели, обоим номерам и месту разом (`searchCondition`) — то
 * есть по тому, как единицу называют на самом деле: бухгалтерия по инвентарному, сервис по
 * серийному, а «принтер в 214-м» вообще по кабинету.
 *
 * Подпись при этом не меняется: она печатается в письмах и в истории, и номер, добавленный в неё
 * ради поиска, поехал бы во все письма модуля. Поиску он там и не нужен — он идёт по колонке.
 *
 * Только действующие: заявку заводят на технику, которая стоит в кабинете, а списанную выбирать
 * незачем — в уже заведённых заявках её реквизиты хранятся снимком (Р7) и от справочника не
 * зависят.
 */
export const officeEquipmentOptionsQuery = (search?: string) =>
  queryOptions({
    queryKey: officeEquipmentKeys.options(search),
    queryFn: () =>
      officeEquipmentApi.list({
        page: 1,
        pageSize: OPTIONS_PAGE_SIZE,
        isActive: 'true',
        search: search?.trim() || undefined,
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    select: (r) => r.items.map(equipmentOption),
  });

/**
 * УЖЕ ВЫБРАННАЯ единица по идентификатору — тем же видом, что и строка выдачи.
 *
 * Заведена вместе с серверным поиском (Ф1) и ровно из-за него: выдача стала срезом по набранному,
 * и единица, названная не набором, в ней может не лежать вовсе. Таких случаев три, и все они
 * рабочие: обращение по гарантии (единицу назвал реестр), правка заявки (её назвали при заведении)
 * и карточка, только что заведённая из самой формы. Без дочитки в поле осталась бы строка
 * идентификатора, реквизиты под ним пропали бы, а поле заказчика — которое считается по площадке
 * выбранной единицы — заперлось бы вместе с ними.
 *
 * Ключ карточки, а не выдачи: спрашивается ровно та же ручка `GET /office-equipment/:id`, которой
 * карточку открывают из заявки, и делить с ней запись кэша правильно — ответ один и тот же.
 */
export const officeEquipmentPickedQuery = (id: string | undefined) =>
  queryOptions({
    queryKey: officeEquipmentKeys.detail(id ?? ''),
    queryFn: () => officeEquipmentApi.get(id!),
    enabled: !!id,
    select: equipmentOption,
  });

/**
 * Единица справочника глазами формы заявки — из ОТДЕЛЬНОЙ проекции селектора (план
 * `docs/office-equipment-request-subject-plan.md`, Р1).
 *
 * Соседний `equipmentOption` не переиспользуется, хотя половина полей совпадает: он собран из
 * карточки `OfficeEquipmentDto` и берёт у неё тип и модель, которых у проекции нет вовсе — и не
 * должно быть. Общая функция потребовала бы либо вернуть их в проекцию, либо сделать
 * необязательными в обеих, то есть стереть ровно ту границу, ради которой проекция и заведена.
 *
 * Подпись собирает тот же `officeEquipmentTitle` — «Kyocera M3145 · инв. 0012345» обязано читаться
 * одинаково и в портале, и в письме.
 */
const selectorOption = (item: OfficeEquipmentRequestOptionDto) => ({
  value: item.id,
  label: officeEquipmentTitle(item),
  warrantyUntil: item.warrantyUntil,
  // Реквизиты выбранной единицы форма показывает отдельными строками: человек должен увидеть, что
  // именно уйдёт в заявку снимком, до отправки, а не после.
  name: item.name,
  serialNumber: item.serialNumber,
  inventoryNumber: item.inventoryNumber,
  objectId: item.object.id,
  objectLabel: `${item.object.code} — ${item.object.name}`,
  departmentId: item.ownerDepartment?.id ?? null,
  departmentName: item.ownerDepartment?.name ?? '',
  location: item.location,
  /**
   * Погашенная приезжает только дочиткой уже выбранного: в выдаче поля её нет. Форма показывает
   * такой выбор честно — «списана», — а не молча теряет его.
   */
  isActive: item.isActive,
  /**
   * Два ответа об области, а не один (Р2). `inOwnScope: false` при `objectInOwnScope: true`
   * означает «чужой отдел, СВОЯ площадка»: плашка про отдел показывается, поправка объекта — нет.
   * Считает их сервер: область — его вопрос, и второе мнение о ней в портале разошлось бы с первым.
   */
  inOwnScope: item.inOwnScope,
  objectInOwnScope: item.objectInOwnScope,
});

/** Единица справочника для поля «Какой аппарат» в заявке: подпись, реквизиты и признаки области. */
export type OfficeEquipmentSelectorOption = ReturnType<typeof selectorOption>;

/**
 * ВЫДАЧА ПОЛЯ «КАКОЙ АППАРАТ» — по всему активному парку от трёх набранных символов (Р3).
 *
 * Своя пара запросов и свои ключи кэша, а не параметр у соседних: у обычной карточки и у селектора
 * не должно быть общей записи кэша вовсе. Дочитка селектора под ключом `detail` положила бы
 * аппарат вне области в ту же ячейку, которой живёт обычная карточка справочника, — и следующий,
 * кто открыл бы его из вкладки, получил бы чужую запись из кэша.
 *
 * Порог в три символа портал не повторяет своим числом и не проверяет сам: решает сервер
 * (`OFFICE_EQUIPMENT_SELECTOR_SEARCH_MIN`), а поле лишь показывает то, что пришло. Второе правило
 * рядом означало бы, что портал обещает поиск, которого сервер не делает, — или наоборот, скрывает
 * то, что сервер уже отдал.
 *
 * Страница та же, что у соседней выдачи, — полсотни строк: список длиннее никто не разбирает
 * глазами, его доуточняют набором.
 */
export const officeEquipmentSelectorOptionsQuery = (search?: string) =>
  queryOptions({
    queryKey: officeEquipmentKeys.selectorOptions(search),
    queryFn: () =>
      officeEquipmentApi.selector({
        page: 1,
        pageSize: OPTIONS_PAGE_SIZE,
        search: search?.trim() || undefined,
      }),
    select: (r) => r.items.map(selectorOption),
  });

/**
 * УЖЕ ВЫБРАННАЯ единица — тем же видом, что и строка выдачи.
 *
 * Нужна ровно потому, что выдача стала срезом по набранному: аппарат, названный не набором, в ней
 * может не лежать. Случаев три, и все рабочие: обращение по гарантии (единицу назвал реестр),
 * правка заявки (её назвали при заведении) и карточка, только что заведённая из самой формы. Без
 * дочитки в поле осталась бы строка идентификатора, а реквизиты под ним пропали бы.
 *
 * Ручка отдаёт запись независимо от области и длины набранного — выбранное уже выбрано, — а
 * погашенную возвращает с `isActive: false`. Архивная отвечает 404: предметом новой заявки
 * удалённая карточка быть не может.
 */
export const officeEquipmentSelectorPickedQuery = (id: string | undefined) =>
  queryOptions({
    queryKey: officeEquipmentKeys.selectorPicked(id ?? ''),
    queryFn: () => officeEquipmentApi.selectorPicked(id!),
    enabled: !!id,
    select: selectorOption,
  });

/**
 * Only active models may be chosen for new equipment. Existing cards restore an inactive saved
 * model through `withSavedOption`. The small directory is fetched once and searched locally rather
 * than requesting the server for each keystroke.
 */
export const officeEquipmentModelOptionsQuery = (equipmentTypeId: string | undefined) =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: officeEquipmentModelKeys.options(equipmentTypeId),
    queryFn: () =>
      officeEquipmentModelsApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        equipmentTypeId,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: !!equipmentTypeId,
    select: (r) => r.items.map((m) => ({ value: m.id, label: m.name })),
  });

/**
 * A model form asks only for the specifications of its selected equipment type. Before a type is
 * chosen the query must stay disabled; an empty response then means that type requires no such
 * fields. The set changes through migrations, so repeated form openings can reuse the cache.
 */
export const officeEquipmentSpecsQuery = (equipmentTypeId: string | undefined) =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: officeEquipmentModelKeys.specs(equipmentTypeId),
    queryFn: () => officeEquipmentSpecsApi.list(equipmentTypeId!),
    enabled: !!equipmentTypeId,
  });

/**
 * A consumable can fit models of several equipment types, so its editor must offer all active
 * models. Type names distinguish identically named models. The canonical model query normally
 * waits for a type; this observer enables its all-types key and uses its own label projection.
 * Existing inactive links are restored by the form through `withSavedOption`.
 */
export const officeEquipmentModelPickerQuery = () => {
  const base = officeEquipmentModelOptionsQuery(undefined);
  return {
    queryKey: base.queryKey,
    ...queryProfileOptions(base),
    queryFn: base.queryFn,
    enabled: true,
    select: (r: Awaited<ReturnType<typeof officeEquipmentModelsApi.list>>) =>
      r.items.map((m) => ({ value: m.id, label: `${m.name} · ${m.type.name}` })),
  };
};

/**
 * One request carrier serves the consumable picker family. Historical usage filters include
 * inactive items; purchase and service forms ask for active items. A model narrows the service
 * form, while the all-items toggle omits that filter. All variants retain the alphabetical order
 * that the server's default list order would not provide.
 */
export const officeEquipmentConsumablePickerQuery = ({
  activeOnly = false,
  modelId,
}: { activeOnly?: boolean; modelId?: string } = {}) =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: officeEquipmentConsumableKeys.picker({ activeOnly, modelId }),
    queryFn: () =>
      officeEquipmentConsumablesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        ...(activeOnly ? { isActive: 'true' } : {}),
        modelId,
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });

export const officeEquipmentConsumableFilterQuery = () => {
  const base = officeEquipmentConsumablePickerQuery();
  return {
    queryKey: base.queryKey,
    ...queryProfileOptions(base),
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof officeEquipmentConsumablesApi.list>>) =>
      r.items.map((c) => ({ value: c.id, label: `${c.name} · ${c.code}` })),
  };
};

/**
 * Purchase forms need complete active stock records, including demand, quantity and amounts
 * already ordered. Those values come from the server's calculation; a second calculation in the
 * portal could disagree. Historical usage filters keep inactive records in their own variant.
 */
export const officeEquipmentActiveConsumablesQuery = () => {
  const base = officeEquipmentConsumablePickerQuery({ activeOnly: true });
  return {
    queryKey: base.queryKey,
    ...queryProfileOptions(base),
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof officeEquipmentConsumablesApi.list>>) => r.items,
  };
};

export const officeEquipmentConsumablesForModelQuery = (modelId: string | undefined) =>
  officeEquipmentConsumablePickerQuery({ activeOnly: true, modelId });

/** The modal needs complete type records; selectors project the same cached response. */
export const officeEquipmentTypeRecordsQuery = () => {
  const base = officeEquipmentTypeOptionsQuery();
  return {
    queryKey: base.queryKey,
    ...queryProfileOptions(base),
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof officeEquipmentTypesApi.list>>) => r,
  };
};
