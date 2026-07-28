import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import {
  createVehicleSchema,
  updateVehicleSchema,
  type VehicleDto,
  vehicleListQuerySchema,
} from '@technic/contracts';
import { z } from 'zod';
import { db } from '../db/client';
import { vehicleModels, vehicles, vehicleTypes } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams } from '../lib/pagination';

const idParams = z.object({ id: z.string().uuid() });

const vehicleSelect = {
  id: vehicles.id,
  vehicleTypeId: vehicles.vehicleTypeId,
  typeName: vehicleTypes.name,
  vehicleModelId: vehicles.vehicleModelId,
  modelName: vehicleModels.name,
  registrationNumber: vehicles.registrationNumber,
  inventoryNumber: vehicles.inventoryNumber,
  serialNumber: vehicles.serialNumber,
  passportNumber: vehicles.passportNumber,
  manufacturerName: vehicles.manufacturerName,
  manufacturedOn: vehicles.manufacturedOn,
  status: vehicles.status,
  note: vehicles.note,
  createdAt: vehicles.createdAt,
  updatedAt: vehicles.updatedAt,
  deletedAt: vehicles.deletedAt,
};

function baseQuery() {
  return db
    .select(vehicleSelect)
    .from(vehicles)
    .innerJoin(vehicleTypes, eq(vehicles.vehicleTypeId, vehicleTypes.id))
    // марка/модель опциональна
    .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id));
}

type VehicleRow = Awaited<ReturnType<typeof baseQuery>>[number];

