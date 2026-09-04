import { and, eq, inArray, isNull } from 'drizzle-orm';
import { can, COUNTERPARTY_SCOPED_ROLES, type ModuleMailEvent } from '@technic/contracts';
import type { db } from '../db/client';
import {
  counterparties,
  moduleMailEventSettings,
  moduleMailRecipients,
  serviceRequestExecutors,
  serviceRequests,
  users,
} from '../db/schema';
import { logger } from '../logger';
import { accessSubjectColumns, accessSubjectOf } from '../auth/principal';

/**
 * Сборщик сторон письма по заявке на обслуживание оргтехники (план
 * `docs/office-equipment-mail-expansion-plan.md`, §5.2–5.4; ADR 0159, решения 5 и 6).
 *
 * **Зачем отдельный модуль.** Адресаты собирались тремя разными местами — `planServiceMail`,
 * `contractorRecipients`, `planServiceAssignmentMail`, — и ADR 0153 уже поймал их расхождение:
 * отмена уходила на общий ящик компании, но не её живым операторам. С семью событиями таких мест
 * стало бы семь, и следующее расхождение нашлось бы тем же способом — по жалобе подрядчика.
 *
 * **Почему всё принимает `tx`.** Состав считается ПОСЛЕ того, как строка заявки взята под
 * блокировку, потому что через окно «посчитали заранее — записали потом» проходит не только
 * переназначение: меняют состав поимённых исполнителей, отзывают `serviceRequests.execute`,
 * деактивируют учётку, правят email. Сверка по одному признаку закрывает один путь из пяти и
 * называет это гарантией. Обращения к глобальному `db` здесь быть не должно — единственное
 * исключение объявлено типом `Reader` ниже и заведено ради **устаревшего** предтранзакционного
 * планировщика назначения, который ещё жив в `service-request-mail.ts`.
 *
 * **Что здесь НЕ живёт:** тела писем и исходы. Модуль отвечает на один вопрос — «кому», — а «чем» и
 * «чем всё кончилось» остаётся в `service-request-mail.ts`. Разделение не косметическое: адресатов
 * считает база, тела — чистые функции, и смешав их, мы потеряли бы границу «SQL-ошибка откатывает
 * всё, ошибка рендера — мягкий исход» (§5.9).
 */

/** Транзакция drizzle: письма ставятся вместе с тем, ради чего они отправляются. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Читатель базы. Транзакция — единственный законный вариант для событий (§5.2); глобальный `db`
 * остаётся ради `planServiceAssignmentMail`, который считает адресатов ДО транзакции и уезжает
 * вместе с переводом его db-тестов (этап Э3).
 */
type Reader = Tx | typeof db;

/**
 * Кому написано письмо — **своим, назначенной организации или прежнему подрядчику** (ADR 0153).
 * Различие не косметическое: у подрядчика ответ замкнут на службу, а не на заявителя, и приписка в
 * теле обязана говорить правду именно ему — он вне портала, и обратный адрес для него единственный
 * способ ответить. Прежнему подрядчику нужно отдельное тело: это отзыв задания, а не новое
 * назначение.
 *
 * Копия из `module_mail_recipients` — четвёртая аудитория, и с ADR 0159 (решение 7) она
 * **редактированная**: строка настройки хранит произвольный email, а не субъекта с проверяемым
 * правом, и раскрывать ему суммы, описание и контакт не на основании чего. Состав полей задаёт
 * закрытая карта `SERVICE_MAIL_AUDIENCE_FIELDS` в `service-request-mail.ts`.
 */
export type ServiceMailAudience = 'internal' | 'contractor' | 'contractor_withdrawn' | 'copy';

/**
 * Чем письмо вызвано — **источник** адресата, а не его адрес (ADR 0159, решение 6). Именно
 * источник исключается у актора, им же упорядочивается накопитель, и он же решает, какое тело
 * победит при совпадении адресов.
 */
export type ServiceMailSource =
  'channel' | 'internal_user' | 'contractor' | 'contractor_withdrawn' | 'copy';

/**
 * Порядок источников — фиксированный и **не зависящий от порядка строк SQL** (§5.2): свои (ящик
 * канала и учётки сотрудников) → текущий подрядчик → отзыв прежнему → копии.
 *
 * Порядок здесь решает, чьё тело достанется адресу, попавшему в письмо дважды. Отдай мы победу
 * копии — доверенное `internal`-тело подменялось бы наблюдательским по перестановке строк в
 * выборке, то есть незаметно и невоспроизводимо. Ящик канала идёт первым внутри своего класса
 * потому, что он — сторона, а не человек: письмо службе не должно зависеть от того, кто из её
 * сотрудников заодно назначен исполнителем.
 */
