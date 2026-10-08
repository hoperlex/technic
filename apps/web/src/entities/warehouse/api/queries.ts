import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE, QUERY_PROFILE } from '@shared/config';
import { warehousesApi } from './warehousesApi';
import { warehouseKeys } from './keys';

/**
 * Warehouse addresses fit in one locally searched page. A warehouse of an inactive supplier cannot
 * be selected even if the warehouse itself is active: the server rejects that destination. When a
 * warehouse has no name, the supplier name keeps its address option identifiable.
 */
export const warehouseOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: warehouseKeys.options(),
    queryFn: () =>
      warehousesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        isActive: 'true',
        sortBy: 'address',
        sortOrder: 'asc',
      }),
    select: (r) =>
      r.items
        .filter((w) => w.supplier.isActive)
        .map((w) => ({
          value: w.id,
          address: w.address,
          label: `${w.name || w.supplier.name} — ${w.address}`,
        })),
  });
