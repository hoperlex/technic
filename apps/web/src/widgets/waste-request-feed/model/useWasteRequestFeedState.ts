import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { parseWasteRequestNumberSearch, type ContainerKind } from '@technic/contracts';
import { wasteRequestKeys, wasteRequestsApi } from '@entities/waste-request';
import { dayEnd, dayStart, useListParams } from '@shared/lib';
import type {
  WasteFilterOptions,
  WasteFilterValues,
  WasteRequestFeedList,
  WasteRequestFeedSources,
  WasteRequestFeedSummary,
} from './types';
import { subjectFilterOptions, subjectFilterPatch, subjectFilterValue } from './subjectFilter';

interface FeedParams extends WasteFilterValues {
  objectId?: string;
  containerKind?: ContainerKind;
  num?: number;
}

/** Own the working-list URL state and preserve the list/summary query-key shapes. */
export function useWasteRequestFeedState(
  sources: WasteRequestFeedSources,
  canReviewTickets: boolean,
) {
  const { params, setParams, setSort, onTableChange } = useListParams<FeedParams>(
    { objectId: sources.initialObjectId || undefined },
    { searchKeys: ['comment'] },
  );
  const [objectFilter, setObjectFilter] = useState(sources.initialObjectId);
  const [numberInput, setNumberInput] = useState('');

  /** Any filter change returns the list to the first page. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((previous) => ({ ...previous, ...patch, page: 1 }));

  const applyObjectFilter = (value: string) => {
    setObjectFilter(value);
    applyFilter({ objectId: value || undefined });
  };
  const applyNumberFilter = (value: string) => {
    setNumberInput(value);
    applyFilter({ num: parseWasteRequestNumberSearch(value) });
  };

  // Delivery filters are calendar dates in the UI and exact instants in both the request and key.
  const listQuery = {
    ...params,
    deliveryFrom: dayStart(params.deliveryFrom),
    deliveryTo: dayEnd(params.deliveryTo),
  };
  const listQueryResult = useQuery({
    queryKey: wasteRequestKeys.list(listQuery),
    queryFn: () => wasteRequestsApi.list(listQuery),
  });
  // Summary shares the list root so every existing mutation invalidates both views together.
  const summaryQueryResult = useQuery({
    queryKey: wasteRequestKeys.summary(params.objectId),
    queryFn: () => wasteRequestsApi.summary({ objectId: params.objectId }),
  });

  const subjectOptions = subjectFilterOptions(sources.subjectTypes);
  const filterOptions: WasteFilterOptions = {
    values: params,
    onChange: applyFilter,
    objects: {
      options: sources.objectOptions,
      loading: sources.objectsLoading,
      value: objectFilter,
      disabled: sources.objectFilterDisabled,
      onChange: applyObjectFilter,
    },
    subject: {
      options: subjectOptions,
      value: subjectFilterValue(params),
      onChange: (value) => applyFilter(subjectFilterPatch(value)),
    },
    operators: sources.operators,
    num: { text: numberInput, onChange: applyNumberFilter },
    ticketReview: canReviewTickets,
  };
  const list: WasteRequestFeedList = {
    onChange: onTableChange,
    onSortChange: setSort,
    page: params.page,
    pageSize: params.pageSize,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  };
  const summary: WasteRequestFeedSummary = {
    new: summaryQueryResult.data?.new ?? 0,
    confirmed: summaryQueryResult.data?.confirmed ?? 0,
    done: summaryQueryResult.data?.done ?? 0,
  };

  return {
    rows: listQueryResult.data?.items ?? [],
    total: listQueryResult.data?.total ?? 0,
    loading: listQueryResult.isFetching,
    filterOptions,
    list,
    summary,
  };
}
