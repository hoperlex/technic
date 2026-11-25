import { z } from 'zod';
import { monthSchema } from './common';
import type { AnalyticsQualityEntry } from './analytics';
import type { RequestType } from './enums';

/**
 * Waste removal statistics for a reporting month — the "Statistics" tab of the waste section
 * (ADR 0193, three-volume rework — ADR 0209, tickets and warnings — ADR 0213).
 *
 * Only the response shape lives here. The numbers are counted by the analytics atom layer
 * (`apps/api/src/services/analytics/`) — the same one that builds the Excel book: there must be no
 * second answer to "how much was removed in August" (R1; R13–R14 of the analytics plan).
 *
 * Three decisions without which the numbers are misread:
 *
 * 1. **Three volumes, each with its own money** (ADR 0209). Ordered — every valid request of the
 *    month, including new ones, by its ordered volume; removed — requests in a fact status ("done" /
 *    "completed"), by the completion; by tickets — every ticket of removed requests that is not
 *    dismissed, summed as it is (it may exceed the removed volume). Every volume comes with the
 *    money of the same requests, so a price per cubic metre can be read off any pair.
 * 2. **The ticket figure counts unreviewed readings too, and says how many** (ADR 0213, replacing
 *    R4 of ADR 0193 for this tab): most paper sits unreviewed, and a column of accepted tickets only
 *    read as "nothing was brought". The unconfirmed share, tickets with an unread volume and scans
 *    the recognition could not read travel beside the figure, so the portal can mark it. A ticket
 *    without a read volume is unknown, not zero: it is not in the sum.
 * 3. **Only removal in cubic metres, one kind at a time** (R6 of ADR 0193). Scrap metal (tonnes, no
 *    money at all — ADR 0067) and container operations (not billed, ADR 0019) never appear here,
 *    neither as a row nor as a position: a site that only had those in the month is absent from
 *    the response. Garbage and snow are answered separately by `kind` (snow-removal plan, S8);
 *    snow has no estimate, so its planned and ticket money is always `null`.
 */

/**
 * Which removal the tab counts (snow-removal plan, S8): garbage or snow, never both in one table.
 * Snow has manual costs only and no estimate, so its money columns mean something different, and
 * a shared total would mix a priced estimate with invoice amounts.
 */
export const WASTE_STATS_KINDS = ['waste', 'snow'] as const;
export type WasteStatsKind = (typeof WASTE_STATS_KINDS)[number];
export const wasteStatsKindSchema = z.enum(WASTE_STATS_KINDS);

/**
 * The stats kind a request type is counted under, `null` — never in the tab (snow-removal plan, §2
 * table «Tab statistics kind»). The server derives the SQL type filter of each kind from this map
 * and `REQUEST_TYPES`, so a new type lands in a kind here or nowhere — never through a list typed
 * by hand into a query. Scrap metal (tonnes, no money) and container operations (not billed) have
 * no kind: R6 of ADR 0193.
 *
 * A question of its own, not a conclusion from `isManualCostOnly` or `wasteFactUnit`: a future
 * volume type priced by hand need not be snow, and a kind mixing estimated and invoiced money in one
 * total is exactly what S8 forbids.
 */
export function wasteStatsKindOf(t: RequestType): WasteStatsKind | null {
  if (t === 'waste_removal') return 'waste';
  if (t === 'snow_removal') return 'snow';
  return null;
}

/**
 * `kind` defaults to `waste`: a tab built before snow sends only `month` and keeps getting the
 * garbage statistics it always got.
 */
export const wasteStatsQuerySchema = z
  .object({ month: monthSchema, kind: wasteStatsKindSchema.optional().default('waste') })
  .strict();
export type WasteStatsQuery = z.infer<typeof wasteStatsQuerySchema>;

/**
 * Figures of one cell: a site row, a position inside it or the total — all three share one shape.
 *
 * The shared shape is not about saving lines: positions must add up to their row and rows to the
 * total (R11), and different field sets on the three levels would make that comparison impossible
 * to express. The row and the position add their own names; the total does not inherit them,
 * because it has neither a position key nor a site, and fields with nothing to fill would be shown
 * empty by the first screen that reads them.
 */
