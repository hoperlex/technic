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

/**
 * Backdated correction of a vehicle change (ADR 0101, R8) plus the request's ESM-2 history it
 * needs.
 */
export function useAssignmentCorrection(
  request: VehicleRequestDto | null,
  reassign: boolean,
  form: VehicleAssignmentForm,
) {
  const targetId = request?.id ?? null;
  const { can } = useAuth();
  // The permission for everything backdated (ADR 0101 item 7). Without it there is no correction
  // block at all: offering an action the handler answers with 403 promises what the portal cannot
  // do.
  const canCorrect = reassign && can('waybills.correct');
  // Deeper than 30 days only an administrator corrects (R37) — the same predicate as the server's.
  const unlimited = can('waybills.correctBeyondLimit');
  const today = moscowDateKeyOf(new Date());
  // Idempotency key (R31): created before sending and kept while the dialog is open on this
  // request. A retry after a network timeout must return the previous operation's result instead of
  // burning a second form number — the same per-dialog rule as the request editor's backdate key.
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
  // A vehicle change of an on-site order — the case in which the dialog also offers to change the
  // machinist, so the request's forms are asked. The selected vehicle's ownership is deliberately
  // not part of it: it changes with the switch inside the dialog, and the query would restart on
  // every move between branches, while "who stands in the forms" does not depend on it.
  const reassignsMachinist = reassign && request?.requestType === 'special_equipment';
  /*
   * The request's ESM-2 forms — with the same query and key as the request card shows them, so a
   * card opened just before answers from cache. Asked under correction and on a vehicle change of
   * an on-site order: in the second case to name the current machinist under the field, otherwise
   * "leave empty" refers to nobody. Taking into work does not need them: the request has no forms
   * yet, and an extra request on every opening would be paid for nothing.
   */
  const { data: requestWaybills } = useQuery({
    queryKey: vehicleRequestKeys.waybills(targetId),
    queryFn: () => vehicleRequestsApi.waybills(targetId!),
    enabled: !!targetId && (correctionEnabled || reassignsMachinist),
  });

  /*
   * Offered for reissue: active weekly forms of **worked** weeks. The current and future weeks are
   * not listed — reconciliation reissues them itself without any unlock: only a week that has ended
   * is untouchable (`canCancelWaybill`). The number's eligibility is `canCorrectWaybill`, the same
   * predicate the server refuses with: a cancelled form is not corrected, and one older than 30
   * days is open only to an administrator.
   */
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

  // A week in which the request has two active forms (ADR 0100 item 7) cannot be reissued by
  // reconciliation: one form would be issued for the week and the second vehicle's report would be
  // lost. The server rejects such a pair — the portal does not offer it at all and says why.
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
    // Who stands in the request's active forms: the empty machinist field is labelled with this
    // name (ADR 0083).
    currentMachinist: currentMachinistName(requestWaybills),
    operationId,
    sharedWeeks,
  };
}

export type AssignmentCorrectionController = ReturnType<typeof useAssignmentCorrection>;
