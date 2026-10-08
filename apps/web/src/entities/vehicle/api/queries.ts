import { QUERY_PROFILE } from '@shared/config';
import { queryOptions } from '@tanstack/react-query';
import { vehiclesApi, vehicleModelsApi } from './vehiclesApi';
import { vehicleKeys, vehicleModelKeys } from './keys';

/** The same fleet response serves every selector with this key. */
export const allVehicleOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleKeys.allOptions(),
    queryFn: () => vehiclesApi.list({ page: 1, pageSize: 500, sortBy: 'createdAt' }),
  });

export const ownVehicleOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleKeys.ownOptions(),
    queryFn: () =>
      vehiclesApi.list({ page: 1, pageSize: 500, ownership: 'own', sortBy: 'createdAt' }),
  });

export const ownActiveVehicleOptionsQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleKeys.ownActiveOptions(),
    queryFn: () =>
      vehiclesApi.list({
        page: 1,
        pageSize: 500,
        ownership: 'own',
        status: 'active',
        sortBy: 'registrationNumber',
        sortOrder: 'asc',
      }),
  });

export const ownVehicleCorrectionQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleKeys.ownForCorrection(),
    queryFn: () =>
      vehiclesApi.list({
        page: 1,
        pageSize: 500,
        ownership: 'own',
        sortBy: 'registrationNumber',
        sortOrder: 'asc',
      }),
  });

export const fuelNormVehiclePickerQuery = () =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleKeys.fuelNormPicker(),
    queryFn: () => vehiclesApi.list({ page: 1, pageSize: 500, status: 'active' }),
  });

export const vehicleModelsForSelectQuery = (vehicleTypeId: string | undefined) =>
  queryOptions({
    ...QUERY_PROFILE.DICTIONARY,
    queryKey: vehicleModelKeys.forSelect(vehicleTypeId),
    queryFn: () =>
      vehicleModelsApi.list({
        page: 1,
        pageSize: 500,
        vehicleTypeId,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: !!vehicleTypeId,
  });
