import { useState } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type AnnulWeeklyRequestBody,
  WEEKLY_RETURN_PERMISSION,
  weeklyAnnulHeaderBlocker,
  weeklyAnnulPermission,
  weeklyReturnHeaderBlocker,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { weeklyRequestKeys, weeklyRequestsApi } from '@entities/weekly-request';
import { hasApiStatus } from './apiError';
import { WEEKLY_REVERSAL_TEXTS, type WeeklyReversalIntent } from './reversalTexts';

/**
 * Cache key of the window's preview for the intent. The window that asks and the hook that rereads
 * it after a refusal share this one function: two copies would drift, and the reread would then
 * refresh a key nobody displays.
 */
export function weeklyReversalPreviewKey(intent: WeeklyReversalIntent, id: string | undefined) {
  return intent === 'annul' ? weeklyRequestKeys.annul(id) : weeklyRequestKeys.returnPreview(id);
}

/**
 * Wiring of a reversal of an applied week — annulment (ADR 0218) or return for re-approval
 * (ADR 0219): whether the window is open, whether the button exists and what to tell the person
 * about the result.
 *
 * Its own module rather than part of the page: the page already holds composition, submission,
 * approval, backdated conduct and cancellation, and the file length budget is the only guard
 * against a seventh scenario being written into the same file.
 *
 * Button availability comes from the contracts. Annulment's right depends on the removed days,
 * which only the server knows, so its button follows the UNION of both branches and the window's
 * preview says what will be required. The return has one right in both branches.
 */
export function useWeeklyReversal(params: {
  intent: WeeklyReversalIntent;
  request: WeeklyVehicleRequestDto | undefined;
  /** Done: the page clears the previous refusal and rereads the related feeds. */
  onSettled: () => void;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  // The right and the message are taken here rather than passed in: this is the hook, and extra
  // parameters would mean the page decides what the hook decides.
  const { can } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const texts = WEEKLY_REVERSAL_TEXTS[params.intent];

  const mutation = useMutation({
    mutationFn: (body: AnnulWeeklyRequestBody) =>
      params.intent === 'annul'
        ? weeklyRequestsApi.annul(params.request!.id, body)
        : weeklyRequestsApi.returnToApproval(params.request!.id, body),
    onSuccess: (result) => {
      setOpen(false);
      // The result in numbers, not "done": the person has just agreed to burn form numbers, and
      // what was reversed must be visible without opening the history.
      const parts = [
        result.shortened.length > 0 ? `сроков возвращено: ${result.shortened.length}` : null,
        result.cancelled.length > 0 ? `заказов отменено: ${result.cancelled.length}` : null,
        result.esm2.cancelled > 0 ? `листов аннулировано: ${result.esm2.cancelled}` : null,
      ].filter((part) => part !== null);
      // A repeat after a dropped connection carries no counters (ADR 0101 decision 9): the first
      // attempt did the work, and the server only confirms that nothing was moved again.
      message.success(
        result.repeated
          ? `${texts.done} — запрос уже был выполнен, повторно ничего не изменено`
          : parts.length > 0
            ? `${texts.done} — ${parts.join(', ')}`
            : texts.done,
      );
      params.onSettled();
    },
    onError: (error) => {
      // A 422 means the plan in the window is stale: the server found a blocker after the window
      // asked. Unless the plan is reread, the window keeps saying "allowed" with an active button,
      // and every click walks into the same refusal; the reread shows the blockers instead. A 409
      // needs no branch here: the page rereads the whole request prefix, previews included.
      if (hasApiStatus(error, 422) && params.request) {
        void queryClient.invalidateQueries({
          queryKey: weeklyReversalPreviewKey(params.intent, params.request.id),
        });
      }
      params.onError(error);
    },
  });

  // Rights come from the server via `useAuth` (access model §10); which permission each command
  // needs, and which headers it accepts, come from the contracts — the same carriers the server
  // asks. Annulment's branch is known only to the server, so its button follows either branch.
  const allowedByRight =
    params.intent === 'annul'
      ? [...weeklyAnnulPermission(false), ...weeklyAnnulPermission(true)].some(can)
      : can(WEEKLY_RETURN_PERMISSION);
  const headerBlocker =
    params.intent === 'annul' ? weeklyAnnulHeaderBlocker : weeklyReturnHeaderBlocker;
  const available = !!params.request && headerBlocker(params.request) === null && allowedByRight;

  return {
    /** Request for the window; `null` — the window is closed. */
    target: open && params.request ? params.request : null,
    /** Button handler; `null` — no button at all. */
    onOpen: available ? () => setOpen(true) : null,
    onClose: () => setOpen(false),
    onSubmit: (body: AnnulWeeklyRequestBody) => mutation.mutate(body),
    pending: mutation.isPending,
  };
}
