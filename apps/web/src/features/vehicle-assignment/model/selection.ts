import type { Dayjs } from 'dayjs';
import {
  assignmentRateLabel,
  isRouteEditable,
  routeRequestCapacity,
  type ConfirmScheduleBody,
  type VehicleDto,
  type VehicleOwnership,
  type VehicleRequestDto,
  type VehicleRouteDto,
  vehicleLabel,
  vehicleSubstitutionGroup,
  vehicleSubstitutionGroupLabels,
  vehicleSubstitutionHint,
  vehicleSubstitutionOf,
  vehicleSubstitutionRank,
  vehicleSubstitutionWarning,
  type WaybillFormCode,
  waybillFormLabels,
  waybillRequirement,
} from '@technic/contracts';
import { NEW_ROUTE, type AssignFormValues } from './command';

export const ASSIGNMENT_LIST_PARAMS = {
  page: 1,
  pageSize: 500,
  sortBy: 'lessorName',
  sortOrder: 'asc',
  status: 'active',
} as const;

export interface OrderedVehiclePosition {
  categorySpecs: VehicleRequestDto['vehicleCategorySpecs'];
  vehicleCategoryId: VehicleRequestDto['vehicleCategoryId'];
  vehicleKindId: VehicleRequestDto['vehicleKindId'];
  vehicleTypeId: VehicleRequestDto['vehicleTypeId'];
}

export interface AssignmentVehicleGroup {
  label: string;
  options: Array<{ label: string; value: string }>;
}

export function orderedVehiclePosition(
  request: VehicleRequestDto | null,
): OrderedVehiclePosition | null {
  return request
    ? {
        vehicleKindId: request.vehicleKindId,
        vehicleTypeId: request.vehicleTypeId,
        vehicleCategoryId: request.vehicleCategoryId,
        categorySpecs: request.vehicleCategorySpecs,
      }
    : null;
}

/** Merge the prioritized kind page with the whole-fleet page without duplicating vehicles. */
export function mergeAssignmentFleet(...pages: ReadonlyArray<readonly VehicleDto[]>): VehicleDto[] {
  const byId = new Map<string, VehicleDto>();
  for (const page of pages) {
    for (const vehicle of page) byId.set(vehicle.id, vehicle);
  }
  return [...byId.values()];
}

export function assignmentFleetByOwnership(vehicles: readonly VehicleDto[]): {
  own: VehicleDto[];
  rental: VehicleDto[];
} {
  return {
    own: vehicles.filter((vehicle) => vehicle.ownership === 'own'),
    rental: vehicles.filter((vehicle) => vehicle.ownership === 'rental'),
  };
}

export function assignmentLessorOptions(
  rentals: readonly VehicleDto[],
): Array<{ label: string; value: string }> {
  const byId = new Map<string, string>();
  for (const vehicle of rentals) {
    if (vehicle.lessorId) byId.set(vehicle.lessorId, vehicle.lessorName ?? '—');
  }
  return [...byId]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, 'ru'));
}

/** Name a vehicle together with the facts that distinguish it in the assignment picker. */
export function assignmentVehicleOptionLabel(
  vehicle: VehicleDto,
  substitution: ReturnType<typeof vehicleSubstitutionOf>,
): string {
  const title = vehicleLabel(vehicle);
  const extra = [
    vehicle.ownership === 'own' ? vehicle.modelName : null,
    vehicle.categoryName ?? vehicle.typeName,
    vehicleSubstitutionHint(substitution),
    assignmentRateLabel(vehicle) || null,
  ].filter((value): value is string => !!value && value !== title);
  return extra.length > 0 ? `${title} — ${extra.join(' · ')}` : title;
}

/**
 * Keep the complete fleet selectable, but rank exact and nearby substitutions first. Data quality
 * may warn about a mismatch; it must not hide the machine that will actually do the work.
 */
