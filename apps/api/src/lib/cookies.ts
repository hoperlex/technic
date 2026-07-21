import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';

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

export function readRefreshCookie(req: FastifyRequest): string | null {
  const raw = req.cookies[REFRESH_COOKIE];
  if (!raw || typeof raw !== 'string') return null;
  return raw;
}
