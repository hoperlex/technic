import { writeAuditTx } from '../lib/audit';
import { ASSIGNMENT_LEGACY_PERIOD_ACTION } from './assignment-legacy-calls';
import type { AssignmentWriteTx } from './assignment-write';

/**
 * Запись клиентского гейта (И5) — половина, которой нужен журнал.
 *
 * Отдельным файлом от счётчика намеренно: журнал тянет прикладной пул, а считать гейт обязаны в том
 * числе сводка готовности и команда аттестации — они ходят административным путём и запускаются
 * тогда, когда портал заморожен. Свести обе половины в один модуль значило бы требовать прикладной
 * конфиг от команд, которые как раз и работают без него.
 */
/**
 * Записать факт: срок правили старым маршрутом.
 *
 * Пишется **в транзакции двери** (`writeAuditTx`): откатилась правка — не осталось и записи, иначе
 * гейт держали бы вызовы, ничего не изменившие.
 */
export async function noteLegacyPeriodCall(
  tx: AssignmentWriteTx,
  params: {
    actor: { id: string };
    requestId: string;
    before: { dateFrom: string; dateTo: string | null };
    after: { dateFrom: string; dateTo: string | null };
  },
): Promise<void> {
  await writeAuditTx(tx, {
    actorUserId: params.actor.id,
    action: ASSIGNMENT_LEGACY_PERIOD_ACTION,
    entityType: 'vehicle_request',
    entityId: params.requestId,
    metadata: {
      door: 'vehicle-requests/patch',
      before: params.before,
      after: params.after,
    },
  });
}


