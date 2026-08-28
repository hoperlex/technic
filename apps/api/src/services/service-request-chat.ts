import { and, asc, desc, eq, gt, inArray, lt, sql, type SQL } from 'drizzle-orm';
import {
  actsForCounterparty,
  audienceMatches,
  canWriteChat,
  participantSidesOf,
  SERVICE_CHAT_SIDES,
  serviceRequestStatusLabels,
  type SendServiceChatMessageInput,
  type ServiceChatFacts,
  type ServiceChatMessageDto,
  type ServiceChatPageDto,
  type ServiceChatPageQuery,
  type ServiceChatSide,
  type ServiceRequestChatSummaryDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  officeEquipment,
  serviceRequestExecutors,
  serviceRequestMessageAddressees,
  serviceRequestMessageReads,
  serviceRequestMessages,
  serviceRequests,
  users,
} from '../db/schema';
import type { Principal } from '../auth/principal';
import { err } from '../lib/errors';
import {
  inServiceRequestCustomerScope,
  serviceRequestCustomerScopeWhere,
} from '../lib/access';

/**
 * Обсуждение заявки на обслуживание оргтехники (ADR 0141, `docs/office-equipment-chat-plan.md`).
 *
 * Здесь живёт всё, что переписка делает с базой: выдача номера реплики под блокировкой заявки,
 * страница ленты, курсор прочтения и счёт непрочитанного. Правила сторон сюда НЕ переезжают — они
 * в контрактах (`participantSidesOf`, `audienceMatches`, `canWriteChat`), а этот модуль считает для
 * них факты и зовёт их. Второе правило рядом с первым разошлось бы молча: подсветка показывала бы
 * одно, а ручка отвечала бы другое (§3.2 плана).
 *
 * ПОЧЕМУ СЫРОЙ SQL У СЧЁТЧИКОВ. Счёт непрочитанного держится на `EXISTS`-подзапросе, цепляющемся за
 * внешнюю строку. Собирая список колонок односоставного запроса, drizzle переписывает колоночные
 * чанки в голые идентификаторы, и такая ссылка разрешается уже в таблицу подзапроса — молча, без
 * отказа, с ответом «ничего нет» (`office-equipment-sql-correlation.test.ts`). В сыром запросе
 * переписывать нечего: текст уходит в базу таким, каким написан.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Строки заявки, из которых считаются факты разговора. `RequestRow` подходит целиком. */
export interface ChatRequestRow {
  id: string;
  status: ServiceRequestStatus;
  createdBy: string;
  equipmentObjectId: string;
  customerDepartmentId: string | null;
  equipmentDepartmentId: string | null;
  serviceCounterpartyId: string | null;
}

/**
 * Что сервер знает о паре «этот человек ↔ эта заявка». Из этих четырёх признаков контракты считают
 * стороны; сам принципал уходит к ним вторым аргументом — права спрашиваются у него, а не
 * раскладываются по фактам (иначе у матрицы прав завелось бы второе представление).
 *
 * `inCustomerScope` берётся тем же правилом, что и область видимости
 * (`inServiceRequestCustomerScope` рядом с `serviceRequestScopeWhere`): разойдись они, человек
 * получал бы яркую метку на реплику «Заявителю» в заявке, которой он не видит, — или не получал бы
 * в той, которую ведёт.
 *
 * `actsForAssignedService` — это назначение ИМЕННО этой заявки, а не «работает в сервисной
 * компании»: подрядчик, которому заявку не отдали, стороной разговора по ней не является.
 */
export function chatFactsFor(
  p: Principal,
  row: ChatRequestRow,
  executorIds: readonly string[],
): ServiceChatFacts {
  return {
    userId: p.id,
    isAuthor: row.createdBy === p.id,
    inCustomerScope: inServiceRequestCustomerScope(p, {
      objectId: row.equipmentObjectId,
      customerDepartmentId: row.customerDepartmentId,
      equipmentDepartmentId: row.equipmentDepartmentId,
    }),
    actsForAssignedService:
      actsForCounterparty(p, 'service') &&
      row.serviceCounterpartyId !== null &&
      row.serviceCounterpartyId === p.counterpartyId,
    isNamedExecutor: executorIds.includes(p.id),
  };
}

// ── Аудитория адресата на языке SQL ──

/**
 * Признаки заявки — те четыре поля `ServiceChatFacts`, ответ по которым зависит от строки, а не от
 * учётки. Ровно им ниже сопоставляются предикаты SQL.
 */
const REQUEST_FACT_KEYS = [
  'isAuthor',
  'inCustomerScope',
  'actsForAssignedService',
  'isNamedExecutor',
] as const;
type RequestFactKey = (typeof REQUEST_FACT_KEYS)[number];

