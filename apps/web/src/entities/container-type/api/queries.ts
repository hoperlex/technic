import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE, QUERY_PROFILE } from '@shared/config';
import { containerTypesApi } from './containerTypesApi';
import { containerTypeKeys } from './keys';

/**
 * Container and vehicle types fit in one response. The request editor and list filter need different
 * subsets, so one cached page is cheaper than separate server reads. The directory's sort order is
 * intentional, and consumers need complete records for equipment kind and volume-based prices.
 */
export const containerTypeOptionsQuery = ({ activeOnly = true }: { activeOnly?: boolean } = {}) =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: containerTypeKeys.options({ activeOnly }),
    queryFn: () =>
      containerTypesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
        ...(activeOnly ? { isActive: 'true' } : {}),
      }),
  });
