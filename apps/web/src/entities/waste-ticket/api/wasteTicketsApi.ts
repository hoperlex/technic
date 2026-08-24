import type {
  AcceptWasteTicketCheckInput,
  ArbitrateWasteTicketBlindCheckInput,
  ConfirmWasteTicketInput,
  CreateWasteTicketInput,
  DismissWasteTicketInput,
  UpdateWasteTicketInput,
  WasteRequestTicketsDto,
  WasteTicketBlindCheckInput,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

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
  /** `ok` — работает; `degraded` — временно недоступно; `unconfigured` — нужен администратор. */
  state: 'ok' | 'degraded' | 'unconfigured';
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

  health: () => apiFetch<TicketRecognitionHealth>('/waste-requests/ticket-recognition/health'),
};
