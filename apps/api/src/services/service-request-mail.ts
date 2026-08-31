import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  COUNTERPARTY_SCOPED_ROLES,
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
  counterparties,
  departments,
  moduleMailRecipients,
  serviceRequestExecutors,
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
 * Служба читает почту, а не портал: заявка, которая ждёт разбора, обязана дойти сама («визы» здесь
 * больше нет — она упразднена, Р10; имя события `service_request_waiting_it` оставлено прежним,
 * потому что имена в коде не переименовываются, Р17). Событие привязано не к ручке, а к **входу
 * заявки в статус** — «Новой» она бывает и при заведении, и вернувшись откатом (ADR 0096), и ждут
 * её в обоих случаях.
 *
 * Отсюда же ключ дедупликации: строка истории статуса плюс адресат. По заявке ключ был бы неверен
 * дважды — повторный цикл «отменили → вернули» не дал бы второго письма, а второй адресат не
 * получил бы ничего (уникальность очереди — `(kind, dedupe_key)`).
 *
 * Третье письмо модуля — **о назначении** (план `office-equipment-requests-rework-plan.md`, §7.3,
 * Н13) — уходит по той же механике события и того же ключа, но адресовано не службе, а назначенным
 * людям: см. `planServiceAssignmentMail`. Всё остальное у него общее с первыми двумя намеренно —
 * второй способ ставить письма по заявке разошёлся бы с первым на первой же правке.
 *
 * Оно и держится не за статус, а за **действие**: назначение перестало быть переходом (план
 * упрощения цикла, Р5), и строку истории `from = to` под него пишет сама ручка состава. Ключ
 * дедупликации от этого не пострадал — строка истории есть, — а вот условие повтора письма службе
 * статусом больше не выражается: его считает `serviceMailRepeatable` по строке заявки (Р14).
 */

/** Канал, которым уходят письма модуля: ящик службы одновременно и отправитель, и получатель. */
const SERVICE_MAIL_ACCOUNT = 'repair';

/**
 * Какому событию соответствует вход в статус. Таблица отвечает ровно на один вопрос — «какое письмо
 * **службе** ставит общий помощник перехода», — и статуса для этого достаточно: адресаты у обоих
 * писем одни и те же, ящик канала и копии.
 *
 * **Письма о назначении здесь нет намеренно.** Назначение переходом больше не является вовсе (план
 * упрощения цикла, Р1): статус «Назначена» снят, а задание исполнителю ставит своё письмо по
 * действию — `planServiceAssignmentMail`, у которого и адресаты другие (назначенные люди и оператор
 * подрядчика, а не служба). Раньше это объяснялось тем, что вход в «Назначенную» письмо службе не
 * ставит; теперь объяснять нечего — входить некуда, — но следствие то же и держать его надо: впиши
 * назначение сюда, и письмо-задание уйдёт службе вместо исполнителей.
 *
 * **Условие ПОВТОРА эта таблица больше не задаёт.** Оно живёт в контрактах — `serviceMailRepeatable`
 * принимает СТРОКУ, а не статус (Р14): повторить письмо «Новой» можно, пока исполнителей нет. Оно
 * зовёт службу разобрать заявку, и после назначения повторять его незачем — задание уже ушло своим
 * письмом. Событие у статуса при этом остаётся: «какое письмо ставит переход» и «есть ли что
 * повторять» — два разных вопроса, и сошлись они только потому, что «Новая» означала «ещё не
 * назначена». Сервер и портал обязаны спрашивать один и тот же предикат: разойдись они, кнопка
 * вела бы в 422 либо повтор был бы недоступен там, где сервер его позволяет.
 */
const EVENT_BY_STATUS: Partial<Record<ServiceRequestStatus, ModuleMailEvent>> = {
  new: 'service_request_waiting_it',
  cancelled: 'service_request_cancelled',
};

/**
 * Какое письмо службе ставит вход в этот статус. Спрашивают её переходы; для повтора кнопкой этой
 * функции МАЛО — там решает `serviceMailRepeatable` по строке заявки (Р14, см. комментарий выше).
 */
export function serviceMailEventOf(status: ServiceRequestStatus): ModuleMailEvent | null {
  return EVENT_BY_STATUS[status] ?? null;
}

