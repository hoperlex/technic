import { expect } from 'vitest';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

/** Prime a fresh inactive directory entry before mutating the owner of an embedded field. */
export function primeCarriers(queryClient: QueryClient, keys: QueryKey[]): void {
  for (const key of keys) queryClient.setQueryData(key, 'before');
}

/** An invalidated fresh entry must fetch again when its carrier is next opened. */
export async function expectCarriersRefetched(
  queryClient: QueryClient,
  keys: QueryKey[],
): Promise<void> {
  for (const key of keys) {
    expect(queryClient.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    expect(
      await queryClient.fetchQuery({
        queryKey: key,
        queryFn: async () => 'after',
        staleTime: Infinity,
      }),
      JSON.stringify(key),
    ).toBe('after');
  }
}
