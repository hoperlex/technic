import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq } from 'drizzle-orm';
import {
  type WasteTariffDto,
  resolveWasteTariffQuerySchema,
  wasteTariffListQuerySchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { containerTypes, wasteTariffs, wasteTypes } from '../db/schema';
import { err } from '../lib/errors';
import { orderByFrom, pageParams } from '../lib/pagination';
import { resolveWasteTariff } from '../services/waste-pricing';

const dtoColumns = {
  id: wasteTariffs.id,
  wasteTypeId: wasteTariffs.wasteTypeId,
  wasteTypeName: wasteTypes.name,
  containerTypeId: wasteTariffs.containerTypeId,
  containerTypeName: containerTypes.name,
  containerKind: wasteTariffs.containerKind,
  pricePerM3: wasteTariffs.pricePerM3,
  pricePerContainer: wasteTariffs.pricePerContainer,
  isPerContainer: wasteTariffs.isPerContainer,
  note: wasteTariffs.note,
  isActive: wasteTariffs.isActive,
};

// Прайс вывоза мусора (ADR 0009). Только чтение: цены задаются миграцией, а в заявке остаётся
// снимок применённого тарифа, поэтому изменение прайса не переписывает оформленные суммы.
export default async function wasteTariffsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ── Подбор тарифа под пару «тип мусора × техника» (предпросмотр цены в форме заявки) ──
  // Объявлен до '/:id'-подобных маршрутов не случайно: статический сегмент должен матчиться первым.
  r.get(
    '/resolve',
    { preHandler: [app.authenticate], schema: { querystring: resolveWasteTariffQuerySchema } },
    async (req) => {
      const { wasteTypeId, containerTypeId } = req.query;
      const resolved = await resolveWasteTariff(wasteTypeId, containerTypeId);
      if (!resolved) throw err.notFound('Тариф для выбранной пары не задан');
      return resolved;
    },
  );

  // ── Список тарифов ──
  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: wasteTariffListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.wasteTypeId ? eq(wasteTariffs.wasteTypeId, q.wasteTypeId) : undefined,
        q.containerTypeId ? eq(wasteTariffs.containerTypeId, q.containerTypeId) : undefined,
        q.isActive === undefined ? undefined : eq(wasteTariffs.isActive, q.isActive),
      );
      const sortCols = {
        wasteTypeName: wasteTypes.name,
        pricePerM3: wasteTariffs.pricePerM3,
        isActive: wasteTariffs.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select(dtoColumns)
          .from(wasteTariffs)
          .innerJoin(wasteTypes, eq(wasteTariffs.wasteTypeId, wasteTypes.id))
          .leftJoin(containerTypes, eq(wasteTariffs.containerTypeId, containerTypes.id))
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'wasteTypeName'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(wasteTariffs).where(where),
      ]);
      const items: WasteTariffDto[] = rows.map((t) => ({
        id: t.id,
        wasteTypeId: t.wasteTypeId,
        wasteTypeName: t.wasteTypeName,
        containerTypeId: t.containerTypeId,
        containerTypeName: t.containerTypeName,
        containerKind: t.containerKind,
        pricePerM3: Number(t.pricePerM3),
        pricePerContainer: t.pricePerContainer == null ? null : Number(t.pricePerContainer),
        isPerContainer: t.isPerContainer,
        note: t.note,
        isActive: t.isActive,
      }));
      return { items, total: Number(totalRows[0]!.c), page: p.page, pageSize: p.pageSize };
    },
  );
}
