import { useState, type ReactNode } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isPlaceScopedRole,
  statusChangeRequiresReason,
  transitionResetsWork,
  type CompleteWasteRequestInput,
  type RequestStatus,
  type WasteRequestDto,
} from '@technic/contracts';
import { CancelReasonModal, RollbackReasonModal } from '@entities/request';
import { useAuth } from '@entities/session';
import { wasteTicketKeys } from '@entities/waste-ticket';
import {
  wasteRequestErrorMessage as errorMessage,
  wasteRequestKeys,
  wasteRequestsApi,
  wasteRollbackErases,
} from '@entities/waste-request';
import type {
  WasteRequestCompletionModalProps,
  WasteRequestLifecycleController,
  WasteRequestOperatorModalProps,
} from './types';

interface Input {
  renderCompletion: (props: WasteRequestCompletionModalProps) => ReactNode;
  renderOperator: (props: WasteRequestOperatorModalProps) => ReactNode;
}

interface StatusCommand {
  comment?: string;
  completion?: CompleteWasteRequestInput;
  id: string;
  status: RequestStatus;
  ticketFileIds?: string[];
  version: number;
}

/** Own lifecycle state and cache effects while operation-specific forms remain separate features. */
export function useWasteRequestLifecycle({
  renderCompletion,
  renderOperator,
}: Input): WasteRequestLifecycleController {
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const canEdit = can('wasteRequests.update');
  const canDelete = can('wasteRequests.delete');
  const canRestore = can('archive.restore');
  // Starting work and cancelling go through modals because both need input (the operator, the
  // reason), so the target request is kept in state.
  const [operatorTarget, setOperatorTarget] = useState<WasteRequestDto | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WasteRequestDto | null>(null);
  // A rollback to "new" (transitionResetsWork) is separate state from cancellation: both use one
  // reason modal, but a rollback also lists what it erases, and a single state could not tell
  // the two apart.
  const [rollbackTarget, setRollbackTarget] = useState<WasteRequestDto | null>(null);
  // Completion: the fact (volume and cost, or only a ticket) and the comment are entered in their
  // own modal and sent together with the status in one request.
  const [completionTarget, setCompletionTarget] = useState<WasteRequestDto | null>(null);

  const invalidateRequests = () => void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });

  // The completion modal already hands over the request body: the actual volume with its cost
  // (ADR 0035) and the request tickets; this command only attaches them to the status change.
  const status = useMutation({
    mutationFn: (value: StatusCommand) =>
      wasteRequestsApi.changeStatus(value.id, value.status, value.version, {
        comment: value.comment,
        completion: value.completion,
        ticketFileIds: value.ticketFileIds,
      }),
    onSuccess: () => {
      setCancelTarget(null);
      setRollbackTarget(null);
      setCompletionTarget(null);
      invalidateRequests();
      // A rollback to "new" erases the tickets with their pages and accepted mismatches in the same
      // transaction as the status (purgeRequestRecognition), under their own cache root. Without
      // this the card would keep listing them and offer actions on rows that no longer exist.
      void qc.invalidateQueries({ queryKey: wasteTicketKeys.root });
    },
    onError: (error) => {
      message.error(errorMessage(error));
      invalidateRequests();
    },
  });

  // Moving into work assigns the executor: from then on the operator sees the request (ADR 0010).
  // Two sequential requests: assignment bumps the request version, so the status change must use
  // the version returned by the assignment.
  const startWork = useMutation({
    mutationFn: async (value: {
      request: WasteRequestDto;
      operatorCounterpartyId: string;
      ownerMismatchReason?: string;
    }) => {
      const assigned = await wasteRequestsApi.assignOperator(
        value.request.id,
        value.operatorCounterpartyId,
        value.request.version,
        value.ownerMismatchReason,
      );
      return wasteRequestsApi.changeStatus(assigned.id, 'confirmed', assigned.version);
    },
    onSuccess: () => {
      setOperatorTarget(null);
      invalidateRequests();
    },
    onError: (error) => {
      message.error(errorMessage(error));
      invalidateRequests();
    },
  });

  /**
   * Starting work goes through operator assignment; completion through the fact-and-ticket modal;
   * cancellation and rollback to "new" through a mandatory reason. Other rollbacks run at once:
   * they erase nothing, so there is nothing to explain.
   */
  const changeStatus = (request: WasteRequestDto, next: RequestStatus) => {
    // Rollback to "new" erases what the work produced (transitionResetsWork): the removal fact and
    // tickets. It asks for a reason in the cancellation modal but lists above the field what this
    // request will lose, because after the click there is nothing to restore.
    if (transitionResetsWork(request.status, next)) {
      setRollbackTarget(request);
      return;
    }
    if (statusChangeRequiresReason(next, request.status)) {
      setCancelTarget(request);
      return;
    }
    // The operator modal preselects an executor already chosen in the request itself, so it then
    // only confirms that choice (WasteOperatorAssignmentModal).
    if (request.status === 'new' && next === 'confirmed') {
      setOperatorTarget(request);
      return;
    }
    // Completion goes through the modal for every request type: container operations also present
    // a ticket, and every completion needs its comment (ADR 0013).
    if (next === 'done') {
      setCompletionTarget(request);
      return;
    }
    status.mutate({ id: request.id, status: next, version: request.version });
  };

  const removeRequest = useMutation({
    mutationFn: (id: string) => wasteRequestsApi.remove(id),
    onSuccess: (result) => {
      message.success(result.mode === 'hard' ? 'Заявка удалена' : 'Заявка перемещена в архив');
      invalidateRequests();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const restoreRequest = useMutation({
    mutationFn: (id: string) => wasteRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Заявка восстановлена');
      invalidateRequests();
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const remove = (request: WasteRequestDto) =>
    modal.confirm({
      title: request.status === 'new' ? 'Удалить заявку?' : 'Переместить заявку в архив?',
      content:
        request.status === 'new'
          ? 'Заявка в статусе «Новая» будет удалена безвозвратно вместе с файлами.'
          : 'Заявка будет помечена удалённой (soft-delete) и может быть восстановлена администратором.',
      okText: 'Подтвердить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeRequest.mutateAsync(request.id),
    });
  // A place-scoped customer (site or department role) edits a request only until it is taken into
  // work: after that it is bound by arrangements with the executor. This is the same predicate as
  // the server's assertObjectRoleEditable (apps/api/src/lib/access.ts), and this copy must match
  // it: if they diverge, the portal either offers edits the API rejects or hides allowed ones.
  // The rule is about the customer, not the site, so a department role on its site falls under it.
  const canModify = (request: WasteRequestDto) =>
    !request.deletedAt &&
    (canEdit || canDelete) &&
    (!isPlaceScopedRole(user?.role) || request.status === 'new');

  return {
    actions: {
      canModify,
      changeStatus,
      remove,
      restore: (request) => restoreRequest.mutate(request.id),
    },
    node: (
      <>
        {renderOperator({
          request: operatorTarget,
          confirmLoading: startWork.isPending,
          onCancel: () => setOperatorTarget(null),
          onSubmit: (value) =>
            operatorTarget && startWork.mutate({ request: operatorTarget, ...value }),
        })}
        {renderCompletion({
          request: completionTarget,
          confirmLoading: status.isPending,
          onCancel: () => setCompletionTarget(null),
          // Completion facts: removal reports actual volume and cost (ADR 0035), container
          // operations a ticket (ADR 0013); a ticket is mandatory in both cases (ADR 0020), and a
          // difference from the planned volume is a hint that does not block saving.
          onSubmit: (value) =>
            completionTarget &&
            status.mutate({
              id: completionTarget.id,
              status: 'done',
              version: completionTarget.version,
              comment: value.comment,
              completion: value.completion ?? undefined,
              ticketFileIds: value.ticketFileIds,
            }),
        })}
        <CancelReasonModal
          open={!!cancelTarget}
          subject={cancelTarget ? `№ ${cancelTarget.displayNumber}` : ''}
          confirmLoading={status.isPending}
          onCancel={() => setCancelTarget(null)}
          onSubmit={(reason) =>
            cancelTarget &&
            status.mutate({
              id: cancelTarget.id,
              status: 'cancelled',
              version: cancelTarget.version,
              comment: reason,
            })
          }
        />
        {/* Rollback to "new": the reason is as mandatory as a cancellation reason (the server
            requires it too), and above the field the modal lists what this request will lose. */}
        <RollbackReasonModal
          open={!!rollbackTarget}
          subject={rollbackTarget ? `№ ${rollbackTarget.displayNumber}` : ''}
          erases={rollbackTarget ? wasteRollbackErases(rollbackTarget) : []}
          confirmLoading={status.isPending}
          onCancel={() => setRollbackTarget(null)}
          onSubmit={(reason) =>
            rollbackTarget &&
            status.mutate({
              id: rollbackTarget.id,
              status: 'new',
              version: rollbackTarget.version,
              comment: reason,
            })
          }
        />
      </>
    ),
    pending: {
      statusRequestId: status.isPending && status.variables ? status.variables.id : undefined,
    },
    rights: { canDelete, canEdit, canRestore },
  };
}
