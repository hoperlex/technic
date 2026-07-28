import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  RequestChangeDto,
  RequestHistoryEntryDto,
  RequestHistoryKind,
  RequestStatus,
} from '@technic/contracts';
import { db } from '../db/client';
import { auditLog, users } from '../db/schema';

// История заявки: кто и когда её завёл, правил и переводил по статусам (ADR 0012). Источников
// два и оба уже пишутся — история статусов своей таблицей у каждого модуля и общий аудит
// (audit_log); третья таблица была бы ещё одной точкой правды о тех же событиях. Что именно
// изменила правка, считает дифф модуля и кладёт в metadata аудита снимком.
//
// Здесь общая часть обоих модулей: выборка событий аудита (таблица одна на всех) и сборка
// хронологии. Своя у модуля только выборка истории статусов — таблицы у них разные.

/** Хвост длинной истории (правки → откаты → повторные закрытия) человеку уже не нужен. */
export const HISTORY_LIMIT = 200;

/** Строка истории статусов. Таблицы у модулей разные, набор колонок — один. */
export interface StatusEventRow {
  id: string;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus;
  comment: string;
  at: Date;
  actorId: string;
  actorName: string;
}

export interface AuditEventRow {
  id: string;
  action: string;
  metadata: unknown;
  at: Date;
  actorId: string | null;
  actorName: string | null;
}

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

/**
 * События аудита одной заявки. Смены статусов сюда не входят: они берутся из своей таблицы —
 * там есть переход и причина, а запись статуса в аудите их бы только продублировала.
 */
export async function loadAuditEvents(
  entityType: string,
  entityId: string,
  actions: readonly string[],
): Promise<AuditEventRow[]> {
  return (
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
          eq(auditLog.entityType, entityType),
          eq(auditLog.entityId, entityId),
          inArray(auditLog.action, [...actions]),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(HISTORY_LIMIT)
  );
}

/**
 * Хронология событий заявки. `created` — запасной вариант для создания: обычно оно есть в
 * истории статусов (переход «— → Новая»), но у записей, заведённых в БД помимо приложения,
 * его может не быть.
 */
export function mergeHistory(params: {
  requestId: string;
  statusRows: StatusEventRow[];
  auditRows: AuditEventRow[];
  /** Какое событие истории означает действие аудита; неизвестное считается правкой. */
  auditKinds: Record<string, RequestHistoryKind>;
  created: { at: Date; actorId: string; actorName: string };
}): RequestHistoryEntryDto[] {
  const { requestId, statusRows, auditRows, auditKinds, created } = params;
  const entries: RequestHistoryEntryDto[] = [
    ...statusRows.map((row) => ({
      id: row.id,
      // Переход «ниоткуда» — это и есть заведение заявки.
      kind: (row.fromStatus === null ? 'created' : 'status') as RequestHistoryKind,
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
      kind: auditKinds[row.action] ?? 'updated',
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
