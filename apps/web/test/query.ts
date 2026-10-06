import { expect, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Measuring the query cache in tests (stage 5 plan, §6). The tests build the production client
 * (`createTestQueryClient` in `./render`), so a refetch happens only when production would do it:
 * on a mount after the freshness term, after an invalidation, or on an explicit request. These
 * helpers make that measurable — when a screen is quiet, how old its data is, how long an
 * unobserved entry stays.
 */

/** A screen that keeps loading past this many rounds is a loop, not a slow test. */
const MAX_SETTLE_ROUNDS = 20;

/**
 * Waits until the screen stops loading: lazy chunks are in and no query is in flight.
 *
 * One check is not enough, hence the rounds. A response renders on a later macrotask (the
 * library delivers notifications through `setTimeout(0)`), and a query enabled by that response
 * starts only after the render commits — an instant check between the two would call the screen
 * quiet with a request still to come. The same goes for a chunk that a response asks for. A round
 * therefore lets one macrotask pass and ends only when nothing new started meanwhile.
 *
 * Needs real `setTimeout`: with faked timers the macrotask never runs. `freezeClock` fakes only
 * `Date` and is safe to combine with it.
 */
export async function settle(queryClient: QueryClient): Promise<void> {
  for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
    await act(() => vi.dynamicImportSettled());
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    if (queryClient.isFetching() === 0) return;
  }
  throw new Error(`the screen kept loading after ${MAX_SETTLE_ROUNDS} rounds`);
}

/**
 * Fakes the wall clock and nothing else. Freshness compares `Date.now()` with the moment the data
 * arrived, so moving `Date` ages the cache without waiting; timers stay real, because rendering,
 * `waitFor` and the library's notifications all run on them. Call `restoreClock` in `afterEach`.
 */
export function freezeClock(now: Date | string | number = Date.now()): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
}

/** Moves the faked wall clock forward: `advanceClock(11_000)` makes LIVE data stale. */
export function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

export function restoreClock(): void {
  vi.useRealTimers();
}

/**
 * Keys under `queryKey` that a mounted component observes right now — which question the screen is
 * showing the answer to.
 *
 * A request log cannot say this on its own: going back to a filter or a mode the screen has
 * already shown is answered from the cache while that entry is fresh, and no request goes out.
 * The observed key is what a filter test reads then: the state the screen returned to, whether or
 * not the network was asked.
 */
export function observedQueryKeys(queryClient: QueryClient, queryKey: QueryKey): QueryKey[] {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey, type: 'active' })
    .map((query) => query.queryKey);
}

/**
 * How long the cache keeps the entry once nobody observes it, in milliseconds; `undefined` when the
 * entry does not exist.
 *
 * Faking `Date` cannot test this: the entry is dropped by a timer of the library, not by a
 * comparison of dates. The value itself is what to check — it is the maximum over every observer
 * the entry has had and never goes down while the entry lives.
 */
export function cachedGcTime(queryClient: QueryClient, queryKey: QueryKey): number | undefined {
  return queryClient.getQueryCache().find({ queryKey, exact: true })?.gcTime;
}
