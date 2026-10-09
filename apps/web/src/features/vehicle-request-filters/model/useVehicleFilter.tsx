import { Select } from 'antd';
import { useState } from 'react';
import { vehicleOptionLabel } from '@technic/contracts';
import { allVehicleOptionsQuery } from '@entities/vehicle';
import type { FilterDefinition } from '@shared/ui';
import { useDeferredOptions } from '@shared/lib';

/**
 * Filter by the assigned vehicle for the request list and the closed-requests journal (ADR 0098).
 *
 * It asks for a fleet unit, not a classifier position: "where is my KamAZ now" and "which requests
 * did it close" are questions about a concrete machine, and the neighbouring type filter does not
 * answer them. The classifier keeps its own filter (useVehicleClassificationFilter): it answers
 * "what kind of equipment was ordered", and a type is ordered, not a machine.
 *
 * The list holds both own and rented vehicles: a request is closed by either (rent is taken exactly
 * when own vehicles ran short), and both are searched by the same field. Written-off and repaired
 * vehicles are not removed, as in the route filter: yesterday's requests did not go anywhere.
 *
 * A request without an assigned vehicle never matches: it has no vehicle yet rather than a "lost
 * row", since a "New" request answers "what was ordered" and holds no vehicle by nature.
 */
export function useVehicleFilter({
  vehicleId,
  onChange,
}: {
  vehicleId: string | undefined;
  onChange: (patch: { vehicleId?: string }) => void;
}) {
  const [opened, setOpened] = useState(!!vehicleId);
  const { options: loadedOptions, loading } = useDeferredOptions(
    allVehicleOptionsQuery(),
    opened || !!vehicleId,
    (data) =>
      data.items.map((vehicle) => ({ value: vehicle.id, label: vehicleOptionLabel(vehicle) })),
  );
  // Sorted by label rather than directory order: people look a vehicle up by its plate number.
  const options = (loadedOptions ?? []).sort((left, right) =>
    left.label.localeCompare(right.label, 'ru'),
  );

  const controls = (
    <Select
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder="Вся техника"
      style={{ width: 240 }}
      options={options}
      loading={loading}
      onOpenChange={(open) => open && setOpened(true)}
      value={vehicleId}
      onChange={(value: string | undefined) => onChange({ vehicleId: value })}
    />
  );
  // The same filter as a description for the phone filter sheet (ADR 0030).
  const mobileFilter: FilterDefinition = {
    kind: 'select',
    key: 'vehicleId',
    label: 'Техника',
    value: vehicleId,
    options,
    placeholder: 'Вся техника',
    loading,
    onOpen: () => setOpened(true),
    onChange: (value) => onChange({ vehicleId: value }),
  };

  return { controls, mobileFilter };
}
