import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import {
  createWasteTypeSchema,
  updateWasteTypeSchema,
  type WasteTypeDto,
  wasteTypeListQuerySchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { wasteTypes, type WasteTypeRow } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

function toDto(t: WasteTypeRow): WasteTypeDto {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    description: t.description,
    sortOrder: t.sortOrder,
    isActive: t.isActive,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

const idParams = z.object({ id: z.string().uuid() });

// Справочник типов мусора (ADR 0009, ведение — ADR 0014): «что вывозим». Читают все, правят
// администратор и менеджер — тип мусора существует ради тарифа, поэтому оба справочника ведёт
// одна роль. Удаления нет: на тип ссылаются заявки и позиции прайса, выбытие — через isActive.
export default async function wasteTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canWrite = app.requireRoles('admin', 'manager');

  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: wasteTypeListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(wasteTypes.isActive, q.isActive),
        searchCondition(q.search, [wasteTypes.code, wasteTypes.name]),
      );
      const sortCols = {
        code: wasteTypes.code,
        name: wasteTypes.name,
        sortOrder: wasteTypes.sortOrder,
        isActive: wasteTypes.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(wasteTypes)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(wasteTypes).where(where),
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
    { preHandler: [app.authenticate, canWrite], schema: { body: createWasteTypeSchema } },
    async (req, reply) => {
      const dup = await db
        .select({ id: wasteTypes.id })
        .from(wasteTypes)
        .where(eq(wasteTypes.code, req.body.code));
      if (dup.length > 0) throw err.conflict('Тип мусора с таким кодом уже существует');
      const [created] = await db.insert(wasteTypes).values(req.body).returning();
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'waste_type.create',
        entityType: 'waste_type',
        entityId: created!.id,
        metadata: { code: created!.code, name: created!.name },
      });
      reply.code(201);
      return toDto(created!);
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateWasteTypeSchema },
    },
    async (req) => {
      const [updated] = await db
        .update(wasteTypes)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(wasteTypes.id, req.params.id))
        .returning();
      if (!updated) throw err.notFound('Тип мусора не найден');
      const action =
        req.body.isActive === false
          ? 'waste_type.deactivate'
          : req.body.isActive === true
            ? 'waste_type.activate'
            : 'waste_type.update';
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action,
        entityType: 'waste_type',
        entityId: updated.id,
      });
      return toDto(updated);
    },
  );
}
