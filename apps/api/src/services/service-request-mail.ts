import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_MAIL_ACCOUNT,
  formatServiceRequestNumber,
  moduleMailEventLabels,
  SERVICE_REQUEST_NO_EQUIPMENT,
  serviceFileKindLabels,
  serviceRequestStatusLabels,
  type ModuleMailEvent,
  type ModuleMailOutcome,
  type ServiceMailTargets,
  type ServiceFileKind,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  counterparties,
  departments,
  serviceRequestExecutors,
  serviceRequestFiles,
  serviceRequests,
  users,
} from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';
import { writeAuditTx } from '../lib/audit';
import { renderMail, type MailContent } from './mail-templates';
import { queuePreparedMail, type MailKind } from './mail';
import {
  addressOf,
  collectServiceMailRecipients,
  copyRecipients,
  counterpartySideRecipients,
  isServiceMailEventEnabled,
  namedRecipients,
  sideRecipients,
  type ServiceMailActor,
  type ServiceMailAudience,
  type ServiceMailAudienceCtx,
  type ServiceMailRecipient,
  type ServiceRequestSide,
} from './service-request-mail-audience';

/** Сторона заявки на момент факта: ручки снимают её до бизнес-изменения (§5.2). */
export {
  documentMailTargets,
  readServiceSide,
  type ServiceRequestSide,
} from './service-request-mail-audience';

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
export const SERVICE_MAIL_ACCOUNT = 'repair';

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
  /**
   * Переходы цикла — одно событие на четыре входа (§3, № 4). Дробить его по статусам значило бы
   * четыре строки в настройке копий и вопрос «а если включены две»; какой именно переход
   * случился, письмо говорит строкой «Было → стало», а не своим именем.
   *
   * `assigned` и `estimate_review` сюда не входят: статусы мёртвые (0224), заявок в них не бывает.
   */
  in_work: 'service_request_status_changed',
  on_hold: 'service_request_status_changed',
  done: 'service_request_status_changed',
  accepted: 'service_request_status_changed',
};

/**
 * Какое письмо службе ставит вход в этот статус. Спрашивают её переходы; для повтора кнопкой этой
 * функции МАЛО — там решает `serviceMailRepeatable` по строке заявки (Р14, см. комментарий выше).
 */
export function serviceMailEventOf(status: ServiceRequestStatus): ModuleMailEvent | null {
  return EVENT_BY_STATUS[status] ?? null;
}

/**
 * Что можно послать заново кнопкой «Отправить ещё раз» (Р70) — только письма СЛУЖБЕ: «заявка ждёт
 * разбора» и «заявка отменена». Событие переходов кнопкой не повторяется: оно адресовано рабочей
 * стороне и привязано к конкретному входу в статус, а повтор из карточки взял бы последний вход и
 * второй раз объявил бы исполнителю о том, что и так случилось час назад.
 */
export function repeatableServiceMailEventOf(status: ServiceRequestStatus): ModuleMailEvent | null {
  const event = serviceMailEventOf(status);
  return event === 'service_request_status_changed' ? null : event;
}

/**
 * Кому написано письмо — **своим, назначенной организации или прежнему подрядчику** (ADR 0153).
 * Различие не косметическое: у подрядчика ответ замкнут на службу, а не на заявителя, и приписка в
 * теле обязана говорить правду именно ему — он вне портала, и обратный адрес для него единственный
 * способ ответить. Прежнему подрядчику нужно отдельное тело: это отзыв задания, а не новое
 * назначение.
 *
 * Копия из `module_mail_recipients` — четвёртая аудитория, и завелась она ровно из-за приписки. У
 * копии СВОЙ режим обратного адреса (`author`, `actor`, `fixed`, `portal`), и любое тело, которое
 * называет адрес ответа, для неё враньё: письмо обещало бы службу там, где ответ уйдёт заявителю
 * или на фиксированный ящик. Поэтому копия получает тело, которое про ответ ничего не утверждает.
 */
export type { ServiceMailAudience } from './service-request-mail-audience';

/** Получатель письма: ящик канала, назначенный исполнитель, подрядчик или заведённая копия. */
/**
 * Намерение письма: **что случилось**, а не кому писать.
 *
 * Готовый список адресатов снаружи больше не приходит (§5.2, ADR 0159, решение 5). Ручка знает
 * только факт и то, чего нет в строке заявки: при назначении — кого добавили и какую компанию
 * сменили, потому что новую запись транзакция как раз делает, а прежнюю после неё не достать.
 * Всё остальное — операторы, поимённые исполнители, их права, ящик компании и копии — читает сама
 * транзакция после блокировки заявки.
 */
export interface ServiceMailIntent {
  event: ModuleMailEvent;
  actor: ServiceMailActor;
  /** Автор заявки: его адрес — обратный у двух сложившихся писем службе (§5.8). */
  authorId: string | null;
  /**
   * Что случилось с объёмом работ; есть только у `service_request_estimate`. Ревизия и действие
   * задают якорь дедупликации: повторное предъявление той же ревизии письма не удваивает, а новая
   * ревизия — это новое письмо, потому что предъявили другие числа.
   */
  estimate?: { revision: number; action: 'submit' | 'approved' | 'reopened' };
  /**
   * Приложенные документы; есть только у `service_request_document`. Цели считает
   * `documentMailTargets` в маршруте — там, где известна сторона приложившего под блокировкой.
   */
  document?: {
    targets: Array<'office' | 'service'>;
    kind: ServiceFileKind;
    /** Имена файлов пачки: письмо называет, что именно подшили, а не «добавлено 2». */
    names: string[];
    /** Сколько файлов у заявки стало всего — чтобы адресат понимал, полон ли комплект. */
    total: number;
  };
  /**
   * Реплика обсуждения; есть только у `service_request_comment`. Цели считает `chatMailTargets` из
   * контрактов — по адресатам самой реплики, а не по правам автора (§ 4).
   */
  comment?: {
    targets: Array<'office' | 'service'>;
    /** Поимённые адресаты: письмо получит только назначенная учётка с правом исполнителя. */
    userIds: string[];
  };
  /** Дельта назначения; есть только у `service_request_assigned`. */
  assignment?: {
    /** Добавленные поимённо — не весь состав: задание уходит тому, кому его выдали. */
    userIds: string[];
    serviceCounterpartyId: string | null;
    previousServiceCounterpartyId: string | null;
  };
}

