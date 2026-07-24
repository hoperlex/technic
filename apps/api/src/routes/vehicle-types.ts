import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  createVehicleTypeSchema,
  updateParentTypeSchema,
  updateSubtypeSchema,
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

// Самоджойн для parentName и иерархической сортировки.
const parent = alias(vehicleTypes, 'parent');

const dtoColumns = {
  id: vehicleTypes.id,
  kindId: vehicleTypes.kindId,
  kindCode: vehicleKinds.code,
  kindName: vehicleKinds.name,
  parentId: vehicleTypes.parentId,
  parentName: parent.name,
  code: vehicleTypes.code,
  name: vehicleTypes.name,
  description: vehicleTypes.description,
  isSelectable: vehicleTypes.isSelectable,
  isActive: vehicleTypes.isActive,
  sortOrder: vehicleTypes.sortOrder,
  childrenCount: sql<number>`(select count(*)::int from ${vehicleTypes} c where c.parent_id = ${vehicleTypes.id})`,
  createdAt: vehicleTypes.createdAt,
  updatedAt: vehicleTypes.updatedAt,
};

type DtoRow = {
  id: string;
  kindId: string;
  kindCode: string;
  kindName: string;
  parentId: string | null;
  parentName: string | null;
  code: string;
  name: string;
  description: string;
  isSelectable: boolean;
  isActive: boolean;
  sortOrder: number;
  childrenCount: number;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(r: DtoRow): VehicleTypeDto {
  return {
    id: r.id,
    kindId: r.kindId,
    kindCode: r.kindCode,
    kindName: r.kindName,
    parentId: r.parentId,
    parentName: r.parentName,
    code: r.code,
    name: r.name,
    description: r.description,
    level: r.parentId === null ? 'type' : 'subtype',
    isSelectable: r.isSelectable,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    childrenCount: r.childrenCount,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function getDtoById(id: string): Promise<VehicleTypeDto | undefined> {
  const [row] = await db
    .select(dtoColumns)
    .from(vehicleTypes)
    .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
    .leftJoin(parent, eq(vehicleTypes.parentId, parent.id))
    .where(eq(vehicleTypes.id, id));
  return row ? toDto(row) : undefined;
}

/** Активность типа — производное: активен ⇔ есть хотя бы один активный подтип (§9). */
async function recomputeParentActive(tx: Tx, parentId: string): Promise<void> {
  await tx
    .update(vehicleTypes)
    .set({
      isActive: sql`exists (select 1 from ${vehicleTypes} c where c.parent_id = ${parentId} and c.is_active = true)`,
      updatedAt: new Date(),
    })
    .where(eq(vehicleTypes.id, parentId));
}

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
        q.parentId ? eq(vehicleTypes.parentId, q.parentId) : undefined,
        q.level === 'type'
          ? isNull(vehicleTypes.parentId)
          : q.level === 'subtype'
            ? isNotNull(vehicleTypes.parentId)
            : undefined,
        q.isActive === undefined ? undefined : eq(vehicleTypes.isActive, q.isActive),
        searchCondition(q.search, [vehicleTypes.code, vehicleTypes.name]),
      );

      const sortCols = {
        code: vehicleTypes.code,
        name: vehicleTypes.name,
        sortOrder: vehicleTypes.sortOrder,
        isActive: vehicleTypes.isActive,
      };
      // Иерархия: родитель и его подтипы идут подряд (§15).
      const hierarchyOrder = [
        asc(vehicleKinds.sortOrder),
        asc(vehicleKinds.id),
        sql`coalesce(${parent.sortOrder}, ${vehicleTypes.sortOrder})`,
        sql`coalesce(${parent.name}, ${vehicleTypes.name})`,
        sql`coalesce(${parent.id}, ${vehicleTypes.id})`,
        sql`(${vehicleTypes.parentId} is not null)`,
        asc(vehicleTypes.sortOrder),
        asc(vehicleTypes.name),
      ];
      const orderBy =
        q.view === 'hierarchy'
          ? hierarchyOrder
          : [orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder')];

      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns)
          .from(vehicleTypes)
          .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
          .leftJoin(parent, eq(vehicleTypes.parentId, parent.id))
          .where(where)
          .orderBy(...orderBy)
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
  r.get(
    '/:id',
    { preHandler: [app.authenticate], schema: { params: idParams } },
    async (req) => {
      const dto = await getDtoById(req.params.id);
      if (!dto) throw err.notFound('Тип не найден');
      return dto;
    },
  );

  // ── Создание (discriminatedUnion по level) ──
  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createVehicleTypeSchema } },
    async (req, reply) => {
      const actor = requirePrincipal(req).id;
      const body = req.body;
      let createdId: string;

      if (body.level === 'type') {
        const dup = await db
          .select({ id: vehicleTypes.id })
          .from(vehicleTypes)
          .where(eq(vehicleTypes.code, body.code));
        if (dup.length > 0) throw err.conflict('Тип с таким кодом уже существует');
        const [created] = await db
          .insert(vehicleTypes)
          .values({
            kindId: body.kindId,
            parentId: null,
            code: body.code,
            name: body.name,
            description: body.description,
            isSelectable: false,
            isActive: false, // тип неактивен, пока нет активного подтипа
            sortOrder: body.sortOrder,
          })
          .returning({ id: vehicleTypes.id });
        createdId = created!.id;
        await writeAudit({
          actorUserId: actor,
          action: 'vehicle_type.create',
          entityType: 'vehicle_type',
          entityId: createdId,
          metadata: { code: body.code, kindId: body.kindId, parentId: null, level: 'type' },
        });
      } else {
        createdId = await db.transaction(async (tx) => {
          const [prow] = await tx
            .select({
              id: vehicleTypes.id,
              kindId: vehicleTypes.kindId,
              parentId: vehicleTypes.parentId,
            })
            .from(vehicleTypes)
            .where(eq(vehicleTypes.id, body.parentId))
            .for('update');
          if (!prow) throw err.notFound('Родительский тип не найден');
          if (prow.parentId !== null) {
            throw err.unprocessable(
              'Родителем можно выбрать только тип (не подтип); третий уровень запрещён',
            );
          }
          const dup = await tx
            .select({ id: vehicleTypes.id })
            .from(vehicleTypes)
            .where(eq(vehicleTypes.code, body.code));
          if (dup.length > 0) throw err.conflict('Тип с таким кодом уже существует');
          const [created] = await tx
            .insert(vehicleTypes)
            .values({
              kindId: prow.kindId, // наследуется от родителя, не из тела запроса
              parentId: body.parentId,
              code: body.code,
              name: body.name,
              description: body.description,
              isSelectable: true,
              isActive: body.isActive,
              sortOrder: body.sortOrder,
            })
            .returning({ id: vehicleTypes.id });
          await recomputeParentActive(tx, body.parentId);
          return created!.id;
        });
        await writeAudit({
          actorUserId: actor,
          action: 'vehicle_type.create',
          entityType: 'vehicle_type',
          entityId: createdId,
          metadata: {
            code: body.code,
            parentId: body.parentId,
            level: 'subtype',
            isActive: body.isActive,
          },
        });
      }
      reply.code(201);
      return (await getDtoById(createdId))!;
    },
  );

  // ── Обновление (только описательные поля; уровень определяет допустимую схему) ──
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateVehicleTypeSchema },
    },
    async (req) => {
      const actor = requirePrincipal(req).id;
      const id = req.params.id;

      const result = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(vehicleTypes)
          .where(eq(vehicleTypes.id, id))
          .for('update');
        if (!row) throw err.notFound('Тип не найден');

        if (row.parentId === null) {
          // Тип: только name/description/sortOrder. isActive/структурные поля запрещены.
          const parsed = updateParentTypeSchema.safeParse(req.body);
          if (!parsed.success) {
            throw err.badRequest(
              'Для типа можно менять только name, description, sortOrder',
              fieldsFromZod(parsed.error),
            );
          }
          await tx
            .update(vehicleTypes)
            .set({ ...parsed.data, updatedAt: new Date() })
            .where(eq(vehicleTypes.id, id));
          return {
            action: 'vehicle_type.update' as const,
            metadata: {
              code: row.code,
              kindId: row.kindId,
              oldName: row.name,
              newName: parsed.data.name ?? row.name,
            },
          };
        }

        // Подтип: name/description/sortOrder/isActive.
        const parsed = updateSubtypeSchema.safeParse(req.body);
        if (!parsed.success) {
          throw err.badRequest(
            'Для подтипа можно менять только name, description, sortOrder, isActive',
            fieldsFromZod(parsed.error),
          );
        }
        await tx
          .update(vehicleTypes)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(eq(vehicleTypes.id, id));

        let action = 'vehicle_type.update';
        const activeChanged =
          parsed.data.isActive !== undefined && parsed.data.isActive !== row.isActive;
        if (activeChanged) {
          await recomputeParentActive(tx, row.parentId);
          action = parsed.data.isActive ? 'vehicle_type.activate' : 'vehicle_type.deactivate';
        }
        return {
          action,
          metadata: {
            code: row.code,
            kindId: row.kindId,
            parentId: row.parentId,
            oldName: row.name,
            newName: parsed.data.name ?? row.name,
            oldActive: row.isActive,
            newActive: parsed.data.isActive ?? row.isActive,
          },
        };
      });

      await writeAudit({
        actorUserId: actor,
        action: result.action,
        entityType: 'vehicle_type',
        entityId: id,
        metadata: result.metadata,
      });
      return (await getDtoById(id))!;
    },
  );
}

function fieldsFromZod(e: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of e.issues) out[issue.path.join('.') || '_'] = issue.message;
  return out;
}
