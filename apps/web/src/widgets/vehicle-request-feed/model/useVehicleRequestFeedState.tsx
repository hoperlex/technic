import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router';
import {
  allowedVehicleRequestTypes,
  type FeedKind,
  feedKindLabels,
  parseFeedNumberSearch,
  vehicleRequestTypeLabels,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { canOpenRoute } from '@entities/vehicle-route';
import { useVehicleClassificationFilter } from '@entities/vehicle-type';
import { weeklyRequestPath, weekSelectOptions } from '@entities/weekly-request';
import { useRequestCustomerDefaults, useRequestCustomerFilter } from '@features/request-customer';
import { useVehicleFilter } from '@features/vehicle-request-filters';
import { useListParams } from '@shared/lib';
import type {
  VehicleRequestFeedFilters,
  VehicleRequestFeedList,
  VehicleRequestFeedSummary,
} from './types';

interface FeedParams {
  requestType?: string;
  status?: string;
  objectId?: string;
  departmentId?: string;
  /** Ordered classifications use `t<uuid>` for a type and `c<uuid>` for a category. */
  classifications?: string;
  /** The assigned fleet vehicle is a separate axis from the ordered classification. */
  vehicleId?: string;
  num?: number;
  approved?: string;
  /** Weekly requests share the feed but never become a third vehicle request type. */
  kind?: FeedKind;
  weekStart?: string;
}

/** Own list state and queries while commands continue to be composed by the route page. */
export function useVehicleRequestFeedState() {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const customerDefaults = useRequestCustomerDefaults();
  const requestTypeOptions = allowedVehicleRequestTypes(user).map((type) => ({
    value: type,
    label: vehicleRequestTypeLabels[type],
  }));

  // The legacy weekly tab now points at this feed with a one-time initial document-kind filter.
  const [searchParams] = useSearchParams();
  const initialKind: FeedKind | undefined =
    searchParams.get('kind') === 'weekly' ? 'weekly' : undefined;
  const { params, setParams, setSort, onTableChange } = useListParams<FeedParams>(
    {
      objectId: customerDefaults.objectId,
      departmentId: customerDefaults.departmentId,
      kind: initialKind,
    },
    { searchKeys: ['comment'] },
  );

  /** Any filter change returns the feed to its first page. */
  const applyFilter = (patch: Partial<typeof params>) =>
    setParams((previous) => ({ ...previous, ...patch, page: 1 }));

  const classificationFilter = useVehicleClassificationFilter({
    classifications: params.classifications,
    onChange: applyFilter,
  });
  const vehicleFilter = useVehicleFilter({ vehicleId: params.vehicleId, onChange: applyFilter });
  const customerFilter = useRequestCustomerFilter({
    objectId: params.objectId,
    departmentId: params.departmentId,
    onChange: applyFilter,
  });

  // Orders and weekly documents must come from the same server page and ordering. The ordinary
  // request list is also used by archive and route selection, where weekly documents are invalid.
  const feedQuery = useQuery({
    queryKey: vehicleRequestKeys.feed(params),
    queryFn: () => vehicleRequestsApi.feed(params),
  });
  const summaryQuery = {
    objectId: params.objectId,
    departmentId: params.departmentId,
    requestType: params.requestType,
    classifications: params.classifications,
    vehicleId: params.vehicleId,
  };
  const summaryResult = useQuery({
    queryKey: vehicleRequestKeys.summary(summaryQuery),
    queryFn: () => vehicleRequestsApi.summary(summaryQuery),
  });

  const documentTypeOptions = [
    ...requestTypeOptions,
    { value: 'weekly', label: feedKindLabels.weekly },
  ];
  const documentTypeValue = params.kind === 'weekly' ? 'weekly' : params.requestType;
  const applyDocumentType = (value: string | undefined) =>
    value === 'weekly'
      ? applyFilter({ kind: 'weekly', requestType: undefined })
      : // A hidden week filter must not keep narrowing ordinary orders after the kind changes.
        applyFilter({ kind: undefined, weekStart: undefined, requestType: value });

  /** Number prefixes select the document kind because weekly and order sequences are independent. */
  const applyNumberSearch = (value: string) => {
    const found = parseFeedNumberSearch(value);
    if (!found) return applyFilter({ num: undefined });
    return applyFilter({
      num: found.num,
      kind: found.kind === 'weekly' ? 'weekly' : undefined,
      ...(found.kind === 'weekly' ? {} : { weekStart: undefined }),
    });
  };

  const filters: VehicleRequestFeedFilters = {
    approved: params.approved,
    classificationControls: classificationFilter.controls,
    classificationMobileFilter: classificationFilter.mobileFilter,
    customerControls: customerFilter.controls,
    customerMobileFilter: customerFilter.mobileFilter,
    documentTypeOptions,
    documentTypeValue,
    kind: params.kind,
    num: params.num,
    onApprovalChange: (value) => applyFilter({ approved: value }),
    onDocumentTypeChange: applyDocumentType,
    onNumberSearch: applyNumberSearch,
    onStatusChange: (value) => applyFilter({ status: value }),
    onWeekStartChange: (value) => applyFilter({ weekStart: value }),
    status: params.status,
    vehicleControls: vehicleFilter.controls,
    vehicleMobileFilter: vehicleFilter.mobileFilter,
    weekOptions: weekSelectOptions(),
    weekStart: params.weekStart,
  };
  const list: VehicleRequestFeedList = {
    onChange: onTableChange,
    onSortChange: setSort,
    page: params.page,
    pageSize: params.pageSize,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  };
  const data = feedQuery.data;
  const summary: VehicleRequestFeedSummary = {
    awaitingApproval: summaryResult.data?.awaitingApproval ?? 0,
    confirmed: summaryResult.data?.confirmed ?? 0,
    new: summaryResult.data?.new ?? 0,
    weeklyPending: data?.weeklyPendingCount ?? 0,
  };

  return {
    rows: data?.items ?? [],
    total: data?.total ?? 0,
    loading: feedQuery.isFetching,
    filters,
    list,
    summary,
    rights: {
      canCreate: can('vehicleRequests.create'),
      canCreateWeekly: can('weeklyRequests.create'),
      showRoutes: canOpenRoute(can),
    },
    openWeekly: (request: WeeklyVehicleRequestDto) => void navigate(weeklyRequestPath(request.id)),
  };
}
