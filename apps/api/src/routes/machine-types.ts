import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import {
  createMachineTypeSchema,
  type MachineTypeDto,
  machineTypeListQuerySchema,
  updateMachineTypeSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { machineTypes, type MachineTypeRow } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

function toDto(r: MachineTypeRow): MachineTypeDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const idParams = z.object({ id: z.string().uuid() });

export default async function machineTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canWrite = app.requireRoles('admin', 'manager');

  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: machineTypeListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(machineTypes.isActive, q.isActive),
        searchCondition(q.search, [machineTypes.code, machineTypes.name]),
      );
      const sortCols = {
        code: machineTypes.code,
        name: machineTypes.name,
        sortOrder: machineTypes.sortOrder,
        isActive: machineTypes.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(machineTypes)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(machineTypes).where(where),
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
    { preHandler: [app.authenticate, canWrite], schema: { body: createMachineTypeSchema } },
    async (req, reply) => {
      const dup = await db
        .select({ id: machineTypes.id })
        .from(machineTypes)
        .where(eq(machineTypes.code, req.body.code));
      if (dup.length > 0) throw err.conflict('Тип машины с таким кодом уже существует');
      const [created] = await db.insert(machineTypes).values(req.body).returning();
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'machine_type.create',
        entityType: 'machine_type',
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
      schema: { params: idParams, body: updateMachineTypeSchema },
    },
    async (req) => {
      const [updated] = await db
        .update(machineTypes)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(machineTypes.id, req.params.id))
        .returning();
      if (!updated) throw err.notFound('Тип машины не найден');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'machine_type.update',
        entityType: 'machine_type',
        entityId: req.params.id,
      });
      return toDto(updated);
    },
  );

  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const [row] = await db
        .update(machineTypes)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(machineTypes.id, req.params.id))
        .returning();
      if (!row) throw err.notFound('Тип машины не найден');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'machine_type.deactivate',
        entityType: 'machine_type',
        entityId: req.params.id,
      });
      return toDto(row);
    },
  );
}