export interface WasteStatsFigures {
  /**
   * ORDERED volume of every valid request of the month, whatever its status (decision Z3): truck
   * rows, else the request volume, else — for old requests filed without one — the removed volume.
   */
  plannedVolumeM3: number;
  /**
   * Money of the ordered volume, from the same source. `null` — none of that volume has a price
   * (a dash, not zero); a number with `plannedVolumeUnpricedM3 > 0` is understated and must be
   * signed. Always `null` for snow, even at zero volume: snow has no estimate at all (S6).
   */
  plannedCost: number | null;
  /** Share of the ordered volume without money. Always 0 for snow: nothing is missing a price. */
  plannedVolumeUnpricedM3: number;
  /** REMOVED volume: completions of requests in a fact status ("done" / "completed"). */
  doneVolumeM3: number;
  /**
   * Completion sums of those requests; `null` — none of the removed volume has a sum.
   *
   * Snow (S6, S7): the amounts entered at completion, a recorded 0 included as a known amount;
   * `null` when removed requests exist and none of them has an amount. No removed request — 0.
   */
  doneCost: number | null;
  /**
   * Share of the removed volume whose completion has no sum. For snow — the removed volume whose
   * invoice amount is still missing («без цены», S7).
   */
  doneVolumeUnpricedM3: number;
  /**
   * TICKET volume of removed requests: every ticket that is not dismissed — accepted and
   * recognised-but-unreviewed alike — idle tickets excluded (ADR 0213). Summed as it is: it may
   * exceed `doneVolumeM3` (decision Z4 of ADR 0209).
   */
  ticketVolumeM3: number;
  /** Of the ticket volume — the part nobody has accepted yet; above zero the figure is marked. */
  ticketVolumeUnconfirmedM3: number;
  /**
   * Of the ticket volume — the part that cannot be priced: its completion has no price (R5 of
   * ADR 0193). A field of its own and not a conclusion from zero money: zero money means both
   * "there was no price" and "there was nothing to price", and after atoms are summed these cannot
   * be told apart. Always 0 for snow: there is no price per cubic metre to miss.
   */
  ticketVolumeUnpricedM3: number;
  /**
   * Ticket volume in money: ticket volume × completion price.
   *
   * `null` — the whole ticket volume of the cell has no completion price. Zero here would mean a
   * free removal, not a missing price. A mixed case gives a NUMBER, and `ticketVolumeUnpricedM3`
   * must be shown next to it: an understated sum without a mark looks calculated. Always `null`
   * for snow: an invoice amount cannot be split by ticket volume.
   */
  ticketCost: number | null;
  /** Tickets (not dismissed, not idle) whose volume is unread: not in the sum, and that must be said. */
  ticketsWithoutVolume: number;
  /** Tickets recognised but not reviewed by a person yet (ADR 0213). */
  ticketsUnconfirmed: number;
  /** Ticket scans the recognition could not read: rejected or out of attempts (ADR 0213). */
  ticketFilesUnread: number;
  /** Ticket scans read without a single ticket found on them (ADR 0213). */
  ticketFilesWithoutTickets: number;
  /**
   * Requests that could not be priced at all: zero money must mean free work. For snow — removed
   * requests (fact status) without an entered amount; an unfinished or rolled-back snow request is
   * not missing anything yet, because its cost is entered only at completion.
   */
  unpricedRequests: number;
  /** Removals — requests in a fact status; requests are counted, not trucks (R21 of analytics). */
  removals: number;
  /** All requests of the month, unfinished ones included. */
  requests: number;
  /**
   * @deprecated Removed + ordered-but-unfinished in one number (R3 of ADR 0193, cancelled by
   * ADR 0209). Kept only for tabs opened with a build older than ADR 0209: they read it without a
   * check, and there is no error boundary. Remove when the client floor on production rises above
   * the `CLIENT_CONTRACT` this release was served with (6).
   */
  volumeM3: number;
  /** @deprecated Ordered share of `volumeM3`; see `volumeM3` for the removal condition. */
  volumeOrderedM3: number;
  /** @deprecated Fact plus estimate in one number; see `volumeM3` for the removal condition. */
  totalCost: number;
  /** @deprecated Estimated share of `totalCost`; see `volumeM3` for the removal condition. */
  costEstimated: number;
  /**
   * @deprecated Same value as `ticketVolumeM3`. Kept only for tabs opened with a build older than
   * ADR 0213: they read it without a check, and there is no error boundary. Carries the new
   * meaning on purpose — such a tab labels it "По талонам", which is what ADR 0213 counts. Remove
   * when the client floor on production rises above the `CLIENT_CONTRACT` this release was served
   * with (6).
   */
  confirmedVolumeM3: number;
  /** @deprecated Same value as `ticketVolumeUnpricedM3`; see `confirmedVolumeM3`. */
  confirmedVolumeUnpricedM3: number;
  /** @deprecated Same value as `ticketCost` (so `null` for snow); see `confirmedVolumeM3`. */
  confirmedCost: number | null;
}

/** Позиция окна детализации: вид отходов. */
export interface WasteStatsPositionDto extends WasteStatsFigures {
  /** Ключ позиции слоя атомов; порталу — только для `key` строки таблицы. */
  key: string;
  /**
   * «Строительный мусор», «Грунт», «Без вида отхода» — если справочник у заявки не заполнен.
   *
   * У заявок старше ADR 0022 в ключе позиции лежит ещё и тип машины, и подпись выходит составной:
   * «Строительный мусор · Самосвал 20 м³» (Р13). Разбирать ключ на портале значило бы завести
   * второе место, где сказано, из чего он состоит.
   */
  label: string;
}

/** Строка таблицы: площадка за месяц и её детализация по видам отходов. */
export interface WasteStatsRowDto extends WasteStatsFigures {
  objectId: string;
  code: string;
  name: string;
  isActive: boolean;
  /**
   * Позиции приезжают вместе со строкой, а не отдельным запросом по нажатию (Р11): так сумма окна
   * равна строке по построению, а не по совпадению двух выборок, сделанных в разные секунды.
   */
  positions: WasteStatsPositionDto[];
}

export interface WasteStatsDto {
  /** Эхо запроса: `YYYY-MM`. */
  month: string;
  /**
   * Echo of the requested kind. The portal renders snow figures only when the reply says `snow`:
   * an older API ignores the parameter and would answer with garbage numbers.
   */
  kind: WasteStatsKind;
  /** Границы месяца, посчитанные сервером, — портал печатает их в шапке окна. */
  from: string;
  to: string;
  rows: WasteStatsRowDto[];
  /** Итог по всем строкам. Считается из тех же атомов, а не сложением строк ответа. */
  totals: WasteStatsFigures;
  /**
   * How far the numbers can be trusted (R10): removals without an accepted ticket, requests without
   * a price, completions without an actual date, requests without an ordered volume and "done"
   * requests without a completion (ADR 0209). The same counters as the "Data quality" sheet of the
   * book.
   */
  quality: AnalyticsQualityEntry[];
}
