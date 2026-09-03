import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, ne } from 'drizzle-orm';
import {
  createMechModelSchema,
  mechModelListQuerySchema,
  mechModelNameKey,
  type MechModelDto,
  updateMechModelSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { mechModels, type MechModelRow } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';

/**
 * Справочник моделей малой механизации (план `docs/mechanization-models-directory-plan.md`,
 * этап Э1; таблица — миграция 0249, наполнение — 0250).
 *
 * Ручки те же и в том же порядке, что у типов контейнеров: список, заведение, правка, деактивация
 * и удаление насовсем. Отличие ровно одно — сверка наименования по нормализованному ключу перед
 * записью: под ключом живёт `mech_models_name_key_unique`, и без сверки человек получал бы на
 * повтор ответ базы с именем индекса вместо слов «такая модель уже есть».
 */

function toDto(r: MechModelRow): MechModelDto {
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

const idParams = z.object({ id: z.string().uuid() });

/**
 * Занято ли наименование другой строкой справочника. Ключ считает та же нормализация, что стоит в
 * GENERATED-колонке; `exclude` — идентификатор правимой строки: без него всякая правка порядка у
 * модели упиралась бы в её собственное наименование.
 */
async function nameTaken(name: string, exclude?: string): Promise<MechModelRow | undefined> {
  const [row] = await db
    .select()
    .from(mechModels)
    .where(
      and(
        eq(mechModels.nameKey, mechModelNameKey(name)),
        exclude === undefined ? undefined : ne(mechModels.id, exclude),
      ),
    );
  return row;
}

export default async function mechModelsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('directories.read');
  const canWrite = app.requirePermission('directories.write');

  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: mechModelListQuerySchema },
    },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(mechModels.isActive, q.isActive),
        // Поиск идёт и по коду: человеку код не показывают, но именно им строка названа в файле
        // обмена, и держатель справочника ищет по нему, разбираясь с отчётом загрузки.
        searchCondition(q.search, [mechModels.code, mechModels.name]),
      );
      const sortCols = {
        code: mechModels.code,
        name: mechModels.name,
        sortOrder: mechModels.sortOrder,
        isActive: mechModels.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(mechModels)
          .where(where)
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(mechModels).where(where),
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
    { preHandler: [app.authenticate, canWrite], schema: { body: createMechModelSchema } },
    async (req, reply) => {
      const dup = await db
        .select({ id: mechModels.id })
        .from(mechModels)
        .where(eq(mechModels.code, req.body.code));
      if (dup.length > 0) throw err.conflict('Модель с таким кодом уже существует');
      const twin = await nameTaken(req.body.name);
      if (twin) {
        throw err.conflict(
          `Модель «${twin.name}» уже заведена: регистр и лишние пробелы наименование не различают`,
        );
      }
      const [created] = await db.insert(mechModels).values(req.body).returning();
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'mech_model.create',
        entityType: 'mech_model',
        entityId: created!.id,
      });
      reply.code(201);
      return toDto(created!);
    },
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateMechModelSchema },
    },
    async (req) => {
      if (req.body.name !== undefined) {
        const twin = await nameTaken(req.body.name, req.params.id);
        if (twin) {
          throw err.conflict(
            `Модель «${twin.name}» уже заведена: регистр и лишние пробелы наименование не различают`,
          );
        }
      }
      const [updated] = await db
        .update(mechModels)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(mechModels.id, req.params.id))
        .returning();
      if (!updated) throw err.notFound('Модель не найдена');
      // Удаления нет: деактивация — через isActive=false (единый принцип со справочниками ТС и
      // типов контейнеров). Переименование раскладывается по всем, кто на модель сослался: заявка
      // хранит ссылку, а не снимок названия.
      const action =
        req.body.isActive === false
          ? 'mech_model.deactivate'
          : req.body.isActive === true
            ? 'mech_model.activate'
            : 'mech_model.update';
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action,
        entityType: 'mech_model',
        entityId: req.params.id,
      });
      return toDto(updated);
    },
  );

  // Удаление насовсем (ADR 0060) — вторым шагом после деактивации: заведённая по ошибке модель
  // иначе остаётся в справочнике навсегда. Заявки механизации будут держать её внешним ключом с
  // этапа Э2; до него удалять нечему помешать, и это не повод заводить ручку позже — справочник
  // наполняют сейчас, ошибаются в нём тоже сейчас.
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(mechModels).where(eq(mechModels.id, id));
      return row;
    },
    isDown: (row) => !row.isActive,
    remove: async (tx, row) => {
      await tx.delete(mechModels).where(eq(mechModels.id, row.id));
    },
    notFound: 'Модель не найдена',
    stillLive: 'Модель активна — сначала деактивируйте её',
    subject: 'модель механизации',
    audit: {
      action: 'mech_model.purge',
      entityType: 'mech_model',
      metadata: (row) => ({ code: row.code, name: row.name }),
    },
  });
}
