import { useQuery } from '@tanstack/react-query';

/**
 * The innermost piece of the `settle` probe (`query-helpers.test.tsx`): a lazily loaded component
 * that asks the server only once it is on screen, as a section tab does.
 */
export function LazyInner({ log }: { log: string[] }) {
  const { data } = useQuery({
    queryKey: ['probe', 'lazy-inner'],
    queryFn: () => {
      log.push('inner');
      return 'loaded';
    },
  });
  return <div>{data ?? 'loading'}</div>;
}
