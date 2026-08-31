import {
  OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES,
  type OfficeEquipmentPurchaseConflictDto,
  type OfficeEquipmentPurchaseSnapshotConflictDto,
  type OfficeEquipmentPurchaseStatusConflictDto,
  type OfficeEquipmentPurchaseVersionConflictDto,
} from '@technic/contracts';
import { isApiError } from '@shared/api';

/**
 * Разбор трёх разных 409 плановой закупки (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р17, Р18).
 *
 * ПОЧЕМУ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ТРИ `if` В ФОРМЕ. Отказов у закупки три, и исходы у них
 * РАЗНЫЕ: снимок устарел — показать новые числа и дать отправить ещё раз; ключ отправки занят
 * другой командой — сказать словами и взять новый; черновик правил сосед — показать его состав.
 * Отличает их только код тела, и портал обязан их различать: общий 409 портала показывает
 * «откройте заново» — то есть на устаревшем снимке предложил бы переспросить ровно то же самое, а
 * на занятом ключе позвал бы отправить второй раз то, что уже отправлено.
 *
 * Разбирают их четыре места — форма заведения, форма правки, «Провести» и «Закрыть»/«Отменить», —
 * и три из четырёх разбирают одинаково. Четыре копии `e.status === 409 && e.code === …` разошлись
 * бы на первой же правке кода: код читается из тела ответа, а не проверяется схемой, и опечатка в
 * строке превратила бы отказ в общий тост молча.
 *
 * ЧТО ЗДЕСЬ НЕ ДЕЛАЕТСЯ: решения. Модуль отвечает «какой это отказ и что в нём приехало», а как
 * поступить — дело формы: одной надо переписать строки, другой перечитать карточку.
 */

/** Известный отказ закупки: разобранный `details` вместе с текстом сервера для человека. */
export interface PurchaseConflict {
  message: string;
  details: OfficeEquipmentPurchaseConflictDto | null;
  /**
   * Занятый ключ отправки — единственный из четырёх кодов, у которого `details` нет вовсе:
   * рассказывать про него нечего, кроме самого факта. Отдельным признаком, а не «details === null»:
   * пустой разбор бывает и у испорченного тела, и путать «сервер сказал: ключ занят» с «ответ не
   * разобрали» нельзя.
   */
  idempotency: boolean;
}

/** Тело ответа несёт `kind`, по которому и разбирается объединение контракта. */
function detailsOf(raw: unknown): OfficeEquipmentPurchaseConflictDto | null {
  if (typeof raw !== 'object' || raw === null || !('kind' in raw)) return null;
  const kind = (raw as { kind: unknown }).kind;
  return kind === 'snapshot' || kind === 'status' || kind === 'version'
    ? (raw as OfficeEquipmentPurchaseConflictDto)
    : null;
}

/**
 * Отказ закупки или `null`, если это что-то другое — 403, 422, сеть.
 *
 * Проверяются И статус, И код: 409 с чужим кодом (общий `version_conflict` откуда-нибудь ещё)
 * разбирать этим модулем нельзя — его `details` описан другим контрактом.
 */
export function purchaseConflictOf(e: unknown): PurchaseConflict | null {
  if (!isApiError(e) || e.status !== 409) return null;
  const codes: string[] = Object.values(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES);
  if (!codes.includes(e.code)) return null;
  return {
    message: e.message,
    details: detailsOf(e.details),
    idempotency: e.code === OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.idempotency,
  };
}

/** «Числа по складу изменились»: в ответе — только разошедшиеся строки с новыми значениями. */
export function snapshotConflictOf(
  conflict: PurchaseConflict | null,
): OfficeEquipmentPurchaseSnapshotConflictDto | null {
  return conflict?.details?.kind === 'snapshot' ? conflict.details : null;
}

/** «Ход из этого состояния уже не делают»: документ провёл, закрыл или отменил сосед. */
export function statusConflictOf(
  conflict: PurchaseConflict | null,
): OfficeEquipmentPurchaseStatusConflictDto | null {
  return conflict?.details?.kind === 'status' ? conflict.details : null;
}

/** «Черновик правил другой»: приехали свежая версия и свежий состав целиком. */
export function versionConflictOf(
  conflict: PurchaseConflict | null,
): OfficeEquipmentPurchaseVersionConflictDto | null {
  return conflict?.details?.kind === 'version' ? conflict.details : null;
}
