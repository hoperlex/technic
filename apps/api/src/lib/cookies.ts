import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { err } from './errors';

export const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/api/v1/auth';

export function setRefreshCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  // Токен уже opaque (base64url 32 байт) — отдельная HMAC-подпись cookie не нужна.
  // signed:true ломал refresh: signature base64 с «+»/«/» портилась в Cookie-заголовке → unsign invalid → 401.
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: REFRESH_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, {
    path: REFRESH_PATH,
    secure: config.isProd,
    sameSite: 'lax',
  });
}

/**
 * CSRF guard for the cookie endpoints (`/auth/refresh`, `/auth/logout`): in production the browser's
 * `Origin` must be exactly `PUBLIC_ORIGIN`.
 *
 * The comparison is strict, so `PUBLIC_ORIGIN` drifting from the address people actually open
 * (a server move that left the old or a nip.io host in `prod.env`) rejects EVERY refresh. Nothing
 * else notices: login does not run this check and keeps working, the access token lives in tab
 * memory only, and a reload then reads the 403 as "session ended" and lands on the login form from
 * any screen. The warning below names both values on purpose — it is the only trace that tells this
 * apart from a cookie that did not arrive. The value is public, so logging it leaks nothing.
 */
export function assertCookieOrigin(req: FastifyRequest): void {
  if (!config.isProd) return;
  const origin = req.headers.origin;
  if (origin && origin === config.publicOrigin) return;
  req.log.warn(
    { origin: origin ?? null, expected: config.publicOrigin },
    'Cookie-эндпоинт отбит: Origin запроса не равен PUBLIC_ORIGIN',
  );
  throw err.forbidden('Недопустимый источник запроса');
}

export function readRefreshCookie(req: FastifyRequest): string | null {
  const raw = req.cookies[REFRESH_COOKIE];
  if (!raw || typeof raw !== 'string') return null;
  return raw;
}
