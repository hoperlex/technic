import pg from 'pg';

/**
 * The worker's copy of the API's bounded pool (`apps/api/src/db/bounded-pool.ts`, which explains
 * the incident of 26.10.2026 in full). The apps share no server package, so the two files change
 * together.
 *
 * The worker runs its jobs one at a time, so a query stuck on a half-open socket stopped the whole
 * queue: mail, recognition and cleanup alike. With the limits the stuck query becomes an error, the
 * loop logs it and goes on with a fresh connection.
 */
export interface BoundedPoolOptions {
  connectionString: string;
  ssl: pg.PoolConfig['ssl'];
  max: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  queryTimeoutMs: number;
  onIdleError: (err: Error) => void;
}

/** pg's wording when `query_timeout` expires; the error carries no code, only this message. */
const QUERY_TIMEOUT_MESSAGE = 'Query read timeout';

function isQueryTimeout(e: unknown): boolean {
  return e instanceof Error && e.message === QUERY_TIMEOUT_MESSAGE;
}

/**
 * pg keeps a timed-out query active on the connection, and a plain `release()` (the worker's
 * `inTransaction` and cleanup) returns such a client to the pool. `end()` makes pg-pool drop it.
 */
class DeadlineClient extends pg.Client {
  constructor(config?: string | pg.ClientConfig) {
    super(config);
    // A checked-out client's connection error has no pool listener and would kill the process; the
    // running query receives the same error, and the pool drops the client on release.
    this.on('error', () => {});
    const query = this.query.bind(this) as (...args: unknown[]) => unknown;
    this.query = ((...args: unknown[]) => {
      const last = args.length - 1;
      const callback = args[last];
      if (typeof callback === 'function') {
        args[last] = (err: unknown, res: unknown) => {
          if (isQueryTimeout(err)) void this.end();
          (callback as (err: unknown, res: unknown) => void)(err, res);
        };
        return query(...args);
      }
      const result = query(...args);
      if (!(result instanceof Promise)) return result;
      return result.catch((err: unknown) => {
        if (isQueryTimeout(err)) void this.end();
        throw err;
      });
    }) as pg.Client['query'];
  }
}

export function createBoundedPool(options: BoundedPoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    ssl: options.ssl,
    max: options.max,
    connectionTimeoutMillis: options.connectTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs,
    query_timeout: options.queryTimeoutMs,
    Client: DeadlineClient,
  });
  // pg-pool re-emits an idle client's error on the pool; without a listener that throws.
  pool.on('error', options.onIdleError);
  releaseClosedClients(pool);
  return pool;
}

/**
 * A checked-out client whose connection has closed goes back to the pool at once; the holder's own
 * `release()` becomes a no-op. The worker's code releases in `finally`, but a holder that does not
 * would keep the slot for good, and the API's copy explains the drizzle path where that happened.
 */
function releaseClosedClients(pool: pg.Pool): void {
  const checkedOut = new WeakSet<pg.PoolClient>();
  pool.on('acquire', (client) => checkedOut.add(client));
  pool.on('release', (_err, client) => checkedOut.delete(client));
  pool.on('connect', (client) => {
    client.once('end', () => {
      if (!checkedOut.has(client)) return;
      // pg-pool throws on a second release, so the holder's call must find a no-op.
      const release = client.release;
      client.release = () => {};
      release();
    });
  });
}

/**
 * Calls `onStall` once when callers wait for a client and the pool has neither handed one out nor
 * taken one back for `stallMs`; see the API's `watchPoolStall` for why both conditions are needed.
 */
export function watchPoolStall(
  pool: pg.Pool,
  options: {
    stallMs: number;
    onStall: (stall: { waiting: number; total: number; silentMs: number }) => void;
    checkEveryMs?: number;
    now?: () => number;
  },
): () => void {
  const now = options.now ?? Date.now;
  let lastTurnover = now();
  const turnover = (): void => {
    lastTurnover = now();
  };
  pool.on('acquire', turnover);
  pool.on('release', turnover);
  pool.on('remove', turnover);

  const stop = (): void => {
    clearInterval(timer);
    pool.off('acquire', turnover);
    pool.off('release', turnover);
    pool.off('remove', turnover);
  };
  const timer = setInterval(() => {
    if (pool.waitingCount === 0) return;
    const silentMs = now() - lastTurnover;
    if (silentMs < options.stallMs) return;
    stop();
    options.onStall({ waiting: pool.waitingCount, total: pool.totalCount, silentMs });
  }, options.checkEveryMs ?? 1000);
  timer.unref();
  return stop;
}
