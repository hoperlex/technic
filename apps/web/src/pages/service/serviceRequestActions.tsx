import { useState, type ReactNode } from 'react';
import { App } from 'antd';
import {
  AuditOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  RollbackOutlined,
  StopOutlined,
  UndoOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  actsForCounterparty,
  allowedServiceStatusTransitions,
  can as hasPermission,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { AssignServiceModal } from '@features/assign-service';
import { EstimateEditorModal } from '@features/estimate-editor';
import { EstimateApprovalModal } from '@features/estimate-approval';
import { ServiceCompleteModal } from '@features/service-complete';
import { ServiceAcceptModal, type AcceptMode } from '@features/service-accept';
import type { ActionSheetItem } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { ReasonModal } from '../../components/CancelReasonModal';
import { errorMessage } from '../../utils/format';

/** Действие, которому нужна причина: окно одно, различаются подписи и сама ручка. */
interface ReasonPrompt {
  title: string;
  label: string;
  okText: string;
  danger?: boolean;
  success: string;
  submit: (reason: string) => Promise<unknown>;
}

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
  const [prompt, setPrompt] = useState<ReasonPrompt | null>(null);

  /**
   * Переходы с одной лишь причиной идут одной мутацией: гасит кэш и сообщает об успехе она одна,
   * поэтому «отказался», «переоткрыл» и «отменил» не могут разойтись в поведении.
   */
  const reasonMutation = useMutation({
    mutationFn: (task: { run: () => Promise<unknown>; success: string }) => task.run(),
    onSuccess: (_result, task) => {
      message.success(task.success);
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      setPrompt(null);
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

    if (has('assigned')) {
      const reassign = request.status !== 'new';
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

    if (request.status === 'assigned' && has('new')) {
      items.push({
        key: 'decline',
        label: executor ? 'Отказаться от заявки' : 'Вернуть в «Новую»',
        icon: <CloseCircleOutlined />,
        danger: true,
        onClick: () =>
          ask({
            title: executor ? 'Отказ от заявки' : 'Возврат заявки в «Новую»',
            label: 'Причина',
            okText: executor ? 'Отказаться' : 'Вернуть',
            danger: true,
            success: executor ? 'Заявка возвращена оператору' : 'Заявка возвращена в «Новую»',
            submit: (reason) =>
              executor
                ? serviceRequestsApi.decline(request.id, { reason, version: request.version })
                : serviceRequestsApi.changeStatus(request.id, {
                    status: 'new',
                    reason,
                    version: request.version,
                  }),
          }),
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
          onClick: () =>
            ask({
              title: 'Возврат сметы в диагностику',
              label: 'Причина',
              okText: 'Вернуть',
              success: 'Смета возвращена в диагностику',
              submit: (reason) =>
                serviceRequestsApi.changeStatus(request.id, {
                  status: 'diagnostics',
                  reason,
                  version: request.version,
                }),
            }),
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
          onClick: () =>
            ask({
              title: 'Переоткрытие сметы',
              label: 'Причина',
              okText: 'Переоткрыть',
              success: 'Смета переоткрыта — согласование снято',
              submit: (reason) =>
                serviceRequestsApi.reopenEstimate(request.id, {
                  reason,
                  version: request.version,
                }),
            }),
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
        onClick: () =>
          ask({
            title: 'Отмена приёмки',
            label: 'Причина',
            okText: 'Отменить приёмку',
            danger: true,
            success: 'Приёмка отменена',
            submit: (reason) =>
              serviceRequestsApi.changeStatus(request.id, {
                status: 'done',
                reason,
                version: request.version,
              }),
          }),
      });
    }

    if (request.status === 'cancelled' && has('new')) {
      items.push({
        key: 'reopen-request',
        label: 'Вернуть в работу',
        icon: <UndoOutlined />,
        onClick: () =>
          ask({
            title: 'Возврат отменённой заявки',
            label: 'Причина',
            okText: 'Вернуть в «Новую»',
            success: 'Заявка снова в работе',
            submit: (reason) =>
              serviceRequestsApi.changeStatus(request.id, {
                status: 'new',
                reason,
                version: request.version,
              }),
          }),
      });
    }

    if (has('cancelled')) {
      items.push({
        key: 'cancel',
        label: 'Отменить заявку',
        icon: <StopOutlined />,
        danger: true,
        onClick: () =>
          ask({
            title: `Отмена заявки ${request.displayNumber}`,
            label: 'Причина отмены',
            okText: 'Отменить заявку',
            danger: true,
            success: 'Заявка отменена',
            submit: (reason) =>
              serviceRequestsApi.changeStatus(request.id, {
                status: 'cancelled',
                reason,
                version: request.version,
              }),
          }),
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
