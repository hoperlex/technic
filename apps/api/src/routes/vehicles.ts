import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import {
  createVehicleSchema,
  updateVehicleSchema,
  updateVehicleSchemaByOwnership,
  type UpdateOwnVehicleInput,
  type UpdateRentalVehicleInput,
  type VehicleDto,
  vehicleListQuerySchema,
} from '@technic/contracts';
import { z } from 'zod';
import { db } from '../db/client';
import {
  counterparties,
  vehicleCategories,
  vehicleModels,
  vehicles,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams } from '../lib/pagination';

// Справочник техники (ADR 0007) с двумя ветками принадлежности (ADR 0018): собственные машины и
// предложения аренды. Ветку задаёт `ownership`, и она неизменяема — смена принадлежности означала бы
// подмену сущности: у веток не пересекается ни один содержательный реквизит.

const idParams = z.object({ id: z.string().uuid() });

const vehicleSelect = {
  id: vehicles.id,
  ownership: vehicles.ownership,
  vehicleTypeId: vehicles.vehicleTypeId,
  typeName: vehicleTypes.name,
  vehicleCategoryId: vehicles.vehicleCategoryId,
  categoryName: vehicleCategories.name,
  vehicleModelId: vehicles.vehicleModelId,
  modelName: vehicleModels.name,
  registrationNumber: vehicles.registrationNumber,
  passportNumber: vehicles.passportNumber,
  lessorId: vehicles.lessorId,
  lessorName: counterparties.name,
  description: vehicles.description,
  pricePerHour: vehicles.pricePerHour,
  pricePerShift: vehicles.pricePerShift,
  shiftHours: vehicles.shiftHours,
  status: vehicles.status,
  note: vehicles.note,
  createdAt: vehicles.createdAt,
  updatedAt: vehicles.updatedAt,
  deletedAt: vehicles.deletedAt,
};

function baseQuery() {
  return (
    db
      .select(vehicleSelect)
      .from(vehicles)
      .innerJoin(vehicleTypes, eq(vehicles.vehicleTypeId, vehicleTypes.id))
      // Марка/модель, категория и арендодатель опциональны — каждая по своей причине.
      .leftJoin(vehicleModels, eq(vehicles.vehicleModelId, vehicleModels.id))
      .leftJoin(vehicleCategories, eq(vehicles.vehicleCategoryId, vehicleCategories.id))
      .leftJoin(counterparties, eq(vehicles.lessorId, counterparties.id))
  );
}

type VehicleRow = Awaited<ReturnType<typeof baseQuery>>[number];

