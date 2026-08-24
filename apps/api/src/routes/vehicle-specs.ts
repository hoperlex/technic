import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  createVehicleSpecSchema,
  updateVehicleSpecSchema,
  vehicleSpecListQuerySchema,
  type VehicleSpecDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { vehicleSpecs, vehicleTypeSpecs } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';

// Справочник ТТХ (ADR 0016): глобальные характеристики, из значений которых складываются категории
// типов ТС. Удаления нет — деактивация через PATCH isActive, и та запрещена, пока ТТХ привязан
// к типам. `code` неизменяем всегда; `unit`/`decimals` замораживаются с первой привязки: они
// входят в смысл канонизации значений и молча переопределили бы уже заведённые категории.

const idParams = z.object({ id: z.string().uuid() });

/**
 * Ссылка на строку ТТХ ИЗВНЕ подзапроса — отдельным `sql`-объектом. Здесь это не запас на будущее, а
 * заплата на живом месте: оба запроса файла идут `from(vehicleSpecs)` БЕЗ соединений, а собирая
 * список столбцов односоставного запроса, drizzle переписывает колоночные чанки в голые
 * идентификаторы (замерено `toSQL()`, drizzle 0.45.2) — до выноса отсюда уходило
 * `WHERE "spec_id" = "id"`.
 *
 * Считалось при этом верно, и вот почему: голое имя Postgres ищет в самом внутреннем `FROM`, а у
 * `vehicle_type_specs` своего `id` нет (ключ составной, `vehicle_type_id + spec_id`) — не найдя,
 * он выходит наружу, к `vehicle_specs.id`, то есть туда, куда и требовалось. Правильность держалась
 * на ФОРМЕ СОСЕДНЕЙ ТАБЛИЦЫ, а не на этом запросе: заведи миграция суррогатный `id` у связки — как
 * он есть у большинства связок этой базы, — и `"spec_id" = "id"` стало бы сравнением строки связки
 * с самой собой. Счётчик обнулился бы молча, а на нём стоит запрет гасить ТТХ, привязанный к типам
 * (`usedInTypes > 0` ниже): запрет перестал бы срабатывать, и `unit` у привязанного ТТХ поменялся
 * бы, переопределив уже заведённые категории.
 *
 * Вынос это снимает: ссылка остаётся квалифицированной в любом контексте. Ответ не меняется —
 * сверено на справочнике: 6 строк из 6 совпали, сумма привязок 16 и до, и после.
 */
const usedInTypes = sql<number>`(
  SELECT count(*) FROM ${vehicleTypeSpecs} WHERE ${vehicleTypeSpecs.specId} = ${sql`${vehicleSpecs.id}`}
)`;

const dtoColumns = {
  id: vehicleSpecs.id,
  code: vehicleSpecs.code,
  name: vehicleSpecs.name,
  shortName: vehicleSpecs.shortName,
  unit: vehicleSpecs.unit,
  decimals: vehicleSpecs.decimals,
  minValue: vehicleSpecs.minValue,
  maxValue: vehicleSpecs.maxValue,
  description: vehicleSpecs.description,
  sortOrder: vehicleSpecs.sortOrder,
  isActive: vehicleSpecs.isActive,
  usedInTypes,
  createdAt: vehicleSpecs.createdAt,
  updatedAt: vehicleSpecs.updatedAt,
};

type DtoRow = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  unit: string;
  decimals: number;
  minValue: string | null;
  maxValue: string | null;
  description: string;
  sortOrder: number;
  isActive: boolean;
  usedInTypes: number;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(r: DtoRow): VehicleSpecDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    shortName: r.shortName,
    unit: r.unit,
    decimals: Number(r.decimals),
    minValue: r.minValue == null ? null : Number(r.minValue),
    maxValue: r.maxValue == null ? null : Number(r.maxValue),
    description: r.description,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    usedInTypes: Number(r.usedInTypes),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** numeric-колонка принимает строку; null остаётся null (границы ТТХ необязательны). */
function numericOrNull(v: number | null): string | null {
  return v == null ? null : String(v);
}

async function getDtoById(id: string): Promise<VehicleSpecDto | undefined> {
  const [row] = await db.select(dtoColumns).from(vehicleSpecs).where(eq(vehicleSpecs.id, id));
  return row ? toDto(row) : undefined;
}

