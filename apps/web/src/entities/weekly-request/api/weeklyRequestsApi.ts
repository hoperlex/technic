import type {
  AnnulWeeklyRequestBody,
  ApproveWeeklyRequestBody,
  CreateWeeklyRequestBody,
  UpdateWeeklyRequestBody,
  WeeklyAnnulPreviewDto,
  WeeklyApplyResultDto,
  WeeklyCorrectionPreviewDto,
  WeeklyRequestDocumentsDto,
  WeeklyRequestStatus,
  ReturnWeeklyRequestBody,
  WeeklyRequestStatusBody,
  WeeklyReversalResultDto,
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
 *
 * Площадка заказывает не машину на срок, а неделю целиком, и виза руководителя строительства
 * продлевает сроки и порождает обычные заказы той же транзакцией (Р1, Р6). Отсюда два правила,
 * которые здесь и живут, потому что держат их эти ручки:
 *
 * - состав правится ЦЕЛИКОМ (`items` переписывается массивом), а не операциями «добавить строку»:
 *   две одновременные правки иначе собрали бы дубли;
 * - `version` в теле — токен оптимистичной блокировки: сервер сверяет его с текущей версией и
 *   присваивает колонке своё значение.
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
  /**
   * What annulment of this week would reverse (ADR 0218): which ESM-2 sheets burn, which are
   * trimmed, which worked ones must be named, which planned decisions are cancelled and which days
   * leave routes.
   *
   * The server computes it with the code that will execute it and returns a fingerprint of the
   * consequences, which the window sends back. The portal has no computation of its own: otherwise
   * the window would promise something other than what happens.
   *
   * Requested **on the click**, not with the card: the plan builds a history and paper plan per
   * extended row, and paying that on every card view is waste.
   */
  annulPreview: (id: string) =>
    apiFetch<WeeklyAnnulPreviewDto>(`/weekly-vehicle-requests/${id}/annul`),
  /**
   * Annul the applied week. The body carries the reason, the header version and both fingerprints;
   * the correction branch adds the operation key and the sheets named for reissue.
   *
   * A repeat with the same `operationId` is not an error but the answer to a dropped connection:
   * the server returns the counters of the first attempt from the operation's journal payload and
   * moves nothing a second time. The window invents the key before sending and keeps it.
   */
  annul: (id: string, body: AnnulWeeklyRequestBody) =>
    apiFetch<WeeklyReversalResultDto>(`/weekly-vehicle-requests/${id}/annul`, {
      method: 'POST',
      body,
    }),
  /**
   * What the return for re-approval would reverse (ADR 0219) — the same plan as annulment, with
   * the rights and wording of the return.
   */
  returnPreview: (id: string) =>
    apiFetch<WeeklyAnnulPreviewDto>(`/weekly-vehicle-requests/${id}/return`),
  /**
   * Return an applied week to "awaiting approval". Same body as annulment, same idempotency: a
   * repeat with the same `operationId` answers with the counters of the first attempt, read from
   * the operation's journal payload, and moves nothing again.
   */
  returnToApproval: (id: string, body: ReturnWeeklyRequestBody) =>
    apiFetch<WeeklyReversalResultDto>(`/weekly-vehicle-requests/${id}/return`, {
      method: 'POST',
      body,
    }),
  /** Чек-лист готовности недели (§5 шаг 6) — экран, ради которого модуль и делается. */
  documents: (id: string) =>
    apiFetch<WeeklyRequestDocumentsDto>(`/weekly-vehicle-requests/${id}/documents`),
  history: (id: string) =>
    apiFetch<WeeklyRequestHistoryEntryDto[]>(`/weekly-vehicle-requests/${id}/history`),
};
