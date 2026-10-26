import type { FastifyInstance } from 'fastify';
import type * as Sessions from '../src/auth/sessions';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Login and refresh while the database does not answer (incident of 26.10.2026).
 *
 * Both used to hang until nginx gave up. Now the pool's deadlines turn the wait into an error, and
 * the error must reach the browser as 503 with `Retry-After`, a refusal the page can repeat. The
 * main test is the refresh one: a failure on the way to the token's verdict must not drop the
 * cookie, or every page reload during a failover would log the person out.
 */

vi.hoisted(() => {
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
    INTERNAL_API_TOKEN: 'test-internal-token',
    LOG_LEVEL: 'fatal',
  });
});

/** What a query gets from the pool when no client frees up in time, wrapped as drizzle does. */
function poolDeadline(): Error {
  return new Error('Failed query: select ...', {
    cause: new Error('timeout exceeded when trying to connect'),
  });
}

vi.mock('../src/db/client', () => {
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, prop): unknown =>
        prop === 'then'
          ? (_resolve: unknown, reject: (e: Error) => void) => reject(poolDeadline())
          : () => chain,
    },
  );
  const db = new Proxy({}, { get: () => () => chain });
  return { db, pingDb: () => Promise.reject(poolDeadline()), pool: { end: async () => {} } };
});

const rotate = vi.hoisted(() => vi.fn());
vi.mock('../src/auth/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof Sessions>()),
  rotateRefreshSession: rotate,
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import('../src/app');
  app = await buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  rotate.mockReset();
});

/** The `Set-Cookie` that removes the refresh token, if the answer carries one. */
function refreshCookieCleared(headers: Record<string, unknown>): boolean {
  const raw = headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.some(
    (c) =>
      String(c).startsWith('refresh_token=;') ||
      /refresh_token=;.*Expires=Thu, 01 Jan 1970/.test(String(c)),
  );
}

const refresh = () =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    cookies: { refresh_token: 'opaque-token' },
  });

describe('database unavailable', () => {
  it('answers login with 503 and Retry-After instead of hanging or 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'person@example.com', password: 'secret-password' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json<{ code: string }>().code).toBe('db_unavailable');
  });

  it('answers refresh with 503 and keeps the refresh cookie', async () => {
    rotate.mockRejectedValue(poolDeadline());

    const res = await refresh();

    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('db_unavailable');
    expect(refreshCookieCleared(res.headers)).toBe(false);
  });

  it("still drops the cookie on the server's verdict that the token is dead", async () => {
    const { err } = await import('../src/lib/errors');
    rotate.mockRejectedValue(err.unauthorized('refresh-токен истёк'));

    const res = await refresh();

    expect(res.statusCode).toBe(401);
    expect(refreshCookieCleared(res.headers)).toBe(true);
  });

  it('keeps readiness a plain 503 for the healthcheck', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready' });
  });
});
