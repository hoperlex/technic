import { db } from '../db/client';
import { auditLog } from '../db/schema';
import { logger } from '../logger';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/** Строка журнала из события: одна на оба способа записи — расходиться им негде. */
function auditValues(entry: AuditEntry): typeof auditLog.$inferInsert {
  return {
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata ?? {},
  };
}

/** Аудит критичных событий (§22). Не роняет основную операцию при сбое записи. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values(auditValues(entry));
  } catch (e) {
    logger.error({ err: e, action: entry.action }, 'Не удалось записать audit-лог');
  }
}

/**
 * То же событие, но **соединением транзакции и без `catch`**: сбой записи обязан откатить саму
 * операцию (ADR 0106, решение 7 — «запись, `authVersion + 1` и журнал в той же транзакции»; план
 * «полномочия в окне учётки», §5.1).
 *
 * **Почему для доступа компромисс `writeAudit` неверен.** У остального портала он осознан: запись в
 * журнал не должна ронять выписанный путевой лист — событие ценно, но операция ценнее. У доступа
 * стороны меняются местами. Доступ, изменённый без события, — это ровно то состояние, ради которого
 * реестр выдач и заведён: «сотрудник уволился, а полномочие осталось» разбирают вопросом «кто и
 * когда это выдал», и ответить на него можно только журналом. Молчаливо потерянная запись делает
 * реестр неполным не где придётся, а именно в редких случаях — то есть там, где его и читают. Отказ
 * же виден сразу: администратор повторит правку, и доступ останется прежним, а не изменится
 * втихую.
 *
 * Переводятся на строгую запись **только события доступа** (`grant.assign`, `grant.revoke`,
 * `user.create`, `user.update` в `routes/users.ts` и `routes/user-grants.ts`). Перевод всего
 * портального журнала — своя работа со своими рисками, и делать её попутно нельзя (§2 «Граница»).
 */
export async function writeAuditTx(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values(auditValues(entry));
}