/**
 * Подготовка письма **до** транзакции: только то, что читается из конфигурации процесса и не
 * зависит от прав и состояния заявки (§5.9). Отказ здесь — мягкий исход, и транзакция идёт дальше
 * без почтовой части.
 *
 * Обратный адрес внутреннего тела считается здесь же: у двух сложившихся писем службе это автор
 * заявки, и его email — единственное, ради чего эта функция ходит в базу.
 */
export interface ServiceMailPreparation {
  intent: ServiceMailIntent;
  ctx: ServiceMailAudienceCtx;
  /** Исход конфигурации: `null` — препятствий нет, дальше решает транзакция. */
  configOutcome: 'mail_disabled' | 'channel_missing' | null;
}

/**
 * Обратный адрес внутреннего тела по событию (§5.8).
 *
 * `waiting_it` и `cancelled` отвечают автору заявки — так сложилось и менять это незачем: письмо
 * адресовано службе, а вопросы у неё именно к заявителю. У писем цикла обратный адрес — ящик
 * службы: это рабочая переписка по заявке, и ответ обязан попасть тем, кто её ведёт.
 */
const AUTHOR_REPLY_EVENTS: ReadonlySet<ModuleMailEvent> = new Set<ModuleMailEvent>([
  'service_request_waiting_it',
  'service_request_cancelled',
]);

export async function prepareServiceMail(
  intent: ServiceMailIntent,
): Promise<ServiceMailPreparation> {
  const channel = config.mail.accounts[SERVICE_MAIL_ACCOUNT];
  const channelEmail = channel.configured ? addressOf(channel.from) : '';
  const [author] = intent.authorId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, intent.authorId))
    : [];
  const authorEmail = author?.email ?? '';
  const ctx: ServiceMailAudienceCtx = {
    channelEmail,
    internalReplyTo: AUTHOR_REPLY_EVENTS.has(intent.event)
      ? authorEmail || channelEmail
      : channelEmail,
    actor: intent.actor,
  };
  const configOutcome = !config.mail.enabled
    ? 'mail_disabled'
    : !channelEmail
      ? 'channel_missing'
      : null;
  return { intent, ctx, configOutcome };
}

/**
 * Есть ли у заявки сторона сервиса. Это НЕ «назначена ли компания»: слоя у назначения два (Н5), и
 * заявку, которую ведёт свой сисадмин поимённо, сторона сервиса тоже имеет — иначе «приняли в
 * работу», «отменена» и приложенный акт не доходили бы до того, кто её и делает.
 *
 * Один предикат на все ветки намеренно: пока их было три — объявление целей, сбор кандидатов и
 * цели документа, — они успели разойтись, и реплика «Сервисному центру» на заявке без компании
 * объявляла обязательную цель, для которой никто не собирался.
 */
function hasServiceSide(side: ServiceRequestSide): boolean {
  return side.serviceCounterpartyId !== null || side.executorUserIds.length > 0;
}

/** Кому адресовано событие: обязательные цели, по которым и считается исход (§5.10). */
type RequiredTarget = 'office' | 'service' | 'assignment' | 'withdrawal';

/**
 * Обязательные цели события. `assigned` в этой таблице нет: у него цели считаются по дельте
 * намерения — выдали задание, отозвали его, или не случилось ни того ни другого (тогда письма и не
 * требовалось, §5.10).
 */
const TARGETS_BY_EVENT: Partial<Record<ModuleMailEvent, RequiredTarget[]>> = {
  /**
   * Сторона подрядчика у «Новой» — изменение решения 3 ADR 0153 (Р3). Там откат в «Новую» ему не
   * писал: «заявка снова ждёт разбора» адресовано службе. С полным контуром это перестало быть
   * правдой — `in_work → new` исполнителя не снимает, заявка остаётся за компанией, и молчание
   * означает, что она собирает выезд по заявке, которую разбирают заново. Второй путь в «Новую»
   * (возврат отменённой) исполнителя снимает сам, и подрядчика там не окажется по устройству.
   */
  service_request_waiting_it: ['office', 'service'],
  service_request_cancelled: ['office', 'service'],
  // Переход цикла касается обеих сторон; кто его вызвал, письма о нём не получает (§5.4).
  service_request_status_changed: ['office', 'service'],
};

/** Исход каждой цели по отдельности плюс общий: смешанный результат виден целиком (§5.10). */
export interface ServiceMailResult {
  outcome: ModuleMailOutcome;
  targets: ServiceMailTargets;
  /**
   * Кому письма поставлены — снимком. Адреса показывает ручка повтора («отправить ещё раз») и
   * пишет аудит: «кому ушло» иначе восстанавливалось бы только запросом в журнал писем. Ключи и
   * аудитории нужны разбору: по ключу письмо находится в очереди, аудитория объясняет, каким телом
   * оно ушло.
   */
  recipients: ServiceMailRecipient[];
}

// ── Потолок частоты и сводка окна (§5.11) ──

/** Вид письма-сводки: не бизнес-событие, поэтому в реестре событий и в админке его нет. */
const ACTIVITY_SUMMARY_KIND = 'service_request_activity_summary' as const;

/**
 * Сколько обычных писем модуля уже ушло на этот адрес по этой заявке в текущем UTC-часе.
 *
 * Считается ПОД `pg_advisory_xact_lock` по тройке «заявка + адрес + час»: два одновременных
 * события иначе прочитали бы один и тот же счёт и оба решили бы, что место ещё есть. Замок
 * транзакционный — он снимается вместе с коммитом, и держать его дольше самой вставки не нужно.
 *
 * Сводки в счёт не входят: иначе одно окно душило бы следующее.
 */
async function windowCount(
  tx: Tx,
  requestId: string,
  email: string,
  hour: string,
): Promise<number> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${requestId}:${email}:${hour}`}))`);
  const rows = await tx.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM mail_messages
     WHERE entity_type = 'serviceRequest' AND entity_id = ${requestId}
       AND to_email = ${email}
       AND NOT is_test
       AND kind <> ${ACTIVITY_SUMMARY_KIND}
       AND created_at >= date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
  return Number(rows.rows[0]?.count ?? 0);
}

