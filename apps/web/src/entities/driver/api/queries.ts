import { queryOptions } from '@tanstack/react-query';
import { driversApi } from './driversApi';
import { driverKeys, licenseCategoryKeys } from './keys';
import type { CredentialTypeCode } from '@technic/contracts';

/** The same 500-row directory serves filters and machinist pickers. */
export const driverOptionsQuery = () =>
  queryOptions({
    queryKey: driverKeys.options(),
    queryFn: () =>
      driversApi.list({ page: 1, pageSize: 500, sortBy: 'fullName', sortOrder: 'asc' }),
  });

export const driverJobTitlesQuery = () =>
  queryOptions({ queryKey: driverKeys.jobTitles(), queryFn: () => driversApi.jobTitles() });

export const licenseCategoriesQuery = (type: CredentialTypeCode) =>
  queryOptions({
    queryKey: licenseCategoryKeys.byType(type),
    queryFn: () => driversApi.licenseCategories(type),
  });
