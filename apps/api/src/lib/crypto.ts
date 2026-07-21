import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Криптостойкий opaque-токен (base64url). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Сравнение hex-строк одинаковой длины за постоянное время. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
