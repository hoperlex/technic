import type {
  AcceptWasteTicketCheckInput,
  AcceptWasteTicketProposalInput,
  ArbitrateWasteTicketBlindCheckInput,
  ConfirmWasteTicketInput,
  CreateWasteTicketInput,
  DismissWasteTicketInput,
  TicketAuditAccuracyDto,
  TicketAuditCohortsDto,
  TicketAuditEventsDto,
  TicketAuditOperationsDto,
  TicketAuditEventsQuery,
  TicketAuditPeriod,
  TicketAuditSummaryDto,
  UpdateWasteTicketInput,
  WasteRequestTicketsDto,
  WasteTicketBlindCheckInput,
  WasteTicketBlindCheckTaskDto,
} from '@technic/contracts';
import type { TicketRecognitionState } from '@technic/contracts';
import { apiDownload, apiFetch } from '@shared/api';

/**
 * Разбор талонов вывоза (ADR 0114). Все ручки вложены в заявку — и это не про красоту URL:
 * право `wasteRequests.ticketReview` говорит, что человек разбирает талоны, но не говорит, **чьи**,
 * поэтому область проверяется по заявке на каждом запросе.
 *
 * Состояние подсистемы (`health`) стоит рядом с ними, а не в «системном» слое: спрашивают его те же
 * экраны и по тому же праву, а молчащее распознавание неотличимо от «талоны в порядке» — ради этого
 * ручка и заведена.
 */
export interface TicketRecognitionHealth {
  /**
   * `disabled` — модуль выключен, талоны разбирает человек; `ok` — работает; `degraded` —
   * временно недоступно; `unconfigured` — нужен администратор.
   */
  state: TicketRecognitionState;
  since: string | null;
  code: string;
  attempts: number;
  failed: number;
  waiting: number;
}

