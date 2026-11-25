import {
  WASTE_REQUEST_CAPABILITY_HEADER,
  WASTE_REQUEST_CAPABILITY_SNOW,
  type CompleteWasteRequestInput,
  type ListResult,
  type PresentContainerGroupDto,
  type RequestHistoryEntryDto,
  type RequestStatus,
  type RequestType,
  type WasteRequestCapabilitiesDto,
  type WasteRequestDeleteMode,
  type WasteRequestDto,
  type WasteRequestHistorySummaryDto,
  type WasteRequestSummaryDto,
  type WasteStatsDto,
  type WasteStatsKind,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';
import type { RequestCreateReconciliation } from '@shared/lib';

/**
 * Ручки заявок «Вывоз мусора» (ADR 0010, ADR 0035, ADR 0054): установка, замена и снятие
 * контейнера на площадке, назначение оператора вывоза, закрытие фактом, журнал и статистика.
 *
 * Вместе с ручками сюда переехали два портальных тела запроса — заведения и правки. В контрактах
 * их нет, и отдельного модуля им не заводится: ни одно поле не читается никем, кроме `create`,
 * `update` и формы, которая их собирает, а порознь тело и ручка разошлись бы молча — сервер
 * ответил бы отказом там, где типы сошлись.
 *
 * Талоны закрытия ходят по адресам `/waste-requests/<id>/tickets`, но живут в
 * `@entities/waste-ticket` и сюда не тянутся: сосед по слою слайсу недоступен, а общего у них
 * ровно один идентификатор заявки. Здесь остался только пул файлов талонов — им заявка
 * закрывается и к нему же докладывают бумагу, не поспевшую к закрытию (ADR 0189).
 */

export interface WasteRequestPayload {
  objectId: string;
  requestType: RequestType;
  containerTypeId?: string;
  /** Чей контейнер снимаем/меняем и сколько единиц (ADR 0054); только у замены и снятия. */
  containerOwnerCounterpartyId?: string;
  containersCount?: number;
  /** Подтверждение вывоза чужого контейнера — причиной. */
  ownerMismatchReason?: string;
  wasteTypeId?: string;
  volumeM3?: number;
  /** Контрагент-оператор вывоза; можно назначить позже (ADR 0010). */
  operatorCounterpartyId?: string;
  deliveryAt: string;
  /** Кто принимает машину на площадке (миграция 0062); при заведении заявки обязателен. */
  responsibleName: string;
  responsiblePhone: string;
  comment?: string;
  fileIds?: string[];
}

export interface WasteRequestUpdatePayload {
  objectId?: string;
  requestType?: RequestType;
  containerTypeId?: string | null;
  containerOwnerCounterpartyId?: string | null;
  containersCount?: number;
  ownerMismatchReason?: string;
  wasteTypeId?: string | null;
  volumeM3?: number | null;
  operatorCounterpartyId?: string | null;
  // Факта выполнения здесь нет: он предъявляется закрытием заявки и правится повторным
  // закрытием (ADR 0035).
  deliveryAt?: string;
  // Не переданный контакт означает «не трогали»; пустым сервер его оставить не даст.
  responsibleName?: string;
  responsiblePhone?: string;
  comment?: string;
  addFileIds?: string[];
  removeFileIds?: string[];
  version: number;
}

/**
 * Every waste request call declares that this build understands snow removal (snow-removal plan,
 * §3.5). The API answers a call without it as an older tab: snow is filtered out of lists and
 * summaries, and a direct snow request gets `426 client_upgrade_required`. A handle that forgot the
 * header would silently lose snow rows, so every handle below spreads this object. The value comes
 * from the contracts, the same constant the API reads.
 *
 * A spread object and not a wrapper around `apiFetch`: the cache-invalidation scan reads each
 * handle's verb from the literal `method` of its `apiFetch` call, and a wrapper with a dynamic
 * method would turn every write of this slice into an unproven one.
 */
const SNOW_CAPABLE = {
  [WASTE_REQUEST_CAPABILITY_HEADER]: WASTE_REQUEST_CAPABILITY_SNOW,
} as const;

/**
 * Statistics reply as it arrives: an API from before snow neither knows nor echoes `kind`, so the
 * field is optional until the tab has validated the reply (`entities/waste-request/model/stats`).
 */
export type WasteStatsReply = Omit<WasteStatsDto, 'kind'> & { kind?: WasteStatsKind };

export const wasteRequestsApi = {
  /**
   * What the serving API supports (snow-removal plan, §3.5). An API from before snow has no such
   * route: the path then falls into `GET /waste-requests/:id` and fails, which the portal reads as
   * "support not confirmed", exactly like a temporarily unavailable server.
   */
  capabilities: () =>
    apiFetch<WasteRequestCapabilitiesDto>('/waste-requests/capabilities', {
      headers: SNOW_CAPABLE,
    }),
  list: (q: Query) =>
    apiFetch<ListResult<WasteRequestDto>>('/waste-requests', { query: q, headers: SNOW_CAPABLE }),
  /** Наличие контейнеров на площадках (присутствующие заявки установки). */
  present: (q: Query) =>
    apiFetch<ListResult<WasteRequestDto>>('/waste-requests/present', {
      query: q,
      headers: SNOW_CAPABLE,
    }),
  /**
   * Группы присутствия на объекте: что и чьё там стоит, сколько штук (ADR 0054). Одна выборка на
   * выбор контейнера в заявке, потолок количества и подсказку «кого звать на этот объект».
   */
  presentGroups: (objectId: string) =>
    apiFetch<PresentContainerGroupDto[]>('/waste-requests/present-groups', {
      query: { objectId },
      headers: SNOW_CAPABLE,
    }),
  /** Счётчики заявок по статусам — сводка над списком; сужается только фильтром по объекту. */
  summary: (q: Query) =>
    apiFetch<WasteRequestSummaryDto>('/waste-requests/summary', {
      query: q,
      headers: SNOW_CAPABLE,
    }),
  /**
   * Журнал закрытых заявок — вкладка «История» (ADR 0135): завершённые и отменённые. Своя ручка,
   * а не список с фильтром: в списке закрытых заявок нет вовсе, и вопросы к журналу другие.
   */
  historyList: (q: Query) =>
    apiFetch<ListResult<WasteRequestDto>>('/waste-requests/history', {
      query: q,
      headers: SNOW_CAPABLE,
    }),
  /** Итог журнала по тем же фильтрам: сколько закрыто, чем закончилось, что вывезли. */
  historySummary: (q: Query) =>
    apiFetch<WasteRequestHistorySummaryDto>('/waste-requests/history/summary', {
      query: q,
      headers: SNOW_CAPABLE,
    }),
  /**
   * Статистика за отчётный месяц — вкладка «Статистика» (план `docs/waste-stats-tab-plan.md`):
   * площадки, объём и деньги, детализация по видам отходов тем же ответом. Считает её слой
   * сводной аналитики — тот же, что собирает книгу Excel, второго счёта тех же чисел нет.
   */
  stats: (month: string, kind: WasteStatsKind) =>
    apiFetch<WasteStatsReply>('/waste-requests/stats', {
      // Garbage keeps the bare `?month=` an API from before snow understands; only snow names its
      // kind, and an API that ignores the parameter is caught by the missing echo, not trusted.
      query: kind === 'waste' ? { month } : { month, kind },
      headers: SNOW_CAPABLE,
    }),
  get: (id: string) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}`, { headers: SNOW_CAPABLE }),
  /** События заявки в хронологическом порядке: создание, правки, смены статусов (ADR 0012). */
  history: (id: string) =>
    apiFetch<RequestHistoryEntryDto[]>(`/waste-requests/${id}/history`, {
      headers: SNOW_CAPABLE,
    }),
  create: (body: WasteRequestPayload, idempotencyKey?: string) => {
    const options = {
      method: 'POST',
      body,
      headers: idempotencyKey
        ? { ...SNOW_CAPABLE, 'Idempotency-Key': idempotencyKey }
        : { ...SNOW_CAPABLE },
    } as const;
    return idempotencyKey
      ? apiFetch<WasteRequestDto>('/waste-requests/_create-with-receipt', options)
      : apiFetch<WasteRequestDto>('/waste-requests', options);
  },
  reconcileCreate: (body: WasteRequestPayload, idempotencyKey: string) =>
    apiFetch<RequestCreateReconciliation>('/waste-requests/_create-attempts/reconcile', {
      method: 'POST',
      body: { originalBody: body },
      headers: { ...SNOW_CAPABLE, 'Idempotency-Key': idempotencyKey },
    }),
  update: (id: string, body: WasteRequestUpdatePayload) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}`, {
      method: 'PATCH',
      body,
      headers: SNOW_CAPABLE,
    }),
  /**
   * Назначение/снятие оператора вывоза; предмет заявки и тариф не пересчитываются (ADR 0010).
   * `ownerMismatchReason` — подтверждение вывоза чужого контейнера: назначение и есть тот момент,
   * когда расхождение возникает (ADR 0054).
   */
  assignOperator: (
    id: string,
    operatorCounterpartyId: string | null,
    version: number,
    ownerMismatchReason?: string,
  ) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/operator`, {
      method: 'PATCH',
      body: { operatorCounterpartyId, version, ownerMismatchReason },
      headers: SNOW_CAPABLE,
    }),
  /**
   * Примечание исполнителя — вторая строка комментария заявки (ADR 0053). Отдельной ручкой:
   * оператор заявку не редактирует, а общий PATCH пересчитывает её предмет и тариф.
   */
  setOperatorComment: (id: string, operatorComment: string, version: number) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/comment`, {
      method: 'PATCH',
      body: { operatorComment, version },
      headers: SNOW_CAPABLE,
    }),
  /**
   * `comment` уходит в историю статусов; при отмене это обязательная причина.
   * `completion` принимается только при закрытии заявки — факт вывоза фиксируется тем же
   * запросом, что и статус (ADR 0035).
   */
  changeStatus: (
    id: string,
    status: RequestStatus,
    version: number,
    // Что предъявляется вместе со статусом, зависит от типа заявки, поэтому необязательные
    // части собраны в объект: позиционным списком из пяти аргументов вызов стал бы нечитаемым.
    extra: {
      comment?: string;
      /** Факт вывоза: фактический объём и стоимость — только вывоз мусора (ADR 0035). */
      completion?: CompleteWasteRequestInput;
      /** Талоны закрытия — общий пул заявки у любого типа (ADR 0013, ADR 0024). */
      ticketFileIds?: string[];
    } = {},
  ) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/status`, {
      method: 'PATCH',
      body: {
        status,
        version,
        comment: extra.comment ?? '',
        ...(extra.completion ? { completion: extra.completion } : {}),
        ticketFileIds: extra.ticketFileIds ?? [],
      },
      headers: SNOW_CAPABLE,
    }),
  /**
   * Добавочные талоны выполненной заявки (ADR 0189) — бумага, не поспевшая к закрытию. Своей
   * ручкой, а не повторным закрытием: статус заявка уже не меняет, факт остаётся предъявленным.
   */
  addTickets: (id: string, ticketFileIds: string[], version: number) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/ticket-files`, {
      method: 'POST',
      body: { ticketFileIds, version },
      headers: SNOW_CAPABLE,
    }),
  /**
   * Sends what the person confirmed: the version they saw and the mode the dialog promised
   * (snow-removal plan, §3.2). The server compares both with the locked row and answers 409 on
   * drift, so a confirmation to archive never turns into a hard delete after a rollback to «Новая».
   */
  remove: (id: string, confirmed: { version: number; mode: WasteRequestDeleteMode }) =>
    apiFetch<{ ok: boolean; mode: string }>(`/waste-requests/${id}`, {
      method: 'DELETE',
      query: confirmed,
      headers: SNOW_CAPABLE,
    }),
  restore: (id: string) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/restore`, {
      method: 'POST',
      headers: SNOW_CAPABLE,
    }),
  /**
   * Удаление насовсем (ADR 0070) — только из архива и только администратором. `version` — та
   * архивная версия, которую человек видел, подтверждая: восстановленную и снова удалённую заявку
   * сервер этим подтверждением не снесёт.
   */
  purge: (id: string, version: number) =>
    apiFetch<{ ok: boolean }>(`/waste-requests/${id}/purge`, {
      method: 'DELETE',
      query: { version },
      headers: SNOW_CAPABLE,
    }),
};