/** Факты, где истинен ровно один признак заявки (или ни одного): ими опрашиваются контракты. */
function probeFacts(p: Principal, only?: RequestFactKey): ServiceChatFacts {
  return {
    userId: p.id,
    isAuthor: only === 'isAuthor',
    inCustomerScope: only === 'inCustomerScope',
    actsForAssignedService: only === 'actsForAssignedService',
    isNamedExecutor: only === 'isNamedExecutor',
  };
}

/**
 * «Эта реплика адресована мне?» — предикатом SQL, над строками `service_request_messages m` и
 * `service_requests` (без псевдонима: колонки подставляются объектами схемы и приезжают
 * квалифицированными).
 *
 * ПРАВИЛО НЕ ПЕРЕПИСЫВАЕТСЯ, А ОПРАШИВАЕТСЯ. Счётчик непрочитанного не может перебрать заявки
 * поштучно — он считает их сразу по всей области субъекта, — значит стороны обязаны стать условием
 * запроса. Написать это условие руками означало бы завести вторую формулу сторон рядом с
 * контрактной; она разошлась бы с ней на первой же правке модели, и разошлась бы молча.
 *
 * Поэтому SQL СОБИРАЕТСЯ ИЗ ОТВЕТОВ `audienceMatches`: у каждой стороны спрашивается, подходит ли
 * она субъекту при пустых признаках заявки (тогда сторона верна всегда — так отвечают `all`,
 * `operator` и `it`, считающиеся по правам), а затем — при каждом признаке по отдельности (тогда в
 * дизъюнкцию входит предикат этого признака). Разложение точное, потому что каждая сторона в
 * контрактах — дизъюнкция признаков: `customer` это «автор ∪ область заказчика», `service` —
 * «назначенный подрядчик ∪ поимённый исполнитель». Заведись там конъюнкция, разложение стало бы
 * шире правила, и это заметил бы db-тест счёта, а не читатель.
 *
 * Поимённый адресат сравнивается напрямую (`a.user_id = :me`) — это и есть весь ответ контрактов
 * для адресата-учётки, выводить его из прав нечем.
 */
function addressedToMeSql(p: Principal): SQL {
  const factSql: Record<RequestFactKey, SQL> = {
    isAuthor: eq(serviceRequests.createdBy, p.id),
    inCustomerScope: serviceRequestCustomerScopeWhere(
      p,
      serviceRequests.equipmentObjectId,
      serviceRequests.customerDepartmentId,
      serviceRequests.equipmentDepartmentId,
    ),
    // «Оператор назначенного контрагента» — две половины: тип контрагента у учётки и совпадение с
    // исполнителем заявки. Без первой любой контрагент с совпавшим идентификатором стал бы
    // сервисной стороной; без второй — сервисной стороной по чужой заявке.
    actsForAssignedService:
      actsForCounterparty(p, 'service') && p.counterpartyId
        ? eq(serviceRequests.serviceCounterpartyId, p.counterpartyId)
        : sql`false`,
    isNamedExecutor: sql`EXISTS (
      SELECT 1 FROM ${serviceRequestExecutors}
       WHERE ${serviceRequestExecutors.requestId} = ${serviceRequests.id}
         AND ${serviceRequestExecutors.userId} = ${p.id}
    )`,
  };

  const parts: SQL[] = [sql`a.user_id = ${p.id}`];
  for (const side of SERVICE_CHAT_SIDES) {
    if (audienceMatches({ side }, p, probeFacts(p))) {
      parts.push(sql`a.side = ${side}`);
      continue;
    }
    const needs = REQUEST_FACT_KEYS.filter((key) =>
      audienceMatches({ side }, p, probeFacts(p, key)),
    ).map((key) => factSql[key]);
    if (needs.length === 0) continue;
    parts.push(sql`(a.side = ${side} AND (${sql.join(needs, sql` OR `)}))`);
  }

  return sql`EXISTS (
    SELECT 1 FROM ${serviceRequestMessageAddressees} a
     WHERE a.message_id = m.id AND (${sql.join(parts, sql` OR `)})
  )`;
}