export function assignmentVehicleOptions(input: {
  fleet: ReturnType<typeof assignmentFleetByOwnership>;
  lessorId?: string;
  ordered: OrderedVehiclePosition | null;
  ownership: VehicleOwnership;
}): AssignmentVehicleGroup[] {
  if (!input.ordered) return [];
  const vehicles =
    input.ownership === 'own'
      ? input.fleet.own
      : input.fleet.rental.filter(
          (vehicle) => !input.lessorId || vehicle.lessorId === input.lessorId,
        );
  const groups = new Map<number, AssignmentVehicleGroup>();
  for (const vehicle of vehicles) {
    const substitution = vehicleSubstitutionOf(input.ordered, vehicle);
    const rank = vehicleSubstitutionRank(substitution);
    const group = groups.get(rank) ?? {
      label: vehicleSubstitutionGroupLabels[vehicleSubstitutionGroup(substitution)],
      options: [],
    };
    group.options.push({
      value: vehicle.id,
      label: assignmentVehicleOptionLabel(vehicle, substitution),
    });
    groups.set(rank, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => ({
      ...group,
      options: group.options.sort((left, right) => left.label.localeCompare(right.label, 'ru')),
    }));
}

export function emptyAssignmentVehicleText(input: {
  isFetching: boolean;
  lessorId?: string;
  ownership: VehicleOwnership;
}): string {
  return input.isFetching
    ? 'Загружаем технику…'
    : input.ownership === 'own'
      ? 'Собственной техники в работе нет — возьмите её в аренду'
      : input.lessorId
        ? 'У этого арендодателя нет активных предложений'
        : 'Активных предложений аренды нет';
}

export function assignmentSubstitutionWarning(input: {
  actual: VehicleDto | null;
  ordered: OrderedVehiclePosition | null;
  orderedLabel: string;
}): ReturnType<typeof vehicleSubstitutionWarning> | null {
  return input.actual && input.ordered
    ? vehicleSubstitutionWarning({
        substitution: vehicleSubstitutionOf(input.ordered, input.actual),
        orderedLabel: input.orderedLabel,
        actualTypeName: input.actual.typeName,
        actualCategoryName: input.actual.categoryName,
      })
    : null;
}

export function assignmentVehicleValues(
  vehicles: readonly VehicleDto[],
  vehicleId: string,
): Pick<AssignFormValues, 'pricePerHour' | 'pricePerShift' | 'shiftHours' | 'vehicleId'> {
  const vehicle = vehicles.find((candidate) => candidate.id === vehicleId);
  return {
    vehicleId,
    pricePerHour: vehicle?.pricePerHour ?? null,
    pricePerShift: vehicle?.pricePerShift ?? null,
    shiftHours: vehicle?.shiftHours ?? null,
  };
}

/** A route with a full task table or issued waybill cannot accept another request. */
export function assignmentRouteOptions(routes: readonly VehicleRouteDto[]): VehicleRouteDto[] {
  return routes.filter(
    (route) =>
      route.requests.length < routeRequestCapacity(route.formCode) &&
      isRouteEditable(route.waybill?.status ?? null),
  );
}

export function assignmentRouteModel(input: {
  isFreight: boolean;
  ownership: VehicleOwnership;
  prefillFormCode: WaybillFormCode | null | undefined;
  prefillReady: boolean;
  request: VehicleRequestDto | null;
  selected: VehicleDto | null;
}): {
  formChange: string | null;
  formCode: WaybillFormCode | null;
  needsRoute: boolean;
  reason: string | null;
} {
  const formCode = input.selected?.waybillFormCode ?? input.prefillFormCode ?? null;
  const requirement =
    input.request && input.isFreight && input.prefillReady && formCode
      ? waybillRequirement({
          requestType: input.request.requestType,
          ownership: input.selected?.ownership ?? input.ownership,
          formCode,
        })
      : { formCode: null, reason: null };
  const formChange =
    input.isFreight &&
    input.selected &&
    input.prefillFormCode &&
    requirement.formCode !== input.prefillFormCode
      ? `Лист выпишется по бланку ${waybillFormLabels[requirement.formCode!]} — по типу выбранной машины, а не заказанного`
      : null;
  return {
    formChange,
    formCode,
    needsRoute: !!requirement.formCode,
    reason: requirement.reason,
  };
}

export function assignmentDriverLookup(input: {
  deliveryDate?: Dayjs | null;
  joinedRoute: VehicleRouteDto | null;
  needsRoute: boolean;
  tripDate?: string;
  wantsDelivery: boolean;
  withTrailer: boolean;
}): { needed: boolean; on?: string; withTrailer: boolean } {
  return {
    needed: input.needsRoute || input.wantsDelivery,
    on: input.needsRoute
      ? (input.joinedRoute?.routeDate ?? input.tripDate)
      : input.wantsDelivery
        ? input.deliveryDate?.format('YYYY-MM-DD')
        : undefined,
    withTrailer: input.joinedRoute ? input.joinedRoute.withTrailer : input.withTrailer,
  };
}

export function canOfferAssignmentDelivery(input: {
  ownership: VehicleOwnership;
  reassign: boolean;
  request: VehicleRequestDto | null;
}): boolean {
  return (
    !input.reassign &&
    input.request?.requestType === 'special_equipment' &&
    !input.request.isLinear &&
    input.ownership === 'own'
  );
}

export function canBatchAssignmentDays(input: {
  ownership: VehicleOwnership;
  reassign: boolean;
  request: VehicleRequestDto | null;
  rollbackToWork: boolean;
}): boolean {
  return (
    !input.reassign &&
    !input.rollbackToWork &&
    input.request?.requestType === 'special_equipment' &&
    input.ownership === 'own'
  );
}

/** Form blockers mirror server invariants and keep every failure attached to its field. */
export function assignmentBlockers(
  values: AssignFormValues,
  context: {
    correctionEnabled: boolean;
    isRental: boolean;
    machinistRequired: boolean;
    needsRoute: boolean;
    reassign: boolean;
    requestType: VehicleRequestDto['requestType'] | undefined;
    schedule: ConfirmScheduleBody | null;
    wantsDelivery: boolean;
  },
): Record<string, string | false | undefined> {
  return {
    [context.requestType === 'special_equipment' ? 'dateFrom' : 'scheduledDate']:
      !context.reassign && !context.schedule && 'Укажите фактическую дату',
    machinistId:
      context.machinistRequired &&
      !values.machinistId &&
      'Выберите машиниста — на него выписываются путевые листы ЭСМ-2',
    vehicleId: !values.vehicleId && 'Выберите технику',
    pricePerHour:
      context.isRental &&
      values.pricePerHour == null &&
      values.pricePerShift == null &&
      'Укажите стоимость аренды — за час или за смену',
    deliveryDate: context.wantsDelivery && !values.deliveryDate && 'Укажите дату перегона',
    deliveryDriverId:
      context.wantsDelivery && !values.deliveryDriverId && 'Выберите водителя перегона',
    deliveryFrom:
      context.wantsDelivery && !values.deliveryFrom?.trim() && 'Укажите, откуда идёт техника',
    deliveryTo: context.wantsDelivery && !values.deliveryTo?.trim() && 'Укажите, куда идёт техника',
    correctionReason:
      context.correctionEnabled && !values.correctionReason?.trim() && 'Укажите причину коррекции',
    driverPersonId:
      context.needsRoute &&
      values.routeId === NEW_ROUTE &&
      !values.driverPersonId &&
      'Выберите водителя — на рейс выписывается путевой лист',
  };
}
