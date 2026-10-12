import { useEffect, useEffectEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { VehicleRequestDto, VehicleRequestRollbackPreviewDto } from '@technic/contracts';
import { isApiError } from '@shared/api';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestsApi,
} from '@entities/vehicle-request';
import { RollbackConsequences } from '../ui/RollbackConsequences';

/**
 * The door's refusal over a stale fingerprint has no code of its own — it is a 409 with the shared
 * `version_conflict` (ADR 0211 decision 4), and nothing tells it apart from an ordinary version
 * mismatch. So the answer to such a 409 is one and honest in both cases: ask the consequences
 * again. If the version went stale, the preview refuses with the same 409, and its text takes the
 * list's place in the dialog.
 */
const STALE_REASON =
  'Данные изменились с того момента, как вы их смотрели, — вот что снимет возврат теперь. Прочитайте и подтвердите заново.';

interface Input {
  /** The request of the open dialog; `null` — there is no dialog and nothing to ask. */
  target: VehicleRequestDto | null;
}

/**
 * The rollback dialog's conversation with the server (ADR 0211): ask the consequences on opening,
 * confirm them with the fingerprint, and on the door's refusal ask again and say that they changed.
 *
 * Why the dialog does not assemble the list itself is explained in ADR 0211: the rule "what the
 * rollback erases" lived in two carriers, the server executed it and the portal retold it, and the
 * retelling diverged both ways — it kept silent about days, shifts, the early end and ESM-2 and
 * promised to remove a relocation that stays. Here the portal computes nothing: it shows the plan
 * it was sent and returns its fingerprint.
 *
 * The preview is a POST asked through a mutation, not a cached query: an answer is valid only for
 * the opening that read it, and a cached plan would confirm consequences nobody looked at.
 */
export function useRollbackConsequences({ target }: Input) {
  /**
   * The consequences shown and the version they were computed for. The pair is immutable: the
   * fingerprint confirms exactly the plan the person read, and it must leave with the same version
   * — otherwise the door would check the fingerprint of one state against the version of another.
   */
  const [shown, setShown] = useState<{
    preview: VehicleRequestRollbackPreviewDto;
    version: number;
  } | null>(null);
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async (v: { request: VehicleRequestDto; stale: string | null }) => ({
      ...v,
      version: v.request.version,
      preview: await vehicleRequestsApi.rollbackPreview(v.request.id, v.request.version),
    }),
    onSuccess: ({ preview, version, stale }) => {
      setFailure(null);
      setStaleReason(stale);
      setShown({ preview, version });
    },
    /*
     * The refusal is shown in the dialog itself, not as a toast: a toast disappears, and the
     * decision "erase the work or not" is taken right here and now. The previous list is removed —
     * it described a state the server no longer confirmed.
     */
    onError: (e) => {
      setShown(null);
      setFailure(errorMessage(e));
    },
  });

  /*
   * The consequences are asked anew on every opening: between yesterday's look and today's click
   * the plan changes without touching the request (a waybill was issued for a relocation, a sheet
   * was cancelled through its own door, a shift draft appeared, a week became worked), and
   * `version` catches none of these cases.
   */
  const targetId = target?.id ?? null;
  const ask = useEffectEvent((_id: string | null) => {
    setShown(null);
    setStaleReason(null);
    setFailure(null);
    if (target) mut.mutate({ request: target, stale: null });
  });
  // The dependency is the request id: a rerender of the same request arrives as a new object and
  // would ask the plan in a loop.
  useEffect(() => ask(targetId), [targetId]);

  return {
    /**
     * The version the shown consequences were computed for — the confirmation sends it. No preview
     * — no answer: the version comes from the request itself, and the return goes as it went
     * before this work (the door's fingerprint is optional).
     */
    version: shown?.version,
    /** Fingerprint of the plan read; `undefined` — nothing to confirm, the door will not ask. */
    fingerprint: shown?.preview.fingerprint,
    /**
     * The answer is still on its way. The dialog passes this to `confirmLoading`: while there are
     * no consequences the click must not go out — there is nothing to promise, while everything
     * would be erased.
     */
    pending: mut.isPending,
    /**
     * Sort out the door's refusal. A 409 is not an error but a question: the consequences changed
     * between reading and clicking, and the dialog's right answer is a fresh list with an
     * explanation, not a "try again" toast. Returns `true` when the refusal is taken over, so the
     * caller's toast stays silent. There are no loops: each round needs a new click.
     */
    recheck: (error: unknown) => {
      if (!target || !isApiError(error) || error.status !== 409) return false;
      mut.mutate({ request: target, stale: STALE_REASON });
      return true;
    },
    node: target ? (
      <RollbackConsequences
        request={target}
        preview={shown?.preview ?? null}
        failure={failure}
        staleReason={staleReason}
        onRetry={() => mut.mutate({ request: target, stale: staleReason })}
      />
    ) : null,
  };
}
