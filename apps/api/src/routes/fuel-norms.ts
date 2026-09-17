import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import {
  createFuelNormSchema,
  fuelNormListQuerySchema,
  updateFuelNormSchema,
  updateFuelNormSettingsSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  fuelNormSettings,
  vehicleCategories,
  vehicleFuelNorms,
  vehicleModels,
  vehicles,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import {
  fuelNormOrder,
  fuelNormSelection,
  loadFuelNormSettings,
  toFuelNormDto,
} from '../services/fuel-norms';

/**
 * Справочник норм расхода топлива (план `docs/fuel-norms-plan.md`, §2; таблицы — миграция 0314).
 *
 * Ручек шесть: список версий, заведение, правка, снятие и пара на настройки сверки. Права —
 * общие права модуля справочников (Р19): своего права волна не заводит, потому что у справочников
 * они одни на весь раздел, а не по вкладкам.
 *
 * Два правила записи, и оба из плана:
 *
 * 1. **Правка заводит новую версию, а не переписывает прошлое** (Р6) — это делает окно, посылая
 *    заведение с новой датой. Ручка правки нужна для другого: поправить только что заведённую
 *    версию (опечатку в ставке), и она честно предупреждает окно, что правит уже действующую
 *    запись.
 * 2. **Совпадение даты перезаписывает версию этой даты** (Р7а): уникальность стоит на паре «машина
 *    + действует с», и человек, поправивший опечатку через час, обязан получить сохранение, а не
 *    отказ базы.
 */

const idParams = z.object({ id: z.string().uuid() });

/** Живая версия машины на ту же дату — ту, что перезапишется по Р7а. */
async function versionOn(vehicleId: string, effectiveFrom: string) {
  const [row] = await db
    .select({ id: vehicleFuelNorms.id })
    .from(vehicleFuelNorms)
    .where(
      and(
        eq(vehicleFuelNorms.vehicleId, vehicleId),
        eq(vehicleFuelNorms.effectiveFrom, effectiveFrom),
        isNull(vehicleFuelNorms.deletedAt),
      ),
    );
  return row;
}

export default async function fuelNormsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: fuelNormListQuerySchema },
    },
    async (req) => {
      const q = req.query;
      const selection = fuelNormSelection();
      const where = and(
        isNull(vehicleFuelNorms.deletedAt),
        q.vehicleId === undefined ? undefined : eq(vehicleFuelNorms.vehicleId, q.vehicleId),
        searchCondition(q.search, [vehicles.registrationNumber, vehicles.description]),
      );
      const p = pageParams(q);
      const sortCols = {
        registrationNumber: vehicles.registrationNumberNormalized,
        effectiveFrom: vehicleFuelNorms.effectiveFrom,
        winterRate: vehicleFuelNorms.winterRate,
        summerRate: vehicleFuelNorms.summerRate,
      };
      const rows = await db
        .select(selection)
        .from(vehicleFuelNorms)
        .innerJoin(vehicles, eq(vehicles.id, vehicleFuelNorms.vehicleId))
        .innerJoin(vehicleTypes, eq(vehicleTypes.id, vehicles.vehicleTypeId))
        .leftJoin(vehicleCategories, eq(vehicleCategories.id, vehicles.vehicleCategoryId))
        .leftJoin(vehicleModels, eq(vehicleModels.id, vehicles.vehicleModelId))
        .where(where)
        .orderBy(
          q.sortBy === undefined
            ? sql.join(fuelNormOrder, sql`, `)
            : orderByFrom(sortCols, q.sortBy, q.sortOrder, 'effectiveFrom'),
        );
      /*
       * Отбор «только действующие» ставится ПОСЛЕ выборки, а не условием запроса, и это не лень:
       * «действующая» — это максимум наступивших дат в окне по машине, то есть оконная функция, а
       * условие на оконную функцию в `WHERE` не ставится. Версий у машины единицы, поэтому набор
       * до отбора не больше самого справочника.
       */
      const filtered = q.currentOnly === true ? rows.filter((row) => row.isCurrent) : rows;
      const page = filtered.slice((p.page - 1) * p.pageSize, p.page * p.pageSize);
      return {
        items: page.map(toFuelNormDto),
        total: filtered.length,
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createFuelNormSchema } },
    async (req, reply) => {
      const body = req.body;
      const [vehicle] = await db
        .select({ id: vehicles.id })
        .from(vehicles)
        .where(and(eq(vehicles.id, body.vehicleId), isNull(vehicles.deletedAt)));
      if (!vehicle) throw err.notFound('Машина не найдена');
      const actorUserId = requirePrincipal(req).id;

      // Перезапись версии той же даты (Р7а) — правка приказа того же дня, а не вторая норма.
      const twin = await versionOn(body.vehicleId, body.effectiveFrom);
      if (twin) {
        const [updated] = await db
          .update(vehicleFuelNorms)
          .set({
            unit: body.unit,
            winterRate: String(body.winterRate),
            summerRate: String(body.summerRate),
            fuelType: body.fuelType,
            note: body.note,
            updatedBy: actorUserId,
            updatedAt: new Date(),
          })
          .where(eq(vehicleFuelNorms.id, twin.id))
          .returning({ id: vehicleFuelNorms.id });
        await writeAudit({
          actorUserId,
          action: 'fuel_norm.update',
          entityType: 'fuel_norm',
          entityId: updated!.id,
          metadata: { vehicleId: body.vehicleId, effectiveFrom: body.effectiveFrom, rewritten: true },
        });
        reply.code(200);
        return { id: updated!.id };
      }

      const [created] = await db
        .insert(vehicleFuelNorms)
        .values({
          vehicleId: body.vehicleId,
          effectiveFrom: body.effectiveFrom,
          unit: body.unit,
          winterRate: String(body.winterRate),
          summerRate: String(body.summerRate),
          fuelType: body.fuelType,
          note: body.note,
          createdBy: actorUserId,
          updatedBy: actorUserId,
        })
        .returning({ id: vehicleFuelNorms.id });
      await writeAudit({
        actorUserId,
        action: 'fuel_norm.create',
        entityType: 'fuel_norm',
        entityId: created!.id,
        metadata: { vehicleId: body.vehicleId, effectiveFrom: body.effectiveFrom },
      });
      reply.code(201);
      return { id: created!.id };
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateFuelNormSchema },
    },
    async (req) => {
      const body = req.body;
      const [current] = await db
        .select({
          id: vehicleFuelNorms.id,
          vehicleId: vehicleFuelNorms.vehicleId,
          effectiveFrom: vehicleFuelNorms.effectiveFrom,
        })
        .from(vehicleFuelNorms)
        .where(and(eq(vehicleFuelNorms.id, req.params.id), isNull(vehicleFuelNorms.deletedAt)));
      if (!current) throw err.notFound('Норма не найдена');
      if (body.effectiveFrom !== undefined && body.effectiveFrom !== current.effectiveFrom) {
        const twin = await versionOn(current.vehicleId, body.effectiveFrom);
        if (twin) {
          throw err.conflict('У машины уже есть норма, действующая с этой даты');
        }
      }
      const [updated] = await db
        .update(vehicleFuelNorms)
        .set({
          ...(body.effectiveFrom === undefined ? {} : { effectiveFrom: body.effectiveFrom }),
          ...(body.unit === undefined ? {} : { unit: body.unit }),
          ...(body.winterRate === undefined ? {} : { winterRate: String(body.winterRate) }),
          ...(body.summerRate === undefined ? {} : { summerRate: String(body.summerRate) }),
          ...(body.fuelType === undefined ? {} : { fuelType: body.fuelType }),
          ...(body.note === undefined ? {} : { note: body.note }),
          updatedBy: requirePrincipal(req).id,
          updatedAt: new Date(),
        })
        .where(eq(vehicleFuelNorms.id, req.params.id))
        .returning({ id: vehicleFuelNorms.id });
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'fuel_norm.update',
        entityType: 'fuel_norm',
        entityId: req.params.id,
      });
      return { id: updated!.id };
    },
  );

  /*
   * Снятие версии — мягкое (`deleted_at`), и оно необратимо по устройству: частичная уникальность
   * позволит завести на ту же дату новую запись, и тогда снятую уже не вернуть (план, Р7б). Окно
   * спрашивает подтверждение, потому что снятие переписывает прошлые отчёты: смены возвращаются к
   * предыдущей версии нормы.
   */
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req, reply) => {
      const actorUserId = requirePrincipal(req).id;
      const [removed] = await db
        .update(vehicleFuelNorms)
        .set({ deletedAt: new Date(), deletedBy: actorUserId })
        .where(and(eq(vehicleFuelNorms.id, req.params.id), isNull(vehicleFuelNorms.deletedAt)))
        .returning({ id: vehicleFuelNorms.id });
      if (!removed) throw err.notFound('Норма не найдена');
      await writeAudit({
        actorUserId,
        action: 'fuel_norm.remove',
        entityType: 'fuel_norm',
        entityId: req.params.id,
      });
      reply.code(204);
      return null;
    },
  );

  // ── Настройки сверки ──

  r.get('/settings/current', { preHandler: [app.authenticate, canRead] }, async () =>
    loadFuelNormSettings(),
  );

  r.put(
    '/settings/current',
    { preHandler: [app.authenticate, canWrite], schema: { body: updateFuelNormSettingsSchema } },
    async (req) => {
      const actorUserId = requirePrincipal(req).id;
      const body = req.body;
      /*
       * Одиночка: строка либо есть (её сеет миграция), либо её нет — на свежей базе. `ON CONFLICT`
       * по ключу-одиночке закрывает оба случая одним запросом, не заводя второй строки: значение
       * ключа единственное, и CHECK не пустит никакое другое.
       */
      await db
        .insert(fuelNormSettings)
        .values({
          winterFromMd: body.winterFromMd,
          winterToMd: body.winterToMd,
          tolerancePercent: String(body.tolerancePercent),
          updatedBy: actorUserId,
        })
        .onConflictDoUpdate({
          target: fuelNormSettings.id,
          set: {
            winterFromMd: body.winterFromMd,
            winterToMd: body.winterToMd,
            tolerancePercent: String(body.tolerancePercent),
            updatedBy: actorUserId,
            updatedAt: new Date(),
          },
        });
      await writeAudit({
        actorUserId,
        action: 'fuel_norm_settings.update',
        entityType: 'fuel_norm_settings',
        metadata: { ...body },
      });
      return loadFuelNormSettings();
    },
  );

  // Счётчик версий — для окна, которому надо сказать «заведено N норм»: список приходит страницами,
  // а число заведённых машин отвечает на другой вопрос и считается отдельно.
  r.get('/count', { preHandler: [app.authenticate, canRead] }, async () => {
    const [row] = await db
      .select({ c: count() })
      .from(vehicleFuelNorms)
      .where(isNull(vehicleFuelNorms.deletedAt));
    return { total: Number(row!.c) };
  });
}
