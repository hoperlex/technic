import type {
  AssignmentCommandBody,
  AssignmentPreviewDto,
  AssignVehicleBody,
  ChangeVehicleAssignmentBody,
  ChangeVehicleRequestTypeBody,
  CompleteVehicleRequestInput,
  CompletionApplyBody,
  CompletionPreviewBody,
  CompletionPreviewDto,
  ConfirmScheduleBody,
  CreateRequestRelocationBody,
  CreateVehicleRequestInput,
  DecideVehicleEarlyEndBody,
  EarlyEndApprovalPreviewDto,
  IssueRequestEsm2Body,
  LinearDayRef,
  ListResult,
  PeriodApplyBody,
  PeriodCommand,
  PeriodPreviewDto,
  PlanVehicleRequestDayBody,
  RepairBody,
  RepairPreviewDto,
  RepairResultDto,
  RequestAssignmentHistoryDto,
  RequestHistoryEntryDto,
  RequestStatus,
  RequestVehicleEarlyEndInput,
  RequestVehicleEarlyEndPreviewInput,
  RequestWaybillDto,
  RouteTripFields,
  SaveVehicleRequestShiftBody,
  UpdateVehicleRequestInput,
  VehicleFeedListDto,
  VehicleOnSiteListDto,
  VehicleOnSiteSummaryDto,
  VehicleRequestDaysDto,
  VehicleRequestDriverDto,
  VehicleRequestDto,
  VehicleRequestHistorySummaryDto,
  VehicleRequestShiftsDto,
  VehicleRequestStatusPreviewDto,
  VehicleRequestSummaryDto,
  VehicleRouteDto,
  WaybillFormCode,
} from '@technic/contracts';
import { apiFetch, type Query } from '@shared/api';

/**
 * Ручки заказа техники: заявка на технику или грузоперевозку, назначение машины и машиниста, срок
 * работ, закрытие фактической датой, досрочное завершение, смены, дни линейного заказа, перегоны и
 * бумага, которой заказ сопровождается.
 *
 * Портальные ответы трёх дверей — срока, закрытия и машиниста — стоят здесь же, рядом с ручками,
 * которые их отдают: в контрактах их нет, а описанные порознь, ответ и его единственный
 * отправитель разошлись бы молча. Той же причиной здесь живёт `VehicleRequestStatusExtra`: тело у
 * смены статуса и её предпросмотра одно на двоих, и разъедься оно — диалог начал бы обещать не то.
 *
 * Бумага соседом не тянется: `waybills` и `issueEsm2` ходят по адресам листов, но отвечают
 * контрактным `RequestWaybillDto` и заявкой целиком, а `@entities/waybill` — сосед по слою,
 * которого границы слайсу запрещают.
 */
/**
 * Ответ двери срока: состояние заявки после команды, а не отчёт о ней (Р9).
 *
 * Описан здесь, а не в контрактах, по той же причине, что и прочие ответы ручек: пакет контрактов
 * держит тела запросов и общие DTO, а этот тип живёт ровно между сервером и порталом. Повтор по
 * тому же ключу операции отвечает то же самое — по нему и видно, что работы не было (`repeated`).
 */
export interface VehicleRequestPeriodResultDto {
  version: number;
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  dateFrom: string;
  dateTo: string | null;
  /** Что переписала сверка ЭСМ-2: сгоревшие и выписанные номера. */
  esm2: { cancelled: string[]; issued: string[] };
  /** Снят ли ожидавший визы запрос на досрочное завершение (ADR 0044). */
  earlyEndDropped: boolean;
  /** Ключ операции журнала; `null` — исход `none`, объяснять нечего (Р32). */
  operationId: string | null;
  history: RequestAssignmentHistoryDto;
}

/**
 * Ответ двери закрытия: состояние заявки после команды, а не отчёт о ней (Р9 плана периодов).
 *
 * Описан здесь по той же причине, что и ответ двери срока: пакет контрактов держит тела запросов и
 * общие DTO, а этот тип живёт ровно между сервером и порталом. Повтор по тому же ключу операции
 * отвечает то же самое — работы на нём не происходит вовсе, и видно это по `repeated`: срок, статус
 * и снимок закрытия читаются из базы и совпадают с первым ответом, а «что сгорело» и «что снято»
 * приходят пустыми.
 */