/** Текущее окно: час в UTC. Ключ сводки строится по нему, и он же ограничивает счёт. */
/**
 * Текущее окно — час по часам БАЗЫ, а не процесса.
 *
 * Счёт писем окна берёт границу от `now()` транзакции; возьми ключ сводки время из `new Date()` — и
 * при расхождении часов приложения с Postgres (или на транзакции, пересёкшей границу часа) ключ
 * уехал бы в соседнее окно. Следствие видно не сразу и хуже потока: сводка, записанная ключом
 * следующего часа, подавит сводку САМОГО следующего часа, и адресат останется без единого письма.
 */
async function currentHour(tx: Tx): Promise<string> {
  const rows = await tx.execute<{ hour: string }>(
    sql`SELECT to_char(date_trunc('hour', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24') AS hour`,
  );
  return rows.rows[0]!.hour;
}

/**
 * Сводка вместо очередного письма: «по заявке идёт работа, писем по каждому шагу до конца часа не
 * будет». Ставится ОДНА на окно — ключ без события, поэтому одновременные события разных видов не
 * создадут двух сводок; `onConflictDoNothing` делает все последующие подавленными.
 *
 * Ссылка — только тем, у кого портал: внешнему адресату вместо неё сказано позвонить в службу.
 */
async function queueActivitySummary(
  tx: Tx,
  params: {
    requestId: string;
    recipient: ServiceMailRecipient;
    hour: string;
    data: ServiceLetterData;
  },
): Promise<'queued' | 'mail_failed'> {
  /**
   * Сводка окна могла быть поставлена раньше и умереть в dead-letter. Тогда `onConflictDoNothing`
   * ниже промолчит, и цель считалась бы достигнутой: портал ответил бы «письмо ушло», а адресат
   * не получил бы за час ничего. Поэтому состояние существующей сводки спрашивается прямо (§5.11).
   */
  const existing = await tx.execute<{ status: string }>(sql`
    SELECT status::text AS status FROM mail_messages
     WHERE kind = ${ACTIVITY_SUMMARY_KIND}
       AND dedupe_key = ${`${params.requestId}:${params.recipient.email}:${params.hour}`}`);
  const status = existing.rows[0]?.status;
  if (status === 'failed') return 'mail_failed';
  if (status) return 'queued';
  const number = formatServiceRequestNumber(params.data.num);
  const internal = params.recipient.audience === 'internal';
  const content: MailContent = {
    title: `${number} — по заявке идёт работа`,
    blocks: [
      {
        kind: 'paragraph',
        text:
          `По заявке ${number} сегодня много событий, и письма по каждому шагу до конца часа ` +
          'отправляться не будут.',
      },
      ...(internal
        ? [
            {
              kind: 'link' as const,
              href: `${config.publicOrigin}/office-equipment?tab=requests&open=${params.requestId}`,
              label: 'Открыть заявку в портале',
            },
          ]
        : [
            {
              kind: 'paragraph' as const,
              text: 'Чтобы узнать подробности, свяжитесь со службой оргтехники.',
            },
          ]),
    ],
  };
  const rendered = renderMail(content);
  await queuePreparedMail(
    {
      kind: ACTIVITY_SUMMARY_KIND,
      dedupeKey: `${params.requestId}:${params.recipient.email}:${params.hour}`,
      to: params.recipient.email,
      account: SERVICE_MAIL_ACCOUNT,
      replyTo: params.recipient.replyTo,
      subject: `${number} — по заявке идёт работа`,
      text: rendered.text,
      html: rendered.html,
      entityType: 'serviceRequest',
      entityId: params.requestId,
    },
    { tx },
  );
  return 'queued';
}

/**
 * Ставит письма события внутри уже открытой транзакции заявки (§5.2).
 *
 * Порядок шагов обязателен и объяснён в §5.10: рубильник спрашивается ПЕРВЫМ и переопределяет уже
 * вычисленный исход конфигурации — если писать не велено, состояние сервера к делу не относится;
 * затем «а требовалось ли письмо вообще»; и только потом почта, канал и адресаты.
 *
 * Сторона заявки снимается ДО бизнес-изменения самой ручкой и приезжает параметром: отмена
 * сбрасывает исполнителя тем же переходом, и строка, перечитанная после него, о подрядчике уже не
 * помнит — письмо «выезд не требуется» ушло бы одной службе.
 */
