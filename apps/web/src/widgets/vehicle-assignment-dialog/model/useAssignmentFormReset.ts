import { useEffect, useEffectEvent } from 'react';
import dayjs from 'dayjs';
import {
  DEFAULT_COMMUNICATION_KIND,
  type VehicleOwnership,
  type VehicleRequestDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import type { AssignmentFleetController } from './useAssignmentFleet';
import type { VehicleAssignmentForm } from './types';

/**
 * The dialog is reused for different requests, so fields reset when the target changes, not on
 * unmount. An already assigned vehicle (taking into work again after a rollback) opens the dialog
 * on itself: usually it is confirmed rather than chosen anew.
 */
export function useAssignmentFormReset(
  request: VehicleRequestDto | null,
  form: VehicleAssignmentForm,
  fleet: AssignmentFleetController,
) {
  const targetId = request?.id ?? null;
  const assignment = request?.assignment ?? null;
  const reset = useEffectEvent((_id: string | null) => {
    if (!request) return;
    const ownership: VehicleOwnership = assignment?.ownership ?? 'own';
    fleet.resetOwnership(ownership);
    // The term defaults to the ordered one: that is usually when work starts. Delivery is converted
    // to Moscow time: in a browser east of Moscow "09:00 Moscow" would otherwise become "12:00".
    // Exactly `dayjs(iso).tz(...)`, not `dayjs.tz(iso, ...)`: the latter reads the string as wall
    // time already in that zone and silently drops the offset sent by the server — a three-hour
    // shift of the delivery.
    const scheduled =
      request.requestType === 'freight_transport' ? dayjs(request.scheduledAt).tz(MOSCOW_TZ) : null;
    form.setFieldsValue({
      dateFrom: request.requestType === 'special_equipment' ? dayjs(request.dateFrom) : null,
      dateTo:
        request.requestType === 'special_equipment' && request.dateTo
          ? dayjs(request.dateTo)
          : null,
      scheduledDate: scheduled,
      // A request "for the date" opens with an empty time: this is where it is set.
      scheduledTime:
        request.requestType === 'freight_transport' && !request.scheduledTimeUnspecified
          ? scheduled!.format('HH:mm')
          : undefined,
      lessorId: assignment?.lessorId ?? undefined,
      vehicleId: assignment?.vehicleId,
      pricePerHour: assignment?.pricePerHour ?? null,
      pricePerShift: assignment?.pricePerShift ?? null,
      shiftHours: assignment?.shiftHours ?? null,
      // The machinist is never filled — neither from the request's assignment nor from the previous
      // opening of the dialog (ADR 0083). The empty field is meaningful: on a vehicle change it
      // means "keep the previous one", and a name left from a neighbouring request would silently
      // go into the ESM-2 form.
      machinistId: undefined,
      // The driver for the same reason, since it is asked for an existing route too (ADR 0048): an
      // empty field means "do not touch", and a name left from the previous request would seat in
      // someone else's route a person nobody chose for it.
      driverPersonId: undefined,
      // The 4-P batch does not travel between requests — not the checkbox, the person or the past
      // reason: a checkbox left from a neighbouring order would silently issue fifty forms.
      dayBatchEnabled: false,
      dayBatchDriverId: undefined,
      dayBatchReason: undefined,
      // The new route's communication kind defaults to the set's default: the field is mandatory,
      // and empty it would stop the form on the most common path. Set here, not only by inheriting
      // from the previous route: a vehicle going out for the first time has nothing to inherit, and
      // the dialog is reused — a value left from the previous target would silently go into the new
      // route.
      communicationKind: DEFAULT_COMMUNICATION_KIND,
    });
  });
  // The dependency is the request id: a re-render of the same request (list invalidation after a
  // neighbouring action) comes as a new object and would erase what was already chosen.
  useEffect(() => reset(targetId), [targetId]);
}
