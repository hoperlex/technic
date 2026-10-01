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

/** Reset request-scoped values while preserving edits across refreshes of the same request. */
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
    const scheduled =
      request.requestType === 'freight_transport' ? dayjs(request.scheduledAt).tz(MOSCOW_TZ) : null;
    form.setFieldsValue({
      dateFrom: request.requestType === 'special_equipment' ? dayjs(request.dateFrom) : null,
      dateTo:
        request.requestType === 'special_equipment' && request.dateTo
          ? dayjs(request.dateTo)
          : null,
      scheduledDate: scheduled,
      scheduledTime:
        request.requestType === 'freight_transport' && !request.scheduledTimeUnspecified
          ? scheduled!.format('HH:mm')
          : undefined,
      lessorId: assignment?.lessorId ?? undefined,
      vehicleId: assignment?.vehicleId,
      pricePerHour: assignment?.pricePerHour ?? null,
      pricePerShift: assignment?.pricePerShift ?? null,
      shiftHours: assignment?.shiftHours ?? null,
      machinistId: undefined,
      driverPersonId: undefined,
      dayBatchEnabled: false,
      dayBatchDriverId: undefined,
      dayBatchReason: undefined,
      communicationKind: DEFAULT_COMMUNICATION_KIND,
    });
  });
  useEffect(() => reset(targetId), [targetId]);
}
