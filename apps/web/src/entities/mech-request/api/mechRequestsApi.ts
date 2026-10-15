import type {
  ChangeMechRequestStatusInput,
  CreateMechRequestInput,
  DecideMechExtensionInput,
  IssueMechRequestInput,
  MechRequestDto,
  MechRequestHistorySummaryDto,
  MechRequestSummaryDto,
  RequestHistoryEntryDto,
  RequestMechExtensionInput,
  RevokeMechIssueInput,
  SetMechRequestApprovalInput,
  UpdateMechDealInput,
  UpdateMechRequestInput,
} from '@technic/contracts';
import {
  apiDownload,
  apiFetch,
  createGetApi,
  createListApi,
  createWriteApi,
  type ListResult,
  type Query,
} from '@shared/api';
import type { RequestCreateReconciliation } from '@shared/lib';

const PATH = '/mech-requests';

/**
 * A rental request for small mechanization (plan `docs/mechanization-module-plan.md`).
 *
 * The list, the card and the write are built by factories — they are the same for every resource.
 * Everything else is the module's own: every action on an existing row MUST carry the version
 * (R21). The version answers the question the `FOR UPDATE` lock does not answer at all — "the card
 * was opened an hour ago, has someone changed it since" — and the server tells 409 ("reread") from
 * 422 ("the rule forbids") exactly by it. The doors without a body (`DELETE`) send it in the query.
 */
