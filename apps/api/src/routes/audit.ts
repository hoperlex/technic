import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { auditQuerySchema, type AuditEntryDto } from '@technic/contracts';
import { db } from '../db/client';
import { auditLog, users } from '../db/schema';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

/**
 * Учётка, над которой действовали. Отдельный алиас, потому что `users` в этом запросе уже занят
 * автором записи: «кто сделал» и «над кем» — две разные строки одной таблицы.
 */
const targets = alias(users, 'audit_targets');

/**
 * Условие join'а цели. `entity_id` — колонка `text` (в журнале лежат идентификаторы всех сущностей
 * портала, и не все они uuid), а `users.id` — `uuid`, поэтому типы приходится сводить.
 *
 * Сводятся они приведением **uuid к тексту**, а не наоборот: `entity_id::uuid` падает с ошибкой на
 * первом же значении, которое uuid'ом не является, и запрос обрушивался бы целиком — притом
 * непредсказуемо, потому что планировщик волен посчитать приведение раньше отбора по
 * `entity_type`. Обратное приведение безопасно всегда: uuid печатается канонически (нижний
 * регистр, дефисы) — ровно так, как его записал сам портал, — а мусорное `entity_id` просто ни с
 * чем не совпадает, и цель у строки остаётся пустой.
 *
 * Индекс по `users.id` при таком сравнении не используется, но учёток в портале сотни, и hash join
 * по ним дешевле, чем разбор, почему журнал отвечает пятисоткой.
 */
const targetJoin = and(
  eq(auditLog.entityType, 'user'),
  sql`${targets.id}::text = ${auditLog.entityId}`,
);

const sortCols = { createdAt: auditLog.createdAt, action: auditLog.action };

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = { preHandler: [app.authenticate, app.requirePermission('audit.read')] };

  r.get('/', { ...guards, schema: { querystring: auditQuerySchema } }, async (req) => {
    const q = req.query;
    const where = and(
      // Набор действий, а не одно: подвкладка «Аудит» показывает перечень действий по учёткам
      // целиком, и фильтр по одному значению заставлял бы читать журнал по разу на действие.
      // Пустой набор — «фильтра нет»: снятые галочки не должны отбирать пустоту.
      q.actions && q.actions.length > 0 ? inArray(auditLog.action, q.actions) : undefined,
      q.entityType ? eq(auditLog.entityType, q.entityType) : undefined,
      q.entityId ? eq(auditLog.entityId, q.entityId) : undefined,
      q.actorUserId ? eq(auditLog.actorUserId, q.actorUserId) : undefined,
      q.from ? gte(auditLog.createdAt, q.from) : undefined,
      q.to ? lte(auditLog.createdAt, q.to) : undefined,
      // Поиск идёт и по именам: журнал читают по фамилии, а не по коду действия и uuid.
      searchCondition(q.search, [
        auditLog.action,
        auditLog.entityType,
        auditLog.entityId,
        users.fullName,
        targets.fullName,
        targets.email,
      ]),
    );
    const p = pageParams(q);
    const [rows, totalRow] = await Promise.all([
      db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          actorUserId: auditLog.actorUserId,
          actorName: users.fullName,
          targetName: targets.fullName,
          targetEmail: targets.email,
          metadata: auditLog.metadata,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .leftJoin(users, eq(auditLog.actorUserId, users.id))
        .leftJoin(targets, targetJoin)
        .where(where)
        .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
        .limit(p.limit)
        .offset(p.offset),
      // Счётчик идёт теми же join'ами, что и выборка: поиск читает ФИО автора и цели, а без
      // join'ов условие сослалось бы на таблицы, которых в запросе нет.
      db
        .select({ c: count() })
        .from(auditLog)
        .leftJoin(users, eq(auditLog.actorUserId, users.id))
        .leftJoin(targets, targetJoin)
        .where(where),
    ]);
    return {
      items: rows.map((row): AuditEntryDto => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      })),
      total: Number(totalRow[0]!.c),
      page: p.page,
      pageSize: p.pageSize,
    };
  });
}
