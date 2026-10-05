import { useQuery } from '@tanstack/react-query';
import { counterpartyActiveVehicleLessorsQuery } from '@entities/counterparty';
import {
  rentalVehicleStatusOptions,
  vehicleKeys,
  vehiclesApi,
  vehicleStatusOptions,
} from '@entities/vehicle';
import { vehicleTypeKeys, vehicleTypesApi } from '@entities/vehicle-type';
import { useListParams } from '@shared/lib';
import { useVehicleFilters, type VehicleFilterParams } from './VehicleFilters';

/** Own the vehicle list, its lookup reads and URL-backed filters. */
export function useVehicleRegistry() {
  const { params, setParams, setSort, onTableChange } = useListParams<VehicleFilterParams>(
    {},
    { searchKeys: [] },
  );
  const ownershipFilter = params.ownership;

  const { data, isFetching } = useQuery({
    queryKey: vehicleKeys.list(params),
    queryFn: () => vehiclesApi.list(params),
  });

  // Registry filtering is by the whole type: “all cranes”, not one classified category.
  const { data: typesData } = useQuery({
    queryKey: vehicleTypeKeys.forSelect(),
    queryFn: () =>
      vehicleTypesApi.list({ page: 1, pageSize: 500, sortBy: 'name', sortOrder: 'asc' }),
  });
  const typeOptions = (typesData?.items ?? [])
    .filter((type) => type.isActive)
    .map((type) => ({ value: type.id, label: type.name }));

  // Lessors are pure counterparty records; they have no portal accounts of their own.
  const { data: lessorsData, isLoading: lessorsLoading } = useQuery(
    counterpartyActiveVehicleLessorsQuery(),
  );
  const lessorOptions = (lessorsData?.items ?? []).map((lessor) => ({
    value: lessor.id,
    label: lessor.name,
  }));

  const { filters, mobileFilters } = useVehicleFilters({
    params,
    setParams,
    typeOptions,
    lessorOptions,
    lessorsLoading,
    statusOptions: vehicleStatusOptions,
    rentalStatusOptions: rentalVehicleStatusOptions,
  });

  return {
    data,
    isFetching,
    params,
    setParams,
    setSort,
    onTableChange,
    ownershipFilter,
    showOwnColumns: ownershipFilter !== 'rental',
    showRentalColumns: ownershipFilter !== 'own',
    filters,
    mobileFilters,
  };
}
