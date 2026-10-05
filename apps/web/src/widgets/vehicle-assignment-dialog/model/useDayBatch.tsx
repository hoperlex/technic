import { useState, type ReactNode } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VehicleRequestDayBatchResultDto, VehicleRequestDaysDto } from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import { garageKeys } from '@entities/garage';
import { vehicleRequestErrorMessage as errorMessage } from '@entities/vehicle-request';
import { dayBatchBody, type DayBatchFormValues } from '@features/vehicle-assignment';
import { DayBatchReport } from '../ui/DayBatchReport';

/**
 * Talking to the "4-P for the whole period" batch door (ADR 0207): the body, cache invalidation and
 * the report that arrives with the answer.
 *
 * A hook rather than a block in each dialog because two places call the batch — the checkbox of the
 * take-into-work dialog and the days-table button — and everything must be identical: how the body
 * is built and which lists are stale after fifty pieces of paper. A cache key forgotten by one
 * dialog is not a crash but a silently old picture: the garage shows a free vehicle, the waybill
 * journal does not know about issued forms.
 *
 * The dialogs differ in one thing — the cost of a refusal, passed as a prop (`failureHint`). For
 * the days-table button a refusal is harmless: nothing happened, press again. For the checkbox it
 * is not: the request is already in work, cannot be rolled back, and the person must learn that the
 * paper was not issued while the request was taken.
 *
 * Each `apply` uses a fresh operation key (`crypto.randomUUID()` per call; ADR 0207 decision 11 —
 * see `dayBatchBody`): a repeated click collects the remainder, which is a different operation.
 */

interface Options {
  /**
   * The new days table: the batch returns it whole, and whoever shows the table owns its cache.
   * Called only on success — which is also the "batch passed" signal: the batch dialog closes here.
   */
  onDays?: (days: VehicleRequestDaysDto) => void;
  /**
   * How to explain a refusal where what was done cannot be undone. Empty — the refusal speaks for
   * itself.
   */
  failureHint?: string;
}

export function useDayBatch({ onDays, failureHint }: Options = {}): {
  apply: (v: { requestId: string; values: DayBatchFormValues }) => void;
  applying: boolean;
  /**
   * The batch report: held by the hook's state, not the dialog's — the dialog is closed by then.
   */
  report: ReactNode;
} {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [result, setResult] = useState<VehicleRequestDayBatchResultDto | null>(null);

  const mut = useMutation({
    mutationFn: (v: { requestId: string; values: DayBatchFormValues }) =>
      vehicleRequestsApi.planDayBatch(v.requestId, dayBatchBody(v.values, crypto.randomUUID())),
    onSuccess: (res: VehicleRequestDayBatchResultDto) => {
      setResult(res);
      onDays?.(res.days);
      // Requests: the list row shows the day's route and vehicle, and the request has a new
      // version. The key is the root, so the days table (`[…, id, 'days']`) is invalidated too —
      // the one open not here but in the neighbouring card dialog.
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      // Routes: each day either joined another route or created a new one — both changed
      // composition.
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      // Waybill journal: the batch issues strict-reporting forms by the dozen, and afterwards the
      // journal shows something other than the database. The per-day door did not invalidate it —
      // it had no reason to: it spends no numbers.
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      // Garage view: it has no tables of its own — the day is assembled by the server (ADR 0076) —
      // and whether work is visible depends on route composition (ADR 0131). Without invalidation
      // the dispatcher reads occupancy that is gone and a free vehicle booked for the whole month.
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (e) => {
      // Longer than usual and with an explanation: in the take-into-work dialog this refusal comes
      // on top of an already completed transition, and a corner "Error" would read as "nothing
      // happened".
      message.error(failureHint ? `${failureHint} ${errorMessage(e)}` : errorMessage(e), 10);
    },
  });

  return {
    apply: mut.mutate,
    applying: mut.isPending,
    report: <DayBatchReport result={result} onClose={() => setResult(null)} />,
  };
}
