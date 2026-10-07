import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { objectsApi } from './objectsApi';
import { objectKeys } from './keys';

/**
 * Объекты для выпадающих списков. Справочник небольшой и запрашивается целиком: сотня площадок
 * приходит одним ответом, а поиск по ним идёт на клиенте — так список открывается без ожидания.
 *
 * `activeOnly` — не украшение: закрытые площадки не предлагают в новых заявках, но показывают там,
 * где на них уже ссылаются.
 */
export const objectOptionsQuery = ({ activeOnly = true }: { activeOnly?: boolean } = {}) =>
  queryOptions({
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
    queryFn: base.queryFn,
    select: (r: Awaited<ReturnType<typeof objectsApi.list>>) => r,
  };
};
