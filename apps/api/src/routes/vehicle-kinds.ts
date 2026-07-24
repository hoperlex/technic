import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq } from 'drizzle-orm';
import { vehicleKindListQuerySchema, type VehicleKindDto } from '@technic/contracts';
import { db } from '../db/client';
import { vehicleKinds, type VehicleKindRow } from '../db/schema';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

function toDto(r: VehicleKindRow): VehicleKindDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Виды ТС — управляемый справочник верхнего уровня («Спецтехника»/«Грузоперевозки»).
 * На этапе 2.1 доступно только чтение (источник для фильтра/Select в типах ТС).
 */
export default async function vehicleKindsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: vehicleKindListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(vehicleKinds.isActive, q.isActive),
        searchCondition(q.search, [vehicleKinds.code, vehicleKinds.name]),
      );
      const sortCols = {
        code: vehicleKinds.code,
        name: vehicleKinds.name,
        sortOrder: vehicleKinds.sortOrder,
        isActive: vehicleKinds.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(vehicleKinds)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(vehicleKinds).where(where),
      ]);
      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );
}
