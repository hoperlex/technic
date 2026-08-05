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
 * Объекты для выбора адреса (ADR 0069). Запрос тот же, что и у выпадающего списка объектов, — тот
 * же ключ, та же выборка, — и различается только сборка: здесь площадка называет себя адресом,
 * потому что ею отвечают на вопрос «куда ехать». Второго обращения к серверу это не стоит: кэш у
 * запроса общий, а `select` работает у каждого потребителя свой.
 *
 * Площадки без адреса отбрасываются: адрес объекта необязателен, а пустая строка в списке мест
 * ничего не называет и на запись всё равно не пройдёт.
 */
export const objectAddressOptionsQuery = () =>
  queryOptions({
    ...objectOptionsQuery({ activeOnly: true }),
    select: (r) =>
      r.items
        .filter((o) => !!o.address.trim())
        .map((o) => ({
          value: o.id,
          address: o.address,
          label: `${o.code} — ${o.name} — ${o.address}`,
        })),
  });
