import { and, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_MAIL_ACCOUNT,
  formatServiceRequestNumber,
  moduleMailEventLabels,
  serviceRequestStatusLabels,
  type ModuleMailEvent,
  type ModuleMailOutcome,
  type ReplyToMode,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  moduleMailRecipients,
  serviceRequestFiles,
  serviceRequests,
  users,
} from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';
import { renderMail, type MailContent } from './mail-templates';
import { queuePreparedMail, type MailKind } from './mail';

/**
 * Письма службе по заявке на обслуживание оргтехники (план
 * `docs/office-equipment-mail-and-history-plan.md`, Р65–Р70, Р91).
 *
 * Служба читает почту, а не портал: заявка, которая ждёт её визы, обязана дойти сама. Событие
 * привязано не к ручке, а к **входу заявки в статус** — «Новой» она бывает и при заведении, и
 * вернувшись откатом (ADR 0096), и ждут её в обоих случаях.
 *
 * Отсюда же ключ дедупликации: строка истории статуса плюс адресат. По заявке ключ был бы неверен
 * дважды — повторный цикл «отменили → вернули» не дал бы второго письма, а второй адресат не
 * получил бы ничего (уникальность очереди — `(kind, dedupe_key)`).
 */

/** Канал, которым уходят письма модуля: ящик службы одновременно и отправитель, и получатель. */
const SERVICE_MAIL_ACCOUNT = 'repair';

/**
 * Какому событию соответствует вход в статус. Перечень согласован с `serviceMailRepeatable` в
 * контрактах — это же условие показывает кнопку повтора в портале: разойдись они, кнопка вела бы в
 * 422 либо повтор был бы недоступен там, где сервер его позволяет.
 */
const EVENT_BY_STATUS: Partial<Record<ServiceRequestStatus, ModuleMailEvent>> = {
  new: 'service_request_waiting_it',
  cancelled: 'service_request_cancelled',
};

export function serviceMailEventOf(status: ServiceRequestStatus): ModuleMailEvent | null {
  return EVENT_BY_STATUS[status] ?? null;
}

/** Получатель письма: ящик канала или заведённая копия. */
interface Recipient {
  /** Часть ключа дедупликации: `channel` у основного адресата, id строки — у копии. */
  key: string;
  email: string;
  /** Куда уйдёт ответ; пусто — общий адрес портала. */
  replyTo: string;
}

export interface ServiceMailPlan {
  event: ModuleMailEvent;
  kind: MailKind;
  recipients: Recipient[];
}

export type ServiceMailPlanResult =
  | { plan: ServiceMailPlan; outcome: 'queued' }
  | { plan: null; outcome: Exclude<ModuleMailOutcome, 'queued'> };

/**
 * Кому и с каким обратным адресом уйдёт письмо. Считается **до** транзакции заявки: здесь ходят в
 * базу и в конфигурацию, и упавшее внутри транзакции откатило бы саму заявку (Р67).
 *
 * Пустой список копий — не повод молчать: основной адресат известен и без настройки, это ящик
 * самого канала (Р91). Молчит портал только тогда, когда почта выключена или канал не настроен на
 * сервере, — и оба случая возвращаются исходом, а не отказом.
 */
export async function planServiceMail(
  status: ServiceRequestStatus,
  ctx: { actor: { id: string; email: string }; authorId: string | null },
): Promise<ServiceMailPlanResult> {
  const event = serviceMailEventOf(status);
  if (!event) return { plan: null, outcome: 'mail_disabled' };
  if (!config.mail.enabled) return { plan: null, outcome: 'mail_disabled' };

  const channel = config.mail.accounts[SERVICE_MAIL_ACCOUNT];
  if (!channel.configured) return { plan: null, outcome: 'channel_missing' };

  // Адрес ящика службы — из `From` канала: «Ремонт <repair@…>» → сам адрес.
  const channelEmail = addressOf(channel.from);
  if (!channelEmail) return { plan: null, outcome: 'channel_missing' };

  const [author] = ctx.authorId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.authorId))
    : [];

  const copies = await db
    .select()
    .from(moduleMailRecipients)
    .where(and(eq(moduleMailRecipients.event, event), eq(moduleMailRecipients.isEnabled, true)));

  const recipients: Recipient[] = [
    // Ящик канала первым и всегда: письмо адресовано службе, а копии — это «кому ещё».
    { key: 'channel', email: channelEmail, replyTo: author?.email ?? '' },
    ...copies
      // Копия на адрес самого канала означала бы два одинаковых письма в один ящик.
      .filter((row) => row.toEmail.toLowerCase() !== channelEmail.toLowerCase())
      .map((row) => ({
        key: row.id,
        email: row.toEmail,
        replyTo: replyToOf(row.replyToMode, row.replyToEmail, {
          author: author?.email ?? '',
          actor: ctx.actor.email,
        }),
      })),
  ];

  return { plan: { event, kind: event as MailKind, recipients }, outcome: 'queued' };
}

