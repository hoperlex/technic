import { useState, type ReactNode } from 'react';
import { App } from 'antd';
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
  /**
   * Fingerprint of the consequences shown by the assignment dialog's second step (§5.4 of the
   * plan). Sent only with the "done" -> "confirmed" rollback: there the portal promised an exact
   * ESM-2 reconciliation result, and the server verifies the promise still holds.
   */
  previewFingerprint?: string;
  /** Actual term refined when taking into work: ordered for one time, started at another. */
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
  // Cancelling requires a reason, entered in its own dialog.
  const [cancelTarget, setCancelTarget] = useState<VehicleRequestDto | null>(null);
  /**
   * The request being returned from work to "new" (`transitionResetsWork`). Separate from the
   * cancellation: the reason dialog is shared, but the list of what gets erased is its own and
   * shows what exactly this request loses. Mixed into one state, the dialog would not know what to
   * show.
   */
  const [rollbackTarget, setRollbackTarget] = useState<VehicleRequestDto | null>(null);
  // Taking into work means choosing the vehicle and rates (ADR 0027): the assignment travels with
  // the status change.
  const [assignmentTarget, setAssignmentTarget] = useState<VehicleRequestDto | null>(null);
  // Completion asks for worked time and cost (ADR 0029): the fact travels with the status too.
  const [completeTarget, setCompleteTarget] = useState<VehicleRequestDto | null>(null);

  /**
   * Relocations of the request being returned to "new" (migration 0082): they drive for this
   * request on its assigned vehicle, so the rollback erases them together with the assignment.
   * Fetched only while the dialog is open and only for on-site orders — freight has no
   * relocations, and an extra request per list row for a dialog opened once a month is pointless.
   * Same key as the request card: a card opened just before answers from cache.
   */
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
      // A rollback to "new" removes the vehicle, and with it the request and its relocations leave
      // their routes: route lists are stale after such a transition. The invalidation is shared by
      // all transitions — closing and cancelling a request touch routes as well.
      void qc.invalidateQueries({ queryKey: vehicleRouteKeys.root });
      // Taking into work issues a waybill, and closing or cancelling rewrites it (ADR 0037): the
      // waybill journal would show something other than the database after a status change.
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const changeStatus = (request: VehicleRequestDto, next: RequestStatus) => {
    // A return from work to "new" erases everything the request gained in work
    // (`transitionResetsWork`) and asks for a reason in the same dialog as a cancellation, but with
    // its own list of what is erased: the person must see what this request loses before the click.
    if (transitionResetsWork(request.status, next)) {
      setRollbackTarget(request);
      return;
    }
    if (statusChangeRequiresReason(next, request.status)) {
      setCancelTarget(request);
      return;
    }
    // "In work" never exists without a vehicle: the request is taken by a concrete unit at a
    // concrete rate.
    if (transitionRequiresAssignment(next)) {
      setAssignmentTarget(request);
      return;
    }
    /*
     * Closing asks for the fact. For freight only where there is something to compute from: a
     * request taken into work before ADR 0027 has no vehicle and no rate; the server decides the
     * same way. For an on-site order the dialog opens **always** (ADR 0178): it closes through its
     * own door, which demands the fact without exception — the status handler that closed such a
     * request with a dash in the sum no longer exists. An order without assigned equipment goes
     * through the same dialog: the sum is entered by hand there.
     */
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

  // Removing the approval is confirmed: without it the request can no longer be taken into work.
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

  // Early end (ADR 0044): requesting a shorter term, deciding on it and withdrawing it. The
  // actions are shared with the "On site" view, where they are used more often, hence one hook.
  const earlyEnd = useEarlyEnd({ renderApproveModal: renderEarlyEndApproveModal, staleReasonOf });
  // Narrowing predicates: only an on-site order is ended early, and the dialog expects exactly it.
  const canRequest = (request: VehicleRequestDto): request is SpecialEquipmentRequestDto =>
    canEdit &&
    request.requestType === 'special_equipment' &&
    canRequestEarlyEnd(request, today) &&
    request.earlyEnd?.status !== 'pending';
  const canDecide = (request: VehicleRequestDto): request is SpecialEquipmentRequestDto =>
    canApprove &&
    request.requestType === 'special_equipment' &&
    request.earlyEnd?.status === 'pending';
  // The customer edits a request while it is "new" (ADR 0040 item 5) — a rule of both axes, asked
  // by the same predicate as on the server: the object axis alone would give a department a button
  // that ends in a refusal.
  const canModify = (request: VehicleRequestDto) =>
    !request.deletedAt &&
    (canEdit || canDelete) &&
    (!isPlaceScopedRole(user?.role) || request.status === 'new');

  // `mutateAsync`, not `mutate`: right after the transition the dialog calls the 4-P day batch as
  // a second request (ADR 0207), and days are planned only for a request already taken into work.
  const assignmentSubmit = (command: AssignmentStatusCommand) =>
    assignmentTarget
      ? status.mutateAsync({
          id: assignmentTarget.id,
          status: 'confirmed',
          version: assignmentTarget.version,
          assignment: command.assignment,
          // The dialog always asks for the term when taking into work — `null` never comes here.
          schedule: command.schedule ?? undefined,
          // Only the "done" -> "confirmed" rollback sends it: other transitions do not call the
          // preview, and there is nothing promised to the server.
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
    earlyEndActions: earlyEnd.earlyEndActions,
    node: (
      <>
        {/* Rejecting an early-end request: the reason is asked by the hook's dialog. */}
        {earlyEnd.node}
        {/* Approval of someone else's request has its own dialog and preview (ADR 0178, R19): it
            applies the shortening and must show consequences before the click. */}
        {earlyEnd.approveNode}
        {/* Early end — the same dialog as on the "On site" view (ADR 0044). */}
        {renderEarlyEndModal({
          request: earlyEnd.target,
          onDate: today,
          approvesOwn: earlyEnd.approvesOwn,
          confirmLoading: earlyEnd.pending,
          onCancel: earlyEnd.close,
          onSubmit: earlyEnd.submit,
        })}
        {/* Completion: worked time and cost (ADR 0029), plus the actual end date for an on-site
            order (ADR 0178). The on-site order is closed by the dialog through its own door and
            preview — the "done" status handler refuses it; `onSubmit` remains only for freight,
            which still closes the old way. */}
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
        {/* Return to "new": the reason is mandatory like a cancellation reason, and above the field
            is the list of what the request loses. A request with an issued waybill cannot be
            rolled back (`ROLLBACK_WAYBILL_MESSAGE`): work that went into an issued form must not
            be erased — said here, before a reason is typed in vain. */}
        <RollbackReasonModal
          open={!!rollbackTarget}
          subject={rollbackTarget ? `№ ${rollbackTarget.displayNumber}` : ''}
          erases={rollbackTarget ? rollbackErases(rollbackTarget, rollbackRelocations ?? []) : []}
          // A flag of the request itself, not of its route (ADR 0207). An on-site order has no
          // route of its own — the paperwork hangs on day routes and relocations — so
          // `route.hasWaybill` always answered "no waybill": the dialog opened, the person typed a
          // reason and hit 409. Relocations are not checked separately: the flag already covers
          // them (`activeWaybillOfRequest`), and a second check would copy the server rule.
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
