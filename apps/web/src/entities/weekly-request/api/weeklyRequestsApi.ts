import type {
  ApproveWeeklyRequestBody,
  CreateWeeklyRequestBody,
  UpdateWeeklyRequestBody,
  WeeklyApplyResultDto,
  WeeklyCorrectionPreviewDto,
  WeeklyRequestDocumentsDto,
  WeeklyRequestStatus,
  WeeklyRequestStatusBody,
  WeeklySuggestionDto,
  WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

/**
 * Ручки недельной заявки на технику (ADR 0085): документ-основание над заказами ТС.
 *
 * Переехали сюда из общего `api/resources.ts` вместе со своими портальными типами — теми, которых
 * нет в контрактах: строкой истории и ответом решения. Разделять их со слайсом незачем: история
 * недельной заявки шире статусов (состав меняется и без перехода), а ответ решения несёт две
 * половины сразу — саму заявку и итог применения, — и оба типа читаются только здесь и на её
 * странице.
 */

/** Событие истории недельной заявки: и переход статуса, и правка состава (Р17). */
export type WeeklyRequestHistoryEvent = 'status' | 'items_changed' | 'item_dropped';

/**
 * Строка истории недельной заявки. Своя, а не общая `RequestHistoryEntryDto`: у недельной заявки
 * события шире статусов — состав меняется и без перехода (правкой черновика, уборкой строк при
 * `purge`), и такое событие обязано пережить сбой записи аудита (Р17).
 */
export interface WeeklyRequestHistoryEntryDto {
  id: string;
  event: WeeklyRequestHistoryEvent;
  fromStatus: WeeklyRequestStatus | null;
  toStatus: WeeklyRequestStatus | null;
  /** Что именно изменилось: снятые строки с номерами заказов, состав до и после. */
  payload: Record<string, unknown>;
  changedByName: string;
  changedAt: string;
  comment: string;
}

/**
 * Ответ решения — визы, отказа, подачи и снятия: заявка после него и итог применения, если оно
 * состоялось. Двумя половинами, а не одной: виза применяет заявку той же транзакцией (Р6), а
 * подача заявки тем, кто её и визирует, применяет её сразу же (Р8) — и «сколько строк прошло»
 * отвечает только применение. У отказа и снятия итога нет вовсе, поэтому `apply` бывает `null`.
 */
export interface WeeklyDecisionResultDto {
  request: WeeklyVehicleRequestDto;
  apply: WeeklyApplyResultDto | null;
}

export const weeklyRequestsApi = {
  /**
   * Предложение состава на пару «объект + неделя» (Р4): что продлевать, что уезжает, что заказано
   * дольше недели и что в состав не годится — с причинами. Здесь же приходит `existingRequestId`:
   * заявка на эту неделю уже собирается, и кнопка обязана открыть её, а не заводить вторую (Р3).
   */
  suggestion: (q: { objectId: string; weekStart: string }) =>
    apiFetch<WeeklySuggestionDto>('/weekly-vehicle-requests/suggestion', { query: q }),
  create: (body: CreateWeeklyRequestBody) =>
    apiFetch<WeeklyVehicleRequestDto>('/weekly-vehicle-requests', { method: 'POST', body }),
  get: (id: string) => apiFetch<WeeklyVehicleRequestDto>(`/weekly-vehicle-requests/${id}`),
  update: (id: string, body: UpdateWeeklyRequestBody) =>
    apiFetch<WeeklyVehicleRequestDto>(`/weekly-vehicle-requests/${id}`, {
      method: 'PATCH',
      body,
    }),
  /**
   * Переходы составителя: подать и снять с причиной. Визы здесь нет — она отдельным решением; но
   * подача руководителем строительства своей площадки применяет заявку тем же запросом (Р8),
   * поэтому ответ тот же, что и у визы.
   */
  changeStatus: (id: string, body: WeeklyRequestStatusBody) =>
    apiFetch<WeeklyDecisionResultDto>(`/weekly-vehicle-requests/${id}/status`, {
      method: 'POST',
      body,
    }),
  /**
   * Виза либо отказ. Виза применяет заявку сразу: отдельного «применить» не существует (Р6).
   *
   * Этим же вызовом идёт проведение просроченной недели задним числом (ADR 0101): у неё в теле
   * обязателен блок `correction` — ключ операции, причина и названные к перевыписке листы ЭСМ-2.
   * Второй ручки под проведение нет намеренно: решение человека одно — «завизировать и провести», —
   * и разведи его портал по двум вызовам, на экране появились бы две кнопки на одно действие.
   *
   * Повтор с тем же `operationId` — не ошибка, а ответ на обрыв связи: сервер возвращает 200 и
   * `apply: null`, ничего не двигая второй раз. Поэтому ключ придумывает окно **до** отправки и
   * держит его неизменным, а повторная попытка обязана уйти тем же телом целиком (отпечаток
   * команды считается со всей команды, включая версию).
   */
  approval: (id: string, body: ApproveWeeklyRequestBody) =>
    apiFetch<WeeklyDecisionResultDto>(`/weekly-vehicle-requests/${id}/approval`, {
      method: 'POST',
      body,
    }),
  /**
   * Что проведение этой недели тронет в прошлом (ADR 0101): какие номера ЭСМ-2 можно назвать к
   * перевыписке, за какие прошедшие недели выпишется бумага, какая у операции эффективная дата и
   * докуда достаёт глубина права.
   *
   * Считает это сервер тем же кодом, которым будет исполнять, — как и у коррекции рейса: второй
   * расчёт в портале разошёлся бы с первым, и окно обещало бы не то, что произойдёт. Здесь же
   * приходят `allowed` и `blockedReason` — почему провести нельзя, если нельзя: ручка отвечает на
   * этот вопрос и тому, кто проводить не вправе, потому что 403 объяснил бы отсутствие права, но
   * не выход из положения.
   */
  correctionPreview: (id: string) =>
    apiFetch<WeeklyCorrectionPreviewDto>(`/weekly-vehicle-requests/${id}/correction`),
  /** Чек-лист готовности недели (§5 шаг 6) — экран, ради которого модуль и делается. */
  documents: (id: string) =>
    apiFetch<WeeklyRequestDocumentsDto>(`/weekly-vehicle-requests/${id}/documents`),
  history: (id: string) =>
    apiFetch<WeeklyRequestHistoryEntryDto[]>(`/weekly-vehicle-requests/${id}/history`),
};