export async function queueServiceMailForIntent(
  tx: Tx,
  params: {
    prepared: ServiceMailPreparation;
    side: ServiceRequestSide;
    requestId: string;
    /**
     * Якорь ключа дедупликации: строка истории статуса у переходов, свой у прочих событий.
     *
     * **Двоеточий в якоре быть не должно.** Ключ собран как `событие:якорь:адресат`, и разбор его
     * полей — не теория: по третьему полю письма отбирают тесты и разбор очереди. Якорь с
     * двоеточиями («…:rev1:submit») сдвигает адресата на пятое место, и письмо перестаёт находиться
     * там, где его ищут. Поэтому составной якорь склеивается дефисами.
     */
    anchor: string;
    /** Отличает осознанный повтор кнопкой от дубля (Р70). */
    idempotencyKey?: string;
    /** Контекст факта: прежний статус, причина перехода, действие с объёмом работ. */
    extra?: ServiceLetterExtra;
    /**
     * Документы пачки — вместе с целями, посчитанными по стороне приложившего. Приезжают сюда, а
     * не в намерение, потому что сторона известна только под блокировкой заявки: до транзакции
     * назначение ещё могли сменить.
     */
    document?: NonNullable<ServiceMailIntent['document']>;
    /** Адресаты реплики — по той же причине, что и документы: их считает транзакция отправки. */
    comment?: NonNullable<ServiceMailIntent['comment']>;
  },
): Promise<ServiceMailResult> {
  const { ctx } = params.prepared;
  // Документы дополняют намерение уже внутри транзакции — см. `params.document`.
  const intent: ServiceMailIntent = {
    ...params.prepared.intent,
    ...(params.document ? { document: params.document } : {}),
    ...(params.comment ? { comment: params.comment } : {}),
  };
  const targets: ServiceMailTargets = {};

  /**
   * Единственный выход из функции, и он же — единственное место записи следа. След обязан
   * оставаться на КАЖДОМ исходе, а не только на успешном: «письма не было» разбирают через месяц,
   * и `event_off` (администратор выключил) от `no_recipients` (писать некуда) отличает как раз эта
   * запись. У `queued` строки очереди есть и без неё, у остальных исходов — нет ничего.
   */
  const finish = async (
    outcome: ModuleMailOutcome,
    recipients: ServiceMailRecipient[] = [],
  ): Promise<ServiceMailResult> => {
    await writeAuditTx(tx, {
      actorUserId: intent.actor.id,
      action: 'serviceRequest.mailPlanned',
      entityType: 'serviceRequest',
      entityId: params.requestId,
      // Адреса — в журнал, а не в лог: у аудита есть право доступа, у логов его нет.
      metadata: {
        event: intent.event,
        outcome,
        targets,
        recipients: recipients.map((r) => r.email),
        sources: recipients.map((r) => r.source),
      },
    });
    logger.info(
      { requestId: params.requestId, event: intent.event, outcome, recipients: recipients.length },
      'письмо модуля: итог планирования',
    );
    return { outcome, targets, recipients };
  };

  if (!(await isServiceMailEventEnabled(tx, intent.event))) return finish('event_off');

  const required = requiredTargetsOf(intent, params.side);
  if (required.length === 0) return finish('not_needed');

  if (params.prepared.configOutcome) return finish(params.prepared.configOutcome);

  const candidates = await candidatesOf(tx, intent, params.side, ctx);
  const recipients = collectServiceMailRecipients(candidates, ctx.actor);
  /** Хоть одна сводка окна мертва: исход события обязан это назвать, а не отчитаться «ушло». */
  let deadSummary = false;

  /**
   * Данные письма — своей же строкой в той же транзакции. Отказать по данным это чтение не может:
   * заявки нет только если нет и транзакции. Ошибка **сборки тела** ловится вызывающим и даёт
   * мягкий исход `mail_failed` — заявка есть, письма нет.
   */
  if (recipients.length > 0) {
    const data = await loadServiceLetterData(tx, params.requestId);
    /**
     * Ошибка **сборки тела** — обычное исключение приложения: оно ловится до следующей SQL-команды
     * и даёт мягкий исход `mail_failed` (заявка есть, письма нет). Отказ же самой базы — чтения
     * адресатов или вставки строки очереди — сюда не попадает и летит наружу, откатывая всё:
     * прятать потерю атомарного outbox под мягким исходом нельзя (§5.9).
     */
    /**
     * Тела собираются ТОЛЬКО тех аудиторий, которые есть среди адресатов, а не все четыре разом.
     * Разница не в экономии: письмо о назначении без назначенных — законный случай (компанию сняли,
     * поимённых нет, уходит один отзыв), а тело `internal` на нём обязано падать — исполнителей
     * действительно нет. Рендери мы всё подряд, этот отзыв отвечал бы `mail_failed` и не уходил
     * бы вовсе.
     */
    let letters: Partial<ServiceLetters>;
    try {
      letters = renderServiceLettersFor(
        intent.event,
        data,
        new Set(recipients.map((r) => r.audience)),
        params.extra,
      );
    } catch (e) {
      logServiceMailFailure(params.requestId, e);
      return finish('mail_failed');
    }
    const limit = config.serviceRequests.mailMaxPerRequestHour;
    const hour = await currentHour(tx);
    for (const recipient of recipients) {
      /**
       * Потолок считается на КАЖДЫЙ адрес отдельно: активная заявка шумит не всем сразу — служба
       * ведёт десяток заявок, а подрядчик читает одну. Ноль снимает потолок совсем.
       */
      if (limit > 0 && (await windowCount(tx, params.requestId, recipient.email, hour)) >= limit) {
        const summary = await queueActivitySummary(tx, {
          requestId: params.requestId,
          recipient,
          hour,
          data,
        });
        // Сводка окна умерла — значит адресат за этот час не получит ничего, и «ушло» было бы
        // ложью ровно про того, ради кого письмо и существует.
        if (summary === 'mail_failed') deadSummary = true;
        continue;
      }
      await queuePreparedMail(
        {
          kind: intent.event as MailKind,
          dedupeKey: `${intent.event}:${params.anchor}:${recipient.key}${
            params.idempotencyKey ? `:${params.idempotencyKey}` : ''
          }`,
          to: recipient.email,
          account: SERVICE_MAIL_ACCOUNT,
          replyTo: recipient.replyTo,
          subject: letters[recipient.audience]!.subject,
          text: letters[recipient.audience]!.text,
          html: letters[recipient.audience]!.html,
          entityType: 'serviceRequest',
          entityId: params.requestId,
        },
        { tx },
      );
    }
  }

  if (deadSummary) return finish('mail_failed', recipients);
  return finish(outcomeOf(required, recipients, targets), recipients);
}

/**
 * Что это письмо обязано доставить. Пустой список означает «письма не требовалось» — исход
 * `not_needed`, по которому портал молчит: правка состава, никого не назначившая, не повод звать
 * заводить ящик (ADR 0153, §4а).
 */
function requiredTargetsOf(intent: ServiceMailIntent, side: ServiceRequestSide): RequiredTarget[] {
  if (intent.event === 'service_request_comment') {
    const plan = intent.comment;
    if (!plan) return [];
    const targets: RequiredTarget[] = plan.targets
      .filter((t) => t !== 'service' || hasServiceSide(side))
      .map((t) => (t === 'office' ? 'office' : 'service'));
    // Поимённый адресат — тоже обязательство: реплика написана конкретному человеку, и «письма
    // нет» здесь означает, что он о ней не узнает.
    if (plan.userIds.length > 0 && !targets.includes('service')) targets.push('service');
    return targets;
  }
  if (intent.event === 'service_request_document') {
    // Цели посчитаны маршрутом по стороне приложившего: здесь их только фильтрует наличие стороны.
    return (intent.document?.targets ?? []).filter((t) => t !== 'service' || hasServiceSide(side));
  }
  if (intent.event === 'service_request_estimate') {
    /**
     * Направление письма у объёма работ зависит от действия, а не от события: предъявление адресуют
     * тому, кто отвечает (служба), а решение и возврат в правку — тому, кто работал (сервис).
     * Одна цель на оба случая означала бы, что исполнитель читает собственное предъявление, а
     * служба — собственный отказ.
     */
    if (intent.estimate?.action === 'submit') return ['office'];
    return hasServiceSide(side) ? ['service'] : [];
  }
  if (intent.event === 'service_request_assigned') {
    const a = intent.assignment;
    if (!a) return [];
    const list: RequiredTarget[] = [];
    if (a.userIds.length > 0 || a.serviceCounterpartyId !== null) list.push('assignment');
    if (a.previousServiceCounterpartyId) list.push('withdrawal');
    return list;
  }
  const declared = TARGETS_BY_EVENT[intent.event] ?? [];
  // Сторона подрядчика — цель только там, где заявка за ним: у нераспределённой её нет вовсе, и
  // требовать доставки некому.
  return declared.filter((t) => t !== 'service' || hasServiceSide(side));
}

