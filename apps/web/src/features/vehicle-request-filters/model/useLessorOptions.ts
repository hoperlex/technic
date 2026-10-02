import { useQuery } from '@tanstack/react-query';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';

/** Include inactive lessors because closed requests remain searchable after cooperation ends. */
export function useLessorOptions() {
  const { data, isFetching } = useQuery({
    queryKey: counterpartyKeys.vehicleLessorOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'vehicle_lessor',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  return {
    options: (data?.items ?? []).map((counterparty) => ({
      value: counterparty.id,
      label: counterparty.name,
    })),
    loading: isFetching,
  };
}
