import { useQuery, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { QUERY_PROFILE } from '@shared/config';

/** A filter and a form observe the same directory key independently. */
export function useDeferredOptions<TData, TSelected, TError, TKey extends QueryKey, TOption>(
  query: UseQueryOptions<TData, TError, TSelected, TKey>,
  enabled: boolean,
  optionsOf: (data: TSelected) => TOption[],
  freshness: 'dictionary' | 'pick' = 'dictionary',
) {
  const result = useQuery({
    ...query,
    enabled,
    ...(freshness === 'pick' ? QUERY_PROFILE.PICK : {}),
  });
  return {
    data: result.data,
    options: result.data === undefined ? undefined : optionsOf(result.data),
    state: (result.isSuccess ? 'ready' : enabled ? 'loading' : 'idle') as
      'idle' | 'loading' | 'ready',
    loading: result.isLoading,
    isSuccess: result.isSuccess,
  };
}