/** Кандидаты в адресаты по событию: сторонами, а не перечнем ящиков (§5.2). */
async function candidatesOf(
  tx: Tx,
  intent: ServiceMailIntent,
  side: ServiceRequestSide,
  ctx: ServiceMailAudienceCtx,
): Promise<ServiceMailRecipient[]> {
  const list: ServiceMailRecipient[] = [];

  if (intent.event === 'service_request_assigned') {
    const a = intent.assignment;
    /**
     * Ящика канала здесь нет намеренно: назначение сделала служба, и второе письмо об этом ей ни о
     * чём не сообщает. Впиши его сюда — и задание исполнителю подменилось бы уведомлением службе.
     */
    if (a) {
      list.push(...(await namedRecipients(tx, a.userIds, ctx)));
      if (a.serviceCounterpartyId) {
        list.push(
          ...(await counterpartySideRecipients(tx, a.serviceCounterpartyId, 'assigned', ctx)),
        );
      }
      if (a.previousServiceCounterpartyId) {
        list.push(
          ...(await counterpartySideRecipients(
            tx,
            a.previousServiceCounterpartyId,
            'withdrawn',
            ctx,
          )),
        );
      }
    }
  } else if (intent.event === 'service_request_comment') {
    for (const target of intent.comment?.targets ?? []) {
      if (target === 'office') list.push(...(await sideRecipients(tx, side, 'office', ctx)));
      if (target === 'service' && hasServiceSide(side)) {
        list.push(...(await sideRecipients(tx, side, 'service', ctx)));
      }
    }
    for (const userId of intent.comment?.userIds ?? []) {
      list.push(...(await sideRecipients(tx, side, { userId }, ctx)));
    }
  } else if (
    intent.event === 'service_request_estimate' ||
    intent.event === 'service_request_document'
  ) {
    for (const target of requiredTargetsOf(intent, side)) {
      if (target === 'office') list.push(...(await sideRecipients(tx, side, 'office', ctx)));
      if (target === 'service') list.push(...(await sideRecipients(tx, side, 'service', ctx)));
    }
  } else {
    for (const target of TARGETS_BY_EVENT[intent.event] ?? []) {
      if (target === 'office') list.push(...(await sideRecipients(tx, side, 'office', ctx)));
      if (target === 'service' && hasServiceSide(side)) {
        list.push(...(await sideRecipients(tx, side, 'service', ctx)));
      }
    }
  }

  // Копии — последними: первый источник побеждает, и доверенное тело не подменяется наблюдательским.
  list.push(...(await copyRecipients(tx, intent.event, ctx)));
  return list;
}

/**
 * Общий исход по обязательным целям (§5.10). Копия на него не влияет: она наблюдатель, и её письмо
 * не отменяет того, что задание никуда не ушло.
 *
 * `no_recipients` побеждает частичный успех намеренно: письмо в ящик службы правда про службу и
 * ложь про того, кто собрался выезжать (ADR 0153, §4а). Кто именно остался без письма, видно в
 * `targets`.
 */
function outcomeOf(
  required: RequiredTarget[],
  recipients: ServiceMailRecipient[],
  targets: ServiceMailTargets,
): ModuleMailOutcome {
  const reached: Record<RequiredTarget, boolean> = {
    office: recipients.some((r) => r.source === 'channel'),
    service: recipients.some((r) => r.source === 'contractor' || r.source === 'internal_user'),
    assignment: recipients.some((r) => r.source === 'contractor' || r.source === 'internal_user'),
    withdrawal: recipients.some((r) => r.source === 'contractor_withdrawn'),
  };
  let outcome: ModuleMailOutcome = 'queued';
  for (const target of required) {
    const ok = reached[target];
    /**
     * У каждой цели своя ячейка: назначение и отзыв — два разных обязательства одного письма, и
     * записанные в одно поле они затирали бы друг друга. Смешанный результат («задание ушло, отзыв
     * некому») читается только по раздельным ячейкам.
     */
    const outcomeOfTarget: ModuleMailOutcome = ok ? 'queued' : 'no_recipients';
    if (target === 'office') targets.office = outcomeOfTarget;
    else if (target === 'withdrawal') targets.withdrawal = outcomeOfTarget;
    else targets.service = outcomeOfTarget;
    if (!ok) outcome = 'no_recipients';
  }
  // Поимённый адресат реплики виден отдельно: «написали инженеру, а письма ему нет» — не то же
  // самое, что «стороне сервиса писать некуда».
  const named = recipients.filter((r) => r.source === 'internal_user');
  if (named.length > 0) targets.user = 'queued';
  if (recipients.some((r) => r.source === 'copy')) targets.copies = 'queued';
  return outcome;
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
  /**
   * Аппарат заявки: `null` — заявки без аппарата (Р8, ADR 0146, решение 7). Признак стоит отдельным
   * полем, а не выводится из пустых реквизитов: пустое наименование бывает и у испорченной карточки,
   * а письмо обязано различать «аппарата нет» и «аппарат есть, но мы про него ничего не написали».
   */
  officeEquipmentId: string | null;
  equipmentName: string;
  equipmentSerialNumber: string;
  equipmentInventoryNumber: string;
  equipmentLocation: string;
  /**
   * Площадка предмета. Пустеет вместе с аппаратом — снимок места у заявки «от отдела» брать
   * неоткуда, — и приезжает из ЛЕВОГО соединения: внутреннее уронило бы сборку письма целиком
   * («Заявка … не найдена при сборке письма»), то есть заведение такой заявки отвечало бы
   * `mail_failed` на ровном месте.
   */
  objectCode: string | null;
  objectName: string | null;
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
  /** Предъявленная сумма объёма работ; `null` — не предъявляли. Копии не показывается (§5.6). */
  estimatedTotalAmount: string | null;
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
    .leftJoin(constructionObjects, eq(serviceRequests.equipmentObjectId, constructionObjects.id))
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
    // Колонка ещё `NOT NULL` (снимает выпуск 2б) — расширение до `string | null` записано в типе
    // поля, а не здесь: значение придёт пустым позже, чем ветка «аппарата нет» понадобится.
    officeEquipmentId: row.r.officeEquipmentId,
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
    estimatedTotalAmount: row.r.estimatedTotalAmount,
  };
}

