import type { ReactNode } from 'react';
import { Select } from 'antd';
import {
  actsForCounterparty,
  VEHICLE_OWNERSHIPS,
  vehicleOwnershipLabels,
  type VehicleOwnership,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import type { FilterDefinition } from '@shared/ui';

const ownershipOptions = VEHICLE_OWNERSHIPS.map((ownership) => ({
  value: ownership,
  label: vehicleOwnershipLabels[ownership],
}));

/**
 * Filter by the ownership of the vehicle on the request: own fleet or rental. One hook for the four
 * tabs of the section (requests, history, on-site, archive), so the rules below cannot diverge.
 *
 * It asks about the vehicle, not about the request: the request holds whatever vehicle the server
 * reads for the tab (the assigned one, or today's vehicle on "On site"), and a request without a
 * vehicle matches neither value. The empty value is the filter being off ("own and rental"), not a
 * third option.
 *
 * A lessor account gets nothing back: every row it sees is rental by visibility (ADR 0038), so
 * "Собственная" would always be empty. The same reason hides its "rented from whom" select. The
 * mobile definitions come as an array for that case: callers spread it instead of branching.
 */
export function useOwnershipFilter({
  ownership,
  onChange,
}: {
  ownership: VehicleOwnership | undefined;
  onChange: (patch: { ownership?: VehicleOwnership }) => void;
}): { controls: ReactNode; mobileFilters: FilterDefinition[] } {
  const { user } = useAuth();
  if (actsForCounterparty(user, 'vehicle_lessor')) return { controls: null, mobileFilters: [] };

  const controls = (
    <Select
      allowClear
      placeholder="Своя и аренда"
      style={{ width: 160 }}
      options={ownershipOptions}
      value={ownership}
      onChange={(value: VehicleOwnership | undefined) => onChange({ ownership: value })}
    />
  );
  // The same filter as a description for the phone filter sheet (ADR 0030).
  const mobileFilter: FilterDefinition = {
    kind: 'select',
    key: 'ownership',
    label: 'Принадлежность',
    value: ownership,
    options: ownershipOptions,
    placeholder: 'Своя и аренда',
    onChange: (value) => onChange({ ownership: value as VehicleOwnership | undefined }),
  };

  return { controls, mobileFilters: [mobileFilter] };
}