function toDto(r: VehicleRow): VehicleDto {
  return {
    id: r.id,
    vehicleTypeId: r.vehicleTypeId,
    typeName: r.typeName,
    vehicleModelId: r.vehicleModelId,
    modelName: r.modelName,
    registrationNumber: r.registrationNumber,
    inventoryNumber: r.inventoryNumber,
    serialNumber: r.serialNumber,
    passportNumber: r.passportNumber,
    manufacturerName: r.manufacturerName,
    manufacturedOn: r.manufacturedOn,
    status: r.status,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

/** Пустая/пробельная строка → NULL (CHECK not-blank в БД и корректный поиск/уникальность). */
const blank = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

async function getById(id: string): Promise<VehicleDto | null> {
  const [row] = await baseQuery().where(eq(vehicles.id, id));
  return row ? toDto(row) : null;
}

async function assertTypeExists(typeId: string): Promise<void> {
  const [t] = await db.select({ id: vehicleTypes.id }).from(vehicleTypes).where(eq(vehicleTypes.id, typeId));
  if (!t) throw err.badRequest('Тип ТС не найден');
}

async function assertModelMatchesType(modelId: string, typeId: string): Promise<void> {
  const [m] = await db
    .select({ id: vehicleModels.id })
    .from(vehicleModels)
    .where(and(eq(vehicleModels.id, modelId), eq(vehicleModels.vehicleTypeId, typeId)));
  if (!m) throw err.badRequest('Марка/модель не относится к выбранному типу');
}

async function assertRegUnique(reg: string, excludeId?: string): Promise<void> {
  const [dup] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(
      and(
        // сравниваем нормализованные формы — тот же алгоритм, что в частичном уникальном индексе
        sql`${vehicles.registrationNumberNormalized} = vehicle_reg_normalize(${reg})`,
        isNull(vehicles.deletedAt),
        excludeId ? ne(vehicles.id, excludeId) : undefined,
      ),
    );
  if (dup) throw err.conflict('Техника с таким госномером уже есть');
}

export default async function vehiclesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canWrite = app.requireRoles('admin', 'manager');

  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: vehicleListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.includeDeleted ? undefined : isNull(vehicles.deletedAt),
        q.vehicleTypeId ? eq(vehicles.vehicleTypeId, q.vehicleTypeId) : undefined,
        q.status ? eq(vehicles.status, q.status) : undefined,
        q.search
          ? or(
              sql`${vehicles.registrationNumberNormalized} ILIKE '%' || vehicle_reg_normalize(${q.search}) || '%'`,
              ilike(vehicles.inventoryNumber, `%${q.search}%`),
              ilike(vehicles.serialNumber, `%${q.search}%`),
              ilike(vehicles.manufacturerName, `%${q.search}%`),
              ilike(vehicleModels.name, `%${q.search}%`),
            )
          : undefined,
      );
      const sortCols = {
        registrationNumber: vehicles.registrationNumberNormalized,
        typeName: vehicleTypes.name,
        modelName: vehicleModels.name,
        inventoryNumber: vehicles.inventoryNumber,
        serialNumber: vehicles.serialNumber,
        manufacturerName: vehicles.manufacturerName,
        manufacturedOn: vehicles.manufacturedOn,
        status: vehicles.status,
        createdAt: vehicles.createdAt,
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
          .from(vehicles)
          .innerJoin(vehicleTypes, eq(vehicles.vehicleTypeId, vehicleTypes.id))
          .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id))
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
    { preHandler: [app.authenticate, canWrite], schema: { body: createVehicleSchema } },
    async (req, reply) => {
      const b = req.body;
      await assertTypeExists(b.vehicleTypeId);
      if (b.vehicleModelId) await assertModelMatchesType(b.vehicleModelId, b.vehicleTypeId);
      const reg = blank(b.registrationNumber);
      if (reg) await assertRegUnique(reg);
      const [created] = await db
        .insert(vehicles)
        .values({
          vehicleTypeId: b.vehicleTypeId,
          vehicleModelId: b.vehicleModelId ?? null,
          registrationNumber: reg,
          inventoryNumber: blank(b.inventoryNumber),
          serialNumber: blank(b.serialNumber),
          passportNumber: blank(b.passportNumber),
          manufacturerName: b.manufacturerName,
          manufacturedOn: b.manufacturedOn ?? null,
          status: b.status,
          note: b.note,
        })
        .returning({ id: vehicles.id });
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle.create',
        entityType: 'vehicle',
        entityId: created!.id,
      });
      reply.code(201);
      return (await getById(created!.id))!;
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateVehicleSchema },
    },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      const [ex] = await db
        .select()
        .from(vehicles)
        .where(and(eq(vehicles.id, id), isNull(vehicles.deletedAt)));
      if (!ex) throw err.notFound('Техника не найдена');

      const typeId = b.vehicleTypeId ?? ex.vehicleTypeId;
      if (b.vehicleTypeId && b.vehicleTypeId !== ex.vehicleTypeId) await assertTypeExists(typeId);
      const modelId = b.vehicleModelId !== undefined ? b.vehicleModelId : ex.vehicleModelId;
      if (modelId) await assertModelMatchesType(modelId, typeId);
      const reg = b.registrationNumber !== undefined ? blank(b.registrationNumber) : ex.registrationNumber;
      if (reg && reg !== ex.registrationNumber) await assertRegUnique(reg, id);

      const set: Partial<typeof vehicles.$inferInsert> = { updatedAt: new Date() };
      if (b.vehicleTypeId !== undefined) set.vehicleTypeId = b.vehicleTypeId;
      if (b.vehicleModelId !== undefined) set.vehicleModelId = b.vehicleModelId ?? null;
      if (b.registrationNumber !== undefined) set.registrationNumber = blank(b.registrationNumber);
      if (b.inventoryNumber !== undefined) set.inventoryNumber = blank(b.inventoryNumber);
      if (b.serialNumber !== undefined) set.serialNumber = blank(b.serialNumber);
      if (b.passportNumber !== undefined) set.passportNumber = blank(b.passportNumber);
      if (b.manufacturerName !== undefined) set.manufacturerName = b.manufacturerName;
      if (b.manufacturedOn !== undefined) set.manufacturedOn = b.manufacturedOn ?? null;
      if (b.status !== undefined) set.status = b.status;
      if (b.note !== undefined) set.note = b.note;

      await db.update(vehicles).set(set).where(eq(vehicles.id, id));
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle.update',
        entityType: 'vehicle',
        entityId: id,
      });
      return (await getById(id))!;
    },
  );

  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const { id } = req.params;
      const [row] = await db
        .update(vehicles)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(vehicles.id, id), isNull(vehicles.deletedAt)))
        .returning({ id: vehicles.id });
      if (!row) throw err.notFound('Техника не найдена');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle.delete',
        entityType: 'vehicle',
        entityId: id,
      });
      return { ok: true };
    },
  );

  r.post(
    '/:id/restore',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const { id } = req.params;
      const [ex] = await db.select().from(vehicles).where(eq(vehicles.id, id));
      if (!ex) throw err.notFound('Техника не найдена');
      if (!ex.deletedAt) return (await getById(id))!;
      // Госномер уникален среди живых — при восстановлении сверяем заново.
      if (ex.registrationNumber) await assertRegUnique(ex.registrationNumber, id);
      await db.update(vehicles).set({ deletedAt: null, updatedAt: new Date() }).where(eq(vehicles.id, id));
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle.restore',
        entityType: 'vehicle',
        entityId: id,
      });
      return (await getById(id))!;
    },
  );
}
