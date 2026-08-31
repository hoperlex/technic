import { useCallback, useState, type ReactNode } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ModuleMailOutcome, ServiceRequestDto } from '@technic/contracts';
import { serviceRequestKeys } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { AssignServiceModal } from '@features/assign-service';
import { EstimateEditorModal } from '@features/estimate-editor';
import { EstimateApprovalModal } from '@features/estimate-approval';
import { ServiceChatModal } from '@features/service-chat';
import { ServiceCompleteModal } from '@features/service-complete';
import { ServiceConsumablesIssueModal } from '@features/service-consumables-issue';
import { ServiceAcceptModal, type AcceptMode } from '@features/service-accept';
import { ServiceHoldModal, type HoldMode } from '@features/service-hold';
import { EquipmentMoveFromRequest } from '@features/equipment-move';
import { ServiceUrgencyModal } from '@features/service-urgency';
import { ServiceRequestConsumablesModal } from './ServiceRequestConsumables';
import { reportServiceMail } from './serviceMailNotice';
import type { ReasonPrompt } from './serviceRequestPrompts';
import { ReasonModal } from '../../components/CancelReasonModal';
import { errorMessage } from '../../utils/format';

/** Чем открывается каждое окно заявки: заявкой, а у двойных — ещё и стороной действия. */
export interface ServiceRequestModals {
  assign: (request: ServiceRequestDto) => void;
  /** Редактор объёма работ исполнителя: строки, сумма и предъявление (Р8). */
  estimate: (request: ServiceRequestDto) => void;
  /**
   * Отказ по объёму работ (Р8, Р12): причина, решение и галочка замены. Согласие сюда не заходит —
   * содержания у него нет, и оно идёт подтверждением прямо из набора действий.
   */
  approval: (request: ServiceRequestDto) => void;
  /**
   * Состав номенклатуры заявки на расходники (Р15) — то же окно, каким у ремонта правят объём
   * работ: у обоих видов заявки исполнитель отвечает на один вопрос, «что по ней пойдёт».
   */
  consumables: (request: ServiceRequestDto) => void;
  complete: (request: ServiceRequestDto) => void;
  /** Правка факта выдачи расходников (Р6): склад двигает она, а не смена статуса. */
  issue: (request: ServiceRequestDto) => void;
  accept: (request: ServiceRequestDto, mode: AcceptMode) => void;
  hold: (request: ServiceRequestDto, mode: HoldMode) => void;
  urgency: (request: ServiceRequestDto) => void;
  /** Обсуждение заявки (ADR 0141): лента реплик, а не перезаписываемое примечание. */
  chat: (request: ServiceRequestDto) => void;
  moveEquipment: (request: ServiceRequestDto) => void;
  /** Переход, у которого из содержания только причина: отказ, отмена, откат (§5.3). */
  ask: (prompt: ReasonPrompt) => void;
  /**
   * Погасить все окна набора (ADR 0140). Нужно тому, чьи окна живут **внутри** карточки: карточку
   * закрывают и мимо них — «Назад» браузера снимает `?open=…`, и системный жест «назад» закрывает
   * полноэкранный шит на телефоне. Элемент окна при этом уезжает вместе с детьми карточки, а
   * взведённая цель остаётся — и следующее открытие той же карточки выкидывало бы окно само, без
   * нажатия и с устаревшей ревизией заявки.
   */
  close: () => void;
  /** Идёт переход «с одной причиной»: подвал списка держит на нём индикатор. */
  pending: boolean;
  node: ReactNode;
}

/**
 * Окна заявки на обслуживание: какое открыто и чем.
 *
 * Отдельно от набора действий (`serviceRequestActions`), потому что это два разных предмета. Там
 * решают, **что субъекту доступно** — по коридору переходов, правам и назначению; здесь — **чем
 * это делается**, и добавление одиннадцатого окна не должно раздувать функцию, отвечающую на
 * первый вопрос.
 *
 * Переходы с одной лишь причиной идут одной мутацией: гасит кэш и сообщает об успехе она одна,
 * поэтому «отказался», «переоткрыл» и «отменил» не могут разойтись в поведении.
 */
