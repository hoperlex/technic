import { queryOptions } from '@tanstack/react-query';
import type { CounterpartyDto } from '@technic/contracts';
import { apiFetch, type ListResult } from '@shared/api';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { serviceCompanyKeys } from './keys';

/**
 * Сервисные компании для выбора исполнителя (Р1: контрагент типа `service`).
 *
 * Запрос описан здесь, а не на экранах: его спрашивают дважды — фильтр списка «сервис» и окно
 * назначения. Разойдись у них `pageSize` или сортировка, один и тот же ключ отдавал бы двум
 * местам разные перечни.
 *
 * Только действующие: назначить заявку приостановленному контрагенту нельзя (сервер откажет), а
 * у уже назначенных наименование приходит снимком в самой заявке.
 *
 * Ходит прямым `apiFetch`, а не общим объектом API контрагентов: слайса контрагентов в портале
 * ещё нет, а `api/resources.ts` слою сущностей запрещён разметкой границ. Появится слайс —
 * перечень переедет туда вместе с ключом.
 */
export const serviceCompanyOptionsQuery = () =>
  queryOptions({
    queryKey: serviceCompanyKeys.options(),
    queryFn: () =>
      apiFetch<ListResult<CounterpartyDto>>('/counterparties', {
        query: {
          page: 1,
          pageSize: DICTIONARY_PAGE_SIZE,
          type: 'service',
          isActive: 'true',
          sortBy: 'name',
          sortOrder: 'asc',
        },
      }),
    select: (r) => r.items.map((c) => ({ value: c.id, label: c.name })),
  });
