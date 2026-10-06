import { QueryClient } from '@tanstack/react-query';
import { QUERY_CLIENT_DEFAULTS } from '@shared/config';

/**
 * What a test may change in the production client — retries and nothing else. A retried request
 * makes a test pass "sometimes", which is worse than a failure; any other difference would make the
 * test measure a cache that does not ship. The type is narrow on purpose: a test wanting
 * `staleTime: 0` to see a refetch is hiding a missing invalidation, and has to fail to compile.
 */
export interface QueryClientOverrides {
  retry?: false;
}

/** The portal's query client: `main.tsx` and every test build it here, from one set of defaults. */
export function createQueryClient(overrides: QueryClientOverrides = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { ...QUERY_CLIENT_DEFAULTS.queries, ...overrides },
      mutations: { ...QUERY_CLIENT_DEFAULTS.mutations },
    },
  });
}
