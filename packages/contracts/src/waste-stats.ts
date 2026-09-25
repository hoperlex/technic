import { z } from 'zod';
import { monthSchema } from './common';
import type { AnalyticsQualityEntry } from './analytics';

/**
 * Waste removal statistics for a reporting month — the "Statistics" tab of the waste section
 * (ADR 0193, three-volume rework — ADR 0209).
 *
 * Only the response shape lives here. The numbers are counted by the analytics atom layer
 * (`apps/api/src/services/analytics/`) — the same one that builds the Excel book: there must be no
 * second answer to "how much was removed in August" (R1; R13–R14 of the analytics plan).
 *
 * Three decisions without which the numbers are misread:
 *
 * 1. **Three volumes, each with its own money** (ADR 0209). Ordered — every valid request of the
 *    month, including new ones, by its ordered volume; removed — requests in a fact status ("done" /
 *    "completed"), by the completion; confirmed — accepted tickets of removed requests, summed as
 *    they are (they may exceed the removed volume). Every volume comes with the money of the same
 *    requests, so a price per cubic metre can be read off any pair.
 * 2. **Only an accepted ticket confirms a volume** (R4 of ADR 0193): what is recognised but not
 *    reviewed by a person stays a machine suggestion. A ticket without a read volume is unknown,
 *    not zero: it is not in the sum and is counted separately (`ticketsWithoutVolume`).
 * 3. **Only waste removal in cubic metres** (R6 of ADR 0193). Scrap metal (tonnes, no money at all
 *    — ADR 0067) and container operations (not billed, ADR 0019) never appear here, neither as a
 *    row nor as a position: a site that only had those in the month is absent from the response.
 */

export const wasteStatsQuerySchema = z.object({ month: monthSchema }).strict();
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
   * signed.
   */
  plannedCost: number | null;
  /** Share of the ordered volume without money. */
  plannedVolumeUnpricedM3: number;
  /** REMOVED volume: completions of requests in a fact status ("done" / "completed"). */
  doneVolumeM3: number;
  /** Completion sums of those requests; `null` — none of the removed volume has a sum. */
  doneCost: number | null;
  /** Share of the removed volume whose completion has no sum. */
  doneVolumeUnpricedM3: number;
  /**
   * Volume of accepted tickets of removed requests, idle tickets excluded (R4). Summed as it is —
   * it may exceed `doneVolumeM3` (decision Z4).
   */
  confirmedVolumeM3: number;
  /**
   * Of the confirmed volume — the part that cannot be priced: its completion has no price (R5). A
   * field of its own and not a conclusion from zero money: zero money means both "there was no
   * price" and "there was nothing to confirm", and after atoms are summed these cannot be told apart.
   */
  confirmedVolumeUnpricedM3: number;
  /**
   * Confirmed volume in money: ticket volume × completion price (R5).
   *
   * `null` — the whole confirmed volume of the cell has no completion price. Zero here would mean a
   * free removal, not a missing price. A mixed case gives a NUMBER, and `confirmedVolumeUnpricedM3`
   * must be signed next to it: an understated sum without a note looks calculated.
   */
  confirmedCost: number | null;
  /** Accepted tickets whose volume is unread: they are not in the sum, and that must be said (R4). */
  ticketsWithoutVolume: number;
  /** Requests that could not be priced at all: zero money must mean free work. */
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
