import { QUERY_PROFILE } from '@shared/config';
import { queryOptions } from '@tanstack/react-query';
import { counterpartiesApi } from './counterpartiesApi';
import { counterpartyKeys } from './keys';

/**
 * All waste operators for the tariff matrix and editor. Inactive operators stay visible because
 * their historical prices remain editable; the pricing resolver excludes them independently.
 */
export const counterpartyOperatorGridQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
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

export const counterpartyOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: counterpartyKeys.options(),
    queryFn: () =>
      counterpartiesApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });

export const counterpartyActiveOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: counterpartyKeys.activeOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });

export const counterpartyActiveOperatorOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: counterpartyKeys.activeOperatorOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'operator',
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });

export const counterpartySupplierOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: counterpartyKeys.supplierOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'supplier',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });

export const counterpartyVehicleLessorOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: counterpartyKeys.vehicleLessorOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'vehicle_lessor',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });

/**
 * Active vehicle lessors for the fleet filter and the vehicle form. One carrier for the key and its
 * request: two components asking the same key with different requests would silently share
 * whichever answer arrived first.
 */
export const counterpartyActiveVehicleLessorsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
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
    ...QUERY_PROFILE.DICTIONARY,
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
    ...QUERY_PROFILE.DICTIONARY,
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
