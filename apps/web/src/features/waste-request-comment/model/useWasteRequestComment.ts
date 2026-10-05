import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WasteRequestDto } from '@technic/contracts';
import {
  wasteRequestErrorMessage as errorMessage,
  wasteRequestKeys,
  wasteRequestsApi,
} from '@entities/waste-request';

/**
 * Persist the executor note (ADR 0053). The card shows a list-row record, so the saved request is
 * handed back to it at once: otherwise the open card would keep the old version and a second edit
 * in a row would hit a version conflict.
 */
export function useWasteRequestComment(onSaved: (request: WasteRequestDto) => void) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (value: { request: WasteRequestDto; text: string }) =>
      wasteRequestsApi.setOperatorComment(value.request.id, value.text, value.request.version),
    onSuccess: (updated) => {
      onSaved(updated);
      message.success('Комментарий сохранён');
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
    onError: (error) => {
      message.error(errorMessage(error));
      void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });
    },
  });
  return {
    pending: mutation.isPending,
    save: (request: WasteRequestDto, text: string) => mutation.mutate({ request, text }),
  };
}
