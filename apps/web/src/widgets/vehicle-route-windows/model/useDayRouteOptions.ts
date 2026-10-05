import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  assignmentTitle,
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  type SpecialEquipmentRequestDto,
  type VehicleDto,
  vehicleLabel,
} from '@technic/contracts';
import { driverKeys, driversApi } from '@entities/driver';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';

/**
 * Own fleet vehicles only: only they run routes, a rented vehicle's waybill is issued by the
 * lessor. The whole fleet, not units of the ordered type: a day vehicle differing from the
 * assignment is legitimate and marked rather than forbidden (ADR 0100 decision 4), which is what
 * the flag exists for.
 */
export function useDayRouteFleet({
  enabled,
  assignment,
}: {
  enabled: boolean;
  assignment: SpecialEquipmentRequestDto['assignment'];
}) {
  const { data: fleet, isFetching: fleetLoading } = useQuery({
    queryKey: vehicleKeys.ownActiveOptions(),
    queryFn: () =>
      vehiclesApi.list({
        status: 'active',
        ownership: 'own',
        page: 1,
        pageSize: 500,
        sortBy: 'registrationNumber',
        sortOrder: 'asc',
      }),
    enabled,
  });

  const vehicleOptions = useMemo(() => {
    const options = (fleet?.items ?? [])
      .map((v: VehicleDto) => ({
        value: v.id,
        label: [vehicleLabel(v), v.modelName, v.categoryName ?? v.typeName]
          .filter((s): s is string => !!s)
          .filter((s, i, all) => all.indexOf(s) === i)
          .join(' · '),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    // The assigned vehicle may have left the active fleet (broken, sold) while the day was still
    // worked with it. Without this row the field would show a bare id.
    if (assignment && !options.some((o) => o.value === assignment.vehicleId))
      options.unshift({ value: assignment.vehicleId, label: assignmentTitle(assignment) });
    return options;
  }, [fleet, assignment]);

  return { fleet, fleetLoading, vehicleOptions };
}

/**
 * Drivers for this day, by the same selection as when taking a request into work (ADR 0064): a
 * vehicle's day is printed on a regular 4-P, which has licence and SNILS columns. The selection
 * removes nobody: document gaps mark the row and are explained under the field.
 */
export function useDayRouteDrivers({
  vehicleId,
  date,
  withTrailer,
  enabled,
}: {
  vehicleId: string | undefined;
  date: string;
  withTrailer: boolean;
  enabled: boolean;
}) {
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: driverKeys.available({ vehicleId, on: date, withTrailer }),
    queryFn: () => driversApi.available({ vehicleId: vehicleId!, on: date, withTrailer }),
    enabled,
  });
  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      d.personnelNo && `таб. ${d.personnelNo}`,
      driverDocumentGapsHint(d.gaps, d.credentialTypeCode),
      d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  return { driverOptions, driversLoading };
}
