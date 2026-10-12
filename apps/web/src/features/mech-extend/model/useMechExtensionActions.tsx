import { useState, type ReactNode } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MechRequestDto } from '@technic/contracts';
import { mechFailureText, mechRequestKeys, mechRequestsApi } from '@entities/mech-request';
import { MechExtensionRequestModal } from '../ui/MechExtensionRequestModal';
import {
  MechExtensionDecisionModal,
  type MechExtensionDecision,
} from '../ui/MechExtensionDecisionModal';

/**
 * The windows and the one window-less mutation of the extension visa (ADR 0171, stage 3): the
 * request window, the decision window in its two modes and the withdrawal behind a confirmation.
 *
 * What is available is not decided here — the menu and the card strip ask `mechExtensionAccess`
 * of the contracts. Like the rest of the module's actions, one set lives per call site (ADR 0140):
 * the windows of a list row live at the tab, the windows of the card inside the card.
 */
export function useMechExtensionActions(): {
  openRequest: (request: MechRequestDto) => void;
  openDecision: (request: MechRequestDto, mode: MechExtensionDecision) => void;
  withdraw: (request: MechRequestDto) => void;
  close: () => void;
  modals: ReactNode;
  pending: boolean;
} {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const [requestTarget, setRequestTarget] = useState<MechRequestDto | null>(null);
  const [decision, setDecision] = useState<{
    request: MechRequestDto;
    mode: MechExtensionDecision;
  } | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: mechRequestKeys.root });

  const withdrawMutation = useMutation({
    mutationFn: (request: MechRequestDto) =>
      mechRequestsApi.withdrawExtension(request.id, request.version),
    onSuccess: () => {
      message.success('Запрос продления отозван');
      refresh();
    },
    onError: (e) => {
      message.error(mechFailureText(e));
      // A 409 means the row under the hand is already another one; keeping the old one on screen
      // would invite the same mistake again.
      refresh();
    },
  });

  /**
   * Withdrawal asks first: the visa holder may be reading the request right now, and after the
   * withdrawal there is nothing for him to sign. The text names the consequence, not the action.
   */
  const withdraw = (request: MechRequestDto) => {
    modal.confirm({
      title: `Отозвать запрос продления ${request.displayNumber}?`,
      content: 'Срок аренды останется прежним, а визировать площадке будет нечего.',
      okText: 'Отозвать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => withdrawMutation.mutateAsync(request),
    });
  };

  const close = () => {
    setRequestTarget(null);
    setDecision(null);
  };

  const modals = (
    <>
      <MechExtensionRequestModal request={requestTarget} onClose={() => setRequestTarget(null)} />
      <MechExtensionDecisionModal
        request={decision?.request ?? null}
        mode={decision?.mode ?? 'approve'}
        onClose={() => setDecision(null)}
      />
    </>
  );

  return {
    openRequest: setRequestTarget,
    openDecision: (request, mode) => setDecision({ request, mode }),
    withdraw,
    close,
    modals,
    pending: withdrawMutation.isPending,
  };
}
