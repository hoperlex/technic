import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { Role } from '@technic/contracts';
import { err } from '../lib/errors';
import { loadPrincipal, type Principal } from './principal';
import { verifyAccessToken } from './tokens';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRoles: (
      ...roles: Role[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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

    app.decorate('requireRoles', (...roles: Role[]) => {
      return async (req: FastifyRequest) => {
        const p = requirePrincipal(req);
        if (!p.role || !roles.includes(p.role)) throw err.forbidden();
      };
    });
  },
  { name: 'auth' },
);
