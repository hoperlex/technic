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
 * Переходы, у которых из содержания только причина (§5.3). Собраны в одном месте, потому что
 * разница между ними — в подписях и в ручке, а не в поведении: окно одно, и разъехаться они могут
 * только текстом, который человек читает перед тем, как отменить чужую работу.
 *
 * Дуга бывает одна, а ручек к ней две: `assigned → it_approved` для исполнителя — это «отказаться»
 * (`/decline`), а для администратора — откат (`/status`). Выбирает специализированную ручку
 * возможность субъекта, а не его имя: специализированная знает условие своего перехода, общий
 * `/status` — только причину.
 */
export function serviceReasonPrompts(request: ServiceRequestDto, executor: boolean) {
  const version = request.version;
  const id = request.id;
  return {
    decline: {
      title: executor ? 'Отказ от заявки' : 'Возврат заявки оператору',
      label: 'Причина',
      okText: executor ? 'Отказаться' : 'Вернуть',
      danger: true,
      success: 'Заявка возвращена оператору',
      submit: (reason: string) =>
        executor
          ? serviceRequestsApi.decline(id, { reason, version })
          : serviceRequestsApi.changeStatus(id, {
              // Виза ИТ отказом исполнителя не отменяется: заявка ждёт нового сервиса, а не
              // повторного решения отдела.
              status: 'it_approved',
              reason,
              version,
            }),
    },
    rejectEstimate: {
      title: 'Возврат сметы в диагностику',
      label: 'Причина',
      okText: 'Вернуть',
      success: 'Смета возвращена в диагностику',
      submit: (reason: string) =>
        serviceRequestsApi.changeStatus(id, { status: 'diagnostics', reason, version }),
    },
    reopenEstimate: {
      title: 'Переоткрытие сметы',
      label: 'Причина',
      okText: 'Переоткрыть',
      success: 'Смета переоткрыта — согласование снято',
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
