import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  can,
  createManualSchema,
  type ManualDto,
  manualListQuerySchema,
  updateManualSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { appManuals, type ManualRow } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

/**
 * Руководства пользователя (`docs/manuals-plan.md`): список ссылок на документы во внешнем
 * хранилище. Портал знает про руководство только строку — файлы он не хранит, и по ссылке сам не
 * ходит.
 *
 * Чтение закрыто одним `authenticate`, права у него нет намеренно (план §3.2). Право, закрывающее
 * «как пользоваться порталом», пришлось бы выдать каждому вошедшему — то есть оно не различало бы
 * никого; то же рассуждение, что у журнала обновлений (ADR 0077 §5). Ведение при этом закрыто
 * своим правом `manuals.manage`, и им же открывается вкладка ведения — модуль закрывается своим
 * правом (ADR 0021).
 *
 * Маршрут один, режима два, и различает их право, а не адрес: без `manuals.manage` параметр
 * `isActive` игнорируется, и обработчик подставляет `true` сам. Второй ручкой «только
 * опубликованные» это было бы честнее на вид, но развело бы один и тот же список по двум путям —
 * а забыть фильтр на одном из них ровно так же легко.
 */

const idParams = z.object({ id: z.string().uuid() });

function toDto(r: ManualRow): ManualDto {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    url: r.url,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export default async function manualsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canManageGuard = app.requirePermission('manuals.manage');

  r.get(
    '/',
    // Только вход: см. преамбулу. Право спрашивается внутри обработчика — не для того, чтобы
    // пустить или не пустить, а чтобы решить, показывать ли снятые с публикации.
    { preHandler: [app.authenticate], schema: { querystring: manualListQuerySchema } },
    async (req) => {
      const q = req.query;
      const manages = can(requirePrincipal(req), 'manuals.manage');
      // Снятое с публикации руководство видит только тот, кто список ведёт. Присланный без права
      // `isActive=false` не отбрасывается молча — он подменяется на `true`: «покажи мне снятые»
      // от того, кому они не положены, означает «покажи опубликованные», а не «покажи пусто».
      const isActive = manages ? q.isActive : true;
      // Один предикат на выборку и на счётчик: посчитай `total` по другому условию — и счётчик
      // рассказывал бы про строки, которых в ответе нет.
      const where = and(
        isActive === undefined ? undefined : eq(appManuals.isActive, isActive),
        searchCondition(q.search, [appManuals.title, appManuals.description]),
      );
      const sortCols = {
        sortOrder: appManuals.sortOrder,
        title: appManuals.title,
        isActive: appManuals.isActive,
        createdAt: appManuals.createdAt,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(appManuals)
          .where(where)
          // `orderByFrom` отдаёт один ключ, поэтому два добивочных стоят прямо здесь. Пары
          // «порядок + название» мало: одинаковые названия в одном `sortOrder` разрешены, и два
          // «Руководства диспетчера» менялись бы местами между запросами — `id` разводит и их.
          .orderBy(
            orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'),
            asc(appManuals.title),
            asc(appManuals.id),
          )
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(appManuals).where(where),
      ]);
      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  r.post(
    '/',
    { preHandler: [app.authenticate, canManageGuard], schema: { body: createManualSchema } },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const [created] = await db.insert(appManuals).values(req.body).returning();
      await writeAudit({
        actorUserId: p.id,
        action: 'manual.create',
        entityType: 'manual',
        entityId: created!.id,
        // Адрес в журнале с самого заведения: по нему видно, что именно выложили людям, — и
        // сравнение с адресом правки отвечает на «когда ссылка поменялась».
        metadata: { title: created!.title, url: created!.url },
      });
      reply.code(201);
      return toDto(created!);
    },
  );

  /**
   * Правится всё, включая ссылку: документ в хранилище переезжает, и заводить ради переезда вторую
   * строку значило бы плодить дубли названий. Снятие с публикации — та же правка (`isActive`), а
   * не отдельная ручка: у руководства нет ни архива, ни жизненного цикла, в который стоило бы
   * вводить переходы.
   */
  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canManageGuard],
      schema: { params: idParams, body: updateManualSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const [updated] = await db
        .update(appManuals)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(appManuals.id, req.params.id))
        .returning();
      if (!updated) throw err.notFound('Руководство не найдено');
      await writeAudit({
        actorUserId: p.id,
        action: 'manual.update',
        entityType: 'manual',
        entityId: updated.id,
        metadata: { title: updated.title, url: updated.url },
      });
      return toDto(updated);
    },
  );

  /**
   * Удаление насовсем — под тем же `manuals.manage`, а не под `records.purge` (план §3.4). Внешних
   * ключей на строку нет, архива у неё нет, восстанавливать нечего: ошибочно вставленную ссылку
   * убирает тот же, кто её вставил. Из обращения руководство при этом выводится `isActive = false`
   * — удаление нужно для опечаток, а не для «больше не показываем».
   */
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canManageGuard], schema: { params: idParams } },
    async (req): Promise<{ ok: true }> => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const [row] = await db
        .delete(appManuals)
        .where(eq(appManuals.id, id))
        .returning({ title: appManuals.title, url: appManuals.url });
      if (!row) throw err.notFound('Руководство не найдено');
      await writeAudit({
        actorUserId: p.id,
        action: 'manual.delete',
        entityType: 'manual',
        entityId: id,
        // Строки больше нет, и один `entityId` после удаления не объясняет ничего: в журнале
        // остаётся то, чем руководство называли и куда вело.
        metadata: { title: row.title, url: row.url },
      });
      return { ok: true };
    },
  );
}
