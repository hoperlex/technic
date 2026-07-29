import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { can, type Permission } from '@technic/contracts';
import { err } from '../lib/errors';
import { loadPrincipal, type Principal } from './principal';
import { verifyAccessToken } from './tokens';

/**
 * Страж маршрута с пометкой о том, чем именно он проверяет доступ. Пометка нужна не коду,
 * а тесту `test/route-authorization.test.ts`: по ней видно, что у маршрута есть осознанная
 * проверка прав, а не забытая. Забыть её — единственный способ выдать доступ всем ролям
 * сразу, и без пометки такой маршрут ничем не отличается от намеренно открытого.
 */
export type AuthzGuard = ((req: FastifyRequest) => Promise<void>) & { authz: string };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Проверка права по матрице ролей (ADR 0021) — до входа в обработчик. */
    requirePermission: (permission: Permission, message?: string) => AuthzGuard;
    /**
     * Маршрут, доступный любому вошедшему: право зависит от самой записи и проверяется в
     * обработчике (файл виден тому, кому видна его заявка). Причина указывается явно.
     */
    authorizeInHandler: (reason: string) => AuthzGuard;
  }
}

/** Достаёт принципала или бросает 401 (для использования в хендлерах). */
export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw err.unauthorized();
  return req.principal;
}

export default fp(
  async (app) => {
    app.decorateRequest('principal', null);

    app.decorate('authenticate', async (req: FastifyRequest) => {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) throw err.unauthorized();
      const token = header.slice('Bearer '.length).trim();
      let payload;
      try {
        payload = await verifyAccessToken(token);
      } catch {
        throw err.unauthorized('Недействительный токен');
      }
      const principal = await loadPrincipal(payload.sub);
      if (!principal) throw err.unauthorized('Сессия недействительна');
      if (principal.authVersion !== payload.av) {
        throw err.unauthorized('Токен устарел — войдите заново');
      }
      req.principal = principal;
    });

    app.decorate('requirePermission', (permission: Permission, message?: string): AuthzGuard => {
      const guard = async (req: FastifyRequest) => {
        const p = requirePrincipal(req);
        if (!can(p.role, permission)) throw err.forbidden(message);
      };
      guard.authz = permission;
      return guard;
    });

    app.decorate('authorizeInHandler', (reason: string): AuthzGuard => {
      const guard = async (req: FastifyRequest) => {
        requirePrincipal(req);
      };
      guard.authz = `handler:${reason}`;
      return guard;
    });
  },
  { name: 'auth' },
);
