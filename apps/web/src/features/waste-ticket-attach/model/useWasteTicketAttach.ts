import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WasteRequestDto } from '@technic/contracts';
import { isApiError } from '@shared/api';
import {
  wasteRequestErrorMessage as errorMessage,
  wasteRequestKeys,
  wasteRequestsApi,
} from '@entities/waste-request';

/**
 * Attach tickets to a completed request (ADR 0189). The card shows a list-row record, so the
 * updated request is handed back to it at once: otherwise the open card would keep the old version
 * and the old paper list, and a second upload in a row would hit a version conflict.
 *
 * `onSaved` may be called after the card moved to another request or closed; it must ignore an
 * answer about a request it no longer shows (snow-removal plan, §3.3).
 */
export function useWasteTicketAttach(onSaved: (request: WasteRequestDto) => void) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (value: { request: WasteRequestDto; ticketFileIds: string[] }) =>
      wasteRequestsApi.addTickets(value.request.id, value.ticketFileIds, value.request.version),
    onSuccess: (updated, value) => {
      onSaved(updated);
      message.success(value.ticketFileIds.length === 1 ? 'Талон приложен' : 'Талоны приложены');
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
    onError: (error, value) => {
      message.error(errorMessage(error));
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
      // A 409 means the request moved on (a rollback, another attach): the card gets the saved
      // ticket links and version before the person retries or discards the uploads (§3.2). The
      // card decides whether the answer still concerns the request it shows.
      if (isApiError(error) && error.status === 409) {
        void wasteRequestsApi
          .get(value.request.id)
          .then(onSaved)
          .catch(() => undefined);
      }
    },
  });
  return {
    attach: (request: WasteRequestDto, ticketFileIds: string[]) =>
      mutation.mutate({ request, ticketFileIds }),
    pending: mutation.isPending,
  };
}
