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
 * Исполнителя-контрагента у заявок на технику не назначают — события `assign_operator` здесь нет.
 * Своё у модуля другое: виза руководителя строительства (ADR 0025), решающая, пойдёт ли заявка
 * в работу, назначение конкретной машины со ставками (ADR 0027), с которого работа начинается,
 * и предъявленный при закрытии факт (ADR 0029), которым она заканчивается.
 */
const AUDIT_ACTIONS = [
  'vehicle_request.update',
  // Переоформление в другой тип (ADR 0091): у заявки сменился не набор значений, а набор полей, и
  // «правкой» это читаться не должно — по такому событию потом и объясняют, куда делся срок работ.
  'vehicle_request.change_type',
  'vehicle_request.approve',
  'vehicle_request.approval_revoke',
  'vehicle_request.assign',
  'vehicle_request.complete',
  // Досрочное завершение (ADR 0044) — четырьмя действиями: сокращение срока проходит через визу,
  // и «попросили», «согласовали», «отказали», «сняли» это разные ответы на вопрос, почему техника
  // уехала (или не уехала) раньше заказанного.
  'vehicle_request.early_end_request',
  'vehicle_request.early_end_approve',
  'vehicle_request.early_end_reject',
  'vehicle_request.early_end_cancel',
  // Продление срока недельной заявкой (ADR 0085): срок двигает виза руководителя строительства
  // под пакетом, а не правка заказа, и в истории это должно читаться номером пакета.
  'vehicle_request.weekly_extend',
  // Подтверждение смены объектом и снятие подписи: «кто принял 11,5 машиночаса за 12 августа» —
  // вопрос, который задают при разборе счёта через два месяца, и отвечать на него должна история,
  // а не текущее состояние строки. Заполнение часов события не пишет: это черновик данных.
  'vehicle_request.shift_approve',
  'vehicle_request.shift_revoke',
  'vehicle_request.soft_delete',
  'vehicle_request.restore',
] as const;

const AUDIT_KINDS: Record<string, RequestHistoryKind> = {
  'vehicle_request.update': 'updated',
  'vehicle_request.change_type': 'typeChanged',
  'vehicle_request.approve': 'approved',
  'vehicle_request.approval_revoke': 'approvalRevoked',
  // Назначение техники (ADR 0027) идёт вместе с переводом в работу, но событием остаётся своим:
  // переход отвечает «что с заявкой», назначение — «чем и почём».
  'vehicle_request.assign': 'assigned',
  // Факт выполнения (ADR 0029) — тем же приёмом: «Выполнена» отвечает «что с заявкой»,
  // закрытие — «сколько отработали и сколько это стоило».
  'vehicle_request.complete': 'completed',
  'vehicle_request.early_end_request': 'earlyEndRequested',
  'vehicle_request.early_end_approve': 'earlyEndApproved',
  'vehicle_request.early_end_reject': 'earlyEndRejected',
  // Снятие запроса — не отказ: его снимает правка срока, закрытие заявки или сам инициатор,
  // и решения по существу за ним не стоит.
  'vehicle_request.early_end_cancel': 'earlyEndCancelled',
  'vehicle_request.weekly_extend': 'weeklyExtended',
  'vehicle_request.shift_approve': 'shiftApproved',
  'vehicle_request.shift_revoke': 'shiftApprovalRevoked',
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