/**
 * «Эта реплика для меня непрочитана» — три сомножителя, и каждый закрывает свою беду.
 *
 * `m.seq > COALESCE(rd.read_through_seq, 0)` — курсор, а не отметка времени: отправка, начавшаяся
 * до открытия окна и закоммиченная после отметки, при сравнении по времени рождалась бы прочитанной
 * (§3.4).
 *
 * `IS DISTINCT FROM`, А НЕ `<>`, и это не стилистика. У перенесённых реплик автор бывает пустым
 * (§3.9), а `NULL <> :me` даёт не «истину», а `UNKNOWN`: такая реплика не попала бы в непрочитанные
 * НИ У КОГО — то есть перенесённое примечание молча исчезло бы из подсветки у всех сразу.
 *
 * Отсечка по `users.created_at` читателя: стороны считаются динамически, и без неё сотрудник, чья
 * учётка заведена вчера, получил бы непрочитанной годовую переписку по всем видимым ему заявкам —
 * бейдж, который невозможно погасить работой. Дата спрашивается подзапросом без корреляции: он
 * считается один раз на весь запрос, а лишнее обращение к базе за одним полем ничего не экономит.
 */
function unreadSql(p: Principal): SQL {
  return sql`m.seq > COALESCE(rd.read_through_seq, 0)
    AND m.author_id IS DISTINCT FROM ${p.id}
    AND m.created_at >= (SELECT u.created_at FROM ${users} u WHERE u.id = ${p.id})`;
}

// ── Сводка для карточки и строки списка ──

/** Заявка страницы вместе с её поимёнными исполнителями: из них считаются факты разговора. */
export interface ChatSummaryInput {
  row: ChatRequestRow;
  executorIds: readonly string[];
}

interface SummaryRow extends Record<string, unknown> {
  request_id: string;
  total: number;
  last_seq: number;
  read_through_seq: number;
  unread_mine: number;
  unread_others: number;
}

/** Пустая сводка: у заявки, по которой ещё не сказано ни слова, курсору некуда указывать. */
function emptySummary(
  p: Principal,
  input: ChatSummaryInput,
): ServiceRequestChatSummaryDto {
  const facts = chatFactsFor(p, input.row, input.executorIds);
  return {
    canWrite: canWriteChat(p, facts, input.row.status),
    participantSides: participantSidesOf(p, facts),
    total: 0,
    unreadMine: 0,
    unreadOthers: false,
    lastSeq: 0,
    readThroughSeq: 0,
  };
}

/**
 * Блок `chat` сразу по всем заявкам страницы — ОДНИМ батч-запросом по их идентификаторам, рядом с
 * `itemsByRequest` и `filesByRequest` (§3.5). Не запросом на заявку: страница списка отдаёт до
 * полусотни строк, и счётчик, спрошенный поштучно, стоил бы полусотни обращений к базе на каждое
 * открытие списка.
 *
 * СЧИТАЮТСЯ СООБЩЕНИЯ, А НЕ СТРОКИ АДРЕСАТОВ, и это тот дефект, который второе ревью нашло в самом
 * плане. Человек совпадает сразу с несколькими адресатами одной реплики — `admin` это и `operator`,
 * и `it`; назначенный сисадмин — `it`, `service` и, возможно, поимённый адресат, — и соединение с
 * таблицей адресатов размножило бы такую реплику на две-три строки. `count(*)` по соединению
 * показал бы «3 новых сообщения» там, где сообщение одно. Поэтому принадлежность адресату
 * проверяется `EXISTS`-подзапросом, а счёт идёт по строкам реплик. `COUNT(DISTINCT m.id)` дал бы
 * тот же ответ, но заставил бы планировщик уникализировать соединение, тогда как `EXISTS`
 * останавливается на первом совпадении.
 *
 * `unreadOthers` показывается ТОЛЬКО участнику: блёклая точка зовёт вмешаться, а коллеге по отделу
 * вмешиваться нечем — он читает, но не пишет (§3.1). Считается она при этом у всех: отдельная ветка
 * запроса ради одного `false` в ответе стоила бы больше, чем сам счёт.
 */
