import { useState, type ReactNode } from 'react';
import { App, Button, Space } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canRequestEarlyEnd,
  type ConfirmScheduleBody,
  isPlaceScopedRole,
  minRequestDateKey,
  ROLLBACK_WAYBILL_MESSAGE,
  statusChangeRequiresReason,
  transitionRequiresAssignment,
  transitionRequiresCompletion,
  transitionResetsWork,
  type CompleteVehicleRequestInput,
  type RequestStatus,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDto,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { CancelReasonModal, RollbackReasonModal } from '@entities/request';
import { useAuth } from '@entities/session';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestKeys,
  vehicleRequestsApi,
} from '@entities/vehicle-request';
import { vehicleRouteKeys } from '@entities/vehicle-route';
import { waybillKeys } from '@entities/waybill';
import { rollbackErases } from '@features/vehicle-request-lifecycle';
import type {
  AssignmentStatusCommand,
  VehicleCompleteModalProps,
  VehicleEarlyEndApproveModalProps,
  VehicleEarlyEndModalProps,
  VehicleRequestLifecycleController,
} from './types';
import { useEarlyEnd } from './useEarlyEnd';

interface Input {
  renderCompleteModal: (props: VehicleCompleteModalProps) => ReactNode;
  renderEarlyEndApproveModal: (props: VehicleEarlyEndApproveModalProps) => ReactNode;
  renderEarlyEndModal: (props: VehicleEarlyEndModalProps) => ReactNode;
  staleReasonOf: (error: unknown) => string | null;
}

interface StatusCommand {
  assignment?: AssignmentStatusCommand['assignment'];
  comment?: string;
  completion?: CompleteVehicleRequestInput;
  id: string;
  previewFingerprint?: string;
  schedule?: ConfirmScheduleBody;
  status: RequestStatus;
  version: number;
}

