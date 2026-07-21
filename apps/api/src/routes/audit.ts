import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, desc, eq } from 'drizzle-orm';
import { baseListQuery } from '@technic/contracts';
import { db } from '../db/client';
import { auditLog, users } from '../db/schema';
import { searchCondition } from '../lib/pagination';
import { pageParams } from '../lib/pagination';

const auditQuerySchema = baseListQuery(['createdAt', 'action']).extend({
  action: z.string().max(100).optional(),
});

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = { preHandler: [app.authenticate, app.requireRoles('admin')] };

  r.get('/', { ...guards, schema: { querystring: auditQuerySchema } }, async (req) => {
    const q = req.query;
    const where = and(
      q.action ? eq(auditLog.action, q.action) : undefined,
      searchCondition(q.search, [auditLog.action, auditLog.entityType, auditLog.entityId]),
    );
    const p = pageParams(q);
    const [rows, totalRow] = await Promise.all([
      db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          actorUserId: auditLog.actorUserId,
          actorName: users.fullName,
          metadata: auditLog.metadata,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .leftJoin(users, eq(auditLog.actorUserId, users.id))
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(p.limit)
        .offset(p.offset),
      db.select({ c: count() }).from(auditLog).where(where),
    ]);
    return {
      items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      total: Number(totalRow[0]!.c),
      page: p.page,
      pageSize: p.pageSize,
    };
  });
}