export async function chatSummaryByRequest(
  p: Principal,
  inputs: readonly ChatSummaryInput[],
): Promise<Map<string, ServiceRequestChatSummaryDto>> {
  const map = new Map<string, ServiceRequestChatSummaryDto>();
  for (const input of inputs) map.set(input.row.id, emptySummary(p, input));
  if (inputs.length === 0) return map;

  const ids = sql.join(
    inputs.map((input) => sql`${input.row.id}::uuid`),
    sql`, `,
  );
  const mine = addressedToMeSql(p);
  const unread = unreadSql(p);
  const rows = await db.execute<SummaryRow>(sql`
    SELECT m.request_id AS request_id,
           count(*)::int AS total,
           max(m.seq)::int AS last_seq,
           COALESCE(max(rd.read_through_seq), 0)::int AS read_through_seq,
           count(*) FILTER (WHERE (${unread}) AND ${mine})::int AS unread_mine,
           count(*) FILTER (WHERE (${unread}) AND NOT ${mine})::int AS unread_others
      FROM ${serviceRequestMessages} m
      JOIN ${serviceRequests} ON ${serviceRequests.id} = m.request_id
      LEFT JOIN ${serviceRequestMessageReads} rd
        ON rd.request_id = m.request_id AND rd.user_id = ${p.id}
     WHERE m.request_id IN (${ids})
     GROUP BY m.request_id
  `);

  const byId = new Map(inputs.map((input) => [input.row.id, input]));
  for (const row of rows.rows) {
    const input = byId.get(row.request_id);
    if (!input) continue;
    const facts = chatFactsFor(p, input.row, input.executorIds);
    const participantSides = participantSidesOf(p, facts);
    map.set(row.request_id, {
      canWrite: canWriteChat(p, facts, input.row.status),
      participantSides,
      total: Number(row.total),
      unreadMine: Number(row.unread_mine),
      unreadOthers: participantSides.length > 0 && Number(row.unread_others) > 0,
      lastSeq: Number(row.last_seq),
      readThroughSeq: Number(row.read_through_seq),
    });
  }
  return map;
}

/**
 * Сколько заявок области субъекта несёт непрочитанное, адресованное ЕМУ, — число для бейджа раздела.
 *
 * Заявок, а не реплик: бейдж ведёт в список, и «7» обязано означать семь строк, к которым надо
 * подойти. Чужая переписка (блёклая точка) в счёт не идёт вовсе — иначе у «Ведения», видящего все
 * заявки модуля, бейдж горел бы всегда.
 *
 * Область приходит предикатом того же списка (`visibility` маршрута): разойдись они, бейдж считал бы
 * заявки, которых в списке не видно, и вёл бы в пустую очередь. Архивные не в счёт — по удалённой
 * заявке отвечать нечего.
 */
export async function chatUnreadCount(p: Principal, scope: SQL | undefined): Promise<number> {
  const mine = addressedToMeSql(p);
  const unread = unreadSql(p);
  const rows = await db.execute<{ c: number }>(sql`
    SELECT count(*)::int AS c
      FROM ${serviceRequests}
      LEFT JOIN ${serviceRequestMessageReads} rd
        ON rd.request_id = ${serviceRequests.id} AND rd.user_id = ${p.id}
     WHERE ${serviceRequests.deletedAt} IS NULL
       ${scope ? sql`AND ${scope}` : sql``}
       AND EXISTS (
         SELECT 1 FROM ${serviceRequestMessages} m
          WHERE m.request_id = ${serviceRequests.id}
            AND (${unread})
            AND ${mine}
       )
  `);
  return Number(rows.rows[0]?.c ?? 0);
}

// ── Лента ──

interface AddresseeRow {
  messageId: string;
  side: ServiceChatSide | null;
  userId: string | null;
  fullName: string | null;
}

/** Адресаты реплик страницы — одной выборкой: их по две-три на реплику, и запрос на каждую был бы N+1. */
async function addresseesOf(messageIds: string[]): Promise<Map<string, AddresseeRow[]>> {
  const map = new Map<string, AddresseeRow[]>();
  if (messageIds.length === 0) return map;
  const rows = await db
    .select({
      messageId: serviceRequestMessageAddressees.messageId,
      side: serviceRequestMessageAddressees.side,
      userId: serviceRequestMessageAddressees.userId,
      fullName: users.fullName,
    })
    .from(serviceRequestMessageAddressees)
    .leftJoin(users, eq(serviceRequestMessageAddressees.userId, users.id))
    .where(inArray(serviceRequestMessageAddressees.messageId, messageIds));
  for (const row of rows) {
    const list = map.get(row.messageId) ?? [];
    list.push(row);
    map.set(row.messageId, list);
  }
  return map;
}

interface MessageRow {
  id: string;
  seq: number;
  authorId: string | null;
  authorName: string | null;
  origin: 'chat' | 'import';
  body: string;
  createdAt: Date;
}

function toMessageDto(row: MessageRow, addressees: AddresseeRow[]): ServiceChatMessageDto {
  return {
    id: row.id,
    seq: row.seq,
    authorId: row.authorId,
    // Пусто только у перенесённых: имени там нет и выдумывать его нечем. Как это подписать —
    // «перенесено из примечания исполнителя» — решает портал, а не сервер.
    authorName: row.authorName ?? '',
    origin: row.origin,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    addressees: {
      sides: addressees
        .map((a) => a.side)
        .filter((side): side is ServiceChatSide => side !== null),
      users: addressees
        .filter((a) => a.userId !== null)
        .map((a) => ({ id: a.userId!, fullName: a.fullName ?? '' })),
    },
  };
}

