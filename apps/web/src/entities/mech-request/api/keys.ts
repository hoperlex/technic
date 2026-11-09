import { createQueryKeys, type Query } from '@shared/api';

/**
 * Query keys of mechanization rental requests (plan `docs/mechanization-module-plan.md`).
 *
 * Families are split by the kind of question, not by the screen: the list with its filters, the
 * card by id (it is opened by a link, bypassing the list), the request's history and the summary
 * above the list. Under one key a card opened from the archive would overwrite the page of the
 * working list — whoever asked second would decide the answer for both.
 *
 * The summary is a family inside the requests, not a root of its own: its four numbers are counted
 * over the same requests by the same R2 predicates and go stale on the same events. A root of its
 * own would mean a header that keeps showing a request "awaiting issue" after the issue was marked.
 *
 * The model hint family is gone: the subject of a request is picked from the model directory
 * (ADR 0156), and that list lives under its own key in `entities/mech-model` — it is not about
 * requests, and filing a new one does not make it stale.
 */
export const mechRequestKeys = createQueryKeys('mech-requests', {
  list: (params: Query) => ['list', params],
  detail: (id: string) => ['detail', id],
  history: (id: string) => ['history', id],
  summary: (params: Query) => ['summary', params],
  /**
   * The journal of closed requests and its total (E3): «Выполнена» and «Отменена» over the chosen
   * filter.
   *
   * Named `closed`, not `history`: `history` in this same set is taken by one request's event feed,
   * and two different questions under one prefix would drop each other — marking an issue in the
   * card would reset the journal page opened next to it.
   *
   * The total is a family of its own, not a tail of the list: it is counted over the whole filter,
   * without a page or an order, and a shared key would recount all six numbers on every page turn.
   */
  closed: (params: Query) => ['closed', params],
  closedSummary: (params: Query) => ['closed-summary', params],
  /**
   * The mechanization lessor's own list and card (lessor receipt plan, P12): other doors and
   * another DTO, so families of their own — an office card and a lessor card of the same id must
   * never answer for each other. Under the module's root on purpose: the receipt doors drop the
   * whole root when they settle, and the lessor's attach must refresh his list and card with it.
   */
  lessorList: (params: Query) => ['lessor-list', params],
  lessorDetail: (id: string) => ['lessor-detail', id],
});
