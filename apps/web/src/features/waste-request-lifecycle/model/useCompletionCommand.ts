import { useRef, useState } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { allowedStatusTransitions, type WasteRequestDto } from '@technic/contracts';
import { useAuth } from '@entities/session';
import { wasteTicketKeys } from '@entities/waste-ticket';
import {
  wasteRequestErrorMessage as errorMessage,
  wasteRequestKeys,
  wasteRequestsApi,
} from '@entities/waste-request';
import { isApiError, mayHaveCommittedWrite } from '@shared/api';
import type {
  CompletionOutcome,
  CompletionReload,
  WasteRequestCompletionModalProps,
  WasteRequestCompletionValue,
} from './types';

interface CompletionCommand {
  request: WasteRequestDto;
  value: WasteRequestCompletionValue;
  /** The opening of the completion window the fact was entered in. */
  opening: number;
}

/**
 * The completion window and its one command: the move to «Выполнена» with the fact and tickets.
 *
 * Every answer is bound to the window OPENING it was sent from (snow-removal plan, §3.3). Closing
 * the window and opening it again — on another request or on the same one — starts a new opening,
 * and a late answer of the previous one may neither close the new window nor reload its request.
 *
 * A 409 means the request moved on while the window was open (a second completion, a version
 * drift). The window then reloads the saved fact and ticket links BEFORE the person retries or
 * discards the uploads, and says whether completing is still possible at all (§3.2).
 */
export function useCompletionCommand(invalidateRequests: () => void) {
  const { message } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const [target, setTarget] = useState<WasteRequestDto | null>(null);
  const [reload, setReload] = useState<CompletionReload | null>(null);
  const opening = useRef(0);

  const show = (request: WasteRequestDto | null) => {
    opening.current += 1;
    setTarget(request);
    setReload(null);
  };

  const reloadTarget = async (command: CompletionCommand) => {
    setReload({ pending: true, blocked: true });
    try {
      const fresh = await wasteRequestsApi.get(command.request.id);
      if (command.opening !== opening.current) return;
      setTarget(fresh);
      setReload({
        pending: false,
        // Another completion may have won: the request is already «Выполнена», and the window can
        // only be closed (its uploads discarded) — a retry would be refused the same way.
        blocked:
          !user || !allowedStatusTransitions(fresh.status, user, 'waste', can).includes('done'),
      });
    } catch (error) {
      if (command.opening !== opening.current) return;
      setReload(null);
      message.error(errorMessage(error));
    }
  };

  const mutation = useMutation({
    mutationFn: ({ request, value }: CompletionCommand) =>
      wasteRequestsApi.changeStatus(request.id, 'done', request.version, {
        comment: value.comment,
        completion: value.completion ?? undefined,
        ticketFileIds: value.ticketFileIds,
      }),
    onSuccess: (_saved, command) => {
      invalidateRequests();
      // Completion queues recognition of the tickets under their own cache root (ADR 0150).
      void qc.invalidateQueries({ queryKey: wasteTicketKeys.root });
      if (command.opening === opening.current) show(null);
    },
    onError: (error, command) => {
      message.error(errorMessage(error));
      invalidateRequests();
      if (command.opening !== opening.current) return;
      if (isApiError(error) && error.status === 409) {
        void qc.invalidateQueries({ queryKey: wasteRequestKeys.detail(command.request.id) });
        void reloadTarget(command);
      }
    },
  });

  /**
   * Sends the fact and tells the window what became of it, so the window knows which uploads it
   * may delete: a definite refusal leaves them unattached, a lost answer (5xx, no connection) may
   * hide a committed completion, and its files are kept until the outcome is known.
   */
  const submit = async (value: WasteRequestCompletionValue): Promise<CompletionOutcome> => {
    if (!target) return 'rejected';
    try {
      await mutation.mutateAsync({ request: target, value, opening: opening.current });
      return 'saved';
    } catch (error) {
      return mayHaveCommittedWrite(error) ? 'unknown' : 'rejected';
    }
  };

  const props: WasteRequestCompletionModalProps = {
    canReviewTickets: can('wasteRequests.ticketReview'),
    request: target,
    confirmLoading: mutation.isPending,
    reload,
    onCancel: () => show(null),
    onSubmit: submit,
  };
  return {
    open: (request: WasteRequestDto) => show(request),
    pendingRequestId: mutation.isPending ? mutation.variables?.request.id : undefined,
    props,
  };
}