/** Последний номер ленты заявки; 0 — не сказано ещё ничего. */
async function lastSeqOf(requestId: string): Promise<number> {
  const [row] = await db
    .select({ seq: sql<number>`COALESCE(max(${serviceRequestMessages.seq}), 0)::int` })
    .from(serviceRequestMessages)
    .where(eq(serviceRequestMessages.requestId, requestId));
  return Number(row?.seq ?? 0);
}

/** Докуда дочитал этот человек; строки нет — не открывал вовсе, и это ноль, а не «всё прочитано». */
async function readThroughOf(p: Principal, requestId: string): Promise<number> {
  const [row] = await db
    .select({ seq: serviceRequestMessageReads.readThroughSeq })
    .from(serviceRequestMessageReads)
    .where(
      and(
        eq(serviceRequestMessageReads.requestId, requestId),
        eq(serviceRequestMessageReads.userId, p.id),
      ),
    );
  return row?.seq ?? 0;
}

/**
 * Страница ленты. Курсорная по `seq`, а не по смещению: лента только растёт, и `OFFSET` съезжал бы
 * на каждую пришедшую реплику — человек, подгружающий историю вверх, видел бы одну и ту же строку
 * дважды.
 *
 * Порядок ответа всегда «снизу вверх» (по возрастанию `seq`), каким бы ни был запрос: лента
 * читается в одну сторону, и разворачивать её на клиенте пришлось бы по-разному в трёх случаях из
 * трёх. Сортировка по `seq`, а не по `created_at`: у времени возможны совпадения до микросекунды, и
 * порядок двух реплик одной секунды был бы неопределённым.
 *
 * `afterSeq` старше `beforeSeq`, когда пришли оба. Это не произвол: `afterSeq` — инкрементальный
 * опрос открытого окна («что нового»), и совместив его с подгрузкой истории, ручка ответила бы не
 * на тот вопрос и не на этот.
 */
export async function readChatPage(
  p: Principal,
  requestId: string,
  q: ServiceChatPageQuery,
): Promise<ServiceChatPageDto> {
  const [lastSeq, readThroughSeq] = await Promise.all([
    lastSeqOf(requestId),
    readThroughOf(p, requestId),
  ]);

  const authors = users;
  const page = db
    .select({
      id: serviceRequestMessages.id,
      seq: serviceRequestMessages.seq,
      authorId: serviceRequestMessages.authorId,
      authorName: authors.fullName,
      origin: serviceRequestMessages.origin,
      body: serviceRequestMessages.body,
      createdAt: serviceRequestMessages.createdAt,
    })
    .from(serviceRequestMessages)
    .leftJoin(authors, eq(serviceRequestMessages.authorId, authors.id));

  // Запрашивается на одну строку больше, чем отдаётся: `hasMore` так отвечается самой выборкой, а
  // не вторым запросом `count(*)` по той же ленте — тот стоил бы прохода по всем репликам заявки
  // ради одного булева.
  const probe = q.limit + 1;
  const forward = q.afterSeq !== undefined;
  const rows = forward
    ? await page
        .where(
          and(
            eq(serviceRequestMessages.requestId, requestId),
            gt(serviceRequestMessages.seq, q.afterSeq!),
          ),
        )
        .orderBy(asc(serviceRequestMessages.seq))
        .limit(probe)
    : await page
        .where(
          and(
            eq(serviceRequestMessages.requestId, requestId),
            q.beforeSeq !== undefined ? lt(serviceRequestMessages.seq, q.beforeSeq) : undefined,
          ),
        )
        .orderBy(desc(serviceRequestMessages.seq))
        .limit(probe);

  const hasMore = rows.length > q.limit;
  const taken = hasMore ? rows.slice(0, q.limit) : rows;
  const ordered = forward ? taken : [...taken].reverse();
  const addressees = await addresseesOf(ordered.map((row) => row.id));

  return {
    items: ordered.map((row) => toMessageDto(row, addressees.get(row.id) ?? [])),
    hasMore,
    lastSeq,
    readThroughSeq,
  };
}

// ── Отправка ──

/** Кто назначен на заявку поимённо — читается под блокировкой: адресат сверяется «на момент отправки». */
async function executorIdsOf(tx: Tx, requestId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: serviceRequestExecutors.userId })
    .from(serviceRequestExecutors)
    .where(eq(serviceRequestExecutors.requestId, requestId));
  return rows.map((row) => row.userId);
}

