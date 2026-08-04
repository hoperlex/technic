import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, exists, notExists } from 'drizzle-orm';
import {
  updateWasteTypeSchema,
  type WasteTypeDto,
  wasteTypeListQuerySchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { wasteTariffs, wasteTypes, type WasteTypeRow } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';
import { assertWasteTypeNameFree, asWasteTypeNameConflict } from '../services/waste-types';

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

/** Есть ли у типа хоть одна действующая позиция прайса. */
function withActiveTariff(has: boolean) {
  const tariff = db
    .select({ id: wasteTariffs.id })
    .from(wasteTariffs)
    .where(and(eq(wasteTariffs.wasteTypeId, wasteTypes.id), eq(wasteTariffs.isActive, true)));
  return has ? exists(tariff) : notExists(tariff);
}

// Типы мусора (ADR 0009, ведение — ADR 0017): «что вывозим». Читают все, правят администратор и
// менеджер. Отдельной вкладки у типов больше нет: заводятся они вместе с первой ценой
// (POST /waste-tariffs), а этот маршрут отдаёт список для выбора и правит название с активностью
// из строки тарифа. Удаления нет: на тип ссылаются заявки и позиции прайса, выбытие — isActive.
export default async function wasteTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  r.get(
    '/',
    { preHandler: [app.authenticate, canRead], schema: { querystring: wasteTypeListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(wasteTypes.isActive, q.isActive),
        // Форма заявки спрашивает типы с действующей ценой: выбор типа без тарифа кончался бы
        // отказом «тариф не найден» уже при сохранении заявки.
        q.hasActiveTariff === undefined ? undefined : withActiveTariff(q.hasActiveTariff),
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

  // Заведения типа тут нет: тип появляется вместе с первой ценой (POST /waste-tariffs, ADR 0017).
  // Иначе брошенная на полпути форма оставляла бы тип без цены, а править такой тип негде —
  // его интерфейс живёт в строке тарифа.
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateWasteTypeSchema },
    },
    async (req) => {
      // Переименование проверяется тем же правилом, что и заведение: иначе дубль, запрещённый
      // при создании, заводился бы правкой соседней строки.
      if (req.body.name !== undefined) {
        await assertWasteTypeNameFree(db, req.body.name, {
          field: 'name',
          excludeId: req.params.id,
        });
      }
      const [updated] = await db
        .update(wasteTypes)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(wasteTypes.id, req.params.id))
        .returning()
        .catch((e: unknown) => {
          throw asWasteTypeNameConflict(e, 'name');
        });
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

  // Удаление насовсем (ADR 0060). Цены прайса — не часть типа, а самостоятельные записи своих
  // операторов: тип с ценами держит внешний ключ, и убирают их из прайса отдельно.
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(wasteTypes).where(eq(wasteTypes.id, id));
      return row;
    },
    isDown: (row) => !row.isActive,
    remove: async (tx, row) => {
      await tx.delete(wasteTypes).where(eq(wasteTypes.id, row.id));
    },
    notFound: 'Тип мусора не найден',
    stillLive: 'Тип мусора активен — сначала деактивируйте его',
    subject: 'тип мусора',
    audit: {
      action: 'waste_type.purge',
      entityType: 'waste_type',
      metadata: (row) => ({ code: row.code, name: row.name }),
    },
  });
}
