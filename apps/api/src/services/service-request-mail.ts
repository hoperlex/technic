import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  COUNTERPARTY_SCOPED_ROLES,
  DEFAULT_MAIL_ACCOUNT,
  formatServiceRequestNumber,
  moduleMailEventLabels,
  SERVICE_REQUEST_NO_EQUIPMENT,
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
export type ServiceMailAudience = 'internal' | 'contractor' | 'contractor_withdrawn' | 'copy';

/** Получатель письма: ящик канала, назначенный исполнитель, подрядчик или заведённая копия. */
interface Recipient {
  /**
   * Часть ключа дедупликации — **чем вызвано письмо**, а не куда оно ушло: `channel` у основного
   * адресата писем службе, id учётки — у назначенного исполнителя, `counterparty-<id>` — у общего
   * ящика подрядчика, id строки — у копии. Двоеточий в ключе быть не должно: им разделены поля
   * самого ключа дедупликации (`событие:строка истории:адресат`), и составной ключ адресата
   * сделал бы разбор ключа неоднозначным.
   */
  key: string;
  email: string;
  /** Куда уйдёт ответ; пусто — общий адрес портала. */
  replyTo: string;
  /** Каким телом письма адресата обслуживать (см. `ServiceMailAudience`). */
  audience: ServiceMailAudience;
}

export interface ServiceMailPlan {
  event: ModuleMailEvent;
  kind: MailKind;
  recipients: Recipient[];
}

