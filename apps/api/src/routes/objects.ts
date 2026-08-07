import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq } from 'drizzle-orm';
import {
  createObjectSchema,
  objectListQuerySchema,
  type ObjectDto,
  updateObjectSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departments,
  type ObjectRow,
  userConstructionObjects,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';
import { purgeWeeklyRequestsOfObject } from '../services/weekly-request-cleanup';
import { operatorsByObjectIds, replaceObjectOperators } from '../services/object-operators';
import { z } from 'zod';

function toDto(r: ObjectRow, operators: ObjectDto['operators']): ObjectDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    address: r.address,
    isActive: r.isActive,
    operators,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Карточка объекта всегда идёт с операторами: клиент правит набор, а не отдельные привязки. */
async function getDto(id: string): Promise<ObjectDto | null> {
  const [row] = await db.select().from(constructionObjects).where(eq(constructionObjects.id, id));
  if (!row) return null;
  const operators = await operatorsByObjectIds([id]);
  return toDto(row, operators.get(id) ?? []);
}

const idParams = z.object({ id: z.string().uuid() });

export default async function objectsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  // Чтение доступно всем аутентифицированным (для выбора в форме заявки).
  r.get(
    '/',
    { preHandler: [app.authenticate, canRead], schema: { querystring: objectListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(constructionObjects.isActive, q.isActive),
        searchCondition(q.search, [
          constructionObjects.code,
          constructionObjects.name,
          constructionObjects.address,
        ]),
      );
      const sortCols = {
        code: constructionObjects.code,
        name: constructionObjects.name,
        address: constructionObjects.address,
        isActive: constructionObjects.isActive,
        createdAt: constructionObjects.createdAt,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(constructionObjects)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'name'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(constructionObjects).where(where),
      ]);
      const operators = await operatorsByObjectIds(rows.map((row) => row.id));
      return {
        items: rows.map((row) => toDto(row, operators.get(row.id) ?? [])),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createObjectSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { operatorIds, ...body } = req.body;
      const created = await db.transaction(async (tx) => {
        const dup = await tx
          .select({ id: constructionObjects.id })
          .from(constructionObjects)
          .where(eq(constructionObjects.code, body.code));
        if (dup.length > 0) throw err.conflict('Объект с таким кодом уже существует');
        const [row] = await tx
          .insert(constructionObjects)
          .values(body)
          .returning({ id: constructionObjects.id });
        await replaceObjectOperators(tx, row!.id, operatorIds, p.id);
        return row!;
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'object.create',
        entityType: 'construction_object',
        entityId: created.id,
      });
      reply.code(201);
      return (await getDto(created.id))!;
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateObjectSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { operatorIds, ...body } = req.body;
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(constructionObjects)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(constructionObjects.id, id))
          .returning({ id: constructionObjects.id });
        if (!updated) throw err.notFound('Объект не найден');
        // Отсутствие поля — «не трогать привязки»: их правят и из карточки контрагента.
        if (operatorIds !== undefined) await replaceObjectOperators(tx, id, operatorIds, p.id);
      });
      await writeAudit({
        actorUserId: p.id,
        action: 'object.update',
        entityType: 'construction_object',
        entityId: id,
      });
      return (await getDto(id))!;
    },
  );

  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const { id } = req.params;
      // деактивация вместо удаления (объект может быть в заявках)
      const [row] = await db
        .update(constructionObjects)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(constructionObjects.id, id))
        .returning({ id: constructionObjects.id });
      if (!row) throw err.notFound('Объект не найден');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'object.deactivate',
        entityType: 'construction_object',
        entityId: id,
      });
      return (await getDto(id))!;
    },
  );

  // Удаление насовсем (ADR 0060): деактивированный объект сносится вместе с привязками операторов
  // вывоза — они каскадные и живут только при нём. Заявки объект держат внешним ключом.
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db
        .select()
        .from(constructionObjects)
        .where(eq(constructionObjects.id, id));
      return row;
    },
    isDown: (row) => !row.isActive,
    remove: async (tx, row) => {
      // Привязки учёток к объекту каскадные, и БД удалению не помешает — а объектная роль без
      // единого объекта нерабочая (ADR 0039). Область доступа не должна меняться уборкой
      // справочника, поэтому сначала её снимают в карточках учёток.
      const scoped = await tx
        .select({ c: count() })
        .from(userConstructionObjects)
        .where(eq(userConstructionObjects.constructionObjectId, row.id));
      const linked = Number(scoped[0]!.c);
      if (linked > 0) {
        throw err.conflict(
          `Объект привязан к учётным записям (${linked}) — снимите привязку и повторите`,
        );
      }
      // Площадка отдела (ADR 0062) — тот же довод, но привязка держится внешним ключом: RESTRICT
      // удалению помешает и сам, только ответит нарушением целостности. Отдел на этой площадке
      // даёт своим сотрудникам права по вывозу мусора, и снимают их в карточке отдела.
      const departmentsOnObject = await tx
        .select({ c: count() })
        .from(departments)
        .where(eq(departments.constructionObjectId, row.id));
      const linkedDepartments = Number(departmentsOnObject[0]!.c);
      if (linkedDepartments > 0) {
        throw err.conflict(
          `Объект указан площадкой отделов (${linkedDepartments}) — снимите привязку и повторите`,
        );
      }
      // Неприменённые недельные заявки этой площадки сносятся целиком (ADR 0085 Р15): заявка на
      // снесённую площадку — документ ни о чём, а строки уйдут каскадом вместе с шапкой. Версией
      // ветка не занимается: клиент, державший страницу открытой, получит 404 — обновлять нечего.
      // Применённая заявка останется и удалению помешает, объяснившись словами.
      const cleanup = await purgeWeeklyRequestsOfObject(tx, { id: row.id });
      await tx.delete(constructionObjects).where(eq(constructionObjects.id, row.id));
      return cleanup;
    },
    notFound: 'Объект не найден',
    stillLive: 'Объект активен — сначала деактивируйте его',
    subject: 'объект',
    audit: {
      action: 'object.purge',
      entityType: 'construction_object',
      metadata: (row) => ({ code: row.code, name: row.name }),
    },
  });
}
