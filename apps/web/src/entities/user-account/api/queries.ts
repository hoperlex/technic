import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { userAccountKeys } from './keys';
import { usersApi } from './usersApi';

export const userOptionsQuery = () =>
  queryOptions({
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
    queryKey: userAccountKeys.pendingCount(),
    queryFn: () => usersApi.pendingCount(),
  });

export const departmentHeadCandidatesQuery = (role: string) =>
  queryOptions({
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
