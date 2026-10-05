import { useQuery } from '@tanstack/react-query';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverDocumentGapsHint,
  driverWorkedOnVehicle,
} from '@technic/contracts';
import { driverKeys, driversApi } from '@entities/driver';

/**
 * Who may drive the route's vehicle on the edited day. The list advises (fit drivers first, marked
 * by category and documents, ADR 0064) but chooses nobody itself: the dispatcher puts a person
 * behind the wheel.
 */
export function useRouteEditDrivers({
  vehicleId,
  on,
  withTrailer,
}: {
  /** undefined while the window is closed; the query stays disabled then. */
  vehicleId: string | undefined;
  on: string | undefined;
  withTrailer: boolean;
}) {
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: driverKeys.available({ vehicleId, on, withTrailer }),
    queryFn: () => driversApi.available({ vehicleId: vehicleId!, on: on!, withTrailer }),
    enabled: !!vehicleId && !!on,
  });

  const driverOptions = (selection?.drivers ?? []).map((d) => ({
    value: d.personId,
    label: [
      d.fullName,
      d.categories.join(', '),
      // The document is named by the person's position (ADR 0095): "no licence number" for an
      // excavator operator would send them looking for the wrong paper.
      driverDocumentGapsHint(d.gaps, d.credentialTypeCode),
      d.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(d) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
  return { driverOptions, driversLoading };
}
