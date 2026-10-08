import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE, QUERY_PROFILE, queryProfileOptions } from '@shared/config';
import { objectsApi } from './objectsApi';
import { objectKeys } from './keys';

/**
 * Sites fit in one response and are searched locally, so a picker opens without a request per
 * keystroke. New requests offer only active sites, while historical references need the inactive
 * variant under its own key.
 */
export const objectOptionsQuery = ({ activeOnly = true }: { activeOnly?: boolean } = {}) =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: objectKeys.options({ activeOnly }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'name',
        sortOrder: 'asc',
        ...(activeOnly ? { isActive: 'true' } : {}),
      }),
    select: (r) => r.items.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` })),
  });

/**
 * Address selection (ADR 0069) uses the same cached active-site response as the ordinary picker.
 * Its observer includes the address in each label and omits sites with no address, since an empty
 * address cannot answer where a vehicle should go.
 */
export const objectAddressOptionsQuery = () => {
  const base = objectOptionsQuery({ activeOnly: true });
  return {
    queryKey: base.queryKey,
    ...queryProfileOptions(base),
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof objectsApi.list>>) =>
      r.items
        .filter((o) => !!o.address.trim())
        .map((o) => ({
          value: o.id,
          address: o.address,
          label: `${o.code} — ${o.name} — ${o.address}`,
        })),
  };
};

/** Raw records serve filters that need fields beyond the standard option label. */
export const objectRecordsQuery = (activeOnly: boolean) => {
  const base = objectOptionsQuery({ activeOnly });
  return {
    queryKey: base.queryKey,
    ...queryProfileOptions(base),
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof objectsApi.list>>) => r,
  };
};
