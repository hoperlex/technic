import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
  vehicleLabel,
  type VehicleDto,
  type VehicleRouteDto,
  vehicleStatusLabels,
} from '@technic/contracts';
import { driverKeys, driversApi } from '@entities/driver';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';
import { vehicleRouteKeys, vehicleRoutesApi } from '@entities/vehicle-route';

/**
 * What fills the choice fields of the route correction window (ADR 0101): vehicle, driver,
 * trailers.
 *
 * Extracted from the window itself (`VehicleRouteCorrectionModal.tsx`) along a subject boundary,
 * the same cut as the neighbouring list of consequences: the window holds the form (fields, rules,
 * submission), while this holds three queries with their own selection rules that have nothing to
 * do with input. The quality ratchet (`scripts/quality.mjs`) counts the window's lines, and the
 * lists were pushing it up without adding anything to the form.
 *
 * THE MAIN INVARIANT OF THIS MODULE: **the selection here is historical, not current**. A past day
 * is being corrected, and the lists must show what was used and who worked THEN: a vehicle
 * decommissioned since (R17) and a driver who left after the route (ADR 0101 item 15). Reduce
 * either list to the usual "what is available now" and a route from last week can no longer be
 * issued to anyone or on anything.
 *
 * Consequences and blockers deliberately did not move here: the server computes them
 * (correctionPreview), and the window itself holds them, because they decide whether it lets the
 * press through. All queries of the window and of this module use key families from
 * entities/<entity>/api/keys (vehicleRouteKeys, waybillKeys, driverKeys, vehicleKeys), so splitting
 * them across files adds no raw-key debt (rawKeyFiles in
 * apps/web/scripts/quality.mjs counts files with literal keys).
 */

interface Args {
  route: VehicleRouteDto | null;
  /** The vehicle currently in the field: both trailers and the driver list depend on it. */
  vehicleId: string | undefined;
  withTrailer: boolean;
}

export function useRouteCorrectionChoices({ route, vehicleId, withTrailer }: Args) {
  /**
   * The whole fleet, including decommissioned and under-repair vehicles (R17): a vehicle has no
   * status history, and a backdated correction often concerns exactly the unit decommissioned
   * since. The status is named in the option label: the person must see "a vehicle that is out of
   * service today went on this route".
   */
  const { data: fleet, isFetching: fleetLoading } = useQuery({
    queryKey: vehicleKeys.ownForCorrection(),
    queryFn: () =>
      vehiclesApi.list({
        ownership: 'own',
        page: 1,
        pageSize: 500,
        sortBy: 'registrationNumber',
        sortOrder: 'asc',
      }),
    enabled: !!route,
  });

  const vehicleOptions = useMemo(
    () =>
      (fleet?.items ?? []).map((v: VehicleDto) => ({
        value: v.id,
        label: [
          vehicleLabel(v),
          v.modelName,
          v.status === 'active' ? null : vehicleStatusLabels[v.status].toLowerCase(),
        ]
          .filter((s): s is string => !!s)
          .join(' · '),
      })),
    [fleet],
  );

  /**
   * Trailers bound to the **selected** vehicle (trailers plan section 4.2.2): the vehicle is what
   * gets changed here, so we ask about the one in the field; the previous vehicle's binding would
   * describe a different route.
   */
  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(vehicleId, route?.routeDate),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: vehicleId!, date: route!.routeDate }),
    enabled: !!route && !!vehicleId,
  });

  /**
   * Who could drive this vehicle **on the route day**: the selection is historical (ADR 0101 item
   * 15), and a person dismissed after the route does not drop out of the list; otherwise a sheet
   * for last week could not be issued to the person who actually worked it.
   */
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: driverKeys.available({ vehicleId, on: route?.routeDate, withTrailer }),
    queryFn: () =>
      driversApi.available({ vehicleId: vehicleId!, on: route!.routeDate, withTrailer }),
    enabled: !!route && !!vehicleId,
  });

  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      driverDocumentGapsHint(d.gaps, d.credentialTypeCode),
      d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  return {
    vehicleOptions,
    fleetLoading,
    driverOptions,
    driversLoading,
    suggestion,
    /** Type of the selected vehicle: the trailer field uses it to decide what can be hitched. */
    vehicleTypeId: fleet?.items.find((v) => v.id === vehicleId)?.vehicleTypeId,
  };
}
