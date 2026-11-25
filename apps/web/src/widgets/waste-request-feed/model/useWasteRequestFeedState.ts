import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  parseWasteRequestNumberSearch,
  REQUEST_TYPES,
  requestTypeLabels,
  type ContainerKind,
  type RequestType,
} from '@technic/contracts';
import { counterpartyActiveOperatorOptionsQuery } from '@entities/counterparty';
import { containerTypeOptionsQuery } from '@entities/container-type';
import { objectFilterOptionLabel, objectRecordsQuery } from '@entities/object';
import {
  offeredRequestTypes,
  useSnowSupport,
  wasteRequestKeys,
  wasteRequestsApi,
} from '@entities/waste-request';
import { listQueryOptions } from '@shared/api';
import { dayEnd, dayStart, useDeferredOptions, useListParams } from '@shared/lib';
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

/**
 * Own the working-list URL state and preserve the list/summary query-key shapes. Filters live in
 * the panel above the table, not in column dropdowns: a header hides them, and half of them
 * (object, operator) are directory lists that do not fit there.
 */
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
  const [objectOpened, setObjectOpened] = useState(false);
  const [subjectOpened, setSubjectOpened] = useState(false);
  const [operatorOpened, setOperatorOpened] = useState(false);
  const [typesOpened, setTypesOpened] = useState(false);
  // Snow in the type filter only while the serving API confirms it; a snow filter set earlier is
  // not sent to a server that stopped confirming snow (snow-removal plan, §3.5).
  const snowSelected = params.requestType === 'snow_removal';
  const snow = useSnowSupport(typesOpened || snowSelected);
  const snowBlocked = snowSelected && !snow.supported;
  const objects = useDeferredOptions(
    objectRecordsQuery(true),
    objectOpened || !!params.objectId,
    (data) =>
      data.items.map((object) => ({
        value: object.id,
        label: objectFilterOptionLabel(object),
      })),
  );
  const types = useDeferredOptions(
    containerTypeOptionsQuery({ activeOnly: true }),
    subjectOpened || !!params.containerTypeId || !!params.containerKind,
    (data) => data.items,
  );
  const operators = useDeferredOptions(
    counterpartyActiveOperatorOptionsQuery(),
    sources.canAssignOperator && (operatorOpened || !!params.operatorCounterpartyId),
    (data) => data.items.map((operator) => ({ value: operator.id, label: operator.name })),
  );

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

  // Delivery filters are calendar dates in the UI and exact instants in both the request and the
  // cache key: deliveryAt is stored with time, and a key built from the raw dates would let two
  // different periods with the same dates share one cache entry.
  const listQuery = {
    ...params,
    deliveryFrom: dayStart(params.deliveryFrom),
    deliveryTo: dayEnd(params.deliveryTo),
  };
  const listQueryResult = useQuery(
    listQueryOptions({
      queryKey: wasteRequestKeys.list(listQuery),
      queryFn: () => wasteRequestsApi.list(listQuery),
      enabled: !snowBlocked,
    }),
  );
  // Header summary: how many requests await processing and how many are in work. Its key shares
  // the list root, so every existing mutation invalidates both views together.
  const summaryQueryResult = useQuery(
    listQueryOptions({
      queryKey: wasteRequestKeys.summary(params.objectId),
      queryFn: () => wasteRequestsApi.summary({ objectId: params.objectId }),
    }),
  );

  const subjectTypes = {
    cont: (types.options ?? [])
      .filter((type) => type.type === 'cont')
      .map((type) => ({ value: type.id, label: type.name })),
    truck: (types.options ?? [])
      .filter((type) => type.type === 'truck')
      .map((type) => ({ value: type.id, label: type.name })),
  };
  const subjectOptions = subjectFilterOptions(subjectTypes);
  const filterOptions: WasteFilterOptions = {
    values: params,
    onChange: applyFilter,
    objects: {
      options: sources.limitObjectOptions(objects.options ?? []),
      loading: objects.loading,
      value: objectFilter,
      disabled: sources.objectFilterDisabled,
      onChange: applyObjectFilter,
      onOpen: () => setObjectOpened(true),
    },
    subject: {
      options: subjectOptions,
      value: subjectFilterValue(params),
      onChange: (value) => applyFilter(subjectFilterPatch(value)),
      onOpen: () => setSubjectOpened(true),
      loading: types.loading,
    },
    operators: sources.canAssignOperator
      ? {
          options: operators.options ?? [],
          loading: operators.loading,
          onOpen: () => setOperatorOpened(true),
        }
      : null,
    types: {
      options: offeredRequestTypes(
        REQUEST_TYPES,
        snow.supported,
        params.requestType as RequestType | undefined,
      ).map((type) => ({ value: type, label: requestTypeLabels[type] })),
      onOpen: () => {
        setTypesOpened(true);
        snow.recheck();
      },
    },
    num: { text: numberInput, onChange: applyNumberFilter },
    ticketReview: canReviewTickets,
  };
  const list: WasteRequestFeedList = {
    onChange: onTableChange,
    onSearchChange: (search) => applyFilter({ search }),
    onSortChange: setSort,
    page: params.page,
    pageSize: params.pageSize,
    search: params.search,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  };
  const summary: WasteRequestFeedSummary = {
    new: summaryQueryResult.data?.new ?? 0,
    confirmed: summaryQueryResult.data?.confirmed ?? 0,
    done: summaryQueryResult.data?.done ?? 0,
  };

  return {
    // A withdrawn confirmation hides a cached snow answer too: stale rows would stay clickable next
    // to the «unavailable» notice.
    rows: snowBlocked ? [] : (listQueryResult.data?.items ?? []),
    total: snowBlocked ? 0 : (listQueryResult.data?.total ?? 0),
    loading: listQueryResult.isFetching || (snowSelected && snow.checking),
    snowBlocked: snowBlocked && !snow.checking,
    isPlaceholderData: listQueryResult.isPlaceholderData,
    filterOptions,
    list,
    summary,
  };
}