export const mechRequestsApi = {
  ...createListApi<MechRequestDto>(PATH),
  ...createGetApi<MechRequestDto>(PATH),
  ...createWriteApi<MechRequestDto, CreateMechRequestInput, UpdateMechRequestInput>(PATH),
  create: (body: CreateMechRequestInput, idempotencyKey?: string) =>
    apiFetch<MechRequestDto>(idempotencyKey ? `${PATH}/_create-with-receipt` : PATH, {
      method: 'POST',
      body,
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    }),
  reconcileCreate: (body: CreateMechRequestInput, idempotencyKey: string) =>
    apiFetch<RequestCreateReconciliation>(`${PATH}/_create-attempts/reconcile`, {
      method: 'POST',
      body: { originalBody: body },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  /**
   * Удаление: «Новая» стирается физически вместе с вложениями, прочие уходят в архив (ADR 0070).
   * Что именно случилось, говорит `mode` ответа — портал не решает это сам: барьер состояния
   * (`mechDeleteScope`) считает то же самое до нажатия, но окончательный ответ у сервера, и
   * подпись тоста берётся из него.
   */
  remove: (id: string, version: number) =>
    apiFetch<{ ok: boolean; mode: 'hard' | 'archive' }>(`${PATH}/${id}`, {
      method: 'DELETE',
      // Версия параметром адреса, а не телом: тело у `DELETE` половина посредников выбрасывает, и
      // так же её шлёт единственный сосед с версионным удалением — акт обслуживания
      // (`vehicleMaintenanceApi.remove`). Фильтром выборки это не читается: у ручки нет выборки.
      query: { version },
    }),

  /** Возврат из архива (ADR 0070) и удаление насовсем (ADR 0060) — слова портала, не HTTP. */
  restore: (id: string, version: number) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/restore`, { method: 'POST', body: { version } }),
  purge: (id: string, version: number) =>
    apiFetch<{ ok: boolean }>(`${PATH}/${id}/purge`, { method: 'DELETE', query: { version } }),

  /**
   * Смена статуса. Договорённость приезжает вместе с переходом в «В работе», а факт — вместе с
   * переходом в «Выполнена»: то же устройство, что у закрытия заявки вывоза, и по той же причине —
   * отдельным запросом их пришлось бы проводить не атомарно со сменой статуса.
   */
  changeStatus: (id: string, body: ChangeMechRequestStatusInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/status`, { method: 'PATCH', body }),

  /**
   * Правка договорённости отдельной ручкой правом `.status` — тем же, которым её и поставили
   * (Р19): через общий `PATCH` это было бы неверно, там барьер роли пускает площадку, а
   * договорённость — работа офиса.
   */
  updateDeal: (id: string, body: UpdateMechDealInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/deal`, { method: 'PATCH', body }),

  /**
   * Виза площадки и её отзыв — одной ручкой (план визы, Р3): у обоих действий одно право, одна
   * область и один инвариант «пока заявка Новая». Тело различает их флагом, а не адрес — методом:
   * два маршрута разошлись бы в проверках при первой же правке.
   */
  setApproval: (id: string, body: SetMechRequestApprovalInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/approval`, { method: 'PATCH', body }),

  /** Отметка выдачи: с этого дня пошли деньги, и в истории он виден своим событием (Р11). */
  issue: (id: string, body: IssueMechRequestInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/issue`, { method: 'POST', body }),
  /**
   * Снятие ошибочной отметки — не «выдача с пустой датой», а своё действие с обязательной
   * причиной: без неё в истории осталась бы пара событий, по которой не понять, отменили выдачу
   * или техника уезжала и вернулась.
   */
  revokeIssue: (id: string, body: RevokeMechIssueInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/issue-revoke`, { method: 'POST', body }),

  /*
   * The extension visa (ADR 0171, stage 3): the dispatcher asks, the site signs, and the term moves
   * with the signature. The old immediate `PATCH /:id/extend` is not called from here at all — the
   * bundle of contract 7 must not depend on it, because release R2 removes it under floor 7
   * (ADR 0226, S-21).
   */
  /** Ask for an extension, or change the pending request (a repeated request overwrites it). */
  requestExtension: (id: string, body: RequestMechExtensionInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/extension`, { method: 'POST', body }),
  /** The visa holder's decision: approval moves the term, a refusal carries its reason. */
  decideExtension: (id: string, body: DecideMechExtensionInput) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/extension`, { method: 'PATCH', body }),
  /** Withdraw the pending request; the version goes in the query, as with deletion. */
  withdrawExtension: (id: string, version: number) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/extension`, { method: 'DELETE', query: { version } }),

  /**
   * Дублирование (Р3): «нужны две виброплиты» — две заявки, потому что ставка задаётся за единицу.
   * Тела нет — копируются значения исходной заявки; версии тоже нет, и это не пропуск: строку
   * здесь не меняют, а заводят новую, и запирать нечего.
   */
  duplicate: (id: string) =>
    apiFetch<MechRequestDto>(`${PATH}/${id}/duplicate`, { method: 'POST', body: {} }),
  duplicateWithReceipt: (id: string, idempotencyKey: string) =>
    apiFetch<{ requestId: string }>(`${PATH}/${id}/_duplicate-with-receipt`, {
      method: 'POST',
      body: {},
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  reconcileDuplicate: (id: string, idempotencyKey: string) =>
    apiFetch<RequestCreateReconciliation>(`${PATH}/${id}/_duplicate-attempts/reconcile`, {
      method: 'POST',
      body: { originalBody: {} },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  history: (id: string) => apiFetch<RequestHistoryEntryDto[]>(`${PATH}/${id}/history`),

  /** Четыре числа над списком (§7); из фильтров сводка знает только площадку. */
  summary: (query: Query) => apiFetch<MechRequestSummaryDto>(`${PATH}/summary`, { query }),

  /**
   * Журнал закрытых аренд (Э3): «Выполнена» и «Отменена». Своя ручка, а не список с фильтром по
   * статусу: в рабочем списке закрытой заявки нет вовсе, и вопросы к журналу другие — не «что
   * вести», а «сколько это стоило».
   */
  closedList: (query: Query) => apiFetch<ListResult<MechRequestDto>>(`${PATH}/history`, { query }),
  /** Итог журнала по тем же отборам: без них он отвечал бы не про то, что человек видит. */
  closedSummary: (query: Query) =>
    apiFetch<MechRequestHistorySummaryDto>(`${PATH}/history/summary`, { query }),
  /**
   * Выгрузка журнала книгой. Отбор уходит тот же, что показан на экране, но без страницы: книгу
   * собирают, чтобы посчитать в ней итог за период, и двадцать строк текущей страницы отвечали бы
   * на другой вопрос.
   *
   * Имя файла приходит заголовком `content-disposition` — сервер один знает, за какой период и
   * какой отбор внутри; здесь только запасное, на случай потери заголовка по дороге.
   */
  exportClosed: (query: Query) =>
    apiDownload(`${PATH}/history/export`, 'Механизация — история.xlsx', { query }),
};
