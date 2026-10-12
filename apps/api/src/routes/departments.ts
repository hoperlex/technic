import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  createDepartmentSchema,
  type DepartmentDto,
  type DepartmentObjectRefDto,
  departmentListQuerySchema,
  updateDepartmentSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  constructionObjects,
  departmentConstructionObjects,
  departments,
  type DepartmentRow,
  userDepartments,
} from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit, writeAuditTx } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { registerPurgeRoute } from '../services/directory-purge';
import {
  headsByDepartmentIds,
  NO_OBJECT_CHANGES,
  replaceDepartmentHeads,
  replaceDepartmentObjects,
} from '../services/user-scopes';

/**
 * Справочник отделов (ADR 0040) — офисные подразделения. Устроен по образцу объектов
 * строительства: те же права (`directories.read` / `directories.write`), то же удаление
 * деактивацией — на отдел ссылаются заведённые заявки.
 *
 * Своего здесь два набора, и оба меняют доступ, а не только карточку.
 *
 * **Руководители** не хранятся в карточке, а выводятся из привязок с признаком `is_head` — это та
 * же связь `user_departments`, прочитанная со стороны справочника. Признак, а не роль: до миграции
 * 0149 руководителями считались учётки роли «Руководитель отдела», и слияние ролей опустошило бы
 * справочник молча (§11.1 плана реструктуризации прав). Кандидатов сужает портал, сервер же
 * принимает любую живую учётку — прав признак не даёт.
 *
 * **Площадки** (ADR 0144, развивает ADR 0062) — набор объектов, на которых сотрудники отдела ведут
 * вывоз мусора наравне со штабом. Смена набора меняет область СРАЗУ ВСЕМУ отделу, а не тем, кого
 * правили, поэтому она же поднимает `authVersion` и гасит сессии.
 *
 * Ни того ни другого маршрут не делает своими руками: оба набора правят сервисы
 * (`replaceDepartmentHeads`, `replaceDepartmentObjects`), и они же внутри той самой транзакции
 * поднимают версию доступа и отзывают сессии (ADR 0144, решение 6). Писателей у площадок двое —
 * ещё загрузка справочника файлом, — и обязательство, оставленное маршруту, второму писателю не
 * досталось бы. Отсюда же и запись в журнал доступа: `writeAuditTx` в той же транзакции, а не
 * `writeAudit` после коммита (ADR 0144, решение 8).
 */

/**
 * Строка справочника в DTO. Площадки приходят готовым списком: их у отдела набор (ADR 0144), и
 * строка отдела больше не одна на запись — подгружаются они пакетом, как руководители.
 */
function toDto(
  r: DepartmentRow,
  objects: DepartmentObjectRefDto[],
  heads: DepartmentDto['heads'],
): DepartmentDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    isActive: r.isActive,
    objects,
    heads,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Площадки отделов пакетом — по образцу `headsByDepartmentIds` и по той же причине, по которой
 * `leftJoin` здесь больше не годится: у отдела теперь набор площадок (ADR 0144), и join размножил
 * бы строку справочника на число привязок. Страница из 20 отделов превратилась бы в страницу из
 * 20 строк «сколько-то первых площадок», а `count()` считал бы уже не отделы.
 *
 * Порядок — по коду объекта (Р7): коды короткие и различают одноимённые корпуса, а порядок обязан
 * быть один и тот же от запроса к запросу — иначе карточка «меняется» при каждом открытии.
 */
async function objectsByDepartmentIds(
  departmentIds: string[],
): Promise<Map<string, DepartmentObjectRefDto[]>> {
  const map = new Map<string, DepartmentObjectRefDto[]>();
  if (departmentIds.length === 0) return map;
  const rows = await db
    .select({
      departmentId: departmentConstructionObjects.departmentId,
      id: constructionObjects.id,
      code: constructionObjects.code,
      name: constructionObjects.name,
    })
    .from(departmentConstructionObjects)
    .innerJoin(
      constructionObjects,
      eq(departmentConstructionObjects.constructionObjectId, constructionObjects.id),
    )
    .where(inArray(departmentConstructionObjects.departmentId, departmentIds))
    .orderBy(constructionObjects.code);
  for (const row of rows) {
    const list = map.get(row.departmentId) ?? [];
    list.push({ id: row.id, code: row.code, name: row.name });
    map.set(row.departmentId, list);
  }
  return map;
}

/**
 * Карточка отдела всегда идёт с площадками и руководителями: клиент правит наборы целиком, а не
 * отдельные привязки.
 */
