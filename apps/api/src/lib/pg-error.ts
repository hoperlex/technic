/**
 * PostgreSQL errors as they arrive through the driver and the ORM.
 *
 * The driver puts the code (`23503` reference, `23505` uniqueness), the source table and the
 * constraint name on the error, and a refusal is turned into a human 409 by them. But drizzle wraps
 * the original error in its own (`DrizzleQueryError`), and those fields are no longer on the outer
 * object: they sit in `cause`. A check `e.code === '23503'` on the wrapper silently misses, and
 * instead of "requests refer to this record" a person gets "internal server error".
 *
 * Hence a walk over the whole cause chain, not one level: wrappers may multiply, while the mark
 * of a database error is always the same.
 */

export interface PgErrorInfo {
  code?: string;
  /** Source table of the reference in a foreign key refusal. */
  table?: string;
  /** Name of the violated constraint; it tells unique indexes of one table apart. */
  constraint?: string;
}

/** Walk depth: a guard against a cycle in `cause`, not a limit in substance. */
const MAX_DEPTH = 5;

export function pgErrorOf(e: unknown): PgErrorInfo | undefined {
  let current: unknown = e;
  for (let depth = 0; depth < MAX_DEPTH && current; depth += 1) {
    const candidate = current as PgErrorInfo & { cause?: unknown };
    // A PostgreSQL code is a five-character SQLSTATE: that tells the wrapper from the error itself.
    if (typeof candidate.code === 'string' && candidate.code.length === 5) {
      return { code: candidate.code, table: candidate.table, constraint: candidate.constraint };
    }
    current = candidate.cause;
  }
  return undefined;
}

/** pg's wording when `query_timeout` expires; the error carries no code, only this message. */
export const QUERY_TIMEOUT_MESSAGE = 'Query read timeout';

/**
 * Client-side deadlines and closed clients in pg's and pg-pool's own wording. The errors carry no
 * code, so the message is the only mark, and these phrases come from nowhere else.
 */
const DRIVER_UNAVAILABLE_MESSAGES = new Set([
  QUERY_TIMEOUT_MESSAGE,
  // pg-pool: no client became free within `connectionTimeoutMillis`.
  'timeout exceeded when trying to connect',
  // pg-pool: a new connection did not open within `connectionTimeoutMillis`.
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  // pg: queries queued on a client that was ended, which is what a query deadline does.
  'Connection terminated',
  'Client was closed and is not queryable',
  'Client has encountered a connection error and is not queryable',
]);

/**
 * Socket and resolver failures, as Node puts them in `code`, plus pg's generic wording for its own
 * connect timer. They name no peer: the same `ECONNREFUSED` comes from S3, SMTP or the recognition
 * proxy. So they count only on an error the database pool marked (`markFromDatabase`); otherwise an
 * S3 outage would be reported as an unavailable database and send the operator to the wrong console.
 */
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);
const CONNECT_TIMER_MESSAGE = 'timeout expired';

/**
 * SQLSTATEs of a server that is going away or not taking sessions: shutdown (`57P01`, `57P02`),
 * startup or recovery (`57P03`), connection slots exhausted (`53300`). Class `08` is checked whole:
 * every code in it is a connection exception.
 */
const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);

const FROM_DATABASE = Symbol('technic.fromDatabase');

/** The database pool marks every error it hands out (`db/bounded-pool.ts`). */
export function markFromDatabase(e: unknown): void {
  if (typeof e !== 'object' || e === null || FROM_DATABASE in e || !Object.isExtensible(e)) return;
  Object.defineProperty(e, FROM_DATABASE, { value: true });
}

export function isQueryTimeout(e: unknown): boolean {
  return e instanceof Error && e.message === QUERY_TIMEOUT_MESSAGE;
}

/**
 * The database could not be reached or did not answer in time: the request may succeed if
 * repeated, so it is answered 503, not 500. A failover or a dropped connection produces exactly
 * these, and a 500 would read as a bug in the screen the person was using.
 *
 * Walks the cause chain for the same reason as `pgErrorOf`, but does not reuse it: that one stops at
 * the first five-character code, and `EPIPE` is five characters too.
 */
export function isDbUnavailable(e: unknown): boolean {
  let current: unknown = e;
  for (let depth = 0; depth < MAX_DEPTH && current; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    const { code, message } = candidate;
    if (typeof code === 'string') {
      if (UNAVAILABLE_SQLSTATES.has(code)) return true;
      if (code.length === 5 && code.startsWith('08')) return true;
    }
    if (typeof message === 'string' && DRIVER_UNAVAILABLE_MESSAGES.has(message)) return true;
    if (typeof current === 'object' && FROM_DATABASE in current) {
      if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
      if (message === CONNECT_TIMER_MESSAGE) return true;
    }
    current = candidate.cause;
  }
  return false;
}
