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

/**
 * Route (the vehicle's trip on a date) and crew: route choice, inherited header fields, the route
 * driver and the ESM-2 machinist.
 *
 * Taking into work issues no document: it puts the request into a route — an existing route of this
 * vehicle on this date or a new one created right here; the waybill is issued from the route once
 * its composition is complete. A route is asked by vehicle: a rental has none — its lessor issues
 * the waybill. An on-site order is not asked at all (ADR 0041): there is no route, only the
 * vehicle's work term on the site.
 */
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
  // The on-site work term: ESM-2 weeks and the days the 4-P batch will issue are counted by it.
  const dateFrom = Form.useWatch('dateFrom', form);
  const dateTo = Form.useWatch('dateTo', form);
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  const routeId = Form.useWatch('routeId', form);
  const communicationKind = Form.useWatch('communicationKind', form);
  const deliveryDriverId = Form.useWatch('deliveryDriverId', form);
  const isFreight = request?.requestType === 'freight_transport';
  const isLinear = request?.requestType === 'special_equipment' && request.isLinear;
  /*
   * Route date for the hint, the driver selection and the waybill. For freight the delivery carries
   * it — taken from the form, not the server answer: the time is edited right here, and the licence
   * must be valid on the day the vehicle actually goes out. For other requests the waybill date is
   * the day of taking into work (ADR 0037), computed by the server.
   *
   * On a vehicle change (ADR 0048) the term is not edited and the server computes the route date
   * entirely: the form has no delivery field, and reading an invisible value would depend on what
   * was left in the form from the previous opening.
   */
  const formTripDate = isFreight && !reassign ? scheduledDate?.format('YYYY-MM-DD') : undefined;

  // Route hint by the ordered vehicle type and without a vehicle (ADR 0052): the day is planned
  // from "which route will the request go with", and the route defines the vehicle. The answer does
  // not depend on the selected unit, so the list is not rebuilt on every click and does not argue
  // with an already chosen route.
  const { data: prefill } = useQuery({
    queryKey: routePrefillKeys.onTripDate(targetId, formTripDate),
    queryFn: () => vehicleRequestsApi.routePrefill(targetId!, { date: formTripDate }),
    enabled: isFreight && !!targetId,
  });
  const tripDate = formTripDate ?? prefill?.tripDate;
  /*
   * Whether a route is kept — by the contracts rule, not a second request: the form is bound to the
   * vehicle type, and ownership is known from the selected vehicle, so "no route is kept" appears
   * the moment a rental unit is selected. The form is asked of the **selected vehicle**, not the
   * ordered type (ADR 0059): the waybill follows the unit that drives — for a car that is form No.
   * 3 where a dump truck has 4-P. Until a vehicle is chosen the ordered type answers, via
   * `prefill`.
   *
   * Before `prefill` answers, the route block is not raised even if the form is known from the
   * vehicle: the "Route" field auto-selects the only option (`AutoSelect`), and on an empty hint
   * that option would be "New route" — the choice would count as manual, and the vehicle's existing
   * route arriving next could no longer override it.
   */
  const routeModel = assignmentRouteModel({
    request,
    isFreight: !!isFreight,
    ownership: fleet.ownership,
    selected: fleet.selected,
    prefillReady: !!prefill,
    prefillFormCode: prefill?.formCode,
  });
  // Routes the request can join: with a free task row and not frozen by an issued waybill. The
  // freeze is checked by the same rule as on the server — otherwise the list would offer routes the
  // server rejects.
  const routeOptions = assignmentRouteOptions(prefill?.routes ?? []);
  // An existing route is selected: its departure details are its own and are not asked again — but
  // the dialog asks for the driver here too (ADR 0048), optionally: the route already runs, and
  // silence means "the same person stays at the wheel".
  const joining = !!routeId && routeId !== NEW_ROUTE;
  const joined = routeOptions.find((route) => route.id === routeId) ?? null;

  // Header fields of the vehicle's previous route and its hitched trailers — a new route needs
  // them.
  const { data: suggestion } = useQuery({
    queryKey: vehicleRouteKeys.suggest(fleet.vehicleId, tripDate),
    queryFn: () => vehicleRoutesApi.suggest({ vehicleId: fleet.vehicleId!, date: tripDate! }),
    enabled: routeModel.needsRoute && !joining && !!fleet.vehicleId && !!tripDate,
  });

  /*
   * Drivers are the whole directory (ADR 0064): neither category nor document completeness removes
   * anyone; both mark the row and are explained by a warning under the field.
   *
   * Documents are checked on the date of the trip: the route's day, or the day the relocation goes
   * — dates differ, and a driver valid today may have an expired licence tomorrow. For an existing
   * route the day comes from the route itself, not `tripDate`: the hint is for the request day, but
   * the person sits in a concrete route, and the licence must be checked against the day printed in
   * their waybill. They almost always match, but "almost" here would cost an expired document on
   * paper.
   */
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

  // Whether the ESM-2 machinist is asked and whether it is required — both branches live in
  // `machinistFieldMode`.
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
  // Weeks for which taking into work issues forms: they label the machinist field.
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

  // What is wrong with the selected driver — two separate warnings (ADR 0055, ADR 0064). The same
  // question for the relocation driver: its waybill is always 4-P (migration 0082).
  const selectedDriver = selection?.drivers.find((driver) => driver.personId === driverPersonId);
  const deliveryDriver = selection?.drivers.find((driver) => driver.personId === deliveryDriverId);
  /*
   * The route fills itself only for an already known vehicle: an assigned unit (taking into work
   * again after a rollback, a vehicle change) goes with its route of the day. While no vehicle is
   * chosen, the field stays on "New route": a filled route would also choose the vehicle, and the
   * person chooses it (ADR 0052).
   *
   * A manual route choice is never overwritten: `routeTouched` is raised by the first change of the
   * field, and a later server answer does not rewrite it.
   */
  const routeTouched = useRef(false);
  useEffect(() => {
    routeTouched.current = false;
  }, [targetId]);

  const syncRoute = useEffectEvent(
    (_needsRoute: boolean, _vehicleId: unknown, _routes: unknown) => {
      if (!routeModel.needsRoute) return;
      // The selected route vanished from the hint — the delivery date was edited and routes are of
      // another day now. Keeping it silently is wrong: the field would show a route the server does
      // not know on that day.
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

  /*
   * Changing the route clears the driver: the two branches ask different things — a new route "who
   * drives", an existing one "whom to replace the current driver with". A name carried between them
   * would mean the portal itself seated in someone else's route a person chosen for something else
   * — exactly what ADR 0083 forbids, by default or by oversight.
   *
   * By comparing with the previous value, not by resetting in the handlers: the route changes by
   * hand (`changeRoute`), by vehicle choice (`changeVehicle`), by the default after a server
   * answer, and when a route disappears from the hint — listing those places one by one means
   * forgetting one eventually. Resetting on every effect run is wrong too: the route hint refetches
   * on its own, and the driver already chosen for a new route would vanish from under the person's
   * hand.
   *
   * The error mark is cleared with the value: "Choose a driver" comes from the field rule or a
   * blocker (ADR 0094), and it was required in the previous branch — for an existing route a red
   * field would demand what the dialog no longer asks. The mark would not clear by itself: the
   * optional field has no rules, and blockers are cleared by `onValuesChange`, which
   * `setFieldsValue` does not raise.
   */
  const driverRoute = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (driverRoute.current === routeId) return;
    driverRoute.current = routeId;
    form.setFields([{ name: 'driverPersonId', value: undefined, errors: [] }]);
  }, [routeId, form]);

  /*
   * Header fields are inherited from this vehicle's previous route — they change once a season, not
   * per route. Except the trailer if one is hitched to the vehicle: `trip` is yesterday's route and
   * the hitch is today's decision, and inheriting over it would print what no longer stands with
   * the vehicle (`docs/vehicle-trailers-plan.md`, §4.2.2). Trailer fields are then set by
   * `TrailerFields`, where their label lives.
   */
  useEffect(() => {
    const trip = suggestion?.trip;
    if (!trip) return;
    form.setFieldsValue({
      ...inheritedTrailerGraphs(trip, suggestion?.hitched),
      garageNumber: trip.garageNumber,
      // The previous route's field may be empty — every route before the list existed is.
      // Inheriting emptiness into a field that cannot be saved without a choice would inherit a
      // stall: the set's default is filled instead.
      communicationKind: trip.communicationKind || DEFAULT_COMMUNICATION_KIND,
      transportationKind: trip.transportationKind,
    });
  }, [suggestion?.trip, suggestion?.hitched, form]);

  // Choosing a vehicle fills its rates and its route of the day: that is how the dispatcher builds
  // the vehicle's day. No free route — a new one is created.
  const changeVehicle = (id: string) => {
    const own = routeOptions.find((route) => route.vehicleId === id);
    form.setFieldsValue({
      ...fleet.vehicleValues(id),
      ...(routeModel.needsRoute ? { routeId: own?.id ?? NEW_ROUTE } : {}),
    });
  };
  // Choosing a route sets the vehicle: a route is created for a concrete unit, and "goes with route
  // R-12 but another vehicle" is not a state but a mismatch the server rejects ("the route belongs
  // to another vehicle"). The vehicle field is locked while a route is chosen; "New route" frees
  // it, keeping the selected value.
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
    // The emptiness of the existing route's driver field is explained in words: silence means
    // "do not replace".
    joinedDriverExtra: joinedRouteDriverExtra(joined),
    // The route composition by name: a driver change affects other requests of the task too.
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
