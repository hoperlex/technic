import { QUERY_PROFILE } from '@shared/config';
import { queryOptions } from '@tanstack/react-query';
import {
  vehicleClassificationsApi,
  vehicleKindsApi,
  vehicleSpecsApi,
  vehicleTypesApi,
} from './vehicleTypesApi';
import {
  vehicleClassificationKeys,
  vehicleKindKeys,
  vehicleSpecKeys,
  vehicleTypeKeys,
} from './keys';

export const vehicleTypesFullQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleTypeKeys.full(),
    queryFn: () =>
      vehicleTypesApi.list({ page: 1, pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });

export const vehicleKindsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleKindKeys.root,
    queryFn: () => vehicleKindsApi.list({ pageSize: 500, sortBy: 'sortOrder', sortOrder: 'asc' }),
  });

export const vehicleClassificationsForSelectQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleClassificationKeys.forSelect(),
    queryFn: () =>
      vehicleClassificationsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
  });

export const activeVehicleSpecsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleSpecKeys.active(),
    queryFn: () =>
      vehicleSpecsApi.list({
        isActive: 'true',
        pageSize: 500,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
  });
