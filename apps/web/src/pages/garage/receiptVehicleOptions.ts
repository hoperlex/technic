import { useQuery } from '@tanstack/react-query';
import { vehicleOptionLabel } from '@technic/contracts';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';

export const WAREHOUSE_DESTINATION_VALUE = '__warehouse__';
export const UNASSIGNED_DESTINATION_VALUE = '__unassigned__';

/** One owned-vehicle option source for receipt rows, bulk assignment, and stock applications. */
export function useReceiptVehicleOptions(): {
  options: { value: string; label: string }[];
  loading: boolean;
} {
  const { data, isFetching } = useQuery({
    queryKey: vehicleKeys.ownOptions(),
    queryFn: () =>
      vehiclesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        ownership: 'own',
        sortBy: 'createdAt',
      }),
  });
  const options = (data?.items ?? [])
    .map((vehicle) => ({ value: vehicle.id, label: vehicleOptionLabel(vehicle) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  return { options, loading: isFetching };
}
