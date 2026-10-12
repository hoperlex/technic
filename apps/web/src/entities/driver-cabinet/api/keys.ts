import { createQueryKeys } from '@shared/api';

/**
 * Cabinet keys. Named apart from the `driverKeys` of `@entities/driver` on purpose: that slice
 * answers "which drivers exist" for the directory, this root holds one person's own day. While
 * both were spelled `driverKeys`, a reader of any single use site could not tell which root was
 * meant, and the roots are not interchangeable — invalidating one leaves the other stale.
 */
export const driverCabinetKeys = createQueryKeys('driver-cabinet', {
  /** Every date's assignment — a prefix to drop; the date stays the third segment of the key. */
  assignments: () => ['assignment'],
  /** Задание на дату: ключ по дате — переключение стрелками не перезапрашивает уже показанный день. */
  assignment: (date: string) => ['assignment', date],
  /** Every date's report — a prefix to drop, with the same date position as `assignments`. */
  reports: () => ['report'],
  /**
   * Отчёт дня — **единственное место, где живёт `DriverReportDto`** (план driver-readings-first,
   * Р8). Второго кэша под ответ `open` нет намеренно: два кэша одного отчёта разъезжаются, и
   * первой это увидела бы строка долга в шапке — `usePendingDays` читает именно этот ключ.
   */
  report: (date: string) => ['report', date],
});

/**
 * How long a cabinet answer counts as fresh. The same as the portal's LIVE term
 * (`shared/config/query.ts`), but a number of its own: here it guards not the request count but
 * the mutation answer lying in the cache (see `cabinetRead`).
 */
const CABINET_FRESH_MS = 10_000;

/**
 * The driver's assignment and report follow a different freshness policy from the portal's LIVE
 * reads. A phone may return from the background after dispatch changed the route, so both refetch
 * on focus even if the last response was recent. Their own ten-second term also protects a response
 * just written by `open` or `submit`: those commands share the report key, and the read is disabled
 * while they run. An immediate refetch on re-enable could replace the command's answer with an
 * older snapshot.
 */
// query-freshness: exception — cabinet reads refresh on focus and retain mutation answers briefly
export const cabinetRead = {
  refetchOnWindowFocus: 'always',
  staleTime: CABINET_FRESH_MS,
} as const;