export type ServiceMailPlanResult =
  | { plan: ServiceMailPlan; outcome: 'queued' | 'no_recipients' }
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
  add: (key: string, email: string, replyTo: string, audience?: ServiceMailAudience) => void;
  list: Recipient[];
} {
  const seen = new Set<string>();
  const list: Recipient[] = [];
  return {
    list,
    add(key, email, replyTo, audience = 'internal') {
      const normalized = email.trim().toLowerCase();
      // Отзыв назначения — не дубль нового назначения даже при одном общем ящике у двух
      // контрагентов: в таком случае на адрес должны прийти два разных по смыслу письма.
      const identity =
        audience === 'contractor_withdrawn' ? `${normalized}|contractor_withdrawn` : normalized;
      if (!normalized || seen.has(identity)) return;
      seen.add(identity);
      list.push({ key, email, replyTo, audience });
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
  ctx: {
    actor: { id: string; email: string };
    authorId: string | null;
    /**
     * Кому заявка отдана сейчас. Нужен ровно одному событию — отмене: подрядчик, который уже
     * собрался ехать, обязан узнать, что везти нечего (ADR 0153), и узнать он это может только
     * письмом — учёток в портале у него может не быть вовсе.
     *
     * У заведения заявки поле пусто по построению, и это не забывчивость: исполнителя у только
     * что заведённой заявки нет. У отката в «Новую» подрядчик бывает, но письма ему этот переход
     * не шлёт — «заявка снова ждёт разбора» адресовано службе, а не тому, кто её ведёт; узнает он
     * о снятии из письма о переназначении, если заявку отдадут другому.
     */
    serviceCounterpartyId?: string | null;
  },
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

  /**
   * Подрядчик — вторым, до копий и после службы (ADR 0153). Порядок здесь тот же, что и у всего
   * накопителя: первый источник побеждает, и адрес, заведённый ещё и копией, останется письмом
   * подрядчику со своим обратным адресом, а не наблюдательской копией.
   *
   * **Сторона подрядчика — это ЕГО УЧЁТКИ И ЕГО ЯЩИК, а не один ящик.** Письмо о назначении так и
   * считало с самого начала, а отмена — нет, и разница была тихой: компания с операторами в портале
   * и пустым полем адреса получала задание и не получала отмены. Ехали зря, а портал отвечал
   * `queued`, потому что письмо службе в очередь встало.
   *
   * Обратный адрес — ящик службы, а не автор заявки: с внешней организацией переписывается служба.
   * Ответ подрядчика заявителю был бы письмом от чужой компании человеку, который её не знает, и
   * ушёл бы мимо тех, кто ведёт заявку. По той же причине обе половины стороны подрядчика получают
   * ТЕЛО ПОДРЯДЧИКА: оператору с учёткой ссылка в портал полезна, но приписка про адрес ответа
   * важнее, а второе тело ради ссылки развело бы одно письмо на два.
   */
  const contractorSide = ctx.serviceCounterpartyId
    ? await contractorRecipients(event, ctx.serviceCounterpartyId)
    : [];
  for (const row of contractorSide) to.add(row.key, row.email, channelEmail, 'contractor');

  for (const row of copies) {
    to.add(
      row.id,
      row.toEmail,
      replyToOf(row.replyToMode, row.replyToEmail, {
        author: author?.email ?? '',
        actor: ctx.actor.email,
      }),
      'copy',
    );
  }

  /**
   * Исход считается по СТОРОНЕ ПОДРЯДЧИКА, а не по всему письму. Ящик службы в адресатах есть
   * всегда, и `queued` по нему был бы правдой про службу и ложью про того, кто собрался выезжать:
   * заявку отменили, сказать об этом оказалось некому, и узнать это назначивший обязан сразу.
   */
  const contractorMissed =
    event === 'service_request_cancelled' && !!ctx.serviceCounterpartyId
      ? contractorSide.length === 0
      : false;

  return {
    plan: { event, kind: event as MailKind, recipients: to.list },
    outcome: contractorMissed ? 'no_recipients' : 'queued',
  };
}

/**
 * Сторона подрядчика для письма, адресованного компании: её живые операторы и общий ящик карточки.
 *
 * Отмену подрядчик получает только тогда, когда заявка у него; для остальных событий список пуст —
 * «Новая» ждёт разбора службой, и подрядчику там нечего читать.
 */
async function contractorRecipients(
  event: ModuleMailEvent,
  counterpartyId: string,
): Promise<{ key: string; email: string }[]> {
  if (event !== 'service_request_cancelled') return [];
  const operators = await liveCounterpartyOperators(counterpartyId);
  const mailbox = await contractorMailbox(counterpartyId);
  return [
    ...operators.map((row) => ({ key: row.id, email: row.email })),
    ...(mailbox ? [{ key: `counterparty-${counterpartyId}`, email: mailbox }] : []),
  ];
}

/**
 * Кому уйдёт письмо о назначении (план `docs/office-equipment-requests-rework-plan.md`, §7.3, Н13;
 * решение опроса В16).
 *
 * **Это единственное письмо модуля, адресованное людям, а не службе.** Остальные два уходят на ящик
 * канала: за ним нет учётки, и список копий только добавляет наблюдателей. Здесь наоборот — письмо
 * это задание на работу, и получает его тот, кому работать: назначенные поимённо сотрудники,
 * операторы и общий ящик сервисной компании. При переназначении прежний подрядчик получает здесь
 * же отдельный отзыв задания. Ящик канала в адресатах не участвует: служба назначение и сделала, и
 * второе письмо об этом ей ни о чём не сообщает.
 *
 * Отсюда же три следствия, каждое из которых легко потерять:
 *
 * 1. **Заявителю письмо не уходит** (В16): движение по заявке он видит в портале, а задание — не
 *    его дело. Автор назван в теле и остаётся доступен режимам обратного адреса настроенных копий;
 *    само задание отвечает в ящик службы.
 * 2. **Копии из `module_mail_recipients` работают поверх, а не вместо.** Строка настройки на это
 *    событие — «хочу видеть все назначения»; подменить ею адресата нельзя.
 * 3. **Нет новых адресатов и ящика прежнего подрядчика — письма нет вовсе** (`no_recipients`).
 *    Отправить его одной службе было бы худшим из исходов: портал отчитался бы «письмо ушло», а
 *    исполнитель задания или отзыв работы не увидел.
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
    /** Прежняя компания при переназначении: ей уходит отзыв уже выданного задания. */
    previousServiceCounterpartyId?: string | null;
  },
  ctx: { actor: { id: string; email: string }; authorId: string | null },
): Promise<ServiceMailPlanResult> {
  const event: ModuleMailEvent = 'service_request_assigned';

  /**
   * Было ли этим действием что-то выдано или отозвано. Спрашивается ПЕРВЫМ, до почты и канала: если
   * писать не о чем, состояние сервера к делу не относится вовсе. Иначе правка состава, которая
   * никого не назначила, отвечала бы «отправка писем выключена» — тревога про настройку там, где
   * письма и не требовалось (это и ломало смысл `not_needed`).
   *
   * «Выдано» — это `userIds` или новая компания; «отозвано» — прежняя компания при переназначении.
   * Нашлись ли у них адреса, здесь не спрашивается: тот вопрос решается ниже и отвечает другим
   * исходом.
   */
  const hadNewAssignment =
    assignment.userIds.length > 0 || assignment.serviceCounterpartyId !== null;
  const hadWithdrawal = !!assignment.previousServiceCounterpartyId;
  if (!hadNewAssignment && !hadWithdrawal) return { plan: null, outcome: 'not_needed' };

  if (!config.mail.enabled) return { plan: null, outcome: 'mail_disabled' };

  /**
   * Канал нужен и здесь, хотя его ящик писем не получает: он отправитель, и без настроенного
   * `From` письмо некому подписать. Со времён ADR 0153 нужен ещё и его АДРЕС — он же обратный
   * адрес этого письма (см. ниже), — поэтому проверяется не только `configured`.
   */
  const channel = config.mail.accounts[SERVICE_MAIL_ACCOUNT];
  const channelEmail = channel.configured ? addressOf(channel.from) : '';
  if (!channelEmail) return { plan: null, outcome: 'channel_missing' };

  const [author] = ctx.authorId
    ? await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.authorId))
    : [];
  const authorEmail = author?.email ?? '';

  /**
   * Задание адресуется тому, кто может войти в портал и принять заявку: архивная и отключённая
   * учётки — это ящик, за которым никого нет, и молчаливо отправить туда письмо хуже, чем сказать
   * назначившему «предупредите их сами».
   */
  const named = assignment.userIds.length
    ? await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          and(
            inArray(users.id, assignment.userIds),
            eq(users.isActive, true),
            isNull(users.deletedAt),
          ),
        )
        .orderBy(users.email)
    : [];

  /**
   * У сервисной компании поимённых строк нет (§4.2): назначается она целиком, а читают почту её
   * операторы. Их может не быть ни одной, и это обычное дело: подрядчик без доступа в портал
   * существует. Отбор — общий на все письма модуля (`liveCounterpartyOperators`).
   */
  const operators = assignment.serviceCounterpartyId
    ? await liveCounterpartyOperators(assignment.serviceCounterpartyId)
    : [];

  const previousOperators = assignment.previousServiceCounterpartyId
    ? await liveCounterpartyOperators(assignment.previousServiceCounterpartyId)
    : [];

  /**
   * Общие ящики новой и прежней компаний (ADR 0153). Ящик новой стоит рядом с её операторами, а
   * не вместо них. Это
   * единственный адресат, до которого письмо доходит, когда учёток у подрядчика нет вовсе: до
   * решения такая заявка отвечала `no_recipients`, то есть портал честно говорил «задание не
   * ушло», и дальше его доносили голосом.
   *
   * Дублирования с оператором нет: накопитель отсеивает по адресу, а не по ключу, — если оператор
   * читает тот же ящик, письмо будет одно. Отзыв прежней компании остаётся отдельным письмом даже
   * при совпавшем адресе: «вам назначено» и «у вас отозвано» схлопывать нельзя.
   */
  const contractor = assignment.serviceCounterpartyId
    ? await contractorMailbox(assignment.serviceCounterpartyId)
    : '';
  const previousContractor = assignment.previousServiceCounterpartyId
    ? await contractorMailbox(assignment.previousServiceCounterpartyId)
    : '';

  /**
   * Обратный адрес всего письма — **ящик службы**, а не автор заявки (решение ADR 0153). Прежде
   * отвечали заявителю, и для своих сисадминов это было удобно; с появлением внешнего адресата так
   * оставлять нельзя: ответ подрядчика ушёл бы от лица чужой организации человеку, который её не
   * знает, мимо тех, кто ведёт заявку. Правило одно на всех адресатов письма намеренно — второй
   * обратный адрес означал бы второе тело письма (приписка называет, куда уйдёт ответ), то есть
   * два расходящихся письма об одном событии.
   *
   * Автор заявки от этого не теряется: его имя названо в теле строкой «Заявку завёл».
   */
  const to = recipientCollector();
  for (const row of [...named, ...operators]) to.add(row.id, row.email, channelEmail);
  if (contractor) {
    to.add(
      `counterparty-${assignment.serviceCounterpartyId}`,
      contractor,
      channelEmail,
      'contractor',
    );
  }
  // Половина письма про новое задание закончилась: дальше идёт отзыв, и его адресаты в этот счёт
  // попадать не должны — иначе «задание дошло» подтверждалось бы письмом прежнему подрядчику.
  const newAssignmentReachedRecipient = to.list.length > 0;
  for (const row of previousOperators) {
    to.add(`withdrawn-${row.id}`, row.email, channelEmail, 'contractor_withdrawn');
  }
  if (previousContractor) {
    to.add(
      `counterparty-withdrawn-${assignment.previousServiceCounterpartyId}`,
      previousContractor,
      channelEmail,
      'contractor_withdrawn',
    );
  }
  // Писем нет вовсе, хотя действие их требовало (случай «не требовалось» отсечён в самом начале):
  // ни у назначенных, ни у той стороны, у которой работу забрали, нет ни одного живого адреса.
  if (to.list.length === 0) return { plan: null, outcome: 'no_recipients' };

  const copies = await db
    .select()
    .from(moduleMailRecipients)
    .where(and(eq(moduleMailRecipients.event, event), eq(moduleMailRecipients.isEnabled, true)));
  const withdrawalReachedRecipient = to.list.some((r) => r.audience === 'contractor_withdrawn');

  for (const row of copies) {
    to.add(
      row.id,
      row.toEmail,
      replyToOf(row.replyToMode, row.replyToEmail, { author: authorEmail, actor: ctx.actor.email }),
      'copy',
    );
  }

  /**
   * Исход отвечает за ОБЕ половины письма, а не за ту, что дошла первой.
   *
   * Половины две и обе обязательны: новому исполнителю выдали задание, у прежней компании его
   * забрали. Считай мы только новую — переназначение к подрядчику с ящиком отвечало бы `queued`,
   * пока прежний, которому написать некуда, продолжал бы собирать выезд. Считай только старую —
   * потерялось бы само задание. Поэтому недоставленной хватает любой.
   */
  const newAssignmentMissed = hadNewAssignment && !newAssignmentReachedRecipient;
  const withdrawalMissed = hadWithdrawal && !withdrawalReachedRecipient;

  return {
    plan: { event, kind: event as MailKind, recipients: to.list },
    outcome: newAssignmentMissed || withdrawalMissed ? 'no_recipients' : 'queued',
  };
}

