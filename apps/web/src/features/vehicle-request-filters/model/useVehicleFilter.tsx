import { Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { vehicleOptionLabel } from '@technic/contracts';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';
import type { FilterDefinition } from '@shared/ui';

/** Select a concrete assigned vehicle independently from the requested classification. */
export function useVehicleFilter({
  vehicleId,
  onChange,
}: {
  vehicleId: string | undefined;
  onChange: (patch: { vehicleId?: string }) => void;
}) {
  const { data, isFetching } = useQuery({
    queryKey: vehicleKeys.allOptions(),
    queryFn: () => vehiclesApi.list({ page: 1, pageSize: 500, sortBy: 'createdAt' }),
  });
  const options = (data?.items ?? [])
    .map((vehicle) => ({ value: vehicle.id, label: vehicleOptionLabel(vehicle) }))
    .sort((left, right) => left.label.localeCompare(right.label, 'ru'));

  const controls = (
    <Select
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder="Вся техника"
      style={{ width: 240 }}
      options={options}
      loading={isFetching}
      value={vehicleId}
      onChange={(value: string | undefined) => onChange({ vehicleId: value })}
    />
  );
  const mobileFilter: FilterDefinition = {
    kind: 'select',
    key: 'vehicleId',
    label: 'Техника',
    value: vehicleId,
    options,
    placeholder: 'Вся техника',
    loading: isFetching,
    onChange: (value) => onChange({ vehicleId: value }),
  };

  return { controls, mobileFilter };
}
