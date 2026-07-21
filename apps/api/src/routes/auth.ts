import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import {
  type AuthUser,
  changePasswordSchema,
  loginSchema,
  registerSchema,
  type Role,
} from '@technic/contracts';
import { config } from '../config';
import { db } from '../db/client';
import { users } from '../db/schema';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from '../lib/cookies';
import { hashPassword, verifyPassword } from '../auth/password';
import { signAccessToken } from '../auth/tokens';
import {
  createRefreshSession,
  revokeAllForUser,
  revokeRefreshByToken,
  rotateRefreshSession,
} from '../auth/sessions';
import { loadPrincipal } from '../auth/principal';
import { requirePrincipal } from '../auth/plugin';

interface AuthUserSource {
  id: string;
  email: string;
  fullName: string;
  role: Role | null;
  isActive: boolean;
  mustChangePassword: boolean;
  constructionObjectId: string | null;
}

function makeAuthUser(u: AuthUserSource): AuthUser {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    constructionObjectId: u.constructionObjectId,
  };
}

/** Защита cookie-эндпоинтов от CSRF: проверка Origin (при single-origin + SameSite=Strict). */
function assertCookieOrigin(req: FastifyRequest): void {
  if (!config.isProd) return;
  const origin = req.headers.origin;
  if (!origin || origin !== config.publicOrigin) {
    throw err.forbidden('Недопустимый источник запроса');
  }
}

const authRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const ctx = (req: FastifyRequest) => ({
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  r.post(
    '/register',
    { schema: { body: registerSchema }, config: authRateLimit },
    async (req, reply) => {
      const { email, fullName, password } = req.body;
      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing.length > 0) {
        throw err.conflict('Пользователь с таким email уже существует');
      }
      const passwordHash = await hashPassword(password);
      const [created] = await db
        .insert(users)
        .values({ email, fullName, passwordHash, isActive: false })
        .returning({ id: users.id });
      await writeAudit({
        actorUserId: created!.id,
        action: 'user.register',
        entityType: 'user',
        entityId: created!.id,
      });
      reply.code(201);
      return {
        ok: true,
        message: 'Регистрация принята. Вход будет доступен после активации администратором.',
      };
    },
  );

  r.post('/login', { schema: { body: loginSchema }, config: authRateLimit }, async (req, reply) => {
    const { email, password } = req.body;
    const [u] = await db.select().from(users).where(eq(users.email, email));
    if (!u || u.deletedAt) throw err.invalidCredentials();
    const ok = await verifyPassword(u.passwordHash, password);
    if (!ok) throw err.invalidCredentials();
    if (!u.isActive) {
      throw err.inactive('Аккаунт не активирован — обратитесь к администратору');
    }

    const accessToken = await signAccessToken({ sub: u.id, role: u.role, av: u.authVersion });
    const refresh = await createRefreshSession(u.id, ctx(req));
    setRefreshCookie(reply, refresh.token, refresh.expiresAt);
    await writeAudit({
      actorUserId: u.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: u.id,
    });
    return { accessToken, expiresIn: config.auth.accessTtl, user: makeAuthUser(u) };
  });

  r.post('/refresh', { config: authRateLimit }, async (req, reply) => {
    assertCookieOrigin(req);
    const raw = readRefreshCookie(req);
    if (!raw) throw err.unauthorized('Отсутствует refresh-токен');
    let rotated;
    try {
      rotated = await rotateRefreshSession(raw, ctx(req));
    } catch (e) {
      clearRefreshCookie(reply);
      throw e;
    }
    const principal = await loadPrincipal(rotated.userId);
    if (!principal) {
      clearRefreshCookie(reply);
      throw err.unauthorized('Сессия недействительна');
    }
    setRefreshCookie(reply, rotated.token, rotated.expiresAt);
    const accessToken = await signAccessToken({
      sub: principal.id,
      role: principal.role,
      av: principal.authVersion,
    });
    return { accessToken, expiresIn: config.auth.accessTtl, user: makeAuthUser(principal) };
  });

  r.post('/logout', async (req, reply) => {
    assertCookieOrigin(req);
    const raw = readRefreshCookie(req);
    if (raw) await revokeRefreshByToken(raw);
    clearRefreshCookie(reply);
    return { ok: true };
  });

  r.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    return makeAuthUser(requirePrincipal(req));
  });

  r.post(
    '/change-password',
    { preHandler: [app.authenticate], schema: { body: changePasswordSchema }, config: authRateLimit },
    async (req, reply) => {
      const principal = requirePrincipal(req);
      const { currentPassword, newPassword } = req.body;
      const [u] = await db.select().from(users).where(eq(users.id, principal.id));
      if (!u) throw err.unauthorized();
      const ok = await verifyPassword(u.passwordHash, currentPassword);
      if (!ok) throw err.badRequest('Текущий пароль неверен', { currentPassword: 'Неверный пароль' });

      const passwordHash = await hashPassword(newPassword);
      const newAuthVersion = u.authVersion + 1;
      await db
        .update(users)
        .set({ passwordHash, mustChangePassword: false, authVersion: newAuthVersion, updatedAt: new Date() })
        .where(eq(users.id, u.id));
      await revokeAllForUser(u.id);

      // выдаём свежие токены, чтобы пользователь остался в системе
      const accessToken = await signAccessToken({ sub: u.id, role: u.role, av: newAuthVersion });
      const refresh = await createRefreshSession(u.id, ctx(req));
      setRefreshCookie(reply, refresh.token, refresh.expiresAt);
      await writeAudit({
        actorUserId: u.id,
        action: 'auth.password_change',
        entityType: 'user',
        entityId: u.id,
      });
      return {
        accessToken,
        expiresIn: config.auth.accessTtl,
        user: makeAuthUser({ ...u, mustChangePassword: false }),
      };
    },
  );
}
