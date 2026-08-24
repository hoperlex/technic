import type {
  ModuleMailOutcome,
  ServiceRequestDto,
  ServiceRequestKind,
  WarrantyClaimSource,
} from '@technic/contracts';
import { serviceRequestsApi } from '@entities/service-request';
import {
  consumableLinesChanged,
  consumableLinesPayload,
  type ConsumableLineValue,
} from './ServiceRequestConsumables';
import type { WarrantyClaimPreset } from './ServiceRequestForm';

/** Значения формы заявки: то, что человек заполнил, а не то, что уйдёт на сервер. */
export interface ServiceFormValues {
  officeEquipmentId: string;
  /** Вид заявки (Н1): ремонт или расходники. При правке не спрашивается — это другая заявка. */
  kind?: ServiceRequestKind;
  /** Строки номенклатуры — только у расходников (Н9). */
  consumables?: ConsumableLineValue[];
  description: string;
  /** Заказчик ключом `CostTargetKey` (Р2): площадка выбранной единицы либо отдел. */
  customer?: string;
  responsibleName: string;
  responsiblePhone: string;
  /** Подразделение заявителя (Н11): идентификатор отдела либо площадки — смотря какая ось. */
  requesterPlaceId?: string;
  comment?: string;
  warrantySource?: WarrantyClaimSource;
  isUrgent?: boolean;
  urgencyReason?: string;
}

/** Что форма знает помимо своих полей: подбор заказчика, ось подразделения, вложения и режим. */
export interface ServiceFormContext {
  /** `null` — заведение новой заявки. */
  request: ServiceRequestDto | null;
  claim?: WarrantyClaimPreset | null;
  /** Отдел-заказчик; `null` — «от площадки», и уходит он явным `null`, а не пропуском (Р12а). */
  customerDepartmentId: string | null;
  /** Подразделение заявителя — только когда выбор был (Н11); иначе пустой объект. */
  requesterPlace: { requesterDepartmentId?: string; requesterObjectId?: string };
  fileIds: string[];
}

/**
 * Отправка формы заявки: заведение и правка одной дорогой.
 *
 * Отдельным модулем от самой формы — не ради длины файла, а потому что это два разных предмета:
 * форма отвечает на «что человек видит и заполняет», здесь — «во что это складывается и какими
 * ручками уходит». Ручек у правки заявки на расходники, например, две, и знать об этом полям
 * незачем.
 *
 * Вид заявки при правке берётся из самой заявки, а не из формы: `kind` менять нельзя вовсе — это
 * другая заявка, — и схема правки его не принимает.
 */
export async function submitServiceRequest(
  values: ServiceFormValues,
  ctx: ServiceFormContext,
): Promise<{ request: ServiceRequestDto; mail: ModuleMailOutcome | null }> {
  const kind: ServiceRequestKind = ctx.request?.kind ?? values.kind ?? 'repair';
  // Позиция прошлого ремонта уходит только вместе с источником `item` и только той, что назвал
  // реестр: сервер сверяет её с техникой заявки и отвечает 422, если она чужая (Р26).
  const warrantyClaim = values.warrantySource
    ? {
        source: values.warrantySource,
        itemId: values.warrantySource === 'item' ? (ctx.claim?.itemId ?? null) : null,
      }
    : undefined;
  const isUrgent = !!values.isUrgent;
  const common = {
    description: values.description.trim(),
    // Заказчик уходит всегда и осознанно (Р12а): отдел — идентификатором, площадка — явным
    // `null`. Пропуск сервер прочёл бы подсказкой и подставил отдел за человека.
    customerDepartmentId: ctx.customerDepartmentId,
    responsibleName: values.responsibleName?.trim() ?? '',
    responsiblePhone: values.responsiblePhone?.trim() ?? '',
    comment: values.comment?.trim() ?? '',
    warrantyClaim,
    // Пара уходит целиком: снятая галочка обязана унести и причину — порознь их не принимает ни
    // схема, ни CHECK в базе.
    isUrgent,
    urgencyReason: isUrgent ? (values.urgencyReason?.trim() ?? '') : '',
  };

  if (ctx.request) {
    const saved = await serviceRequestsApi.update(ctx.request.id, {
      ...common,
      version: ctx.request.version,
    });
    /**
     * Состав строк номенклатуры — своей ручкой и только когда его тронули: правка заявки такого
     * поля не имеет вовсе, а лишний `PUT` поднимал бы версию второй раз на правке телефона.
     * Версия берётся из ответа первой ручки — та её уже подняла, и старая дала бы 409 на ровном
     * месте.
     *
     * По заявке с отметкой о выдаче сервер отвечает 409: состав уже стал основанием записи на
     * складе. Форма до этого не доводит — блок строк в таком состоянии не правится.
     */
    if (kind === 'consumable' && consumableLinesChanged(values.consumables, ctx.request.consumables)) {
      const withLines = await serviceRequestsApi.putConsumables(saved.id, {
        items: consumableLinesPayload(values.consumables),
        version: saved.version,
      });
      return { request: withLines, mail: null };
    }
    // Правка письма службе не шлёт: заявка никуда не переходила, а «исправили формулировку» — не
    // событие. Исход у неё поэтому всегда «письмо не требовалось».
    return { request: saved, mail: null };
  }

  return serviceRequestsApi.create({
    ...common,
    // Подразделение заявителя — выбором из своих и только когда выбор был (Н11).
    ...ctx.requesterPlace,
    officeEquipmentId: values.officeEquipmentId,
    kind,
    /**
     * Строки уходят **заведением**, а не отдельным `PUT` следом: заявка на расходники без строк
     * запрещена постановкой, и разложенное на два запроса заведение оставляло бы её в этом
     * состоянии всякий раз, когда второй запрос не дошёл.
     */
    consumables: kind === 'consumable' ? consumableLinesPayload(values.consumables) : undefined,
    fileIds: ctx.fileIds,
  });
}
