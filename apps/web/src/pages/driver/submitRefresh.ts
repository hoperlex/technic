import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { driverCabinetKeys } from '@entities/driver-cabinet';

/**
 * What a submit for `date` changes in the cabinet's cache besides its own report.
 *
 * LATER days of the same vehicles: the server relinks their readings to this day's
 * (`relinkChains`), so a later report recomputes its deltas and anomalies, and a later assignment
 * shows this day's numbers as `previous` — the snapshot read strictly before its date
 * (`previousReadings`), against which the form raises its warnings. Until this was written the page
 * dropped this day's assignment instead, whose `previous` is older than the day and cannot change,
 * and a later day opened within the freshness term warned against the counters of the day before.
 *
 * Not the root (R8): it would take `report(date)`, the key the submit answer has just been put
 * into, while the read gate is the only thing keeping a stale answer out of it. Earlier days are not
 * touched by the server at all.
 */
export function refreshAfterSubmit(queryClient: QueryClient, date: string): Promise<unknown> {
  // Dates are ISO `YYYY-MM-DD`, the third segment of both families: string order is date order.
  const later = (query: { queryKey: QueryKey }) => String(query.queryKey[2]) > date;
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: driverCabinetKeys.assignments(), predicate: later }),
    queryClient.invalidateQueries({ queryKey: driverCabinetKeys.reports(), predicate: later }),
  ]);
}
