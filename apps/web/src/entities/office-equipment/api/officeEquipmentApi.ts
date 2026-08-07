import type {
  CreateOfficeEquipmentInput,
  CreateOfficeEquipmentTypeInput,
  OfficeEquipmentDto,
  OfficeEquipmentTypeDto,
  UpdateOfficeEquipmentInput,
  UpdateOfficeEquipmentTypeInput,
} from '@technic/contracts';
import {
  apiFetch,
  createGetApi,
  createListApi,
  createRemoveApi,
  createWriteApi,
} from '@shared/api';

const PATH = '/office-equipment';
const TYPES_PATH = '/office-equipment-types';

/**
 * Справочник оргтехники (ADR 0085): что стоит по кабинетам и площадкам.
 *
 * Карточка (`get`) заведена не «на всякий случай»: единицу открывают ссылкой из заявки на
 * обслуживание, и списка там нет — есть только идентификатор.
 *
 * `remove` гасит запись мягко (Р33), поэтому рядом стоят `restore` и `purge`. Обе — явными
 * ручками, а не фабрикой: «вернуть из архива» и «снести насовсем» — слова портала, а не HTTP, и
 * знать их фабрике в `shared` нечем. Ответы у них разные и не случайно: восстановление возвращает
 * карточку (её тут же показывают в списке), а после `purge` показывать нечего.
 */
export const officeEquipmentApi = {
  ...createListApi<OfficeEquipmentDto>(PATH),
  ...createGetApi<OfficeEquipmentDto>(PATH),
  ...createWriteApi<OfficeEquipmentDto, CreateOfficeEquipmentInput, UpdateOfficeEquipmentInput>(
    PATH,
  ),
  ...createRemoveApi<{ ok: boolean }>(PATH),
  restore: (id: string) =>
    apiFetch<OfficeEquipmentDto>(`${PATH}/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем — только из архива и только без ссылок (ADR 0060). */
  purge: (id: string) => apiFetch<{ ok: boolean }>(`${PATH}/${id}/purge`, { method: 'DELETE' }),
};

/**
 * Перечень типов: МФУ, принтер, ноутбук, монитор. Ведётся в окне из вкладки справочника (Р34) —
 * сам по себе тип ничего не значит, и отдельной вкладки ради десяти строк не заводят.
 *
 * Удаление здесь настоящее, а не пометка: перечень наполняют руками, и заведённый по ошибке код
 * вычищают. Тип, на который уже ссылаются карточки, сервер удалить не даёт — его выключают
 * отметкой «Активен». Отсюда и `{ ok }` в ответе: возвращать после удаления нечего.
 */
export const officeEquipmentTypesApi = {
  ...createListApi<OfficeEquipmentTypeDto>(TYPES_PATH),
  ...createWriteApi<
    OfficeEquipmentTypeDto,
    CreateOfficeEquipmentTypeInput,
    UpdateOfficeEquipmentTypeInput
  >(TYPES_PATH),
  ...createRemoveApi<{ ok: boolean }>(TYPES_PATH),
};
