import { desc, eq, inArray } from 'drizzle-orm';
import {
  serviceChatSideLabels,
  type RequestChangeDto,
  type RequestHistoryEntryDto,
  type RequestHistoryKind,
  type ServiceChatSide,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  serviceRequestMessageAddressees,
  serviceRequestMessages,
  serviceRequestStatusHistory,
  users,
} from '../db/schema';
import { HISTORY_LIMIT, loadAuditEvents } from './request-history';
import { short } from './request-diff';

// История заявки на обслуживание оргтехники (ADR 0012, ADR 0085). Источников три, и все три уже
// пишутся своими таблицами: переходы статусов (там есть переход, причина и ревизия сметы), общий
// аудит (что именно изменила правка — снимком в metadata) и лента обсуждения (ADR 0141). Своей
// таблицы у истории нет по той же причине, что у двух действующих модулей: она была бы ещё одной
// точкой правды о тех же событиях.
//
// Реплику аудит не пишет и писать не должен: событие уже хранится таблицей ленты — с автором,
// временем и текстом, — и вторая его копия расходилась бы с первой ровно тогда, когда на переписку
// сошлются в споре.

/**
 * Событие истории этого модуля.
 *
 * Свой тип, а не общий `RequestHistoryEntryDto`, по двум причинам, и обе — про содержание, а не
 * про удобство. У модуля собственный перечень статусов (ADR 0085 §5), тогда как в общем типе они
 * объявлены статусами «Вывоза мусора» и «Заказа ТС». И у события есть ревизия сметы: по истории
 * должно читаться, что именно согласовали, — без неё два согласования подряд выглядят одинаково.
 */
export interface ServiceRequestHistoryEntryDto extends Omit<
  RequestHistoryEntryDto,
  'fromStatus' | 'toStatus'
> {
  fromStatus: ServiceRequestStatus | null;
  toStatus: ServiceRequestStatus | null;
  /** Ревизия сметы на момент события; `null` — событие не про смету. */
  estimateRevision: number | null;
}

/**
 * События аудита, попадающие в историю. Смены статусов сюда не входят: они берутся из своей
 * таблицы, а запись «статус изменён» их бы только продублировала.
 *
 * Свои у модуля те события, за которыми стоит решение или содержание: кого позвали чинить и кого
 * позвали вместо него, почему исполнитель отказался, какую ревизию сметы предъявили и какую
 * согласовали, что в итоге не поставили и какие бумаги подшили. Переход отвечает «что с заявкой»,
 * эти события — «что именно решили и на каких цифрах».
 *
 * Взятия в диагностику здесь нет намеренно: у него нет содержания сверх самого перехода, и строка
 * в аудите повторила бы строку истории статусов слово в слово.
 */
const AUDIT_ACTIONS = [
  'serviceRequest.update',
  'serviceRequest.estimate_update',
  'serviceRequest.it_approve',
  'serviceRequest.it_reject',
  'serviceRequest.assign',
  'serviceRequest.reassign',
  'serviceRequest.decline',
  'serviceRequest.estimate_submit',
  'serviceRequest.estimate_approve',
  'serviceRequest.estimate_reject',
  'serviceRequest.estimate_reopen',
  'serviceRequest.consumables_update',
  'serviceRequest.consumables_issued',
  'serviceRequest.complete',
  'serviceRequest.accept',
  'serviceRequest.rework',
  'serviceRequest.service_comment',
  'serviceRequest.urgency',
  'serviceRequest.files_attach',
  'serviceRequest.files_detach',
  'serviceRequest.soft_delete',
  'serviceRequest.restore',
] as const;

