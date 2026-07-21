import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, isNull } from 'drizzle-orm';
import {
  createUserSchema,
  setUserPasswordSchema,
  updateUserSchema,
  userListQuerySchema,
  type UserDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { constructionObjects, users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { hashPassword } from '../auth/password';
import { revokeAllForUser } from '../auth/sessions';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';

const idParams = z.object({ id: z.string().uuid() });

interface UserRowJoined {
  id: string;
  email: string;
  fullName: string;
  role: UserDto['role'];
  isActive: boolean;
  mustChangePassword: boolean;
  constructionObjectId: string | null;
  objectName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(r: UserRowJoined): UserDto {
  return {
    id: r.id,
    email: r.email,
    fullName: r.fullName,
    role: r.role,
    isActive: r.isActive,
    mustChangePassword: r.mustChangePassword,
    constructionObjectId: r.constructionObjectId,
    constructionObjectName: r.objectName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const selectCols = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  role: users.role,
  isActive: users.isActive,
  mustChangePassword: users.mustChangePassword,
  constructionObjectId: users.constructionObjectId,
  objectName: constructionObjects.name,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

async function fetchUserDto(id: string): Promise<UserDto | null> {
  const [row] = await db
    .select(selectCols)
    .from(users)
    .leftJoin(constructionObjects, eq(users.constructionObjectId, constructionObjects.id))
    .where(eq(users.id, id));
  return row ? toDto(row) : null;
}

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const adminOnly = app.requireRoles('admin');
  const guards = { preHandler: [app.authenticate, adminOnly] };

  r.get('/', { ...guards, schema: { querystring: userListQuerySchema } }, async (req) => {
    const q = req.query;
    const where = and(
      isNull(users.deletedAt),
      q.role === undefined ? undefined : eq(users.role, q.role),
      q.isActive === undefined ? undefined : eq(users.isActive, q.isActive),
      searchCondition(q.search, [users.email, users.fullName]),
    );
    const sortCols = {
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    };
    const p = pageParams(q);
    const [rows, totalRows] = await Promise.all([
      db
        .select(selectCols)
        .from(users)
        .leftJoin(constructionObjects, eq(users.constructionObjectId, constructionObjects.id))
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

  r.post('/', { ...guards, schema: { body: createUserSchema } }, async (req, reply) => {
    const body = req.body;
    const dup = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (dup.length > 0) throw err.conflict('Пользователь с таким email уже существует');
    const passwordHash = await hashPassword(body.password);
    const [created] = await db
      .insert(users)
      .values({
        email: body.email,
        fullName: body.fullName,
        role: body.role,
        passwordHash,
        isActive: body.isActive,
        constructionObjectId: body.constructionObjectId ?? null,
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

  r.patch('/:id', { ...guards, schema: { params: idParams, body: updateUserSchema } }, async (req) => {
    const actor = requirePrincipal(req);
    const { id } = req.params;
    const body = req.body;
    const [existing] = await db.select().from(users).where(eq(users.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');

    // защита от самоблокировки
    if (actor.id === id) {
      if (body.isActive === false) throw err.badRequest('Нельзя деактивировать собственный аккаунт');
      if (body.role && body.role !== existing.role) {
        throw err.badRequest('Нельзя менять собственную роль');
      }
    }

    const nextRole = body.role ?? existing.role;
    const nextObjectId =
      body.constructionObjectId !== undefined
        ? body.constructionObjectId
        : existing.constructionObjectId;
    if (nextRole === 'shtab' && !nextObjectId) {
      throw err.badRequest('Для роли «Штаб» обязателен объект', {
        constructionObjectId: 'Укажите объект',
      });
    }

    const roleChanged = body.role !== undefined && body.role !== existing.role;
    const deactivated = body.isActive === false && existing.isActive;
    const bumpAuth = roleChanged || deactivated;

    await db
      .update(users)
      .set({
        fullName: body.fullName ?? existing.fullName,
        role: nextRole,
        isActive: body.isActive ?? existing.isActive,
        constructionObjectId: nextObjectId ?? null,
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
      metadata: { roleChanged, deactivated },
    });
    return (await fetchUserDto(id))!;
  });

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
