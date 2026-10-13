import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

/**
 * Origin guard of the cookie endpoints (`/auth/refresh`, `/auth/logout`).
 *
 * The case worth a test is the quiet one: after a server move `PUBLIC_ORIGIN` kept a host nobody
 * opens (a nip.io name of the new IP), so every refresh answered 403 while login, which has no such
 * check, kept working. People saw "reload throws me to the login form from any screen" and nothing
 * in the logs pointed at the origin. The guard must therefore leave a trace with BOTH values.
 */

const cfg = { isProd: true, publicOrigin: 'https://auto.su10.ru' };
vi.mock('../src/config', () => ({ config: cfg }));

const { assertCookieOrigin } = await import('../src/lib/cookies');

function request(origin: string | undefined) {
  const warn = vi.fn();
  const req = { headers: origin === undefined ? {} : { origin }, log: { warn } };
  return { req: req as unknown as FastifyRequest, warn };
}

describe('assertCookieOrigin', () => {
  beforeEach(() => {
    cfg.isProd = true;
    cfg.publicOrigin = 'https://auto.su10.ru';
  });

  it('lets through the origin equal to PUBLIC_ORIGIN', () => {
    const { req, warn } = request('https://auto.su10.ru');
    expect(() => assertCookieOrigin(req)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a foreign origin and logs what it got and what it expected', () => {
    const { req, warn } = request('https://evil.example');
    expect(() => assertCookieOrigin(req)).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'forbidden' }),
    );
    expect(warn).toHaveBeenCalledWith(
      { origin: 'https://evil.example', expected: 'https://auto.su10.ru' },
      expect.any(String),
    );
  });

  it('rejects the portal address when PUBLIC_ORIGIN was left on another host after a move', () => {
    cfg.publicOrigin = 'https://auto.213-171-26-249.nip.io';
    const { req, warn } = request('https://auto.su10.ru');
    expect(() => assertCookieOrigin(req)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(warn).toHaveBeenCalledWith(
      { origin: 'https://auto.su10.ru', expected: 'https://auto.213-171-26-249.nip.io' },
      expect.any(String),
    );
  });

  it('rejects a request without Origin and logs it as null', () => {
    const { req, warn } = request(undefined);
    expect(() => assertCookieOrigin(req)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(warn).toHaveBeenCalledWith(
      { origin: null, expected: 'https://auto.su10.ru' },
      expect.any(String),
    );
  });

  it('does not run outside production', () => {
    cfg.isProd = false;
    const { req, warn } = request(undefined);
    expect(() => assertCookieOrigin(req)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
