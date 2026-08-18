import type {
  CreateMailingScheduleBody,
  ListResult,
  MailAccountStatusDto,
  MailingRecipientCandidateDto,
  MailingRunDto,
  MailingScheduleDto,
  MailTestBody,
  Role,
  UpdateMailingScheduleBody,
} from '@technic/contracts';
import { apiFetch } from '@shared/api';

/**
 * Ручки почтового контура (ADR 0075, 0111): расписания рассылок, история их запусков и отладочная
 * отправка.
 *
 * Половина этого домена — не ручки, а типы ответов, которых нет в контрактах: получатель
 * отладочного письма, водитель-образец, учётка-образец и счётчики запуска приходят из
 * административных ручек и описаны портальной стороной. В общем реестре ресурсов они выглядели
 * набором безымянных структур посреди справочников; здесь у них один адресат — вкладка «Рассылки»,
 * и объясняются они вместе с ручками, которые их отдают.
 *
 * Импорт через `api/resources` остаётся рабочим: реестр реэкспортирует всё, что здесь объявлено.
 */

/** Строка запроса: набор ключей у каждой ручки свой, общего в них — только форма. */
type Query = Record<string, unknown>;

/** Получатель отладочного письма: действующий администратор и его адрес. */
export interface MailTestRecipient {
  id: string;
  fullName: string;
  email: string;
}

/** Водитель-образец для отладочного письма: чьё задание собрать. */
export interface MailTestDriver {
  personId: string;
  fullName: string;
  email: string;
}

/**
 * Учётка-образец для отладочной сводки: чьими глазами её собрать. Роль показывается рядом с именем
 * не для красоты — по ней и выбирают, чью сводку смотреть: проверяют обычно не человека, а то, что
 * видит роль.
 */
export interface MailDigestSampleUser {
  id: string;
  fullName: string;
  email: string;
  role: Role;
}

/**
 * Итоги запуска рассылки. Письмо составляется не каждому: у водителя может не быть адреса, он
 * может стоять в исключениях расписания, а рейсов в окне может не оказаться вовсе — и все три
 * случая считаются отдельно, потому что чинят их по-разному.
 */
export interface MailingRunStats {
  sent: number;
  withoutEmail: number;
  excluded: number;
  empty: number;
}

/**
 * Рассылки: расписания, их история и отладочная отправка (ADR 0075). Отладка стоит рядом с
 * расписаниями, но отвечает на другой вопрос — «как письмо выглядит в почтовом клиенте», тогда
 * как расписание отвечает «кому и когда оно уходит само».
 */
export const mailingsApi = {
  testRecipients: () => apiFetch<MailTestRecipient[]>('/admin/mail/test-recipients'),
  /** Водители с рейсами на дату: список зависит от даты, поэтому запрашивается вместе с ней. */
  driversWithRoutes: (date: string) =>
    apiFetch<MailTestDriver[]>('/admin/mail/drivers-with-routes', { query: { date } }),
  /**
   * Кем можно «посмотреть» сводку. Даты в запросе нет намеренно: сводка собирается под любым
   * действующим человеком, и пустота за выбранный день — это уже её ответ, а не повод прятать его
   * из списка.
   */
  digestSampleUsers: () => apiFetch<MailDigestSampleUser[]>('/admin/mail/digest-sample-users'),
  /** Какие каналы отправки настроены на сервере: список известен контрактами, признак — только ему. */
  accounts: () => apiFetch<MailAccountStatusDto[]>('/admin/mail/accounts'),
  sendTest: (body: MailTestBody) =>
    apiFetch<{ ok: boolean; message: string }>('/admin/mail/test', { method: 'POST', body }),
  /** Расписания приходят целиком и вместе с исключениями: их в портале единицы, листать нечего. */
  schedules: () => apiFetch<MailingScheduleDto[]>('/admin/mail/schedules'),
  createSchedule: (body: CreateMailingScheduleBody) =>
    apiFetch<MailingScheduleDto>('/admin/mail/schedules', { method: 'POST', body }),
  /**
   * Правка уходит целиком, вместе с `version`: применимость каждого поля решает соседнее, а
   * несовпавшая версия означает, что расписание успели изменить в другом окне (409).
   */
  updateSchedule: (id: string, body: UpdateMailingScheduleBody) =>
    apiFetch<MailingScheduleDto>(`/admin/mail/schedules/${id}`, { method: 'PATCH', body }),
  deleteSchedule: (id: string) =>
    apiFetch<void>(`/admin/mail/schedules/${id}`, { method: 'DELETE' }),
  /**
   * Кого зацепит сводка при таком наборе прав и областей. Считает сервер тем же отбором, каким
   * рассылка выбирает адресатов: правило «нет площадко-отдельной оси — фильтр по площадкам не
   * применяется» в общий список учёток не встроить, эффективное право учётки по справочнику
   * вообще не сосчитать (ADR 0111), а цифра под формой обязана совпадать с тем, кого возьмёт
   * планировщик.
   */
  recipientCandidates: (q: Query) =>
    apiFetch<MailingRecipientCandidateDto[]>('/admin/mail/recipient-candidates', { query: q }),
  /** История запусков — с пагинацией, в отличие от расписаний: она прирастает каждый день. */
  runs: (q: Query) => apiFetch<ListResult<MailingRunDto>>('/admin/mail/runs', { query: q }),
  /** Запуск «сейчас»: письма уходят настоящим получателям, поэтому кнопка спрашивает подтверждение. */
  runNow: (id: string) =>
    apiFetch<{ ok: boolean; runId: string; stats: MailingRunStats }>(
      `/admin/mail/schedules/${id}/run`,
      { method: 'POST' },
    ),
};
