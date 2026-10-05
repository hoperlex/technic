import { useEffect, useMemo, useState } from 'react';
import { Form } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  canCorrectWaybill,
  moscowDateKeyOf,
  weekStartKey,
  type VehicleRequestDto,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { currentMachinistName } from '@features/vehicle-assignment';
import type { VehicleAssignmentForm } from './types';

/** Keep correction permissions, idempotency and ESM-2 history behind one form boundary. */
export function useAssignmentCorrection(
  request: VehicleRequestDto | null,
  reassign: boolean,
  form: VehicleAssignmentForm,
) {
  const targetId = request?.id ?? null;
  const { can } = useAuth();
  const canCorrect = reassign && can('waybills.correct');
  const unlimited = can('waybills.correctBeyondLimit');
  const today = moscowDateKeyOf(new Date());
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({
      correctionEnabled: false,
      correctionReason: '',
      unlockWaybillIds: [],
    });
  }, [targetId, form]);

  const correctionEnabled = (Form.useWatch('correctionEnabled', form) ?? false) && canCorrect;
  const reassignsMachinist = reassign && request?.requestType === 'special_equipment';
  const { data: requestWaybills } = useQuery({
    queryKey: vehicleRequestKeys.waybills(targetId),
    queryFn: () => vehicleRequestsApi.waybills(targetId!),
    enabled: !!targetId && (correctionEnabled || reassignsMachinist),
  });

  // Only completed weeks can require an explicit unlock; current weeks reconcile normally.
  const correctableSheets = useMemo(
    () =>
      (requestWaybills ?? []).filter(
        (waybill) =>
          waybill.formCode === 'esm2' &&
          !!waybill.periodTo &&
          waybill.periodTo < today &&
          canCorrectWaybill(
            {
              issuedForDate: waybill.issuedForDate,
              periodTo: waybill.periodTo,
              status: waybill.status,
            },
            today,
            { unlimited },
          ),
      ),
    [requestWaybills, today, unlimited],
  );

  // A shared week cannot be reconciled into one replacement sheet without losing an assignment.
  const sharedWeeks = useMemo(() => {
    const byWeek = new Map<string, number>();
    for (const waybill of requestWaybills ?? []) {
      if (waybill.formCode !== 'esm2' || waybill.status !== 'issued' || !waybill.periodFrom)
        continue;
      const week = weekStartKey(waybill.periodFrom);
      byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
    }
    return byWeek;
  }, [requestWaybills]);

  return {
    canCorrect,
    correctionEnabled,
    correctableSheets,
    currentMachinist: currentMachinistName(requestWaybills),
    operationId,
    sharedWeeks,
  };
}

export type AssignmentCorrectionController = ReturnType<typeof useAssignmentCorrection>;