/**
 * Адрес из строки отправителя: `«Ремонт оргтехники <repair@example.ru>»` → `repair@example.ru`.
 * Строка без угловых скобок — уже адрес.
 */
function addressOf(from: string): string {
  const match = /<([^>]+)>/u.exec(from);
  return (match?.[1] ?? from).trim();
}

/**
 * Обратный адрес по режиму строки (Р68). Откат при пустом адресе: `author`/`actor` → запасной
 * адрес этой же строки → общий адрес портала (пустая строка означает именно его).
 */
function replyToOf(
  mode: ReplyToMode,
  fallback: string,
  people: { author: string; actor: string },
): string {
  switch (mode) {
    case 'fixed':
      return fallback;
    case 'author':
      return people.author || fallback;
    case 'actor':
      return people.actor || fallback;
    case 'portal':
      return '';
  }
}

/** Что письмо рассказывает о заявке. Собирается одним запросом по её же строке. */
export interface ServiceLetterData {
  requestId: string;
  num: number;
  status: ServiceRequestStatus;
  isUrgent: boolean;
  urgencyReason: string;
  description: string;
  dueDate: string | null;
  responsibleName: string;
  responsiblePhone: string;
  equipmentName: string;
  equipmentSerialNumber: string;
  equipmentInventoryNumber: string;
  equipmentLocation: string;
  objectCode: string;
  objectName: string;
  departmentName: string | null;
  attachments: number;
  authorName: string | null;
}

/** Транзакция drizzle: письмо ставится вместе с тем, ради чего оно отправляется. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Данные письма — одним запросом по строке самой заявки, внутри той же транзакции. Чтение
 * собственной только что записанной строки отказать по данным не может: её нет только если нет и
 * транзакции. Собирать те же поля дважды — в ручке заведения и в ручке перехода — значило бы
 * завести два письма, расходящихся с первой правки.
 */
export async function loadServiceLetterData(tx: Tx, requestId: string): Promise<ServiceLetterData> {
  const [row] = await tx
    .select({
      r: serviceRequests,
      objectCode: constructionObjects.code,
      objectName: constructionObjects.name,
      departmentName: departments.name,
      authorName: users.fullName,
      attachments: sql<number>`(
        SELECT count(*)::int FROM ${serviceRequestFiles}
         WHERE ${serviceRequestFiles.requestId} = ${serviceRequests.id}
      )`,
    })
    .from(serviceRequests)
    .innerJoin(constructionObjects, eq(serviceRequests.equipmentObjectId, constructionObjects.id))
    .leftJoin(departments, eq(serviceRequests.customerDepartmentId, departments.id))
    .leftJoin(users, eq(serviceRequests.createdBy, users.id))
    .where(eq(serviceRequests.id, requestId));
  if (!row) throw new Error(`Заявка ${requestId} не найдена при сборке письма`);

  return {
    requestId,
    num: row.r.num,
    status: row.r.status,
    isUrgent: row.r.isUrgent,
    urgencyReason: row.r.urgencyReason,
    description: row.r.description,
    dueDate: row.r.dueDate,
    responsibleName: row.r.responsibleName,
    responsiblePhone: row.r.responsiblePhone,
    equipmentName: row.r.equipmentName,
    equipmentSerialNumber: row.r.equipmentSerialNumber,
    equipmentInventoryNumber: row.r.equipmentInventoryNumber,
    equipmentLocation: row.r.equipmentLocation,
    objectCode: row.objectCode,
    objectName: row.objectName,
    departmentName: row.departmentName,
    attachments: row.attachments,
    authorName: row.authorName,
  };
}

