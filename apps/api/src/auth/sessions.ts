import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db/client';
import { refreshSessions } from '../db/schema';
import { err } from '../lib/errors';
import { randomToken, sha256hex } from '../lib/crypto';

export interface IssuedRefresh {
  token: string;
  sessionId: string;
  familyId: string;
  expiresAt: Date;
}

export async function createRefreshSession(
  userId: string,
  ctx: { familyId?: string; ip?: string; userAgent?: string } = {},
): Promise<IssuedRefresh> {
  const token = randomToken(32);
  const tokenHash = sha256hex(token);
  const familyId = ctx.familyId ?? randomUUID();
  const expiresAt = new Date(Date.now() + config.auth.refreshTtl * 1000);
  const [row] = await db
    .insert(refreshSessions)
    .values({ userId, tokenHash, familyId, expiresAt, ip: ctx.ip, userAgent: ctx.userAgent })
    .returning({ id: refreshSessions.id });
  return { token, sessionId: row!.id, familyId, expiresAt };
}

export interface RotationResult {
  token: string;
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Ротация refresh-токена с детекцией повторного использования:
 * если предъявлен уже отозванный токен — отзываем всю семью сессий (§13).
 */
export async function rotateRefreshSession(
  rawToken: string,
  ctx: { ip?: string; userAgent?: string } = {},
): Promise<RotationResult> {
  const tokenHash = sha256hex(rawToken);
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(refreshSessions)
      .where(eq(refreshSessions.tokenHash, tokenHash))
      .for('update');

    if (!session) throw err.unauthorized('Недействительный refresh-токен');

    if (session.revokedAt) {
      // reuse detected — компрометация: отзываем всю семью
      await tx
        .update(refreshSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(refreshSessions.familyId, session.familyId), isNull(refreshSessions.revokedAt)),
        );
      throw err.unauthorized('Повторное использование refresh-токена — сессии отозваны');
    }

    if (session.expiresAt.getTime() < Date.now()) {
      throw err.unauthorized('refresh-токен истёк');
    }

    const newToken = randomToken(32);
    const newHash = sha256hex(newToken);
    const expiresAt = new Date(Date.now() + config.auth.refreshTtl * 1000);
    const [next] = await tx
      .insert(refreshSessions)
      .values({
        userId: session.userId,
        tokenHash: newHash,
        familyId: session.familyId,
        expiresAt,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      .returning({ id: refreshSessions.id });
    await tx
      .update(refreshSessions)
      .set({ revokedAt: new Date(), replacedBy: next!.id })
      .where(eq(refreshSessions.id, session.id));

    return { token: newToken, sessionId: next!.id, userId: session.userId, expiresAt };
  });
}

export async function revokeRefreshByToken(rawToken: string): Promise<void> {
  const tokenHash = sha256hex(rawToken);
  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshSessions.tokenHash, tokenHash), isNull(refreshSessions.revokedAt)));
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await db
    .update(refreshSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshSessions.userId, userId), isNull(refreshSessions.revokedAt)));
}
