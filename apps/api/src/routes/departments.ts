import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createDepartmentSchema,
  type DepartmentDto,
  departmentListQuerySchema,
  updateDepartmentSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { departments, type DepartmentRow, userDepartments } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { revokeAllForUser } from '../auth/sessions';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';
import { headsByDepartmentIds, replaceDepartmentHeads } from '../services/user-scopes';

/**
 * Справочник отделов (ADR 0040) — офисные подразделения. Устроен по образцу объектов
 * строительства: те же права (`directories.read` / `directories.write`), то же удаление
 * деактивацией — на отдел ссылаются заведённые заявки.
 *
 * Своё здесь одно: руководители отдела. Они не хранятся в карточке, а выводятся из учёток с
 * ролью «Руководитель отдела», привязанных к отделу, — это та же связь `user_departments`,
 * прочитанная со стороны справочника. Поэтому правка набора отсюда меняет область учётки и
 * гасит её сессии так же, как правка из карточки пользователя.
 */

function toDto(r: DepartmentRow, heads: DepartmentDto['heads']): DepartmentDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    isActive: r.isActive,
    heads,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Карточка отдела всегда идёт с руководителями: клиент правит набор, а не отдельные привязки. */
async function getDto(id: string): Promise<DepartmentDto | null> {
  const [row] = await db.select().from(departments).where(eq(departments.id, id));
  if (!row) return null;
  const heads = await headsByDepartmentIds([id]);
  return toDto(row, heads.get(id) ?? []);
}

const idParams = z.object({ id: z.string().uuid() });

export default async function departmentsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  // Чтение доступно всем аутентифицированным: без него не отрисовать ни фильтр по отделу, ни
  // наименование отдела в списке заявок.
  r.get(
    '/',
    { preHandler: [app.authenticate, canRead], schema: { querystring: departmentListQuerySchema } },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(departments.isActive, q.isActive),
        searchCondition(q.search, [departments.code, departments.name]),
      );
      const sortCols = {
        code: departments.code,
        name: departments.name,
        isActive: departments.isActive,
        createdAt: departments.createdAt,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(departments)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'name'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(departments).where(where),
      ]);
      const heads = await headsByDepartmentIds(rows.map((row) => row.id));
      return {
        items: rows.map((row) => toDto(row, heads.get(row.id) ?? [])),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canWrite], schema: { body: createDepartmentSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const { headUserIds, ...body } = req.body;
      const { created, affected } = await db.transaction(async (tx) => {
        const dup = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(eq(departments.code, body.code));
        if (dup.length > 0) throw err.conflict('Отдел с таким кодом уже существует');
        const [row] = await tx.insert(departments).values(body).returning({ id: departments.id });
        return {
          created: row!,
          affected: await replaceDepartmentHeads(tx, row!.id, headUserIds, p.id),
        };
      });
      await revokeScopeChanged(affected);
      await writeAudit({
        actorUserId: p.id,
        action: 'department.create',
        entityType: 'department',
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
      schema: { params: idParams, body: updateDepartmentSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { headUserIds, ...body } = req.body;
      const affected = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(departments)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(departments.id, id))
          .returning({ id: departments.id });
        if (!updated) throw err.notFound('Отдел не найден');
        // Отсутствие поля — «не трогать привязки»: их правят и из карточки учётки.
        return headUserIds === undefined
          ? []
          : await replaceDepartmentHeads(tx, id, headUserIds, p.id);
      });
      await revokeScopeChanged(affected);
      await writeAudit({
        actorUserId: p.id,
        action: 'department.update',
        entityType: 'department',
        entityId: id,
        metadata: { headsChanged: affected.length > 0 },
      });
      return (await getDto(id))!;
    },
  );

  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const { id } = req.params;
      // Деактивация вместо удаления: на отдел ссылаются заведённые заявки. Привязки учёток при
      // этом остаются — деактивированный отдел не должен молча обнулить область его сотрудников
      // и тем самым открыть или закрыть им что-то в обход карточки учётки.
      const [row] = await db
        .update(departments)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(departments.id, id))
        .returning({ id: departments.id });
      if (!row) throw err.notFound('Отдел не найден');
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'department.deactivate',
        entityType: 'department',
        entityId: id,
      });
      return (await getDto(id))!;
    },
  );

  // Удаление насовсем (ADR 0060): деактивированный отдел сносится целиком. Заявки его держат
  // внешним ключом, а привязки учёток — проверкой ниже: каскад снял бы их молча.
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(departments).where(eq(departments.id, id));
      return row;
    },
    isDown: (row) => !row.isActive,
    remove: async (tx, row) => {
      // Тот же довод, что и при деактивации: отдел не должен обнулять область своих сотрудников
      // в обход карточки учётки (ADR 0040). Сначала снимают привязку, потом удаляют отдел.
      const scoped = await tx
        .select({ c: count() })
        .from(userDepartments)
        .where(eq(userDepartments.departmentId, row.id));
      const linked = Number(scoped[0]!.c);
      if (linked > 0) {
        throw err.conflict(
          `Отдел привязан к учётным записям (${linked}) — снимите привязку и повторите`,
        );
      }
      await tx.delete(departments).where(eq(departments.id, row.id));
    },
    notFound: 'Отдел не найден',
    stillLive: 'Отдел активен — сначала деактивируйте его',
    subject: 'отдел',
    audit: {
      action: 'department.purge',
      entityType: 'department',
      metadata: (row) => ({ code: row.code, name: row.name }),
    },
  });
}

/**
 * Учёткам, у которых сменилась область, гасим выданные токены — как при правке из карточки
 * пользователя: набор отделов решает, какие заявки человек видит, и старый токен обещал бы
 * прежнюю область до своего истечения. Вне транзакции: сессии живут своей таблицей, и
 * откатывать их вместе со справочником нечем.
 */
async function revokeScopeChanged(userIds: string[]): Promise<void> {
  for (const userId of userIds) await revokeAllForUser(userId);
}
