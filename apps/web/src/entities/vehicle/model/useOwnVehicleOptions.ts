import { useQuery } from '@tanstack/react-query';
import { vehicleOptionLabel } from '@technic/contracts';
import { vehicleKeys } from '../api/keys';
import { vehiclesApi } from '../api/vehiclesApi';

/**
 * The complete company-owned fleet for route and waybill history filters.
 *
 * Archived and maintenance vehicles stay visible because historical routes and issued forms do
 * not disappear with the current fleet status. Rental vehicles are excluded: their lessor owns
 * route and waybill operations. The shared query key keeps both consumers on the same cache cell.
 */
export function useOwnVehicleOptions() {
  const { data, isFetching } = useQuery({
    queryKey: vehicleKeys.ownOptions(),
    queryFn: () =>
      vehiclesApi.list({ page: 1, pageSize: 500, ownership: 'own', sortBy: 'createdAt' }),
  });

  return {
    options: (data?.items ?? [])
      .map((vehicle) => ({
        value: vehicle.id,
        label: vehicleOptionLabel(vehicle),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    loading: isFetching,
  };
}
