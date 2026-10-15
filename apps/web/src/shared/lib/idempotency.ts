/**
 * A retry must reuse one UUID across every send of the same operation. The caller owns its
 * lifetime: request drafts persist it across tabs, while other actions may keep it only for one
 * form opening. A second generator would diverge on the fallback path. randomUUID is unavailable
 * on some local-network origins, so random bytes keep retries possible there too.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes]
    // The server accepts UUID v4 variant 10x; an arbitrary byte string would fail validation.
    .map((b, i) => (i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