/**
 * Живые учётки, работающие от лица контрагента, — те, кто читает заявки этой компании в портале.
 *
 * Отбор один на все письма модуля намеренно: задание, отзыв задания и отмена адресуются одной и той
 * же стороне, и разойдись эти три списка — подрядчик получал бы назначение, но не отмену, что и
 * случилось до этой правки.
 *
 * Условие живой учётки: архивная и отключённая — это ящик, за которым никого нет. Роль спрашивается
 * вдобавок к контрагенту, а не вместо него: `users_operator_counterparty_check` (миграция 0023)
 * односторонний — «оператор обязан иметь контрагента», но не наоборот, и у учётки, переведённой на
 * другую роль, привязка остаётся. Такой человек заявок компании уже не видит, и письмо ему — письмо
 * в никуда.
 */
async function liveCounterpartyOperators(
  counterpartyId: string,
): Promise<{ id: string; email: string }[]> {
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.counterpartyId, counterpartyId),
        inArray(users.role, [...COUNTERPARTY_SCOPED_ROLES]),
        eq(users.isActive, true),
        isNull(users.deletedAt),
      ),
    )
    .orderBy(users.email);
}

/**
 * Общий ящик организации-подрядчика; пустая строка — адреса нет (ADR 0153, миграция 0241).
 *
 * Ни активность, ни архивность контрагента здесь НЕ спрашиваются, и это осознанно: заявка на него
 * уже ссылается, работу он уже делает, а «архивному подрядчику не пишем» означало бы, что заявку
 * отменили, а тому, кто едет, об этом не сказали. Отбор при НАЗНАЧЕНИИ — другое дело, и он стоит
 * на своём месте: `resolveServiceCounterparty` не даст отдать заявку удалённому или неактивному.
 */