export interface VehicleRequestCompletionResultDto {
  version: number;
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  status: RequestStatus;
  /** Срок, каким он стал: у обычного закрытия конец равен фактической дате. */
  dateFrom: string;
  dateTo: string | null;
  /** Снимок закрытия: чем закрыли и что было. Оба пусты у арендодательской ветви (Р16). */
  endedOn: string | null;
  previousDateTo: string | null;
  /** Что переписала сверка: сгоревшие, выписанные и сокращённые номера. */
  esm2: { cancelled: string[]; issued: string[]; trimmed: string[] };
  /** Снят ли ожидавший визы запрос на досрочное завершение (ADR 0044). */
  earlyEndDropped: boolean;
  /** Дни, часы за которые закрытие удалило (Р10). */
  clearedShiftDays: string[];
  /** Дни линейного заказа, снятые с рейсов (Р11, Р27). */
  detachedDays: LinearDayRef[];
  /** Ключ операции журнала; `null` — исход `none`, объяснять нечего. */
  operationId: string | null;
}

/**
 * Ответ двери машиниста: состояние заявки после команды, а не отчёт о ней (Р9).
 *
 * Пересобирается из **текущего** состояния, поэтому повтор по тому же ключу операции отвечает то
 * же, что ответил бы обычный запрос, — по нему и видно, что работы не было (`repeated`).
 * Переписанная бумага стоит рядом с историей намеренно: окно, сделавшее смену, обязано узнать и
 * то, чем продолжать (версия), и то, что случилось с номерами бланков.
 */
export interface AssignmentCommandResultDto {
  version: number;
  /** true — операцию уже выполнял этот же ключ: работы не было, версия не тронута. */
  repeated: boolean;
  /** Что переписала сверка ЭСМ-2: сгоревшие и выписанные номера. */
  esm2: { cancelled: string[]; issued: string[] };
  history: RequestAssignmentHistoryDto;
}

/**
 * Что предъявляется вместе со статусом заявки. Тип один на смену статуса и её предпросмотр
 * намеренно: предпросмотр обязан считать последствия по тем же входам, по которым их потом
 * исполнит боевая ручка, — разойдись эти тела, диалог начал бы обещать не то.
 */
interface VehicleRequestStatusExtra {
  comment?: string;
  /** Техника и ставки при переводе в работу (ADR 0027). */
  assignment?: AssignVehicleBody;
  /** Фактический срок, о котором договорились при том же переводе. */
  schedule?: ConfirmScheduleBody;
  /** Отработанное время и стоимость при выполнении (ADR 0029). */
  completion?: CompleteVehicleRequestInput;
  /**
   * Отпечаток последствий, показанных предпросмотром. Обязателен на одном переходе — откате
   * «Выполнена» → «В работе» у заказа техники на объект, — и спрашивает его сервер: только он
   * знает, чем эта заявка пойдёт дальше.
   */
  previewFingerprint?: string;
}

