import { queryOptions } from '@tanstack/react-query';
import { counterpartiesApi } from './counterpartiesApi';
import { counterpartyKeys } from './keys';

/**
 * All waste operators for the tariff matrix and editor. Inactive operators stay visible because
 * their historical prices remain editable; the pricing resolver excludes them independently.
 */
export const counterpartyOperatorGridQuery = () =>
  queryOptions({
    queryKey: counterpartyKeys.operatorOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        sortBy: 'name',
        sortOrder: 'asc',
        type: 'operator',
      }),
  });

/**
 * Active vehicle lessors for the fleet filter and the vehicle form. One carrier for the key and its
 * request: two components asking the same key with different requests would silently share
 * whichever answer arrived first.
 */
export const counterpartyActiveVehicleLessorsQuery = () =>
  queryOptions({
    queryKey: counterpartyKeys.activeVehicleLessorOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'vehicle_lessor',
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });

/** An inactive service company cannot be assigned a new request. */
export const serviceCompanyOptionsQuery = () =>
  queryOptions({
    queryKey: counterpartyKeys.serviceOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'service',
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    select: (r) => r.items.map((c) => ({ value: c.id, label: c.name })),
  });

/**
 * A mechanization lessor must have its own type. A company that also leases vehicles needs a
 * second counterparty record because the server assigns one type per record.
 */
export const mechLessorOptionsQuery = () =>
  queryOptions({
    queryKey: counterpartyKeys.mechLessorOptions(),
    queryFn: () =>
      counterpartiesApi
        .list({
          page: 1,
          pageSize: 500,
          type: 'mech_lessor',
          isActive: 'true',
          sortBy: 'name',
          sortOrder: 'asc',
        })
        .then((r) => r.items),
    select: (items) =>
      items
        .map((c) => ({ value: c.id, label: c.name, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  });
