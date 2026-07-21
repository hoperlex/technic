import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq } from 'drizzle-orm';
import {
  createObjectSchema,
  objectListQuerySchema,
  type ObjectDto,
  updateObjectSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { constructionObjects, type ObjectRow } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { z } from 'zod';

function toDto(r: ObjectRow): ObjectDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    address: r.address,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const idParams = z.object({ id: z.string().uuid() });

export default async function objectsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canWrite = app.requireRoles('admin', 'manager');

  // Чтение доступно всем аутентифицированным (для выбора в форме заявки).
  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: objectListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(constructionObjects.isActive, q.isActive),
        searchCondition(q.search, [
          constructionObjects.code,
          constructionObjects.name,
          constructionObjects.address,
        ]),
      );
      const sortCols = {
        code: constructionObjects.code,
        name: constructionObjects.name,
        address: constructionObjects.address,
        isActive: constructionObjects.isActive,
        createdAt: constructionObjects.createdAt,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(constructionObjects)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'name'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(constructionObjects).where(where),
      ]);
      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createObjectSchema } },
    async (req, reply) => {
      const body = req.body;
      const dup = await db
        .select({ id: constructionObjects.id })
        .from(constructionObjects)
        .where(eq(constructionObjects.code, body.code));
      if (dup.length > 0) throw err.conflict('Объект с таким кодом уже существует');
      const [created] = await db.insert(constructionObjects).values(body).returning();
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'object.create',
        entityType: 'construction_object',
        entityId: created!.id,
      });
      reply.code(201);
      return toDto(created!);
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateObjectSchema },
    },
    async (req) => {
      const { id } = req.params;
      const [updated] = await db
        .update(constructionObjects)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(constructionObjects.id, id))
        .returning();
      if (!updated) throw err.notFound('Объект не найден');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'object.update',
        entityType: 'construction_object',
        entityId: id,
      });
      return toDto(updated);
    },
  );

  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const { id } = req.params;
      // деактивация вместо удаления (объект может быть в заявках)
      const [row] = await db
        .update(constructionObjects)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(constructionObjects.id, id))
        .returning();
      if (!row) throw err.notFound('Объект не найден');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'object.deactivate',
        entityType: 'construction_object',
        entityId: id,
      });
      return toDto(row);
    },
  );
}
