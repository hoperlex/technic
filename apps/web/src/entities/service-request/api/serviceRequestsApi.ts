import type {
  ApproveServiceEstimateInput,
  AssignServiceInput,
  CompleteServiceRequestInput,
  CreateServiceRequestInput,
  DeclineServiceRequestInput,
  PutServiceEstimateInput,
  RequestHistoryEntryDto,
  ServiceFileKind,
  ServiceRequestDto,
  ServiceStatusChangeInput,
  ServiceWarrantyRowDto,
  SubmitServiceEstimateInput,
  UpdateServiceRequestInput,
} from '@technic/contracts';
import {
  apiFetch,
  createGetApi,
  createListApi,
  createRemoveApi,
  createWriteApi,
  type ListResult,
  type Query,
} from '@shared/api';

const PATH = '/service-requests';

/** Тело перехода без данных: версия сверяется в `WHERE`, оптимистическая блокировка (Р30). */
interface VersionOnly {
  version: number;
}

/** Переход, отменяющий чужую работу: причина обязательна (§5.3). */
interface ReasonInput extends VersionOnly {
  reason: string;
}

/** Приёмка: комментарий необязателен — решение выражено самим переходом. */
interface CommentInput extends VersionOnly {
  comment?: string;
}

const patch = <T>(id: string, tail: string, body: unknown) =>
  apiFetch<T>(`${PATH}/${id}${tail}`, { method: 'PATCH', body });

/**
 * Заявки на обслуживание оргтехники (ADR 0085).
 *
 * Каждый переход с содержанием — своя ручка, а не общий `changeStatus` с полем «данные» (§8.1):
 * так проверка условия перехода на сервере не может разъехаться с проверкой данных этого
 * перехода, а портал не имеет возможности отправить смету туда, где её не ждут. `changeStatus`
 * остаётся отмене и административным откатам — у них из содержания только причина.
 *
 * Все изменяющие ручки принимают `version` (Р30): между открытием карточки и нажатием кнопки
 * заявку мог продвинуть другой человек, и молча затирать его решение нельзя.
 *
 * Ответ у переходов один и тот же — обновлённая заявка: следующее действие (предъявить смету
 * сразу после её правки) требует новой версии, а перезапрашивать карточку ради номера версии
 * значило бы гонку с самим собой.
 */
export const serviceRequestsApi = {
  ...createListApi<ServiceRequestDto>(PATH),
  ...createGetApi<ServiceRequestDto>(PATH),
  ...createWriteApi<ServiceRequestDto, CreateServiceRequestInput, UpdateServiceRequestInput>(PATH),
  ...createRemoveApi<{ ok: boolean }>(PATH),

  history: (id: string) => apiFetch<RequestHistoryEntryDto[]>(`${PATH}/${id}/history`),

  /**
   * Реестр действующих гарантий (§9.5): строки двух видов — гарантия поставщика на единицу и
   * гарантия на выполненную позицию ремонта. Своей ручки создания у реестра нет: он отвечает на
   * вопрос «что ещё покрыто», а обращение по гарантии заводится обычной заявкой с источником.
   */
  warranties: (query: Query) =>
    apiFetch<ListResult<ServiceWarrantyRowDto>>(`${PATH}/warranties`, { query }),

  /**
   * Сколько заявок ждёт решения самого спрашивающего — число для бейджа в меню. Счётчиком, а не
   * первой страницей списка: бейдж рисуется в каркасе портала на любом экране, а сами заявки
   * нужны уже в разделе. Сторону считает сервер по правам учётки — портал её не передаёт.
   */
  waitingCount: () => apiFetch<{ count: number }>(`${PATH}/waiting-count`),

  /** Назначение и переназначение исполнителя: при смене сервиса причина обязательна (§5.3). */
  assignService: (id: string, body: AssignServiceInput) =>
    patch<ServiceRequestDto>(id, '/service', body),
  /** Отказ исполнителя: заявка снова ничья, у неё стирается сервис. */
  decline: (id: string, body: DeclineServiceRequestInput) =>
    patch<ServiceRequestDto>(id, '/decline', body),
  /** Взятие в диагностику — единственный переход исполнителя без содержания. */
  start: (id: string, body: VersionOnly) => patch<ServiceRequestDto>(id, '/start', body),

  /**
   * Состав сметы целиком: смета — документ, и «добавить строку» без остальных строк не имеет
   * смысла. Поэтому PUT, а не POST по строке.
   */
  saveEstimate: (id: string, body: PutServiceEstimateInput) =>
    apiFetch<ServiceRequestDto>(`${PATH}/${id}/estimate`, { method: 'PUT', body }),
  /** Предъявление сметы: ревизия +1, либо гарантийный ремонт без оплаты (Р27). */
  submitEstimate: (id: string, body: SubmitServiceEstimateInput) =>
    patch<ServiceRequestDto>(id, '/estimate/submit', body),
  /** Согласование и отклонение — одна ручка: у них одно право, одна область и один момент. */
  decideEstimate: (id: string, body: ApproveServiceEstimateInput) =>
    patch<ServiceRequestDto>(id, '/estimate/approval', body),
  /** Переоткрытие согласованной сметы — единственный путь её изменить (Р14). */
  reopenEstimate: (id: string, body: ReasonInput) =>
    patch<ServiceRequestDto>(id, '/estimate/reopen', body),

  /** Закрытие работ: отметки факта по строкам. Итог не передаётся — его считает сервер (Р12). */
  complete: (id: string, body: CompleteServiceRequestInput) =>
    patch<ServiceRequestDto>(id, '/complete', body),
  accept: (id: string, body: CommentInput) => patch<ServiceRequestDto>(id, '/accept', body),
  rework: (id: string, body: ReasonInput) => patch<ServiceRequestDto>(id, '/rework', body),
  /** Только отмена и административные откаты (Р18) — остальное ходит своими ручками. */
  changeStatus: (id: string, body: ServiceStatusChangeInput) =>
    patch<ServiceRequestDto>(id, '/status', body),
  /** Примечание исполнителя: заявку не редактирует, границу сторон не двигает (приём ADR 0053). */
  saveServiceComment: (id: string, body: { serviceComment: string; version: number }) =>
    patch<ServiceRequestDto>(id, '/service-comment', body),

  /** Подшивка документа: вид говорит, чем именно закрыта работа (§8.3). */
  attachFiles: (id: string, fileIds: string[], kind: ServiceFileKind) =>
    apiFetch<ServiceRequestDto>(`${PATH}/${id}/files`, {
      method: 'POST',
      body: { fileIds, kind },
    }),
  detachFile: (id: string, fileId: string) =>
    apiFetch<{ ok: boolean }>(`${PATH}/${id}/files/${fileId}`, { method: 'DELETE' }),

  /** Возврат из архива (ADR 0070) и удаление насовсем (ADR 0060) — слова портала, не HTTP. */
  restore: (id: string) => apiFetch<ServiceRequestDto>(`${PATH}/${id}/restore`, { method: 'POST' }),
  purge: (id: string) => apiFetch<{ ok: boolean }>(`${PATH}/${id}/purge`, { method: 'DELETE' }),
};