export function useServiceRequestModals(): ServiceRequestModals {
  const { message } = App.useApp();
  const qc = useQueryClient();

  const [assignTarget, setAssignTarget] = useState<ServiceRequestDto | null>(null);
  const [estimateTarget, setEstimateTarget] = useState<ServiceRequestDto | null>(null);
  const [approvalTarget, setApprovalTarget] = useState<ServiceRequestDto | null>(null);
  const [consumablesTarget, setConsumablesTarget] = useState<ServiceRequestDto | null>(null);
  const [completeTarget, setCompleteTarget] = useState<ServiceRequestDto | null>(null);
  const [issueTarget, setIssueTarget] = useState<ServiceRequestDto | null>(null);
  const [acceptTarget, setAcceptTarget] = useState<{
    request: ServiceRequestDto;
    mode: AcceptMode;
  } | null>(null);
  const [holdTarget, setHoldTarget] = useState<{
    request: ServiceRequestDto;
    mode: HoldMode;
  } | null>(null);
  const [urgencyTarget, setUrgencyTarget] = useState<ServiceRequestDto | null>(null);
  const [chatTarget, setChatTarget] = useState<ServiceRequestDto | null>(null);
  const [moveTarget, setMoveTarget] = useState<ServiceRequestDto | null>(null);
  const [prompt, setPrompt] = useState<ReasonPrompt | null>(null);

  const reasonMutation = useMutation({
    mutationFn: (task: { run: () => Promise<unknown>; success: string }) => task.run(),
    onSuccess: (result, task) => {
      message.success(task.success);
      // Отмена шлёт письмо службе: «не выезжайте». Если письма не будет, человек узнаёт об этом
      // здесь же — служба читает почту, а не портал.
      reportServiceMail(message, (result as { mail?: ModuleMailOutcome } | null)?.mail);
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      setPrompt(null);
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const close = useCallback(() => {
    setAssignTarget(null);
    setEstimateTarget(null);
    setApprovalTarget(null);
    setConsumablesTarget(null);
    setCompleteTarget(null);
    setIssueTarget(null);
    setAcceptTarget(null);
    setHoldTarget(null);
    setUrgencyTarget(null);
    setChatTarget(null);
    setMoveTarget(null);
    setPrompt(null);
  }, []);

  return {
    assign: setAssignTarget,
    estimate: setEstimateTarget,
    approval: setApprovalTarget,
    consumables: setConsumablesTarget,
    complete: setCompleteTarget,
    issue: setIssueTarget,
    accept: (request, mode) => setAcceptTarget({ request, mode }),
    hold: (request, mode) => setHoldTarget({ request, mode }),
    urgency: setUrgencyTarget,
    chat: setChatTarget,
    moveEquipment: setMoveTarget,
    ask: setPrompt,
    close,
    pending: reasonMutation.isPending,
    node: (
      <>
        <AssignServiceModal request={assignTarget} onClose={() => setAssignTarget(null)} />
        <EstimateEditorModal request={estimateTarget} onClose={() => setEstimateTarget(null)} />
        <EstimateApprovalModal request={approvalTarget} onClose={() => setApprovalTarget(null)} />
        <ServiceRequestConsumablesModal
          request={consumablesTarget}
          onClose={() => setConsumablesTarget(null)}
        />
        <ServiceCompleteModal request={completeTarget} onClose={() => setCompleteTarget(null)} />
        <ServiceConsumablesIssueModal request={issueTarget} onClose={() => setIssueTarget(null)} />
        <ServiceAcceptModal
          request={acceptTarget?.request ?? null}
          mode={acceptTarget?.mode ?? 'accept'}
          onClose={() => setAcceptTarget(null)}
        />
        <ServiceHoldModal
          request={holdTarget?.request ?? null}
          mode={holdTarget?.mode ?? 'hold'}
          onClose={() => setHoldTarget(null)}
        />
        <ServiceUrgencyModal request={urgencyTarget} onClose={() => setUrgencyTarget(null)} />
        <ServiceChatModal request={chatTarget} onClose={() => setChatTarget(null)} />
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
    ),
  };
}
