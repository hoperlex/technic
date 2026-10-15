import { useState } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SpecialEquipmentRequestDto } from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestKeys,
  vehicleRequestsApi,
  type VehicleRequestPeriodResultDto,
} from '@entities/vehicle-request';
import { waybillKeys } from '@entities/waybill';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { recheckReasonOf } from '@features/vehicle-assignment';
import {
  silentTermApplyBody,
  termCommandOf,
  termPreviewIsSilent,
  termRidesWideEdit,
  type FormValues,
} from '@features/vehicle-request-editor';
import type { PendingPeriodSave, VehicleRequestEditorPeriodModalProps } from './types';
import type { VehicleRequestEditorState } from './useVehicleRequestEditorState';

/** What the rest of the edit is saved with once the term step is over. */
export interface TermStepResult {
  values: FormValues;
  /** The term applied by its door in this edit: the fresh version comes from it. */
  period?: VehicleRequestPeriodResultDto;
  /**
   * The term rides the wide `PATCH /:id` itself: a «Новая» order edited by an account without the
   * journal right (`termRidesWideEdit`, S-22). Not a fallback — the route the owner kept for it.
   */
  termInBody?: boolean;
}

/** A term applied during this edit, tied to the snapshot the editor opened with. */
interface AppliedTerm {
  requestId: string;
  fromVersion: number;
  result: VehicleRequestPeriodResultDto;
}

type SilentOutcome =
  { kind: 'applied'; result: VehicleRequestPeriodResultDto } | { kind: 'window' };

interface Input {
  state: VehicleRequestEditorState;
  /** Saves the rest of the edit through the wide `PATCH /:id`. */
  saveRest: (input: TermStepResult) => void;
}

/**
 * The term step of an edit (K3a; owner surveys S-21 and S-22 of 12.10.2026): a changed term goes
 * through its own door first, and the rest follows in the wide `PATCH /vehicle-requests/:id` with
 * the version the door returned and without `dateFrom`/`dateTo`. Release R2 removes the dates from
 * the wide PATCH for orders in work, so a contract-7 bundle must not send them there.
 *
 * THE ONE CASE THE DOOR IS NOT ASKED (S-22). A «Новая» order edited by an account without
 * `waybills.read` — the site and the department — sends its term in the wide PATCH, one command.
 * The door stays guarded by the journal right, R2 keeps the dates for «Новая» orders, and such an
 * order has no paper or history for a preview to show (`termRidesWideEdit`).
 *
 * WHY THE TERM GOES FIRST. It is the step that can be refused on its own rules (lead time, the
 * ban on shortening a running order, backdate rights, a stale preview) and the only one the person
 * may decline in the consequences window. Going first, any refusal or a cancel leaves nothing
 * written. The other order would save the comment and the contacts and then leave the term as it
 * was — a half-applied edit by the person's own "Cancel".
 *
 * WHAT IF THE REST FAILS AFTER THE TERM. Two commands cannot be one transaction, so this is the
 * one half-applied state left, and it is made visible and recoverable rather than hidden: the
 * editor stays open, the message says the term is already changed, and the applied result is kept
 * here — the next "Save" compares the form with the applied term, finds nothing to move and sends
 * only the rest, with the door's version. Asking the door again would be an empty command (422).
 *
 * WHICH WAY THE DOOR OPENS. A running order of a paper reader opens the consequences window, as
 * before K3a. A «Новая» order of a paper reader asks the preview first and applies a silent one at
 * once (`termPreviewIsSilent`): it has neither vehicle nor paper, and a window saying "nothing
 * happens" would only teach people to press without reading. A loud preview opens the window.
 *
 * NO FALLBACK ON 403. A refusal by right from the door is shown as it is, not retried through the
 * wide PATCH. The only accounts it can reach edit an order in work without the journal — no
 * shipped role does (site and department roles edit «Новая» only), a hand-made grant set could —
 * and for an order in work S-22 keeps the door as the only route: R2 refuses dates there anyway.
 */
