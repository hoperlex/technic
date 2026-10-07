import { ownVehicleOptionsQuery } from '../api/queries';
import { useQuery } from '@tanstack/react-query';
import { vehicleOptionLabel } from '@technic/contracts';

/**
 * The complete company-owned fleet for route and waybill history filters.
 *
 * Archived and maintenance vehicles stay visible because historical routes and issued forms do
 * not disappear with the current fleet status. Rental vehicles are excluded: their lessor owns
 * route and waybill operations. The shared query key keeps both consumers on the same cache cell.
 */
export function useOwnVehicleOptions() {
  const { data, isFetching } = useQuery({
    ...ownVehicleOptionsQuery(),
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
