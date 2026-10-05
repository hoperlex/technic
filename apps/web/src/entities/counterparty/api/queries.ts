import { queryOptions } from '@tanstack/react-query';
import { counterpartiesApi } from './counterpartiesApi';
import { counterpartyKeys } from './keys';

/**
 * All waste operators for the tariff matrix and editor. Inactive operators stay visible because
 * their historical prices remain editable; the pricing resolver excludes them independently.
 */
export const counterpartyOperatorGridQuery = () =>
  queryOptions({
    queryKey: counterpartyKeys.operatorGridOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 200,
        sortBy: 'name',
        sortOrder: 'asc',
        type: 'operator',
      }),
  });
