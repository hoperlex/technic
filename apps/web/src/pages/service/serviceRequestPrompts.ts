import { serviceRequestsApi } from '@entities/service-request';
import type { ServiceRequestDto } from '@technic/contracts';

/** Действие, которому нужна причина: окно одно, различаются подписи и сама ручка. */
export interface ReasonPrompt {
  title: string;
  label: string;
  okText: string;
  danger?: boolean;
  success: string;
  submit: (reason: string) => Promise<unknown>;
}

/**
 * Действия, у которых из содержания только причина (§5.3). Собраны в одном месте, потому что
 * разница между ними — в подписях и в ручке, а не в поведении: окно одно, и разъехаться они могут
 * только текстом, который человек читает перед тем, как отменить чужую работу.
 *
 * Переходами эти действия быть перестали не все: отказ и возврат объёма работ в правку статуса не
 * трогают вовсе (Р7, Р9), но причину спрашивают той же ручкой — по ней в истории и читают, почему
 * исполнителей стало меньше, а подпись под объёмом снята.
 */
export function serviceReasonPrompts(request: ServiceRequestDto) {
  const version = request.version;
  const id = request.id;
  return {
    /*
     * Отказ идёт одной ручкой на всех (Р7). Второй дороги — отката `/status` из «Назначенной» —
     * больше нет вовсе: назначение переходом быть перестало, дуга `assigned → new` снята вместе со
     * статусом, и выбирать между ручками стало не из чего. Кто снимается, решает сама ручка: свою
     * строку у сотрудника, всю компанию у подрядчика.
     *
     * Успех говорит про состав, а не про статус: заявка и до отказа стояла в «Новой», и «возвращена
     * оператору» звучало бы как переход, которого не было. Ждёт ли она теперь распределения или
     * оставшихся исполнителей — отвечает очередь, пересчитанная сервером (Р7).
     */
    decline: {
      title: 'Отказ от заявки',
      label: 'Причина',
      okText: 'Отказаться',
      danger: true,
      success: 'Вы сняты с заявки',
      submit: (reason: string) => serviceRequestsApi.decline(id, { reason, version }),
    },
    reopenEstimate: {
      title: 'Возврат объёма работ в правку',
      label: 'Причина',
      okText: 'Вернуть в правку',
      // Ручка снимает ОБЕ отметки (Р9): снимок согласования и само предъявление. Успех называет обе
      // — иначе исполнитель, отозвавший непогашенное предъявление, прочитал бы про снятое
      // согласование, которого не было.
      success: 'Объём работ возвращён в правку — предъявление и согласование сняты',
      submit: (reason: string) => serviceRequestsApi.reopenEstimate(id, { reason, version }),
    },
    rollbackAcceptance: {
      title: 'Отмена приёмки',
      label: 'Причина',
      okText: 'Отменить приёмку',
      danger: true,
      success: 'Приёмка отменена',
      submit: (reason: string) =>
        serviceRequestsApi.changeStatus(id, { status: 'done', reason, version }),
    },
    reopenRequest: {
      title: 'Возврат отменённой заявки',
      label: 'Причина',
      okText: 'Вернуть в «Новую»',
      success: 'Заявка снова в работе',
      submit: (reason: string) =>
        serviceRequestsApi.changeStatus(id, { status: 'new', reason, version }),
    },
    cancel: {
      title: `Отмена заявки ${request.displayNumber}`,
      label: 'Причина отмены',
      okText: 'Отменить заявку',
      danger: true,
      success: 'Заявка отменена',
      submit: (reason: string) =>
        serviceRequestsApi.changeStatus(id, { status: 'cancelled', reason, version }),
    },
  } satisfies Record<string, ReasonPrompt>;
}
