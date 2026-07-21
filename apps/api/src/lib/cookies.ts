import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';

export const REFRESH_COOKIE = 'refresh_token';
const REFRESH_PATH = '/api/v1/auth';

export function setRefreshCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict',
    path: REFRESH_PATH,
    signed: true,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
}

export function readRefreshCookie(req: FastifyRequest): string | null {
  const raw = req.cookies[REFRESH_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}
