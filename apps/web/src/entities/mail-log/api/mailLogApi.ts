import type { MailLogItemDto, MailLogMessageDto } from '@technic/contracts';
import { apiFetch, createListApi } from '@shared/api';

const PATH = '/admin/mail/log';

/**
 * Журнал отправки писем: что портал отправлял и чем это кончилось (ADR 0199).
 *
 * Только чтение, и других умений у объекта не будет: повтор письма модуля делает карточка заявки —
 * она знает событие и якорь дедупликации, а строка очереди помнит только их отпечаток.
 */
export const mailLogApi = {
  ...createListApi<MailLogItemDto>(PATH),
  /** Письмо целиком — по клику на строке: в списке тел нет, иначе страница весила бы мегабайты. */
  message: (id: string) => apiFetch<MailLogMessageDto>(`${PATH}/${id}`),
};