export default async function vehicleSpecsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  // ── Список ──
  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: vehicleSpecListQuerySchema },
    },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(vehicleSpecs.isActive, q.isActive),
        searchCondition(q.search, [vehicleSpecs.code, vehicleSpecs.name, vehicleSpecs.unit]),
      );
      const sortCols = {
        code: vehicleSpecs.code,
        name: vehicleSpecs.name,
        unit: vehicleSpecs.unit,
        sortOrder: vehicleSpecs.sortOrder,
        isActive: vehicleSpecs.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns)
          .from(vehicleSpecs)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(vehicleSpecs).where(where),
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
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const dto = await getDtoById(req.params.id);
      if (!dto) throw err.notFound('ТТХ не найден');
      return dto;
    },
  );

  // ── Создание ──
  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createVehicleSpecSchema } },
    async (req, reply) => {
      const body = req.body;
      const dupCode = await db
        .select({ id: vehicleSpecs.id })
        .from(vehicleSpecs)
        .where(eq(vehicleSpecs.code, body.code));
      if (dupCode.length > 0) throw err.conflict('ТТХ с таким кодом уже существует');

      // Пара «наименование + единица» уникальна: два «Грузоподъёмность, т» развели бы категории
      // по двум одинаковым характеристикам (тот же индекс есть и в БД).
      const dupName = await db
        .select({ id: vehicleSpecs.id })
        .from(vehicleSpecs)
        .where(
          and(
            sql`lower(btrim(${vehicleSpecs.name})) = lower(btrim(${body.name}))`,
            sql`lower(btrim(${vehicleSpecs.unit})) = lower(btrim(${body.unit}))`,
          ),
        );
      if (dupName.length > 0) {
        throw err.conflict('ТТХ с таким наименованием и единицей измерения уже существует');
      }

      const [created] = await db
        .insert(vehicleSpecs)
        .values({
          code: body.code,
          name: body.name,
          shortName: body.shortName,
          unit: body.unit,
          decimals: body.decimals,
          minValue: numericOrNull(body.minValue ?? null),
          maxValue: numericOrNull(body.maxValue ?? null),
          description: body.description,
          sortOrder: body.sortOrder,
          isActive: body.isActive,
        })
        .returning({ id: vehicleSpecs.id });
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'vehicle_spec.create',
        entityType: 'vehicle_spec',
        entityId: created!.id,
        metadata: { code: body.code, unit: body.unit, decimals: body.decimals },
      });
      reply.code(201);
      return (await getDtoById(created!.id))!;
    },
  );

  // ── Обновление ──
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateVehicleSpecSchema },
    },
    async (req) => {
      const id = req.params.id;
      const body = req.body;
      const current = await getDtoById(id);
      if (!current) throw err.notFound('ТТХ не найден');

      if (current.usedInTypes > 0) {
        if (body.unit !== undefined && body.unit !== current.unit) {
          throw err.unprocessable(
            'Единицу измерения нельзя изменить: ТТХ уже привязан к типам, значения категорий заданы в ней',
          );
        }
        if (body.decimals !== undefined && body.decimals !== current.decimals) {
          throw err.unprocessable(
            'Точность нельзя изменить: ТТХ уже привязан к типам, она входит в канонизацию значений',
          );
        }
        if (body.isActive === false) {
          throw err.conflict(
            `ТТХ привязан к типам ТС (${current.usedInTypes}) — сначала отвяжите его от них`,
          );
        }
      }

      const nextMin = body.minValue === undefined ? current.minValue : body.minValue;
      const nextMax = body.maxValue === undefined ? current.maxValue : body.maxValue;
      if (nextMin != null && nextMax != null && nextMin > nextMax) {
        throw err.unprocessable('Минимум не может быть больше максимума');
      }

      if (body.name !== undefined || body.unit !== undefined) {
        const nextName = body.name ?? current.name;
        const nextUnit = body.unit ?? current.unit;
        const dup = await db
          .select({ id: vehicleSpecs.id })
          .from(vehicleSpecs)
          .where(
            and(
              sql`lower(btrim(${vehicleSpecs.name})) = lower(btrim(${nextName}))`,
              sql`lower(btrim(${vehicleSpecs.unit})) = lower(btrim(${nextUnit}))`,
            ),
          );
        if (dup.some((d) => d.id !== id)) {
          throw err.conflict('ТТХ с таким наименованием и единицей измерения уже существует');
        }
      }

      await db
        .update(vehicleSpecs)
        .set({
          name: body.name,
          shortName: body.shortName,
          unit: body.unit,
          decimals: body.decimals,
          minValue: body.minValue === undefined ? undefined : numericOrNull(body.minValue),
          maxValue: body.maxValue === undefined ? undefined : numericOrNull(body.maxValue),
          description: body.description,
          sortOrder: body.sortOrder,
          isActive: body.isActive,
          updatedAt: new Date(),
        })
        .where(eq(vehicleSpecs.id, id));

      const activeChanged = body.isActive !== undefined && body.isActive !== current.isActive;
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: activeChanged
          ? body.isActive
            ? 'vehicle_spec.activate'
            : 'vehicle_spec.deactivate'
          : 'vehicle_spec.update',
        entityType: 'vehicle_spec',
        entityId: id,
        metadata: { code: current.code, oldName: current.name, newName: body.name ?? current.name },
      });
      return (await getDtoById(id))!;
    },
  );

  // Удаление насовсем (ADR 0060). Отдельной проверки на привязки к типам не нужно: деактивировать
  // привязанный ТТХ и так нельзя, а значит до удаления доходит только отвязанный.
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(vehicleSpecs).where(eq(vehicleSpecs.id, id));
      return row;
    },
    isDown: (row) => !row.isActive,
    remove: async (tx, row) => {
      await tx.delete(vehicleSpecs).where(eq(vehicleSpecs.id, row.id));
    },
    notFound: 'ТТХ не найден',
    stillLive: 'ТТХ активен — сначала деактивируйте его',
    subject: 'ТТХ',
    audit: {
      action: 'vehicle_spec.purge',
      entityType: 'vehicle_spec',
      metadata: (row) => ({ code: row.code, name: row.name, unit: row.unit }),
    },
  });
}
