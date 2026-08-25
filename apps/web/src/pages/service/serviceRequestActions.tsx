import { useState, type ReactNode } from 'react';
import { App } from 'antd';
import {
  AuditOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileTextOutlined,
  InboxOutlined,
  MailOutlined,
  MessageOutlined,
  PauseCircleOutlined,
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
  hasServiceClosingDocument,
  serviceRequestNeedsClosingDocument,
  allowedServiceStatusTransitions,
  can as hasPermission,
  canResumeService,
  isServiceExecutor,
  isServiceRequestEditable,
  serviceMailRepeatable,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import type { HoldMode } from '@features/service-hold';
import { officeEquipmentKeys } from '@entities/office-equipment';
import type { ActionSheetItem } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { useServiceRequestModals } from './serviceRequestModals';
import { serviceReasonPrompts } from './serviceRequestPrompts';
import { reportServiceMail } from './serviceMailNotice';
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

  const modals = useServiceRequestModals();

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
      // Успех называет адресатов: повтор шлют, когда сомневаются в настройке, — и ответ на это
      // сомнение не «отправлено», а «отправлено вот сюда». Неудача повтора — тем же
      // предупреждением, что и у прочих действий: письма снова нет.
      if (res.mail === 'queued') {
        message.success(`Письмо службе поставлено в очередь: ${res.recipients.join(', ')}`);
      } else {
        reportServiceMail(message, res.mail);
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

  /*
   * Признак `primary` — главный шаг текущего статуса (Р117): к нему ведёт подпись «Вам: …» в
   * столбце состояния. Он живёт прямо здесь, у пункта меню, а не второй картой «статус → окно»:
   * карта разошлась бы с коридором на первом же новом статусе — строка звала бы к действию,
   * которого в меню уже нет. Поэтому у каждого пункта он выставлен ровно в том статусе, где этот
   * пункт и есть главный ход (§4 плана), а не там, где та же дуга встречается вторым смыслом.
   */
  const actionsFor = (request: ServiceRequestDto): ActionSheetItem[] => {
    // Архивной заявке ход не положен: её либо восстанавливают, либо сносят — это действия архива.
    if (request.deletedAt) return [];

    /*
     * Коридор считается с признаками назначения (волна В6): ход исполнителя открывает не право, а
     * назначение на **эту** заявку — поимённое вместе с `serviceRequests.execute` либо своя
     * компания в исполнителях (Н5). Сервер спрашивает то же самое теми же признаками, поэтому меню
     * и ответ маршрута не расходятся.
     */
    const assignment = {
      actsForAssignedCounterparty: actsForCounterparty(user, 'service'),
      isNamedExecutor: request.executors.some((e) => e.userId === user?.id),
    };
    const allowed = allowedServiceStatusTransitions(request.status, user, assignment);
    const has = (status: (typeof allowed)[number]) => allowed.includes(status);
    const executor = assignment.actsForAssignedCounterparty;
    const items: ActionSheetItem[] = [];
    const ask = modals.ask;
    // Переходы «только с причиной» собраны отдельно: их шесть, и различаются они подписями, а не
    // поведением (`serviceRequestPrompts.ts`).
    const prompts = serviceReasonPrompts(request, executor);

    /*
     * Виза ИТ уехала со входа на смету (Н3): вопрос «чинить за эти деньги или менять аппарат»
     * задаётся, когда есть счёт, а не когда заявку только завели. Одно действие на оба исхода —
     * решение одно, и разводить его двумя кнопками значило бы предлагать замену наравне с ремонтом.
     *
     * Условие — `waitingOn === 'it'`, а не право и не дуга. Сервер считает эту сторону по строке
     * заявки, сверяя ревизию подписи с текущей (`serviceRequestWaitingOn`): подпись прошлой ревизии
     * визой не считается, а повторную на ту же ревизию маршрут отбивает 422. Спроси мы право —
     * пункт висел бы у согласующего и после подписи.
     */
    if (request.status === 'estimate_review' && request.waitingOn === 'it') {
      items.push({
        key: 'it-approval',
        label: 'Решение ИТ по смете',
        icon: <SafetyCertificateOutlined />,
        primary: true, // главный шаг статуса: пока визы нет, сумму не согласуют
        onClick: () => modals.itApproval(request),
      });
    }

    if (has('assigned')) {
      // Назначение — главный шаг «Новой»:
      // дальше это уже переназначение, то есть разбор ошибки, а не ожидаемый ход.
      const first = request.status === 'new';
      items.push({
        key: 'assign',
        label: first ? 'Назначить исполнителей' : 'Изменить исполнителей',
        icon: <UserSwitchOutlined />,
        primary: first,
        onClick: () => modals.assign(request),
      });
    }

    // «Диагностики» больше нет (Н2): исполнитель принимает заявку в работу и оттуда предъявляет
    // смету — состояние «взялся» у ремонта и у расходников теперь одно и называется одинаково.
    if (request.status === 'assigned' && has('in_work')) {
      items.push({
        key: 'start',
        label: 'Принять в работу',
        icon: <PlayCircleOutlined />,
        primary: true,
        onClick: () => startMutation.mutate(request),
      });
    }

    if (request.status === 'assigned' && has('new')) {
      items.push({
        key: 'decline',
        label: executor ? 'Отказаться от заявки' : 'Вернуть в «Новую»',
        icon: <CloseCircleOutlined />,
        danger: true,
        onClick: () => ask(prompts.decline),
      });
    }

    /*
     * Смета предъявляется из «В работе» (Н2).
     *
     * У расходников сметы нет вовсе (§6.2): картридж берут со своего склада, согласовывать по нему
     * нечего и не у кого, — и заход в смету у этого вида заявки не открыт ни одной стороне.
     */
    if (
      request.kind === 'repair' &&
      request.status === 'in_work' &&
      has('estimate_review')
    ) {
      items.push({
        key: 'estimate',
        label: 'Смета',
        icon: <FileTextOutlined />,
        primary: request.status === 'in_work' && !request.estimateSubmittedAt,
        onClick: () => modals.estimate(request),
      });
    }

    /*
     * Сумму согласуют **после** визы ИТ (Н3), и `waitingOn` это уже знает: пока он `it`, пункт не
     * показывается — сервер на такое согласование отвечает 422 «Сумму согласуют после визы ИТ».
     * Оба исхода (согласие и отклонение) ведут в «В работе» и живут в одном окне: различает их не
     * дуга, а тело действия.
     */
    if (
      request.status === 'estimate_review' &&
      request.waitingOn === 'operator' &&
      has('in_work') &&
      hasPermission(user, 'serviceRequests.approveEstimate')
    ) {
      items.push({
        key: 'approval',
        label: 'Согласование сметы',
        icon: <AuditOutlined />,
        primary: true,
        onClick: () => modals.approval(request),
      });
    }

    if (request.status === 'in_work') {
      if (has('done')) {
        /*
         * Планка закрывающего документа переехала с приёмки на «Решена» (Н8) и стоит только у
         * сервисного ремонта — предикат контрактов, а не своя копия правила. Кнопка при этом
         * остаётся видимой и неактивной: спрятанная, она читалась бы как «мне это не положено», а
         * причина запрета — «бумаги нет», и она написана рядом.
         */
        // Предикат берёт вид заявки и назначенного контрагента; в DTO компания лежит объектом
        // (`service`), поэтому сюда передаётся её идентификатор, а правило остаётся одно на портал
        // и сервер.
        const needsDoc =
          serviceRequestNeedsClosingDocument({
            kind: request.kind,
            serviceCounterpartyId: request.service?.id ?? null,
          }) && !hasServiceClosingDocument(request);
        items.push({
          key: 'complete',
          label: 'Закрыть работы',
          icon: <CheckCircleOutlined />,
          primary: !needsDoc,
          disabled: needsDoc,
          disabledReason: needsDoc
            ? 'Сначала подшейте акт, счёт или гарантийный талон — без документа заявка не уходит в «Решена»'
            : undefined,
          onClick: () => modals.complete(request),
        });
      }
      /*
       * «Вернуть смету в правку» — единственный путь изменить согласованную смету (уточнение В3):
       * ручка снимает снимок согласования, не двигая статус. Пункт показывается ровно там, где он
       * что-то меняет: пока согласованная ревизия совпадает с текущей.
       */
      if (request.approval?.revision === request.estimateRevision) {
        items.push({
          key: 'reopen',
          label: 'Вернуть смету в правку',
          icon: <UndoOutlined />,
          onClick: () => ask(prompts.reopenEstimate),
        });
      }
    }

    /*
     * Отметка о выдаче расходников (Р6): склад двигает она, а не смена статуса, — поэтому пункт
     * стоит рядом с ходами, а не внутри них, и живёт в двух статусах сразу. В «В работе» им
     * отмечают выдачу до закрытия, в «Решена» — правят то, что уже списано.
     *
     * После «Закрыта» пункта нет: строки заявки замирают, и всё дальнейшее — ручная правка остатка
     * с причиной и своим правом (Р8). Сервер отвечает на такую правку 422, и кнопка, ведущая в
     * него, была бы обещанием, которого он не даёт.
     *
     * Кто вправе — тот же предикат, что и на сервере (`assertConsumableIssuer`): назначенный
     * исполнитель (поимённо с `execute` либо своей компанией) **либо** тот, кто ведёт заявки и
     * разбирает ошибки за любую сторону.
     */
    if (
      request.kind === 'consumable' &&
      (request.status === 'in_work' || request.status === 'done') &&
      (isServiceExecutor(user, assignment) || hasPermission(user, 'serviceRequests.status'))
    ) {
      const marked = request.consumables.some((line) => line.issuedQuantity !== null);
      items.push({
        key: 'consumables-issued',
        label: marked ? 'Изменить выданное' : 'Отметить выдачу',
        icon: <InboxOutlined />,
        onClick: () => modals.issue(request),
      });
    }

    if (request.status === 'done') {
      if (has('accepted')) {
        items.push({
          key: 'accept',
          label: 'Принять работу',
          icon: <CheckCircleOutlined />,
          // Сюда же ведёт подпись «Вам: нужен закрывающий документ» (Р120): бумагу подшивают в
          // том же окне, и второго адреса у этого шага нет.
          primary: true,
          onClick: () => modals.accept(request, 'accept'),
        });
      }
      if (has('in_work')) {
        items.push({
          key: 'rework',
          label: 'Вернуть на доработку',
          icon: <RollbackOutlined />,
          danger: true,
          onClick: () => modals.accept(request, 'rework'),
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
     * Заморозка и выход из неё (Р103) — одним пунктом: это два конца одной остановки, и в каждом
     * статусе доступен ровно один из них. Дугу в `on_hold` выдаёт коридор — исполнителю её там нет
     * (Р105), и спрашивать роль здесь незачем; возврат коридором не выражается вовсе: цель у него
     * динамическая — статус, из которого заявку отложили (Р104), — поэтому право спрашивается тем
     * же предикатом, что и на сервере.
     */
    const held = request.status === 'on_hold';
    const holdMode: HoldMode | null = held
      ? canResumeService(user)
        ? 'resume'
        : null
      : has('on_hold')
        ? 'hold'
        : null;
    if (holdMode) {
      items.push({
        key: holdMode,
        label: holdMode === 'resume' ? 'Возобновить' : 'Отложить',
        icon: holdMode === 'resume' ? <PlayCircleOutlined /> : <PauseCircleOutlined />,
        onClick: () => modals.hold(request, holdMode),
      });
    }

    /*
     * Срочность (Р56) — не переход, поэтому она не в коридоре: её ставят и снимают до самого
     * закрытия. Кто вправе, решает право, а не роль: оператор оргтехники — тот же «Штаб» или
     * «Отдел», и правило «правит только Новую» отобрало бы у него признак вместе с заказчиком.
     *
     * Отложенной срочность не меняют (Р119): сервер отвечает 422 — заявка стоит, и очередь срочных
     * её не показывает. Признак при этом не гасится, он ждёт возобновления.
     */
    const closed = request.status === 'accepted' || request.status === 'cancelled';
    const mayUrgency =
      !executor &&
      !closed &&
      !held &&
      hasPermission(user, 'serviceRequests.update') &&
      (hasPermission(user, 'serviceRequests.assign') || isServiceRequestEditable(request.status));
    if (mayUrgency) {
      items.push({
        key: 'urgency',
        label: request.isUrgent ? 'Снять срочность' : 'Отметить срочной',
        icon: <ThunderboltOutlined />,
        onClick: () => modals.urgency(request),
      });
    }

    /*
     * Примечание исполнителя (приём ADR 0053) — не переход и не правка заявки: исполнитель пишет
     * своё слово в чужую заявку, а сама заявка правится заказчиком и только в двух статусах.
     * Поэтому спрашивается право работы исполнителя, а не коридор: одной ручкой пользуются и
     * сервис, и администратор, и у обоих она открыта до самого закрытия.
     *
     * Отложенной примечание пишут наравне с прочими (Р110): «запчасть будет 3-го» — это ответ
     * ровно на тот вопрос, из-за которого заявку и остановили, и убрать пункт в `on_hold` значило
     * бы закрыть поле в единственный момент, когда оно и нужно. Не показывается он только у
     * закрытой заявки: там сервер отвечает отказом.
     */
    if (!closed && hasPermission(user, 'serviceRequests.estimate')) {
      items.push({
        key: 'service-comment',
        label: 'Примечание исполнителя',
        icon: <MessageOutlined />,
        onClick: () => modals.comment(request),
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
        onClick: () => modals.moveEquipment(request),
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

  return { actionsFor, modals: modals.node, pending: modals.pending || startMutation.isPending };
}
