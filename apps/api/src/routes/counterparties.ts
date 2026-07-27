import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, exists, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  type CounterpartyDto,
  counterpartyListQuerySchema,
  type CounterpartyType,
  createCounterpartySchema,
  INN_CHECKSUM_MESSAGE,
  isValidInn,
  resolveCounterpartyQuerySchema,
  type ResolvedCounterpartyDto,
  updateCounterpartySchema,
} from '@technic/contracts';
import { z } from 'zod';
import { db } from '../db/client';
import { counterparties, counterpartySynonyms, type CounterpartyRow } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import {
  hasObjectLinks,
  objectsByCounterpartyIds,
  replaceOperatorObjects,
} from '../services/object-operators';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const idParams = z.object({ id: z.string().uuid() });

/** Нормализованная форма наименования считается БД — единственный источник истины (миграция 0022). */
const normalized = (name: string) => sql<string>`counterparty_name_normalize(${name})`;

async function synonymsByCounterpartyIds(ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      counterpartyId: counterpartySynonyms.counterpartyId,
      name: counterpartySynonyms.name,
    })
    .from(counterpartySynonyms)
    .where(inArray(counterpartySynonyms.counterpartyId, ids))
    .orderBy(counterpartySynonyms.name);
  for (const row of rows) {
    const list = map.get(row.counterpartyId) ?? [];
    list.push(row.name);
    map.set(row.counterpartyId, list);
  }
  return map;
}

function toDto(
  r: CounterpartyRow,
  synonyms: string[],
  objects: CounterpartyDto['objects'],
): CounterpartyDto {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    inn: r.inn,
    comment: r.comment,
    synonyms,
    objects,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
  };
}

async function getDto(id: string): Promise<CounterpartyDto | null> {
  const [row] = await db.select().from(counterparties).where(eq(counterparties.id, id));
  if (!row) return null;
  const [synonyms, objects] = await Promise.all([
    synonymsByCounterpartyIds([id]),
    objectsByCounterpartyIds([id]),
  ]);
  return toDto(row, synonyms.get(id) ?? [], objects.get(id) ?? []);
}

/** ИНН — ключ идентичности: занят живой записью → 409, а не «второй контрагент с тем же ИНН». */
async function assertInnFree(tx: Tx, inn: string, exceptId?: string): Promise<void> {
  const dup = await tx
    .select({ id: counterparties.id, name: counterparties.name })
    .from(counterparties)
    .where(
      and(
        eq(counterparties.inn, inn),
        isNull(counterparties.deletedAt),
        exceptId ? ne(counterparties.id, exceptId) : undefined,
      ),
    );
  if (dup.length > 0) {
    throw err.conflict(`ИНН ${inn} уже занят контрагентом «${dup[0]!.name}»`);
  }
}

/**
 * Заменяет набор синонимов целиком. Чужой синоним — конфликт с именем владельца: молча
 * проигнорировать его нельзя, иначе пользователь решит, что наименование закреплено за ним.
 * Дубли внутри собственного набора схлопывает onConflictDoNothing (после удаления старых
 * записей конфликтовать можно только с самим собой).
 */
async function replaceSynonyms(tx: Tx, counterpartyId: string, names: string[]): Promise<void> {
  if (names.length > 0) {
    const conflicts = await tx
      .select({ synonym: counterpartySynonyms.name, owner: counterparties.name })
      .from(counterpartySynonyms)
      .innerJoin(counterparties, eq(counterpartySynonyms.counterpartyId, counterparties.id))
      .where(
        and(
          ne(counterpartySynonyms.counterpartyId, counterpartyId),
          or(...names.map((n) => eq(counterpartySynonyms.normalizedName, normalized(n)))),
        ),
      );
    if (conflicts.length > 0) {
      const c = conflicts[0]!;
      throw err.conflict(`Синоним «${c.synonym}» уже закреплён за контрагентом «${c.owner}»`);
    }
  }
  await tx
    .delete(counterpartySynonyms)
    .where(eq(counterpartySynonyms.counterpartyId, counterpartyId));
  if (names.length > 0) {
    await tx
      .insert(counterpartySynonyms)
      .values(names.map((name) => ({ counterpartyId, name })))
      .onConflictDoNothing();
  }
}

