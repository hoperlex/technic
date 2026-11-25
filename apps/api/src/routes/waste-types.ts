import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, exists, notExists } from 'drizzle-orm';
import {
  isServiceWasteTypeId,
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
import {
  assertWasteTypeNameFree,
  asServiceWasteTypeRefusal,
  asWasteTypeNameConflict,
  editableWasteTypes,
  isServiceWasteTypeRow,
  SERVICE_WASTE_TYPE_LOCKED_MESSAGE,
  serviceWasteTypeEditRefusal,
} from '../services/waste-types';

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
        // The service type «Снег» is set by the server on snow requests (S2): it is neither chosen
        // in a garbage request nor priced or edited here. A snow request still shows it — the
        // request DTO carries the type name from its own join, not from this list.
        editableWasteTypes(),
        q.isActive === undefined ? undefined : eq(wasteTypes.isActive, q.isActive),
        // The request form asks for types with an active price: choosing a type without a tariff
        // would end in «тариф не найден» only when the request is saved.
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

  // There is no creation here: a type appears together with its first price (POST /waste-tariffs,
  // ADR 0017). Otherwise a form abandoned halfway would leave a type without a price, and such a
  // type could not be edited anywhere — its interface lives in the tariff row.
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateWasteTypeSchema },
    },
    async (req) => {
      // The service row «Снег» (S10) is refused before any query and in field words: the database
      // would refuse a rename or deactivation too, but only by a constraint name. The id is
      // compared as a UUID — an uppercase spelling still names the reserved row — and the loaded
      // row is checked by its code as well.
      const sent = Object.keys(req.body);
      if (isServiceWasteTypeId(req.params.id)) throw serviceWasteTypeEditRefusal(sent);
      const [current] = await db
        .select({ id: wasteTypes.id, code: wasteTypes.code })
        .from(wasteTypes)
        .where(eq(wasteTypes.id, req.params.id));
      if (!current) throw err.notFound('Тип мусора не найден');
      if (isServiceWasteTypeRow(current)) throw serviceWasteTypeEditRefusal(sent);

      // A rename is checked by the same rule as creation: otherwise a duplicate refused on
      // creation would be made by editing a neighbouring row, and the reserved name «Снег» would
      // be taken by an ordinary, priced type.
      if (req.body.name !== undefined) {
        await assertWasteTypeNameFree(db, req.body.name, {
          field: 'name',
          excludeId: current.id,
        });
      }
      const [updated] = await db
        .update(wasteTypes)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(wasteTypes.id, req.params.id))
        .returning()
        .catch((e: unknown) => {
          throw asServiceWasteTypeRefusal(asWasteTypeNameConflict(e, 'name'), 'name');
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

  // Purge (ADR 0060). Prices are not part of the type but records of their operators: a type with
  // prices is held by the foreign key, and they are removed from the price list separately.
  registerPurgeRoute(app, {
    load: async (id) => {
      // The service row is never purged (S10). It is always active, so without this refusal the
      // person would be told to deactivate it first — a step its CHECK forbids. Refused by the id
      // (any case) before the query and by the code of the loaded row.
      if (isServiceWasteTypeId(id)) throw err.conflict(SERVICE_WASTE_TYPE_LOCKED_MESSAGE);
      const [row] = await db.select().from(wasteTypes).where(eq(wasteTypes.id, id));
      if (row && isServiceWasteTypeRow(row)) throw err.conflict(SERVICE_WASTE_TYPE_LOCKED_MESSAGE);
      return row;
    },
    isDown: (row) => !row.isActive,
    remove: async (tx, row) => {
      await tx
        .delete(wasteTypes)
        .where(eq(wasteTypes.id, row.id))
        .catch((e: unknown) => {
          throw asServiceWasteTypeRefusal(e, 'id');
        });
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
