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
import { recheckReasonOf } from '@features/vehicle-assignment';
import {
  silentTermApplyBody,
  termCommandOf,
  termPreviewIsSilent,
  type FormValues,
} from '@features/vehicle-request-editor';
import { isApiError } from '@shared/api';
import type { PendingPeriodSave, VehicleRequestEditorPeriodModalProps } from './types';
import type { VehicleRequestEditorState } from './useVehicleRequestEditorState';

/** What the rest of the edit is saved with once the term step is over. */
export interface TermStepResult {
  values: FormValues;
  /** The term applied by its door in this edit: the fresh version comes from it. */
  period?: VehicleRequestPeriodResultDto;
  /**
   * Transitional (see `legacy` below): the door refused this account by right, and the term rides
   * the wide `PATCH /:id` the way it did before K3a.
   */
  legacyTerm?: boolean;
}

/** A term applied during this edit, tied to the snapshot the editor opened with. */
interface AppliedTerm {
  requestId: string;
  fromVersion: number;
  result: VehicleRequestPeriodResultDto;
}

type SilentOutcome =
  | { kind: 'applied'; result: VehicleRequestPeriodResultDto }
  | { kind: 'window' }
  | { kind: 'legacy' };

interface Input {
  state: VehicleRequestEditorState;
  /** Saves the rest of the edit through the wide `PATCH /:id`, which no longer carries the term. */
  saveRest: (input: TermStepResult) => void;
}

/**
 * The term step of an edit (K3a, S-21 of 12.10.2026): the editor sends no `dateFrom`/`dateTo` in
 * the wide `PATCH /vehicle-requests/:id`; a changed term goes through its own door first, and the
 * rest follows with the version the door returned.
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
 * before K3a. Everything that used to ride the wide route quietly — a "new" order, an account
 * without the journal right — asks the preview first and applies a silent one at once
 * (`termPreviewIsSilent`): a new order has neither vehicle nor paper, and a window saying "nothing
 * happens" would only teach people to press without reading. A loud preview opens the window.
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
      let preview;
      try {
        preview = await vehicleRequestsApi.periodPreview(request.id, {
          version: request.version,
          ...command,
        });
      } catch (error) {
        /*
         * TRANSITIONAL — the only path left that sends the term in the wide PATCH. Today the door
         * is guarded by `waybills.read` at the route, and the customer roles (site, department)
         * hold `vehicleRequests.update` without the journal right: the door answers them 403
         * while the wide route still moves their "new" order's term. The fallback keeps their
         * edit working until the server asks that right by the plan instead (the open server
         * prerequisite of K3a, ADR 0214, last section); then this preview answers them and the
         * branch is never taken. R2 may drop the wide-PATCH dates only after that.
         */
        if (isApiError(error) && error.status === 403) return { kind: 'legacy' };
        throw error;
      }
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
      if (outcome.kind === 'legacy') {
        saveRest({ values: pending.values, legacyTerm: true });
        return;
      }
      if (outcome.kind === 'window') {
        setWindowSave(pending);
        return;
      }
      // The term is written even if the rest fails next: lists and paper must re-read now.
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
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
   * on-site order), and the caller saves the rest at once with `applied`.
   */
  const start = (values: FormValues): boolean => {
    if (!current) return false;
    const command = termCommandOf(values, current);
    if (!command) return false;
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
