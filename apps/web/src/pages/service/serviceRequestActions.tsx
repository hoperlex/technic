import { useState, type ReactNode } from 'react';
import { App } from 'antd';
import {
  AuditOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  MailOutlined,
  PlayCircleOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  actsForCounterparty,
  allowedServiceStatusTransitions,
  can as hasPermission,
  isServiceRequestEditable,
  moduleMailOutcomeLabels,
  serviceMailRepeatable,
  type ModuleMailOutcome,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { AssignServiceModal } from '@features/assign-service';
import { EstimateEditorModal } from '@features/estimate-editor';
import { EstimateApprovalModal } from '@features/estimate-approval';
import { ServiceCompleteModal } from '@features/service-complete';
import { ServiceAcceptModal, type AcceptMode } from '@features/service-accept';
import { EquipmentMoveFromRequest } from '@features/equipment-move';
import { ItApprovalModal } from '@features/it-approval';
import { ServiceUrgencyModal } from '@features/service-urgency';
import type { ActionSheetItem } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { serviceReasonPrompts, type ReasonPrompt } from './serviceRequestPrompts';
import { ReasonModal } from '../../components/CancelReasonModal';
import { errorMessage } from '../../utils/format';

/**
 * Действия заявки строятся из **коридора переходов**, а не из списка ролей (§5.2).
 *
 * `allowedServiceStatusTransitions` — одна функция на сервер и портал: сервис получает коридор
 * исполнителя, оператор оргтехники — свой, администратор — их объединение с откатами. Спроси
 * компонент вместо неё имя роли, и кнопка либо вела бы в 403, либо пропадала бы у того, кому
 * действие разрешено, — и обнаружилось бы это на экране, а не в тестах.
 *
 * Дуга бывает одна, а ручек к ней две: `assigned → new` для исполнителя — это «отказаться»
 * (`/decline`), а для администратора — откат (`/status`). Выбирает специализированную ручку
 * возможность субъекта, а не его имя: специализированная знает условие своего перехода, общий
 * `/status` — только причину.
 */
export function useServiceRequestActions(): {
  actionsFor: (request: ServiceRequestDto) => ActionSheetItem[];
  modals: ReactNode;
  pending: boolean;
} {
  const { user } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();

  const [assignTarget, setAssignTarget] = useState<ServiceRequestDto | null>(null);
  const [estimateTarget, setEstimateTarget] = useState<ServiceRequestDto | null>(null);
  const [approvalTarget, setApprovalTarget] = useState<ServiceRequestDto | null>(null);
  const [completeTarget, setCompleteTarget] = useState<ServiceRequestDto | null>(null);
  const [acceptTarget, setAcceptTarget] = useState<{
    request: ServiceRequestDto;
    mode: AcceptMode;
  } | null>(null);
  const [urgencyTarget, setUrgencyTarget] = useState<ServiceRequestDto | null>(null);
  const [itTarget, setItTarget] = useState<ServiceRequestDto | null>(null);
  const [moveTarget, setMoveTarget] = useState<ServiceRequestDto | null>(null);
  const [prompt, setPrompt] = useState<ReasonPrompt | null>(null);

  /**
   * Переходы с одной лишь причиной идут одной мутацией: гасит кэш и сообщает об успехе она одна,
   * поэтому «отказался», «переоткрыл» и «отменил» не могут разойтись в поведении.
   */
  const reasonMutation = useMutation({
    mutationFn: (task: { run: () => Promise<unknown>; success: string }) => task.run(),
    onSuccess: (result, task) => {
      message.success(task.success);
      // Отмена шлёт письмо службе: «не выезжайте». Если письма не будет, человек узнаёт об этом
      // здесь же — служба читает почту, а не портал.
      const outcome = (result as { mail?: ModuleMailOutcome } | null)?.mail;
      if (outcome && outcome !== 'queued') message.warning(moduleMailOutcomeLabels[outcome]);
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      setPrompt(null);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Повторная отправка письма службе (Р70). Ключ идемпотентности живёт до успеха: два нажатия
   * подряд дают одно письмо, а осознанный повтор после ответа — новое.
   */
  const [notifyKey, setNotifyKey] = useState(() => crypto.randomUUID());
  const notifyMutation = useMutation({
    mutationFn: (request: ServiceRequestDto) =>
      serviceRequestsApi.notify(request.id, { idempotencyKey: notifyKey }),
    onSuccess: (res) => {
      setNotifyKey(crypto.randomUUID());
      if (res.mail === 'queued') {
        message.success(`Письмо службе поставлено в очередь: ${res.recipients.join(', ')}`);
      } else {
        message.warning(moduleMailOutcomeLabels[res.mail]);
      }
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Взятие в диагностику — единственное действие без содержания: подтверждать нечего. */
  const startMutation = useMutation({
    mutationFn: (request: ServiceRequestDto) =>
      serviceRequestsApi.start(request.id, { version: request.version }),
    onSuccess: () => {
      message.success('Заявка взята в диагностику');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const actionsFor = (request: ServiceRequestDto): ActionSheetItem[] => {
    // Архивной заявке ход не положен: её либо восстанавливают, либо сносят — это действия архива.
    if (request.deletedAt) return [];

    const allowed = allowedServiceStatusTransitions(request.status, user);
    const has = (status: (typeof allowed)[number]) => allowed.includes(status);
    const executor = actsForCounterparty(user, 'service');
    const items: ActionSheetItem[] = [];
    const ask = (p: ReasonPrompt) => setPrompt(p);
    // Переходы «только с причиной» собраны отдельно: их шесть, и различаются они подписями, а не
    // поведением (`serviceRequestPrompts.ts`).
    const prompts = serviceReasonPrompts(request, executor);

    /*
     * Виза ИТ (Р51) — первый шаг цикла: до неё сервис не назначают. Одно действие на согласие и
     * отказ: решение одно, и разводить его двумя кнопками в меню значило бы предлагать отказ
     * наравне с согласием там, где чаще нужно второе.
     */
    if (has('it_approved')) {
      items.push({
        key: 'it-approval',
        label: 'Согласование ИТ',
        icon: <SafetyCertificateOutlined />,
        onClick: () => setItTarget(request),
      });
    }

    if (has('assigned')) {
      const reassign = request.status !== 'it_approved';
      items.push({
        key: 'assign',
        label: reassign ? 'Переназначить сервис' : 'Назначить сервис',
        icon: <UserSwitchOutlined />,
        onClick: () => setAssignTarget(request),
      });
    }

    if (request.status === 'assigned' && has('diagnostics')) {
      items.push({
        key: 'start',
        label: 'Взять в диагностику',
        icon: <PlayCircleOutlined />,
        onClick: () => startMutation.mutate(request),
      });
    }

    if (request.status === 'assigned' && has('it_approved')) {
      items.push({
        key: 'decline',
        label: executor ? 'Отказаться от заявки' : 'Вернуть в «Новую»',
        icon: <CloseCircleOutlined />,
        danger: true,
        onClick: () => ask(prompts.decline),
      });
    }

    if (request.status === 'diagnostics' && has('estimate_review')) {
      items.push({
        key: 'estimate',
        label: 'Смета',
        icon: <FileTextOutlined />,
        onClick: () => setEstimateTarget(request),
      });
    }

    if (request.status === 'estimate_review') {
      if (has('in_work') && hasPermission(user, 'serviceRequests.approveEstimate')) {
        items.push({
          key: 'approval',
          label: 'Согласование сметы',
          icon: <AuditOutlined />,
          onClick: () => setApprovalTarget(request),
        });
      } else if (has('diagnostics')) {
        items.push({
          key: 'reject-estimate',
          label: 'Вернуть в диагностику',
          icon: <RollbackOutlined />,
          onClick: () => ask(prompts.rejectEstimate),
        });
      }
    }

    if (request.status === 'in_work') {
      if (has('done')) {
        items.push({
          key: 'complete',
          label: 'Закрыть работы',
          icon: <CheckCircleOutlined />,
          onClick: () => setCompleteTarget(request),
        });
      }
      if (has('diagnostics')) {
        items.push({
          key: 'reopen',
          label: 'Переоткрыть смету',
          icon: <UndoOutlined />,
          onClick: () => ask(prompts.reopenEstimate),
        });
      }
    }

    if (request.status === 'done') {
      if (has('accepted')) {
        items.push({
          key: 'accept',
          label: 'Принять работу',
          icon: <CheckCircleOutlined />,
          onClick: () => setAcceptTarget({ request, mode: 'accept' }),
        });
      }
      if (has('in_work')) {
        items.push({
          key: 'rework',
          label: 'Вернуть на доработку',
          icon: <RollbackOutlined />,
          danger: true,
          onClick: () => setAcceptTarget({ request, mode: 'rework' }),
        });
      }
    }

    if (request.status === 'accepted' && has('done')) {
      items.push({
        key: 'rollback-accept',
        label: 'Отменить приёмку',
        icon: <UndoOutlined />,
        danger: true,
        onClick: () => ask(prompts.rollbackAcceptance),
      });
    }

    if (request.status === 'cancelled' && has('new')) {
      items.push({
        key: 'reopen-request',
        label: 'Вернуть в работу',
        icon: <UndoOutlined />,
        onClick: () => ask(prompts.reopenRequest),
      });
    }

    /*
     * Срочность (Р56) — не переход, поэтому она не в коридоре: её ставят и снимают до самого
     * закрытия. Кто вправе, решает право, а не роль: оператор оргтехники — тот же «Штаб» или
     * «Отдел», и правило «правит только Новую» отобрало бы у него признак вместе с заказчиком.
     */
    const closed = request.status === 'accepted' || request.status === 'cancelled';
    const mayUrgency =
      !executor &&
      !closed &&
      hasPermission(user, 'serviceRequests.update') &&
      (hasPermission(user, 'serviceRequests.assign') || isServiceRequestEditable(request.status));
    if (mayUrgency) {
      items.push({
        key: 'urgency',
        label: request.isUrgent ? 'Снять срочность' : 'Отметить срочной',
        icon: <ThunderboltOutlined />,
        onClick: () => setUrgencyTarget(request),
      });
    }

    /*
     * Переезд техники, вызванный ремонтом (Р61): «увезли в сервис» и «вернулась». Ход заявки
     * состояние единицы сам не меняет — чинят и на месте, — но узнают о переезде именно здесь, и
     * записать его надо там же, где узнали. Действие видно только тому, кто ведёт справочник:
     * сервисной компании он закрыт целиком (Р7).
     */
    if (!executor && !closed && hasPermission(user, 'officeEquipment.write')) {
      items.push({
        key: 'move-equipment',
        label: 'Записать перемещение техники',
        icon: <SwapOutlined />,
        onClick: () => setMoveTarget(request),
      });
    }

    /**
     * Письмо службе уходит на входе в статус, и повторить его можно только там, где событие есть:
     * «Новая» и «Отменена». В остальных статусах сервер отвечает 422, и предлагать кнопку было бы
     * обещанием, которого он не даёт.
     */
    if (
      !executor &&
      serviceMailRepeatable(request.status) &&
      hasPermission(user, 'serviceRequests.status')
    ) {
      items.push({
        key: 'notify',
        label: 'Отправить письмо службе ещё раз',
        icon: <MailOutlined />,
        onClick: () => notifyMutation.mutate(request),
      });
    }

    if (has('cancelled')) {
      items.push({
        key: 'cancel',
        label: 'Отменить заявку',
        icon: <StopOutlined />,
        danger: true,
        onClick: () => ask(prompts.cancel),
      });
    }

    return items;
  };

  const modals = (
    <>
      <AssignServiceModal request={assignTarget} onClose={() => setAssignTarget(null)} />
      <EstimateEditorModal request={estimateTarget} onClose={() => setEstimateTarget(null)} />
      <EstimateApprovalModal request={approvalTarget} onClose={() => setApprovalTarget(null)} />
      <ServiceCompleteModal request={completeTarget} onClose={() => setCompleteTarget(null)} />
      <ServiceAcceptModal
        request={acceptTarget?.request ?? null}
        mode={acceptTarget?.mode ?? 'accept'}
        onClose={() => setAcceptTarget(null)}
      />
      <ServiceUrgencyModal request={urgencyTarget} onClose={() => setUrgencyTarget(null)} />
      <ItApprovalModal request={itTarget} onClose={() => setItTarget(null)} />
      {moveTarget && (
        <EquipmentMoveFromRequest
          equipmentId={moveTarget.equipment.id}
          serviceRequestId={moveTarget.id}
          open
          onClose={() => setMoveTarget(null)}
        />
      )}
      <ReasonModal
        open={!!prompt}
        title={prompt?.title}
        label={prompt?.label}
        okText={prompt?.okText}
        danger={prompt?.danger}
        confirmLoading={reasonMutation.isPending}
        onCancel={() => setPrompt(null)}
        onSubmit={(reason) => {
          if (!prompt) return;
          reasonMutation.mutate({ run: () => prompt.submit(reason), success: prompt.success });
        }}
      />
    </>
  );

  return { actionsFor, modals, pending: reasonMutation.isPending || startMutation.isPending };
}
