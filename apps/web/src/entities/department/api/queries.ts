import { queryOptions } from '@tanstack/react-query';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { departmentsApi } from './departmentsApi';
import { departmentKeys } from './keys';

/**
 * Отделы для выпадающих списков. Справочник маленький и запрашивается целиком: подразделения
 * приходят одним ответом, а поиск по ним идёт на клиенте — поле открывается без запроса на каждую
 * букву.
 *
 * Запрос описан здесь, а не на экранах, потому что спрашивают его в двух местах — в форме заявки
 * на технику и в карточке учётки. Разойдись у них `pageSize` или сортировка, один и тот же ключ
 * стал бы отдавать двум экранам разные списки.
 */
export const departmentOptionsQuery = () =>
  queryOptions({
    queryKey: departmentKeys.options(),
    queryFn: () =>
      departmentsApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    select: (r) => r.items.map((d) => ({ value: d.id, label: `${d.code} — ${d.name}` })),
  });
