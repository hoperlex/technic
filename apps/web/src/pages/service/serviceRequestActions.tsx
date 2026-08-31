import type { ReactNode } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import type { ActionSheetItem } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { useServiceRequestModals } from './serviceRequestModals';
import { serviceRequestMenuItems } from './serviceRequestMenu';
import { reportServiceMail } from './serviceMailNotice';
import { forgetServiceNotifyKey, serviceNotifyKey } from './serviceRequestNotifyKeys';
import { errorMessage, formatMoney } from '../../utils/format';

/**
 * Чем действие заявки делается: мутации без окна, подтверждения и владение набором окон.
 *
 * Что субъекту доступно — вопрос другой, и он живёт соседним модулем (`serviceRequestMenu`):
 * доступность после Р11 считают предикаты контрактов, и перечень пунктов стал чистой функцией от
 * заявки и субъекта. Хук её зовёт и подставляет ей три обработчика — те действия, у которых нет ни
 * окна, ни причины и которые уходят прямо в запрос.
 */
export function useServiceRequestActions(): {
  actionsFor: (request: ServiceRequestDto) => ActionSheetItem[];
  modals: ReactNode;
  /** Открыть обсуждение помимо меню: этим живёт адрес `?open=<id>&chat=1` (ADR 0141, §3.7). */
  openChat: (request: ServiceRequestDto) => void;
  /** Погасить все окна набора: нужно тому, чьи окна живут внутри карточки (ADR 0140). */
  close: () => void;
  pending: boolean;
} {
  const { user } = useAuth();
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const modals = useServiceRequestModals();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
    void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
  };

  /** Повторная отправка письма службе (Р70); чем держится её ключ — `serviceRequestNotifyKeys`. */
  const notifyMutation = useMutation({
    mutationFn: (request: ServiceRequestDto) =>
      serviceRequestsApi.notify(request.id, { idempotencyKey: serviceNotifyKey(request.id) }),
    onSuccess: (res, request) => {
      forgetServiceNotifyKey(request.id);
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

  /**
   * «Принять в работу» (Р6) — единственный ход без содержания: подтверждать нечего, есть только
   * версия заявки. Оттого он и вынесен быстрой кнопкой в строку списка и в шапку карточки.
   */
  const startMutation = useMutation({
    mutationFn: (request: ServiceRequestDto) =>
      serviceRequestsApi.start(request.id, { version: request.version }),
    onSuccess: () => {
      message.success('Заявка принята в работу');
      refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * «Согласовано» (Р8): статуса не меняет — заявка остаётся в «В работе», как просил заказчик.
   *
   * Своей мутацией, а не окном, потому что содержания у согласия нет: есть ревизия и сумма, которые
   * человек только что видел. «Не согласовано» идёт другой дорогой — там спрашивают причину,
   * решение и галочку замены (Р12), и окно ему нужно своё.
   */
  const approveMutation = useMutation({
    mutationFn: (request: ServiceRequestDto) =>
      serviceRequestsApi.decideEstimate(request.id, {
        approved: true,
        // Галочку замены согласие не ставит никогда: «менять аппарат» — это исход отказа, и
        // проставленная здесь она была бы решением, которого никто не принимал (Р8).
        replacementRecommended: false,
        version: request.version,
      }),
    onSuccess: () => {
      message.success('Объём работ согласован — заявка в работе');
      refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Откат «принял в работу» (Р13): `in_work → new` — живая дуга административных откатов, и ходит
   * она общей ручкой `/status`, как отмена и прочие откаты.
   *
   * **Исполнителей откат сохраняет** (матрица сброса на этой дуге не снимает ничего), и успех
   * говорит именно это: «вернули оператору» читалось бы как освобождённая заявка, которой человек
   * не получит. Причины переход не требует — пустая строка здесь не пропуск, а ответ схемы:
   * `reason` у неё с умолчанием, и в выводимом типе поле обязательно.
   *
   * Письмо у отката есть: заявка снова ждёт разбора, и служба узнаёт об этом так же, как при
   * заведении (Р65), — поэтому исход письма называется тут же.
   */
  const rollbackStartMutation = useMutation({
    mutationFn: (request: ServiceRequestDto) =>
      serviceRequestsApi.changeStatus(request.id, {
        status: 'new',
        reason: '',
        version: request.version,
      }),
    onSuccess: (res) => {
      message.success('Заявка снова «Новая» — исполнители остались на ней');
      reportServiceMail(message, res.mail);
      refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Подтверждение отката (Р13): спрашивается не «уверены ли вы», а что именно случится. Пункт
   * называется «Вернуть в «Новую»», и без этих слов его прочитали бы как снятие исполнителей —
   * прежний одноимённый пункт висел как раз на дуге, которая их снимала.
   */
  const confirmRollbackStart = (request: ServiceRequestDto) =>
    modal.confirm({
      title: 'Вернуть заявку в «Новую»?',
      content:
        'Назначенные исполнители останутся на заявке — она вернётся к ним, и «Принять в работу» ' +
        'нажмут заново. Чтобы сменить исполнителя, воспользуйтесь «Изменить исполнителей».',
      okText: 'Вернуть в «Новую»',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: () => rollbackStartMutation.mutateAsync(request),
    });

  /**
   * Подтверждение с суммой (Р11): подпись под цифрой обязана показывать цифру. Из меню строки
   * списка таблицы объёма работ не видно вовсе, и «Согласовать» без числа означало бы подпись
   * вслепую; на вкладке таблица рядом, но второй дороги для одного действия мы не заводим.
   */
  const confirmApprove = (request: ServiceRequestDto) =>
    modal.confirm({
      title: 'Согласовать объём работ?',
      content: `Ревизия ${request.estimateRevision} на ${formatMoney(
        request.estimatedTotalAmount,
      )}. Заявка останется в «В работе».`,
      okText: 'Согласовать',
      cancelText: 'Отмена',
      onOk: () => approveMutation.mutateAsync(request),
    });

  const actionsFor = (request: ServiceRequestDto): ActionSheetItem[] =>
    serviceRequestMenuItems(request, {
      user,
      modals,
      run: {
        start: (target) => startMutation.mutate(target),
        approve: confirmApprove,
        rollbackStart: confirmRollbackStart,
        notify: (target) => notifyMutation.mutate(target),
      },
    });

  const pending =
    modals.pending ||
    startMutation.isPending ||
    approveMutation.isPending ||
    rollbackStartMutation.isPending;
  return { actionsFor, modals: modals.node, openChat: modals.chat, close: modals.close, pending };
}