const AUDIT_KINDS: Record<string, RequestHistoryKind> = {
  'serviceRequest.update': 'updated',
  // Правка сметы — тоже правка, но своя: её ведёт исполнитель, а заявку правит заказчик.
  // Различает их не вид события, а перечень изменений (`diffServiceEstimate`).
  'serviceRequest.estimate_update': 'updated',
  // Виза ИТ (Р51): согласие и отказ читаются разными событиями — «решение ИТ» одним словом не
  // отвечает, чем кончилось.
  'serviceRequest.it_approve': 'itApproved',
  'serviceRequest.it_reject': 'itRejected',
  'serviceRequest.assign': 'serviceAssigned',
  'serviceRequest.reassign': 'serviceReassigned',
  'serviceRequest.decline': 'serviceDeclined',
  'serviceRequest.estimate_submit': 'estimateSubmitted',
  'serviceRequest.estimate_approve': 'estimateApproved',
  'serviceRequest.estimate_reject': 'estimateRejected',
  'serviceRequest.estimate_reopen': 'estimateReopened',
  // Правка состава номенклатуры — обычная правка заявки: до первой выдачи это ещё список
  // пожеланий, и своего вида события он не заслуживает. А вот содержание у него своё, и берётся
  // оно не из `changes` (их у этого действия нет), а из снимков состава — см. `changesOf`.
  'serviceRequest.consumables_update': 'updated',
  // Отметка факта выдачи — своё событие: с него заявка перестаёт быть просьбой и становится
  // основанием записи на складе. «Правка» в этом месте истории умолчала бы о том, что со склада
  // ушли картриджи.
  'serviceRequest.consumables_issued': 'consumablesIssued',
  'serviceRequest.complete': 'completed',
  'serviceRequest.accept': 'accepted',
  'serviceRequest.rework': 'returnedToWork',
  'serviceRequest.service_comment': 'updated',
  // Срочность — своё событие, а не правка: её ставят и снимают тогда, когда сама заявка уже не
  // правится, и «Правка» в этом месте истории читалась бы как смена предмета заявки у сервиса.
  'serviceRequest.urgency': 'urgencyChanged',
  'serviceRequest.files_attach': 'documentAttached',
  // Снятие документа — не подшивка: вид события у него общий («изменено»), а что именно сняли,
  // видно в перечне изменений.
  'serviceRequest.files_detach': 'updated',
  'serviceRequest.soft_delete': 'deleted',
  'serviceRequest.restore': 'restored',
};

/** Изменения из metadata аудита. Записи, сделанные до появления истории, деталей не несут. */
function fieldChangesOf(metadata: unknown): RequestChangeDto[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { changes?: unknown }).changes;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is RequestChangeDto =>
      !!c && typeof c === 'object' && typeof (c as RequestChangeDto).field === 'string',
  );
}

/** Позиция с количеством — так её читают и в движении склада, и в снимке состава заявки. */
function position(name: unknown, quantity: unknown): string | null {
  if (typeof name !== 'string' || typeof quantity !== 'number') return null;
  return `${name} — ${quantity} шт`;
}

function arrayOf(metadata: unknown, key: string): unknown[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw : [];
}

/**
 * Движение склада строками истории: «Списано со склада: Тонер Ricoh 201 — 2 шт» (Р10).
 *
 * Отдельно от `changes`, потому что это и есть отдельная вещь: `changes` отвечают «какие поля
 * заявки поменялись», а склад двигает не поле, а отметка факта выдачи, и пишут её два действия —
 * правка факта и закрытие работ. Из аудита они приезжают полем `movements`, и оба разбираются
 * здесь одной функцией: два разбора одного снимка разошлись бы на первой же правке формата.
 *
 * Возврат — своей подписью, а не отрицательным числом: «−2» в ленте истории читается как опечатка,
 * а «Возвращено на склад» отвечает на вопрос, ради которого строку и ищут.
 *
 * Записи, сделанные до этого выпуска, поля не несут вовсе — тогда движений просто нет, и событие
 * остаётся в истории самим собой.
 */
function movementChangesOf(metadata: unknown): RequestChangeDto[] {
  const changes: RequestChangeDto[] = [];
  for (const raw of arrayOf(metadata, 'movements')) {
    if (!raw || typeof raw !== 'object') continue;
    const movement = raw as Record<string, unknown>;
    const text = position(movement.name, movement.quantity);
    if (!text) continue;
    changes.push({
      field: movement.entryKind === 'return' ? 'consumablesReturned' : 'consumablesIssued',
      // «Было» у движения нет: событие не меняет значение поля, а называет случившийся факт —
      // стрелка из пустоты в такой строке только мешает (`ChangeLines` на портале).
      from: null,
      to: text,
    });
  }
  return changes;
}

/**
 * Правка состава номенклатуры — одной строкой «было → стало», а не перечнем добавленных и убранных.
 *
 * Состав заменяется целиком одной ручкой (`PUT /:id/consumables`), и аудит хранит два снимка, а не
 * разницу: спорят здесь не о том, какую строку тронули, а о том, что именно просили и в каком
 * количестве. Собрать разницу из снимков можно, но читалась бы она хуже — «убрали 2, добавили 3»
 * вместо самого списка.
 */
