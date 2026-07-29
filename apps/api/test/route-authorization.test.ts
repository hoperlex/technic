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
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
]);

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
      .filter((r) => !PUBLIC_ROUTES.has(r.url) && !SELF_SERVICE_ROUTES.has(r.url))
      .filter((r) => r.authz.length === 0)
      .map((r) => r.key);
    expect(unguarded).toEqual([]);
  });

  it('непубличные маршруты требуют входа', () => {
    const anonymous = routes
      .filter((r) => !PUBLIC_ROUTES.has(r.url))
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
        route.authz.every((a) => a.startsWith('wasteRequests.') || a.startsWith('archive.')),
      ).toBe(true);
    }
  });
});
