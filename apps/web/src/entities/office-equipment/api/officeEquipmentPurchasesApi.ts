import type {
  CancelOfficeEquipmentPurchaseInput,
  CloseOfficeEquipmentPurchaseInput,
  CreateOfficeEquipmentPurchaseInput,
  OfficeEquipmentPurchaseDetailDto,
  OfficeEquipmentPurchaseDto,
  OfficeEquipmentPurchasePrefillDto,
  SubmitOfficeEquipmentPurchaseInput,
  UpdateOfficeEquipmentPurchaseInput,
} from '@technic/contracts';
import { apiFetch, createGetApi, createListApi } from '@shared/api';

const PATH = '/office-equipment-purchases';

/**
 * Плановая закупка расходников (план `docs/office-equipment-consumables-and-purchase-plan.md`,
 * Р9–Р18; ADR 0146).
 *
 * САМОСТОЯТЕЛЬНЫЙ ДОКУМЕНТ, А НЕ ВИД ЗАЯВКИ, и это видно уже по набору ручек: ни вложений, ни
 * обсуждения, ни срочности, ни писем — только состав, четыре перехода и отмена с причиной.
 * Видимость у неё не по области, а по праву `officeEquipmentPurchases.manage`: остаток расходников
 * один на компанию, значит и заказ по дефициту глобален — ни площадки, ни отдела у такого
 * документа не бывает.
 *
 * `createWriteApi` здесь НЕ разворачивается, хотя заведение и правка есть у обоих. Тела у них
 * разные по существу: заведение несёт заголовок `Idempotency-Key` (без него маршрут отвечает 400),
 * а правка — версию содержимого в теле. Фабрика, не знающая ни того, ни другого, дала бы `create`
 * без ключа — то есть ручку, которая компилируется и всегда отказывает.
 */
export const officeEquipmentPurchasesApi = {
  ...createListApi<OfficeEquipmentPurchaseDto>(PATH),
  ...createGetApi<OfficeEquipmentPurchaseDetailDto>(PATH),
  /**
   * Предзаполнение формы (Р16): позиции с положительным «к закупке» и всё, из чего это число
   * сложилось. Считает его сервер одним местом — два вычислителя дефицита разошлись бы, а по
   * этому числу заказывают.
   */
  prefill: () => apiFetch<OfficeEquipmentPurchasePrefillDto>(`${PATH}/prefill`),
  /**
   * Заведение с КЛЮЧОМ ИДЕМПОТЕНТНОСТИ ЗАГОЛОВКОМ (Р17) — тем же транспортом, что у кабинета
   * водителя (ADR 0103): ключ описывает попытку отправки, а не документ, и место ему в заголовке,
   * а не в теле. Обязателен: ручка новая, legacy-клиентов у неё нет, и необязательный ключ
   * означал бы, что защита от дубля работает у тех, кто её попросил.
   *
   * Параметром, а не сгенерированный здесь: ключ обязан пережить повторное нажатие кнопки, значит
   * порождает его форма при открытии и держит до закрытия. Роди его этот метод — каждое нажатие
   * получало бы свой ключ, и защита выродилась бы в украшение.
   */
  create: (body: CreateOfficeEquipmentPurchaseInput, idempotencyKey: string) =>
    apiFetch<OfficeEquipmentPurchaseDetailDto>(PATH, {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  /**
   * Правка черновика (Р18): только в «Новой» и только под версией содержимого. Ключа
   * идемпотентности у неё нет, и это не забывчивость — повтор правки упирается в ту же версию и
   * получает 409 с текущим состоянием, размножаться тут нечему.
   */
  update: (id: string, body: UpdateOfficeEquipmentPurchaseInput) =>
    apiFetch<OfficeEquipmentPurchaseDetailDto>(`${PATH}/${id}`, { method: 'PATCH', body }),
  /** «Провести» — бумага уходит в снабжение. Несёт версию: уехать обязан тот состав, что видели. */
  submit: (id: string, body: SubmitOfficeEquipmentPurchaseInput) =>
    apiFetch<OfficeEquipmentPurchaseDetailDto>(`${PATH}/${id}/submit`, { method: 'POST', body }),
  /** «Закрыть» с подтверждением «приход занесён» (Р11). Версии не несёт: состав уже неизменяем. */
  close: (id: string, body: CloseOfficeEquipmentPurchaseInput) =>
    apiFetch<OfficeEquipmentPurchaseDetailDto>(`${PATH}/${id}/close`, { method: 'POST', body }),
  /** «Отменить» с обязательной причиной: отменённая без объяснения читается как «передумали». */
  cancel: (id: string, body: CancelOfficeEquipmentPurchaseInput) =>
    apiFetch<OfficeEquipmentPurchaseDetailDto>(`${PATH}/${id}/cancel`, { method: 'POST', body }),
};