const SOURCE_ORDER: Record<ServiceMailSource, number> = {
  channel: 0,
  internal_user: 1,
  contractor: 2,
  contractor_withdrawn: 3,
  copy: 4,
};

/** Получатель письма: ящик канала, назначенный исполнитель, подрядчик или заведённая копия. */
export interface ServiceMailRecipient {
  /**
   * Часть ключа дедупликации — **чем вызвано письмо**, а не куда оно ушло: `channel` у основного
   * адресата писем службе, id учётки — у назначенного исполнителя, `counterparty-<id>` — у общего
   * ящика подрядчика, id строки — у копии. Двоеточий в ключе быть не должно: им разделены поля
   * самого ключа дедупликации (`событие:якорь:адресат`), и составной ключ адресата сделал бы разбор
   * ключа неоднозначным.
   */
  key: string;
  /** Нормализованный адрес (`trim` + lowercase): именно он уходит в очередь и в дедупликацию. */
  email: string;
  /** Куда уйдёт ответ; пусто — общий адрес портала. */
  replyTo: string;
  /** Каким телом письма адресата обслуживать (см. `ServiceMailAudience`). */
  audience: ServiceMailAudience;
  /** Победивший источник: он определяет тело, Reply-To и ключ дедупликации (§5.4). */
  source: ServiceMailSource;
  /**
   * Стабильный ключ порядка внутри класса источника — идентификатор строки, а не email и не
   * порядок выдачи SQL. Порядок писем не должен переставляться от плана запроса: по нему считается
   * «первое письмо» в тестах и разбирается очередь в проде.
   */
  sortId: string;
  /**
   * Чей это **общий ящик из карточки контрагента**; `null` — адрес принадлежит человеку.
   *
   * Поле отвечает исключению источника-актора и только ему: вычёркивается общий ящик ТОЙ компании,
   * от лица которой актор действует (§5.4). У операторов той же компании здесь `null` намеренно —
   * они люди, а не диспетчерская: оператор, отменивший заявку, не должен лишать письма коллегу.
   */
  counterpartyId: string | null;
}

/**
 * Актор события: его источник вычёркивается из обычных адресатов (§5.4, ADR 0159, решение 6).
 *
 * Учётка — **по адресу**, а не по ключу: человек попадает в письмо и поимённо, и как оператор
 * компании. Компания — по идентификатору: письмо про собственное действие в диспетчерскую своей же
 * компании это эхо, а не уведомление.
 */
export interface ServiceMailActor {
  id: string;
  email: string;
  counterpartyId: string | null;
}

/** Что сборщику нужно знать помимо базы: адреса, которые считаются из конфигурации и из заявки. */
export interface ServiceMailAudienceCtx {
  /** Адрес ящика канала `repair`: он же отправитель, он же обратный адрес внешних тел (§5.8). */
  channelEmail: string;
  /**
   * Обратный адрес **внутреннего** тела. У двух сложившихся писем службе (`waiting_it`,
   * `cancelled`) это автор заявки — у службы вопросы именно к нему, и менять сложившееся поведение
   * этой работой незачем; у остальных событий цикла — ящик службы (§5.8).
   */
  internalReplyTo: string;
  actor: ServiceMailActor;
}

/**
 * Сторона заявки **на момент факта**: то, по чему считается адресат.
 *
 * Снимается внутри транзакции и **до** бизнес-изменения, а не после него, и это не придирка к
 * порядку. Отмена сбрасывает исполнителя тем же переходом (`serviceResetOnTransition`, флаг
 * `executor`): строка, перечитанная после него, о подрядчике уже не помнит, и письмо «выезд не
 * требуется» ушло бы одной службе — ровно тому, кто отмену и сделал. Переназначение при этом
 * читает своих адресатов не отсюда, а из намерения ручки: новый состав известен только ей.
 */
export interface ServiceRequestSide {
  serviceCounterpartyId: string | null;
  /** Поимённые исполнители заявки: идентификаторы строк `service_request_executors`. */
  executorUserIds: string[];
}