/**
 * Адресаты, прошедшие серверную проверку (§3.3). Клиенту не верят ни в одном пункте: портал гасит
 * остальные пункты при выборе «Всем участникам» и предлагает только назначенных, но и то и другое —
 * поведение интерфейса, а ручка открыта напрямую.
 *
 * ПЕРВЫЕ ДВЕ ПРОВЕРКИ ДУБЛИРУЮТ СХЕМУ, и через маршрут до них дело не доходит: `sendServiceChatMessageSchema`
 * разбирается ДО обработчика, и пустой список или «Всем участникам вместе со стороной» получают
 * 400 `validation_error` с пометкой поля — то есть ответ, который портал покажет прямо в форме.
 * Здесь они стоят ради всякого, кто зовёт функцию мимо схемы (перенос, скрипт, будущая ручка): у
 * правила «`all` не сочетается ни с чем» не должно быть входа, где оно не проверяется.
 *
 * Третья — единственная, до которой маршрут доходит по-настоящему: назначение схеме неизвестно, оно
 * читается из строк заявки под блокировкой, и отказ по нему 422 — «прислано разбираемое, но
 * несовместимое с состоянием записи».
 */
function checkedAddressees(
  input: SendServiceChatMessageInput,
  executorIds: readonly string[],
): { sides: ServiceChatSide[]; users: string[] } {
  const sides = [...new Set(input.addressees.sides)];
  const userIds = [...new Set(input.addressees.users)];
  if (sides.length === 0 && userIds.length === 0) {
    throw err.unprocessable('Выберите хотя бы одного адресата');
  }
  // «Всем» и «ещё вот этому» — противоречие: `all` уже включает любого, а при подсчёте яркости
  // такая пара давала бы двойной учёт одной реплики.
  if (sides.includes('all') && (sides.length > 1 || userIds.length > 0)) {
    throw err.unprocessable('«Всем участникам» не сочетается с другими адресатами');
  }
  // Поимённо — только назначенному исполнителю ЭТОЙ заявки. Иначе через ручку можно было бы
  // адресовать реплику любому uuid из портала и зажечь метку у постороннего.
  const stranger = userIds.find((id) => !executorIds.includes(id));
  if (stranger) {
    throw err.unprocessable('Поимённо адресовать реплику можно только исполнителю этой заявки');
  }
  return { sides, users: userIds };
}

export interface PostedChatMessage {
  message: ServiceChatMessageDto;
  lastSeq: number;
}

/**
 * Отправка реплики.
 *
 * ОТПРАВКА НЕ ТРОГАЕТ ЗАЯВКУ — ни `version`, ни `updated_at`, ни `updated_by`. Реплика не является
 * правкой заявки: подними она версию, всякая открытая форма получала бы конфликт на каждое чужое
 * сообщение, а «кто последним правил заявку» отвечало бы именем того, кто просто написал «ждём
 * запчасть». Блокировка строки при этом берётся — но только ради номера.
 *
 * НОМЕР ВЫДАЁТСЯ ПОД `FOR UPDATE` по строке заявки — той же, под которой идут остальные её мутации.
 * Уникальный индекс `(request_id, seq)` — страховка от гонки, а не основной механизм. Глобальная
 * `identity` для этого не годится: номер выдавался бы до коммита, и реплика с меньшим номером могла
 * бы стать видимой ПОСЛЕ большего — ровно та потеря, от которой уходит курсор чтения.
 *
 * РЕПЛИКА И АДРЕСАТЫ — ОДНОЙ ВЕРХНЕУРОВНЕВОЙ ТРАНЗАКЦИЕЙ. Триггер `..._same_xact` сверяет `xmin`
 * строки реплики с `pg_current_xact_id()`, а тот возвращает идентификатор ВЕРХНЕЙ транзакции:
 * строка, вставленная внутри savepoint (вложенный `tx.transaction`, блок с `EXCEPTION`), несёт в
 * `xmin` идентификатор подтранзакции, и вставка адресата будет отбита. Проверено на dev-базе.
 * Поэтому `db.transaction` здесь — не удобство, а требование схемы.
 */