/** Номера единицы одной строкой: их печатает производитель и клеит бухгалтерия. */
function numbersOf(data: ServiceLetterData): string {
  // У заявки без аппарата номеров нет вовсе, и спрашивать снимок незачем: он пуст.
  if (data.officeEquipmentId === null) return '';
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
 * Контекст факта: то, чего в строке заявки уже нет к моменту письма.
 *
 * Прежний статус после перехода не прочитать ниоткуда, кроме истории, а письмо о переходе без «было»
 * отвечает на половину вопроса: «Отложена» без «из работы» читается как заведение отложенной
 * заявки. С объёмом работ то же: строка помнит текущую ревизию, но не то, что с ней сейчас сделали.
 */
export interface ServiceLetterExtra {
  fromStatus?: ServiceRequestStatus | null;
  comment?: string;
  estimate?: { revision: number; action: 'submit' | 'approved' | 'reopened' };
  document?: { kind: ServiceFileKind; names: string[]; total: number };
  /**
   * Реплика целиком: у подрядчика без учётки письмо — единственный носитель, и «вам написали» без
   * текста заставило бы его звонить, чтобы узнать что.
   */
  message?: { authorName: string; addressees: string; body: string };
}

/** Что произошло с объёмом работ — словами, которыми это называют в портале. */
const ESTIMATE_ACTION_LABELS: Record<'submit' | 'approved' | 'reopened', string> = {
  submit: 'предъявлен',
  approved: 'согласован',
  reopened: 'возвращён в правку',
};

/**
 * Сумма письмом: рубли с копейками, как в карточке. `numeric` приезжает строкой, и печатать его
 * как есть («14300.00») в письме нельзя — это цена, её читает человек.
 */
function formatEstimateAmount(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value)
    ? `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`
    : amount;
}

/**
 * Что аудитории **разрешено видеть в теле** (§5.6, ADR 0159, решение 7).
 *
 * Карта, а не россыпь `if` по телу письма: состав полей — это правило доступа, и оно обязано
 * читаться одним куском. Закрыта `satisfies Record<ServiceMailAudience, …>` — новая аудитория не
 * проедет молча, ей придётся ответить на каждый вопрос.
 *
 * **Копия урезана намеренно.** `module_mail_recipients` хранит произвольный email, а не субъекта с
 * проверяемым правом: раскрывать ему описание поломки, телефон ответственного, состав документов и
 * (со следующими событиями) суммы объёма работ не на основании чего. Копии остаётся то, ради чего
 * её заводят, — «по этой заявке произошло вот это»: номер, статус, событие, срочность и обозначение
 * техники. Понадобится полное тело — настройка должна ссылаться на живую учётку с
 * `serviceRequests.finance`, а не на строку с адресом.
 *
 * Ссылка в портал у копии снята по той же причине: произвольный адрес не доказывает доступа, и
 * приглашение «откройте заявку» ведёт такого читателя на форму входа.
 */
interface ServiceLetterFields {
  /** Кого назначили — состав исполнителей. */
  assignees: boolean;
  /** Где стоит аппарат: площадка и место установки. */
  place: boolean;
  department: boolean;
  /** Ответственный и его телефон. */
  contact: boolean;
  author: boolean;
  /** Число вложений в заявке. */
  attachments: boolean;
  /** Текст «Описание» — то, что написал заявитель. */
  description: boolean;
  /** Ссылка «Открыть заявку в портале». */
  portalLink: boolean;
  /**
   * Деньги: предъявленная сумма объёма работ. У копии запрещены отдельным полем, а не заодно с
   * описанием: адрес из настройки — не субъект с правом `serviceRequests.finance`, и раскрывать
   * ему цену ремонта не на основании чего.
   */
  finance: boolean;
}

export const SERVICE_MAIL_AUDIENCE_FIELDS = {
  internal: {
    finance: true,
    assignees: true,
    place: true,
    department: true,
    contact: true,
    author: true,
    attachments: true,
    description: true,
    portalLink: true,
  },
  contractor: {
    finance: true,
    assignees: true,
    place: true,
    department: true,
    contact: true,
    author: true,
    attachments: true,
    description: true,
    // Учётки у подрядчика может не быть вовсе, и ссылка привела бы его на форму входа.
    portalLink: false,
  },
  contractor_withdrawn: {
    finance: true,
    // Новый состав отзыв не раскрывает: у прежней компании заявку забрали, и кто её ведёт теперь —
    // уже чужая работа.
    assignees: false,
    place: true,
    department: true,
    contact: true,
    author: true,
    attachments: true,
    description: true,
    portalLink: false,
  },
  copy: {
    finance: false,
    assignees: false,
    place: false,
    department: false,
    contact: false,
    author: false,
    attachments: false,
    description: false,
    portalLink: false,
  },
} satisfies Record<ServiceMailAudience, ServiceLetterFields>;

/**
 * Тело письма — самодостаточное: у службы учётки в портале может не быть вовсе, и ссылка ей ничего
 * не откроет. Вложения не прикладываются (контур их не носит), но их число названо — иначе о
 * фотографиях поломки никто не узнает.
 *
 * Письмо о назначении отличается списком назначенных и припиской: своему исполнителю оно предлагает
 * открыть портал, внешнему — подтвердить получение ответом. Отзыв прежней компании не раскрывает
 * новый состав и прямо говорит, что выезд не требуется.
 */