/**
 * Куда адресовано письмо. `office` — ящик канала (за ним нет учётки, это сторона, а не человек);
 * `service` — назначенная компания целиком; `{ userId }` — одна назначенная учётка, то есть
 * адресация реплики по имени, а не вся сторона `service`.
 */
export type ServiceMailTarget = 'office' | 'service' | { userId: string };

// ── Рубильник события ──

/**
 * Включено ли событие (`module_mail_event_settings`, §5.1).
 *
 * Читается `FOR SHARE` внутри транзакции события и **первым** — до сборки адресатов: если писать не
 * велено, состояние адресов к делу не относится вовсе, и `no_recipients` звал бы заводить ящик там,
 * где письма никто не просил.
 *
 * Отсутствующая строка — fail-closed: событие, о котором база не знает, не может начать слать письма
 * наружу оттого, что кто-то забыл наполнить настройку. Молчать про это нельзя — строки заводит
 * миграция, и их отсутствие означает недокаченный выкат, снаружи неотличимый от «администратор
 * выключил»; отсюда `error` в логе рядом с fail-closed ответом.
 */
export async function isServiceMailEventEnabled(tx: Tx, event: ModuleMailEvent): Promise<boolean> {
  const [row] = await tx
    .select({ isEnabled: moduleMailEventSettings.isEnabled })
    .from(moduleMailEventSettings)
    .where(eq(moduleMailEventSettings.event, event))
    .for('share');
  if (!row) {
    logger.error({ event }, 'рубильник почты модуля: у события нет строки настройки — письма нет');
    return false;
  }
  return row.isEnabled;
}

// ── Сторона заявки и субъекты ──

/**
 * Сторона заявки внутри транзакции. Поимённый состав читается строками, а не полем заявки: слоя у
 * назначения два (Н5), и «заявка за компанией» ничего не говорит о том, кто ведёт её поимённо.
 */
export async function readServiceSide(tx: Tx, requestId: string): Promise<ServiceRequestSide> {
  const [row] = await tx
    .select({ serviceCounterpartyId: serviceRequests.serviceCounterpartyId })
    .from(serviceRequests)
    .where(eq(serviceRequests.id, requestId));
  if (!row) throw new Error(`Заявка ${requestId} не найдена при сборке адресатов письма`);
  const executors = await tx
    .select({ userId: serviceRequestExecutors.userId })
    .from(serviceRequestExecutors)
    .where(eq(serviceRequestExecutors.requestId, requestId))
    .orderBy(serviceRequestExecutors.userId);
  return {
    serviceCounterpartyId: row.serviceCounterpartyId,
    executorUserIds: executors.map((e) => e.userId),
  };
}

/** Живая учётка вместе с субъектом доступа: адрес письма и ответ на вопрос «а можно ли ей». */
export interface ExecuteCandidate {
  id: string;
  email: string;
  /** Есть ли у учётки `serviceRequests.execute` **сейчас** — считает `can` из контрактов. */
  canExecute: boolean;
}

/**
 * Кандидаты в адресаты вместе с их правом исполнителя (§5.2).
 *
 * **Право не пересчитывается своей формулой.** Субъект собирается теми же выражениями, что у
 * `loadPrincipal` (`accessSubjectColumns`, `accessSubjectOf`), а ответ даёт `can(subject,
 * 'serviceRequests.execute')` из контрактов: заведи почта собственное правило — она решала бы про
 * доступ по-своему, и разошлись бы они молча, на первой же правке гейта совместимости с ролью.
 *
 * **`FOR SHARE` по отсортированному id и до вычисления прав.** Все изменения активности, email,
 * роли и наборов обязаны в своей транзакции трогать ту же строку пользователя (`auth_version`),
 * поэтому отзыв, закоммиченный до блокировки, адресата исключает, а конкурентный отзыв
 * сериализуется с созданием строк очереди. Сортировка по id — против взаимной блокировки: две
 * транзакции, берущие один и тот же набор учёток в разном порядке, встали бы насмерть.
 *
 * Архивная и отключённая учётки в ответ не попадают вовсе: это ящик, за которым никого нет, и
 * молчаливо отправить туда письмо хуже, чем сказать назначившему «предупредите их сами».
 */
