import { useEffect, useState } from 'react';
import { App } from 'antd';
import { useMutation } from '@tanstack/react-query';
import type { AssignmentPreviewDto, VehicleRequestDto } from '@technic/contracts';
import { isApiError } from '@shared/api';
import { vehicleRequestsApi } from '@entities/vehicle-request';
import { errorMessage } from '../../utils/format';
import type { AssignCommand } from './assignCommand';
import {
  ReassignPreview,
  reassignPreviewBlocked,
  reassignPreviewIsSilent,
  reassignStaleReason,
} from './ReassignPreview';

/**
 * The consequences step of a vehicle change (wave 4a of `docs/assignment-periods-plan.md`, §7) —
 * a conversation of its own, taken out of `VehicleAssignModal`.
 *
 * WHY A SEPARATE MODULE. The assign window is a form of vehicle, rates, driver, route and trailer;
 * the consequences step is a conversation with the history door: preview, the person's
 * confirmations, the command with the handshakes the preview handed out, and a recomputed list when
 * the server says the shown one is no longer true. Adding the per-sheet signatures (B4) to that
 * conversation inside the window would grow a file already at its length budget; out here the
 * step is one hook, and the window only asks it to start, confirm, go back and render.
 *
 * WHAT GOES WITH THE COMMAND. Exactly the body the preview was computed from, plus its fingerprint.
 *
 * Only a special-equipment request previews the change: a freight request has neither a term nor
 * weekly paper, and the server asks no fingerprint of it. The window decides that and calls `start`
 * only for it.
 */
export function useReassignConsequences({
  request,
  onSubmit,
}: {
  request: VehicleRequestDto | null;
  /** The window's sender; its promise is awaited — a refusal is the window's business (see below). */
  onSubmit: (v: AssignCommand) => void | Promise<unknown>;
}) {
  const { message } = App.useApp();
  /** Shown consequences and the body they were computed for: the confirmation sends exactly it. */
  const [shown, setShown] = useState<{
    preview: AssignmentPreviewDto;
    payload: AssignCommand;
  } | null>(null);
  /** Why the window came back to the consequences on its own; `null` — the person came normally. */
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const targetId = request?.id ?? null;
  useEffect(() => {
    setShown(null);
    setStaleReason(null);
  }, [targetId]);

  /**
   * Send the command — with the fingerprint of the preview, if one was shown.
   *
   * A 409 at this door is a question, not an error: between reading and pressing the plan changed
   * without touching the request (someone else's command took the date, a sheet was cancelled,
   * midnight), and `version` catches none of it. The answer is a recomputed list with the reason the window stepped
   * back, not a toast. There is no loop: every round needs a press.
   *
   * Any other refusal is swallowed here: the sender has already said it.
   */
  function send(payload: AssignCommand, preview?: AssignmentPreviewDto): void {
    const command = preview ? { ...payload, previewFingerprint: preview.fingerprint } : payload;
    void Promise.resolve(onSubmit(command)).catch((e: unknown) => {
      const reason = reassignStaleReason(e);
      if (reason) mut.mutate({ payload, stale: reason });
    });
  }

  const mut = useMutation({
    /*
     * The same body the command will carry: the plan is computed from the vehicle, the driver and
     * the correction block, and a second assembly would drift from the first — and the fingerprint
     * with it.
     */
    mutationFn: async (v: { payload: AssignCommand; stale: string | null }) => ({
      ...v,
      preview: await vehicleRequestsApi.assignmentPreview(request!.id, {
        ...v.payload.assignment,
        version: request!.version,
        ...(v.payload.correction ? { correction: v.payload.correction } : {}),
      }),
    }),
    onSuccess: ({ payload, preview, stale }) => {
      /*
       * Nothing to talk about — the command goes at once, with the fingerprint. No second screen on
       * purpose: an empty "nothing will happen, press again" teaches pressing without reading, and
       * then the screen fails the one time it has something to say.
       *
       * After a 409 the rule is lifted: silently repeating a command the server has just refused
       * would do it behind the person's back, even if the recomputed plan came out empty.
       */
      if (!stale && reassignPreviewIsSilent(preview)) {
        send(payload, preview);
        return;
      }
      setStaleReason(stale);
      setShown({ preview, payload });
    },
    onError: (e, v) => {
      /*
       * The server is older than the portal: it has no preview handle yet and asks no fingerprint
       * (phase `legacy`, I5). The rollout is not atomic, so the vehicle change goes the old way —
       * exactly as before this wave. Only on the first round: after a 409 the fingerprint is
       * required by definition, and "quietly send without it" would bypass the guard that fired.
       */
      if (isApiError(e) && (e.status === 404 || e.status === 405) && !v.stale) {
        send(v.payload);
        return;
      }
      message.error(errorMessage(e));
    },
  });

  return {
    /** The consequences are on screen: the window is on its second step. */
    shown: !!shown,
    pending: mut.isPending,
    /** Ask the consequences of the filled form. */
    start: (payload: AssignCommand) => mut.mutate({ payload, stale: null }),
    /** Confirm what is shown: the command goes with exactly the body the preview was computed for. */
    confirm: () => {
      if (shown) send(shown.payload, shown.preview);
    },
    back: () => {
      setShown(null);
      setStaleReason(null);
    },
    /*
     * Days signed by the site lock the command — the server refuses on the same condition (R18).
     * The button goes out and the reason stands in the body: a dead button without one reads as
     * broken.
     */
    okDisabled: shown ? reassignPreviewBlocked(shown.preview) : undefined,
    node: shown ? <ReassignPreview preview={shown.preview} staleReason={staleReason} /> : null,
  };
}
