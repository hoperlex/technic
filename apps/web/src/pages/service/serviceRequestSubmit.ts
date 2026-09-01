import type {
  ModuleMailOutcome,
  ServiceRequestDto,
  ServiceRequestKind,
  WarrantyClaimSource,
} from '@technic/contracts';
import { serviceRequestsApi } from '@entities/service-request';
import type { WarrantyClaimPreset } from './ServiceRequestForm';

/** Значения формы заявки: то, что человек заполнил, а не то, что уйдёт на сервер. */
export interface ServiceFormValues {
  /**
   * Какой аппарат. Необязателен (Р5): пустым его оставляет держатель права
   * `serviceRequests.createWithoutEquipment`, и тогда предмет заявки называет одно описание.
   */
  officeEquipmentId?: string;
  /** Вид заявки (Н1): ремонт или расходники. При правке не спрашивается — это другая заявка. */
  kind?: ServiceRequestKind;
  /**
   * «Аппарат стоит на другом объекте» (Р16) — пара, а не одно поле, и уходит она только целиком:
   * пометка без объекта и объект без пометки схему заведения не проходят (422). При правке пары нет
   * вовсе — заявленный факт историчен и правке не подлежит.
   */
  objectOverridden?: boolean;
  objectId?: string;
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
  /**
   * Площадка-заказчик — вторая половина той же пары; `null` — заказчик не площадка. Нужна только
   * заявке БЕЗ аппарата (Р6): у неё `objectId` означает «для кого», а не «где стоит». У заявки с
   * аппаратом площадку задаёт карточка единицы, и это значение в тело не уходит вовсе.
   */
  customerObjectId: string | null;
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
 *
 * Номенклатуры здесь больше нет ни у заведения, ни у правки (Р15): состав заполняет исполнитель
 * своей ручкой `PUT /:id/consumables`. Принимать строки заведение не перестало — ИТ-служба заводит
 * заявку за сотрудника, зная состав сразу, — но форма портала их не спрашивает, и слать ей нечего.
 */
export async function submitServiceRequest(
  values: ServiceFormValues,
  ctx: ServiceFormContext,
): Promise<{ request: ServiceRequestDto; mail: ModuleMailOutcome | null }> {
  const kind: ServiceRequestKind = ctx.request?.kind ?? values.kind ?? 'repair';
  /*
   * Аппарат: пустая строка и «поля нет» означают тут одно — заявку без аппарата (Р5). Дальше от
   * этого ответа зависят три поля тела, и потому он считается один раз и наверху.
   */
  const equipmentId = values.officeEquipmentId || null;
  // Позиция прошлого ремонта уходит только вместе с источником `item` и только той, что назвал
  // реестр: сервер сверяет её с техникой заявки и отвечает 422, если она чужая (Р26).
  //
  // Без аппарата гарантийного обращения не бывает вовсе (Р7): спорят о гарантии на КОНКРЕТНУЮ
  // единицу. Блока в форме там нет, но значение в ней остаться может — выбрали аппарат, назвали
  // источник, аппарат убрали, — и отправленное, оно стоило бы человеку отказа схемы по полю,
  // которого он на экране уже не видит.
  const warrantyClaim =
    equipmentId && values.warrantySource
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
    // Правка письма службе не шлёт: заявка никуда не переходила, а «исправили формулировку» — не
    // событие. Исход у неё поэтому всегда «письмо не требовалось».
    return { request: saved, mail: null };
  }

  /*
   * Пометка «не тот объект» (Р16) — утверждение о расхождении снимка заявки с карточкой единицы, и
   * без единицы расходиться не с чем (Р7). Поэтому она гасится здесь, а не только прячется блоком:
   * значение в форме переживает и очистку поля техники (блок реквизитов уходит с экрана вместе со
   * своим сбросом), и уйди оно на сервер — заявка получила бы отказ схемы по невидимому полю.
   */
  const objectOverridden = !!equipmentId && !!values.objectOverridden;
  return serviceRequestsApi.create({
    ...common,
    // Подразделение заявителя — выбором из своих и только когда выбор был (Н11).
    ...ctx.requesterPlace,
    // Явным `null`, а не пропуском: «аппарата у заявки нет» — ответ, а не умолчание клиента.
    officeEquipmentId: equipmentId,
    kind,
    /*
     * У `objectId` ДВА СМЫСЛА, и различает их аппарат — ровно как на сервере (Р6).
     *
     * С АППАРАТОМ это «где он стоит на самом деле», и уходит поле только парой с пометкой: пометка
     * без объекта и объект без пометки одинаково отвергаются схемой. Нетронутая галочка не шлёт ни
     * того ни другого — умолчание заявки — объект из карточки техники, и присланный вместе с ним
     * `objectId` сервер прочёл бы как заявление о расхождении, которого никто не делал.
     *
     * БЕЗ АППАРАТА то же поле называет ЗАКАЗЧИКА-площадку: колонка `equipment_object_id` заведует
     * областью роли площадки, и завести туда заявку иначе нечем. Пара с пометкой здесь невозможна
     * (выше), поэтому два смысла не путаются: с пометкой — «не тот объект», без аппарата — «для
     * кого». Вторую половину пары (отдел) шлёт `common` — обе сразу схема не принимает.
     */
    objectOverridden,
    objectId: equipmentId
      ? objectOverridden
        ? values.objectId
        : undefined
      : (ctx.customerObjectId ?? undefined),
    fileIds: ctx.fileIds,
  });
}