function buildServiceLetter(
  event: ModuleMailEvent,
  data: ServiceLetterData,
  audience: ServiceMailAudience,
  extra?: ServiceLetterExtra,
): { subject: string; content: MailContent } {
  const number = formatServiceRequestNumber(data.num);
  const urgent = data.isUrgent ? 'СРОЧНО · ' : '';
  const withdrawn = audience === 'contractor_withdrawn';
  const eventLabel = withdrawn
    ? 'Назначение сервисной компании отозвано'
    : moduleMailEventLabels[event];
  const subject = `${urgent}${number} · ${eventLabel}`;
  const assignment = event === 'service_request_assigned';

  /**
   * Письмо о назначении без назначенных — не пустая строка, а признак того, что исполнителей
   * записали **после** перехода: данные письма читаются той же транзакцией, что их пишет. Молчать
   * тут нельзя — отказ ловит вызывающий и отвечает `mail_failed`, то есть «письма нет» будет
   * сказано вслух, а не показано пробелом в теле.
   */
  if (assignment && !withdrawn && !assigneesOf(data)) {
    throw new Error(
      `Заявка ${number}: письмо о назначении собирается, а исполнителей у заявки нет — ` +
        'строки исполнителей пишутся до перехода статуса',
    );
  }

  const fields = SERVICE_MAIL_AUDIENCE_FIELDS[audience];

  const lines = [
    extra?.fromStatus && extra.fromStatus !== data.status
      ? `Было: «${serviceRequestStatusLabels[extra.fromStatus]}» → стало «${serviceRequestStatusLabels[data.status]}»`
      : `Статус: ${serviceRequestStatusLabels[data.status]}`,
    /**
     * Причина перехода — то, ради чего письмо и читают: у возврата на доработку и заморозки она
     * обязательна по схеме, и без неё адресат узнает факт, но не узнает, что делать.
     *
     * Свободный текст человека, поэтому спрашивается `fields.description`: у копии за адресом нет
     * субъекта с правом, и «этих тянуть не будем, счёт завышен» ей знать неоткуда.
     */
    ...(fields.description && extra?.comment ? [`Причина: ${extra.comment}`] : []),
    // Автор и адресаты реплики — те же данные переписки, что и её текст: копии их не показываем.
    ...(fields.description && extra?.message
      ? [`Написал: ${extra.message.authorName}`, `Кому: ${extra.message.addressees}`]
      : []),
    /**
     * Документы: вид и имена файлов — только тем, кому разрешены вложения. Копия видит сам факт
     * («добавлены документы: N»), но не то, ЧТО подшили: имя «schet-4412.pdf» рассказывает о
     * заявке ровно то, что от копии закрыто (§5.6).
     */
    ...(extra?.document
      ? [
          fields.attachments
            ? `Приложены документы (${serviceFileKindLabels[extra.document.kind]}): ${extra.document.names.join(', ')} — файлов в заявке: ${extra.document.total}`
            : `Добавлены документы: ${extra.document.names.length}`,
        ]
      : []),
    ...(extra?.estimate
      ? [
          `Объём работ: ${ESTIMATE_ACTION_LABELS[extra.estimate.action]}, ревизия ${extra.estimate.revision}${
            fields.finance && data.estimatedTotalAmount
              ? `, ${formatEstimateAmount(data.estimatedTotalAmount)}`
              : ''
          }`,
        ]
      : []),
    ...(assignment && !withdrawn && fields.assignees ? [`Назначены: ${assigneesOf(data)}`] : []),
    /**
     * Предмет заявки. У заявки без аппарата (Р8) строка не исчезает, а говорит это словами: письмо
     * читают в сервисной компании, у которой портала может не быть вовсе, и пропавшая строка была
     * бы прочитана как потерянные данные, а не как законное состояние.
     */
    `Техника: ${data.officeEquipmentId === null ? SERVICE_REQUEST_NO_EQUIPMENT : `${data.equipmentName}${numbersOf(data) ? ` · ${numbersOf(data)}` : ''}`}`,
    /**
     * А вот «Где стоит» без площадки уходит целиком, и это не то же самое: у заявки без аппарата
     * места нет ни в каком виде, и строка «Где стоит: —» отвечала бы на вопрос, которого никто не
     * задавал. Откуда заявка, читается строкой «Отдел» ниже.
     */
    ...(fields.place && (data.objectCode !== null || data.objectName !== null)
      ? [
          `Где стоит: ${data.objectCode ?? ''} — ${data.objectName ?? ''}${
            data.equipmentLocation ? `, ${data.equipmentLocation}` : ''
          }`,
        ]
      : []),
    ...(fields.department && data.departmentName ? [`Отдел: ${data.departmentName}`] : []),
    ...(fields.contact && (data.responsibleName || data.responsiblePhone)
      ? [`Контакт: ${[data.responsibleName, data.responsiblePhone].filter(Boolean).join(', ')}`]
      : []),
    ...(fields.author && data.authorName ? [`Заявку завёл: ${data.authorName}`] : []),
    ...(fields.attachments && data.attachments > 0
      ? [
          // «См. в портале» — только тем, у кого портал есть. Копия читает его наравне со службой.
          audience === 'internal'
            ? `Вложений в заявке: ${data.attachments} (см. в портале)`
            : `Вложений в заявке: ${data.attachments} (запросите их ответом на письмо)`,
        ]
      : []),
  ];

  const content: MailContent = {
    title: `${number} — ${eventLabel}`,
    blocks: [
      // Срочность первой строкой тела, а не только пометкой в теме: причину читают до того, как
      // решают, ехать ли сегодня.
      ...(data.isUrgent && data.urgencyReason
        ? [{ kind: 'paragraph' as const, text: `Срочно: ${data.urgencyReason}` }]
        : []),
      { kind: 'lines' as const, lines },
      // Заголовок блока совпадает с подписью поля в портале (Р2, просьба 7): письмо и карточка
      // называют одно и то же одинаково, а на заявке про расходники «Что случилось» было мимо.
      ...(fields.description && extra?.message
        ? [
            { kind: 'heading' as const, text: 'Сообщение' },
            { kind: 'paragraph' as const, text: extra.message.body },
          ]
        : []),
      ...(fields.description
        ? [
            { kind: 'heading' as const, text: 'Описание' },
            { kind: 'paragraph' as const, text: data.description },
          ]
        : []),
      ...(fields.portalLink
        ? [
            {
              kind: 'link' as const,
              // `open`, а не `id`: карточку открывает именно этот параметр
              // (`shared/lib/useOpenedRecord.ts`), и письмо с `id` приводило человека на список,
              // где заявку искали глазами (§5.7).
              href: `${config.publicOrigin}/office-equipment?tab=requests&open=${data.requestId}`,
              label: 'Открыть заявку в портале',
            },
          ]
        : []),
      {
        kind: 'note' as const,
        /**
         * Приписка обязана говорить правду про обратный адрес и доступ в портал — иначе внешний
         * адресат получает неисполнимое указание. Отсюда пять веток (ADR 0153):
         *
         * 1. **Копия про адрес ответа не утверждает ничего.** У строки настройки свой режим —
         *    `author`, `actor`, `fixed` или `portal`, — и любая фраза «ответ уйдёт туда-то» для неё
         *    неверна у трёх режимов из четырёх. Раньше копия получала тело службы и обещала ответ
         *    заявителю, а по письму о назначении — службу; куда уйдёт ответ на самом деле, знала
         *    только настройка.
         * 2. Своему исполнителю назначение предлагает открыть портал.
         * 3. Внешнему подрядчику назначение предлагает подтвердить получение ответом на письмо.
         * 4. Прежнему подрядчику прямо сообщается, что задание отозвано и выезд не требуется.
         * 5. Подрядчику — ответ идёт в службу, и для отмены к этому добавлено главное: не выезжать.
         *    Текст перечисляет события поимённо, а не пишет «отменена» на всякий подрядческий
         *    случай: заведи мы этой аудитории третье событие — приписка соврала бы молча.
         *    Своим у событий службы ответ по-прежнему идёт заявителю: у службы вопросы к нему.
         */
        text:
          audience === 'copy'
            ? 'Это копия письма по заявке — без подробностей: их читают в портале. Ответ на это ' +
              'письмо уйдёт в службу оргтехники.'
            : withdrawn
              ? 'Заявка больше не назначена вашей компании — выезд не требуется. Ответ на это ' +
                'письмо уйдёт в службу оргтехники.'
              : assignment
                ? audience === 'contractor'
                  ? 'Заявка назначена вашей компании. Подтвердите получение ответом на это ' +
                    'письмо — ответ уйдёт в службу оргтехники.'
                  : 'Заявка назначена вам — примите её в работу в портале. Ответ на это письмо ' +
                    'уйдёт в службу оргтехники.'
                : audience === 'contractor'
                  ? `${event === 'service_request_cancelled' ? 'Заявка отменена — выезд не требуется. ' : ''}Ответ на это письмо уйдёт в службу оргтехники.`
                  : /**
                     * Своим приписка обязана называть ТОТ адрес, который стоит в заголовке
                     * (§5.8): у двух сложившихся писем службе это автор заявки, у писем цикла —
                     * ящик службы. Одна фраза на все события обещала бы заявителя там, где ответ
                     * уйдёт в службу, — то есть врала бы ровно тому, кто ей поверит.
                     */
                    `Ссылка работает у тех, у кого есть доступ в портал. Ответ на это письмо уйдёт ${
                      AUTHOR_REPLY_EVENTS.has(event) ? 'заявителю' : 'в службу оргтехники'
                    }.`,
      },
    ],
  };

  return { subject, content };
}

