import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE, QUERY_PROFILE } from '@shared/config';
import { userAccountKeys } from './keys';
import { usersApi } from './usersApi';

export const userOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: userAccountKeys.options(),
    queryFn: () =>
      usersApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'fullName',
        sortOrder: 'asc',
      }),
  });

export const pendingUsersCountQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.SIGNAL,
    queryKey: userAccountKeys.pendingCount(),
    queryFn: () => usersApi.pendingCount(),
  });

export const departmentHeadCandidatesQuery = (role: string) =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: userAccountKeys.departmentHeadCandidates(role),
    queryFn: () =>
      usersApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        role,
        sortBy: 'fullName',
        sortOrder: 'asc',
      }),
  });