export const vehicleRequestsApi = {
  list: (q: Query) => apiFetch<ListResult<VehicleRequestDto>>('/vehicle-requests', { query: q }),
  /**
   * Лента раздела: заказы ТС и недельные заявки одним списком (ADR 0085 переехал в общий список).
   *
   * Отдельный маршрут, а не флаг у `list`: тем списком пользуются архив и подбор заявок в рейс, и
   * подмешивать туда документы, которые в рейс не ставятся, нельзя. Строка ленты размечена видом,
   * поэтому таблица разбирает её ветками, а не гадает по пустым полям.
   */
  feed: (q: Query) => apiFetch<VehicleFeedListDto>('/vehicle-requests/feed', { query: q }),
  /** Контакт водителя защищён правом на путевые листы и поэтому не входит в основной DTO. */
  driver: (id: string) =>
    apiFetch<VehicleRequestDriverDto | null>(`/vehicle-requests/${id}/driver`),
  /**
   * Что портал знает о рейсе до перевода заявки в работу: ведётся ли он, на какую дату, какие
   * рейсы на неё уже заведены и чем были заполнены графы шапки в прошлый раз. Форма либо кладёт
   * заявку в готовый рейс, либо заводит новый.
   *
   * Без `vehicleId` подсказываются рейсы того же типа ТС, что заказан в заявке: день планируют с
   * вопроса «каким рейсом заявка поедет», а машину задаёт сам рейс. С машиной — её рейсы и графы
   * шапки от её прошлого рейса (наследовать их без машины неоткуда).
   *
   * `date` передаётся, когда подачу правят прямо в форме: рейс печатает задание на день, и
   * подсказка обязана относиться к тому дню, который уедет на сервер.
   */
  routePrefill: (id: string, params: { vehicleId?: string; date?: string } = {}) =>
    apiFetch<{
      required: boolean;
      /** Бланк, по которому пойдёт лист; `null` — рейс этой заявке не ведётся. */
      formCode: WaybillFormCode | null;
      formLabel: string | null;
      reason: string | null;
      tripDate: string;
      routes: VehicleRouteDto[];
      trip: RouteTripFields | null;
    }>(`/vehicle-requests/${id}/route-prefill`, { query: { ...params } }),
  /**
   * Листы, выписанные по заявке (ADR 0041) — их печатают из карточки, не уходя в журнал. Пусто
   * там, где листов нет: аренда, заявка не в работе, тип без бланка.
   *
   * Список, а не один: у грузоперевозки лист по-прежнему один — рейс один, — а у заказа техники
   * на объект их столько, сколько недель в сроке (ЭСМ-2, миграция 0087).
   */
  waybills: (id: string) => apiFetch<RequestWaybillDto[]>(`/vehicle-requests/${id}/waybills`),
  /**
   * Выписать недельный ЭСМ-2 по требованию (ADR 0100 решение 6) — у линейного заказа портал
   * листов сам не выписывает, и это единственная дверь, через которую бланк рождается.
   *
   * `weekOf` — любой день нужной недели: границы листа считает сервер, пересекая календарную
   * неделю со сроком заявки, — тем же правилом, каким режет срок автоматическая выписка. Машина и
   * машинист приходят выбранными: за неделю на объекте могли отработать две единицы, а водитель у
   * каждого дня свой. В ответе — заявка целиком: у неё меняется версия, и список листов вместе с
   * ней.
   */
  issueEsm2: (id: string, body: IssueRequestEsm2Body) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/esm2`, { method: 'POST', body }),
  /**
   * Перегоны заявки: доставка техники на объект и вывоз с него. Пусто — их не заводили: технику
   * могли привезти тралом, и тогда листа на перегон не бывает вовсе.
   */
  relocations: (id: string) => apiFetch<VehicleRouteDto[]>(`/vehicle-requests/${id}/relocations`),
  createRelocation: (id: string, body: CreateRequestRelocationBody) =>
    apiFetch<VehicleRouteDto>(`/vehicle-requests/${id}/relocations`, { method: 'POST', body }),
  /** Счётчики заявок по статусам — сводка над списком; сужается объектом и типом заявки. */
  summary: (q: Query) =>
    apiFetch<VehicleRequestSummaryDto>('/vehicle-requests/summary', { query: q }),
  /**
   * Журнал закрытых заявок — вкладка «История» (ADR 0029): «Выполнена» и «Отменена» с фактом
   * выполнения. Отдельный маршрут: свой фильтр по арендодателю и свой порядок (по сроку работ).
   */
  historyList: (q: Query) =>
    apiFetch<ListResult<VehicleRequestDto>>('/vehicle-requests/history', { query: q }),
  /** Итог журнала по тем же фильтрам: сколько закрыто, чем закончилось и на какую сумму. */
  historySummary: (q: Query) =>
    apiFetch<VehicleRequestHistorySummaryDto>('/vehicle-requests/history/summary', { query: q }),
  /**
   * Техника на объектах прямо сейчас — вкладка «На объекте» (ADR 0036). День среза считает сервер
   * и возвращает в `onDate`: от него, а не от часов браузера, считаются подписи присутствия.
   */
  onSite: (q: Query) => apiFetch<VehicleOnSiteListDto>('/vehicle-requests/on-site', { query: q }),
  /** Итог среза по тем же фильтрам: сколько машин, на скольких объектах, кто вышел и кто уезжает. */
  onSiteSummary: (q: Query) =>
    apiFetch<VehicleOnSiteSummaryDto>('/vehicle-requests/on-site/summary', { query: q }),
  get: (id: string) => apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}`),
  /** События заявки в хронологическом порядке: создание, правки, смены статусов (ADR 0015). */
  history: (id: string) => apiFetch<RequestHistoryEntryDto[]>(`/vehicle-requests/${id}/history`),
  create: (body: CreateVehicleRequestInput) =>
    apiFetch<VehicleRequestDto>('/vehicle-requests', { method: 'POST', body }),
  update: (id: string, body: UpdateVehicleRequestInput) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}`, { method: 'PATCH', body }),
  /**
   * Переоформить заявку в другой тип (ADR 0091): заказ завели работой на объекте, а нужен рейс —
   * или наоборот. Номер, вложения и история остаются за заявкой; тело — полный состав нового типа,
   * потому что деталь прежнего снимается целиком, а взять её значения новому типу неоткуда.
   */
  changeRequestType: (id: string, body: ChangeVehicleRequestTypeBody) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/request-type`, { method: 'PATCH', body }),
  /**
   * `comment` уходит в историю статусов; при отмене это обязательная причина. Остальное
   * предъявляется вместе со статусом и потому собрано в объект: `assignment` — техника и ставки
   * при переводе в работу (ADR 0027), `schedule` — фактический срок, о котором договорились при
   * том же переводе, `completion` — отработанное время и стоимость при выполнении (ADR 0029).
   * Всё это проводится тем же запросом, что и смена статуса: заявка не бывает «в работе» ни на
   * чём, взятой на одно время с листом на другое и «выполненной» без факта.
   *
   * ЗАКРЫТИЕ ЗАКАЗА ТЕХНИКИ НА ОБЪЕКТ ЭТОЙ РУЧКОЙ БОЛЬШЕ НЕ ПРОХОДИТ (Р1 плана
   * `docs/vehicle-request-actual-end-date-plan.md`, ADR 0178): «Выполнена» у него отвечает 422 и
   * называет правильный вход — окно закрытия, у которого своя дверь (`completion` ниже).
   * Грузоперевозка закрывается здесь по-прежнему: срока работ и недельной бумаги у неё нет, и
   * фактическая дата окончания ей ничего не значит.
   */
  changeStatus: (
    id: string,
    status: RequestStatus,
    version: number,
    extra: VehicleRequestStatusExtra = {},
  ) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/status`, {
      method: 'PATCH',
      body: {
        status,
        comment: extra.comment ?? '',
        version,
        ...(extra.assignment ? { assignment: extra.assignment } : {}),
        ...(extra.schedule ? { schedule: extra.schedule } : {}),
        ...(extra.completion ? { completion: extra.completion } : {}),
        ...(extra.previewFingerprint ? { previewFingerprint: extra.previewFingerprint } : {}),
      },
    }),
  /**
   * Последствия перехода до его совершения: каким режимом заявка пойдёт дальше, что сделает сверка
   * ЭСМ-2 и как будет считаться занятость машины. Ничего не пишет.
   *
   * Тело — то же самое, что у смены статуса: план считается по машине, машинисту и сроку, которые
   * приходят из окна назначения, и своя схема разошлась бы с боевой на первом же новом поле.
   * Заведён под откат «Выполнена» → «В работе» — на прочих переходах сервер отвечает 422.
   */
  statusPreview: (
    id: string,
    body: VehicleRequestStatusExtra & { status: RequestStatus; version: number },
  ) =>
    apiFetch<VehicleRequestStatusPreviewDto>(`/vehicle-requests/${id}/status/preview`, {
      method: 'POST',
      body: { ...body, comment: body.comment ?? '' },
    }),
  /**
   * Последствия закрытия заказа техники фактической датой до его совершения (ADR 0178, Р1, Р22):
   * какие листы сгорят и выпишутся, какие решения о технике погаснут, какие часы смен исчезнут и
   * какие дни уйдут из рейсов. Ничего не пишет.
   *
   * Тело — семантическая половина боевого (Л1 плана периодов): факт целиком, включая фактическую
   * дату, — без неё сокращать нечего, и предпросмотр показал бы план несуществующей команды.
   * Отпечатков он не принимает вовсе: он их и вычисляет, а присланный отпечаток означает ошибку
   * клиента и кончается 400.
   *
   * Арендодатель сюда не ходит (Р16): его ветвь ни срока, ни бумаги не трогает, план у неё пуст по
   * построению, и подтверждать ему нечего.
   */
  completionPreview: (id: string, body: CompletionPreviewBody) =>
    apiFetch<CompletionPreviewDto>(`/vehicle-requests/${id}/completion/preview`, {
      method: 'POST',
      body,
    }),
  /**
   * Закрыть заказ техники на объект фактической датой — своя дверь, а не «Выполнена» у статусной
   * ручки (Р1, ADR 0178). Статусная ручка это закрытие с того же выпуска отвергает.
   *
   * Почему дверь: закрытие фактом сокращает срок, переписывает бумагу, гасит решения истории и
   * стирает часы смен за фактической датой — то есть команда с предпросмотром, отпечатками,
   * условной авторизацией и, у закрытия задним числом, записью в журнал коррекций. Всё это уже
   * написано каноном команд истории, и вторая его копия в статусной ручке разошлась бы с первой.
   *
   * Что уезжает подтверждениями (Р28): `previewFingerprint` — последствия, которые человек видел;
   * `cancelGroupsFingerprint` — перечень гасимых решений о технике; `clearedShiftsFingerprint` —
   * снимаемые часы; `unlockFingerprint` — отработанные листы, которые переоформит операция;
   * `operation` — причина и ключ идемпотентности там, где нужна запись журнала. Присутствие
   * каждого задаёт **ответ сервера**, а не желание клиента: лишнее подтверждение отвергается так
   * же строго, как недостающее.
   */
  complete: (id: string, body: CompletionApplyBody) =>
    apiFetch<VehicleRequestCompletionResultDto>(`/vehicle-requests/${id}/completion`, {
      method: 'POST',
      body,
    }),
  /**
   * Сменить машину и ставки у заявки, которая уже в работе (ADR 0048): техника сломалась, ушла на
   * другой объект или её перепутали при переводе в работу. Статус при этом не меняется — тем и
   * отличается от повторного перевода в работу, которым назначение переписывали до сих пор.
   * Заявка переезжает в рейс новой машины той же транзакцией.
   */
  changeAssignment: (id: string, body: ChangeVehicleAssignmentBody) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/assignment`, { method: 'PATCH', body }),
  /**
   * Последствия смены техники до её совершения (волна 4a плана `docs/assignment-periods-plan.md`,
   * §7): какие номера ЭСМ-2 сгорят и какие выпишутся, какие подписи объекта слетят, каких дней не
   * хватает машинисту. Ничего не пишет.
   *
   * Тело — то же самое, что у боевой ручки, и это существенно: план считается по машине, машинисту
   * и коррекционному блоку из окна, а своя схема разошлась бы с боевой на первом же новом поле — и
   * вместе с ней разошёлся бы отпечаток, которым сервер сверяет обещанное.
   *
   * Отпечаток сюда не передаётся никогда: предпросмотр его выдаёт, а не спрашивает.
   */
  assignmentPreview: (id: string, body: ChangeVehicleAssignmentBody) =>
    apiFetch<AssignmentPreviewDto>(`/vehicle-requests/${id}/assignment/preview`, {
      method: 'POST',
      body,
    }),
  /**
   * Последствия правки срока до её совершения (волна 4a плана `docs/assignment-periods-plan.md`,
   * Ж4, З5, Л1): какие бланки ЭСМ-2 сгорят и какие выпишутся, какие решения о технике погасит
   * сокращение (Д2), какие отработанные листы придётся переоформить и нужна ли причина. Ничего
   * не пишет.
   *
   * Тело у предпросмотра — семантическая половина боевого (Л1): отпечатка, исхода и ключей листов
   * он ещё не знает — он их и вычисляет. Отпечаток сюда не передаётся никогда.
   */
  periodPreview: (id: string, body: PeriodCommand) =>
    apiFetch<PeriodPreviewDto>(`/vehicle-requests/${id}/period/preview`, { method: 'POST', body }),
  /**
   * Правка срока работ — своя дверь, а не поля широкого `PATCH /:id` (Ж4, З5).
   *
   * Узкое тело «продлить до 31 августа» в широкий маршрут не легло бы: там строгий union с
   * обязательными типом заявки, техникой, заказчиком, контактами и файлами. Но главное не форма
   * тела, а рукопожатия: сокращение способно **погасить решения о технике** за новым концом срока
   * (Д2), и портал обязан показать перечень и вернуть подтверждение — иначе сервер отвечает 422.
   *
   * Что уезжает подтверждениями: `previewFingerprint` — последствия, которые человек видел;
   * `cancelGroupsFingerprint` — перечень гасимых решений; `unlockFingerprint` — отработанные
   * листы, которые переоформит операция (присутствие поля задаёт исход, а не желание клиента);
   * `operation` — причина и ключ идемпотентности там, где нужна запись в журнале коррекций.
   *
   * Широкий маршрут при этом продолжает принимать даты (И5): выкат не одномоментный, и старый
   * путь остаётся рабочим до cutover.
   */
  changePeriod: (id: string, body: PeriodApplyBody) =>
    apiFetch<VehicleRequestPeriodResultDto>(`/vehicle-requests/${id}/period`, {
      method: 'PATCH',
      body,
    }),
  /**
   * История назначения заявки — то, из чего портал строит «Состав по датам» (этап 6 плана
   * `docs/assignment-periods-plan.md`, §9): с какого числа какая машина и какой машинист.
   *
   * Погашенные строки приходят наравне с актуальными: журнал заявки читают, чтобы понять, **что**
   * правили, а не только чем дело кончилось. Состояние готовности отдаётся той же ручкой (Р26) —
   * окно обязано отличить «истории нет» от «история есть, но неполна», и второй запрос за этим
   * означал бы, что между ними состояние успевает измениться.
   */
  assignmentHistory: (id: string) =>
    apiFetch<RequestAssignmentHistoryDto>(`/vehicle-requests/${id}/assignment-changes`),
  /**
   * Последствия команды машиниста до её совершения (§8). Ничего не пишет.
   *
   * Двухфазный (Р16): первый вызов идёт без якорей и возвращает `requiredAnchors` — границы, на
   * которых свёртка осталась бы без человека; второй, с названными именами, отдаёт окончательный
   * план и отпечаток, который и принимает боевая ручка. Одной фазы не хватает: пока люди не
   * названы, набор последствий ещё неизвестен, и подтверждать нечего.
   *
   * Тело — то же самое, что у боевой ручки (§8): расчёт обязан идти по тем входам, по которым его
   * потом исполнит команда, иначе окно начнёт обещать не то. Отпечаток сюда не передаётся никогда:
   * предпросмотр его выдаёт, а не спрашивает.
   */
  assignmentChangePreview: (id: string, body: AssignmentCommandBody) =>
    apiFetch<AssignmentPreviewDto>(`/vehicle-requests/${id}/assignment-changes/preview`, {
      method: 'POST',
      body,
    }),
  /**
   * Команда машиниста: `set` — назначить человека с даты, `cancel` — снять запланированное
   * решение (Р13).
   *
   * Ответ — состояние заявки после команды, а не отчёт о ней (Р9): версия, переписанные номера
   * ЭСМ-2 и вся история заново. Повтор по тому же ключу операции отвечает то же самое — по нему и
   * видно, что работы не было (`repeated`).
   */
  changeAssignmentMachinist: (id: string, body: AssignmentCommandBody) =>
    apiFetch<AssignmentCommandResultDto>(`/vehicle-requests/${id}/assignment-changes`, {
      method: 'POST',
      body,
    }),
  /**
   * Осмотр истории: что в ней чинить (подэтап 6a плана `docs/assignment-periods-plan.md`, Р29).
   *
   * Первый запрос окна «Починка истории». Своя ручка, а не предпросмотр с пустым телом: тело
   * предпросмотра нарочно одно с боевым, а спросить «что чинить» окно обязано **до** того, как
   * назовёт работу. Главное в ответе — `fillableGaps`: какие `unknown`-промежутки заблокированы и
   * потому адресуются заполнением, а какие правятся якорями, знает только сервер — это зависит от
   * отменяемости бумаги. Ничего не пишет.
   */
  repairState: (id: string) =>
    apiFetch<RepairPreviewDto>(`/vehicle-requests/${id}/assignment-changes/repair/state`),
  /**
   * Последствия ремонта до его совершения (Р29): какие бланки сгорят, какие выпишутся задним
   * числом, какие отработанные листы придётся переоформить и станет ли история полной.
   *
   * Тело — то же самое, что у боевой ручки (§8). Отпечаток сюда не передаётся никогда:
   * предпросмотр его выдаёт, а не спрашивает.
   */
  repairPreview: (id: string, body: RepairBody) =>
    apiFetch<RepairPreviewDto>(`/vehicle-requests/${id}/assignment-changes/repair/preview`, {
      method: 'POST',
      body,
    }),
  /**
   * Ремонт истории: якоря на пробелах машиниста, заполнение `unknown` известным человеком,
   * решение о машине после конца срока и отмена заполнения (Р29, Р31).
   *
   * Заполнение выписывает недостающие бланки **задним числом** — расход строгой отчётности
   * реальный, и окно обязано показать номера до нажатия.
   */
  repairAssignmentHistory: (id: string, body: RepairBody) =>
    apiFetch<RepairResultDto>(`/vehicle-requests/${id}/assignment-changes/repair`, {
      method: 'POST',
      body,
    }),
  /** Виза руководителя строительства: `approved: false` — отзыв (ADR 0025). */
  setApproval: (id: string, approved: boolean, version: number) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/approval`, {
      method: 'PATCH',
      body: { approved, version },
    }),
  /**
   * Последствия досрочного завершения глазами того, кто просит **сам за себя** (Р19, Р26): его
   * запрос сервер применяет немедленно, значит и последствия у него есть сегодня.
   *
   * Ответ **обезличен**: числа и даты, без номеров бланков и фамилий. Причина не в скупости, а в
   * правах — визирующий сокращение (руководитель строительства) прав на журнал листов не имеет
   * вовсе, и спроси дверь это право, обе применяющие ветви стали бы недоступны тем, ради кого они
   * существуют (решение заказчика по В9).
   *
   * Тому, чей запрос уйдёт на визу, сервер отвечает 422: он ничего не применяет, а обещание «что
   * будет, когда завизируют» к моменту визы устареет — его и покажет предпросмотр решения.
   */
  earlyEndPreview: (id: string, body: RequestVehicleEarlyEndPreviewInput) =>
    apiFetch<EarlyEndApprovalPreviewDto>(`/vehicle-requests/${id}/early-end/preview`, {
      method: 'POST',
      body,
    }),
  /**
   * Последствия визы — то же обезличенное тело, но по **чужому** запросу и глазами визирующего.
   *
   * Предпросмотр заявителя сюда не годится и физически не подойдёт: между обращением и решением
   * проходит время, состояние меняется, решает другой человек, а имя двери входит в отпечаток
   * (Р19). Виза получает свою пару «предпросмотр → решение», и отпечаток берётся из неё.
   */
  earlyEndDecisionPreview: (id: string, version: number) =>
    apiFetch<EarlyEndApprovalPreviewDto>(`/vehicle-requests/${id}/early-end/decision/preview`, {
      method: 'POST',
      body: { approved: true, version },
    }),
  /**
   * Досрочное завершение заказа спецтехники (ADR 0044): техника освободилась раньше срока.
   * Запрос уходит на визу руководителя строительства; его собственный сервер применяет сразу.
   *
   * Отпечатки и ключ операции необязательны и уезжают только у применяющей ветви — той, где просит
   * сам визирующий (Р19, Р28): у ждущей визы подтверждать нечего, и присланное подтверждение она
   * отвергает 422. Какая ветвь пойдёт, решает сервер по субъекту, а не портал по телу; окно шлёт
   * подтверждения ровно тогда, когда ему ответил предпросмотр.
   */
  requestEarlyEnd: (id: string, body: RequestVehicleEarlyEndInput) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/early-end`, { method: 'POST', body }),
  /**
   * Решение по запросу: `approved: false` — отказ, и тогда причина обязательна.
   *
   * У визы тело растёт теми же тремя подтверждениями, что у применяющего запроса: она двигает срок
   * и переписывает бумагу спустя часы или дни после обращения. У отказа их нет и быть не может —
   * он не применяет ничего, и схема отвергает их 400.
   */
  decideEarlyEnd: (id: string, body: DecideVehicleEarlyEndBody) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/early-end`, { method: 'PATCH', body }),
  /** Отозвать запрос, пока он ждёт визы: «отбой, техника нужна». */
  cancelEarlyEnd: (id: string) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/early-end`, { method: 'DELETE' }),
  /**
   * Смены заказа спецтехники: дни заказа целиком, включая незаполненные. День среза (`onDate`)
   * считает сервер — по нему таблица решает, какая строка ещё в будущем и потому неактивна.
   */
  shifts: (id: string) => apiFetch<VehicleRequestShiftsDto>(`/vehicle-requests/${id}/shifts`),
  /** Записать смену дня: время, машиночасы, заправку и комментарий. */
  saveShift: (id: string, date: string, body: SaveVehicleRequestShiftBody) =>
    apiFetch<VehicleRequestShiftsDto>(`/vehicle-requests/${id}/shifts/${date}`, {
      method: 'PUT',
      body,
    }),
  /** Убрать ошибочно заведённый день — пока он не подтверждён. */
  deleteShift: (id: string, date: string) =>
    apiFetch<VehicleRequestShiftsDto>(`/vehicle-requests/${id}/shifts/${date}`, {
      method: 'DELETE',
    }),
  /** Подпись объекта под днём работы и её снятие — одним маршрутом, как виза заявки. */
  approveShift: (id: string, date: string, approved: boolean) =>
    apiFetch<VehicleRequestShiftsDto>(`/vehicle-requests/${id}/shifts/${date}/approval`, {
      method: 'POST',
      body: { approved },
    }),
  /**
   * Дни линейного заказа (ADR 0100): дни срока целиком — с рейсом дня, его машиной, водителем,
   * листом и часами смены. День среза (`onDate`) считает сервер, как и у смен.
   *
   * `blocker` приходит вместе с таблицей, а не вместо неё: у арендного заказа дней не бывает
   * вовсе, и блок обязан объяснить это словами — теми же, которыми откажет ручка планирования.
   */
  days: (id: string) => apiFetch<VehicleRequestDaysDto>(`/vehicle-requests/${id}/days`),
  /**
   * Поставить день заказа в рейс: в уже заведённый рейс машины на этот день (`routeId`) либо в
   * новый, заводимый тут же (`newRoute`). Ровно одно из двух — «и то, и другое» означало бы два
   * разных ответа на вопрос, куда едет день.
   *
   * День — часть адреса, а не тела: второй ответ на «за какой это день» разошёлся бы с первым,
   * тем же порядком устроены смены. В ответе — таблица дней целиком: изменился не только этот
   * день, но и перечень свободных рейсов у соседних.
   */
  planDay: (id: string, date: string, body: PlanVehicleRequestDayBody) =>
    apiFetch<VehicleRequestDaysDto>(`/vehicle-requests/${id}/days/${date}/route`, {
      method: 'POST',
      body,
    }),
  /**
   * Снять день с рейса. Сам рейс остаётся: он мог собираться из нескольких заявок, и пустой
   * маршрут диспетчер убирает своим действием.
   */
  unplanDay: (id: string, date: string) =>
    apiFetch<VehicleRequestDaysDto>(`/vehicle-requests/${id}/days/${date}/route`, {
      method: 'DELETE',
    }),
  remove: (id: string) =>
    apiFetch<{ ok: boolean; mode: string }>(`/vehicle-requests/${id}`, { method: 'DELETE' }),
  restore: (id: string) =>
    apiFetch<VehicleRequestDto>(`/vehicle-requests/${id}/restore`, { method: 'POST' }),
  /** Удаление насовсем (ADR 0070) — только из архива и только администратором. */
  purge: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vehicle-requests/${id}/purge`, { method: 'DELETE' }),
};
