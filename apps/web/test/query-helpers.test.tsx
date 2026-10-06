import { afterEach, describe, expect, it } from 'vitest';
import { lazy, Suspense, useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { QUERY_CLIENT_DEFAULTS, QUERY_PROFILE } from '@shared/config';
import { createTestQueryClient, renderWithUser } from './render';
import {
  advanceClock,
  cachedGcTime,
  freezeClock,
  observedQueryKeys,
  restoreClock,
  settle,
} from './query';

/**
 * Self-test of the cache measuring kit (`./query`) and of the client the tests build. Every count
 * of requests in the suite rests on these: a client with other defaults than production, or a
 * `settle` that returns between two chained requests, would make those counts describe a system
 * that does not ship.
 */

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/*
 * Declared at module level, as the portal declares its page entries: the import runs on the first
 * render of the test that needs it, so its modules are cold there however the file is ordered.
 */
const LazyOuter = lazy(() =>
  import('./settle-probe/LazyOuter').then((m) => ({ default: m.LazyOuter })),
);

describe('тестовый клиент запросов', () => {
  it('совпадает с продовым во всём, кроме повторов запросов', () => {
    expect(createTestQueryClient().getDefaultOptions()).toEqual({
      queries: { ...QUERY_CLIENT_DEFAULTS.queries, retry: false },
      mutations: QUERY_CLIENT_DEFAULTS.mutations,
    });
  });
});

describe('settle: экран затих', () => {
  /** The second read waits for the first: it is enabled only by the first response. */
  function Chain({ log }: { log: string[] }) {
    const first = useQuery({
      queryKey: ['probe', 'first'],
      queryFn: async () => {
        log.push('first');
        await delay(5);
        return 'one';
      },
    });
    const second = useQuery({
      queryKey: ['probe', 'second', first.data],
      enabled: first.data !== undefined,
      queryFn: async () => {
        log.push('second');
        await delay(5);
        return 'two';
      },
    });
    return <div>{second.data ?? 'loading'}</div>;
  }

  it('дожидается запроса, который включил ответ предыдущего', async () => {
    const log: string[] = [];
    const { queryClient } = renderWithUser(<Chain log={log} />);

    await settle(queryClient);

    expect(log).toEqual(['first', 'second']);
    expect(queryClient.isFetching()).toBe(0);
    // Read synchronously on purpose: after `settle` the screen has nothing left to wait for.
    expect(screen.getByText('two')).toBeDefined();
  });

  it('дожидается ленивой вкладки внутри ленивой страницы, чьи модули ещё не загружены', async () => {
    const log: string[] = [];
    const { queryClient } = renderWithUser(
      <Suspense fallback={<div>page loading</div>}>
        <LazyOuter log={log} />
      </Suspense>,
    );

    await settle(queryClient);

    expect(log).toEqual(['inner']);
    expect(screen.getByText('loaded')).toBeDefined();
  });
});

describe('часы срока свежести', () => {
  afterEach(() => restoreClock());

  const KEY = ['probe', 'clock'];

  function Probe({ onFetch }: { onFetch: () => void }) {
    const { data } = useQuery({
      queryKey: KEY,
      queryFn: () => {
        onFetch();
        return 'data';
      },
    });
    return <div>{data}</div>;
  }

  it('повторный монтаж перечитывает LIVE только после срока', async () => {
    freezeClock('2026-10-06T09:00:00.000Z');
    const queryClient = createTestQueryClient();
    let fetches = 0;
    const mount = async () => {
      const view = renderWithUser(<Probe onFetch={() => (fetches += 1)} />, { queryClient });
      await settle(queryClient);
      view.unmount();
    };

    await mount();
    expect(fetches).toBe(1);

    advanceClock(QUERY_PROFILE.LIVE.staleTime - 1_000);
    await mount();
    expect(fetches).toBe(1);

    advanceClock(2_000);
    await mount();
    expect(fetches).toBe(2);
  });
});

describe('observedQueryKeys: на какой вопрос отвечает экран', () => {
  afterEach(() => restoreClock());

  function Filtered({ log }: { log: string[] }) {
    const [filter, setFilter] = useState('all');
    const { data } = useQuery({
      queryKey: ['probe', 'list', filter],
      queryFn: () => {
        log.push(filter);
        return filter;
      },
    });
    return (
      <div>
        <span>{data}</span>
        <button type="button" onClick={() => setFilter(filter === 'all' ? 'mine' : 'all')}>
          switch
        </button>
      </div>
    );
  }

  it('возврат к показанному отбору виден по ключу, хотя запроса за ним не было', async () => {
    // The wall clock stands still, so the first answer stays younger than the LIVE term however
    // slow the machine is — the return below has to be served from the cache.
    freezeClock('2026-10-06T09:00:00.000Z');
    const log: string[] = [];
    const { queryClient } = renderWithUser(<Filtered log={log} />);
    await settle(queryClient);

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    await settle(queryClient);
    expect(observedQueryKeys(queryClient, ['probe', 'list'])).toEqual([['probe', 'list', 'mine']]);

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    await settle(queryClient);
    expect(observedQueryKeys(queryClient, ['probe', 'list'])).toEqual([['probe', 'list', 'all']]);
    expect(log).toEqual(['all', 'mine']);
  });
});

describe('cachedGcTime: срок хранения записи', () => {
  it('у записи без своего срока — срок LIVE, у отсутствующей — undefined', async () => {
    const queryClient = createTestQueryClient();
    function Probe() {
      const { data } = useQuery({ queryKey: ['probe', 'gc'], queryFn: () => 'data' });
      return <div>{data}</div>;
    }

    const view = renderWithUser(<Probe />, { queryClient });
    await settle(queryClient);
    view.unmount();

    expect(cachedGcTime(queryClient, ['probe', 'gc'])).toBe(QUERY_PROFILE.LIVE.gcTime);
    expect(cachedGcTime(queryClient, ['probe', 'missing'])).toBeUndefined();
  });
});
