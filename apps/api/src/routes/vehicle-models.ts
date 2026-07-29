import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq } from 'drizzle-orm';
import { type VehicleModelDto, vehicleModelListQuerySchema } from '@technic/contracts';
import { db } from '../db/client';
import { vehicleModels } from '../db/schema';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

// Read-only: список марок/моделей для селекта в форме техники (не отдельный справочник, ADR 0007).
export default async function vehicleModelsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');

  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: vehicleModelListQuerySchema },
    },
    async (req) => {
      const q = req.query;
      const where = and(
        q.vehicleTypeId ? eq(vehicleModels.vehicleTypeId, q.vehicleTypeId) : undefined,
        q.isActive === undefined ? undefined : eq(vehicleModels.isActive, q.isActive),
        searchCondition(q.search, [vehicleModels.name]),
      );
      const sortCols = { name: vehicleModels.name, createdAt: vehicleModels.createdAt };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: vehicleModels.id,
            vehicleTypeId: vehicleModels.vehicleTypeId,
            name: vehicleModels.name,
            manufacturerName: vehicleModels.manufacturerName,
            isActive: vehicleModels.isActive,
          })
          .from(vehicleModels)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'name'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(vehicleModels).where(where),
      ]);
      const items: VehicleModelDto[] = rows;
      return { items, total: Number(totalRows[0]!.c), page: p.page, pageSize: p.pageSize };
    },
  );
}
