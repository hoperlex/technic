import { useQuery } from '@tanstack/react-query';
import { vehicleOptionLabel } from '@technic/contracts';
import { ownVehicleOptionsQuery } from '@entities/vehicle';

export const WAREHOUSE_DESTINATION_VALUE = '__warehouse__';
export const UNASSIGNED_DESTINATION_VALUE = '__unassigned__';

/** One owned-vehicle option source for receipt rows, bulk assignment, and stock applications. */
export function useReceiptVehicleOptions(): {
  options: { value: string; label: string }[];
  loading: boolean;
} {
  const { data, isFetching } = useQuery({
    ...ownVehicleOptionsQuery(),
  });
  const options = (data?.items ?? [])
    .map((vehicle) => ({ value: vehicle.id, label: vehicleOptionLabel(vehicle) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  return { options, loading: isFetching };
}