export function useEditorTermDoor({ state, saveRest }: Input) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  /** The consequences window waiting for confirmation; the form values must survive it. */
  const [windowSave, setWindowSave] = useState<PendingPeriodSave | null>(null);
  const [applied, setApplied] = useState<AppliedTerm | null>(null);

  const record = state.record?.requestType === 'special_equipment' ? state.record : null;
  const appliedNow =
    record && applied?.requestId === record.id && applied.fromVersion === record.version
      ? applied.result
      : undefined;
  /**
   * The order as this edit now stands: a term applied earlier in the same edit replaces the
   * snapshot's.
   */
  const current: SpecialEquipmentRequestDto | null =
    record && appliedNow
      ? {
          ...record,
          version: appliedNow.version,
          dateFrom: appliedNow.dateFrom,
          dateTo: appliedNow.dateTo,
        }
      : record;

  const afterApplied = (values: FormValues, result: VehicleRequestPeriodResultDto) => {
    if (record) setApplied({ requestId: record.id, fromVersion: record.version, result });
    saveRest({ values, period: result });
  };

  const silent = useMutation({
    mutationFn: async ({ request, command, values }: PendingPeriodSave): Promise<SilentOutcome> => {
      const preview = await vehicleRequestsApi.periodPreview(request.id, {
        version: request.version,
        ...command,
      });
      const reason = (values.backdateReason ?? '').trim();
      if (!termPreviewIsSilent(preview, reason)) return { kind: 'window' };
      const result = await vehicleRequestsApi.changePeriod(
        request.id,
        silentTermApplyBody(request, command, preview, {
          operationId: state.operationId,
          reason,
        }),
      );
      return { kind: 'applied', result };
    },
    onSuccess: (outcome, pending) => {
      if (outcome.kind === 'window') {
        setWindowSave(pending);
        return;
      }
      // The term is written even if the rest fails next: lists and paper must re-read now.
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      afterApplied(pending.values, outcome.result);
    },
    onError: (error, pending) => {
      // The consequences changed between the preview and the command: the person reads them in
      // the window instead of a toast, because what happens now is no longer "nothing".
      if (recheckReasonOf(error)) {
        setWindowSave(pending);
        return;
      }
      message.error(errorMessage(error));
    },
  });

  /**
   * Starts the term step. `false` — the form leaves the term as it is (or the edit is not of an
   * on-site order), and the caller saves the rest at once with `applied`. `true` — the step has
   * taken the save over: the door first, or the wide PATCH with the term in the S-22 case.
   */
  const start = (values: FormValues): boolean => {
    if (!current) return false;
    const command = termCommandOf(values, current);
    if (!command) return false;
    if (termRidesWideEdit(current.status, can('waybills.read'))) {
      saveRest({ values, termInBody: true });
      return true;
    }
    const pending: PendingPeriodSave = { request: current, command, values };
    if (current.status !== 'new' && can('waybills.read')) setWindowSave(pending);
    else silent.mutate(pending);
    return true;
  };

  const periodModalProps: VehicleRequestEditorPeriodModalProps = {
    request: windowSave?.request ?? null,
    command: windowSave?.command ?? null,
    // The backdate reason typed in the form moves to the window together with the same operation
    // key: the person explains one edit, not every handler it passes through.
    reason: windowSave?.values.backdateReason,
    operationId: state.operationId,
    onCancel: () => setWindowSave(null),
    onApplied: (result) => {
      const pending = windowSave;
      setWindowSave(null);
      if (pending) afterApplied(pending.values, result);
    },
  };

  return {
    /** The term applied earlier in this edit, if the rest failed after it. */
    applied: appliedNow,
    pending: silent.isPending,
    periodModalProps,
    /** The edit is saved: the applied term is no longer a pending half. */
    reset: () => setApplied(null),
    start,
  };
}
