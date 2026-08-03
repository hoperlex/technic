import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  createWarehouseSchema,
  updateWarehouseSchema,
  warehouseListQuerySchema,
  type WarehouseDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { counterparties, warehouses, type CounterpartyRow, type WarehouseRow } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

/**
 * Справочник складов поставщиков (ADR 0051). Склад — адрес, по которому работают с поставщиком:
 * забирают материалы или привозят их ему. Устроен как остальные справочники и с теми же правами
 * (`directories.read` / `directories.write`).
 *
 * Своё здесь два правила, и оба живут в сервисе, а не в БД: «склад заводится только у контрагента
 * типа „Поставщик“» (то же решение, что у исполнителя заявки на вывоз, ADR 0010 §6) и «пара
 * „поставщик + адрес“ уникальна» — второе держит и уникальный индекс, но проверка до вставки
 * отвечает человеку понятным текстом, а не нарушением ограничения.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

/** Нормализованную форму адреса считает БД — единственный источник истины (миграция 0077). */
const normalized = (address: string) => sql<string>`counterparty_name_normalize(${address})`;

function toDto(r: WarehouseRow, supplier: WarehouseDto['supplier']): WarehouseDto {
  return {
    id: r.id,
    supplier,
    address: r.address,
    name: r.name,
    contactPerson: r.contactPerson,
    contactPhone: r.contactPhone,
    comment: r.comment,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const supplierRef = {
  id: counterparties.id,
  name: counterparties.name,
  inn: counterparties.inn,
  isActive: counterparties.isActive,
};

/** Карточка склада всегда идёт с поставщиком: без наименования адрес ничего не называет. */
async function getDto(id: string): Promise<WarehouseDto | null> {
  const [row] = await db
    .select({ w: warehouses, supplier: supplierRef })
    .from(warehouses)
    .innerJoin(counterparties, eq(warehouses.supplierCounterpartyId, counterparties.id))
    .where(eq(warehouses.id, id));
  return row ? toDto(row.w, row.supplier) : null;
}

/**
 * Склад заводится только у поставщика: тип контрагента и задаёт смысл строки. Требование держит
 * сервис — составной FK потребовал бы вернуть снятый миграцией 0038 UNIQUE (id, type) и
 * денормализовать тип в каждую строку склада (ADR 0010 §6).
 *
 * Удалённый контрагент не годится тоже: его карточки в справочнике нет, и склад висел бы на том,
 * кого не видно.
 */
async function assertSupplier(tx: Tx, id: string): Promise<CounterpartyRow> {
  const [row] = await tx.select().from(counterparties).where(eq(counterparties.id, id));
  if (!row || row.deletedAt) {
    throw err.badRequest('Поставщик не найден', { supplierId: 'Не найден' });
  }
  if (row.type !== 'supplier') {
    throw err.badRequest('Склад заводится только у контрагента типа «Поставщик»', {
      supplierId: 'Контрагент не поставщик',
    });
  }
  return row;
}

/**
 * Пара «поставщик + адрес» уникальна: второй записи по тому же адресу у одного поставщика быть не
 * может. Сравнение — по нормализованной форме, той же, что в уникальном индексе: «ул. Ленина,
 * д. 1» и «ул Ленина д.1» — один и тот же адрес.
 */
async function assertAddressFree(
  tx: Tx,
  supplierId: string,
  address: string,
  exceptId?: string,
): Promise<void> {
  const dup = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.supplierCounterpartyId, supplierId),
        eq(warehouses.normalizedAddress, normalized(address)),
        exceptId ? ne(warehouses.id, exceptId) : undefined,
      ),
    );
  if (dup.length > 0) {
    throw err.conflict('У этого поставщика уже заведён склад по такому адресу');
  }
}