function compositionChangesOf(metadata: unknown): RequestChangeDto[] {
  const listOf = (key: string): string | null => {
    const rows = arrayOf(metadata, key);
    if (rows.length === 0) return null;
    const texts = rows
      .map((row) =>
        row && typeof row === 'object'
          ? position(
              (row as Record<string, unknown>).name,
              (row as Record<string, unknown>).requestedQuantity,
            )
          : null,
      )
      .filter((text): text is string => text !== null);
    return texts.length > 0 ? texts.join('; ') : null;
  };
  const before = listOf('before');
  const after = listOf('after');
  // Пустая заявка с обеих сторон — это не правка состава, а запись, у которой снимков не оказалось
  // (аудит прошлых выпусков): строка «— → —» не сказала бы читателю ничего.
  if (before === null && after === null) return [];
  return [{ field: 'consumables', from: before ?? '—', to: after ?? '—' }];
}

/**
 * Всё содержание события одним списком: поля заявки, движение склада и состав номенклатуры.
 *
 * Собрано в одном месте намеренно: перечень изменений показывается человеку одной колонкой, и
 * решать, что в неё попадёт, обязана одна функция, а не три вызова, разложенные по веткам.
 *
 * Состав спрашивается **по действию**, а не по наличию полей: `before`/`after` — имена настолько
 * общие, что первое же чужое событие с такой парой снимков молча приехало бы в историю подписью
 * «Состав номенклатуры». Движения так не гадают: поле `movements` пишут два действия, и оба —
 * ровно про склад.
 */
function changesOf(action: string, metadata: unknown): RequestChangeDto[] {
  return [
    ...fieldChangesOf(metadata),
    ...movementChangesOf(metadata),
    ...(action === 'serviceRequest.consumables_update' ? compositionChangesOf(metadata) : []),
  ];
}

/** Ревизия сметы из metadata: её кладут события сметы — предъявление, согласование, отклонение. */
function revisionOf(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as { revision?: unknown }).revision;
  return typeof raw === 'number' ? raw : null;
}

/**
 * Реплики обсуждения — третий источник истории (ADR 0141, §3.8).
 *
 * Живёт по правилам первых двух: свой `.limit(HISTORY_LIMIT)`, и только потом общий список
 * сортируется и режется тем же числом. Без этого длинная переписка вернула бы историю к
 * неограниченной выдаче — той самой болезни, от которой саму ленту лечит постраничность.
 *
 * Берутся ПОСЛЕДНИЕ реплики (`desc` плюс лимит), а не первые: история отвечает на вопрос «что
 * происходило недавно», и обрезать её с конца значило бы показывать самое старое.
 *
 * Сортировка по `created_at`, а не по `seq`, — и индекс `(request_id, created_at)` заведён ровно под
 * это. Порядок по номеру здесь не годится: у перенесённых реплик время приблизительное (§3.9) и с
 * номером не согласовано, а общий список всё равно сшивается по времени с двумя другими
 * источниками.
 */
async function loadChatEvents(requestId: string): Promise<ServiceRequestHistoryEntryDto[]> {
  const rows = await db
    .select({
      id: serviceRequestMessages.id,
      body: serviceRequestMessages.body,
      at: serviceRequestMessages.createdAt,
      actorId: serviceRequestMessages.authorId,
      actorName: users.fullName,
    })
    .from(serviceRequestMessages)
    .leftJoin(users, eq(serviceRequestMessages.authorId, users.id))
    .where(eq(serviceRequestMessages.requestId, requestId))
    .orderBy(desc(serviceRequestMessages.createdAt))
    .limit(HISTORY_LIMIT);
  if (rows.length === 0) return [];

  // Адресаты — второй выборкой по идентификаторам уже отобранных реплик: соединением они размножили
  // бы строку события на две-три (у реплики адресатов несколько), и история показала бы одно
  // сообщение трижды.
  const addressees = await db
    .select({
      messageId: serviceRequestMessageAddressees.messageId,
      side: serviceRequestMessageAddressees.side,
      fullName: users.fullName,
    })
    .from(serviceRequestMessageAddressees)
    .leftJoin(users, eq(serviceRequestMessageAddressees.userId, users.id))
    .where(
      inArray(
        serviceRequestMessageAddressees.messageId,
        rows.map((row) => row.id),
      ),
    );
  const targets = new Map<string, string[]>();
  for (const row of addressees) {
    const list = targets.get(row.messageId) ?? [];
    // Поимённый адресат — с пометкой «лично» и ИМЕНЕМ КАК ЕСТЬ, без склонения: у сторон ярлык
    // словарный и уже в дательном падеже, а фамилию портал склонять не умеет — и не должен.
    // Неправильно просклонённая фамилия в истории, на которую ссылаются в споре, хуже именительной.
    list.push(row.side ? sideTarget(row.side) : `лично ${row.fullName ?? ''}`);
    targets.set(row.messageId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    kind: 'chatMessage' as RequestHistoryKind,
    at: row.at.toISOString(),
    actorId: row.actorId,
    // Пусто у перенесённых из примечания: автора там не восстановить, и подставлять «кого-нибудь»
    // хуже, чем промолчать.
    actorName: row.actorName,
    fromStatus: null,
    toStatus: null,
    estimateRevision: null,
    // Строка события целиком: «сообщение сервисному центру: „ждём запчасть“». Кому и что — вместе,
    // потому что вместе они и читаются; `changes` тут нечем заполнить — у реплики нет «было».
    comment: `сообщение ${(targets.get(row.id) ?? []).join(', ') || 'без адресата'}: «${short(
      row.body,
    )}»`,
    changes: [],
  }));
}