export const wasteTicketsApi = {
  list: (requestId: string) =>
    apiFetch<WasteRequestTicketsDto>(`/waste-requests/${requestId}/tickets`),

  create: (requestId: string, body: CreateWasteTicketInput) =>
    apiFetch<{ id: string; duplicateOverrideApplied: boolean }>(
      `/waste-requests/${requestId}/tickets`,
      { method: 'POST', body },
    ),

  confirm: (requestId: string, ticketId: string, body: ConfirmWasteTicketInput) =>
    apiFetch<{ ok: boolean; duplicateOverrideApplied: boolean }>(
      `/waste-requests/${requestId}/tickets/${ticketId}/confirm`,
      { method: 'POST', body },
    ),

  update: (requestId: string, ticketId: string, body: UpdateWasteTicketInput) =>
    apiFetch<{ ok: boolean }>(`/waste-requests/${requestId}/tickets/${ticketId}`, {
      method: 'PATCH',
      body,
    }),

  dismiss: (requestId: string, ticketId: string, body: DismissWasteTicketInput) =>
    apiFetch<{ ok: boolean }>(`/waste-requests/${requestId}/tickets/${ticketId}/dismiss`, {
      method: 'POST',
      body,
    }),

  /**
   * Принять расхождение. `subjectKey` уходит в строке запроса, потому что у построчных проверок
   * он идентификатор талона, а у заявочных пуст — и первичный ключ принятия составлен из той же
   * пары, иначе два расхождения по адресу у разных талонов делили бы одно принятие.
   */
  acceptCheck: (
    requestId: string,
    checkCode: string,
    subjectKey: string,
    body: AcceptWasteTicketCheckInput,
  ) =>
    apiFetch<{ ok: boolean }>(`/waste-requests/${requestId}/checks/${checkCode}/accept`, {
      method: 'POST',
      query: subjectKey ? { subjectKey } : undefined,
      body,
    }),

  /** Перераспознать файл: попытка пойдёт мимо кэша и со своим ключом идемпотентности (Р13). */
  recognize: (requestId: string, fileId: string) =>
    apiFetch<{ ok: boolean }>(`/waste-requests/${requestId}/ticket-files/${fileId}/recognize`, {
      method: 'POST',
    }),

  blindCheck: (requestId: string, ticketId: string, body: WasteTicketBlindCheckInput) =>
    apiFetch<{ id: string; status: string }>(
      `/waste-requests/${requestId}/tickets/${ticketId}/blind-check`,
      { method: 'POST', body },
    ),

  arbitrate: (requestId: string, blindCheckId: string, body: ArbitrateWasteTicketBlindCheckInput) =>
    apiFetch<{ ok: boolean }>(
      `/waste-requests/${requestId}/blind-checks/${blindCheckId}/arbitrate`,
      { method: 'POST', body },
    ),

  /**
   * Принять предложение перераспознавания (Р13). Значений в теле нет: они лежат снимком в самом
   * предложении, и присылай их клиент — принять можно было бы что угодно под видом «так прочитала
   * машина».
   */
  acceptProposal: (requestId: string, ticketId: string, body: AcceptWasteTicketProposalInput) =>
    apiFetch<{ ok: boolean; duplicateOverrideApplied: boolean }>(
      `/waste-requests/${requestId}/tickets/${ticketId}/proposal/accept`,
      { method: 'POST', body },
    ),

  dismissProposal: (requestId: string, ticketId: string) =>
    apiFetch<{ ok: boolean }>(`/waste-requests/${requestId}/tickets/${ticketId}/proposal/dismiss`, {
      method: 'POST',
      body: {},
    }),

  /**
   * Очередь заданий слепой перепроверки (Р31). Ответ не несёт ни одного прочитанного значения —
   * ни машинного, ни подтверждённого: слепота держится тем, что цифр нет в ответе, а не тем, что
   * их не нарисовали.
   */
  blindCheckQueue: (limit = 20) =>
    apiFetch<{ items: WasteTicketBlindCheckTaskDto[] }>(
      `/waste-requests/ticket-blind-checks?limit=${limit}`,
    ),

  health: () => apiFetch<TicketRecognitionHealth>('/waste-requests/ticket-recognition/health'),

  /**
   * Сводка аудита распознавания (ADR 0137, §5.1 плана). Ручка только читает: инструмент
   * наблюдения, умеющий вмешиваться, однажды вмешается вместо наблюдения (§6 плана).
   *
   * Период уходит датами `YYYY-MM-DD`, а не моментами: считается он по московским суткам и по
   * времени НАБЛЮДЕНИЯ (§1.3), и переведи его клиент в моменты своего пояса — граница периода
   * поехала бы вслед за часовым поясом вкладки, а числа за один и тот же день разошлись бы у
   * двух смотрящих.
   */
  auditSummary: (period: TicketAuditPeriod) =>
    apiFetch<TicketAuditSummaryDto>('/waste-requests/ticket-audit/summary', {
      query: { from: period.from, to: period.to },
    }),

  /**
   * Сигналы по производственным когортам за тот же период (§5.2 плана). Отдельная ручка, а не
   * ветка сводки: экраны открывают по очереди, и сводка, тянущая за собой разбор по конфигурациям,
   * платила бы за него на каждом открытии окна.
   *
   * Период уходит теми же датами и по той же причине, что у сводки: считается он по московским
   * суткам, и перевод в моменты пояса вкладки развёл бы числа у двух смотрящих на один день.
   */
  auditCohorts: (period: TicketAuditPeriod) =>
    apiFetch<TicketAuditCohortsDto>('/waste-requests/ticket-audit/cohorts', {
      query: { from: period.from, to: period.to },
    }),

  /**
   * Лента событий за период с фильтрами и постранично (§5.3 плана).
   *
   * Отбор уходит на сервер целиком одним объектом — тем же, что лежит в адресе окна: пустые ключи
   * транспорт не ставит вовсе (`buildUrl`), и «фильтр не выбран» превращается в отсутствие
   * параметра, а не в пустую строку. Сузить выборку на клиенте нечем и незачем: общее число лента
   * считает по ВСЕЙ выборке, и отбор, применённый после ответа, показывал бы страницы, которых нет.
   *
   * ПЕРИОД ЗДЕСЬ ЗНАЧИТ ДРУГОЕ, чем у сводки и когорт: границы те же и в тех же московских сутках,
   * но лента отбирает по времени СОБЫТИЯ, а не наблюдения (§1.3). Правка, сделанная сегодня по
   * августовскому чтению, стоит в ленте сегодняшним днём и в августовской доле исправлений
   * одновременно. Отсюда и подпись «события за» на экране — единственная такая в разделе.
   */
  auditEvents: (query: TicketAuditEventsQuery) =>
    apiFetch<TicketAuditEventsDto>('/waste-requests/ticket-audit/events', { query }),

  /**
   * Точность среди неисправленных подтверждённых талонов (§5.5 плана): слепая перепроверка, три
   * поля и три исхода арбитража.
   *
   * Путь ручки — `blind`, а экран называется «Точность», и расхождение намеренное: ручка отвечает
   * за выборку (слепая перепроверка), экран — за то, что из неё следует. Переименуй мы путь в
   * `accuracy`, он обещал бы точность потока, которой эта выборка не измеряет вовсе (§3).
   *
   * Период уходит теми же датами, что у сводки, хотя считается по другому времени — по времени
   * ВЫДАЧИ перепроверки. Границы при этом обязаны совпадать: человек, переключивший экран, ждёт
   * того же отрезка, и «те же 30 суток» у двух экранов не должны означать разные отрезки.
   */
  auditAccuracy: (period: TicketAuditPeriod) =>
    apiFetch<TicketAuditAccuracyDto>('/waste-requests/ticket-audit/blind', {
      query: { from: period.from, to: period.to },
    }),

  /**
   * Состояние подсистемы (§5.4 плана): работает ли, что за неделю стоило вызовов и что копится в
   * очереди.
   *
   * БЕЗ ПАРАМЕТРОВ ВОВСЕ, и это не упущение подписи: схема ручки строгая, и любой присланный ключ —
   * хоть `from`, хоть `to` — кончается 400 с объяснением. Периода здесь нет ни в вопросе, ни в
   * ответе: очередь — снимок «сейчас», а вызовы считаются фиксированным окном по времени вызова
   * (§1.3). Пришли клиент период — он попросил бы посчитать отрезком то, что отрезком не считается.
   */
  auditOperations: () =>
    apiFetch<TicketAuditOperationsDto>('/waste-requests/ticket-audit/operations'),

  /**
   * Та же выборка файлом (§4.3 плана).
   *
   * Страница отбрасывается намеренно: «первая страница выгрузки» была бы файлом, который выглядит
   * отчётом, а содержит полсотни строк. Предел строк ставит сервер и отказывает 400-м, если по
   * отбору их больше, — экран показывает этот отказ словами, а не молча отдаёт обрезанный файл.
   *
   * Скачивается через `apiDownload`, а не ссылкой в разметке: переход по `href` браузер делает без
   * заголовка `Authorization` (токен живёт в памяти вкладки), и вместо файла человек получил бы
   * 401 в новой вкладке. Имя файла присылает сервер; здесь стоит только запасное.
   */
  auditEventsCsv: ({ page: _page, pageSize: _pageSize, ...filters }: TicketAuditEventsQuery) => {
    // Страница названа и выброшена здесь, а не оставлена вызывающему: экран зовёт выгрузку тем же
    // объектом, которым спрашивает ленту, и решение «в файл идёт весь отбор» принадлежит выгрузке,
    // а не тому, кто её позвал.
    const period = filters.from && filters.to ? ` ${filters.from} — ${filters.to}` : '';
    return apiDownload(
      '/waste-requests/ticket-audit/events.csv',
      `Аудит распознавания талонов${period}.csv`,
      { query: filters },
    );
  },
};
