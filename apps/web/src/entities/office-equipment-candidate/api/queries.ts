import { QUERY_PROFILE, queryProfileOptions } from '@shared/config';
import { queryOptions } from '@tanstack/react-query';
import { officeEquipmentCandidatesApi } from './officeEquipmentCandidatesApi';
import { officeEquipmentCandidateKeys } from './keys';

/**
 * The pending badge uses the list total from a one-row page, so it follows exactly the same
 * visibility rule as the review queue. Candidate decisions invalidate the list root and refresh
 * both views together; a separate count endpoint or key could leave the badge stale.
 */
const PENDING_COUNT_PARAMS = {
  page: 1,
  pageSize: 1,
  status: 'pending',
  sortBy: 'createdAt',
  sortOrder: 'asc',
} as const;

export const officeEquipmentCandidatePendingCountQuery = () => {
  const base = officeEquipmentCandidateListQuery(PENDING_COUNT_PARAMS);
  return {
    queryKey: base.queryKey,
    ...queryProfileOptions(base),
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof officeEquipmentCandidatesApi.list>>) => r.total,
  };
};

export const officeEquipmentCandidateListQuery = (
  params: Parameters<typeof officeEquipmentCandidatesApi.list>[0],
) =>
  queryOptions({
    ...(Object.keys(params).length === Object.keys(PENDING_COUNT_PARAMS).length &&
    params.page === PENDING_COUNT_PARAMS.page &&
    params.pageSize === PENDING_COUNT_PARAMS.pageSize &&
    params.status === PENDING_COUNT_PARAMS.status &&
    params.sortBy === PENDING_COUNT_PARAMS.sortBy &&
    params.sortOrder === PENDING_COUNT_PARAMS.sortOrder
      ? QUERY_PROFILE.SIGNAL
      : {}),
    queryKey: officeEquipmentCandidateKeys.list(params),
    queryFn: () => officeEquipmentCandidatesApi.list(params),
  });
