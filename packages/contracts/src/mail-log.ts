import { z } from 'zod';
import { baseListQuery } from './common';
import { DEFAULT_MAIL_ACCOUNT, MAIL_ACCOUNTS, type MailAccount } from './mail-accounts';

/**
 * Журнал отправки писем — то, что администратор видит на подвкладке «Аудит» раздела «Рассылки».
 *
 * **Зачем понадобился.** Очередь `mail_messages` (миграция 0097) хранит адресата, тело и исход
 * доставки с первого дня, но прочитать её можно было только запросом к базе. Пока письмо было одно
 * («задание водителю»), это терпелось; с полным контуром модуля «Орг.техника» (ADR 0159) видов
 * стало двадцать, и вопрос «ушло ли письмо подрядчику» стал ежедневным — а ответ на него жил в SQL.
 *
 * **Почему отбор по каналу обязателен, а не «все подряд».** Каналов два, и смешивать их в одном
 * списке нельзя: `default` — это сотни заданий водителям за день, `repair` — десятки писем по
 * заявкам оргтехники. В общем списке второе тонет в первом ровно тогда, когда его ищут. Поэтому
 * канал — не фильтр со значением «любой», а переключатель с умолчанием: список всегда про
 * конкретный контур отправки.
 *
 * **Чего здесь нет намеренно.** Ни повтора отправки, ни правки, ни удаления: журнал отвечает на
 * вопрос «что было», а повторную отправку письма модуля делает своя кнопка в карточке заявки — она
 * знает событие и якорь, а строка очереди про них не помнит.
 */

/**
 * Виды писем — перечень `mail_kind` целиком, включая технические (сводки окна и пачки).
 *
 * Полный, а не подмножество `MAIL_TEST_KINDS`: отладка отправляет то, что можно собрать по
 * образцу, а журнал показывает то, что портал действительно отправлял, — и сводка, которой
 * подменили поток писем по шумной заявке, в нём обязана быть подписана, иначе администратор увидит
 * в «причине» технический код.
 *
 * Порядок — как в `mailKindEnum` (миграции 0097 и далее): список читают глазами, сверяя с базой.
 */
export const MAIL_KINDS = [
  'verify_email',
  'password_reset',
  'password_changed',
  'driver_routes',
  'role_digest',
  'registration_rejected',
  'registration_approved',
  'account_created',
  'email_changed',
  'service_request_waiting_it',
  'service_request_cancelled',
  'service_request_assigned',
  'service_request_status_changed',
  'service_request_estimate',
  'service_request_document',
  'service_request_comment',
  'service_request_activity_summary',
  'office_equipment_candidate_pending',
  'office_equipment_candidate_decided',
  'service_request_bulk_summary',
] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/**
 * Причина письма человеческим языком — то, что стоит в колонке «Причина».
 *
 * Закрытый `Record`: новый вид письма не проедет мимо подписи, и в журнале не появится строка с
 * кодом `service_request_*` вместо объяснения. Подписи технических сводок начинаются со слова
 * «Сводка» намеренно — по ним видно, что письма события в этот час не было, его заменили.
 */
export const mailKindLabels: Record<MailKind, string> = {
  verify_email: 'Подтверждение адреса при регистрации',
  password_reset: 'Восстановление пароля',
  password_changed: 'Уведомление о смене пароля',
  driver_routes: 'Задание водителю на рейсы',
  role_digest: 'Сводка по ролям',
  registration_rejected: 'Отказ по заявке на регистрацию',
  registration_approved: 'Одобрение заявки на регистрацию',
  account_created: 'Учётная запись заведена администратором',
  email_changed: 'Смена адреса учётной записи',
  service_request_waiting_it: 'Оргтехника: заявка ждёт разбора',
  service_request_cancelled: 'Оргтехника: заявка отменена',
  service_request_assigned: 'Оргтехника: заявка назначена исполнителю',
  service_request_status_changed: 'Оргтехника: заявка сменила состояние',
  service_request_estimate: 'Оргтехника: движение по объёму работ',
  service_request_document: 'Оргтехника: приложены документы',
  service_request_comment: 'Оргтехника: реплика в обсуждении',
  service_request_activity_summary: 'Сводка: по заявке идёт работа',
  office_equipment_candidate_pending: 'Оргтехника: сообщение о технике ждёт проверки',
  office_equipment_candidate_decided: 'Оргтехника: решение по сообщению о технике',
  service_request_bulk_summary: 'Сводка: массовое действие над заявками',
};

/** Исход доставки: письмо составлено и ждёт, отправлено или отвергнуто. */
export const MAIL_STATUSES = ['pending', 'sent', 'failed'] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

/**
 * Подписи исходов. «Ждёт отправки» — не «ошибка»: письмо стоит в очереди, и задача его заберёт;
 * зависшее письмо видно по времени в колонке «Когда», а не по особому состоянию.
 */
export const mailStatusLabels: Record<MailStatus, string> = {
  pending: 'Ждёт отправки',
  sent: 'Отправлено',
  failed: 'Не отправлено',
};

/** Цвет тега исхода в таблице: красный только у настоящего отказа. */
export const mailStatusColors: Record<MailStatus, string> = {
  pending: 'gold',
  sent: 'green',
  failed: 'red',
};

export const MAIL_LOG_SORT_FIELDS = ['createdAt', 'toEmail', 'status'] as const;

/**
 * Запрос журнала. `account` с умолчанием, а не необязательный: список без канала смешал бы
 * задания водителям с письмами подрядчику — см. рассуждение в шапке файла.
 *
 * Поиск — по адресу получателя и теме письма: по этим двум полям письмо и ищут («что уходило на
 * info@…», «где письма по СО-94» — номер стоит в теме).
 */
export const mailLogQuerySchema = baseListQuery(MAIL_LOG_SORT_FIELDS).extend({
  account: z.enum(MAIL_ACCOUNTS).default(DEFAULT_MAIL_ACCOUNT),
  kind: z.enum(MAIL_KINDS).optional(),
  status: z.enum(MAIL_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * Строка журнала. Тела письма здесь нет: список из пятисот строк с телами весил бы мегабайты, а
 * читают тело у одной строки — той, по которой кликнули.
 */
export interface MailLogItemDto {
  id: string;
  /** Когда письмо было СОСТАВЛЕНО: отправка происходит позже, и её время — отдельным полем. */
  createdAt: string;
  kind: MailKind;
  toEmail: string;
  subject: string;
  status: MailStatus;
  sentAt: string | null;
  /** Отказ SMTP одной строкой; пусто — отказа не было. */
  lastError: string;
  /** Отладочная отправка администратору: такие письма не относятся к работе портала. */
  isTest: boolean;
}

/** Письмо целиком — то, что открывается по клику на строке. */
export interface MailLogMessageDto extends MailLogItemDto {
  account: MailAccount;
  /** Куда уйдёт ответ адресата; пусто — общий адрес портала. */
  replyTo: string;
  bodyText: string;
  bodyHtml: string;
  /** Идентификатор письма у провайдера — по нему письмо ищут в его журнале. */
  providerId: string;
  /** Ключ бизнес-события: по нему видно, почему второго такого письма не появилось. */
  dedupeKey: string;
  entityType: string | null;
  entityId: string | null;
}
