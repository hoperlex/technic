import { keepPreviousData, type QueryKey } from '@tanstack/react-query';

/** Keep a server list visible while its page or filters change, but never fill a disabled query. */
export function listQueryOptions<T extends { queryKey: QueryKey; enabled?: boolean }>(options: T) {
  return {
    ...options,
    placeholderData: options.enabled === false ? undefined : keepPreviousData,
  };
}