/** Номера единицы одной строкой: их печатает производитель и клеит бухгалтерия. */
function numbersOf(data: ServiceLetterData): string {
  const parts = [
    data.equipmentInventoryNumber ? `инв. ${data.equipmentInventoryNumber}` : '',
    data.equipmentSerialNumber ? `SN ${data.equipmentSerialNumber}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Тело письма — самодостаточное: у службы учётки в портале может не быть вовсе, и ссылка ей ничего
 * не откроет. Вложения не прикладываются (контур их не носит), но их число названо — иначе о
 * фотографиях поломки никто не узнает.
 */
export function renderServiceLetter(
  event: ModuleMailEvent,
  data: ServiceLetterData,
): { subject: string; text: string; html: string } {
  const number = formatServiceRequestNumber(data.num);
  const urgent = data.isUrgent ? 'СРОЧНО · ' : '';
  const subject = `${urgent}${number} · ${moduleMailEventLabels[event]}`;

  const lines = [
    `Статус: ${serviceRequestStatusLabels[data.status]}`,
    `Техника: ${data.equipmentName}${numbersOf(data) ? ` · ${numbersOf(data)}` : ''}`,
    `Где стоит: ${data.objectCode} — ${data.objectName}${
      data.equipmentLocation ? `, ${data.equipmentLocation}` : ''
    }`,
    ...(data.departmentName ? [`Отдел: ${data.departmentName}`] : []),
    ...(data.dueDate ? [`Желаемый срок: ${data.dueDate}`] : []),
    ...(data.responsibleName || data.responsiblePhone
      ? [`Контакт: ${[data.responsibleName, data.responsiblePhone].filter(Boolean).join(', ')}`]
      : []),
    ...(data.authorName ? [`Заявку завёл: ${data.authorName}`] : []),
    ...(data.attachments > 0 ? [`Вложений в заявке: ${data.attachments} (см. в портале)`] : []),
  ];

  const content: MailContent = {
    title: `${number} — ${moduleMailEventLabels[event]}`,
    blocks: [
      // Срочность первой строкой тела, а не только пометкой в теме: причину читают до того, как
      // решают, ехать ли сегодня.
      ...(data.isUrgent && data.urgencyReason
        ? [{ kind: 'paragraph' as const, text: `Срочно: ${data.urgencyReason}` }]
        : []),
      { kind: 'lines' as const, lines },
      { kind: 'heading' as const, text: 'Что случилось' },
      { kind: 'paragraph' as const, text: data.description },
      {
        kind: 'link' as const,
        href: `${config.publicOrigin}/office-equipment?tab=requests&id=${data.requestId}`,
        label: 'Открыть заявку в портале',
      },
      {
        kind: 'note' as const,
        text: 'Ссылка работает у тех, у кого есть доступ в портал. Ответ на это письмо уйдёт заявителю.',
      },
    ],
  };

  const rendered = renderMail(content);
  return { subject, text: rendered.text, html: rendered.html };
}

/**
 * Ставит письма события — по одному на адресата, каждое со своим ключом дедупликации.
 *
 * Внутри транзакции заявки: письмо не может уйти по заявке, которой нет. Ошибка сборки тела ловится
 * вызывающим и даёт мягкий исход `mail_failed`, ошибка вставки — отказ хранилища и откат всего.
 */
export async function queueServiceMails(
  tx: Tx,
  params: {
    plan: ServiceMailPlan;
    statusHistoryId: string;
    requestId: string;
    /** Уже отрисованное тело: ошибка рендера ловится вызывающим и даёт мягкий исход. */
    letter: { subject: string; text: string; html: string };
    /** Отличает повтор кнопкой от письма самого события (Р70). */
    idempotencyKey?: string;
  },
): Promise<void> {
  const { letter } = params;
  const suffix = params.idempotencyKey ? `:${params.idempotencyKey}` : '';

  for (const recipient of params.plan.recipients) {
    await queuePreparedMail(
      {
        kind: params.plan.kind,
        dedupeKey: `${params.plan.event}:${params.statusHistoryId}:${recipient.key}${suffix}`,
        to: recipient.email,
        account: SERVICE_MAIL_ACCOUNT,
        replyTo: recipient.replyTo,
        subject: letter.subject,
        text: letter.text,
        html: letter.html,
        entityType: 'serviceRequest',
        entityId: params.requestId,
      },
      { tx },
    );
  }
}

/**
 * Неудача сборки письма: заявка сохранена, письма нет. Пишется **после** фиксации транзакции —
 * `writeAudit` ходит мимо неё, и запись, сделанная внутри, пережила бы откат.
 */
export function logServiceMailFailure(requestId: string, error: unknown): void {
  logger.error({ err: error, requestId }, 'Письмо по заявке на обслуживание не собралось');
}

/**
 * Каким исходом закончилась почтовая часть. Значение возвращается ответом ручки и показывается в
 * портале: «заявка заведена, но служба не оповещена» — это то, что человек обязан узнать сразу.
 */
export type ServiceMailOutcome = ModuleMailOutcome;

export const DEFAULT_SERVICE_MAIL_ACCOUNT = DEFAULT_MAIL_ACCOUNT;
