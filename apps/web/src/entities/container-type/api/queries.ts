import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { containerTypesApi } from './containerTypesApi';
import { containerTypeKeys } from './keys';

/**
 * Типы контейнеров и машин для выпадающих списков и фильтров. Справочник маленький и приходит
 * целиком одним ответом: разложить его по видам («установка берёт контейнеры, фильтр списка —
 * ещё и самосвалы») дешевле на клиенте, чем вторым запросом за тем же самым.
 *
 * Порядок задаёт сам справочник (`sortOrder`), а не алфавит: в нём типы стоят так, как их привыкли
 * видеть в заявке.
 *
 * `select` тут нет намеренно: одному потребителю нужен вид техники (`type`), другому —
 * вместимость (`volumeM3`), из которой выводится цена за контейнер целиком. Готовые
 * `{ value, label }` пришлось бы разворачивать обратно в обоих местах.
 */
export const containerTypeOptionsQuery = ({ activeOnly = true }: { activeOnly?: boolean } = {}) =>
  queryOptions({
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
