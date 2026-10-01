import dayjs, { type Dayjs } from 'dayjs';
import {
  type AssignVehicleBody,
  type ChangeVehicleAssignmentBody,
  type ConfirmScheduleBody,
  type CorrectAssignmentBody,
  normalizeTimeInput,
  RELOCATION_COMMUNICATION_KIND,
  type VehicleRequestDto,
} from '@technic/contracts';
import { trailerTripBody } from '@entities/vehicle-route';
import { MOSCOW_TZ } from '@shared/config';

/** Empty route selection means that the assignment must create a route. */
export const NEW_ROUTE = 'new';

export interface AssignFormValues {
  correctionEnabled?: boolean;
  correctionReason?: string;
  dateFrom?: Dayjs | null;
  dateTo?: Dayjs | null;
  deliveryDate?: Dayjs | null;
  deliveryDriverId?: string;
  deliveryEnabled?: boolean;
  deliveryFrom?: string;
  deliveryTo?: string;
  driverPersonId?: string;
  garageNumber?: string;
  lessorId?: string;
  machinistId?: string;
  pricePerHour?: number | null;
  pricePerShift?: number | null;
  routeId?: string;
  scheduledDate?: Dayjs | null;
  scheduledTime?: string;
  shiftHours?: number | null;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
  transportationKind?: string;
  communicationKind?: string;
  unlockWaybillIds?: string[];
  vehicleId?: string;
  withTrailer?: boolean;
}

/** One immutable command is used for both preview and confirmation. */
export interface AssignCommand {
  acknowledgements?: Record<string, string>;
  assignment: AssignVehicleBody;
  correction?: CorrectAssignmentBody;
  previewFingerprint?: string;
  schedule: ConfirmScheduleBody | null;
}

export interface AssignmentCommandContext {
  correctionId: string | null;
  needsMachinist: boolean;
  needsRoute: boolean;
  schedule: ConfirmScheduleBody | null;
  wantsDelivery: boolean;
}

/**
 * Add request version and only the handshakes supplied by the preview. The API rejects an extra
 * fingerprint or acknowledgement just as strictly as a missing one.
 */
export function reassignRequestBody(
  command: AssignCommand,
  version: number,
): ChangeVehicleAssignmentBody {
  return {
    ...command.assignment,
    version,
    ...(command.correction ? { correction: command.correction } : {}),
    ...(command.previewFingerprint ? { previewFingerprint: command.previewFingerprint } : {}),
    ...(command.acknowledgements ? { acknowledgements: command.acknowledgements } : {}),
  };
}

/** Convert the form term to the API schedule in Moscow time. */
export function assignScheduleOf(
  request: VehicleRequestDto | null,
  values: AssignFormValues,
): ConfirmScheduleBody | null {
  if (!request) return null;
  if (request.requestType === 'special_equipment') {
    if (!values.dateFrom) return null;
    return {
      requestType: 'special_equipment',
      dateFrom: values.dateFrom.format('YYYY-MM-DD'),
      dateTo: values.dateTo ? values.dateTo.format('YYYY-MM-DD') : null,
    };
  }
  if (!values.scheduledDate) return null;
  const time = normalizeTimeInput(values.scheduledTime ?? '');
  return {
    requestType: 'freight_transport',
    scheduledAt: dayjs
      .tz(`${values.scheduledDate.format('YYYY-MM-DD')} ${time ?? '00:00'}`, MOSCOW_TZ)
      .format('YYYY-MM-DDTHH:mm:ssZ'),
    scheduledTimeUnspecified: time === undefined,
  };
}

/**
 * Build the complete assignment command once. The preview and the write must receive the same
 * assignment, otherwise the server fingerprint would describe a different operation.
 */
export function assignCommandBody(
  values: AssignFormValues,
  context: AssignmentCommandContext,
): AssignCommand {
  return {
    assignment: {
      vehicleId: values.vehicleId!,
      pricePerHour: values.pricePerHour ?? null,
      pricePerShift: values.pricePerShift ?? null,
      shiftHours: values.shiftHours ?? null,
      // An omitted machinist means "keep the previous one" during reassignment.
      ...(context.needsMachinist ? { driverPersonId: values.machinistId } : {}),
      ...(context.needsRoute
        ? {
            route:
              values.routeId && values.routeId !== NEW_ROUTE
                ? {
                    routeId: values.routeId,
                    // A missing driver keeps the current driver of the shared route.
                    ...(values.driverPersonId ? { driverPersonId: values.driverPersonId } : {}),
                  }
                : {
                    newRoute: {
                      driverPersonId: values.driverPersonId,
                      trip: {
                        ...trailerTripBody(values),
                        garageNumber: values.garageNumber ?? '',
                        communicationKind: values.communicationKind ?? '',
                        transportationKind: values.transportationKind ?? '',
                      },
                    },
                  },
          }
        : {}),
      // Delivery is a separate relocation route for special equipment, not its work route.
      ...(context.wantsDelivery
        ? {
            delivery: {
              routeDate: values.deliveryDate!.format('YYYY-MM-DD'),
              driverPersonId: values.deliveryDriverId,
              moveFrom: values.deliveryFrom!.trim(),
              moveTo: values.deliveryTo!.trim(),
              trip: { communicationKind: RELOCATION_COMMUNICATION_KIND },
            },
          }
        : {}),
    },
    schedule: context.schedule,
    // A correction describes the past; it is not part of the current assignment snapshot.
    ...(context.correctionId
      ? {
          correction: {
            operationId: context.correctionId,
            reason: values.correctionReason!.trim(),
            unlockWaybillIds: values.unlockWaybillIds ?? [],
          },
        }
      : {}),
  };
}
