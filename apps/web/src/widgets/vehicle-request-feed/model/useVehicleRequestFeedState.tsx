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
  /**
   * Ordered equipment (ADR 0028) as a set: t<uuid> is a whole type, c<uuid> one of its categories.
   */
  classifications?: string;
  /** Assigned vehicle (ADR 0098): a fleet unit, not a classifier position. */
  vehicleId?: string;
  num?: number;
  /** Approval (ADR 0025): 'false' means requests awaiting approval. */
  approved?: string;
  /**
   * Feed document kind: weekly means weekly requests only. In the UI it is the third value of the
   * same select as the request type, but it goes to the query as its own parameter: requestType
   * also travels in the request body, where a third value does not exist at all.
   */
  kind?: FeedKind;
  /** Week of a weekly request; asked only when that kind is selected. */
  weekStart?: string;
}

/** Own list state and queries while commands continue to be composed by the route page. */
export function useVehicleRequestFeedState() {
  const { user, can } = useAuth();
  const navigate = useNavigate();
  // Customer filter defaults follow the shared rule of both axes (ADR 0201): the account's
  // predetermined customer, and nothing when it has two axes. Options are computed by
  // useRequestCustomerOptions.
  const customerDefaults = useRequestCustomerDefaults();
  // The list comes from the matrix and the account scope: a department with a site may order
  // special equipment too (ADR 0201).
  const requestTypeOptions = allowedVehicleRequestTypes(user).map((type) => ({
    value: type,
    label: vehicleRequestTypeLabels[type],
  }));

  // Document kind from the URL: the old "Weekly requests" tab moved here, and its bookmarks
  // (?tab=weekly) now lead to ?tab=requests&kind=weekly, i.e. this feed narrowed to weekly ones.
  // Read once, for the initial filter state: afterwards the select owns the kind, and the URL would
  // stop matching what is on screen.
  const [searchParams] = useSearchParams();
  const initialKind: FeedKind | undefined =
    searchParams.get('kind') === 'weekly' ? 'weekly' : undefined;
  // No requestType means both types; the header filter narrows to one. All filters live in the bar
  // above the table rather than column dropdowns: they are not visible in headers, and some values
  // (object, vehicle type) are directory lists.
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
  // The assigned-vehicle filter (ADR 0098) is the second equipment question next to the first:
  // "what was ordered" is asked by the classifier, "what closed it" by this one.
  const vehicleFilter = useVehicleFilter({ vehicleId: params.vehicleId, onChange: applyFilter });
  /*
   * Customer in the feed filter (R9) uses the module-wide filter: the same picker as the form, with
   * the same groups (the requester's own axis, both for the office and read-only roles). The filter
   * has no saved value: it asks the directory, not a record. Defaults (own object, own department)
   * remain list parameters above.
   */
  const customerFilter = useRequestCustomerFilter({
    objectId: params.objectId,
    departmentId: params.departmentId,
    onChange: applyFilter,
  });

  // The section feed, not the order list: vehicle orders and weekly requests arrive in one query,
  // one page and one order (vehicleRequestsApi.feed). A separate endpoint rather than a list flag:
  // the order list also serves the archive and picking requests for a route, where a weekly
  // document (never put into a route) would be a row that cannot be chosen.
  const feedQuery = useQuery({
    queryKey: vehicleRequestKeys.feed(params),
    queryFn: () => vehicleRequestsApi.feed(params),
  });
  // Header summary: how many requests await processing and how many are in work. The key starts
  // with 'vehicle-requests', so the counters refresh with the same invalidations as the list.
  // Narrowing filters (customer, request type, vehicle type and the vehicle itself) apply to the
  // summary: the numbers are about the list the person sees. Status and number do not: they would
  // reduce the summary to itself.
  const summaryQuery = {
    objectId: params.objectId,
    // The department narrows the numbers too (R9a): otherwise the table narrows while the counters
    // above it stay global.
    departmentId: params.departmentId,
    requestType: params.requestType,
    classifications: params.classifications,
    vehicleId: params.vehicleId,
  };
  const summaryResult = useQuery({
    queryKey: vehicleRequestKeys.summary(summaryQuery),
    queryFn: () => vehicleRequestsApi.summary(summaryQuery),
  });

  /*
   * "Request type" with a third value, the document kind. In the UI it is one select: the person
   * asks "what to show", and "Weekly request" stands in one row with "On-site equipment" and
   * "Freight". The query gets either requestType or kind; they must not be mixed in one parameter,
   * because requestType also travels in the request body.
   */
  const documentTypeOptions = [
    ...requestTypeOptions,
    { value: 'weekly', label: feedKindLabels.weekly },
  ];
  const documentTypeValue = params.kind === 'weekly' ? 'weekly' : params.requestType;
  const applyDocumentType = (value: string | undefined) =>
    value === 'weekly'
      ? applyFilter({ kind: 'weekly', requestType: undefined })
      : // Leaving the weekly kind drops the week too: a filter that is not shown would keep
        // narrowing the result, and orders would come back not all, for no visible reason.
        applyFilter({ kind: undefined, weekStart: undefined, requestType: value });

  /**
   * Number search parses both prefixes: "НЗ-12" looks for a week, "ТС-341" and a bare number for an
   * order. Numbers are two independent sequences, so input answers with a PAIR "kind + number",
   * sent to the query as is: searching "12" in both would answer one question with two documents.
   *
   * Empty input drops only the number and keeps the chosen kind: clearing the search box means "not
   * looking for a specific document", not "show everything".
   */
  const applyNumberSearch = (value: string) => {
    const found = parseFeedNumberSearch(value);
    if (!found) return applyFilter({ num: undefined });
    return applyFilter({
      num: found.num,
      // An order number leaves the weekly kind: the number itself names what to show, and keeping
      // "Weekly request" would answer with an empty list.
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
    // The filter offers the same weeks as creation: past ones are found by number, since a list of
    // weeks growing every week would be unreadable by year end.
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
      // Creating a weekly request (docs/adr/0085-weekly-vehicle-request.md) uses its own right, not
      // the fact that weekly rows are shown: observers, departments and lessors now see the
      // document without creating it, and a button disabled for half the list would explain a
      // non-existent ban.
      canCreateWeekly: can('weeklyRequests.create'),
      // "Routes" is one of three doors to the route list (here, in the request card and in the
      // route card). It is in the toolbar because the day is assembled from here: requests are
      // confirmed in this list and laid out into routes in that one. The right is the one that
      // opens a route: the list shows foreign vehicles and own-fleet driver names.
      showRoutes: canOpenRoute(can),
    },
    // The only real navigation left: a weekly request has its own page with an address because its
    // composition is edited row by row, which does not fit a window. Routes and the route list open
    // as windows over this list instead (ADR 0120).
    openWeekly: (request: WeeklyVehicleRequestDto) => void navigate(weeklyRequestPath(request.id)),
  };
}
