import { App } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { serviceRequestKeys } from '@entities/service-request';
import { isApiError } from '@shared/api';
import { errorMessage } from '@shared/lib';

/**
 * A refusal of any of the window's commands: said in words, and on 409 the request is reread.
 *
 * 409 here means the request moved under the window (a colleague's save, a submission from another
 * screen). Rereading this request's own card record brings the newer version, and the window then
 * shows the notice with "Reload" by itself (stage 5 plan §4.5, decision R6-a) instead of leaving the
 * person with a refusal and no way to see what changed. Only the detail of this request is reread:
 * it is a read, not a change of what the commands invalidate on success.
 */
export function useEstimateFailure(requestId: string | null): (error: unknown) => void {
  const { message } = App.useApp();
  const qc = useQueryClient();
  return (error) => {
    message.error(errorMessage(error));
    if (requestId && isApiError(error) && error.status === 409) {
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.detail(requestId), exact: true });
    }
  };
}
