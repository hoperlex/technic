import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import {
  type ContainerDto,
  containerListQuerySchema,
  createContainerSchema,
  updateContainerSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { constructionObjects, containerTypes, containers } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

const containerSelect = {
  id: containers.id,
  objectId: containers.objectId,
  containerTypeId: containers.containerTypeId,
  containerTypeName: containerTypes.name,
  label: containers.label,
  isActive: containers.isActive,
  createdAt: containers.createdAt,
  updatedAt: containers.updatedAt,
};

type ContainerJoinRow = {
  id: string;
  objectId: string;
  containerTypeId: string;
  containerTypeName: string;
  label: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(r: ContainerJoinRow): ContainerDto {
  return {
    id: r.id,
    objectId: r.objectId,
    containerTypeId: r.containerTypeId,
    containerTypeName: r.containerTypeName,
    label: r.label,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function baseQuery() {
  return db
    .select(containerSelect)
    .from(containers)
    .innerJoin(containerTypes, eq(containers.containerTypeId, containerTypes.id));
}

const idParams = z.object({ id: z.string().uuid() });

async function getContainerDto(id: string): Promise<ContainerDto | null> {
  const [row] = await baseQuery().where(eq(containers.id, id));
  return row ? toDto(row) : null;
}

export default async function containersRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canWrite = app.requireRoles('admin', 'manager');

  // Чтение доступно всем аутентифицированным (для формы заявки).
  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: containerListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.objectId ? eq(containers.objectId, q.objectId) : undefined,
        q.isActive === undefined ? undefined : eq(containers.isActive, q.isActive),
        searchCondition(q.search, [containers.label, containerTypes.name]),
      );
      const sortCols = {
        label: containers.label,
        containerTypeName: containerTypes.name,
        isActive: containers.isActive,
        createdAt: containers.createdAt,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        baseQuery()
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
          .limit(p.limit)
          .offset(p.offset),
        db
          .select({ c: count() })
          .from(containers)
          .innerJoin(containerTypes, eq(containers.containerTypeId, containerTypes.id))
          .where(where),
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
    { preHandler: [app.authenticate, canWrite], schema: { body: createContainerSchema } },
    async (req, reply) => {
      const { objectId, containerTypeId } = req.body;
      const [obj] = await db
        .select({ id: constructionObjects.id })
        .from(constructionObjects)
        .where(eq(constructionObjects.id, objectId));
      if (!obj) throw err.badRequest('Объект не найден');
      const [ct] = await db
        .select({ id: containerTypes.id })
        .from(containerTypes)
        .where(eq(containerTypes.id, containerTypeId));
      if (!ct) throw err.badRequest('Тип контейнера не найден');
      const [created] = await db.insert(containers).values(req.body).returning({ id: containers.id });
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'container.create',
        entityType: 'container',
        entityId: created!.id,
      });
      reply.code(201);
      return (await getContainerDto(created!.id))!;
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateContainerSchema },
    },
    async (req) => {
      if (req.body.containerTypeId) {
        const [ct] = await db
          .select({ id: containerTypes.id })
          .from(containerTypes)
          .where(eq(containerTypes.id, req.body.containerTypeId));
        if (!ct) throw err.badRequest('Тип контейнера не найден');
      }
      const [updated] = await db
        .update(containers)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(containers.id, req.params.id))
        .returning({ id: containers.id });
      if (!updated) throw err.notFound('Контейнер не найден');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'container.update',
        entityType: 'container',
        entityId: req.params.id,
      });
      return (await getContainerDto(req.params.id))!;
    },
  );

  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      // Деактивация вместо удаления (контейнер может быть в заявках на замену).
      const [row] = await db
        .update(containers)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(containers.id, req.params.id))
        .returning({ id: containers.id });
      if (!row) throw err.notFound('Контейнер не найден');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'container.deactivate',
        entityType: 'container',
        entityId: req.params.id,
      });
      return (await getContainerDto(req.params.id))!;
    },
  );
}