/** Own all request lifecycle state while leaving the assignment form as its separate program. */
export function useVehicleRequestLifecycle({
  renderCompleteModal,
  renderEarlyEndApproveModal,
  renderEarlyEndModal,
  staleReasonOf,
}: Input): VehicleRequestLifecycleController {
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const canEdit = can('vehicleRequests.update');
  const canDelete = can('vehicleRequests.delete');
  const canApprove = can('vehicleRequests.approve');
  const canRestore = can('archive.restore');
  const today = minRequestDateKey();
  const [cancelTarget, setCancelTarget] = useState<VehicleRequestDto | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<VehicleRequestDto | null>(null);
  const [assignmentTarget, setAssignmentTarget] = useState<VehicleRequestDto | null>(null);
  const [completeTarget, setCompleteTarget] = useState<VehicleRequestDto | null>(null);

  // Relocations are work created for the assignment and are removed by a rollback with it.
  const { data: rollbackRelocations } = useQuery({
    queryKey: vehicleRequestKeys.relocations(rollbackTarget?.id),
    queryFn: () => vehicleRequestsApi.relocations(rollbackTarget!.id),
    enabled: !!rollbackTarget && rollbackTarget.requestType === 'special_equipment',
  });

  const status = useMutation({
    mutationFn: (value: StatusCommand) =>
      vehicleRequestsApi.changeStatus(value.id, value.status, value.version, {
        comment: value.comment,
        assignment: value.assignment,
        schedule: value.schedule,
        completion: value.completion,
        previewFingerprint: value.previewFingerprint,
      }),
    onSuccess: () => {
      message.success('Статус изменён');
      setCancelTarget(null);
      setRollbackTarget(null);
      setAssignmentTarget(null);
      setCompleteTarget(null);
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const changeStatus = (request: VehicleRequestDto, next: RequestStatus) => {
    if (transitionResetsWork(request.status, next)) {
      setRollbackTarget(request);
      return;
    }
    if (statusChangeRequiresReason(next, request.status)) {
      setCancelTarget(request);
      return;
    }
    if (transitionRequiresAssignment(next)) {
      setAssignmentTarget(request);
      return;
    }
    if (
      transitionRequiresCompletion(next) &&
      (request.requestType === 'special_equipment' || request.assignment)
    ) {
      setCompleteTarget(request);
      return;
    }
    status.mutate({ id: request.id, status: next, version: request.version });
  };

  const approval = useMutation({
    mutationFn: (value: { id: string; approved: boolean; version: number }) =>
      vehicleRequestsApi.setApproval(value.id, value.approved, value.version),
    onSuccess: (_result, value) => {
      message.success(value.approved ? 'Заявка завизирована' : 'Виза снята');
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const changeApproval = (request: VehicleRequestDto, approved: boolean) => {
    if (approved) {
      approval.mutate({ id: request.id, approved, version: request.version });
      return;
    }
    modal.confirm({
      title: `Снять визу с заявки ${request.displayNumber}?`,
      content: 'Пока визы нет, заявку нельзя взять в работу.',
      okText: 'Снять визу',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () =>
        approval.mutateAsync({ id: request.id, approved: false, version: request.version }),
    });
  };

  const removeRequest = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.remove(id),
    onSuccess: (result) => {
      message.success(result.mode === 'hard' ? 'Удалено' : 'Перемещено в архив');
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const restoreRequest = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.restore(id),
    onSuccess: () => {
      message.success('Восстановлено');
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });
  const remove = (request: VehicleRequestDto) =>
    modal.confirm({
      title:
        request.status === 'new'
          ? `Удалить заявку ${request.displayNumber} безвозвратно?`
          : `Переместить заявку ${request.displayNumber} в архив?`,
      okText: request.status === 'new' ? 'Удалить' : 'В архив',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => removeRequest.mutateAsync(request.id),
    });

  const earlyEnd = useEarlyEnd({ renderApproveModal: renderEarlyEndApproveModal, staleReasonOf });
  const canRequest = (request: VehicleRequestDto): request is SpecialEquipmentRequestDto =>
    canEdit &&
    request.requestType === 'special_equipment' &&
    canRequestEarlyEnd(request, today) &&
    request.earlyEnd?.status !== 'pending';
  const canDecide = (request: VehicleRequestDto): request is SpecialEquipmentRequestDto =>
    canApprove &&
    request.requestType === 'special_equipment' &&
    request.earlyEnd?.status === 'pending';
  const canModify = (request: VehicleRequestDto) =>
    !request.deletedAt &&
    (canEdit || canDelete) &&
    (!isPlaceScopedRole(user?.role) || request.status === 'new');

  const earlyEndActions = (request: VehicleRequestDto) => {
    if (request.requestType !== 'special_equipment' || request.earlyEnd?.status !== 'pending') {
      return null;
    }
    return (
      <Space size={8} wrap>
        {canApprove && (
          <>
            <Button size="small" type="primary" onClick={() => earlyEnd.approve(request)}>
              Согласовать
            </Button>
            <Button size="small" danger onClick={() => earlyEnd.reject(request)}>
              Отклонить
            </Button>
          </>
        )}
        {canEdit && (
          <Button size="small" onClick={() => earlyEnd.withdraw(request)}>
            Отозвать запрос
          </Button>
        )}
      </Space>
    );
  };

  const assignmentSubmit = (command: AssignmentStatusCommand) =>
    assignmentTarget
      ? status.mutateAsync({
          id: assignmentTarget.id,
          status: 'confirmed',
          version: assignmentTarget.version,
          assignment: command.assignment,
          schedule: command.schedule ?? undefined,
          previewFingerprint: command.previewFingerprint,
        })
      : undefined;

  return {
    actions: {
      approveEarlyEnd: earlyEnd.approve,
      canDecideEarlyEnd: canDecide,
      canModify,
      canRequestEarlyEnd: canRequest,
      changeApproval,
      changeStatus,
      rejectEarlyEnd: earlyEnd.reject,
      remove,
      requestEarlyEnd: earlyEnd.open,
      restore: (request) => restoreRequest.mutate(request.id),
    },
    assignment: {
      close: () => setAssignmentTarget(null),
      pending: status.isPending,
      submit: assignmentSubmit,
      target: assignmentTarget,
    },
    earlyEndActions,
    node: (
      <>
        {earlyEnd.node}
        {earlyEnd.approveNode}
        {renderEarlyEndModal({
          request: earlyEnd.target,
          onDate: today,
          approvesOwn: earlyEnd.approvesOwn,
          confirmLoading: earlyEnd.pending,
          onCancel: earlyEnd.close,
          onSubmit: earlyEnd.submit,
        })}
        {renderCompleteModal({
          request: completeTarget,
          onDate: today,
          confirmLoading: status.isPending,
          onCancel: () => setCompleteTarget(null),
          onCompleted: () => setCompleteTarget(null),
          onSubmit: ({ completion, comment }) => {
            if (!completeTarget) return;
            status.mutate({
              id: completeTarget.id,
              status: 'done',
              version: completeTarget.version,
              comment,
              completion,
            });
          },
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
          erases={rollbackTarget ? rollbackErases(rollbackTarget, rollbackRelocations ?? []) : []}
          blocker={rollbackTarget?.hasActiveWaybill ? ROLLBACK_WAYBILL_MESSAGE : null}
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
      approvalRequestId: approval.isPending ? approval.variables?.id : undefined,
      statusRequestId: status.isPending ? status.variables?.id : undefined,
    },
    rights: { canApprove, canDelete, canEdit, canRestore },
  };
}