async function getDto(id: string): Promise<DepartmentDto | null> {
  const [row] = await db.select().from(departments).where(eq(departments.id, id));
  if (!row) return null;
  const [objects, heads] = await Promise.all([
    objectsByDepartmentIds([id]),
    headsByDepartmentIds([id]),
  ]);
  return toDto(row, objects.get(id) ?? [], heads.get(id) ?? []);
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
      const ids = rows.map((row) => row.id);
      const [objects, heads] = await Promise.all([
        objectsByDepartmentIds(ids),
        headsByDepartmentIds(ids),
      ]);
      return {
        items: rows.map((row) => toDto(row, objects.get(row.id) ?? [], heads.get(row.id) ?? [])),
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
      const { headUserIds, constructionObjectIds, ...body } = req.body;
      const created = await db.transaction(async (tx) => {
        const dup = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(eq(departments.code, body.code));
        if (dup.length > 0) throw err.conflict('Отдел с таким кодом уже существует');
        const [row] = await tx.insert(departments).values(body).returning({ id: departments.id });
        /*
         * The order "department → sites → heads" (plan stage 3) is not arbitrary. Both sets raise
         * `authVersion` for whom they touch, and the sites raise it for EVERYONE in the department.
         * With heads assigned first, their accounts would get the version twice: by the link and
         * then by the site change after it. The result is the same, but the extra bump reads in the
         * journal as a second access edit that never happened.
         *
         * The department is created without sites and the set follows in a separate call because
         * the set has one writer, and it does more than an `INSERT`: object checks, the limit, the
         * audit diff, `authVersion` and session revocation.
         */
        const objects = await replaceDepartmentObjects(tx, row!.id, constructionObjectIds, p.id);
        await replaceDepartmentHeads(tx, row!.id, headUserIds, p.id);
        // Событие пишется в ЭТОЙ же транзакции (ADR 0144, решение 8): набор площадок и есть
        // область доступа, а разница набора не хранится больше нигде — карточка показывает только
        // «сейчас». Отказ записи откатывает создание отдела целиком, и это верно: отдел с
        // площадками, о которых журнал молчит, — ровно то состояние, ради которого журнал заведён.
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'department.create',
          entityType: 'department',
          entityId: row!.id,
          metadata: { objects },
        });
        return row!;
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
      const { headUserIds, constructionObjectIds, ...body } = req.body;
      await db.transaction(async (tx) => {
        /*
         * The department row is taken `FOR UPDATE` first, the same lock `replaceDepartmentObjects`
         * takes inside: the whole edit (row, sites, heads, audit) is serialized against a concurrent
         * edit of the same department, and a missing row answers 404 before anything is written.
         * The second lock inside the service costs nothing: the transaction already holds the row.
         */
        const [before] = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(eq(departments.id, id))
          .for('update');
        if (!before) throw err.notFound('Отдел не найден');

        await tx
          .update(departments)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(departments.id, id));

        /*
         * Отсутствие поля — «не трогать набор», пустой массив — «снять все» (Р3). Разница
         * существенная: снятие меняет область сотрудникам отдела и гасит их сессии, и «клиент не
         * прислал поле» не должно означать того же.
         *
         * Площадки идут ПЕРЕД руководителями по той же причине, что и при создании: смена набора
         * поднимает `authVersion` всем, кто в отделе, и назначенный первым руководитель получил бы
         * его дважды.
         */
        const objects =
          constructionObjectIds === undefined
            ? NO_OBJECT_CHANGES
            : await replaceDepartmentObjects(tx, id, constructionObjectIds, p.id);
        // Отсутствие поля — «не трогать привязки»: их правят и из карточки учётки.
        const heads =
          headUserIds === undefined ? [] : await replaceDepartmentHeads(tx, id, headUserIds, p.id);

        /*
         * Сессии здесь больше не гасятся: это делают оба сервиса внутри транзакции (ADR 0144,
         * решение 6). Прежний маршрутный отзыв шёл после коммита и потому был негарантирован —
         * правка записана, отзыв упал, живые сессии остались.
         *
         * `headsChanged` считается по СВОЕМУ набору, а не по объединённому списку затронутых
         * учёток, как считался раньше: тот включал и сотрудников, которых задела смена площадки,
         * и потому смена одной лишь площадки писала в журнал, что меняли руководителей.
         */
        await writeAuditTx(tx, {
          actorUserId: p.id,
          action: 'department.update',
          entityType: 'department',
          entityId: id,
          metadata: { headsChanged: heads.length > 0, objects },
        });
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
