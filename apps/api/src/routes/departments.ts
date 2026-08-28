import type { FastifyInstance, FastifyRequest } from 'fastify';
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
  objectIdsOfDepartment,
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
    /*
     * Совместимая проекция набора на один релиз (ADR 0144, решение 5): один элемент, когда в
     * наборе ровно один объект, и `null` при пустом наборе и при наборе из нескольких.
     *
     * Считается из уже загруженного набора, а не из колонки `departments.construction_object_id`:
     * колонка — такая же проекция, только записанная, и читать её значило бы держать два
     * источника одного значения, расходящиеся при первой же правке мимо `replaceDepartmentObjects`
     * (перенос, триггер совместимости, ручной `UPDATE` в базе).
     *
     * `null` при наборе из нескольких — намеренно: старая форма такой набор не выражает, и,
     * показав ей одну площадку из трёх, мы получили бы обратно её же одну, а сохранение названия
     * схлопнуло бы набор. Её PATCH со старым полем против такого набора встречает 409 ниже.
     */
    object: objects.length === 1 ? objects[0]! : null,
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

/**
 * Запросы, приславшие **старое** поле площадки (`constructionObjectId`, ADR 0062).
 *
 * Зачем признак вообще. Контракт нормализует старое поле в набор ещё до маршрута
 * (`withLegacyObjectId`, `z.preprocess`): наружу схема отдаёт только `constructionObjectIds`, и
 * legacy-запрос `{ constructionObjectId: X }` к моменту обработчика неотличим от нового
 * `{ constructionObjectIds: [X] }`. А различать их обязательно: для нового клиента `[X]` — это
 * осознанное «оставить одну площадку из трёх», для старой вкладки — то единственное, что она
 * вообще способна выразить, и против набора из нескольких площадок такой запрос обязан получить
 * 409, а не молча снести две из трёх (ADR 0144, решение 5).
 *
 * Почему `preValidation`, а не флаг из контракта. Пометка в разобранном теле означала бы поле,
 * которого нет в предметной модели: `CreateDepartmentInput`/`UpdateDepartmentInput` читают ещё и
 * загрузка справочника файлом, и портал, и всем им пришлось бы про алиас знать — а снимается он
 * через релиз (этап 9 плана). `preValidation` — единственная точка лайфцикла, где исходное тело
 * ещё видно целиком, и вся совместимость остаётся в двух местах: предобработка схемы и вот этот
 * хук, оба с одним сроком жизни.
 *
 * `WeakSet` по объекту запроса, а не `decorateRequest`: признак нужен ровно одному маршруту на
 * один релиз, а декоратор пришлось бы объявлять расширением типа `FastifyRequest` на весь портал
 * и потом не забыть убрать. Ссылок `WeakSet` не держит — запрос уходит вместе с ответом.
 */
const legacyObjectIdRequests = new WeakSet<FastifyRequest>();

/**
 * Тот же признак «поле пришло», что и у предобработки контракта, — и условие обязано совпадать с
 * ней слово в слово (`legacy === undefined` — «поля не было»), иначе схема и маршрут разошлись бы
 * в понимании одного и того же тела.
 */
async function markLegacyObjectId(req: FastifyRequest): Promise<void> {
  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
  if ((body as Record<string, unknown>).constructionObjectId !== undefined) {
    legacyObjectIdRequests.add(req);
  }
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
         * Порядок «отдел → площадки → руководители» (этап 3 плана) не произволен. Оба набора
         * поднимают `authVersion` тем, кого затрагивают, и площадки поднимают его ВСЕМ, кто в
         * отделе состоит. Назначь мы руководителей первыми — их учётки получили бы версию дважды:
         * привязкой и следом сменой площадок, случившейся уже после них. Итог тот же, но лишний
         * скачок версии выглядит в журнале второй правкой доступа, которой не было.
         *
         * Отдел заводится без площадок, а набор ставится следом отдельным вызовом, потому что
         * писатель набора один и делает он больше, чем `INSERT`: проверку объектов, порог,
         * проекцию в колонку совместимости и разницу для аудита.
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
      // Признак «пришло старое поле площадки» снимается ДО разбора тела — после него алиас уже
      // нормализован в набор и отличить одно от другого нечем (см. `legacyObjectIdRequests`).
      preValidation: markLegacyObjectId,
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateDepartmentSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const { headUserIds, constructionObjectIds, ...body } = req.body;
      const sentLegacyObjectId = legacyObjectIdRequests.has(req);
      await db.transaction(async (tx) => {
        /*
         * Строка отдела берётся `FOR UPDATE` с самого начала — той же блокировкой, что возьмёт
         * внутри себя `replaceDepartmentObjects`. Взять её здесь нужно ради проверки ниже: она
         * сравнивает присланное с ТЕКУЩИМ набором, и без блокировки этот набор мог бы смениться
         * между сравнением и записью. Повторная блокировка внутри сервиса ничего не стоит —
         * транзакция уже держит строку.
         */
        const [before] = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(eq(departments.id, id))
          .for('update');
        if (!before) throw err.notFound('Отдел не найден');

        /*
         * Совместимость на один релиз (ADR 0144, решение 5). Старая вкладка справочника выражает
         * ровно одну площадку и шлёт её при КАЖДОМ сохранении карточки — даже когда правят одно
         * название. Против набора из нескольких площадок такой запрос означал бы «оставить одну из
         * трёх», чего человек за старой формой не выбирал и выбрать не мог: он просто не видит
         * набора. Отказ вместо молчаливой потери — сознательный размен: название не сохранится,
         * пока вкладку не обновят, зато площадки не исчезнут.
         *
         * Набор из одного и пустой набор старая форма выражает верно, и её PATCH принимается как
         * есть — иначе совместимость не давала бы работать вовсе.
         */
        if (sentLegacyObjectId) {
          const current = await objectIdsOfDepartment(tx, id);
          if (current.length > 1) {
            throw err.conflict('У отдела несколько площадок — обновите страницу');
          }
        }

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