export async function executeSubjectsOf(
  tx: Tx,
  userIds: string[],
): Promise<Map<string, ExecuteCandidate>> {
  const map = new Map<string, ExecuteCandidate>();
  const ids = [...new Set(userIds)].sort();
  if (ids.length === 0) return map;
  const rows = await tx
    .select({
      id: users.id,
      email: users.email,
      ...accessSubjectColumns,
    })
    .from(users)
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id))
    .where(and(inArray(users.id, ids), eq(users.isActive, true), isNull(users.deletedAt)))
    .orderBy(users.id)
    // `OF users`: блокируется строка учётки, а не карточка контрагента. Внешнее соединение свою
    // нулевую сторону блокировать и не даёт — PostgreSQL отказал бы запросу целиком.
    .for('share', { of: users });
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      email: row.email,
      canExecute: can(accessSubjectOf(row), 'serviceRequests.execute'),
    });
  }
  return map;
}

/**
 * Живые учётки, работающие от лица контрагента, — те, кто читает заявки этой компании в портале.
 *
 * Отбор один на все письма модуля намеренно: задание, отзыв задания и отмена адресуются одной и той
 * же стороне, и разойдись эти три списка — подрядчик получал бы назначение, но не отмену, что и
 * случилось до ADR 0153.
 *
 * Условие живой учётки: архивная и отключённая — это ящик, за которым никого нет. Роль спрашивается
 * вдобавок к контрагенту, а не вместо него: `users_operator_counterparty_check` (миграция 0023)
 * односторонний — «оператор обязан иметь контрагента», но не наоборот, и у учётки, переведённой на
 * другую роль, привязка остаётся. Такой человек заявок компании уже не видит, и письмо ему — письмо
 * в никуда.
 *
 * **`serviceRequests.execute` у оператора подрядчика не спрашивается, и это не пропуск.** Право
 * заведено для поимённого слоя назначения и сервисной компании не выдаётся вовсе
 * (`COUNTERPARTY_TYPE_PERMISSIONS`): у неё назначается контрагент, а не человек. Спроси мы его
 * здесь — подрядчик перестал бы получать почту целиком.
 *
 * Порядок — по id: он стабилен и не переставляется от того, как заведены адреса.
 */
export async function liveCounterpartyOperators(
  reader: Reader,
  counterpartyId: string,
): Promise<{ id: string; email: string }[]> {
  return reader
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
    .orderBy(users.id);
}

/**
 * Общий ящик организации-подрядчика; пустая строка — адреса нет (ADR 0153, миграция 0241).
 *
 * Ни активность, ни архивность контрагента здесь НЕ спрашиваются, и это осознанно: заявка на него
 * уже ссылается, работу он уже делает, а «архивному подрядчику не пишем» означало бы, что заявку
 * отменили, а тому, кто едет, об этом не сказали. Отбор при НАЗНАЧЕНИИ — другое дело, и он стоит
 * на своём месте: `resolveServiceCounterparty` не даст отдать заявку удалённому или неактивному.
 */
export async function counterpartyMailbox(reader: Reader, counterpartyId: string): Promise<string> {
  const [row] = await reader
    .select({ email: counterparties.email })
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId));
  return row?.email ?? '';
}

/** Адрес автора заявки: обратный адрес двух сложившихся писем службе (§5.8). */
export async function authorEmailOf(reader: Reader, authorId: string | null): Promise<string> {
  if (!authorId) return '';
  const [row] = await reader
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, authorId));
  return row?.email ?? '';
}

// ── Стороны письма ──

/**
 * Адресаты одной стороны события (§5.2).
 *
 * - `office` — ящик канала `repair`, аудитория `internal`. Учётки за ним нет: это сторона, а не
 *   человек, и потому он не вычёркивается исключением актора (§5.4).
 * - `service` — назначенная компания целиком: её живые операторы, общий ящик карточки и активные
 *   поимённые исполнители заявки. Внешним — тело подрядчика, своим сотрудникам — внутреннее.
 * - `{ userId }` — только та активная учётка, которая **сейчас назначена на эту заявку** и имеет
 *   `serviceRequests.execute`. Это адресация по имени, а не вся сторона `service`: реплика
 *   конкретному исполнителю не должна приходить всей компании.
 *
 * Возвращает кандидатов, а не готовый список: исключение актора, нормализацию и дедупликацию делает
 * накопитель (`collectServiceMailRecipients`) — одним правилом на все стороны сразу.
 */
