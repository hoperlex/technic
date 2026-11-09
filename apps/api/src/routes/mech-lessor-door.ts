import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isCounterpartyScopedRole, MECH_LESSOR_DOOR_MESSAGE } from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import { err } from '../lib/errors';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * A mechanization door open to a mechanization lessor (lessor receipt plan, P11). The module
     * refuses counterparty-scoped principals by default; only a route marked here lets the lessor
     * through — a route added tomorrow stays closed to him unless someone marks it. Read by the
     * module's lessor door guard (`installMechLessorDoorGuard`).
     */
    mechLessorDoor?: boolean;
  }
}

/**
 * The marker of the guard, read by `test/route-authorization.test.ts` from each route's
 * `preValidation`: the test proves that every mechanization route carries the guard, so a route
 * registered on another instance — where the hook does not reach — fails the run instead of
 * opening to the lessor. Its own prefix, not a permission's spelling: the guard asks no
 * permission, and the manifest tests read permission markers from `preHandler` only.
 */
export const MECH_LESSOR_DOOR_GUARD_MARK = 'scope:mech-lessor-door';

/**
 * **The first line of the lessor's scope** (lessor receipt plan, P11): every route of the
 * mechanization instance refuses a counterparty-scoped principal with 403 unless its config marks
 * it a lessor door. The second line — the lessor axis in `mechScopeWhere` / `assertMechScope` —
 * stands behind it, so no door relies on the lessor lacking a permission.
 *
 * Why `preValidation`, and why the guard authenticates itself:
 *
 * - `app.authenticate` is a route-level `preHandler` in this module, and Fastify runs plugin-level
 *   hooks of a stage before the route's own. A `preHandler` guard would see `req.principal` still
 *   empty and refuse nobody;
 * - params and body are validated before `preHandler`: a guard there would answer an empty body
 *   with 400, and a probe of the module with garbage would learn which routes exist and what they
 *   take. In `preValidation` the lessor gets the same 403 whatever he sends.
 *
 * `authenticate` is idempotent (a no-op once a principal is set), so the session loads once per
 * request; an unauthenticated call still answers 401 here.
 *
 * Installed through `onRoute`, before the module's first route: the guard becomes each route's own
 * `preValidation`, so it covers the extension and receipt doors registered on the same instance and
 * is visible in the route's options, where the route authorization test finds it by its mark.
 * Every executor type is refused, not only the mechanization lessor: another type holds no
 * permission of this module today, and the guard must not rely on that.
 */
export function installMechLessorDoorGuard(app: FastifyInstance): void {
  const guard = Object.assign(
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!req.principal) await app.authenticate(req, reply);
      const p = requirePrincipal(req);
      if (isCounterpartyScopedRole(p.role) && req.routeOptions.config.mechLessorDoor !== true) {
        throw err.forbidden(MECH_LESSOR_DOOR_MESSAGE);
      }
    },
    { authz: MECH_LESSOR_DOOR_GUARD_MARK },
  );
  app.addHook('onRoute', (route) => {
    const own = route.preValidation;
    // First of the route's own hooks: nothing of the route may run for the lessor before it.
    route.preValidation = [guard, ...(own === undefined ? [] : Array.isArray(own) ? own : [own])];
  });
}
