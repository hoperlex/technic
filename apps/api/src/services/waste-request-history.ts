import { desc, eq } from 'drizzle-orm';
import type { RequestHistoryEntryDto, RequestHistoryKind } from '@technic/contracts';
import { db } from '../db/client';
import { requestStatusHistory, users } from '../db/schema';
import { HISTORY_LIMIT, loadAuditEvents, mergeHistory } from './request-history';

// История заявки на вывоз (ADR 0012). Общая часть — в request-history.ts; здесь только своя
// таблица переходов и перечень событий аудита этого модуля.

/**
 * События аудита, попадающие в историю. Смены статусов берутся из своей таблицы: там есть
 * переход и причина, а запись `waste_request.status` их бы только продублировала.
 */
const AUDIT_ACTIONS = [
  'waste_request.update',
  'waste_request.assign_operator',
  // Примечание исполнителя (ADR 0053): своей ручкой, но в истории — обычная правка заявки, и
  // чью строку правили, называет состав изменений.
  'waste_request.operator_comment',
  // Факт вывоза (ADR 0035): своё событие рядом с переходом в «Выполнена» — объём и сумма
  // предъявляются составом изменений, а не одной отметкой о статусе.
  'waste_request.complete',
  'waste_request.soft_delete',
  'waste_request.restore',
] as const;

const AUDIT_KINDS: Record<string, RequestHistoryKind> = {
  'waste_request.update': 'updated',
  'waste_request.assign_operator': 'operator',
  'waste_request.operator_comment': 'updated',
  'waste_request.complete': 'completed',
  'waste_request.soft_delete': 'deleted',
  'waste_request.restore': 'restored',
};

/**
 * История заявки в хронологическом порядке. `created` — запасной вариант для создания заявки:
 * обычно оно есть в истории статусов (переход «— → Новая»), но у записей, заведённых в БД
 * помимо приложения, его может не быть.
 */
export async function loadWasteRequestHistory(
  requestId: string,
  created: { at: Date; actorId: string; actorName: string },
): Promise<RequestHistoryEntryDto[]> {
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
    loadAuditEvents('waste_request', requestId, AUDIT_ACTIONS),
  ]);

  return mergeHistory({ requestId, statusRows, auditRows, auditKinds: AUDIT_KINDS, created });
}