export async function sideRecipients(
  tx: Tx,
  row: ServiceRequestSide,
  target: ServiceMailTarget,
  ctx: ServiceMailAudienceCtx,
): Promise<ServiceMailRecipient[]> {
  if (target === 'office') {
    if (!ctx.channelEmail) return [];
    return [
      {
        key: 'channel',
        email: ctx.channelEmail,
        replyTo: ctx.internalReplyTo,
        audience: 'internal',
        source: 'channel',
        sortId: 'channel',
        counterpartyId: null,
      },
    ];
  }

  if (typeof target === 'object') {
    // Не назначенному письма нет вовсе: поимённая адресация обязана упереться в тот же факт
    // назначения, которым открываются ходы исполнителя, — иначе почта раздавала бы движение по
    // заявке шире, чем портал его показывает.
    if (!row.executorUserIds.includes(target.userId)) return [];
    const live = await executeSubjectsOf(tx, [target.userId]);
    const person = live.get(target.userId);
    if (!person || !person.canExecute) return [];
    return [namedRecipientOf(person, ctx)];
  }

  const counterpartyId = row.serviceCounterpartyId;
  const operators = counterpartyId ? await liveCounterpartyOperators(tx, counterpartyId) : [];
  /**
   * Все кандидатные учётки — **одним** блокирующим чтением по отсортированному id: операторы
   * компании и поимённые исполнители берутся вместе, потому что два отдельных `FOR SHARE` по
   * пересекающимся наборам в разном порядке — это готовый взаимный замок.
   */
  const live = await executeSubjectsOf(tx, [...operators.map((o) => o.id), ...row.executorUserIds]);

  const list: ServiceMailRecipient[] = [];
  for (const id of row.executorUserIds) {
    const person = live.get(id);
    // Право спрашивается КАЖДЫЙ раз, а не однажды при назначении: отозванный набор обязан закрыть
    // и почту, иначе снятый с модуля сотрудник продолжал бы читать движение по чужим заявкам.
    if (person?.canExecute) list.push(namedRecipientOf(person, ctx));
  }
  for (const operator of operators) {
    const person = live.get(operator.id);
    if (!person) continue;
    list.push({
      key: person.id,
      email: person.email,
      replyTo: ctx.channelEmail,
      audience: 'contractor',
      source: 'contractor',
      sortId: person.id,
      counterpartyId: null,
    });
  }
  if (counterpartyId) {
    const mailbox = await counterpartyMailbox(tx, counterpartyId);
    if (mailbox) {
      list.push({
        key: `counterparty-${counterpartyId}`,
        email: mailbox,
        replyTo: ctx.channelEmail,
        audience: 'contractor',
        source: 'contractor',
        sortId: counterpartyId,
        counterpartyId,
      });
    }
  }
  return list;
}

/**
 * Свой сотрудник, назначенный поимённо: тело внутреннее (ему полезна ссылка в портал — учётка у
 * него есть), обратный адрес — ящик службы.
 */
function namedRecipientOf(
  person: ExecuteCandidate,
  ctx: ServiceMailAudienceCtx,
): ServiceMailRecipient {
  return {
    key: person.id,
    email: person.email,
    replyTo: ctx.channelEmail,
    audience: 'internal',
    source: 'internal_user',
    sortId: person.id,
    counterpartyId: null,
  };
}

/**
 * Сторона компании при назначении: то же, что половина `service`, но по компании из **намерения
 * ручки**, а не из строки заявки.
 *
 * Отдельная функция потому, что назначение — единственное событие, у которого сторона считается не
 * по текущему состоянию: новую компанию транзакция как раз записывает, а прежнюю знает только
 * ручка, и после записи её из заявки уже не достать. Поимённых исполнителей здесь нет намеренно —
 * задание уходит **добавленным** (их список тоже знает только ручка), а не всему составу: иначе
 * второй сисадмин рядом с первым означал бы письмо «вам назначено» тому, кто ведёт заявку неделю.
 */
