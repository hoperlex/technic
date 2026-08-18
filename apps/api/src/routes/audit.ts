import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, exists, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  auditQuerySchema,
  auditScopeActions,
  type AuditEntryDto,
  type ArchiveFilter,
} from '@technic/contracts';
import { db } from '../db/client';
import { auditLog, userConstructionObjects, userDepartments, users } from '../db/schema';
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

// Объект и отдел цели — EXISTS, а не join: вторым join'ом строка журнала размножилась бы по числу
// площадок, и `total` считал бы привязки вместо событий. Тем же приёмом отбирается список учёток.

function targetOnObject(objectId: string) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(userConstructionObjects)
      .where(
        and(
          eq(userConstructionObjects.userId, targets.id),
          eq(userConstructionObjects.constructionObjectId, objectId),
        ),
      ),
  );
}

function targetInDepartment(departmentId: string) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(userDepartments)
      .where(
        and(eq(userDepartments.userId, targets.id), eq(userDepartments.departmentId, departmentId)),
      ),
  );
}

/**
 * Архив цели. Записи, у которых учётки уже нет вовсе (удаление насовсем), при отборе действующих
 * тоже уходят: `deleted_at` у ненайденной цели пуст из-за left join, и без проверки на саму цель
 * «только действующие» показывало бы как раз тех, кого стёрли.
 */
function archiveCondition(filter: ArchiveFilter) {
  if (filter === 'include') return undefined;
  if (filter === 'only') return isNotNull(targets.deletedAt);
  return and(isNotNull(targets.id), isNull(targets.deletedAt));
}

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = { preHandler: [app.authenticate, app.requirePermission('audit.read')] };

  r.get('/', { ...guards, schema: { querystring: auditQuerySchema } }, async (req) => {
    const q = req.query;
    const where = and(
      // Срез — граница ручки, и снять его запросом нельзя. Журнал в портале один: в него пишет
      // каждая операция — заявка, рейс, путевой лист, справочник, вход, — а подвкладка «Аудит»
      // спрашивает у него одно, что происходило с учётными записями. Пока границы здесь не было,
      // ответом на пустой фильтр шёл весь `audit_log`, и десяток административных событий тонул
      // в тысячах чужих. Умолчание среза — учётки (контракты), поэтому забыть его клиент не может.
      inArray(auditLog.action, [...auditScopeActions(q.scope)]),
      // Набор действий, а не одно: подвкладка «Аудит» показывает перечень действий по учёткам
      // целиком, и фильтр по одному значению заставлял бы читать журнал по разу на действие.
      // Пустой набор — «фильтра нет», то есть весь срез: снятые галочки не отбирают пустоту.
      q.actions && q.actions.length > 0 ? inArray(auditLog.action, q.actions) : undefined,
      q.entityType ? eq(auditLog.entityType, q.entityType) : undefined,
      q.entityId ? eq(auditLog.entityId, q.entityId) : undefined,
      q.actorUserId ? eq(auditLog.actorUserId, q.actorUserId) : undefined,
      q.from ? gte(auditLog.createdAt, q.from) : undefined,
      q.to ? lte(auditLog.createdAt, q.to) : undefined,
      // Отбор по данным учётки, над которой действовали (ADR 0109) — по её состоянию сейчас:
      // снимка учётки на момент события журнал не хранит. Вопросы к нему задают про нынешних
      // людей («что меняли у механиков», «что меняли у людей СУ-10»), и подвкладка это оговаривает.
      q.targetRole ? eq(targets.role, q.targetRole) : undefined,
      q.targetIsActive === undefined ? undefined : eq(targets.isActive, q.targetIsActive),
      q.targetObjectId ? targetOnObject(q.targetObjectId) : undefined,
      q.targetDepartmentId ? targetInDepartment(q.targetDepartmentId) : undefined,
      q.targetCounterpartyId ? eq(targets.counterpartyId, q.targetCounterpartyId) : undefined,
      archiveCondition(q.targetArchive),
      // Поиск — по людям: ФИО и адрес учётки, ФИО администратора. Коды действий и `entity_id` из
      // него убраны — наружу они не показываются вовсе, и искать по ним нечего.
      searchCondition(q.search, [users.fullName, targets.fullName, targets.email]),
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
          // Чем учётка стала сейчас: строка журнала называет человека так же, как список учёток, —
          // «Механик, в архиве». По одному ФИО действующий сотрудник неотличим от уволенного.
          targetRole: targets.role,
          targetIsActive: targets.isActive,
          targetDeletedAt: targets.deletedAt,
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
        targetDeletedAt: row.targetDeletedAt?.toISOString() ?? null,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      })),
      total: Number(totalRow[0]!.c),
      page: p.page,
      pageSize: p.pageSize,
    };
  });
}
