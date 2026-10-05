import { useEffect, useEffectEvent, useMemo, useRef } from 'react';
import { Form } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_COMMUNICATION_KIND, type VehicleRequestDto } from '@technic/contracts';
import { driverKeys, driversApi } from '@entities/driver';
import { routePrefillKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import {
  inheritedTrailerGraphs,
  vehicleRouteKeys,
  vehicleRoutesApi,
} from '@entities/vehicle-route';
import {
  assignmentDriverLookup,
  assignmentRouteModel,
  assignmentRouteOptions,
  driverCategoryNote,
  driverGapsNote,
  driverOption,
  joinedRouteDriverExtra,
  joinedRouteDriverNote,
  machinistFieldExtra,
  machinistFieldMode,
  machinistOption,
  NEW_ROUTE,
  plannedEsm2Weeks,
} from '@features/vehicle-assignment';
import type { AssignmentDeliveryController } from './useAssignmentDelivery';
import type { AssignmentFleetController } from './useAssignmentFleet';
import type { VehicleAssignmentForm } from './types';

/** Coordinate route choice, inherited trip fields and crew advisories as one state machine. */
export function useAssignmentRouteCrew({
  request,
  reassign,
  form,
  fleet,
  delivery,
  currentMachinist,
}: {
  request: VehicleRequestDto | null;
  reassign: boolean;
  form: VehicleAssignmentForm;
  fleet: AssignmentFleetController;
  delivery: AssignmentDeliveryController;
  currentMachinist: string | null;
}) {
  const targetId = request?.id ?? null;
  const scheduledDate = Form.useWatch('scheduledDate', form);
  const driverPersonId = Form.useWatch('driverPersonId', form);
  const dateFrom = Form.useWatch('dateFrom', form);
  const dateTo = Form.useWatch('dateTo', form);
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  const routeId = Form.useWatch('routeId', form);
  const communicationKind = Form.useWatch('communicationKind', form);
  const deliveryDriverId = Form.useWatch('deliveryDriverId', form);
  const isFreight = request?.requestType === 'freight_transport';
  const isLinear = request?.requestType === 'special_equipment' && request.isLinear;
  const formTripDate = isFreight && !reassign ? scheduledDate?.format('YYYY-MM-DD') : undefined;

  const { data: prefill } = useQuery({
    queryKey: routePrefillKeys.onTripDate(targetId, formTripDate),
    queryFn: () => vehicleRequestsApi.routePrefill(targetId!, { date: formTripDate }),
    enabled: isFreight && !!targetId,
  });
  const tripDate = formTripDate ?? prefill?.tripDate;
  const routeModel = assignmentRouteModel({
    request,
    isFreight: !!isFreight,
    ownership: fleet.ownership,
    selected: fleet.selected,
    prefillReady: !!prefill,
    prefillFormCode: prefill?.formCode,
  });
  const routeOptions = assignmentRouteOptions(prefill?.routes ?? []);
  const joining = !!routeId && routeId !== NEW_ROUTE;
  const joined = routeOptions.find((route) => route.id === routeId) ?? null;

  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(fleet.vehicleId, tripDate),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: fleet.vehicleId!, date: tripDate! }),
    enabled: routeModel.needsRoute && !joining && !!fleet.vehicleId && !!tripDate,
  });

  const driverLookup = assignmentDriverLookup({
    needsRoute: routeModel.needsRoute,
    joinedRoute: joined,
    tripDate,
    wantsDelivery: delivery.wants,
    deliveryDate: delivery.date,
    withTrailer,
  });
  const { data: selection, isFetching: driversLoading } = useQuery({
    queryKey: driverKeys.available({
      vehicleId: fleet.vehicleId,
      on: driverLookup.on,
      withTrailer: driverLookup.withTrailer,
    }),
    queryFn: () =>
      driversApi.available({
        vehicleId: fleet.vehicleId!,
        on: driverLookup.on!,
        withTrailer: driverLookup.withTrailer,
      }),
    enabled: driverLookup.needed && !!fleet.vehicleId && !!driverLookup.on,
  });
  const driverOptions = (selection?.drivers ?? []).map(driverOption);

  const machinistMode = machinistFieldMode({
    requestType: request?.requestType,
    isRental: fleet.isRental,
    reassign,
    isLinear,
  });
  const { data: machinists, isFetching: machinistsLoading } = useQuery({
    queryKey: driverKeys.machinistOptions(),
    queryFn: () => driversApi.list({ pageSize: 200, sortBy: 'fullName', sortOrder: 'asc' }),
    enabled: machinistMode.needsMachinist,
  });
  const machinistOptions = (machinists?.items ?? []).map(machinistOption);
  const esm2Weeks = useMemo(
    () =>
      plannedEsm2Weeks({
        needsMachinist: machinistMode.needsMachinist,
        reassign,
        isLinear,
        dateFrom,
        dateTo,
      }),
    [machinistMode.needsMachinist, reassign, isLinear, dateFrom, dateTo],
  );

  const selectedDriver = selection?.drivers.find((driver) => driver.personId === driverPersonId);
  const deliveryDriver = selection?.drivers.find((driver) => driver.personId === deliveryDriverId);
  const routeTouched = useRef(false);
  useEffect(() => {
    routeTouched.current = false;
  }, [targetId]);

  const syncRoute = useEffectEvent(
    (_needsRoute: boolean, _vehicleId: unknown, _routes: unknown) => {
      if (!routeModel.needsRoute) return;
      const current = form.getFieldValue('routeId');
      if (current && current !== NEW_ROUTE && !routeOptions.some((route) => route.id === current)) {
        form.setFieldsValue({ routeId: NEW_ROUTE });
        return;
      }
      if (routeTouched.current) return;
      const own = fleet.vehicleId
        ? routeOptions.find((route) => route.vehicleId === fleet.vehicleId)
        : null;
      form.setFieldsValue({ routeId: own?.id ?? NEW_ROUTE });
    },
  );
  useEffect(
    () => syncRoute(routeModel.needsRoute, fleet.vehicleId, prefill?.routes),
    [routeModel.needsRoute, fleet.vehicleId, prefill?.routes],
  );

  // Route branches ask different questions, so a driver choice must never cross the branch edge.
  const driverRoute = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (driverRoute.current === routeId) return;
    driverRoute.current = routeId;
    form.setFields([{ name: 'driverPersonId', value: undefined, errors: [] }]);
  }, [routeId, form]);

  useEffect(() => {
    const trip = suggestion?.trip;
    if (!trip) return;
    form.setFieldsValue({
      ...inheritedTrailerGraphs(trip, suggestion?.hitched),
      garageNumber: trip.garageNumber,
      communicationKind: trip.communicationKind || DEFAULT_COMMUNICATION_KIND,
      transportationKind: trip.transportationKind,
    });
  }, [suggestion?.trip, suggestion?.hitched, form]);

  const changeVehicle = (id: string) => {
    const own = routeOptions.find((route) => route.vehicleId === id);
    form.setFieldsValue({
      ...fleet.vehicleValues(id),
      ...(routeModel.needsRoute ? { routeId: own?.id ?? NEW_ROUTE } : {}),
    });
  };
  const changeRoute = (id: string) => {
    routeTouched.current = true;
    const target = routeOptions.find((route) => route.id === id) ?? null;
    form.setFieldsValue({
      routeId: id,
      ...(target ? fleet.vehicleValues(target.vehicleId) : {}),
    });
  };

  return {
    changeRoute,
    changeVehicle,
    communicationKind,
    deliveryDriverGaps: delivery.wants ? driverGapsNote(deliveryDriver, '4p') : null,
    driverCategoryMismatch: driverCategoryNote(selection, selectedDriver),
    driverGaps: driverGapsNote(selectedDriver, routeModel.formCode),
    driverOptions,
    driversLoading,
    isFreight,
    isLinear,
    joined,
    joinedDriverExtra: joinedRouteDriverExtra(joined),
    joinedRouteNote: joinedRouteDriverNote(joined, driverPersonId),
    joining,
    machinistExtra: machinistFieldExtra({
      reassign,
      isLinear,
      currentMachinist,
      esm2Weeks,
    }),
    machinistItems: machinists?.items ?? [],
    machinistOptions,
    machinistsLoading,
    ...machinistMode,
    prefillFormLabel: prefill?.formLabel,
    routeId,
    routeModel,
    routeOptions,
    suggestion,
    tripDate,
    withTrailer,
  };
}

export type AssignmentRouteCrewController = ReturnType<typeof useAssignmentRouteCrew>;