/** Готовое письмо: тема и отрисованное тело — то, что уходит в очередь. */
export function renderServiceLetter(
  event: ModuleMailEvent,
  data: ServiceLetterData,
  audience: ServiceMailAudience = 'internal',
  extra?: ServiceLetterExtra,
): { subject: string; text: string; html: string } {
  const letter = buildServiceLetter(event, data, audience, extra);
  const rendered = renderMail(letter.content);
  return { subject: letter.subject, text: rendered.text, html: rendered.html };
}

/**
 * То же письмо, но **до** отрисовки — темой и `MailContent`.
 *
 * Нужна отладочной отправке (`POST /admin/mail/test`): она помечает письмо словом «ТЕСТ», а
 * помечать умеет только `MailContent`. Собирать образец вторым кодом нельзя — проверка вёрстки
 * проверяла бы не то письмо, что уходит людям; поэтому `renderServiceLetter` и эта функция ходят
 * по одному пути, и разойтись им негде.
 */
export function serviceLetterContent(
  event: ModuleMailEvent,
  data: ServiceLetterData,
  audience: ServiceMailAudience = 'internal',
  extra?: ServiceLetterExtra,
): { subject: string; content: MailContent } {
  return buildServiceLetter(event, data, audience, extra);
}

/** Готовое тело письма на каждую аудиторию: адресат выбирает своё по `Recipient.audience`. */
export type ServiceLetters = Record<
  ServiceMailAudience,
  { subject: string; text: string; html: string }
>;

/**
 * Тела письма для перечисленных аудиторий. Аудитория, которой в письме нет, не собирается: сборка
 * тела бывает законно невозможной (см. выше про отзыв без назначенных), и падать из-за письма,
 * которое никому не адресовано, нельзя.
 */
export function renderServiceLettersFor(
  event: ModuleMailEvent,
  data: ServiceLetterData,
  audiences: ReadonlySet<ServiceMailAudience>,
  extra?: ServiceLetterExtra,
): Partial<ServiceLetters> {
  const letters: Partial<ServiceLetters> = {};
  for (const audience of audiences) {
    letters[audience] = renderServiceLetter(event, data, audience, extra);
  }
  return letters;
}

/**
 * Все тела письма разом (ADR 0153). Функция чистая и дешёвая, поэтому варианты подрядчика
 * собираются всегда, а не «если есть такой адресат»: условие завело бы ещё одно место, где надо
 * помнить про аудиторию.
 *
 * Зовут её ОБА места, где письмо ставится (переход и повтор кнопкой), и оба ловят её отказ: сборка
 * тела письма о назначении падает, если исполнителей у заявки нет, и падение это — мягкий исход
 * `mail_failed`, а не откат заявки.
 */
export function renderServiceLetters(
  event: ModuleMailEvent,
  data: ServiceLetterData,
): ServiceLetters {
  return {
    internal: renderServiceLetter(event, data, 'internal'),
    contractor: renderServiceLetter(event, data, 'contractor'),
    contractor_withdrawn: renderServiceLetter(event, data, 'contractor_withdrawn'),
    copy: renderServiceLetter(event, data, 'copy'),
  };
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
