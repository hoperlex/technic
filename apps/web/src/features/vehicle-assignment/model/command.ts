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

/**
 * Assignment command body and the actual term — what the vehicle-assignment dialog sends out.
 *
 * Separate from the dialog on the same border that keeps `machinistCommand` apart from the
 * machinist dialog: the dialog is form state (ownership branches, defaults, field resets when the
 * request changes), and here live the rules of talking to the door. The body is built **once**: the
 * consequence preview is requested with it and the confirmation sends it, and a second assembly
 * would drift from the first on the first new field — and with it the fingerprint the server uses
 * to check what was promised to the person.
 *
 * The form fields are described here too: both the body assembly and the dialog know their names,
 * and they must not diverge — a field the assembly does not know would silently not reach the
 * server.
 */

/**
 * Select value for "create a new route": an empty string is indistinguishable from "not chosen
 * yet".
 */
export const NEW_ROUTE = 'new';

export interface AssignFormValues {
  // ── Actual term ──
  /** On-site equipment: the work term. */
  dateFrom?: Dayjs | null;
  dateTo?: Dayjs | null;
  /**
   * Freight: delivery date and time (`HH:mm`); an empty time means delivery without an exact hour.
   */
  scheduledDate?: Dayjs | null;
  scheduledTime?: string;
  lessorId?: string;
  vehicleId?: string;
  pricePerHour?: number | null;
  pricePerShift?: number | null;
  shiftHours?: number | null;
  // ── Route: an existing one (where at most the driver changes) or a whole new one ──
  routeId?: string;
  /**
   * Who drives the route. Mandatory for a new route — there is no route without a person; for an
   * existing route the field answers a different question, "replace whoever already drives", and an
   * empty value there is the legitimate answer "do not replace" (ADR 0048).
   */
  driverPersonId?: string;
  withTrailer?: boolean;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
  garageNumber?: string;
  communicationKind?: string;
  transportationKind?: string;
  /**
   * Machinist of an on-site order: weekly ESM-2 forms are issued to them (migration 0087). A
   * separate field, not `driverPersonId`: that one is the freight route driver, selected by
   * documents and licence category for the vehicle, while here any driver of the directory fits.
   */
  machinistId?: string;
  // ── Backdated correction (ADR 0101, R8): only when changing the vehicle of a running request ──
  /**
   * The vehicle changes not "from today" but because the wrong one was recorded: another plate
   * worked.
   */
  correctionEnabled?: boolean;
  correctionReason?: string;
  /** ESM-2 forms of worked weeks to reissue: addressed one by one, not "all past ones". */
  unlockWaybillIds?: string[];
  // ── Delivery to the site: an optional relocation (migration 0082) ──
  /** On-site equipment drives to the site on its own wheels — a 4-P is issued for that trip. */
  deliveryEnabled?: boolean;
  deliveryDate?: Dayjs | null;
  deliveryDriverId?: string;
  deliveryFrom?: string;
  deliveryTo?: string;
}

/**
 * What the dialog sends out: built once and sent immediately or after confirmation. The preview and
 * the write receive the same command, otherwise the server fingerprint would describe a different
 * operation.
 */
export interface AssignCommand {
  /** Signatures per warned sheet (B4) of the shown vehicle-change preview; see `warnings`. */
  acknowledgements?: Record<string, string>;
  assignment: AssignVehicleBody;
  /** Backdated vehicle change (ADR 0101, R8): reason, operation key and forms to reissue. */
  correction?: CorrectAssignmentBody;
  /**
   * Fingerprint of the consequences shown in the dialog's second step: the server checks under its
   * locks that what was promised still holds. Absent where there was no preview at all — for
   * freight and for a server older than the portal.
   */
  previewFingerprint?: string;
  schedule: ConfirmScheduleBody | null;
}

export interface AssignmentCommandContext {
  /** Backdated-correction operation key; `null` — an ordinary change without editing the past. */
  correctionId: string | null;
  /** Whether the ESM-2 machinist was asked — decides whether the field is sent at all. */
  needsMachinist: boolean;
  /** Whether a route is kept: rentals and on-site orders have none (ADR 0041). */
  needsRoute: boolean;
  schedule: ConfirmScheduleBody | null;
  /** Whether a delivery relocation to the site is created (migration 0082). */
  wantsDelivery: boolean;
}

/**
 * The body of `PATCH …/assignment` (vehicle change, ADR 0048) from the dialog's command.
 *
 * Every handshake goes only when the dialog has one: its presence is dictated by the server's
 * answer, and a superfluous one is rejected as strictly as a missing one. Assembled here, next to
 * the command, rather than in the list that sends it: the list only knows "send this command", and
 * a second assembly there would drift from the one the preview was computed with.
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

/**
 * The actual term as the API accepts it. The delivery time is assembled in Moscow time — the zone
 * of both the request and the waybill; an empty time means delivery "on the date", as when creating
 * the request.
 */
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

/** The whole assignment command: vehicle, rates, person, route, relocation and correction flag. */
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
      // Machinist of an on-site order: ESM-2 forms for every week of the term are issued to them.
      // Freight has no such field — there the driver belongs to the route. For a linear request the
      // field may stay empty: an assignment without a machinist is legal, its forms are issued
      // separately and to their own person (ADR 0100 decision 6).
      //
      // An unfilled field goes as an absent key, not an empty string or `null`: `undefined` is lost
      // in serialisation, and the server receives exactly what the contract describes — "no
      // machinist named". On a vehicle change (ADR 0048) that means "keep the previous one": ESM-2
      // reconciliation takes the person from the request's previous form.
      ...(context.needsMachinist ? { driverPersonId: values.machinistId } : {}),
      // Route: an existing one by id and, if a person was chosen, a new driver; a new one together
      // with its driver and departure details.
      ...(context.needsRoute
        ? {
            route:
              values.routeId && values.routeId !== NEW_ROUTE
                ? {
                    routeId: values.routeId,
                    // The key is sent only with a chosen name. An absent key means "do not touch
                    // the driver" in the contract (ADR 0048), and that is the only way the dialog
                    // can express an empty field: `null` there means "remove", and the route is
                    // shared — removing would leave other requests without a driver too. That
                    // decision is made by editing the route, where its whole composition is
                    // visible (ADR 0082); it is not offered here.
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
      // Delivery to the site is a separate route on the relocation date, not part of the request's
      // route: on-site equipment has no route at all, only its work term on the site.
      ...(context.wantsDelivery
        ? {
            delivery: {
              routeDate: values.deliveryDate!.format('YYYY-MM-DD'),
              driverPersonId: values.deliveryDriverId,
              moveFrom: values.deliveryFrom!.trim(),
              moveTo: values.deliveryTo!.trim(),
              // The portal sets the relocation communication kind itself and the dialog does not
              // ask for it (`RELOCATION_COMMUNICATION_KIND`): equipment goes from base to site
              // through the city.
              trip: { communicationKind: RELOCATION_COMMUNICATION_KIND },
            },
          }
        : {}),
    },
    schedule: context.schedule,
    // The correction flag is a separate block, not an assignment field: it is not about how the
    // request is carried out but about what the request claims about past days (ADR 0101, R8).
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
