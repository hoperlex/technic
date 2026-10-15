import { vi } from 'vitest';
import { act, getConfig } from '@testing-library/react';
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
 * "Nothing new" means no query in flight **and** a screen the round left as the previous round
 * did. Queries alone miss a chain of chunks: a section page is lazy and renders a lazy tab, and
 * on a cold module cache the tab's import starts only when the page's chunk has arrived — at the
 * end of a round, while no query is running yet, because the tab that asks has not loaded. The
 * page replacing its fallback changes the screen, so one more round runs and its
 * `dynamicImportSettled` waits for the tab. Without that the first test of a section in a worker
 * measured an empty request log, and every later test of the same page a full one.
 *
 * EVERY WAIT OF A ROUND RUNS INSIDE `act`, and the screen comparison depends on it. A chunk or a
 * response that arrives outside `act` is rendered by React's scheduler, and React holds back the
 * reveal of a resolved Suspense boundary until 300 ms after the last fallback it showed
 * (`FALLBACK_THROTTLE_MS`; inside `act` it commits at once). For those 300 ms nothing is in flight
 * and the screen does not change, so two rounds agree and `settle` returned with the tab still on
 * its fallback. That was the flake of the lazy-tab probe in `query-helpers.test.tsx`: it needed the
 * tab's chunk to land in the one window a round spent outside `act` — testing-library's `waitFor`,
 * which switches the act environment off while it waits — so it showed up only on a loaded host.
 *
 * Needs real `setTimeout`: with faked timers the macrotask never runs. `freezeClock` fakes only
 * `Date` and is safe to combine with it.
 */
export async function settle(queryClient: QueryClient): Promise<void> {
  let previousScreen: string | null = null;
  for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
    await act(() => vi.dynamicImportSettled());
    await act(() => noQueryInFlight(queryClient));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    const screen = document.body.innerHTML;
    if (queryClient.isFetching() === 0 && screen === previousScreen) return;
    previousScreen = screen;
  }
  throw new Error(`the screen kept loading after ${MAX_SETTLE_ROUNDS} rounds`);
}

/**
 * Resolves once no query is in flight, checking once per macrotask. It is `waitFor` without its act
 * switch (see `settle`), under the same limit: testing-library's `asyncUtilTimeout`
 * (`test/setup.ts`), so a stuck request fails the same way any other wait of the test would, and
 * the message names the keys still fetching.
 */
function noQueryInFlight(queryClient: QueryClient): Promise<void> {
  const limit = getConfig().asyncUtilTimeout;
  // `performance.now`, not `Date.now`: `freezeClock` stops `Date`, and the limit would never come.
  const started = performance.now();
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (queryClient.isFetching() === 0) {
        resolve();
        return;
      }
      if (performance.now() - started > limit) {
        const keys = queryClient
          .getQueryCache()
          .findAll({ fetchStatus: 'fetching' })
          .map((query) => JSON.stringify(query.queryKey));
        reject(new Error(`queries still in flight after ${limit} ms: ${keys.join(', ')}`));
        return;
      }
      setTimeout(check, 0);
    };
    check();
  });
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