export async function postChatMessage(
  p: Principal,
  requestId: string,
  input: SendServiceChatMessageInput,
): Promise<PostedChatMessage> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(serviceRequests)
      .where(eq(serviceRequests.id, requestId))
      .for('update');
    if (!row || row.deletedAt) throw err.notFound('Заявка не найдена');

    const executorIds = await executorIdsOf(tx, row.id);
    const facts = chatFactsFor(p, row, executorIds);
    if (!canWriteChat(p, facts, row.status)) {
      // Условие одно — `canWriteChat`, — а кодов отказа два, и различаются они не строгостью, а
      // тем, что человеку делать дальше. «Не участник» не изменится от повторной попытки (403), а
      // «заявка закрыта» — это состояние записи, которое читатель как раз и видит на экране (409).
      if (participantSidesOf(p, facts).length === 0) {
        throw err.forbidden('В обсуждении заявки пишут её стороны и автор');
      }
      throw err.conflict(
        `Заявка в статусе «${serviceRequestStatusLabels[row.status]}» закрыта: обсуждение только читается`,
        { code: 'chat_frozen' },
      );
    }

    const addressees = checkedAddressees(input, executorIds);
    const [seqRow] = await tx
      .select({ seq: sql<number>`COALESCE(max(${serviceRequestMessages.seq}), 0)::int` })
      .from(serviceRequestMessages)
      .where(eq(serviceRequestMessages.requestId, row.id));
    const seq = Number(seqRow?.seq ?? 0) + 1;

    // Время передаётся явно: у колонки нет `DEFAULT` — умолчание превратило бы пропущенное поле
    // перенесённой реплики в «перенесено сегодня» (§3.9).
    const createdAt = new Date();
    const [message] = await tx
      .insert(serviceRequestMessages)
      .values({
        requestId: row.id,
        seq,
        authorId: p.id,
        origin: 'chat',
        importedHash: null,
        body: input.body,
        createdAt,
      })
      .returning({ id: serviceRequestMessages.id });

    await tx.insert(serviceRequestMessageAddressees).values([
      ...addressees.sides.map((side) => ({ messageId: message!.id, side, userId: null })),
      ...addressees.users.map((userId) => ({ messageId: message!.id, side: null, userId })),
    ]);

    const names =
      addressees.users.length > 0
        ? await tx
            .select({ id: users.id, fullName: users.fullName })
            .from(users)
            .where(inArray(users.id, addressees.users))
        : [];

    return {
      message: {
        id: message!.id,
        seq,
        authorId: p.id,
        authorName: p.fullName,
        origin: 'chat',
        body: input.body,
        createdAt: createdAt.toISOString(),
        addressees: {
          sides: addressees.sides,
          users: addressees.users.map((id) => ({
            id,
            fullName: names.find((n) => n.id === id)?.fullName ?? '',
          })),
        },
      },
      lastSeq: seq,
    };
  });
}

// ── Курсор прочтения ──

/**
 * Подтверждение прочтения. `GREATEST` — чтобы параллельная вкладка не откатила курсор назад; но он
 * спасает ТОЛЬКО от движения назад, и потому границы проверяются до него.
 *
 * `throughSeq > lastSeq` — отказ 422, а не молчаливое обрезание. Клиент, приславший миллион, погасил
 * бы весь БУДУЩИЙ разговор — сообщения, которых ещё нет, — а обрезание скрыло бы ошибку клиента,
 * из-за которой человек перестал видеть новое. Ноль законен: это «не прочитано ничего».
 */
export async function markChatRead(
  p: Principal,
  requestId: string,
  throughSeq: number,
): Promise<{ readThroughSeq: number; lastSeq: number }> {
  const lastSeq = await lastSeqOf(requestId);
  if (throughSeq > lastSeq) {
    throw err.unprocessable(
      `Отметка прочтения ${throughSeq} больше последней реплики обсуждения (${lastSeq})`,
    );
  }
  const [row] = await db
    .insert(serviceRequestMessageReads)
    .values({ requestId, userId: p.id, readThroughSeq: throughSeq, readAt: new Date() })
    .onConflictDoUpdate({
      target: [serviceRequestMessageReads.requestId, serviceRequestMessageReads.userId],
      set: {
        readThroughSeq: sql`GREATEST(${serviceRequestMessageReads.readThroughSeq}, excluded.read_through_seq)`,
        readAt: new Date(),
      },
    })
    .returning({ seq: serviceRequestMessageReads.readThroughSeq });
  return { readThroughSeq: row?.seq ?? throughSeq, lastSeq };
}

/**
 * «Отметить все прочитанными» по заявкам ТЕКУЩЕГО ОТБОРА — кнопка тулбара списка (§3.4).
 *
 * Отбор, а не «всё подряд», и это не осторожность: человеку сегодня выдали набор «Ведение», у него
 * загорелись открытые заявки, — гасить он идёт то, что видит на экране. Кнопка, гасящая невидимое,
 * однажды съела бы ровно ту заявку, ради которой её и нажали.
 *
 * Одним запросом: курсор ставится на `max(seq)` каждой заявки отбора, и `GREATEST` в `ON CONFLICT`
 * держит ту же монотонность, что и одиночная отметка. Возвращается число тронутых заявок — портал
 * показывает его человеку, а «ничего не изменилось» отличается от «ручка не сработала».
 */
