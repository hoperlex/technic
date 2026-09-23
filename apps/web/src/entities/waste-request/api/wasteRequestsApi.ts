import type {
  CompleteWasteRequestInput,
  ListResult,
  PresentContainerGroupDto,
  RequestHistoryEntryDto,
  RequestStatus,
  RequestType,
  WasteRequestDto,
  WasteRequestHistorySummaryDto,
  WasteRequestSummaryDto,
  WasteStatsDto,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

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

export const wasteRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<WasteRequestDto>>('/waste-requests', { query: q }),
  /** Наличие контейнеров на площадках (присутствующие заявки установки). */
  present: (q: Query) =>
    apiFetch<ListResult<WasteRequestDto>>('/waste-requests/present', { query: q }),
  /**
   * Группы присутствия на объекте: что и чьё там стоит, сколько штук (ADR 0054). Одна выборка на
   * выбор контейнера в заявке, потолок количества и подсказку «кого звать на этот объект».
   */
  presentGroups: (objectId: string) =>
    apiFetch<PresentContainerGroupDto[]>('/waste-requests/present-groups', {
      query: { objectId },
    }),
  /** Счётчики заявок по статусам — сводка над списком; сужается только фильтром по объекту. */
  summary: (q: Query) => apiFetch<WasteRequestSummaryDto>('/waste-requests/summary', { query: q }),
  /**
   * Журнал закрытых заявок — вкладка «История» (ADR 0135): завершённые и отменённые. Своя ручка,
   * а не список с фильтром: в списке закрытых заявок нет вовсе, и вопросы к журналу другие.
   */
  historyList: (q: Query) =>
    apiFetch<ListResult<WasteRequestDto>>('/waste-requests/history', { query: q }),
  /** Итог журнала по тем же фильтрам: сколько закрыто, чем закончилось, что вывезли. */
  historySummary: (q: Query) =>
    apiFetch<WasteRequestHistorySummaryDto>('/waste-requests/history/summary', { query: q }),
  /**
   * Статистика за отчётный месяц — вкладка «Статистика» (план `docs/waste-stats-tab-plan.md`):
   * площадки, объём и деньги, детализация по видам отходов тем же ответом. Считает её слой
   * сводной аналитики — тот же, что собирает книгу Excel, второго счёта тех же чисел нет.
   */
  stats: (month: string) => apiFetch<WasteStatsDto>('/waste-requests/stats', { query: { month } }),
  get: (id: string) => apiFetch<WasteRequestDto>(`/waste-requests/${id}`),
  /** События заявки в хронологическом порядке: создание, правки, смены статусов (ADR 0012). */
  history: (id: string) => apiFetch<RequestHistoryEntryDto[]>(`/waste-requests/${id}/history`),
  create: (body: WasteRequestPayload) =>
    apiFetch<WasteRequestDto>('/waste-requests', { method: 'POST', body }),
  update: (id: string, body: WasteRequestUpdatePayload) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}`, { method: 'PATCH', body }),
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
    }),
  /**
   * Примечание исполнителя — вторая строка комментария заявки (ADR 0053). Отдельной ручкой:
   * оператор заявку не редактирует, а общий PATCH пересчитывает её предмет и тариф.
   */
  setOperatorComment: (id: string, operatorComment: string, version: number) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/comment`, {
      method: 'PATCH',
      body: { operatorComment, version },
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
    }),
  /**
   * Добавочные талоны выполненной заявки (ADR 0189) — бумага, не поспевшая к закрытию. Своей
   * ручкой, а не повторным закрытием: статус заявка уже не меняет, факт остаётся предъявленным.
   */
  addTickets: (id: string, ticketFileIds: string[], version: number) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/ticket-files`, {
      method: 'POST',
      body: { ticketFileIds, version },
    }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean; mode: string }>(`/waste-requests/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<WasteRequestDto>(`/waste-requests/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем (ADR 0070) — только из архива и только администратором. */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/waste-requests/${id}/purge`, { method: 'DELETE' }),
};
