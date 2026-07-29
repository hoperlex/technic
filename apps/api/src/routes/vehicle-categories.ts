import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import {
  buildVehicleCategoryName,
  createVehicleCategorySchema,
  updateVehicleCategorySchema,
  vehicleCategoryListQuerySchema,
  type VehicleCategoryDto,
  type VehicleCategoryValueDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  vehicleCategories,
  vehicleCategorySpecValues,
  vehicleKinds,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import {
  assertNameFree,
  assertSignatureFree,
  checkedValues,
  loadTypeSpecs,
  lockType,
  signatureOf,
  valueDtos,
  valueToColumn,
  valuesByCategoryIds,
} from '../services/vehicle-categories';

// Категории типов ТС (ADR 0016) — условные подтипы, заданные набором значений ТТХ. Комбинации не
// генерируются перебором: активные категории заводит человек либо приносит seed-миграция.
// Все изменения идут в транзакции с блокировкой строки типа: состав ТТХ у типа и категории этого
// типа — один инвариант, править их одновременно нельзя.

const idParams = z.object({ id: z.string().uuid() });

const dtoColumns = {
  id: vehicleCategories.id,
  vehicleTypeId: vehicleCategories.vehicleTypeId,
  typeName: vehicleTypes.name,
  kindName: vehicleKinds.name,
  name: vehicleCategories.name,
  isAutoName: vehicleCategories.isAutoName,
  specSignature: vehicleCategories.specSignature,
  sortOrder: vehicleCategories.sortOrder,
  isActive: vehicleCategories.isActive,
  createdAt: vehicleCategories.createdAt,
  updatedAt: vehicleCategories.updatedAt,
};

type DtoRow = {
  id: string;
  vehicleTypeId: string;
  typeName: string;
  kindName: string;
  name: string;
  isAutoName: boolean;
  specSignature: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(r: DtoRow, values: VehicleCategoryValueDto[]): VehicleCategoryDto {
  return {
    id: r.id,
    vehicleTypeId: r.vehicleTypeId,
    typeName: r.typeName,
    kindName: r.kindName,
    name: r.name,
    isAutoName: r.isAutoName,
    specSignature: r.specSignature,
    values,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Значения грузятся одним запросом на страницу: список категорий не должен порождать запрос на строку. */
async function toDtos(rows: DtoRow[]): Promise<VehicleCategoryDto[]> {
  const values = await valuesByCategoryIds(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toDto(r, values.get(r.id) ?? []));
}

async function getDtoById(id: string): Promise<VehicleCategoryDto | undefined> {
  const [row] = await db
    .select(dtoColumns)
    .from(vehicleCategories)
    .innerJoin(vehicleTypes, eq(vehicleCategories.vehicleTypeId, vehicleTypes.id))
    .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
    .where(eq(vehicleCategories.id, id));
  if (!row) return undefined;
  return (await toDtos([row]))[0];
}

export default async function vehicleCategoriesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  // ── Список ──
  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: vehicleCategoryListQuerySchema },
    },
    async (req) => {
      const q = req.query;
      const where = and(
        q.vehicleTypeId ? eq(vehicleCategories.vehicleTypeId, q.vehicleTypeId) : undefined,
        q.isActive === undefined ? undefined : eq(vehicleCategories.isActive, q.isActive),
        searchCondition(q.search, [vehicleCategories.name]),
      );
      const sortCols = {
        name: vehicleCategories.name,
        typeName: vehicleTypes.name,
        sortOrder: vehicleCategories.sortOrder,
        isActive: vehicleCategories.isActive,
        createdAt: vehicleCategories.createdAt,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns)
          .from(vehicleCategories)
          .innerJoin(vehicleTypes, eq(vehicleCategories.vehicleTypeId, vehicleTypes.id))
          .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db
          .select({ c: count() })
          .from(vehicleCategories)
          .innerJoin(vehicleTypes, eq(vehicleCategories.vehicleTypeId, vehicleTypes.id))
          .where(where),
      ]);
      return {
        items: await toDtos(rows),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  // ── Одна запись ──
  r.get(
    '/:id',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const dto = await getDtoById(req.params.id);
      if (!dto) throw err.notFound('Категория не найдена');
      return dto;
    },
  );

  // ── Создание ──
  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createVehicleCategorySchema } },
    async (req, reply) => {
      const body = req.body;
      const createdId = await db.transaction(async (tx) => {
        const type = await lockType(tx, body.vehicleTypeId);
        const specs = await loadTypeSpecs(tx, type.id);
        const values = checkedValues(body.values, specs);

        const signature = await signatureOf(tx, specs, values);
        await assertSignatureFree(tx, type.id, signature);

        const name = body.name ?? buildVehicleCategoryName(type.name, valueDtos(specs, values));
        await assertNameFree(tx, type.id, name);

        const [inserted] = await tx
          .insert(vehicleCategories)
          .values({
            vehicleTypeId: type.id,
            name,
            isAutoName: body.name === undefined,
            specSignature: signature,
            sortOrder: body.sortOrder,
            isActive: body.isActive,
          })
          .returning({ id: vehicleCategories.id });
        const id = inserted!.id;

        // Категория и её значения вставляются в одной транзакции: инвариант полноты проверяется
        // отложенным триггером на COMMIT, поэтому промежуточное состояние допустимо.
        await tx.insert(vehicleCategorySpecValues).values(
          specs.map((s) => ({
            categoryId: id,
            vehicleTypeId: type.id,
            specId: s.specId,
            valueNum: valueToColumn(values.get(s.specId)!, s),
          })),
        );
        return id;
      });

      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle_category.create',
        entityType: 'vehicle_category',
        entityId: createdId,
        metadata: { vehicleTypeId: body.vehicleTypeId },
      });
      reply.code(201);
      return (await getDtoById(createdId))!;
    },
  );

  // ── Обновление ──
  // Тип категории неизменяем: смена типа — это другая сущность. Правка значений меняет
  // идентичность категории; когда на неё начнут ссылаться техника и заявки, её нужно будет
  // запретить (ADR 0016 §10).
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateVehicleCategorySchema },
    },
    async (req) => {
      const id = req.params.id;
      const body = req.body;
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(vehicleCategories)
          .where(eq(vehicleCategories.id, id));
        if (!before) throw err.notFound('Категория не найдена');
        const type = await lockType(tx, before.vehicleTypeId);
        const specs = await loadTypeSpecs(tx, type.id);

        let nextValues: VehicleCategoryValueDto[] | undefined;
        if (body.values) {
          const values = checkedValues(body.values, specs);
          const signature = await signatureOf(tx, specs, values);
          await assertSignatureFree(tx, type.id, signature, id);
          nextValues = valueDtos(specs, values);
          for (const s of specs) {
            await tx
              .update(vehicleCategorySpecValues)
              .set({ valueNum: valueToColumn(values.get(s.specId)!, s) })
              .where(
                and(
                  eq(vehicleCategorySpecValues.categoryId, id),
                  eq(vehicleCategorySpecValues.specId, s.specId),
                ),
              );
          }
          await tx
            .update(vehicleCategories)
            .set({ specSignature: signature })
            .where(eq(vehicleCategories.id, id));
        }

        // Пустая строка в name возвращает автогенерацию наименования.
        const manualName = body.name !== undefined && body.name !== '' ? body.name : undefined;
        const backToAuto = body.name === '';
        const isAutoName = manualName ? false : backToAuto ? true : before.isAutoName;

        let name = manualName ?? before.name;
        if (!manualName && isAutoName) {
          const current = nextValues ?? (await valuesByCategoryIds(tx, [id])).get(id) ?? [];
          name = buildVehicleCategoryName(type.name, current);
        }
        if (name !== before.name) await assertNameFree(tx, type.id, name, id);

        await tx
          .update(vehicleCategories)
          .set({
            name,
            isAutoName,
            sortOrder: body.sortOrder,
            isActive: body.isActive,
            updatedAt: new Date(),
          })
          .where(eq(vehicleCategories.id, id));
      });

      const activeChanged = body.isActive !== undefined;
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: activeChanged
          ? body.isActive
            ? 'vehicle_category.activate'
            : 'vehicle_category.deactivate'
          : 'vehicle_category.update',
        entityType: 'vehicle_category',
        entityId: id,
        metadata: { valuesChanged: body.values !== undefined },
      });
      return (await getDtoById(id))!;
    },
  );

  // ── Удаление ──
  // Осознанное отступление от «удаления нет» (ADR 0016 §13): категории заводятся при наполнении
  // справочника, ошибочную запись нужно вычищать, а не держать неактивным мусором в списках.
  // Ссылающихся сущностей пока нет; с их появлением здесь встанет проверка ссылок и 409.
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const id = req.params.id;
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: vehicleCategories.id, vehicleTypeId: vehicleCategories.vehicleTypeId })
          .from(vehicleCategories)
          .where(eq(vehicleCategories.id, id));
        if (!row) throw err.notFound('Категория не найдена');
        await lockType(tx, row.vehicleTypeId);
        // Значения уйдут каскадом по составному FK на (id, vehicle_type_id).
        await tx.delete(vehicleCategories).where(eq(vehicleCategories.id, id));
      });
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle_category.delete',
        entityType: 'vehicle_category',
        entityId: id,
      });
      return { ok: true };
    },
  );
}
