import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq } from 'drizzle-orm';
import { type WasteTypeDto, wasteTypeListQuerySchema } from '@technic/contracts';
import { db } from '../db/client';
import { wasteTypes } from '../db/schema';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

// Справочник типов мусора (ADR 0009). Только чтение: состав задан прайсом и меняется миграцией —
// произвольное заведение типов сделало бы часть заявок нетарифицируемыми.
export default async function wasteTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: wasteTypeListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(wasteTypes.isActive, q.isActive),
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
      const items: WasteTypeDto[] = rows.map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        description: t.description,
        sortOrder: t.sortOrder,
        isActive: t.isActive,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
      }));
      return { items, total: Number(totalRows[0]!.c), page: p.page, pageSize: p.pageSize };
    },
  );
}
