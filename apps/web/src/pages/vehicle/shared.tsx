import { useQuery } from '@tanstack/react-query';
import { objectsApi, objectKeys } from '@entities/object';

/** Load active construction sites for vehicle-page selectors. */
export function useObjectOptions() {
  const { data, isFetching } = useQuery({
    queryKey: objectKeys.options({ activeOnly: true }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  return {
    options: (data?.items ?? []).map((object) => ({
      value: object.id,
      label: `${object.code} — ${object.name}`,
    })),
    loading: isFetching,
  };
}
