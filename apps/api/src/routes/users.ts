import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, exists, gte, isNull, lte, or, sql } from 'drizzle-orm';
import {
  can,
  type CounterpartyType,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeHasAccounts,
  counterpartyTypeLabels,
  createUserSchema,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  rejectUserSchema,
  roleLabels,
  setUserPasswordSchema,
  updateUserSchema,
  userListQuerySchema,
  type UserDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { counterparties, userConstructionObjects, users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { hashPassword } from '../auth/password';
import { revokeAllForUser } from '../auth/sessions';
import { orderByFrom, pageParams, phoneSearchCondition, searchCondition } from '../lib/pagination';
import {
  departmentIdsOfUser,
  departmentsByUserIds,
  objectIdsOfUser,
  objectsByUserIds,
  replaceUserDepartments,
  replaceUserObjects,
} from '../services/user-scopes';

const idParams = z.object({ id: z.string().uuid() });

/**
 * Заявка на регистрацию: учётка, которую завёл сам пользователь и которую администратор ещё не
 * рассмотрел. Отличается от деактивированной именно отсутствием роли — роль назначают вместе с
 * активацией, а саморегистрация её не ставит (ADR 0034).
 */
const unreviewedRegistration = and(eq(users.isActive, false), isNull(users.role));

/**
 * То же среди действующих записей — для счётчика и для списка без архива. Отклонённая заявка
 * ушла в soft delete и в очереди не висит, но остаётся заявкой: с `includeDeleted` список
 * показывает и её, поэтому признак «удалена» стоит отдельным условием, а не внутри этого.
 */
const pendingRegistration = and(isNull(users.deletedAt), unreviewedRegistration);

interface UserRowJoined {
  id: string;
  email: string;
  lastName: string;
  firstName: string;
  middleName: string;
  fullName: string;
  phone: string;
  requestedRole: UserDto['requestedRole'];
  requestedObject: string;
  requestedCompany: string;
  role: UserDto['role'];
  isActive: boolean;
  mustChangePassword: boolean;
  counterpartyId: string | null;
  counterpartyName: string | null;
  counterpartyType: CounterpartyType | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(
  r: UserRowJoined,
  objects: UserDto['constructionObjects'],
  departments: UserDto['departments'],
): UserDto {
  return {
    id: r.id,
    email: r.email,
    lastName: r.lastName,
    firstName: r.firstName,
    middleName: r.middleName,
    fullName: r.fullName,
    phone: r.phone,
    requestedRole: r.requestedRole,
    requestedObject: r.requestedObject,
    requestedCompany: r.requestedCompany,
    role: r.role,
    isActive: r.isActive,
    mustChangePassword: r.mustChangePassword,
    constructionObjects: objects,
    departments,
    counterpartyId: r.counterpartyId,
    counterpartyName: r.counterpartyName,
    counterpartyType: r.counterpartyType,
    deletedAt: r.deletedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const selectCols = {
  id: users.id,
  email: users.email,
  lastName: users.lastName,
  firstName: users.firstName,
  middleName: users.middleName,
  fullName: users.fullName,
  phone: users.phone,
  requestedRole: users.requestedRole,
  requestedObject: users.requestedObject,
  requestedCompany: users.requestedCompany,
  role: users.role,
  isActive: users.isActive,
  mustChangePassword: users.mustChangePassword,
  counterpartyId: users.counterpartyId,
  counterpartyName: counterparties.name,
  counterpartyType: counterparties.type,
  deletedAt: users.deletedAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

function usersQuery() {
  return db
    .select(selectCols)
    .from(users)
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id));
}

/** Карточка учётки всегда идёт с областью: клиент правит набор, а не отдельные привязки. */
async function fetchUserDto(id: string): Promise<UserDto | null> {
  const [row] = await usersQuery().where(eq(users.id, id));
  if (!row) return null;
  const [objects, departments] = await Promise.all([
    objectsByUserIds([id]),
    departmentsByUserIds([id]),
  ]);
  return toDto(row, objects.get(id) ?? [], departments.get(id) ?? []);
}

/**
 * Контрагент учётки (ADR 0010, 0038). Для внешнего исполнителя он обязателен и задаёт сразу
 * две вещи: чьи заявки видны и в каком модуле учётка работает — модуль следует из типа
 * контрагента (оператор вывоза ведёт вывоз, арендодатель ТС — заказ техники).
 *
 * Годятся только типы, за которых в портале кто-то работает (`COUNTERPARTY_TYPES_WITH_ACCOUNTS`,
 * выводятся из матрицы прав): учётка на генподрядчике не получила бы ни одного модульного права
 * и вошла бы в портал, где ей нечего делать. Для остальных ролей поле пустое — область видимости
 * у них задаётся иначе (объект у «Штаба») или не ограничена.
 */
async function resolveCounterpartyId(
  role: UserDto['role'],
  counterpartyId: string | null | undefined,
): Promise<string | null> {
  if (!isCounterpartyScopedRole(role)) return null;
  if (!counterpartyId) {
    throw err.badRequest(`Для роли «${roleLabels[role!]}» обязателен контрагент`, {
      counterpartyId: 'Выберите контрагента',
    });
  }
  const [cp] = await db
    .select({
      type: counterparties.type,
      isActive: counterparties.isActive,
      deletedAt: counterparties.deletedAt,
    })
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId));
  if (!cp || cp.deletedAt) throw err.badRequest('Контрагент не найден');
  if (!counterpartyTypeHasAccounts(cp.type)) {
    const allowed = COUNTERPARTY_TYPES_WITH_ACCOUNTS.map(
      (t) => `«${counterpartyTypeLabels[t]}»`,
    ).join(' или ');
    throw err.badRequest(`Учётку исполнителя можно привязать к контрагенту типа ${allowed}`, {
      counterpartyId: `Нужен контрагент типа ${allowed}`,
    });
  }
  if (!cp.isActive) throw err.badRequest('Контрагент неактивен');
  return counterpartyId;
}

/**
 * Объекты учётки (ADR 0039). Инвариант «объектной роли обязателен объект» держится здесь:
 * с переходом на множественную привязку CHECK `users_rukstroy_object_check` снят — он читал
 * колонку своей строки, а набор лежит в отдельной таблице (миграция 0063).
 *
 * У остальных ролей набор пуст, как и контрагент: область у них задана иначе или не ограничена,
 * а привязка, ни на что не влияющая, в карточке читается как действующее ограничение.
 */
function resolveObjectIds(role: UserDto['role'], objectIds: string[]): string[] {
  if (!isObjectScopedRole(role)) return [];
  if (objectIds.length === 0) {
    throw err.badRequest(`Для роли «${roleLabels[role!]}» обязателен объект`, {
      constructionObjectIds: 'Укажите хотя бы один объект',
    });
  }
  return objectIds;
}

/**
 * Отделы учётки (ADR 0040) — вторая ось области, по тому же правилу, что объекты. Пустой набор
 * у остальных ролей означает и второй инвариант: объекты и отделы вместе не встречаются, потому
 * что роль работает ровно на одной оси — обнулением набора чужой оси он и держится.
 *
 * В БД это не выражается: CHECK читает колонки своей строки, а наборы лежат в двух отдельных
 * таблицах. Отсюда же требование к клиенту не присылать оба набора — оно проверяется схемой
 * (`createUserSchema`), чтобы ошибка указала на поле, а не пришла общим 400.
 */
function resolveDepartmentIds(role: UserDto['role'], departmentIds: string[]): string[] {
  if (!isDepartmentScopedRole(role)) return [];
  if (departmentIds.length === 0) {
    throw err.badRequest(`Для роли «${roleLabels[role!]}» обязателен отдел`, {
      departmentIds: 'Укажите хотя бы один отдел',
    });
  }
  return departmentIds;
}

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = { preHandler: [app.authenticate, app.requirePermission('users.manage')] };

  r.get('/', { ...guards, schema: { querystring: userListQuerySchema } }, async (req) => {
    const q = req.query;
    // Архив просит право `archive.read`, как и в остальных списках: право вести учётки и право
    // видеть удалённое — разные, и одно другого не подразумевает.
    const showDeleted = q.includeDeleted && can(requirePrincipal(req), 'archive.read');
    const where = and(
      showDeleted ? undefined : isNull(users.deletedAt),
      q.role === undefined ? undefined : eq(users.role, q.role),
      q.isActive === undefined ? undefined : eq(users.isActive, q.isActive),
      q.pending ? unreviewedRegistration : undefined,
      // Объект в наборе учётки (ADR 0039): EXISTS, а не join, — иначе строка размножилась бы по
      // числу объектов и `total` считал бы привязки вместо людей.
      q.constructionObjectId === undefined
        ? undefined
        : exists(
            db
              .select({ one: sql`1` })
              .from(userConstructionObjects)
              .where(
                and(
                  eq(userConstructionObjects.userId, users.id),
                  eq(userConstructionObjects.constructionObjectId, q.constructionObjectId),
                ),
              ),
          ),
      q.counterpartyId === undefined ? undefined : eq(users.counterpartyId, q.counterpartyId),
      q.requestedRole === undefined ? undefined : eq(users.requestedRole, q.requestedRole),
      // Дата регистрации — календарные сутки Europe/Moscow: `created_at` хранит момент времени, и
      // без явных границ дня «с 1 июля» отрезало бы утро первого числа по UTC.
      q.createdFrom === undefined
        ? undefined
        : gte(users.createdAt, new Date(`${q.createdFrom}T00:00:00.000+03:00`)),
      q.createdTo === undefined
        ? undefined
        : lte(users.createdAt, new Date(`${q.createdTo}T23:59:59.999+03:00`)),
      // Поиск идёт по трём полям сразу: адрес и ФИО — подстрокой как есть, телефон — по цифрам,
      // потому что записан он свободно и «9261234567» обязано находить «+7 926 123-45-67».
      or(
        searchCondition(q.search, [users.email, users.fullName]),
        phoneSearchCondition(q.search, users.phone),
      ),
    );
    const sortCols = {
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      counterpartyName: counterparties.name,
      isActive: users.isActive,
      createdAt: users.createdAt,
    };
    const p = pageParams(q);
    const [rows, totalRows] = await Promise.all([
      usersQuery()
        .where(where)
        .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
        .limit(p.limit)
        .offset(p.offset),
      db.select({ c: count() }).from(users).where(where),
    ]);
    const ids = rows.map((row) => row.id);
    const [objects, departments] = await Promise.all([
      objectsByUserIds(ids),
      departmentsByUserIds(ids),
    ]);
    return {
      items: rows.map((row) => toDto(row, objects.get(row.id) ?? [], departments.get(row.id) ?? [])),
      total: Number(totalRows[0]!.c),
      page: p.page,
      pageSize: p.pageSize,
    };
  });

  /**
   * Счётчик для бейджа в меню. Отдельным маршрутом, а не полем в списке: бейдж рисуется на
   * каждой странице портала, и тянуть ради него страницу пользователей — лишний трафик.
   */
  r.get('/pending-count', guards, async () => {
    const [row] = await db.select({ c: count() }).from(users).where(pendingRegistration);
    return { count: Number(row!.c) };
  });

  r.post('/', { ...guards, schema: { body: createUserSchema } }, async (req, reply) => {
    const actor = requirePrincipal(req);
    const body = req.body;
    const passwordHash = await hashPassword(body.password);
    const counterpartyId = await resolveCounterpartyId(body.role, body.counterpartyId);
    const objectIds = resolveObjectIds(body.role, body.constructionObjectIds);
    const departmentIds = resolveDepartmentIds(body.role, body.departmentIds);
    const created = await db.transaction(async (tx) => {
      const dup = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.email));
      if (dup.length > 0) throw err.conflict('Пользователь с таким email уже существует');
      const [row] = await tx
        .insert(users)
        .values({
          email: body.email,
          lastName: body.lastName,
          firstName: body.firstName,
          middleName: body.middleName,
          phone: body.phone,
          role: body.role,
          passwordHash,
          isActive: body.isActive,
          counterpartyId,
        })
        .returning({ id: users.id });
      await replaceUserObjects(tx, row!.id, objectIds, actor.id);
      await replaceUserDepartments(tx, row!.id, departmentIds, actor.id);
      return row!;
    });
    await writeAudit({
      actorUserId: actor.id,
      action: 'user.create',
      entityType: 'user',
      entityId: created.id,
      metadata: { role: body.role },
    });
    reply.code(201);
    return (await fetchUserDto(created.id))!;
  });

  r.patch(
    '/:id',
    { ...guards, schema: { params: idParams, body: updateUserSchema } },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;
      const [existing] = await db.select().from(users).where(eq(users.id, id));
      if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');

      // защита от самоблокировки
      if (actor.id === id) {
        if (body.isActive === false)
          throw err.badRequest('Нельзя деактивировать собственный аккаунт');
        if (body.role && body.role !== existing.role) {
          throw err.badRequest('Нельзя менять собственную роль');
        }
      }

      const nextRole = body.role ?? existing.role;
      // Активная учётка без роли не попадает ни под одно ограничение доступа: проверки
      // сформулированы от конкретных ролей («штаб — свой объект», «оператор — свой контрагент»),
      // и учётка без роли видит все заявки вывоза. Роль назначается вместе с активацией.
      if ((body.isActive ?? existing.isActive) && !nextRole) {
        throw err.badRequest('Нельзя активировать учётку без роли', { role: 'Выберите роль' });
      }
      const nextCounterpartyId = await resolveCounterpartyId(
        nextRole,
        body.counterpartyId !== undefined ? body.counterpartyId : existing.counterpartyId,
      );

      const roleChanged = body.role !== undefined && body.role !== existing.role;
      const deactivated = body.isActive === false && existing.isActive;
      // Смена контрагента у исполнителя — это смена и модуля, и области видимости (ADR 0038):
      // права учётки после неё другие, поэтому выданные токены гасятся так же, как при смене роли.
      const counterpartyChanged = nextCounterpartyId !== existing.counterpartyId;

      const scopeChanged = await db.transaction(async (tx) => {
        // Отсутствие поля — «не трогать привязки»; при этом смена роли на объектную или
        // отдельскую требует области и без поля: набор, оставшийся от прежней роли, проверяется
        // наравне с присланным. Смена оси при этом обнуляет чужой набор сама — `resolve*`
        // возвращают пустой список всем, кроме своей роли.
        const [currentObjects, currentDepartments] = await Promise.all([
          objectIdsOfUser(tx, id),
          departmentIdsOfUser(tx, id),
        ]);
        const nextObjectIds = resolveObjectIds(
          nextRole,
          body.constructionObjectIds ?? currentObjects,
        );
        const nextDepartmentIds = resolveDepartmentIds(
          nextRole,
          body.departmentIds ?? currentDepartments,
        );
        const objectsChanged = await replaceUserObjects(tx, id, nextObjectIds, actor.id);
        const departmentsChanged = await replaceUserDepartments(
          tx,
          id,
          nextDepartmentIds,
          actor.id,
        );
        const changed = objectsChanged || departmentsChanged;
        await tx
          .update(users)
          .set({
            lastName: body.lastName ?? existing.lastName,
            firstName: body.firstName ?? existing.firstName,
            middleName: body.middleName ?? existing.middleName,
            // Телефон правится как ФИО: поле не прислали — не трогаем, прислали пустым — стёрли.
            phone: body.phone ?? existing.phone,
            role: nextRole,
            isActive: body.isActive ?? existing.isActive,
            counterpartyId: nextCounterpartyId,
            authVersion:
              roleChanged || counterpartyChanged || deactivated || changed
                ? existing.authVersion + 1
                : existing.authVersion,
            updatedAt: new Date(),
          })
          .where(eq(users.id, id));
        return changed;
      });

      // Сменившаяся область гасит токены наравне со сменой роли и контрагента: учётке стали
      // видны другие заявки.
      const bumpAuth = roleChanged || counterpartyChanged || deactivated || scopeChanged;
      if (bumpAuth) await revokeAllForUser(id);
      await writeAudit({
        actorUserId: actor.id,
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        metadata: { roleChanged, counterpartyChanged, deactivated, scopeChanged },
      });
      return (await fetchUserDto(id))!;
    },
  );

  r.post(
    '/:id/password',
    { ...guards, schema: { params: idParams, body: setUserPasswordSchema } },
    async (req) => {
      const { id } = req.params;
      const [existing] = await db.select().from(users).where(eq(users.id, id));
      if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');
      const passwordHash = await hashPassword(req.body.newPassword);
      await db
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: true,
          authVersion: existing.authVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
      await revokeAllForUser(id);
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'user.reset_password',
        entityType: 'user',
        entityId: id,
      });
      return { ok: true };
    },
  );

  /**
   * Отказ по заявке на регистрацию. Технически это тот же soft delete, что и удаление учётки,
   * но отдельным действием: в аудите «отклонена заявка, потому что <причина>» и «удалён
   * сотрудник» — разные события, и разбирать их потом приходится по-разному.
   */
  r.post(
    '/:id/reject',
    { ...guards, schema: { params: idParams, body: rejectUserSchema } },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const [existing] = await db.select().from(users).where(eq(users.id, id));
      if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');
      // Отклонять можно только нерассмотренную заявку: у действующей учётки для этого есть
      // деактивация и удаление, и подменять их отказом — терять смысл записи в аудите.
      if (existing.isActive || existing.role) {
        throw err.badRequest('Отклонить можно только заявку, которая ещё не рассмотрена');
      }
      await db
        .update(users)
        .set({
          deletedAt: new Date(),
          authVersion: existing.authVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
      await revokeAllForUser(id);
      await writeAudit({
        actorUserId: actor.id,
        action: 'user.reject_registration',
        entityType: 'user',
        entityId: id,
        metadata: { reason: req.body.reason, email: existing.email },
      });
      return { ok: true };
    },
  );

  r.delete('/:id', { ...guards, schema: { params: idParams } }, async (req) => {
    const actor = requirePrincipal(req);
    const { id } = req.params;
    if (actor.id === id) throw err.badRequest('Нельзя удалить собственный аккаунт');
    const [existing] = await db.select().from(users).where(eq(users.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');
    await db
      .update(users)
      .set({
        isActive: false,
        deletedAt: new Date(),
        authVersion: existing.authVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
    await revokeAllForUser(id);
    await writeAudit({
      actorUserId: actor.id,
      action: 'user.delete',
      entityType: 'user',
      entityId: id,
    });
    return { ok: true };
  });
}