/** Ярлык стороны в дательном падеже — тот же, что рисует лента: «Сервисному центру» → строчными. */
function sideTarget(side: ServiceChatSide): string {
  const label = serviceChatSideLabels[side];
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * История заявки в хронологическом порядке. `created` — запасной вариант для заведения заявки:
 * обычно оно есть в истории статусов (переход «— → Новая»), но у записей, заведённых в БД помимо
 * приложения, его может не быть.
 */
export async function loadServiceRequestHistory(
  requestId: string,
  created: { at: Date; actorId: string; actorName: string },
): Promise<ServiceRequestHistoryEntryDto[]> {
  const [statusRows, auditRows, chatRows] = await Promise.all([
    db
      .select({
        id: serviceRequestStatusHistory.id,
        fromStatus: serviceRequestStatusHistory.fromStatus,
        toStatus: serviceRequestStatusHistory.toStatus,
        estimateRevision: serviceRequestStatusHistory.estimateRevision,
        comment: serviceRequestStatusHistory.comment,
        at: serviceRequestStatusHistory.changedAt,
        actorId: serviceRequestStatusHistory.changedBy,
        actorName: users.fullName,
      })
      .from(serviceRequestStatusHistory)
      .innerJoin(users, eq(serviceRequestStatusHistory.changedBy, users.id))
      .where(eq(serviceRequestStatusHistory.requestId, requestId))
      .orderBy(desc(serviceRequestStatusHistory.changedAt))
      .limit(HISTORY_LIMIT),
    loadAuditEvents('serviceRequest', requestId, AUDIT_ACTIONS),
    loadChatEvents(requestId),
  ]);

  const entries: ServiceRequestHistoryEntryDto[] = [
    ...statusRows.map((row) => ({
      id: row.id,
      // Переход «ниоткуда» — это и есть заведение заявки.
      kind: (row.fromStatus === null ? 'created' : 'status') as RequestHistoryKind,
      at: row.at.toISOString(),
      actorId: row.actorId,
      actorName: row.actorName,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      estimateRevision: row.estimateRevision,
      comment: row.comment,
      changes: [],
    })),
    ...auditRows.map((row) => ({
      id: row.id,
      kind: AUDIT_KINDS[row.action] ?? 'updated',
      at: row.at.toISOString(),
      actorId: row.actorId,
      actorName: row.actorName,
      fromStatus: null,
      toStatus: null,
      estimateRevision: revisionOf(row.metadata),
      comment: '',
      changes: changesOf(row.action, row.metadata),
    })),
    ...chatRows,
  ];

  // Обрезанную историю дополнять заведением нельзя: его запись просто не попала в выборку.
  if (statusRows.length < HISTORY_LIMIT && !entries.some((e) => e.kind === 'created')) {
    entries.push({
      id: `created:${requestId}`,
      kind: 'created',
      at: created.at.toISOString(),
      actorId: created.actorId,
      actorName: created.actorName,
      fromStatus: null,
      toStatus: null,
      estimateRevision: null,
      comment: '',
      changes: [],
    });
  }

  // Свежие события отбираются первыми, а показываются в порядке, в котором происходили.
  return entries
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, HISTORY_LIMIT)
    .reverse();
}