export default async function warehousesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  // Чтение доступно всем аутентифицированным: без него не отрисовать ни фильтр по поставщику,
  // ни адрес склада там, где на него сошлются.
  r.get(
    '/',
    { preHandler: [app.authenticate, canRead], schema: { querystring: warehouseListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.supplierId ? eq(warehouses.supplierCounterpartyId, q.supplierId) : undefined,
        q.isActive === undefined ? undefined : eq(warehouses.isActive, q.isActive),
        // Ищут склад и по адресу, и по тому, чей он: в разговоре его называют и так, и так.
        searchCondition(q.search, [
          warehouses.address,
          warehouses.name,
          counterparties.name,
          counterparties.inn,
        ]),
      );
      const sortCols = {
        address: warehouses.address,
        supplier: counterparties.name,
        isActive: warehouses.isActive,
        createdAt: warehouses.createdAt,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select({ w: warehouses, supplier: supplierRef })
          .from(warehouses)
          .innerJoin(counterparties, eq(warehouses.supplierCounterpartyId, counterparties.id))
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'address'))
          .limit(p.limit)
          .offset(p.offset),
        db
          .select({ c: count() })
          .from(warehouses)
          .innerJoin(counterparties, eq(warehouses.supplierCounterpartyId, counterparties.id))
          .where(where),
      ]);
      return {
        items: rows.map((row) => toDto(row.w, row.supplier)),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  r.get(
    '/:id',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => {
      const dto = await getDto(req.params.id);
      if (!dto) throw err.notFound('Склад не найден');
      return dto;
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createWarehouseSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { supplierId, ...body } = req.body;
      const created = await db.transaction(async (tx) => {
        await assertSupplier(tx, supplierId);
        await assertAddressFree(tx, supplierId, body.address);
        const [row] = await tx
          .insert(warehouses)
          .values({
            supplierCounterpartyId: supplierId,
            ...body,
            createdBy: p.id,
            updatedBy: p.id,
          })
          .returning({ id: warehouses.id });
        return row!;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'warehouse.create',
        entityType: 'warehouse',
        entityId: created.id,
        metadata: { supplierId, address: body.address },
      });
      reply.code(201);
      return (await getDto(created.id))!;
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateWarehouseSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { supplierId, ...body } = req.body;
      await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(warehouses).where(eq(warehouses.id, id));
        if (!existing) throw err.notFound('Склад не найден');
        // Поставщика у склада можно сменить — это исправление ошибки ввода, а не переезд склада;
        // проверка типа при этом та же, что при заведении.
        const supplier = supplierId ?? existing.supplierCounterpartyId;
        if (supplierId !== undefined && supplierId !== existing.supplierCounterpartyId) {
          await assertSupplier(tx, supplierId);
        }
        const address = body.address ?? existing.address;
        if (supplier !== existing.supplierCounterpartyId || address !== existing.address) {
          await assertAddressFree(tx, supplier, address, id);
        }
        await tx
          .update(warehouses)
          .set({
            ...body,
            supplierCounterpartyId: supplier,
            updatedBy: p.id,
            updatedAt: new Date(),
          })
          .where(eq(warehouses.id, id));
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'warehouse.update',
        entityType: 'warehouse',
        entityId: id,
      });
      return (await getDto(id))!;
    },
  );

  // ── Удаление ──
  // Строку удаляем, а не гасим (то же отступление, что у категорий ТС): справочник наполняется
  // руками, ошибочный адрес нужно вычищать, а не держать неактивным мусором в списках. Пауза у
  // склада выражается переключателем «Активен» в карточке, и это другое состояние: «работаем, но
  // не сейчас». Ссылающихся сущностей пока нет — с их появлением здесь встанет проверка ссылок
  // и 409, а удаление станет мягким.
  //
  // Возможность удалить склад держит и карточку контрагента: тип поставщика со складами не
  // меняется и такой контрагент не удаляется, и «сначала уберите склады» обязано быть выполнимым.
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const [row] = await db
        .delete(warehouses)
        .where(eq(warehouses.id, id))
        .returning({ id: warehouses.id, address: warehouses.address });
      if (!row) throw err.notFound('Склад не найден');
      await writeAudit({
        actorUserId: p.id,
        action: 'warehouse.delete',
        entityType: 'warehouse',
        entityId: id,
        // Строки больше нет — в журнале остаётся то, чем её называли.
        metadata: { address: row.address },
      });
      return { ok: true };
    },
  );
}