function toDto(r: VehicleRow): VehicleDto {
  return {
    id: r.id,
    ownership: r.ownership,
    vehicleTypeId: r.vehicleTypeId,
    typeName: r.typeName,
    vehicleCategoryId: r.vehicleCategoryId,
    categoryName: r.categoryName,
    vehicleModelId: r.vehicleModelId,
    modelName: r.modelName,
    registrationNumber: r.registrationNumber,
    passportNumber: r.passportNumber,
    lessorId: r.lessorId,
    lessorName: r.lessorName,
    description: r.description,
    pricePerHour: r.pricePerHour == null ? null : Number(r.pricePerHour),
    pricePerShift: r.pricePerShift == null ? null : Number(r.pricePerShift),
    shiftHours: r.shiftHours == null ? null : Number(r.shiftHours),
    status: r.status,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

/** Пустая/пробельная строка → NULL (CHECK not-blank в БД и корректный поиск/уникальность). */
const blank = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

/** numeric(12,2) принимает строку; null остаётся null. */
const money = (v: number | null | undefined): string | null => (v == null ? null : v.toFixed(2));

async function getById(id: string): Promise<VehicleDto | null> {
  const [row] = await baseQuery().where(eq(vehicles.id, id));
  return row ? toDto(row) : null;
}

async function assertTypeExists(typeId: string): Promise<void> {
  const [t] = await db
    .select({ id: vehicleTypes.id })
    .from(vehicleTypes)
    .where(eq(vehicleTypes.id, typeId));
  if (!t) throw err.badRequest('Тип ТС не найден');
}

async function assertModelMatchesType(modelId: string, typeId: string): Promise<void> {
  const [m] = await db
    .select({ id: vehicleModels.id })
    .from(vehicleModels)
    .where(and(eq(vehicleModels.id, modelId), eq(vehicleModels.vehicleTypeId, typeId)));
  if (!m) throw err.badRequest('Марка/модель не относится к выбранному типу');
}

/**
 * Категория должна принадлежать выбранному типу (это же держит составной FK) и быть активной:
 * неактивная категория остаётся у заведённых записей, но новой её выбрать нельзя.
 */
async function assertCategoryMatchesType(categoryId: string, typeId: string): Promise<void> {
  const [c] = await db
    .select({ id: vehicleCategories.id, isActive: vehicleCategories.isActive })
    .from(vehicleCategories)
    .where(and(eq(vehicleCategories.id, categoryId), eq(vehicleCategories.vehicleTypeId, typeId)));
  if (!c) throw err.badRequest('Категория не относится к выбранному типу');
  if (!c.isActive) throw err.unprocessable('Категория неактивна');
}

/** Арендодатель — живой активный контрагент роли «Арендодатель (ТС)» (ADR 0018 §9-10). */
async function assertLessorUsable(lessorId: string): Promise<void> {
  const [cp] = await db
    .select({
      type: counterparties.type,
      isActive: counterparties.isActive,
      deletedAt: counterparties.deletedAt,
    })
    .from(counterparties)
    .where(eq(counterparties.id, lessorId));
  if (!cp || cp.deletedAt) throw err.badRequest('Арендодатель не найден');
  if (cp.type !== 'vehicle_lessor') {
    throw err.badRequest(
      'Арендодателем можно указать только контрагента роли «Арендодатель (ТС)»',
      {
        lessorId: 'Нужен контрагент-арендодатель',
      },
    );
  }
  if (!cp.isActive) throw err.unprocessable('Арендодатель неактивен');
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

/**
 * Одно предложение = (арендодатель, тип, категория, описание) — то же, что частичный уникальный
 * индекс с NULLS NOT DISTINCT. Проверяем заранее, чтобы отдать человеку понятный 409 с подсказкой,
 * а не сырую ошибку индекса.
 */
async function assertRentalOfferFree(
  lessorId: string,
  typeId: string,
  categoryId: string | null,
  description: string,
  excludeId?: string,
): Promise<void> {
  const [dup] = await db
    .select({ id: vehicles.id })
    .from(vehicles)
    .where(
      and(
        eq(vehicles.ownership, 'rental'),
        isNull(vehicles.deletedAt),
        eq(vehicles.lessorId, lessorId),
        eq(vehicles.vehicleTypeId, typeId),
        categoryId
          ? eq(vehicles.vehicleCategoryId, categoryId)
          : isNull(vehicles.vehicleCategoryId),
        eq(vehicles.description, description),
        excludeId ? ne(vehicles.id, excludeId) : undefined,
      ),
    );
  if (dup) {
    throw err.conflict(
      'У этого арендодателя уже есть такое предложение — уточните категорию или добавьте описание (например «Автокран 70 тн»)',
    );
  }
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
        q.ownership ? eq(vehicles.ownership, q.ownership) : undefined,
        q.vehicleTypeId ? eq(vehicles.vehicleTypeId, q.vehicleTypeId) : undefined,
        q.vehicleCategoryId ? eq(vehicles.vehicleCategoryId, q.vehicleCategoryId) : undefined,
        q.lessorId ? eq(vehicles.lessorId, q.lessorId) : undefined,
        q.status ? eq(vehicles.status, q.status) : undefined,
        // Поиск покрывает опознавательные поля обеих веток: у своей — госномер и марка/модель,
        // у аренды — описание и наименование арендодателя.
        q.search
          ? or(
              sql`${vehicles.registrationNumberNormalized} ILIKE '%' || vehicle_reg_normalize(${q.search}) || '%'`,
              ilike(vehicleModels.name, `%${q.search}%`),
              ilike(vehicles.description, `%${q.search}%`),
              ilike(counterparties.name, `%${q.search}%`),
            )
          : undefined,
      );
      const sortCols = {
        ownership: vehicles.ownership,
        registrationNumber: vehicles.registrationNumberNormalized,
        typeName: vehicleTypes.name,
        categoryName: vehicleCategories.name,
        modelName: vehicleModels.name,
        lessorName: counterparties.name,
        description: vehicles.description,
        pricePerHour: vehicles.pricePerHour,
        pricePerShift: vehicles.pricePerShift,
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
          .leftJoin(vehicleCategories, eq(vehicles.vehicleCategoryId, vehicleCategories.id))
          .leftJoin(counterparties, eq(vehicles.lessorId, counterparties.id))
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
      if (b.vehicleCategoryId)
        await assertCategoryMatchesType(b.vehicleCategoryId, b.vehicleTypeId);

      const common = {
        ownership: b.ownership,
        vehicleTypeId: b.vehicleTypeId,
        vehicleCategoryId: b.vehicleCategoryId ?? null,
        status: b.status,
        note: b.note,
      };

      let values: typeof vehicles.$inferInsert;
      if (b.ownership === 'own') {
        if (b.vehicleModelId) await assertModelMatchesType(b.vehicleModelId, b.vehicleTypeId);
        const reg = blank(b.registrationNumber);
        if (reg) await assertRegUnique(reg);
        values = {
          ...common,
          vehicleModelId: b.vehicleModelId ?? null,
          registrationNumber: reg,
          passportNumber: blank(b.passportNumber),
        };
      } else {
        await assertLessorUsable(b.lessorId);
        await assertRentalOfferFree(
          b.lessorId,
          b.vehicleTypeId,
          b.vehicleCategoryId ?? null,
          b.description,
        );
        values = {
          ...common,
          lessorId: b.lessorId,
          // Служебный тип — цель составного FK; человек его не задаёт.
          lessorType: 'vehicle_lessor',
          description: b.description,
          pricePerHour: money(b.pricePerHour),
          pricePerShift: money(b.pricePerShift),
          shiftHours: b.shiftHours ?? null,
        };
      }

      const [created] = await db.insert(vehicles).values(values).returning({ id: vehicles.id });
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle.create',
        entityType: 'vehicle',
        entityId: created!.id,
        metadata: { ownership: b.ownership },
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
      const [ex] = await db
        .select()
        .from(vehicles)
        .where(and(eq(vehicles.id, id), isNull(vehicles.deletedAt)));
      if (!ex) throw err.notFound('Техника не найдена');

      // Ветку задаёт запись, а не тело: схема союза приняла бы поля любой из веток, поэтому
      // разбираем тело ещё раз — уже схемой той принадлежности, которая у записи.
      const parsed = updateVehicleSchemaByOwnership[ex.ownership].safeParse(req.body);
      if (!parsed.success) {
        throw err.badRequest(
          ex.ownership === 'own'
            ? 'Для собственной техники недоступны поля аренды'
            : 'Для предложения аренды недоступны реквизиты машины (марка/модель, госномер, ПТС)',
        );
      }

      const typeId = parsed.data.vehicleTypeId ?? ex.vehicleTypeId;
      if (parsed.data.vehicleTypeId && parsed.data.vehicleTypeId !== ex.vehicleTypeId) {
        await assertTypeExists(typeId);
      }
      const categoryId =
        parsed.data.vehicleCategoryId !== undefined
          ? (parsed.data.vehicleCategoryId ?? null)
          : ex.vehicleCategoryId;
      // Смена типа обнуляет категорию, если та относилась к прежнему типу: составной FK иначе
      // просто откажет, а человек не поймёт, почему.
      const nextCategoryId =
        categoryId && typeId !== ex.vehicleTypeId && parsed.data.vehicleCategoryId === undefined
          ? null
          : categoryId;
      if (nextCategoryId) await assertCategoryMatchesType(nextCategoryId, typeId);

      const set: Partial<typeof vehicles.$inferInsert> = { updatedAt: new Date() };
      if (parsed.data.vehicleTypeId !== undefined) set.vehicleTypeId = parsed.data.vehicleTypeId;
      if (nextCategoryId !== ex.vehicleCategoryId) set.vehicleCategoryId = nextCategoryId;
      if (parsed.data.status !== undefined) set.status = parsed.data.status;
      if (parsed.data.note !== undefined) set.note = parsed.data.note;

      if (ex.ownership === 'own') {
        const b = parsed.data as UpdateOwnVehicleInput;
        const modelId = b.vehicleModelId !== undefined ? b.vehicleModelId : ex.vehicleModelId;
        if (modelId) await assertModelMatchesType(modelId, typeId);
        const reg =
          b.registrationNumber !== undefined ? blank(b.registrationNumber) : ex.registrationNumber;
        if (reg && reg !== ex.registrationNumber) await assertRegUnique(reg, id);
        if (b.vehicleModelId !== undefined) set.vehicleModelId = b.vehicleModelId ?? null;
        if (b.registrationNumber !== undefined)
          set.registrationNumber = blank(b.registrationNumber);
        if (b.passportNumber !== undefined) set.passportNumber = blank(b.passportNumber);
      } else {
        const b = parsed.data as UpdateRentalVehicleInput;
        const lessorId = b.lessorId ?? ex.lessorId!;
        if (b.lessorId && b.lessorId !== ex.lessorId) await assertLessorUsable(b.lessorId);
        const description = b.description ?? ex.description;
        const offerChanged =
          lessorId !== ex.lessorId ||
          typeId !== ex.vehicleTypeId ||
          nextCategoryId !== ex.vehicleCategoryId ||
          description !== ex.description;
        if (offerChanged) {
          await assertRentalOfferFree(lessorId, typeId, nextCategoryId, description, id);
        }
        // Хотя бы одна цена должна остаться: в PATCH это видно только со «склеенным» состоянием.
        const hour = b.pricePerHour !== undefined ? (b.pricePerHour ?? null) : ex.pricePerHour;
        const shift = b.pricePerShift !== undefined ? (b.pricePerShift ?? null) : ex.pricePerShift;
        if (hour == null && shift == null) {
          throw err.unprocessable('Укажите хотя бы одну цену — за час или за смену');
        }
        if (b.lessorId !== undefined) set.lessorId = b.lessorId;
        if (b.description !== undefined) set.description = b.description;
        if (b.pricePerHour !== undefined) set.pricePerHour = money(b.pricePerHour);
        if (b.pricePerShift !== undefined) set.pricePerShift = money(b.pricePerShift);
        if (b.shiftHours !== undefined) set.shiftHours = b.shiftHours ?? null;
      }

      await db.update(vehicles).set(set).where(eq(vehicles.id, id));
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle.update',
        entityType: 'vehicle',
        entityId: id,
        metadata: { ownership: ex.ownership },
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
      // Уникальность считается только среди живых — при восстановлении сверяем заново.
      if (ex.registrationNumber) await assertRegUnique(ex.registrationNumber, id);
      if (ex.ownership === 'rental' && ex.lessorId) {
        await assertRentalOfferFree(
          ex.lessorId,
          ex.vehicleTypeId,
          ex.vehicleCategoryId,
          ex.description,
          id,
        );
      }
      await db
        .update(vehicles)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(vehicles.id, id));
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
