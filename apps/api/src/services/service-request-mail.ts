import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_MAIL_ACCOUNT,
  formatServiceRequestNumber,
  moduleMailEventLabels,
  SERVICE_REQUEST_NO_EQUIPMENT,
  serviceRequestStatusLabels,
  type ModuleMailEvent,
  type ModuleMailOutcome,
  type ServiceMailTargets,
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
export { readServiceSide, type ServiceRequestSide } from './service-request-mail-audience';

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
  },
): Promise<ServiceMailResult> {
  const { intent, ctx } = params.prepared;
  const targets: ServiceMailTargets = {};

  if (!(await isServiceMailEventEnabled(tx, intent.event))) {
    return { outcome: 'event_off', targets, recipients: [] };
  }

  const required = requiredTargetsOf(intent, params.side);
  if (required.length === 0) return { outcome: 'not_needed', targets, recipients: [] };

  if (params.prepared.configOutcome) {
    return { outcome: params.prepared.configOutcome, targets, recipients: [] };
  }

  const candidates = await candidatesOf(tx, intent, params.side, ctx);
  const recipients = collectServiceMailRecipients(candidates, ctx.actor);

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
      return { outcome: 'mail_failed', targets, recipients: [] };
    }
    for (const recipient of recipients) {
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

  return { outcome: outcomeOf(required, recipients, targets), targets, recipients };
}

/**
 * Что это письмо обязано доставить. Пустой список означает «письма не требовалось» — исход
 * `not_needed`, по которому портал молчит: правка состава, никого не назначившая, не повод звать
 * заводить ящик (ADR 0153, §4а).
 */
function requiredTargetsOf(intent: ServiceMailIntent, side: ServiceRequestSide): RequiredTarget[] {
  if (intent.event === 'service_request_estimate') {
    /**
     * Направление письма у объёма работ зависит от действия, а не от события: предъявление адресуют
     * тому, кто отвечает (служба), а решение и возврат в правку — тому, кто работал (сервис).
     * Одна цель на оба случая означала бы, что исполнитель читает собственное предъявление, а
     * служба — собственный отказ.
     */
    if (intent.estimate?.action === 'submit') return ['office'];
    return side.serviceCounterpartyId !== null || side.executorUserIds.length > 0
      ? ['service']
      : [];
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
  return declared.filter((t) => t !== 'service' || side.serviceCounterpartyId !== null);
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
  } else if (intent.event === 'service_request_estimate') {
    for (const target of requiredTargetsOf(intent, side)) {
      if (target === 'office') list.push(...(await sideRecipients(tx, side, 'office', ctx)));
      if (target === 'service') list.push(...(await sideRecipients(tx, side, 'service', ctx)));
    }
  } else {
    for (const target of TARGETS_BY_EVENT[intent.event] ?? []) {
      if (target === 'office') list.push(...(await sideRecipients(tx, side, 'office', ctx)));
      if (target === 'service' && side.serviceCounterpartyId !== null) {
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
    if (target === 'office') targets.office = ok ? 'queued' : 'no_recipients';
    else targets.service = ok ? 'queued' : 'no_recipients';
    if (!ok) outcome = 'no_recipients';
  }
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
export function renderServiceLetter(
  event: ModuleMailEvent,
  data: ServiceLetterData,
  audience: ServiceMailAudience = 'internal',
  extra?: ServiceLetterExtra,
): { subject: string; text: string; html: string } {
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
    // Причина перехода — то, ради чего письмо и читают: у возврата на доработку и заморозки она
    // обязательна по схеме, и без неё адресат узнает факт, но не узнает, что делать.
    ...(extra?.comment ? [`Причина: ${extra.comment}`] : []),
    // Объём работ: что именно с ним произошло и на какую сумму. Сумма — только тем, кому она
    // разрешена картой аудиторий: копия видит факт, но не цену.
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
                  : 'Ссылка работает у тех, у кого есть доступ в портал. Ответ на это письмо уйдёт заявителю.',
      },
    ],
  };

  const rendered = renderMail(content);
  return { subject, text: rendered.text, html: rendered.html };
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
