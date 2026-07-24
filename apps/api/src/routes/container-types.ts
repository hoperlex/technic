import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import {
  containerTypeListQuerySchema,
  type ContainerTypeDto,
  createContainerTypeSchema,
  updateContainerTypeSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { containerTypes, type ContainerTypeRow } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

function toDto(r: ContainerTypeRow): ContainerTypeDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const idParams = z.object({ id: z.string().uuid() });

export default async function containerTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canWrite = app.requireRoles('admin', 'manager');

  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: containerTypeListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(containerTypes.isActive, q.isActive),
        q.type ? eq(containerTypes.type, q.type) : undefined,
        searchCondition(q.search, [containerTypes.code, containerTypes.name]),
      );
      const sortCols = {
        code: containerTypes.code,
        name: containerTypes.name,
        type: containerTypes.type,
        sortOrder: containerTypes.sortOrder,
        isActive: containerTypes.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(containerTypes)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(containerTypes).where(where),
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
    { preHandler: [app.authenticate, canWrite], schema: { body: createContainerTypeSchema } },
    async (req, reply) => {
      const dup = await db
        .select({ id: containerTypes.id })
        .from(containerTypes)
        .where(eq(containerTypes.code, req.body.code));
      if (dup.length > 0) throw err.conflict('Тип с таким кодом уже существует');
      const [created] = await db.insert(containerTypes).values(req.body).returning();
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'container_type.create',
        entityType: 'container_type',
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
      schema: { params: idParams, body: updateContainerTypeSchema },
    },
    async (req) => {
      const [updated] = await db
        .update(containerTypes)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(containerTypes.id, req.params.id))
        .returning();
      if (!updated) throw err.notFound('Тип контейнера не найден');
      // Удаления нет: деактивация — через isActive=false (единый принцип со справочником ТС).
      const action =
        req.body.isActive === false
          ? 'container_type.deactivate'
          : req.body.isActive === true
            ? 'container_type.activate'
            : 'container_type.update';
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action,
        entityType: 'container_type',
        entityId: req.params.id,
      });
      return toDto(updated);
    },
  );
}
