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
  const [operatorTarget, setOperatorTarget] = useState<WasteRequestDto | null>(null);
  const [cancelTarget, setCancelTarget] = useState<WasteRequestDto | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<WasteRequestDto | null>(null);
  const [completionTarget, setCompletionTarget] = useState<WasteRequestDto | null>(null);

  const invalidateRequests = () => void qc.invalidateQueries({ queryKey: wasteRequestKeys.root });

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
      // A rollback erases ticket recognition in the same transaction under its own cache root.
      void qc.invalidateQueries({ queryKey: wasteTicketKeys.root });
    },
    onError: (error) => {
      message.error(errorMessage(error));
      invalidateRequests();
    },
  });

  // Assignment changes the version first; the status command must use the returned version.
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

  const changeStatus = (request: WasteRequestDto, next: RequestStatus) => {
    if (transitionResetsWork(request.status, next)) {
      setRollbackTarget(request);
      return;
    }
    if (statusChangeRequiresReason(next, request.status)) {
      setCancelTarget(request);
      return;
    }
    if (request.status === 'new' && next === 'confirmed') {
      setOperatorTarget(request);
      return;
    }
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
