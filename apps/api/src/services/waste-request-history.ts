import { and, desc, eq, inArray } from 'drizzle-orm';
import type { WasteRequestChangeDto, WasteRequestHistoryEntryDto } from '@technic/contracts';
import { db } from '../db/client';
import { auditLog, requestStatusHistory, users } from '../db/schema';

// История заявки: кто и когда её завёл, правил и переводил по статусам. Источников два и оба
// уже пишутся — история статусов (request_status_history) и аудит (audit_log); третья таблица
// была бы ещё одной точкой правды о тех же событиях. Что именно изменила правка, считает
// waste-request-diff и кладёт в metadata аудита снимком.

/** Хвост длинной истории (правки → откаты → повторные закрытия) человеку уже не нужен. */
const HISTORY_LIMIT = 200;

/**
 * События аудита, попадающие в историю. Смены статусов берутся из своей таблицы: там есть
 * переход и причина, а запись `waste_request.status` их бы только продублировала.
 */
const AUDIT_ACTIONS = [
  'waste_request.update',
  'waste_request.assign_operator',
  'waste_request.soft_delete',
  'waste_request.restore',
] as const;

const AUDIT_KINDS: Record<string, WasteRequestHistoryEntryDto['kind']> = {
  'waste_request.update': 'updated',
  'waste_request.assign_operator': 'operator',
  'waste_request.soft_delete': 'deleted',
  'waste_request.restore': 'restored',
};

/** Изменения из metadata аудита. Записи, сделанные до появления истории, деталей не несут. */
function changesOf(metadata: unknown): WasteRequestChangeDto[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { changes?: unknown }).changes;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is WasteRequestChangeDto =>
      !!c && typeof c === 'object' && typeof (c as WasteRequestChangeDto).field === 'string',
  );
}

/**
 * История заявки в хронологическом порядке. `created` — запасной вариант для создания заявки:
 * обычно оно есть в истории статусов (переход «— → Новая»), но у записей, заведённых в БД
 * помимо приложения, его может не быть.
 */
export async function loadWasteRequestHistory(
  requestId: string,
  created: { at: Date; actorId: string; actorName: string },
): Promise<WasteRequestHistoryEntryDto[]> {
  const [statusRows, auditRows] = await Promise.all([
    db
      .select({
        id: requestStatusHistory.id,
        fromStatus: requestStatusHistory.fromStatus,
        toStatus: requestStatusHistory.toStatus,
        comment: requestStatusHistory.comment,
        at: requestStatusHistory.changedAt,
        actorId: requestStatusHistory.changedBy,
        actorName: users.fullName,
      })
      .from(requestStatusHistory)
      .innerJoin(users, eq(requestStatusHistory.changedBy, users.id))
      .where(eq(requestStatusHistory.requestId, requestId))
      .orderBy(desc(requestStatusHistory.changedAt))
      .limit(HISTORY_LIMIT),
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        metadata: auditLog.metadata,
        at: auditLog.createdAt,
        actorId: auditLog.actorUserId,
        actorName: users.fullName,
      })
      .from(auditLog)
      // Автора аудита может уже не быть: actor_user_id обнуляется при удалении пользователя.
      .leftJoin(users, eq(auditLog.actorUserId, users.id))
      .where(
        and(
          eq(auditLog.entityType, 'waste_request'),
          eq(auditLog.entityId, requestId),
          inArray(auditLog.action, [...AUDIT_ACTIONS]),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(HISTORY_LIMIT),
  ]);

  const entries: WasteRequestHistoryEntryDto[] = [
    ...statusRows.map((row) => ({
      id: row.id,
      // Переход «ниоткуда» — это и есть заведение заявки.
      kind: (row.fromStatus === null ? 'created' : 'status') as WasteRequestHistoryEntryDto['kind'],
      at: row.at.toISOString(),
      actorId: row.actorId,
      actorName: row.actorName,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
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
      comment: '',
      changes: changesOf(row.metadata),
    })),
  ];

  // Обрезанную историю дополнять созданием нельзя: его запись просто не попала в выборку.
  if (statusRows.length < HISTORY_LIMIT && !entries.some((e) => e.kind === 'created')) {
    entries.push({
      id: `created:${requestId}`,
      kind: 'created',
      at: created.at.toISOString(),
      actorId: created.actorId,
      actorName: created.actorName,
      fromStatus: null,
      toStatus: null,
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
