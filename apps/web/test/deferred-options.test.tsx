import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClientProvider, queryOptions } from '@tanstack/react-query';
import { QUERY_PROFILE } from '@shared/config';
import { useDeferredOptions } from '@shared/lib';
import { advanceClock, freezeClock, restoreClock, settle } from './query';
import { createTestQueryClient } from './render';

afterEach(restoreClock);

describe('deferred directory observer', () => {
  it('waits for opening and checks a cached choice again after the PICK term', async () => {
    freezeClock();
    const queryFn = vi.fn(async () => ({ items: [{ value: 'one', label: 'First' }] }));
    const query = queryOptions({
      ...QUERY_PROFILE.DICTIONARY,
      queryKey: ['deferred-test'],
      queryFn,
    });
    const client = createTestQueryClient();
    function Picker({ open }: { open: boolean }) {
      const result = useDeferredOptions(query, open, (data) => data.items, 'pick');
      return <output>{`${result.state}:${result.options?.[0]?.label ?? 'none'}`}</output>;
    }
    const mounted = render(
      <QueryClientProvider client={client}>
        <Picker open={false} />
      </QueryClientProvider>,
    );
    await settle(client);
    expect(screen.getByText('idle:none')).toBeDefined();
    expect(queryFn).not.toHaveBeenCalled();

    const show = (open: boolean) =>
      act(() =>
        mounted.rerender(
          <QueryClientProvider client={client}>
            <Picker open={open} />
          </QueryClientProvider>,
        ),
      );
    show(true);
    await settle(client);
    expect(screen.getByText('ready:First')).toBeDefined();
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().find({ queryKey: ['deferred-test'] })?.meta?.profile).toBe(
      'DICTIONARY',
    );

    show(false);
    advanceClock(59_000);
    show(true);
    await settle(client);
    expect(queryFn).toHaveBeenCalledTimes(1);

    show(false);
    advanceClock(2_000);
    show(true);
    await settle(client);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
