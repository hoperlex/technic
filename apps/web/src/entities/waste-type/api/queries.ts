import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE, QUERY_PROFILE } from '@shared/config';
import { wasteTypesApi } from './wasteTypesApi';
import { wasteTypeKeys } from './keys';

/**
 * Waste types fit in one locally searched page. `pricedOnly` is required because request entry
 * needs active types with active prices, while the tariff editor needs all recorded types. A
 * default would silently choose the wrong variant for one of them. Consumers need full records for
 * activity markers and duplicate-name checks.
 */
export const wasteTypeOptionsQuery = ({ pricedOnly }: { pricedOnly: boolean }) =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: wasteTypeKeys.options({ pricedOnly }),
    queryFn: () =>
      wasteTypesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
        ...(pricedOnly ? { isActive: 'true', hasActiveTariff: 'true' } : {}),
      }),
  });