export async function markAllChatRead(p: Principal, scope: SQL | undefined): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO ${serviceRequestMessageReads} (request_id, user_id, read_through_seq, read_at)
    SELECT m.request_id, ${p.id}::uuid, max(m.seq), now()
      FROM ${serviceRequestMessages} m
     WHERE m.request_id IN (
       SELECT ${serviceRequests.id} FROM ${serviceRequests}
        -- Соединение с единицей техники — не украшение: отбор списка умеет фильтровать по типу
        -- оргтехники, а колонка эта живёт в справочнике. Тот же join стоит и в счётчике страницы
        -- списка, и разойтись им нельзя: кнопка обязана гасить ровно то, что человек видит.
        INNER JOIN ${officeEquipment}
           ON ${officeEquipment.id} = ${serviceRequests.officeEquipmentId}
        ${scope ? sql`WHERE ${scope}` : sql``}
     )
     GROUP BY m.request_id
    ON CONFLICT (request_id, user_id) DO UPDATE
      SET read_through_seq = GREATEST(
            ${serviceRequestMessageReads}.read_through_seq,
            excluded.read_through_seq
          ),
          read_at = now()
  `);
  return result.rowCount ?? 0;
}

// ── Адаптер совместимости: «Примечание исполнителя» (§3.10) ──

/**
 * Реплика из старой ручки `PATCH /:id/service-comment`. Живёт ровно столько, сколько работает
 * сервер выпуска A: браузер держит СТАРЫЙ бандл и после выката продолжает звать снятую ручку, —
 * поэтому написанное им обязано сразу оказаться в ленте, а не только в колонке.
 *
 * `origin = 'import'` и хеш текста — те же, что у миграционного переноса, и это условие
 * идемпотентности: повторный прогон переноса в выпуске C на ту же строку дубля не создаст, потому
 * что хеш совпадёт. Автор и время, в отличие от переноса, ЗАПИСЫВАЮТСЯ ЯВНО: у адаптера принципал
 * под рукой, и пустота там означала бы выдуманную анонимность. Пустой автор — удел только миграции,
 * где восстановить его действительно нечем.
 *
 * `md5` считает база, а не Node: перенос выпуска C возьмёт хеш от значения колонки тем же
 * `md5(service_comment)`, и посчитай мы его здесь по-своему, две редакции одного текста разошлись бы
 * на кодировке — а идемпотентность держится ровно на совпадении.
 *
 * `ON CONFLICT` ОБЯЗАН ПОВТОРЯТЬ ПРЕДИКАТ частичного индекса: без `WHERE origin = 'import'`
 * PostgreSQL индекс не выводит и падает с «no unique or exclusion constraint matching the ON
 * CONFLICT specification».
 *
 * Адресат вставляется ТОЛЬКО ПО `RETURNING`. Молчаливый `DO NOTHING` означает, что реплика с этим
 * хешем уже есть, — и вставка адресата тогда либо сослалась бы на несуществующий идентификатор,
 * либо попыталась дополнить ЧУЖУЮ, ранее созданную реплику, и справедливо отбилась бы
 * `xmin`-триггером.
 *
 * Транзакция приходит аргументом и обязана быть верхнеуровневой (`db.transaction`) — по той же
 * причине, что у обычной отправки.
 */
export async function importServiceCommentMessage(
  tx: Tx,
  actorId: string,
  requestId: string,
  text: string,
): Promise<boolean> {
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO ${serviceRequestMessages}
      (request_id, seq, author_id, origin, imported_hash, body, created_at)
    SELECT ${requestId}::uuid,
           COALESCE(
             (SELECT max(m.seq) FROM ${serviceRequestMessages} m
               WHERE m.request_id = ${requestId}::uuid),
             0
           ) + 1,
           ${actorId}::uuid, 'import', md5(${text}), ${text}, now()
    ON CONFLICT (request_id, imported_hash) WHERE origin = 'import' DO NOTHING
    RETURNING id
  `);
  const id = inserted.rows[0]?.id;
  if (!id) return false;
  // Адресат у перенесённого примечания один — «Всем участникам»: кому оно предназначалось, поле
  // никогда не знало, и выдумывать сторону задним числом значило бы приписать автору адресность,
  // которой он не выбирал.
  await tx
    .insert(serviceRequestMessageAddressees)
    .values({ messageId: id, side: 'all', userId: null });
  return true;
}
