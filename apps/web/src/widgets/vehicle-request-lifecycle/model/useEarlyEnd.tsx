import { useState, type ReactNode } from 'react';
import { App, Button, Space } from 'antd';
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
 * Early-end actions (ADR 0044), one host for both vehicle-request views. Three mutations, two
 * dialogs and the "who approves their own request" rule live together: split per view, they would
 * also drift in behaviour — one place would confirm a rejection, another would not.
 *
 * Since ADR 0178 both applying branches — the approver's own request and an approval of someone
 * else's request — follow the history command canon and require a consequences fingerprint. Hence
 * two dialogs: the request dialog shows consequences as a second step, and the approval, which used
 * to go straight from the list row, got its own dialog. Rejection and withdrawal stay simple: they
 * apply nothing.
 */
export function useEarlyEnd({ renderApproveModal, staleReasonOf }: Input) {
  const { message, modal } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const [target, setTarget] = useState<SpecialEquipmentRequestDto | null>(null);
  /**
   * Rejection asks for a reason: the request stays on the ordered term, and that needs explaining.
   * The dialog is the shared `ReasonModal`, not a `confirm` with its own field: with a home-made
   * field the "reason missing" error came as a toast over the dialog and marked nothing (ADR 0094).
   */
  const [rejectTarget, setRejectTarget] = useState<VehicleRequestDto | null>(null);
  // The request whose early end is being approved: its dialog has its own preview and fingerprint
  // (R19).
  const [approveTarget, setApproveTarget] = useState<SpecialEquipmentRequestDto | null>(null);

  // A shortened term rewrites waybills too: the server reconciles the request's ESM-2 again (ADR
  // 0037), and without this the waybill journal shows shifts that no longer exist.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
    void qc.invalidateQueries({ queryKey: waybillKeys.root });
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  };

  const request = useMutation({
    mutationFn: (value: { id: string; body: RequestVehicleEarlyEndInput }) =>
      vehicleRequestsApi.requestEarlyEnd(value.id, value.body),
    onSuccess: (result) => {
      // The message names what really happened: the server applies an approver's own request at
      // once, and "sent for approval" would be untrue.
      const applied =
        result.requestType === 'special_equipment' && result.earlyEnd?.status === 'approved';
      message.success(applied ? 'Срок заявки сокращён' : 'Запрос отправлен на визу');
      setTarget(null);
      invalidate();
    },
    // "Consequences changed" is not an error but a question, and the dialog answers it: it asks for
    // the plan again and shows the recomputed list with an explanation of why it came back. A toast
    // would be a second voice about the same thing and draw the eye away from the dialog.
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
    // Stale consequences or changed warnings are answered by the approval dialog itself (it
    // recomputes the preview); a toast on top would be a second voice about the same thing.
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

  // An own approval applies at once — the same rule as when creating a request (ADR 0032).
  const approvesOwn = isPlaceScopedRole(user?.role ?? null) && can('vehicleRequests.approve');
  const withdraw = (requestValue: VehicleRequestDto) =>
    modal.confirm({
      title: `Отозвать запрос на досрочное завершение ${requestValue.displayNumber}?`,
      content: 'Срок заявки останется прежним.',
      okText: 'Отозвать',
      cancelText: 'Отмена',
      onOk: () => withdrawRequest.mutateAsync(requestValue.id),
    });

  // A decision is taken after reading the reason in the card. A decided request gets no buttons:
  // approval already shortened the term, while rejection explains why that did not happen.
  // Both the feed and the on-site view use this renderer so their rights and action sets agree.
  const earlyEndActions = (value: VehicleRequestDto) => {
    if (value.requestType !== 'special_equipment' || value.earlyEnd?.status !== 'pending') {
      return null;
    }
    return (
      <Space size={8} wrap>
        {can('vehicleRequests.approve') && (
          <>
            <Button size="small" type="primary" onClick={() => setApproveTarget(value)}>
              Согласовать
            </Button>
            <Button size="small" danger onClick={() => setRejectTarget(value)}>
              Отклонить
            </Button>
          </>
        )}
        {/* Whoever could file the request may withdraw it: the withdrawal reaches both the
            dispatcher and the site. */}
        {can('vehicleRequests.update') && (
          <Button size="small" onClick={() => withdraw(value)}>
            Отозвать запрос
          </Button>
        )}
      </Space>
    );
  };

  return {
    earlyEndActions,
    approve: setApproveTarget,
    approvesOwn,
    close: () => setTarget(null),
    // The rejection dialog: rendered by whoever uses the hook — the hook mounts nothing itself.
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
    /*
     * The approval dialog: consequences of someone else's request computed **for the approver**
     * (R19, R26). This is what approval lacked: "Approve" used to go straight from the list row,
     * and the person approved without seeing what it burns and cancels. The answer is anonymised —
     * numbers and dates, no form numbers: the approver has no access to the waybill journal.
     */
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
    // `mutateAsync`, not `mutate`: the dialog awaits the server answer — a 409 "consequences
    // changed" is cured by showing them again, and it is the dialog that must see the refusal
    // (R17, ADR 0178).
    submit: (body: RequestVehicleEarlyEndInput) =>
      target ? request.mutateAsync({ id: target.id, body }) : undefined,
    target,
    withdraw,
  };
}
