import { useMemo, useState } from 'react';
import { Form } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  type VehicleOwnership,
  type VehicleRequestDto,
  vehicleClassificationLabel,
} from '@technic/contracts';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';
import {
  ASSIGNMENT_LIST_PARAMS,
  assignmentFleetByOwnership,
  assignmentLessorOptions,
  assignmentSubstitutionWarning,
  assignmentVehicleOptions,
  assignmentVehicleValues,
  emptyAssignmentVehicleText,
  mergeAssignmentFleet,
  NEW_ROUTE,
  orderedVehiclePosition,
} from '@features/vehicle-assignment';
import type { VehicleAssignmentForm } from './types';

/**
 * The fleet side of the dialog: the whole active fleet and the step-by-step choice "own or rental"
 * -> "from whom" (rental only) -> the concrete unit. That is how people think about it; the reverse
 * order (every suitable vehicle at once) is unreadable on a real fleet: one type has dozens of
 * offers from different lessors, distinguishable only by the tail of the row.
 */
export function useAssignmentFleet(request: VehicleRequestDto | null, form: VehicleAssignmentForm) {
  const [ownership, setOwnership] = useState<VehicleOwnership>('own');
  // The whole active fleet, not the ordered kind (ADR 0064): classification no longer narrows the
  // list — neither by category (ADR 0045), nor type (ADR 0059), nor kind. Both ownership branches
  // are needed at once: the switch itself is labelled by their size ("Rental · 12").
  //
  // Two queries, not one: a list page is capped at 500 rows, and in a fleet that does not fit, the
  // ordered kind is exactly what would be cut. The first query takes the ordered kind whole — what
  // closes the request nine times out of ten; the second collects the rest, and its incompleteness
  // is named under the field (`hiddenVehicles`).
  const vehicleKindId = request?.vehicleKindId ?? null;
  // The ordered position is the left side of every comparison in this dialog.
  const ordered = useMemo(() => orderedVehiclePosition(request), [request]);
  const ofKind = useQuery({
    queryKey: vehicleKeys.forAssignment(vehicleKindId),
    queryFn: () => vehiclesApi.list({ ...ASSIGNMENT_LIST_PARAMS, vehicleKindId: vehicleKindId! }),
    enabled: !!vehicleKindId,
  });
  const wholeFleet = useQuery({
    queryKey: vehicleKeys.forAssignmentWholeFleet(),
    queryFn: () => vehiclesApi.list(ASSIGNMENT_LIST_PARAMS),
    enabled: !!request,
  });
  const isFetching = ofKind.isFetching || wholeFleet.isFetching;
  const vehicles = useMemo(
    () => mergeAssignmentFleet(ofKind.data?.items ?? [], wholeFleet.data?.items ?? []),
    [ofKind.data, wholeFleet.data],
  );
  const byOwnership = useMemo(() => assignmentFleetByOwnership(vehicles), [vehicles]);
  const lessorId = Form.useWatch('lessorId', form);
  const vehicleId = Form.useWatch('vehicleId', form);
  const pricePerHour = Form.useWatch('pricePerHour', form);
  const pricePerShift = Form.useWatch('pricePerShift', form);
  // Lessors are only those with vehicles in the fleet: an empty item is pointless to choose.
  const lessorOptions = useMemo(
    () => assignmentLessorOptions(byOwnership.rental),
    [byOwnership.rental],
  );
  /*
   * Vehicles in groups: ordered type -> larger -> other types of the kind -> smaller than ordered
   * -> another vehicle kind (ADR 0059, ADR 0064). The order is the answer to "what closes the
   * request": a match on top, close ones below, distant ones at the bottom. Alphabetical inside a
   * group: rows there are equivalent, and any other order would need explaining. No "show other
   * kinds" switch — row order is enough, and search runs across all groups at once.
   */
  const vehicleOptions = useMemo(
    () => assignmentVehicleOptions({ fleet: byOwnership, ownership, lessorId, ordered }),
    [byOwnership, ownership, lessorId, ordered],
  );
  const selected = vehicles.find((vehicle) => vehicle.id === vehicleId) ?? null;
  // The ordered classifier position (ADR 0028): it labels the dialog and the choice is checked
  // against it.
  const orderedLabel = request
    ? vehicleClassificationLabel({
        typeName: request.vehicleTypeName,
        categoryName: request.vehicleCategoryName,
      })
    : '';
  /*
   * Not what was ordered — another type or category (ADR 0045, ADR 0059). Not a ban: the request is
   * closed with what the fleet has. But the mark in the list row is read while choosing and
   * forgotten, while the warning under the field stays visible until "Take into work". The level
   * depends on direction: smaller than ordered — a yellow warning; larger or "nothing to compare" —
   * a neutral note.
   */
  const substitution = assignmentSubstitutionWarning({
    ordered,
    actual: selected,
    orderedLabel,
  });
  // Rates of the rental offer: they fill the fields and reveal a hand-changed price. Rates are
  // agreed per request and the directory price list does not overrule that agreement; the
  // difference is only made visible, not prevented.
  const listedRate = selected?.ownership === 'rental' ? selected : null;
  const priceChanged =
    !!listedRate &&
    ((pricePerHour ?? null) !== (listedRate.pricePerHour ?? null) ||
      (pricePerShift ?? null) !== (listedRate.pricePerShift ?? null));

  // Switching the branch resets the other branch's fields — a lessor means nothing for an own
  // vehicle. The route is reset together with the vehicle: a rental unit is run by its lessor and
  // has no route here.
  const changeOwnership = (next: VehicleOwnership) => {
    setOwnership(next);
    form.setFieldsValue({
      lessorId: undefined,
      vehicleId: undefined,
      pricePerHour: null,
      pricePerShift: null,
      shiftHours: null,
      routeId: NEW_ROUTE,
    });
  };

  return {
    byOwnership,
    changeOwnership,
    emptyText: emptyAssignmentVehicleText({ isFetching, ownership, lessorId }),
    // How many vehicles of other kinds did not fit the page. Silence is not an option: field search
    // runs over loaded rows, and an unfound vehicle would look absent from the fleet.
    hiddenVehicles: Math.max(
      0,
      (wholeFleet.data?.total ?? 0) - (wholeFleet.data?.items.length ?? 0),
    ),
    isFetching,
    isRental: ownership === 'rental',
    lessorId,
    lessorOptions,
    listedRate,
    orderedLabel,
    ownership,
    priceChanged,
    resetOwnership: setOwnership,
    selected,
    substitution,
    vehicleId,
    vehicleOptions,
    // The vehicle and its directory rates: an own vehicle has none, and the fields stay empty.
    vehicleValues: (id: string) => assignmentVehicleValues(vehicles, id),
  };
}

export type AssignmentFleetController = ReturnType<typeof useAssignmentFleet>;
