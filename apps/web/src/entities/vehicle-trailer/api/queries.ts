import { QUERY_PROFILE, queryProfileOptions } from '@shared/config';
import { queryOptions } from '@tanstack/react-query';
import { trailerKeys } from './keys';
import { vehicleTrailersApi } from './vehicleTrailersApi';

export const trailerListQuery = (params: Parameters<typeof vehicleTrailersApi.list>[0]) =>
  queryOptions({
    ...(Object.keys(params).length === Object.keys(PICKER_PARAMS).length &&
    params.page === PICKER_PARAMS.page &&
    params.pageSize === PICKER_PARAMS.pageSize &&
    params.sortBy === PICKER_PARAMS.sortBy &&
    params.sortOrder === PICKER_PARAMS.sortOrder &&
    !params.status &&
    !params.hitchedVehicleId
      ? QUERY_PROFILE.DICTIONARY
      : {}),
    queryKey: trailerKeys.list(params),
    queryFn: () => vehicleTrailersApi.list(params),
  });

/**
 * The binding dialog and vehicle card ask the same question: which trailers occupy this vehicle's
 * slots. One key and one request keep their answers aligned. Without a vehicle there is no useful
 * question, so the query stays disabled. The API accepts only contract page sizes; the smallest
 * valid page (50) is enough for the two live slots and still exposes any legacy extra rows. The
 * display orders slots locally because the server orders by creation time.
 */
export const trailerSlotsQuery = (vehicleId: string | undefined) =>
  queryOptions({
    queryKey: trailerKeys.slots(vehicleId),
    queryFn: () => vehicleTrailersApi.list({ page: 1, pageSize: 50, hitchedVehicleId: vehicleId }),
    enabled: !!vehicleId,
  });

/**
 * The picker needs the whole live trailer register ordered by registration number. The server
 * accepts only exact status equality, while the picker needs every status except retired; one
 * page with local filtering avoids separate requests. Deleted rows are absent unless explicitly
 * requested by `includeDeleted`, which this key never does.
 */
const PICKER_PARAMS = {
  page: 1,
  pageSize: 200,
  sortBy: 'registrationNumber',
  sortOrder: 'asc',
} as const;

/**
 * Route forms share one cached, registration-ordered trailer page. The server only supports an
 * exact status filter, so this observer removes retired and deleted units locally while historical
 * trailer slots keep their saved snapshot (R11). The picker is enabled by its caller when needed.
 */
export const trailerPickerQuery = () => {
  const base = trailerListQuery(PICKER_PARAMS);
  return {
    queryKey: base.queryKey,
    queryFn: base.queryFn,
    ...queryProfileOptions(base),
    select: (page: Awaited<ReturnType<typeof vehicleTrailersApi.list>>) =>
      page.items.filter((t) => t.status !== 'retired' && !t.deletedAt),
  };
};
