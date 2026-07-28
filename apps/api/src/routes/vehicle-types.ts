import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  attachVehicleTypeSpecSchema,
  createVehicleTypeSchema,
  updateVehicleTypeSchema,
  updateVehicleTypeSpecSchema,
  vehicleTypeListQuerySchema,
  type VehicleTypeDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  vehicleCategories,
  vehicleCategorySpecValues,
  vehicleKinds,
  vehicleSpecs,
  vehicleTypeSpecs,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import {
  assertValueFitsSpec,
  loadTypeSpecs,
  lockType,
  refreshTypeCategories,
  signaturesWithoutSpec,
  valueToColumn,
} from '../services/vehicle-categories';

const idParams = z.object({ id: z.string().uuid() });
const specParams = z.object({ id: z.string().uuid(), specId: z.string().uuid() });

// Счётчики ТТХ и категорий (ADR 0016) — коррелированными подзапросами, чтобы список типов не
// порождал запрос на строку. specCount = 0 означает, что у типа нет и не может быть категорий.
const specCount = sql<number>`(
  SELECT count(*) FROM ${vehicleTypeSpecs}
  WHERE ${vehicleTypeSpecs.vehicleTypeId} = ${vehicleTypes.id}
)`;
const categoryCount = sql<number>`(
  SELECT count(*) FROM ${vehicleCategories}
  WHERE ${vehicleCategories.vehicleTypeId} = ${vehicleTypes.id}
)`;

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
  specCount,
  categoryCount,
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
  specCount: number;
  categoryCount: number;
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
    specCount: Number(r.specCount),
    categoryCount: Number(r.categoryCount),
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

  // ── ТТХ типа (ADR 0016) ──
  // Привязка = обязательность: каждая категория типа обязана иметь значение по каждому
  // привязанному ТТХ. Поэтому и добавление, и отвязка задевают все категории разом и идут
  // в транзакции с блокировкой строки типа.

  r.get(
    '/:id/specs',
    { preHandler: [app.authenticate], schema: { params: idParams } },
    async (req) => {
      const [type] = await db
        .select({ id: vehicleTypes.id })
        .from(vehicleTypes)
        .where(eq(vehicleTypes.id, req.params.id));
      if (!type) throw err.notFound('Тип не найден');
      return await loadTypeSpecs(db, req.params.id);
    },
  );

  r.post(
    '/:id/specs',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: attachVehicleTypeSpecSchema },
    },
    async (req, reply) => {
      const typeId = req.params.id;
      const body = req.body;

      await db.transaction(async (tx) => {
        const type = await lockType(tx, typeId);
        const [spec] = await tx.select().from(vehicleSpecs).where(eq(vehicleSpecs.id, body.specId));
        if (!spec) throw err.notFound('ТТХ не найден');
        if (!spec.isActive) throw err.unprocessable('ТТХ неактивен');

        const existing = await tx
          .select({ specId: vehicleTypeSpecs.specId })
          .from(vehicleTypeSpecs)
          .where(
            and(
              eq(vehicleTypeSpecs.vehicleTypeId, typeId),
              eq(vehicleTypeSpecs.specId, body.specId),
            ),
          );
        if (existing.length > 0) throw err.conflict('Этот ТТХ уже привязан к типу');

        const cats = await tx
          .select({ id: vehicleCategories.id })
          .from(vehicleCategories)
          .where(eq(vehicleCategories.vehicleTypeId, typeId));

        // Существующие категории мгновенно стали бы неполными — поэтому значение обязательно.
        // Одинаковая координата, добавленная ко всем кортежам, коллизий сигнатур не создаёт.
        if (cats.length > 0 && body.backfillValue === undefined) {
          throw err.unprocessable(
            `У типа уже есть категории (${cats.length}): укажите значение нового ТТХ — оно будет проставлено каждой из них`,
          );
        }

        const bounds = {
          name: spec.name,
          unit: spec.unit,
          decimals: Number(spec.decimals),
          minValue: spec.minValue == null ? null : Number(spec.minValue),
          maxValue: spec.maxValue == null ? null : Number(spec.maxValue),
        };
        if (cats.length > 0) assertValueFitsSpec(body.backfillValue!, bounds);

        await tx
          .insert(vehicleTypeSpecs)
          .values({ vehicleTypeId: typeId, specId: body.specId, sortOrder: body.sortOrder });

        if (cats.length > 0) {
          await tx.insert(vehicleCategorySpecValues).values(
            cats.map((c) => ({
              categoryId: c.id,
              vehicleTypeId: typeId,
              specId: body.specId,
              valueNum: valueToColumn(body.backfillValue!, bounds),
            })),
          );
          await refreshTypeCategories(tx, typeId, type.name);
        }
      });

      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle_type_spec.attach',
        entityType: 'vehicle_type',
        entityId: typeId,
        metadata: { specId: body.specId, backfillValue: body.backfillValue ?? null },
      });
      reply.code(201);
      return await loadTypeSpecs(db, typeId);
    },
  );

  // Порядок ТТХ определяет порядок полей в форме категории и частей в её наименовании,
  // поэтому авто-имена пересобираются.
  r.patch(
    '/:id/specs/:specId',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: specParams, body: updateVehicleTypeSpecSchema },
    },
    async (req) => {
      const { id: typeId, specId } = req.params;
      await db.transaction(async (tx) => {
        const type = await lockType(tx, typeId);
        const updated = await tx
          .update(vehicleTypeSpecs)
          .set({ sortOrder: req.body.sortOrder })
          .where(
            and(eq(vehicleTypeSpecs.vehicleTypeId, typeId), eq(vehicleTypeSpecs.specId, specId)),
          )
          .returning({ specId: vehicleTypeSpecs.specId });
        if (updated.length === 0) throw err.notFound('ТТХ не привязан к этому типу');
        await refreshTypeCategories(tx, typeId, type.name);
      });
      return await loadTypeSpecs(db, typeId);
    },
  );

  r.delete(
    '/:id/specs/:specId',
    { preHandler: [app.authenticate, canWrite], schema: { params: specParams } },
    async (req) => {
      const { id: typeId, specId } = req.params;
      await db.transaction(async (tx) => {
        const type = await lockType(tx, typeId);
        const specs = await loadTypeSpecs(tx, typeId);
        const binding = specs.find((s) => s.specId === specId);
        if (!binding) throw err.notFound('ТТХ не привязан к этому типу');

        const cats = await tx
          .select({ id: vehicleCategories.id, name: vehicleCategories.name })
          .from(vehicleCategories)
          .where(eq(vehicleCategories.vehicleTypeId, typeId));

        if (cats.length > 0) {
          if (specs.length === 1) {
            throw err.conflict(
              `Это единственный ТТХ типа, а категорий ${cats.length}: категория без значений невозможна — сначала удалите категории`,
            );
          }
          // Выброшенная координата может схлопнуть две категории в один кортеж. Останавливаемся
          // до потери данных, а не ловим уникальным индексом после удаления значений.
          const nameById = new Map(cats.map((c) => [c.id, c.name]));
          const seen = new Map<string, string>();
          const clashes: string[] = [];
          for (const [catId, sig] of await signaturesWithoutSpec(tx, typeId, specId)) {
            const prev = seen.get(sig);
            if (prev) clashes.push(`«${prev}» и «${nameById.get(catId) ?? catId}»`);
            else seen.set(sig, nameById.get(catId) ?? catId);
          }
          if (clashes.length > 0) {
            throw err.conflict(
              `Без этого ТТХ категории станут неразличимы: ${clashes.join('; ')}. Объедините или удалите их и повторите.`,
            );
          }
        }

        // Значения — раньше привязки: составной FK на (vehicle_type_id, spec_id) стоит RESTRICT.
        await tx
          .delete(vehicleCategorySpecValues)
          .where(
            and(
              eq(vehicleCategorySpecValues.vehicleTypeId, typeId),
              eq(vehicleCategorySpecValues.specId, specId),
            ),
          );
        await tx
          .delete(vehicleTypeSpecs)
          .where(
            and(eq(vehicleTypeSpecs.vehicleTypeId, typeId), eq(vehicleTypeSpecs.specId, specId)),
          );
        if (cats.length > 0) await refreshTypeCategories(tx, typeId, type.name);
      });

      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle_type_spec.detach',
        entityType: 'vehicle_type',
        entityId: typeId,
        metadata: { specId },
      });
      return await loadTypeSpecs(db, typeId);
    },
  );
}