async function contractorMailbox(counterpartyId: string): Promise<string> {
  const [row] = await db
    .select({ email: counterparties.email })
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId));
  return row?.email ?? '';
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

  const lines = [
    `Статус: ${serviceRequestStatusLabels[data.status]}`,
    ...(assignment && !withdrawn ? [`Назначены: ${assigneesOf(data)}`] : []),
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
    ...(data.objectCode !== null || data.objectName !== null
      ? [
          `Где стоит: ${data.objectCode ?? ''} — ${data.objectName ?? ''}${
            data.equipmentLocation ? `, ${data.equipmentLocation}` : ''
          }`,
        ]
      : []),
    ...(data.departmentName ? [`Отдел: ${data.departmentName}`] : []),
    ...(data.responsibleName || data.responsiblePhone
      ? [`Контакт: ${[data.responsibleName, data.responsiblePhone].filter(Boolean).join(', ')}`]
      : []),
    ...(data.authorName ? [`Заявку завёл: ${data.authorName}`] : []),
    ...(data.attachments > 0
      ? [
          // «См. в портале» — только тем, у кого портал есть. Копия читает его наравне со службой.
          audience === 'internal' || audience === 'copy'
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
      { kind: 'heading' as const, text: 'Описание' },
      { kind: 'paragraph' as const, text: data.description },
      ...(audience === 'internal' || audience === 'copy'
        ? [
            {
              kind: 'link' as const,
              href: `${config.publicOrigin}/office-equipment?tab=requests&id=${data.requestId}`,
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
            ? 'Это копия письма по заявке. Ссылка работает у тех, у кого есть доступ в портал; ' +
              'ответ уйдёт по адресу, заданному в настройке рассылки.'
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
 * Ставит письма события — по одному на адресата, каждое со своим ключом дедупликации и **телом по
 * своей аудитории**: подрядчику уходит письмо, приписка которого не врёт про обратный адрес.
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
    /** Уже отрисованные тела: ошибка рендера ловится вызывающим и даёт мягкий исход. */
    letters: ServiceLetters;
    /** Отличает повтор кнопкой от письма самого события (Р70). */
    idempotencyKey?: string;
  },
): Promise<void> {
  const suffix = params.idempotencyKey ? `:${params.idempotencyKey}` : '';

  for (const recipient of params.plan.recipients) {
    const letter = params.letters[recipient.audience];
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