export async function counterpartySideRecipients(
  tx: Tx,
  counterpartyId: string,
  kind: 'assigned' | 'withdrawn',
  ctx: ServiceMailAudienceCtx,
): Promise<ServiceMailRecipient[]> {
  const withdrawn = kind === 'withdrawn';
  const audience: ServiceMailAudience = withdrawn ? 'contractor_withdrawn' : 'contractor';
  const source: ServiceMailSource = withdrawn ? 'contractor_withdrawn' : 'contractor';
  const operators = await liveCounterpartyOperators(tx, counterpartyId);
  const list: ServiceMailRecipient[] = operators.map((operator) => ({
    key: withdrawn ? `withdrawn-${operator.id}` : operator.id,
    email: operator.email,
    replyTo: ctx.channelEmail,
    audience,
    source,
    sortId: operator.id,
    counterpartyId: null,
  }));
  const mailbox = await counterpartyMailbox(tx, counterpartyId);
  if (mailbox) {
    list.push({
      key: withdrawn
        ? `counterparty-withdrawn-${counterpartyId}`
        : `counterparty-${counterpartyId}`,
      email: mailbox,
      replyTo: ctx.channelEmail,
      audience,
      source,
      sortId: counterpartyId,
      counterpartyId,
    });
  }
  return list;
}

/**
 * Поимённые адресаты, названные самой ручкой: назначаемые исполнители.
 *
 * Список приходит параметром, а не вычитывается из `service_request_executors`, ровно потому, что
 * это **дельта** назначения: строки в таблице к этому моменту уже стоят все, и прочитанный оттуда
 * состав отправил бы задание и тем, кому его никто не выдавал.
 */
export async function namedRecipients(
  tx: Tx,
  userIds: string[],
  ctx: ServiceMailAudienceCtx,
): Promise<ServiceMailRecipient[]> {
  const live = await executeSubjectsOf(tx, userIds);
  const list: ServiceMailRecipient[] = [];
  for (const id of userIds) {
    const person = live.get(id);
    if (person?.canExecute) list.push(namedRecipientOf(person, ctx));
  }
  return list;
}

/**
 * Включённые копии события (§5.6, §5.8).
 *
 * **Обратный адрес копии больше не выбирается строкой.** Режимы `author` и `actor` означают, что
 * произвольный адрес настройки получает личный email автора заявки или нажавшего кнопку — раздачу
 * адресов по строке, у которой нет субъекта. По событиям заявок режим не применяется: ответ уходит
 * в ящик службы, как и у всех внешних тел (ADR 0159, решение 8). Колонки `reply_to_mode` и
 * `reply_to_email` со своим `CHECK` при этом остаются в схеме — строки прошлых выпусков обязаны
 * оставаться валидными, а удаление полей ради красоты стоило бы миграции и потери истории
 * настройки; читать их этот путь просто перестал.
 *
 * Порядок — по id строки: копии перечисляются одинаково от прогона к прогону.
 */
export async function copyRecipients(
  tx: Tx,
  event: ModuleMailEvent,
  ctx: ServiceMailAudienceCtx,
): Promise<ServiceMailRecipient[]> {
  const rows = await tx
    .select({ id: moduleMailRecipients.id, toEmail: moduleMailRecipients.toEmail })
    .from(moduleMailRecipients)
    .where(and(eq(moduleMailRecipients.event, event), eq(moduleMailRecipients.isEnabled, true)))
    .orderBy(moduleMailRecipients.id)
    .for('share');
  return rows.map((row) => ({
    key: row.id,
    email: row.toEmail,
    replyTo: ctx.channelEmail,
    audience: 'copy' as const,
    source: 'copy' as const,
    sortId: row.id,
    counterpartyId: null,
  }));
}

// ── Накопитель ──

/** Адрес одним видом: `trim` + lowercase — до исключения и до дедупликации (§5.2). */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Итоговые адресаты: нормализация → исключение источника-актора → дедупликация, в фиксированном
 * порядке источников.
 *
 * **Дедупликация по адресу, а не по ключу.** Источники пересекаются, и человек попадает в письмо
 * дважды с разных сторон: ящик службы бывает заведён ещё и копией, а назначенный исполнитель —
 * заодно и той копией, которой «хочется видеть все назначения». Ключи у таких попаданий разные (id
 * учётки и id строки настройки), и `(kind, dedupe_key)` в очереди их не схлопнет: в один ящик
 * пришли бы два одинаковых письма.
 *
 * **Отзыв назначения дедупликацией не гасится** даже при одном общем ящике у двух контрагентов:
 * «вам назначено» и «у вас отозвано» — две разные новости, и схлопнуть их значило бы потерять одну.
 *
 * **Исключается источник, а не адрес** (ADR 0159, решение 6). Ящик канала и настроенные копии не
 * вычёркиваются никогда: служба — сторона, а не человек (вычеркни мы её, журнал зиял бы дырами
 * ровно там, где служба работала), а копии завели ради наблюдения со стороны, и гасить его по
 * совпадению адреса значило бы делать наблюдение выборочным — причём незаметно для того, кто его
 * настроил. Поэтому обещать «этот email ничего не получит» нельзя: он может получить письмо как
 * канал или как копия.
 */
