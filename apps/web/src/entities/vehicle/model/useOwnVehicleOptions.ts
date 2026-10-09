import { ownVehicleOptionsQuery } from '../api/queries';
import { vehicleOptionLabel } from '@technic/contracts';
import { useDeferredOptions } from '@shared/lib';

/**
 * The complete company-owned fleet for route and waybill history filters.
 *
 * Archived and maintenance vehicles stay visible because historical routes and issued forms do
 * not disappear with the current fleet status. Rental vehicles are excluded: their lessor owns
 * route and waybill operations. The shared query key keeps both consumers on the same cache cell.
 */
export function useOwnVehicleOptions(enabled = true) {
  const { options, loading } = useDeferredOptions(ownVehicleOptionsQuery(), enabled, (data) =>
    data.items
      .map((vehicle) => ({ value: vehicle.id, label: vehicleOptionLabel(vehicle) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
  );

  return {
    options: options ?? [],
    loading,
  };
}
