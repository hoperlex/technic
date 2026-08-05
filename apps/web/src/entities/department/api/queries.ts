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

/**
 * Площадка отдела (ADR 0062) по его идентификатору. Запрос и ключ — те же, что у выпадающего
 * списка отделов, отличается только сборка: `id отдела → id объекта`.
 *
 * Нужен там, где заявку заводит отдел: объекта в такой заявке нет вовсе (ADR 0040), а предложить
 * адрес всё-таки есть чем — площадкой отдела, если она у него заведена. Без этой карты форма
 * знала бы только идентификатор отдела, из которого адрес не выводится.
 */
export const departmentPlatformQuery = () =>
  queryOptions({
    ...departmentOptionsQuery(),
    select: (r) =>
      new Map(r.items.filter((d) => d.object).map((d) => [d.id, d.object!.id] as const)),
  });
