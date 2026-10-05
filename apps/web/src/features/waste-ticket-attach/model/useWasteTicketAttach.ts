import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WasteRequestDto } from '@technic/contracts';
import {
  wasteRequestErrorMessage as errorMessage,
  wasteRequestKeys,
  wasteRequestsApi,
} from '@entities/waste-request';

/** Attach late ticket evidence and refresh the open card before another upload can start. */
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
    onError: (error) => {
      message.error(errorMessage(error));
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
  });
  return {
    attach: (request: WasteRequestDto, ticketFileIds: string[]) =>
      mutation.mutate({ request, ticketFileIds }),
    pending: mutation.isPending,
  };
}
