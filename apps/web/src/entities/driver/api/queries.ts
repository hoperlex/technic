import { queryOptions } from '@tanstack/react-query';
import { driversApi } from './driversApi';
import { driverKeys } from './keys';

/** The same 500-row directory serves filters and machinist pickers. */
export const driverOptionsQuery = () =>
  queryOptions({
    queryKey: driverKeys.options(),
    queryFn: () =>
      driversApi.list({ page: 1, pageSize: 500, sortBy: 'fullName', sortOrder: 'asc' }),
  });
