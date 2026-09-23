import { createHash, randomBytes } from 'node:crypto';

/** Криптостойкий opaque-токен (base64url). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
