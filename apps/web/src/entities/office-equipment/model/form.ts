import type { Dayjs } from 'dayjs';
import type { CreateOfficeEquipmentInput, UpdateOfficeEquipmentInput } from '@technic/contracts';

/**
 * Карточка единицы в форме: значения полей (`OfficeEquipmentFields`) и сборка тела запроса.
 *
 * Живёт в слое сущности вместе с самими полями, потому что заводят единицу из двух мест — из
 * вкладки справочника и из формы заявки, когда техники в списке не нашлось. Пока преобразование
 * лежало в каждом из них, это были два одинаковых списка одиннадцати полей: разойдись они хоть в
 * одном (скажем, перестань один тримить номер), «заведённое из заявки» перестало бы совпадать с
 * «заведённым в справочнике» — а различать их в базе нечем, единица одна и та же.
 */
export interface OfficeEquipmentFormValues {
  equipmentTypeId: string;
  /**
   * Модель записью справочника (Р1), а не строкой ввода. Имени карточки в значениях формы больше
   * нет вовсе: с выпуска A `name` — зеркало имени модели, которое ведёт база (Р3), и отправлять
   * его вместе со ссылкой значило бы дать серверу два ответа на вопрос «что это за аппарат».
   */
  modelId: string;
  serialNumber?: string;
  inventoryNumber?: string;
  objectId: string;
  departmentId?: string;
  location?: string;
  purchasedOn?: Dayjs;
  warrantyUntil?: Dayjs;
  comment?: string;
  isActive: boolean;
}

/** Календарный день без времени: тот же формат, в котором его хранит и отдаёт сервер. */
const DATE = 'YYYY-MM-DD';

/**
 * Тело запроса собирается явно, а не отдаётся значениями формы как есть: даты в форме — объекты
 * `Dayjs`, а сервер ждёт календарный день строкой, и пустое поле обязано прийти `null`, иначе
 * стереть однажды заведённый срок было бы нечем.
 */
export function officeEquipmentPayload(v: OfficeEquipmentFormValues): CreateOfficeEquipmentInput {
  return {
    equipmentTypeId: v.equipmentTypeId,
    modelId: v.modelId,
    serialNumber: v.serialNumber?.trim() ?? '',
    inventoryNumber: v.inventoryNumber?.trim() ?? '',
    objectId: v.objectId,
    departmentId: v.departmentId ?? null,
    location: v.location?.trim() ?? '',
    purchasedOn: v.purchasedOn ? v.purchasedOn.format(DATE) : null,
    warrantyUntil: v.warrantyUntil ? v.warrantyUntil.format(DATE) : null,
    comment: v.comment?.trim() ?? '',
    isActive: v.isActive,
  };
}

/**
 * Тело правки карточки: то же самое **без объекта** (план модернизации, Р59). Переезд — событие с
 * датой, причиной и обеими сторонами, и тихая смена площадки в форме оставляла бы вопрос «где этот
 * аппарат стоял в мае» без ответа. Сервер такое тело и не примет: поле из схемы правки убрано.
 */
export function officeEquipmentUpdatePayload(
  v: OfficeEquipmentFormValues,
): UpdateOfficeEquipmentInput {
  const { objectId: _objectId, ...rest } = officeEquipmentPayload(v);
  return rest;
}
