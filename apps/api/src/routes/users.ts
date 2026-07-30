import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, isNull } from 'drizzle-orm';
import {
  type CounterpartyType,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeHasAccounts,
  counterpartyTypeLabels,
  createUserSchema,
  isCounterpartyScopedRole,
  isObjectScopedRole,
  rejectUserSchema,
  roleLabels,
  setUserPasswordSchema,
  updateUserSchema,
  userListQuerySchema,
  type UserDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { constructionObjects, counterparties, users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { hashPassword } from '../auth/password';
import { revokeAllForUser } from '../auth/sessions';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

const idParams = z.object({ id: z.string().uuid() });

/**
 * Заявка на регистрацию: учётка, которую завёл сам пользователь и которую администратор ещё не
 * рассмотрел. Отличается от деактивированной именно отсутствием роли — роль назначают вместе с
 * активацией, а саморегистрация её не ставит (ADR 0034).
 */
const pendingRegistration = and(
  isNull(users.deletedAt),
  eq(users.isActive, false),
  isNull(users.role),
);

interface UserRowJoined {
  id: string;
  email: string;
  lastName: string;
  firstName: string;
  middleName: string;
  fullName: string;
  requestedRole: UserDto['requestedRole'];
  requestedObject: string;
  requestedCompany: string;
  role: UserDto['role'];
  isActive: boolean;
  mustChangePassword: boolean;
  constructionObjectId: string | null;
  objectName: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  counterpartyType: CounterpartyType | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(r: UserRowJoined): UserDto {
  return {
    id: r.id,
    email: r.email,
    lastName: r.lastName,
    firstName: r.firstName,
    middleName: r.middleName,
    fullName: r.fullName,
    requestedRole: r.requestedRole,
    requestedObject: r.requestedObject,
    requestedCompany: r.requestedCompany,
    role: r.role,
    isActive: r.isActive,
    mustChangePassword: r.mustChangePassword,
    constructionObjectId: r.constructionObjectId,
    constructionObjectName: r.objectName,
    counterpartyId: r.counterpartyId,
    counterpartyName: r.counterpartyName,
    counterpartyType: r.counterpartyType,
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
  requestedRole: users.requestedRole,
  requestedObject: users.requestedObject,
  requestedCompany: users.requestedCompany,
  role: users.role,
  isActive: users.isActive,
  mustChangePassword: users.mustChangePassword,
  constructionObjectId: users.constructionObjectId,
  objectName: constructionObjects.name,
  counterpartyId: users.counterpartyId,
  counterpartyName: counterparties.name,
  counterpartyType: counterparties.type,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

function usersQuery() {
  return db
    .select(selectCols)
    .from(users)
    .leftJoin(constructionObjects, eq(users.constructionObjectId, constructionObjects.id))
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id));
}

async function fetchUserDto(id: string): Promise<UserDto | null> {
  const [row] = await usersQuery().where(eq(users.id, id));
  return row ? toDto(row) : null;
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

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = { preHandler: [app.authenticate, app.requirePermission('users.manage')] };

  r.get('/', { ...guards, schema: { querystring: userListQuerySchema } }, async (req) => {
    const q = req.query;
    const where = and(
      isNull(users.deletedAt),
      q.role === undefined ? undefined : eq(users.role, q.role),
      q.isActive === undefined ? undefined : eq(users.isActive, q.isActive),
      q.pending ? pendingRegistration : undefined,
      searchCondition(q.search, [users.email, users.fullName]),
    );
    const sortCols = {
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      constructionObjectName: constructionObjects.name,
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
    return {
      items: rows.map(toDto),
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
    const body = req.body;
    const dup = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (dup.length > 0) throw err.conflict('Пользователь с таким email уже существует');
    const passwordHash = await hashPassword(body.password);
    const counterpartyId = await resolveCounterpartyId(body.role, body.counterpartyId);
    const [created] = await db
      .insert(users)
      .values({
        email: body.email,
        lastName: body.lastName,
        firstName: body.firstName,
        middleName: body.middleName,
        role: body.role,
        passwordHash,
        isActive: body.isActive,
        constructionObjectId: body.constructionObjectId ?? null,
        counterpartyId,
      })
      .returning({ id: users.id });
    await writeAudit({
      actorUserId: requirePrincipal(req).id,
      action: 'user.create',
      entityType: 'user',
      entityId: created!.id,
      metadata: { role: body.role },
    });
    reply.code(201);
    return (await fetchUserDto(created!.id))!;
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
      const nextObjectId =
        body.constructionObjectId !== undefined
          ? body.constructionObjectId
          : existing.constructionObjectId;
      // Объектные роли («Штаб», «Руководитель строительства») без объекта не ограничены ничем и
      // одновременно не видят ни одной заявки — объект назначается вместе с ролью (ADR 0025).
      if (isObjectScopedRole(nextRole) && !nextObjectId) {
        throw err.badRequest(`Для роли «${roleLabels[nextRole!]}» обязателен объект`, {
          constructionObjectId: 'Укажите объект',
        });
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
      const bumpAuth = roleChanged || counterpartyChanged || deactivated;

      await db
        .update(users)
        .set({
          lastName: body.lastName ?? existing.lastName,
          firstName: body.firstName ?? existing.firstName,
          middleName: body.middleName ?? existing.middleName,
          role: nextRole,
          isActive: body.isActive ?? existing.isActive,
          constructionObjectId: nextObjectId ?? null,
          counterpartyId: nextCounterpartyId,
          authVersion: bumpAuth ? existing.authVersion + 1 : existing.authVersion,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));

      if (bumpAuth) await revokeAllForUser(id);
      await writeAudit({
        actorUserId: actor.id,
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        metadata: { roleChanged, counterpartyChanged, deactivated },
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
