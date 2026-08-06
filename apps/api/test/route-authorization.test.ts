import { beforeAll, describe, expect, it } from 'vitest';
import type { RouteOptions } from 'fastify';

/**
 * Страж авторизации: каждый маршрут API обязан объявить, чем он проверяет доступ.
 *
 * Полностью забытая проверка не ломает ни один тест и никак не проявляется в поведении — она
 * просто открывает маршрут всем ролям сразу. Маршруты здесь перечисляет само приложение,
 * поэтому маршрут без `requirePermission` (или без явного `authorizeInHandler` с причиной)
 * роняет тест, а не уезжает в прод (ADR 0021).
 *
 * Чего этот тест НЕ проверяет: что к маршруту привязано правильное право и что проверка внутри
 * обработчика действительно что-то запрещает. Это дело `access-matrix.test.ts` (запросы под
 * каждой ролью) и `file-access.test.ts` (правило доступа к файлу) — страж без них показывает
 * лишь то, что строчка проверки на месте.
 */

/**
 * Маршруты, которые обязаны работать без входа: проверки живости для nginx и сам вход.
 * Сравниваем по пути, а не по паре «метод + путь»: Fastify заводит HEAD к каждому GET сам.
 */
const PUBLIC_ROUTES = new Set([
  '/health/live',
  '/health/ready',
  '/metrics',
  '/api/v1/auth/register',
  '/api/v1/auth/captcha',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  // Ссылки из писем (ADR 0072): по ним ходит тот, кто ещё не вошёл, — и войти как раз не может.
  // Владение ящиком доказывает одноразовый токен, а запросы письма закрыты капчей и лимитами.
  '/api/v1/auth/verify-email',
  '/api/v1/auth/verify-email/resend',
  '/api/v1/auth/password-reset/request',
  '/api/v1/auth/password-reset/confirm',
]);

/**
 * Внутренние маршруты (ADR 0075): ими планировщик из worker просит API собрать рассылку. Прав у них
 * нет и быть не может — у планировщика нет человека, от чьего имени он действует; доступ закрыт
 * общим секретом `INTERNAL_API_TOKEN`, который обработчик проверяет первым делом, а наружу префикс
 * `/internal/` не проксируется (`deploy/nginx/spa.conf`).
 *
 * Перечислены поимённо намеренно: список из двух строк заметен в ревью, а «пропустить всё под
 * /internal/» однажды прикрыло бы забытую ручку без всякой проверки.
 */
const INTERNAL_ROUTES = new Set(['/internal/mail/schedules/due', '/internal/mail/runs']);

/** Маршруты «про себя»: доступны любому вошедшему независимо от роли. */
const SELF_SERVICE_ROUTES = new Set(['/api/v1/auth/me', '/api/v1/auth/change-password']);

interface RouteInfo {
  key: string;
  url: string;
  /** Пометки стражей: право из матрицы либо `handler:<причина>` (см. auth/plugin.ts). */
  authz: string[];
  requiresLogin: boolean;
}

const routes: RouteInfo[] = [];

function handlersOf(route: RouteOptions): Record<string, unknown>[] {
  const pre = route.preHandler;
  if (!pre) return [];
  return (Array.isArray(pre) ? pre : [pre]) as unknown as Record<string, unknown>[];
}

beforeAll(async () => {
  // Конфиг читается из окружения при импорте модуля, поэтому значения ставим до него.
  // Сборка приложения не ходит ни в БД, ни в S3 — маршруты регистрируются оффлайн.
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'https://portal.test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/technic_test',
    JWT_PUBLIC_KEY_PEM: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
    COOKIE_SECRET: 'test-cookie-secret-value',
    CSRF_SECRET: 'test-csrf-secret-value',
    S3_ENDPOINT: 'https://s3.test.local',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
  });
  const { buildApp } = await import('../src/app');
  const app = await buildApp({
    onRoute: (route) => {
      const handlers = handlersOf(route);
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        routes.push({
          key: `${method} ${route.url}`,
          url: route.url,
          authz: handlers.flatMap((h) => (h.authz ? [String(h.authz)] : [])),
          // Вход проверяет `authenticate` — единственный страж без пометки authz.
          requiresLogin: handlers.some((h) => !h.authz),
        });
      }
    },
  });
  await app.close();
});

describe('авторизация маршрутов', () => {
  it('маршруты собраны из приложения, а не перечислены в тесте', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it('каждый маршрут либо публичный, либо проверяет право', () => {
    const unguarded = routes
      .filter(
        (r) =>
          !PUBLIC_ROUTES.has(r.url) &&
          !SELF_SERVICE_ROUTES.has(r.url) &&
          !INTERNAL_ROUTES.has(r.url),
      )
      .filter((r) => r.authz.length === 0)
      .map((r) => r.key);
    expect(unguarded).toEqual([]);
  });

  it('непубличные маршруты требуют входа', () => {
    const anonymous = routes
      .filter((r) => !PUBLIC_ROUTES.has(r.url) && !INTERNAL_ROUTES.has(r.url))
      .filter((r) => !r.requiresLogin)
      .map((r) => r.key);
    expect(anonymous).toEqual([]);
  });

  it('доступ «по самой записи, а не по роли» оставлен только файлам', () => {
    const inHandler = routes
      .filter((r) => r.authz.some((a) => a.startsWith('handler:')))
      .map((r) => r.url);
    expect(inHandler.length).toBeGreaterThan(0);
    for (const url of inHandler) expect(url.startsWith('/api/v1/files')).toBe(true);
  });

  it('модуль «Вывоз мусора» закрыт правами, а не запретами для отдельных ролей', () => {
    const waste = routes.filter((r) => r.url.startsWith('/api/v1/waste-requests'));
    expect(waste.length).toBeGreaterThan(0);
    for (const route of waste) {
      expect(
        route.authz.every(
          (a) =>
            a.startsWith('wasteRequests.') ||
            a.startsWith('archive.') ||
            // Удаление насовсем — общее действие над архивом, а не право модуля (ADR 0070):
            // заявки сносит тот же `records.purge`, что и записи справочников.
            a === 'records.purge',
        ),
      ).toBe(true);
    }
  });

  /**
   * Удаление насовсем (ADR 0060) — единственное действие над справочником, которое не отменить.
   * Ведут справочники менеджер и диспетчер (`directories.write`), а сносить записи может только
   * администратор, и разница между двумя правами здесь — вся защита. Маршруты собраны из
   * приложения, поэтому очередной справочник, закрытый не тем правом, роняет тест.
   */
  it('окончательное удаление закрыто правом `records.purge`', () => {
    const purge = routes.filter((r) => r.url.endsWith('/purge'));
    expect(purge.length).toBeGreaterThan(0);
    for (const route of purge) expect(route.authz).toContain('records.purge');
  });
});
