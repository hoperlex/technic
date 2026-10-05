import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { useListParams } from '@shared/lib';

/** Own the counterparty list query and URL-backed table state. */
export function useCounterpartyRegistry() {
  const { params, setParams, setSort, onTableChange } = useListParams<{
    type?: string;
    isActive?: string;
    includeDeleted?: string;
  }>(
    {},
    {
      searchKeys: ['name', 'inn'],
      // Type is controlled only by the toolbar. Mirroring it as a table filter would make every
      // sort clear the selection because Ant Table reports an empty filter for absent columns.
      mapFilters: (filters) => ({ isActive: filters.isActive?.[0] as string | undefined }),
    },
  );
  const { data, isFetching } = useQuery({
    queryKey: counterpartyKeys.list(params),
    queryFn: () => counterpartiesApi.list(params),
  });

  const [typeFilter, setTypeFilter] = useState('');
  const applyTypeFilter = (value: string) => {
    setTypeFilter(value);
    setParams((current) => ({ ...current, page: 1, type: value || undefined }));
  };

  return {
    data,
    isFetching,
    params,
    setParams,
    setSort,
    onTableChange,
    typeFilter,
    applyTypeFilter,
  };
}