/** Получатель письма: ящик канала, назначенный исполнитель или заведённая копия. */
interface Recipient {
  /**
   * Часть ключа дедупликации — **чем вызвано письмо**, а не куда оно ушло: `channel` у основного
   * адресата писем службе, id учётки — у назначенного исполнителя, id строки — у копии.
   */
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
 * Накопитель адресатов: одно правило дедупликации на все письма модуля — **по адресу, а не по
 * ключу**.
 *
 * Дедупликация нужна потому, что источники адресатов пересекаются, и человек попадает в письмо
 * дважды с разных сторон: ящик службы бывает заведён ещё и копией, а назначенный исполнитель —
 * заодно и той копией, которой «хочется видеть все назначения». Ключи у таких попаданий разные (id
 * учётки и id строки настройки), и `(kind, dedupe_key)` в очереди их не схлопнет: в один ящик
 * придут два одинаковых письма.
 *
 * Первый источник побеждает — отсюда порядок вызовов: сперва тот, кому письмо адресовано, потом
 * копии. Обратный порядок отдал бы адресату обратный адрес копии (у неё свой режим), то есть тихо
 * подменил бы смысл письма настройкой, заведённой ради наблюдения со стороны.
 */
function recipientCollector(): {
  add: (key: string, email: string, replyTo: string) => void;
  list: Recipient[];
} {
  const seen = new Set<string>();
  const list: Recipient[] = [];
  return {
    list,
    add(key, email, replyTo) {
      const normalized = email.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      list.push({ key, email, replyTo });
    },
  };
}

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

  // Ящик канала первым и всегда: письмо адресовано службе, а копии — это «кому ещё». Копия на
  // адрес самого канала после этого отсеивается сама — двух одинаковых писем в один ящик не будет.
  const to = recipientCollector();
  to.add('channel', channelEmail, author?.email ?? '');
  for (const row of copies) {
    to.add(
      row.id,
      row.toEmail,
      replyToOf(row.replyToMode, row.replyToEmail, {
        author: author?.email ?? '',
        actor: ctx.actor.email,
      }),
    );
  }

  return { plan: { event, kind: event as MailKind, recipients: to.list }, outcome: 'queued' };
}

/**
 * Кому уйдёт письмо о назначении (план `docs/office-equipment-requests-rework-plan.md`, §7.3, Н13;
 * решение опроса В16).
 *
 * **Это единственное письмо модуля, адресованное людям, а не службе.** Остальные два уходят на ящик
 * канала: за ним нет учётки, и список копий только добавляет наблюдателей. Здесь наоборот — письмо
 * это задание на работу, и получает его тот, кому работать: назначенные поимённо сотрудники и
 * оператор сервисной компании, если заявку отдали ей. Ящик канала в адресатах не участвует: служба
 * назначение и сделала, и второе письмо об этом ей ни о чём не сообщает.
 *
 * Отсюда же три следствия, каждое из которых легко потерять:
 *
 * 1. **Заявителю письмо не уходит** (В16): движение по заявке он видит в портале, а задание — не
 *    его дело. Автор появляется здесь только обратным адресом: вопрос исполнителя про поломку
 *    адресован ему.
 * 2. **Копии из `module_mail_recipients` работают поверх, а не вместо.** Строка настройки на это
 *    событие — «хочу видеть все назначения»; подменить ею адресата нельзя.
 * 3. **Нет назначенных с ящиками — письма нет вовсе** (`no_recipients`). Отправить его одной службе
 *    было бы худшим из исходов: портал отчитался бы «письмо ушло», а исполнитель задания не увидел.
 *
 * Считается **до** транзакции, как и `planServiceMail` (Р67): здесь ходят в базу и в конфигурацию,
 * и упавшее внутри транзакции откатило бы саму заявку. Список приходит **параметром**, а не
 * вычитывается из `service_request_executors`: строк там на этот момент ещё нет — их пишет та самая
 * транзакция, ради которой письмо и составляется.
 */
