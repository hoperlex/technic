import { useState, type ReactNode } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type DecideVehicleEarlyEndBody,
  isPlaceScopedRole,
  type RequestVehicleEarlyEndInput,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDto,
} from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { useAuth } from '@entities/session';
import {
  vehicleRequestErrorMessage as errorMessage,
  vehicleRequestKeys,
  vehicleRequestsApi,
} from '@entities/vehicle-request';
import { waybillKeys } from '@entities/waybill';
import { ReasonModal } from '@shared/ui';
import type { VehicleEarlyEndApproveModalProps } from './types';

interface Input {
  renderApproveModal: (props: VehicleEarlyEndApproveModalProps) => ReactNode;
  staleReasonOf: (error: unknown) => string | null;
}

/**
 * Shared early-end command host. Applying branches use their preview dialogs, while rejection and
 * withdrawal stay simple because they do not change the request term or its forms.
 */
export function useEarlyEnd({ renderApproveModal, staleReasonOf }: Input) {
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const [target, setTarget] = useState<SpecialEquipmentRequestDto | null>(null);
  const [rejectTarget, setRejectTarget] = useState<VehicleRequestDto | null>(null);
  const [approveTarget, setApproveTarget] = useState<SpecialEquipmentRequestDto | null>(null);

  // Shortening a term changes request rows, ESM-2 forms, and garage availability together.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    void qc.invalidateQueries({ queryKey: waybillKeys.root });
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  };

  const request = useMutation({
    mutationFn: (value: { id: string; body: RequestVehicleEarlyEndInput }) =>
      vehicleRequestsApi.requestEarlyEnd(value.id, value.body),
    onSuccess: (result) => {
      const applied =
        result.requestType === 'special_equipment' && result.earlyEnd?.status === 'approved';
      message.success(applied ? 'Срок заявки сокращён' : 'Запрос отправлен на визу');
      setTarget(null);
      invalidate();
    },
    // A stale preview is handled by the open dialog, which immediately recomputes consequences.
    onError: (error) => {
      if (staleReasonOf(error)) return;
      message.error(errorMessage(error));
    },
  });

  const decide = useMutation({
    mutationFn: (value: { id: string; body: DecideVehicleEarlyEndBody }) =>
      vehicleRequestsApi.decideEarlyEnd(value.id, value.body),
    onSuccess: (_result, value) => {
      message.success(value.body.approved ? 'Досрочное завершение согласовано' : 'Запрос отклонён');
      setRejectTarget(null);
      invalidate();
    },
    onError: (error) => {
      if (staleReasonOf(error)) return;
      message.error(errorMessage(error));
    },
  });

  const withdrawRequest = useMutation({
    mutationFn: (id: string) => vehicleRequestsApi.cancelEarlyEnd(id),
    onSuccess: () => {
      message.success('Запрос отозван');
      invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  // A site-scoped approver applies their own shortening immediately instead of creating a queue.
  const approvesOwn = isPlaceScopedRole(user?.role ?? null) && can('vehicleRequests.approve');
  const withdraw = (requestValue: VehicleRequestDto) =>
    modal.confirm({
      title: `Отозвать запрос на досрочное завершение ${requestValue.displayNumber}?`,
      content: 'Срок заявки останется прежним.',
      okText: 'Отозвать',
      cancelText: 'Отмена',
      onOk: () => withdrawRequest.mutateAsync(requestValue.id),
    });

  return {
    approve: setApproveTarget,
    approvesOwn,
    close: () => setTarget(null),
    node: (
      <ReasonModal
        open={!!rejectTarget}
        title={
          rejectTarget
            ? `Отклонить досрочное завершение ${rejectTarget.displayNumber}`
            : 'Отклонить досрочное завершение'
        }
        label="Причина отказа"
        placeholderHint="Например: техника ещё нужна на объекте"
        okText="Отклонить"
        danger
        confirmLoading={decide.isPending}
        onCancel={() => setRejectTarget(null)}
        onSubmit={(reason) =>
          rejectTarget &&
          decide.mutate({
            id: rejectTarget.id,
            body: { approved: false, comment: reason, version: rejectTarget.version },
          })
        }
      />
    ),
    approveNode: renderApproveModal({
      request: approveTarget,
      confirmLoading: decide.isPending,
      onCancel: () => setApproveTarget(null),
      onSubmit: (body) => {
        if (!approveTarget) return undefined;
        return decide.mutateAsync({ id: approveTarget.id, body }).then(() => {
          setApproveTarget(null);
        });
      },
    }),
    open: setTarget,
    pending: request.isPending || decide.isPending || withdrawRequest.isPending,
    reject: setRejectTarget,
    submit: (body: RequestVehicleEarlyEndInput) =>
      target ? request.mutateAsync({ id: target.id, body }) : undefined,
    target,
    withdraw,
  };
}
