import { desc, eq } from 'drizzle-orm';
import type { RequestHistoryEntryDto, RequestHistoryKind } from '@technic/contracts';
import { db } from '../db/client';
import { users, vehicleRequestStatusHistory } from '../db/schema';
import { HISTORY_LIMIT, loadAuditEvents, mergeHistory } from './request-history';

// История заявки на технику (ADR 0015). Общая часть — в request-history.ts; здесь только своя
// таблица переходов и перечень событий аудита этого модуля.

/**
 * События аудита, попадающие в историю. Смены статусов берутся из своей таблицы: там есть
 * переход и причина, а запись `vehicle_request.status` их бы только продублировала.
 * Исполнитель у заявок на технику не назначается — события `assign_operator` здесь нет.
 */
const AUDIT_ACTIONS = [
  'vehicle_request.update',
  'vehicle_request.soft_delete',
  'vehicle_request.restore',
] as const;

const AUDIT_KINDS: Record<string, RequestHistoryKind> = {
  'vehicle_request.update': 'updated',
  'vehicle_request.soft_delete': 'deleted',
  'vehicle_request.restore': 'restored',
};

/**
 * История заявки в хронологическом порядке. `created` — запасной вариант для создания заявки:
 * обычно оно есть в истории статусов (переход «— → Новая»), но у записей, заведённых в БД
 * помимо приложения, его может не быть.
 */
export async function loadVehicleRequestHistory(
  requestId: string,
  created: { at: Date; actorId: string; actorName: string },
): Promise<RequestHistoryEntryDto[]> {
  const [statusRows, auditRows] = await Promise.all([
    db
      .select({
        id: vehicleRequestStatusHistory.id,
        fromStatus: vehicleRequestStatusHistory.fromStatus,
        toStatus: vehicleRequestStatusHistory.toStatus,
        comment: vehicleRequestStatusHistory.comment,
        at: vehicleRequestStatusHistory.changedAt,
        actorId: vehicleRequestStatusHistory.changedBy,
        actorName: users.fullName,
      })
      .from(vehicleRequestStatusHistory)
      .innerJoin(users, eq(vehicleRequestStatusHistory.changedBy, users.id))
      .where(eq(vehicleRequestStatusHistory.vehicleRequestId, requestId))
      .orderBy(desc(vehicleRequestStatusHistory.changedAt))
      .limit(HISTORY_LIMIT),
    loadAuditEvents('vehicle_request', requestId, AUDIT_ACTIONS),
  ]);

  return mergeHistory({ requestId, statusRows, auditRows, auditKinds: AUDIT_KINDS, created });
}
