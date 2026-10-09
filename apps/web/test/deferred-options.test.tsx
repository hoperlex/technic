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

  it('keeps cached labels visible but withholds automatic decisions until a fresh answer', async () => {
    freezeClock();
    let answer!: (data: { items: { value: string; label: string }[] }) => void;
    const queryFn = vi.fn(
      () =>
        new Promise<{ items: { value: string; label: string }[] }>((resolve) => {
          answer = resolve;
        }),
    );
    const query = queryOptions({
      ...QUERY_PROFILE.DICTIONARY,
      queryKey: ['deferred-old-answer'],
      queryFn,
    });
    const client = createTestQueryClient();
    client.setQueryData(
      query.queryKey,
      { items: [{ value: 'old', label: 'Old' }] },
      {
        updatedAt: Date.now() - QUERY_PROFILE.PICK.staleTime - 1,
      },
    );
    function Picker({ open }: { open: boolean }) {
      const result = useDeferredOptions(query, open, (data) => data.items, 'pick');
      return <output>{`${result.options?.[0]?.label}:${result.current}`}</output>;
    }
    const mounted = render(
      <QueryClientProvider client={client}>
        <Picker open={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Old:false')).toBeDefined();
    act(() =>
      mounted.rerender(
        <QueryClientProvider client={client}>
          <Picker open />
        </QueryClientProvider>,
      ),
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Old:false')).toBeDefined();

    await act(async () => answer({ items: [{ value: 'new', label: 'New' }] }));
    await settle(client);
    expect(screen.getByText('New:true')).toBeDefined();
    expect(client.getQueryCache().find({ queryKey: query.queryKey })?.meta?.profile).toBe(
      'DICTIONARY',
    );
  });
});
