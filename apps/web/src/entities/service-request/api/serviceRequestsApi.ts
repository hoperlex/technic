import type {
  NotifyServiceRequestInput,
  ServiceRequestNotifyResultDto,
  ServiceRequestWithMailDto,
  ApproveServiceEstimateInput,
  CompleteServiceRequestInput,
  CreateServiceRequestInput,
  DeclineServiceRequestInput,
  PutServiceConsumablesInput,
  PutServiceEstimateInput,
  PutServiceExecutorsInput,
  RequestHistoryEntryDto,
  ServiceFileKind,
  ApproveServiceItInput,
  ServiceRequestDto,
  MarkServiceChatReadInput,
  SendServiceChatMessageInput,
  ServiceChatMessageDto,
  ServiceChatPageDto,
  ServiceStatusChangeInput,
  ServiceWarrantyRowDto,
  SetServiceConsumablesIssuedInput,
  SetServiceUrgencyInput,
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
  /**
   * Заведение отвечает заявкой **и исходом письма службе**: у службы нет учётки в портале, и
   * «заявка заведена, но служба не оповещена» человек обязан узнать сразу, а не когда за ней не
   * приехали. Переопределяет `create` фабрики — форма ответа у него своя.
   */
  create: (body: CreateServiceRequestInput) =>
    apiFetch<ServiceRequestWithMailDto>(PATH, { method: 'POST', body }),
  /** Повторная отправка письма службе: ключ идемпотентности — один на открытие диалога (Р70). */
  notify: (id: string, body: NotifyServiceRequestInput) =>
    apiFetch<ServiceRequestNotifyResultDto>(`${PATH}/${id}/notify`, { method: 'POST', body }),
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

  /**
   * Обсуждение заявки (ADR 0141). Лента страничная и курсорная: `beforeSeq` — подгрузка вверх,
   * `afterSeq` — инкрементальный опрос открытого окна. Смещения у ленты нет и быть не может — она
   * только растёт, и номер страницы съезжал бы на каждую пришедшую реплику.
   */
  chatPage: (id: string, query: { beforeSeq?: number; afterSeq?: number; limit?: number } = {}) =>
    apiFetch<ServiceChatPageDto>(`${PATH}/${id}/messages`, { query }),
  /** Ответ — только созданная реплика и новый `lastSeq`: возвращать полсотни ради одной незачем. */
  sendChatMessage: (id: string, body: SendServiceChatMessageInput) =>
    apiFetch<{ message: ServiceChatMessageDto; lastSeq: number }>(`${PATH}/${id}/messages`, {
      method: 'POST',
      body,
    }),
  /**
   * Подтверждение прочтения — курсор, а не отметка времени (ADR 0141, решение 5). Зовётся ПОСЛЕ
   * успешного показа ленты: отметка на открытии гасила бы разговор и тогда, когда загрузка упала и
   * человек не увидел ничего.
   */
  markChatRead: (id: string, body: MarkServiceChatReadInput) =>
    apiFetch<{ readThroughSeq: number; lastSeq: number }>(`${PATH}/${id}/messages/read`, {
      method: 'POST',
      body,
    }),
  /**
   * «Отметить все прочитанными» по заявкам текущего отбора. Тело — те же параметры, что у списка:
   * кнопка обязана гасить ровно то, что человек видит, а не всё подряд.
   */
  markAllChatRead: (query: Query) =>
    apiFetch<{ count: number }>(`${PATH}/messages/read-all`, { method: 'POST', body: query }),
  /**
   * Сколько заявок несут непрочитанное, адресованное мне, — число для синего бейджа раздела.
   * Отдельно от «ждут меня» (`waitingCount`): вопросы разные, и сумма не отвечает ни на один.
   */
  chatUnreadCount: () => apiFetch<{ count: number }>(`${PATH}/unread-count`),

  /**
   * Исполнители заявки одним действием (Н5, Н6): список своих сотрудников **и**
   * исполнитель-контрагент. Оба поля уходят целиком — это состав, а не добавление: «прислать
   * одного» означало бы, что сервер угадывает, снимали ли кого-то.
   *
   * Ответ несёт исход письма о назначении: оно адресовано **людям**, а не ящику службы, и
   * «назначили, но задание никуда не ушло» назначивший обязан узнать сразу — иначе он будет ждать
   * работу от того, кто о ней не знает.
   */
  putExecutors: (id: string, body: PutServiceExecutorsInput) =>
    apiFetch<ServiceRequestWithMailDto>(`${PATH}/${id}/executors`, { method: 'PUT', body }),
  /**
   * Прежнее назначение контрагента. Остаётся совместимым адаптером на весь выпуск 1 и уходит
   * вместе с ним (план §7.3): её зовёт вкладка, открытая до выката, — портал ходит только новой
   * ручкой выше.
   */
  /** Отказ исполнителя: заявка снова ничья, у неё стирается сервис. */
  decline: (id: string, body: DeclineServiceRequestInput) =>
    patch<ServiceRequestDto>(id, '/decline', body),
  /** Взятие в диагностику — единственный переход исполнителя без содержания. */
  start: (id: string, body: VersionOnly) => patch<ServiceRequestDto>(id, '/start', body),
  /**
   * Заморозка (Р103): своя дуга — своя ручка. Причина обязательна (Р107) — даты «отложена до» у
   * заморозки нет, и на вопрос «когда ждать» отвечает только она. Куда вернуть, портал не
   * присылает: исходный статус сервер берёт из самой заявки (Р104).
   */
  hold: (id: string, body: ReasonInput) => patch<ServiceRequestDto>(id, '/hold', body),
  /** Возврат в работу: цель — `held_from_status`, от человека нужно лишь слово вдогонку. */
  resume: (id: string, body: CommentInput) => patch<ServiceRequestDto>(id, '/resume', body),

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

  /**
   * Состав строк номенклатуры целиком (Н9), как и смета: это список того, что просят, и «добавить
   * одну позицию» без остальных заставляло бы сервер угадывать, снимали ли что-то. Пустой список
   * ручка не принимает — заявка на расходники без строк это заявка без предмета.
   *
   * Правится он только до первой отметки о выдаче: строка, за которой числится движение склада, —
   * уже основание записи на складе, и сервер отвечает на такую правку 409.
   */
  putConsumables: (id: string, body: PutServiceConsumablesInput) =>
    apiFetch<ServiceRequestDto>(`${PATH}/${id}/consumables`, { method: 'PUT', body }),
  /**
   * Правка факта выдачи (Р6). Склад двигает **изменение факта**, а не смена статуса: каждая правка
   * порождает событие журнала на разницу — было 2, стало 3, значит со склада уйдёт одна штука.
   * Отсюда `PATCH` и только тронутые строки: состава заявки эта ручка не касается.
   */
  setConsumablesIssued: (id: string, body: SetServiceConsumablesIssuedInput) =>
    patch<ServiceRequestDto>(id, '/consumables/issued', body),

  /** Закрытие работ: отметки факта по строкам. Итог не передаётся — его считает сервер (Р12). */
  complete: (id: string, body: CompleteServiceRequestInput) =>
    patch<ServiceRequestDto>(id, '/complete', body),
  accept: (id: string, body: CommentInput) => patch<ServiceRequestDto>(id, '/accept', body),
  rework: (id: string, body: ReasonInput) => patch<ServiceRequestDto>(id, '/rework', body),
  /**
   * Виза отдела ИТ (Р51): согласие либо отказ с причиной. Одна ручка на оба ответа — у решения
   * одно право и один момент, как у согласования сметы.
   */
  itApproval: (id: string, body: ApproveServiceItInput) =>
    patch<ServiceRequestDto>(id, '/it-approval', body),
  /** Только отмена и административные откаты (Р18) — остальное ходит своими ручками. */
  /** Отмена и откаты: ответ несёт исход письма — отменённую заявку служба тоже должна узнать. */
  changeStatus: (id: string, body: ServiceStatusChangeInput) =>
    patch<ServiceRequestWithMailDto>(id, '/status', body),
  /**
   * Срочность своей ручкой, а не полем правки (Р56): её ставят и снимают до самого закрытия, в том
   * числе когда саму заявку править уже нельзя.
   */
  setUrgency: (id: string, body: SetServiceUrgencyInput) =>
    patch<ServiceRequestDto>(id, '/urgency', body),

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
