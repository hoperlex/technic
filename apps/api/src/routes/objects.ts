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
import { operatorsByObjectIds, replaceObjectOperators } from '../services/object-operators';
import { z } from 'zod';

function toDto(r: ObjectRow, operators: ObjectDto['operators']): ObjectDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    address: r.address,
    isActive: r.isActive,
    operators,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Карточка объекта всегда идёт с операторами: клиент правит набор, а не отдельные привязки. */
async function getDto(id: string): Promise<ObjectDto | null> {
  const [row] = await db.select().from(constructionObjects).where(eq(constructionObjects.id, id));
  if (!row) return null;
  const operators = await operatorsByObjectIds([id]);
  return toDto(row, operators.get(id) ?? []);
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
      const operators = await operatorsByObjectIds(rows.map((row) => row.id));
      return {
        items: rows.map((row) => toDto(row, operators.get(row.id) ?? [])),
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
      const p = requirePrincipal(req);
      const { operatorIds, ...body } = req.body;
      const created = await db.transaction(async (tx) => {
        const dup = await tx
          .select({ id: constructionObjects.id })
          .from(constructionObjects)
          .where(eq(constructionObjects.code, body.code));
        if (dup.length > 0) throw err.conflict('Объект с таким кодом уже существует');
        const [row] = await tx
          .insert(constructionObjects)
          .values(body)
          .returning({ id: constructionObjects.id });
        await replaceObjectOperators(tx, row!.id, operatorIds, p.id);
        return row!;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'object.create',
        entityType: 'construction_object',
        entityId: created.id,
      });
      reply.code(201);
      return (await getDto(created.id))!;
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateObjectSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { operatorIds, ...body } = req.body;
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(constructionObjects)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(constructionObjects.id, id))
          .returning({ id: constructionObjects.id });
        if (!updated) throw err.notFound('Объект не найден');
        // Отсутствие поля — «не трогать привязки»: их правят и из карточки контрагента.
        if (operatorIds !== undefined) await replaceObjectOperators(tx, id, operatorIds, p.id);
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'object.update',
        entityType: 'construction_object',
        entityId: id,
      });
      return (await getDto(id))!;
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
        .returning({ id: constructionObjects.id });
      if (!row) throw err.notFound('Объект не найден');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'object.deactivate',
        entityType: 'construction_object',
        entityId: id,
      });
      return (await getDto(id))!;
    },
  );
}