export function collectServiceMailRecipients(
  candidates: ServiceMailRecipient[],
  actor: ServiceMailActor,
): ServiceMailRecipient[] {
  const actorEmail = normalizeEmail(actor.email);
  const ordered = candidates
    .map((row) => ({ ...row, email: normalizeEmail(row.email) }))
    .filter((row) => row.email !== '')
    // Порядок задаётся классом источника и стабильным id — не тем, в каком порядке строки вернул
    // SQL. Иначе «первый источник побеждает» означало бы «побеждает тот, кого выбрал планировщик».
    .sort((a, b) =>
      SOURCE_ORDER[a.source] !== SOURCE_ORDER[b.source]
        ? SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]
        : a.sortId.localeCompare(b.sortId),
    );

  const seen = new Set<string>();
  const list: ServiceMailRecipient[] = [];
  for (const row of ordered) {
    if (isActorSource(row, actorEmail, actor.counterpartyId)) continue;
    const identity =
      row.source === 'contractor_withdrawn' ? `${row.email}|contractor_withdrawn` : row.email;
    if (seen.has(identity)) continue;
    seen.add(identity);
    list.push(row);
  }
  return list;
}

/**
 * Тот ли это источник, которым действует актор. Учётка — по адресу (человек попадает в письмо и
 * поимённо, и как оператор компании), общий ящик — по компании, от лица которой актор действует.
 */
function isActorSource(
  row: ServiceMailRecipient,
  actorEmail: string,
  actorCounterpartyId: string | null,
): boolean {
  if (row.source === 'channel' || row.source === 'copy') return false;
  if (actorEmail && row.email === actorEmail) return true;
  return !!actorCounterpartyId && row.counterpartyId === actorCounterpartyId;
}

/**
 * Адрес из строки отправителя: `«Ремонт оргтехники <repair@example.ru>»` → `repair@example.ru`.
 * Строка без угловых скобок — уже адрес.
 */
export function addressOf(from: string): string {
  const match = /<([^>]+)>/u.exec(from);
  return (match?.[1] ?? from).trim();
}

// ── Кому адресован приложенный документ ──

/**
 * Стороны письма о документе (§5.2 плана расширения, § 3 № 6).
 *
 * Документ адресован **противоположной стороне**: подрядчик приложил акт — читает служба; служба
 * приложила счёт или фотографии — читает подрядчик. У `POST /:id/files` нет признака «от какой роли
 * я сейчас действую», и выбирать одну сторону по основной подписи профиля было бы скрытой
 * эвристикой: у своего сисадмина, назначенного поимённо, обе стороны настоящие. Поэтому при двойном
 * участии письмо уходит обеим — лишнее письмо здесь дешевле пропавшего.
 *
 * Закрытая функция, а не пара `if` в маршруте: тот же вопрос задаст следующее событие, и второй
 * ответ на него разошёлся бы с первым молча.
 */
export function documentMailTargets(opts: {
  /** Приложивший работает по этой заявке: подрядчик её компании или поимённый исполнитель. */
  actorOnServiceSide: boolean;
  /** Приложивший — внешняя учётка подрядчика (оператор контрагента), а не свой сотрудник. */
  actorIsExternal: boolean;
  /** Заявка отдана сервисной компании: без неё писать «стороне сервиса» некому. */
  hasServiceAssignment: boolean;
}): Array<'office' | 'service'> {
  const targets: Array<'office' | 'service'> = [];
  // Внешний подрядчик пишет службе — она ведёт заявку и ждёт закрывающих бумаг.
  if (opts.actorOnServiceSide && opts.actorIsExternal) targets.push('office');
  // Свой сотрудник (служба, заявитель, поимённый исполнитель) — стороне сервиса, если она есть.
  if (!opts.actorIsExternal && opts.hasServiceAssignment) targets.push('service');
  // Свой поимённый исполнитель — это обе стороны разом: он и работает, и ведёт заявку изнутри.
  if (opts.actorOnServiceSide && !opts.actorIsExternal && !targets.includes('office')) {
    targets.push('office');
  }
  return targets;
}
