import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import {
  createVehicleTypeSchema,
  updateVehicleTypeSchema,
  vehicleTypeListQuerySchema,
  type VehicleTypeDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { vehicleKinds, vehicleTypes } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

const idParams = z.object({ id: z.string().uuid() });

const dtoColumns = {
  id: vehicleTypes.id,
  kindId: vehicleTypes.kindId,
  kindCode: vehicleKinds.code,
  kindName: vehicleKinds.name,
  code: vehicleTypes.code,
  name: vehicleTypes.name,
  description: vehicleTypes.description,
  isActive: vehicleTypes.isActive,
  sortOrder: vehicleTypes.sortOrder,
  createdAt: vehicleTypes.createdAt,
  updatedAt: vehicleTypes.updatedAt,
};

type DtoRow = {
  id: string;
  kindId: string;
  kindCode: string;
  kindName: string;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(r: DtoRow): VehicleTypeDto {
  return {
    id: r.id,
    kindId: r.kindId,
    kindCode: r.kindCode,
    kindName: r.kindName,
    code: r.code,
    name: r.name,
    description: r.description,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function getDtoById(id: string): Promise<VehicleTypeDto | undefined> {
  const [row] = await db
    .select(dtoColumns)
    .from(vehicleTypes)
    .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
    .where(eq(vehicleTypes.id, id));
  return row ? toDto(row) : undefined;
}

// Плоский справочник типов ТС (ADR 0005): один уровень, без подтипов/иерархии. Удаления нет —
// деактивация через PATCH isActive. Структурные ключи (code/kindId) неизменяемы после создания.
export default async function vehicleTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canWrite = app.requireRoles('admin', 'manager');

  // ── Список ──
  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: vehicleTypeListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.kindId ? eq(vehicleTypes.kindId, q.kindId) : undefined,
        q.isActive === undefined ? undefined : eq(vehicleTypes.isActive, q.isActive),
        searchCondition(q.search, [vehicleTypes.code, vehicleTypes.name]),
      );
      const sortCols = {
        code: vehicleTypes.code,
        kindName: vehicleKinds.name,
        name: vehicleTypes.name,
        sortOrder: vehicleTypes.sortOrder,
        isActive: vehicleTypes.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns)
          .from(vehicleTypes)
          .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(vehicleTypes).where(where),
      ]);
      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  // ── Одна запись ──
  r.get('/:id', { preHandler: [app.authenticate], schema: { params: idParams } }, async (req) => {
    const dto = await getDtoById(req.params.id);
    if (!dto) throw err.notFound('Тип не найден');
    return dto;
  });

  // ── Создание ──
  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createVehicleTypeSchema } },
    async (req, reply) => {
      const actor = requirePrincipal(req).id;
      const body = req.body;

      const [kind] = await db
        .select({ id: vehicleKinds.id, isActive: vehicleKinds.isActive })
        .from(vehicleKinds)
        .where(eq(vehicleKinds.id, body.kindId));
      if (!kind) throw err.notFound('Вид ТС не найден');
      if (!kind.isActive) throw err.unprocessable('Вид ТС неактивен');

      const dup = await db
        .select({ id: vehicleTypes.id })
        .from(vehicleTypes)
        .where(eq(vehicleTypes.code, body.code));
      if (dup.length > 0) throw err.conflict('Тип с таким кодом уже существует');

      const [created] = await db
        .insert(vehicleTypes)
        .values({
          kindId: body.kindId,
          code: body.code,
          name: body.name,
          description: body.description,
          isActive: body.isActive,
          sortOrder: body.sortOrder,
        })
        .returning({ id: vehicleTypes.id });
      const createdId = created!.id;
      await writeAudit({
        actorUserId: actor,
        action: 'vehicle_type.create',
        entityType: 'vehicle_type',
        entityId: createdId,
        metadata: { code: body.code, kindId: body.kindId, isActive: body.isActive },
      });
      reply.code(201);
      return (await getDtoById(createdId))!;
    },
  );

  // ── Обновление (name/description/sortOrder/isActive; code/kindId неизменяемы) ──
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateVehicleTypeSchema },
    },
    async (req) => {
      const actor = requirePrincipal(req).id;
      const id = req.params.id;
      const body = req.body;
      const [row] = await db.select().from(vehicleTypes).where(eq(vehicleTypes.id, id));
      if (!row) throw err.notFound('Тип не найден');

      await db
        .update(vehicleTypes)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(vehicleTypes.id, id));

      const activeChanged = body.isActive !== undefined && body.isActive !== row.isActive;
      const action = activeChanged
        ? body.isActive
          ? 'vehicle_type.activate'
          : 'vehicle_type.deactivate'
        : 'vehicle_type.update';
      await writeAudit({
        actorUserId: actor,
        action,
        entityType: 'vehicle_type',
        entityId: id,
        metadata: {
          code: row.code,
          kindId: row.kindId,
          oldName: row.name,
          newName: body.name ?? row.name,
          oldActive: row.isActive,
          newActive: body.isActive ?? row.isActive,
        },
      });
      return (await getDtoById(id))!;
    },
  );
}
