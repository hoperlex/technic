import { desc, eq } from 'drizzle-orm';
import type {
  RequestChangeDto,
  RequestHistoryEntryDto,
  RequestHistoryKind,
  ServiceRequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import { serviceRequestStatusHistory, users } from '../db/schema';
import { HISTORY_LIMIT, loadAuditEvents } from './request-history';

// История заявки на обслуживание оргтехники (ADR 0012, ADR 0085). Источников два, и оба уже
// пишутся: своя таблица переходов (там есть переход, причина и ревизия сметы) и общий аудит
// (что именно изменила правка — снимком в metadata). Третьей таблицы нет по той же причине, что
// у двух действующих модулей: она была бы ещё одной точкой правды о тех же событиях.

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
function changesOf(metadata: unknown): RequestChangeDto[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { changes?: unknown }).changes;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is RequestChangeDto =>
      !!c && typeof c === 'object' && typeof (c as RequestChangeDto).field === 'string',
  );
}

/** Ревизия сметы из metadata: её кладут события сметы — предъявление, согласование, отклонение. */
function revisionOf(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as { revision?: unknown }).revision;
  return typeof raw === 'number' ? raw : null;
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
  const [statusRows, auditRows] = await Promise.all([
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
      changes: changesOf(row.metadata),
    })),
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
