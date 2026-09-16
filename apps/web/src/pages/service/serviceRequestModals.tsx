import { useCallback, useState, type ReactNode } from 'react';
import { Alert, App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuthUser, ModuleMailOutcome, ServiceRequestDto } from '@technic/contracts';
import { serviceRequestKeys } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { AssignServiceModal } from '@features/assign-service';
import { EstimateEditorModal } from '@features/estimate-editor';
import { EstimateApprovalModal } from '@features/estimate-approval';
import { ServiceChatModal } from '@features/service-chat';
import { ServiceCompleteModal } from '@features/service-complete';
import { ServiceConsumablesIssueModal } from '@features/service-consumables-issue';
import { ServiceAcceptModal, type AcceptMode } from '@features/service-accept';
import { ServiceCancelModal } from '@features/service-cancel';
import { ServiceHoldModal, type HoldMode } from '@features/service-hold';
import { EquipmentMoveFromRequest } from '@features/equipment-move';
import { ServiceUrgencyModal } from '@features/service-urgency';
import { ServiceEstimateDisputeModal } from './ServiceEstimateDisputeModal';
import { ServiceRequestConsumablesModal } from './ServiceRequestConsumables';
import { reportServiceMail } from './serviceMailNotice';
import { cancelErases, type ReasonPrompt } from './serviceRequestPrompts';
import { serviceActionRow, serviceExecutorAssignment } from './serviceRequestRow';
import { useAuth } from '../../auth/AuthContext';
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
   * Разрешение спора об освобождении от подписи (Р9 плана
   * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`): три исхода в одном окне. Само
   * ОТКРЫТИЕ спора сюда не заходит — у него из содержания одна лишь причина, и идёт оно общим
   * окном причины (`ask`), как отказ и откаты.
   */
  disputeResolution: (request: ServiceRequestDto) => void;
  /**
   * Состав номенклатуры заявки на расходники (Р15) — то же окно, каким у ремонта правят объём
   * работ: у обоих видов заявки исполнитель отвечает на один вопрос, «что по ней пойдёт».
   */
  consumables: (request: ServiceRequestDto) => void;
  complete: (request: ServiceRequestDto) => void;
  /** Правка факта выдачи расходников (Р6): склад двигает она, а не смена статуса. */
  issue: (request: ServiceRequestDto) => void;
  accept: (request: ServiceRequestDto, mode: AcceptMode) => void;
  /**
   * Отмена заявки (Р10): причина, а у ремонта — решение «что делаем вместо» и пометка замены. Своё
   * окно, а не `ask(prompts.cancel)`: у отмены появилось содержание, которого одно-полевой
   * `ReasonModal` не знает.
   */
  cancel: (request: ServiceRequestDto) => void;
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

/** Чем перечень пользуется помимо самой заявки: смотрящий, окна и действия без окна. */
export interface ServiceMenuContext {
  /** Смотрящий: от него зависят и права, и сторона исполнителя на этой заявке. */
  user: AuthUser | null;
  /** Окна заявки: какое открыть — решает пункт, чем оно устроено — набор окон. */
  modals: ServiceRequestModals;
  /**
   * Действия, у которых нет ни окна, ни причины: они уходят прямо в мутацию хука. Передаются
   * обработчиками, а не мутациями, чтобы перечень пунктов не знал ни про кэш запросов, ни про
   * подтверждения — иначе разрез потерял бы смысл.
   */
  run: {
    /** «Принять в работу» (Р6): содержания у хода нет вовсе — только версия заявки. */
    start: (request: ServiceRequestDto) => void;
    /** «Согласовано» (Р8): подтверждение с суммой и ревизией живёт в хуке, рядом с мутацией. */
    approve: (request: ServiceRequestDto) => void;
    /**
     * Откат «принял в работу» (Р13): `in_work → new`, причины переход не требует
     * (`serviceStatusChangeRequiresReason` о нём молчит), поэтому и подтверждение живёт в хуке.
     */
    rollbackStart: (request: ServiceRequestDto) => void;
  };
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
  /*
   * Смотрящий нужен ровно одному окну — объёму работ: признаки назначения на заявку
   * (`serviceExecutorAssignment`) считаются парой «человек ↔ эта строка», и без человека такой пары
   * нет. Остальные окна берут его сами через `useAuth`, потому что спрашивают о нём своё.
   */
  const { user } = useAuth();

  const [assignTarget, setAssignTarget] = useState<ServiceRequestDto | null>(null);
  const [estimateTarget, setEstimateTarget] = useState<ServiceRequestDto | null>(null);
  const [approvalTarget, setApprovalTarget] = useState<ServiceRequestDto | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<ServiceRequestDto | null>(null);
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
  const [cancelTarget, setCancelTarget] = useState<ServiceRequestDto | null>(null);
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
    setDisputeTarget(null);
    setConsumablesTarget(null);
    setCompleteTarget(null);
    setIssueTarget(null);
    setAcceptTarget(null);
    setCancelTarget(null);
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
    disputeResolution: setDisputeTarget,
    consumables: setConsumablesTarget,
    complete: setCompleteTarget,
    issue: setIssueTarget,
    accept: (request, mode) => setAcceptTarget({ request, mode }),
    cancel: setCancelTarget,
    hold: (request, mode) => setHoldTarget({ request, mode }),
    urgency: setUrgencyTarget,
    chat: setChatTarget,
    moveEquipment: setMoveTarget,
    ask: setPrompt,
    close,
    pending: reasonMutation.isPending,
    node: (
      <>
        {/* Каждое окно монтируется только под свою цель, а не сразу всё одиннадцать с
          `request={null}`. Так уже был устроен перенос ниже, и причина у остальных та же: пустое
          окно всё равно заводит экземпляр `Form.useForm`, а `<Form>` внутри себя не рендерит —
          antd на это и жалуется («Instance created by `useForm` is not connected to any Form
          element»). Значений это не теряло (rc-form держит их в своём store и до монтажа поля),
          но десять мёртвых форм на каждом списке заявок — цена ни за что. */}
        {assignTarget && (
          <AssignServiceModal request={assignTarget} onClose={() => setAssignTarget(null)} />
        )}
        {/* Перевод карточки для предикатов — ГОТОВЫМ ОТ ЭТОГО СЛОЯ (Р3 плана освобождения). Окно
            спрашивает им `canDeclareExemption`, то есть решает, показывать ли чекбокс
            «Согласование не требуется»; не передай мы его, окно честно уходит в fail-closed — и
            денежное решение становится недостижимым вовсе, а не «недоступным не тому». Перевод
            берётся тот единственный, что уже есть в портале (`serviceActionRow`,
            `serviceExecutorAssignment`): второй, собранный здесь по-своему, разошёлся бы с меню
            действий молча и ровно на тех полях, по которым сервер отвечает 403. */}
        {estimateTarget && (
          <EstimateEditorModal
            request={estimateTarget}
            actionRow={serviceActionRow(estimateTarget)}
            assignment={serviceExecutorAssignment(estimateTarget, user)}
            onClose={() => setEstimateTarget(null)}
          />
        )}
        {approvalTarget && (
          <EstimateApprovalModal request={approvalTarget} onClose={() => setApprovalTarget(null)} />
        )}
        {disputeTarget && (
          <ServiceEstimateDisputeModal
            request={disputeTarget}
            onClose={() => setDisputeTarget(null)}
          />
        )}
        {consumablesTarget && (
          <ServiceRequestConsumablesModal
            request={consumablesTarget}
            onClose={() => setConsumablesTarget(null)}
          />
        )}
        {completeTarget && (
          <ServiceCompleteModal request={completeTarget} onClose={() => setCompleteTarget(null)} />
        )}
        {issueTarget && (
          <ServiceConsumablesIssueModal
            request={issueTarget}
            onClose={() => setIssueTarget(null)}
          />
        )}
        {acceptTarget && (
          <ServiceAcceptModal
            request={acceptTarget.request}
            mode={acceptTarget.mode}
            onClose={() => setAcceptTarget(null)}
          />
        )}
        {/* Перечень потерь считает страница (`cancelErases`), а не окно: тем же перечнем живёт
            возврат отменённой заявки, и вторая копия матрицы сброса разошлась бы с первой. */}
        {cancelTarget && (
          <ServiceCancelModal
            request={cancelTarget}
            erases={cancelErases(cancelTarget)}
            onClose={() => setCancelTarget(null)}
          />
        )}
        {holdTarget && (
          <ServiceHoldModal
            request={holdTarget.request}
            mode={holdTarget.mode}
            onClose={() => setHoldTarget(null)}
          />
        )}
        {urgencyTarget && (
          <ServiceUrgencyModal request={urgencyTarget} onClose={() => setUrgencyTarget(null)} />
        )}
        {chatTarget && (
          <ServiceChatModal request={chatTarget} onClose={() => setChatTarget(null)} />
        )}
        {/* Аппарат здесь есть всегда: пункт «Записать перемещение техники» у заявки без него не
            заводится вовсе (Р8). Проверка не защита, а способ сказать это типом — окно перемещения
            без единицы бессмысленно, и открывать его «на всякий случай» не нужно. */}
        {moveTarget?.equipment && (
          <EquipmentMoveFromRequest
            equipmentId={moveTarget.equipment.id}
            serviceRequestId={moveTarget.id}
            open
            onClose={() => setMoveTarget(null)}
          />
        )}
        <ReasonModal
          open={!!prompt}
          /*
           * Что заявка потеряет — блоком НАД полем причины (ADR 0161): возврат отменённой снимает
           * исполнителей, согласование и весь объём работ. После нажатия восстанавливать будет
           * нечего, поэтому перечень читают до, а не узнают из карточки после. Пустой перечень
           * блока не рисует: терять нечего, и предупреждать не о чем.
           *
           * Тот же блок собственными руками рисует окно отмены (Р10): общим его не сделать —
           * `ReasonModal` живёт в `components` и служит трём модулям сразу, а перечень потерь у
           * каждого свой.
           */
          notice={
            prompt?.erases?.length ? (
              <Alert
                type="warning"
                showIcon
                title="Что снимется с заявки"
                description={
                  <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                    {prompt.erases.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                }
                style={{ marginBottom: 16 }}
              />
            ) : undefined
          }
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
