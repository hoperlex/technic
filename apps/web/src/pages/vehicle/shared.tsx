import { useQuery } from '@tanstack/react-query';
import { objectRecordsQuery } from '@entities/object';

/** Load active construction sites for vehicle-page selectors. */
export function useObjectOptions() {
  const { data, isFetching } = useQuery({
    ...objectRecordsQuery(true),
  });
  return {
    options: (data?.items ?? []).map((object) => ({
      value: object.id,
      label: `${object.code} — ${object.name}`,
    })),
    loading: isFetching,
  };
}
