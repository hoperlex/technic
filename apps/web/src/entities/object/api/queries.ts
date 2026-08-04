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
