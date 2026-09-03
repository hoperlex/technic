import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { can, type Permission } from '@technic/contracts';
import { config } from '../config';
import { err } from '../lib/errors';
import { loadPrincipal, type Principal } from './principal';
import { verifyAccessToken } from './tokens';

/**
 * Страж маршрута с пометкой о том, чем именно он проверяет доступ. Пометка нужна не коду,
 * а тесту `test/route-authorization.test.ts`: по ней видно, что у маршрута есть осознанная
 * проверка прав, а не забытая. Забыть её — единственный способ выдать доступ всем ролям
 * сразу, и без пометки такой маршрут ничем не отличается от намеренно открытого.
 *
 * Три написания пометки, по одному на каждый вид стража:
 *
 * - `<право>` — одно право (`requirePermission`); конъюнкция записывается несколькими стражами,
 *   и в пометках маршрута их видно по одному;
 * - `anyOf:<право>|<право>[|…]` — «хотя бы одно из перечисленных» (`requireAnyPermission`).
 *   Права перечислены **все**: пометкой «одно из прав» без имён сверка с манифестом стала бы
 *   неполной — маршрут, у которого страж молча оброс третьим правом, выглядел бы прежним;
 * - `handler:<причина>` — решает обработчик по самой записи (`authorizeInHandler`).
 *
 * Разбирают пометку тесты (`route-authorization`, `access-manifest`), и разбирают её по этим же
 * префиксам — своими литералами, а не импортом отсюда: ожидание, взятое из проверяемого кода,
 * сходилось бы с ним всегда.
 */
export type AuthzGuard = ((req: FastifyRequest) => Promise<void>) & { authz: string };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Проверка права по матрице (ADR 0021, 0038: роль + тип контрагента) — до обработчика. */
    requirePermission: (permission: Permission, message?: string) => AuthzGuard;
    /**
     * Маршрут, открытый субъекту с **любым одним** из перечисленных прав. Заведён под ходы
     * исполнителя заявки на обслуживание: они закрыты правом стороны (`serviceRequests.status`
     * либо `.estimate`), а поимённому исполнителю дугу открывает назначение вместе с
     * `serviceRequests.execute` — ни того, ни другого права у него нет и быть не должно.
     *
     * Страж отвечает только на вопрос «может ли этот субъект вообще работать с этой ручкой».
     * Какая дуга ему доступна на самой заявке, решает коридор контрактов — держатель
     * `serviceRequests.execute`, не назначенный на неё, получает отказ шагом позже.
     *
     * Не меньше двух прав: дизъюнкция из одного — это `requirePermission`, записанный так, что в
     * манифесте его не отличить от настоящего выбора.
     */
    requireAnyPermission: (
      permissions: readonly [Permission, Permission, ...Permission[]],
      message?: string,
    ) => AuthzGuard;
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
      /*
       * Эпоха токенов (план `docs/maintenance-mode-plan.md`, Р3 и §4.2). Сверка делает ту же
       * работу, что и `av` ниже, — отзывает выданное, — но действует ВСЕГДА, а не только в окне
       * технических работ: обнуление доступа полезно само по себе, и связывать его с состоянием
       * портала в коде незачем.
       *
       * Стоит она до чтения принципала, потому что ничего, кроме токена, ей не нужно: после снятия
       * окна сюда одновременно приходят все вкладки портала с мёртвыми токенами, и платить за
       * каждую запросом в базу ради ответа, который уже известен, не за что.
       *
       * **Граница — «меньше либо равно», и это не оформление.** `iat` измеряется целыми секундами:
       * при строгом `<` токен, выданный в ту же секунду, в которую поднята эпоха, остался бы живым
       * — а это ровно секунда, в которую оператор закрывает портал. Обратная сторона той же монеты
       * лежит на стороне команды: новый `api` не поднимается в секунду эпохи, иначе его первый же
       * токен отвергается здесь, и вкладка уходит в круг «401 → refresh → 401».
       *
       * **Токен, который нельзя датировать, отбивается вместе со старыми**: пропустить его значило
       * бы оставить в живых ровно те токены, ради которых эпоху и поднимали. Спрашивается это
       * только при поднятой эпохе: при умолчании `0` эпохи нет вовсе, сравнивать не с чем, и
       * заводить новый повод для 401 там, где обнуления никто не объявлял, нельзя — умолчание
       * обязано оставить поведение стража прежним до последней ветки.
       */
      if (config.auth.epochSince > 0) {
        if (typeof payload.iat !== 'number' || payload.iat <= config.auth.epochSince) {
          throw err.unauthorized('Доступ обновлён — войдите заново');
        }
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
        if (!can(p, permission)) throw err.forbidden(message);
      };
      guard.authz = permission;
      return guard;
    });

    app.decorate(
      'requireAnyPermission',
      (
        permissions: readonly [Permission, Permission, ...Permission[]],
        message?: string,
      ): AuthzGuard => {
        const guard = async (req: FastifyRequest) => {
          const p = requirePrincipal(req);
          if (!permissions.some((permission) => can(p, permission))) throw err.forbidden(message);
        };
        // Права перечислены в пометке все до одного: по ней сверяется манифест доступа.
        guard.authz = `anyOf:${permissions.join('|')}`;
        return guard;
      },
    );

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
