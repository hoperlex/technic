import { db } from '../db/client';
import { auditLog } from '../db/schema';
import { logger } from '../logger';

export interface AuditEntry {
  actorUserId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/** Аудит критичных событий (§22). Не роняет основную операцию при сбое записи. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: entry.metadata ?? {},
    });
  } catch (e) {
    logger.error({ err: e, action: entry.action }, 'Не удалось записать audit-лог');
  }
}
