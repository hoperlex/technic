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

/** Own the complete active fleet and the four-step ownership/lessor/vehicle selection. */
export function useAssignmentFleet(request: VehicleRequestDto | null, form: VehicleAssignmentForm) {
  const [ownership, setOwnership] = useState<VehicleOwnership>('own');
  const vehicleKindId = request?.vehicleKindId ?? null;
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
  const lessorOptions = useMemo(
    () => assignmentLessorOptions(byOwnership.rental),
    [byOwnership.rental],
  );
  const vehicleOptions = useMemo(
    () => assignmentVehicleOptions({ fleet: byOwnership, ownership, lessorId, ordered }),
    [byOwnership, ownership, lessorId, ordered],
  );
  const selected = vehicles.find((vehicle) => vehicle.id === vehicleId) ?? null;
  const orderedLabel = request
    ? vehicleClassificationLabel({
        typeName: request.vehicleTypeName,
        categoryName: request.vehicleCategoryName,
      })
    : '';
  const substitution = assignmentSubstitutionWarning({
    ordered,
    actual: selected,
    orderedLabel,
  });
  const listedRate = selected?.ownership === 'rental' ? selected : null;
  const priceChanged =
    !!listedRate &&
    ((pricePerHour ?? null) !== (listedRate.pricePerHour ?? null) ||
      (pricePerShift ?? null) !== (listedRate.pricePerShift ?? null));

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
    vehicleValues: (id: string) => assignmentVehicleValues(vehicles, id),
  };
}

export type AssignmentFleetController = ReturnType<typeof useAssignmentFleet>;