export async function planServiceAssignmentMail(
  assignment: {
    /** Учётки, назначаемые поимённо, — те же, что уйдут в `service_request_executors`. */
    userIds: string[];
    /** Сервисная компания, если заявка назначается ей; `null` — назначение только своими силами. */
    serviceCounterpartyId: string | null;
  },
  ctx: { actor: { id: string; email: string }; authorId: string | null },
): Promise<ServiceMailPlanResult> {
  const event: ModuleMailEvent = 'service_request_assigned';
  if (!config.mail.enabled) return { plan: null, outcome: 'mail_disabled' };

  // Канал нужен и здесь, хотя его ящик писем не получает: он отправитель, и без настроенного
  // `From` письмо некому подписать.
  if (!config.mail.accounts[SERVICE_MAIL_ACCOUNT].configured) {
    return { plan: null, outcome: 'channel_missing' };
  }

  const [author] = ctx.authorId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.authorId))
    : [];
  const authorEmail = author?.email ?? '';

  /**
   * Условие живой учётки одно на обе стороны: задание адресуется тому, кто может войти в портал и
   * принять заявку. Архивная и отключённая учётки — это ящик, за которым никого нет; молчаливо
   * отправить туда письмо хуже, чем сказать назначившему «предупредите их сами».
   */
  const alive = (...extra: (SQL | undefined)[]) =>
    and(...extra, eq(users.isActive, true), isNull(users.deletedAt));

  const named = assignment.userIds.length
    ? await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(alive(inArray(users.id, assignment.userIds)))
        .orderBy(users.email)
    : [];

  /**
   * У сервисной компании поимённых строк нет (§4.2): назначается она целиком, а читают почту её
   * операторы — учётки, у которых этот контрагент задаёт область видимости. Их может не быть ни
   * одной, и это обычное дело: подрядчик без доступа в портал существует.
   *
   * Роль спрашивается вдобавок к контрагенту, а не вместо него: `users_operator_counterparty_check`
   * (миграция 0023) односторонний — «оператор обязан иметь контрагента», но не наоборот, и у
   * учётки, которую перевели на другую роль, привязка остаётся. Такой человек заявок компании уже
   * не видит, и задание ему — письмо в никуда. Список ролей берётся из контрактов, чтобы вторая
   * копия «кто работает от контрагента» не разошлась с первой.
   */
  const operators = assignment.serviceCounterpartyId
    ? await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          alive(
            eq(users.counterpartyId, assignment.serviceCounterpartyId),
            inArray(users.role, [...COUNTERPARTY_SCOPED_ROLES]),
          ),
        )
        .orderBy(users.email)
    : [];

  const to = recipientCollector();
  for (const row of [...named, ...operators]) to.add(row.id, row.email, authorEmail);
  if (to.list.length === 0) return { plan: null, outcome: 'no_recipients' };

  const copies = await db
    .select()
    .from(moduleMailRecipients)
    .where(and(eq(moduleMailRecipients.event, event), eq(moduleMailRecipients.isEnabled, true)));
  for (const row of copies) {
    to.add(
      row.id,
      row.toEmail,
      replyToOf(row.replyToMode, row.replyToEmail, { author: authorEmail, actor: ctx.actor.email }),
    );
  }

  return { plan: { event, kind: event as MailKind, recipients: to.list }, outcome: 'queued' };
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
  /**
   * Кого назначили — готовой строкой, потому что письмо её только печатает: «Иванов И. И.,
   * Петров П. П.». Пусто — поимённых исполнителей нет; у заявки, отданной одному лишь подрядчику,
   * это нормальное состояние (§4.2).
   */
  executorNames: string;
  /** Сервисная компания, если заявка назначена ей; `null` — своими силами. */
  serviceName: string | null;
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
      serviceName: counterparties.name,
      attachments: sql<number>`(
        SELECT count(*)::int FROM ${serviceRequestFiles}
         WHERE ${serviceRequestFiles.requestId} = ${serviceRequests.id}
      )`,
      /**
       * Исполнители подзапросом с псевдонимом, а не соединением: строк на заявку несколько, и
       * соединение размножило бы саму заявку — вложения посчитались бы по разу на исполнителя.
       * Псевдоним `ex_user` обязателен: `users` уже стоит в этом запросе автором заявки.
       */
      executorNames: sql<string>`(
        SELECT coalesce(string_agg(ex_user.full_name, ', ' ORDER BY ex_user.full_name), '')
          FROM ${serviceRequestExecutors} ex
          JOIN ${users} ex_user ON ex_user.id = ex.user_id
         WHERE ex.request_id = ${serviceRequests.id}
      )`,
    })
    .from(serviceRequests)
    .innerJoin(constructionObjects, eq(serviceRequests.equipmentObjectId, constructionObjects.id))
    .leftJoin(departments, eq(serviceRequests.customerDepartmentId, departments.id))
    .leftJoin(users, eq(serviceRequests.createdBy, users.id))
    .leftJoin(counterparties, eq(serviceRequests.serviceCounterpartyId, counterparties.id))
    .where(eq(serviceRequests.id, requestId));
  if (!row) throw new Error(`Заявка ${requestId} не найдена при сборке письма`);

  return {
    requestId,
    num: row.r.num,
    status: row.r.status,
    isUrgent: row.r.isUrgent,
    urgencyReason: row.r.urgencyReason,
    description: row.r.description,
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
    executorNames: row.executorNames,
    serviceName: row.serviceName,
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

/** Кому отдали заявку — одной строкой: свои сотрудники и подрядчик перечисляются подряд (§4.2). */
function assigneesOf(data: ServiceLetterData): string {
  return [data.executorNames, data.serviceName ?? ''].filter(Boolean).join(', ');
}

/**
 * Тело письма — самодостаточное: у службы учётки в портале может не быть вовсе, и ссылка ей ничего
 * не откроет. Вложения не прикладываются (контур их не носит), но их число названо — иначе о
 * фотографиях поломки никто не узнает.
 *
 * Письмо о назначении отличается двумя строками — списком назначенных и припиской: у него другой
 * адресат (`planServiceAssignmentMail`), и приписка «ответ уйдёт заявителю» без «заявка назначена
 * вам» читалась бы как уведомление службе, а не как задание.
 */
export function renderServiceLetter(
  event: ModuleMailEvent,
  data: ServiceLetterData,
): { subject: string; text: string; html: string } {
  const number = formatServiceRequestNumber(data.num);
  const urgent = data.isUrgent ? 'СРОЧНО · ' : '';
  const subject = `${urgent}${number} · ${moduleMailEventLabels[event]}`;
  const assignment = event === 'service_request_assigned';

  /**
   * Письмо о назначении без назначенных — не пустая строка, а признак того, что исполнителей
   * записали **после** перехода: данные письма читаются той же транзакцией, что их пишет. Молчать
   * тут нельзя — отказ ловит вызывающий и отвечает `mail_failed`, то есть «письма нет» будет
   * сказано вслух, а не показано пробелом в теле.
   */
  if (assignment && !assigneesOf(data)) {
    throw new Error(
      `Заявка ${number}: письмо о назначении собирается, а исполнителей у заявки нет — ` +
        'строки исполнителей пишутся до перехода статуса',
    );
  }

  const lines = [
    `Статус: ${serviceRequestStatusLabels[data.status]}`,
    ...(assignment ? [`Назначены: ${assigneesOf(data)}`] : []),
    `Техника: ${data.equipmentName}${numbersOf(data) ? ` · ${numbersOf(data)}` : ''}`,
    `Где стоит: ${data.objectCode} — ${data.objectName}${
      data.equipmentLocation ? `, ${data.equipmentLocation}` : ''
    }`,
    ...(data.departmentName ? [`Отдел: ${data.departmentName}`] : []),
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
      // Заголовок блока совпадает с подписью поля в портале (Р2, просьба 7): письмо и карточка
      // называют одно и то же одинаково, а на заявке про расходники «Что случилось» было мимо.
      { kind: 'heading' as const, text: 'Описание' },
      { kind: 'paragraph' as const, text: data.description },
      {
        kind: 'link' as const,
        href: `${config.publicOrigin}/office-equipment?tab=requests&id=${data.requestId}`,
        label: 'Открыть заявку в портале',
      },
      {
        kind: 'note' as const,
        text: assignment
          ? 'Заявка назначена вам — примите её в работу в портале. Ответ на это письмо уйдёт ' +
            'заявителю.'
          : 'Ссылка работает у тех, у кого есть доступ в портал. Ответ на это письмо уйдёт заявителю.',
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