/**
 * Объекты обслуживает оператор — у генподрядчика и подрядчика это поле лишено смысла (ADR 0010).
 * Молча игнорировать присланный список нельзя: пользователь решит, что привязка сохранена.
 */
function assertObjectsAllowed(type: CounterpartyType, objectIds: string[]): void {
  if (objectIds.length > 0 && type !== 'operator') {
    throw err.badRequest('Объекты привязываются только к контрагенту типа «Оператор»', {
      objectIds: 'Доступно только для типа «Оператор»',
    });
  }
}

export default async function counterpartiesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canWrite = app.requireRoles('admin', 'manager');

  // Чтение — всем аутентифицированным: контрагент выбирается в заявке (оператор вывоза).
  r.get(
    '/',
    { preHandler: [app.authenticate], schema: { querystring: counterpartyListQuerySchema } },
    async (req) => {
      const p = requirePrincipal(req);
      const q = req.query;
      const showDeleted = q.includeDeleted && p.role === 'admin';
      // Поиск идёт и по синонимам: пользователь ищет по тому наименованию, которое видит в документе.
      const search = q.search
        ? or(
            searchCondition(q.search, [counterparties.name, counterparties.inn]),
            exists(
              db
                .select({ one: sql`1` })
                .from(counterpartySynonyms)
                .where(
                  and(
                    eq(counterpartySynonyms.counterpartyId, counterparties.id),
                    sql`${counterpartySynonyms.name} ILIKE ${`%${q.search}%`}`,
                  ),
                ),
            ),
          )
        : undefined;
      const where = and(
        showDeleted ? undefined : isNull(counterparties.deletedAt),
        q.type ? eq(counterparties.type, q.type) : undefined,
        q.isActive === undefined ? undefined : eq(counterparties.isActive, q.isActive),
        search,
      );
      const sortCols = {
        name: counterparties.name,
        inn: counterparties.inn,
        type: counterparties.type,
        isActive: counterparties.isActive,
        createdAt: counterparties.createdAt,
      };
      const pg = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(counterparties)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'name'))
          .limit(pg.limit)
          .offset(pg.offset),
        db.select({ c: count() }).from(counterparties).where(where),
      ]);
      const ids = rows.map((row) => row.id);
      const [synonyms, objects] = await Promise.all([
        synonymsByCounterpartyIds(ids),
        objectsByCounterpartyIds(ids),
      ]);
      return {
        items: rows.map((row) => toDto(row, synonyms.get(row.id) ?? [], objects.get(row.id) ?? [])),
        total: Number(totalRows[0]!.c),
        page: pg.page,
        pageSize: pg.pageSize,
      };
    },
  );

  // Сопоставление наименования из документа с контрагентом: основное имя, затем синонимы.
  // Сравнение — по нормализованной форме («ООО «Ромашка»» и «Ромашка ООО» дают разное, а
  // «ООО «Ромашка»» и «ООО Ромашка» — одно и то же).
  r.get(
    '/resolve',
    {
      preHandler: [app.authenticate],
      schema: { querystring: resolveCounterpartyQuerySchema },
    },
    async (req) => {
      const { name } = req.query;
      const [byName] = await db
        .select()
        .from(counterparties)
        .where(
          and(
            eq(counterparties.normalizedName, normalized(name)),
            isNull(counterparties.deletedAt),
          ),
        )
        .limit(1);
      if (byName) {
        const dto: ResolvedCounterpartyDto = {
          counterparty: (await getDto(byName.id))!,
          matchedBy: 'name',
        };
        return dto;
      }
      const [bySynonym] = await db
        .select({ row: counterparties })
        .from(counterpartySynonyms)
        .innerJoin(counterparties, eq(counterpartySynonyms.counterpartyId, counterparties.id))
        .where(
          and(
            eq(counterpartySynonyms.normalizedName, normalized(name)),
            isNull(counterparties.deletedAt),
          ),
        )
        .limit(1);
      if (!bySynonym) throw err.notFound('Контрагент с таким наименованием не найден');
      const dto: ResolvedCounterpartyDto = {
        counterparty: (await getDto(bySynonym.row.id))!,
        matchedBy: 'synonym',
      };
      return dto;
    },
  );

  r.get('/:id', { preHandler: [app.authenticate], schema: { params: idParams } }, async (req) => {
    const dto = await getDto(req.params.id);
    if (!dto) throw err.notFound('Контрагент не найден');
    return dto;
  });

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createCounterpartySchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const body = req.body;
      if (!isValidInn(body.inn))
        throw err.badRequest(INN_CHECKSUM_MESSAGE, { inn: 'Неверный ИНН' });
      assertObjectsAllowed(body.type, body.objectIds);
      const created = await db.transaction(async (tx) => {
        await assertInnFree(tx, body.inn);
        const [row] = await tx
          .insert(counterparties)
          .values({
            type: body.type,
            name: body.name,
            inn: body.inn,
            comment: body.comment,
            isActive: body.isActive,
            createdBy: p.id,
            updatedBy: p.id,
          })
          .returning({ id: counterparties.id });
        await replaceSynonyms(tx, row!.id, body.synonyms);
        await replaceOperatorObjects(tx, row!.id, body.objectIds, p.id);
        return row!;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'counterparty.create',
        entityType: 'counterparty',
        entityId: created.id,
        metadata: { type: body.type, inn: body.inn },
      });
      reply.code(201);
      return (await getDto(created.id))!;
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateCounterpartySchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;
      if (body.inn !== undefined && !isValidInn(body.inn)) {
        throw err.badRequest(INN_CHECKSUM_MESSAGE, { inn: 'Неверный ИНН' });
      }
      await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(counterparties).where(eq(counterparties.id, id));
        if (!existing || existing.deletedAt) throw err.notFound('Контрагент не найден');
        if (body.inn !== undefined && body.inn !== existing.inn) {
          await assertInnFree(tx, body.inn, id);
        }
        const type = body.type ?? existing.type;
        assertObjectsAllowed(type, body.objectIds ?? []);
        // Смена типа с «Оператора» на другой при живых привязках — не молчаливая их очистка:
        // привязки заводил кто-то другой (в том числе из карточки объекта), и снимать их
        // побочным эффектом правки типа нельзя.
        if (type !== 'operator' && (await hasObjectLinks(tx, id))) {
          throw err.conflict(
            'У контрагента есть привязанные объекты — снимите привязку перед сменой типа',
          );
        }
        await tx
          .update(counterparties)
          .set({
            type,
            name: body.name ?? existing.name,
            inn: body.inn ?? existing.inn,
            comment: body.comment ?? existing.comment,
            isActive: body.isActive ?? existing.isActive,
            updatedBy: p.id,
            updatedAt: new Date(),
          })
          .where(eq(counterparties.id, id));
        if (body.synonyms !== undefined) await replaceSynonyms(tx, id, body.synonyms);
        // Отсутствие поля — «не трогать привязки»: их правят и из карточки объекта.
        if (body.objectIds !== undefined) await replaceOperatorObjects(tx, id, body.objectIds, p.id);
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'counterparty.update',
        entityType: 'counterparty',
        entityId: id,
      });
      return (await getDto(id))!;
    },
  );

  // Soft-delete: контрагент уже мог попасть в заявки и учётки, поэтому строка остаётся.
  // Восстановление — отдельной ручкой (ИНН на время удаления освобождается).
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const [existing] = await db.select().from(counterparties).where(eq(counterparties.id, id));
      if (!existing || existing.deletedAt) throw err.notFound('Контрагент не найден');
      await db
        .update(counterparties)
        .set({ deletedAt: new Date(), deletedBy: p.id, isActive: false, updatedAt: new Date() })
        .where(eq(counterparties.id, id));
      await writeAudit({
        actorUserId: p.id,
        action: 'counterparty.delete',
        entityType: 'counterparty',
        entityId: id,
      });
      return { ok: true };
    },
  );

  r.post(
    '/:id/restore',
    { preHandler: [app.authenticate, app.requireRoles('admin')], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(counterparties).where(eq(counterparties.id, id));
        if (!existing) throw err.notFound('Контрагент не найден');
        if (!existing.deletedAt) return;
        // Пока запись была удалена, ИНН могли занять заново — восстанавливать вслепую нельзя.
        await assertInnFree(tx, existing.inn, id);
        await tx
          .update(counterparties)
          .set({ deletedAt: null, deletedBy: null, updatedBy: p.id, updatedAt: new Date() })
          .where(eq(counterparties.id, id));
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'counterparty.restore',
        entityType: 'counterparty',
        entityId: id,
      });
      return (await getDto(id))!;
    },
  );
}
