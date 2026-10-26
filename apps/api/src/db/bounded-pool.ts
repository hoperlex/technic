import pg from 'pg';
import { isQueryTimeout, markFromDatabase } from '../lib/pg-error';

/**
 * A pool whose every wait has an end (incident of 26.10.2026).
 *
 * Without limits node-postgres waits forever: for a new connection, for a free client and for a
 * query's reply. After a short drop of the managed cluster the API's ten clients sat on half-open
 * sockets to the old master, every request (login and readiness included) queued behind them, and
 * the process stayed like that for twenty minutes while a fresh connection opened in 200 ms. The
 * limits turn that state into errors within seconds, and the client that hit one leaves the pool.
 *
 * The worker builds the same pool in `apps/worker/src/db-pool.ts`; the two apps share no server
 * package, so a change here is a change there.
 */
export interface BoundedPoolOptions {
  connectionString: string;
  ssl: pg.PoolConfig['ssl'];
  max: number;
  /** Both opening a connection and waiting for a free client give up after this. */
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  /**
   * Client-side deadline of one query. A server-side `statement_timeout` cannot replace it: on a
   * half-open socket the query never reached the server, and only a timer in this process ends the
   * wait.
   */
  queryTimeoutMs: number;
  /** An idle client's connection failed; the pool has already dropped that client. */
  onIdleError: (err: Error) => void;
}

/**
 * A client that leaves the pool once a query deadline has passed.
 *
 * pg rejects an expired `query_timeout` but keeps the query active on the connection: the client
 * still counts as queryable, a plain `release()` returns it to the pool, and the next borrower
 * queues behind a reply that a half-open socket will never deliver. drizzle's transactions and the
 * hand-held clients release without the error, so on those paths the pool refilled with dead
 * sockets. `end()` marks the client as ending, which pg-pool checks on every release and then drops
 * the client, and it closes the socket, so the ROLLBACK that follows fails at once instead of
 * waiting out a second deadline.
 *
 * Every error the client hands out is also marked as the database's: a bare `ECONNRESET` names no
 * peer, and only the mark lets the error handler answer "database unavailable" for it.
 */
class DeadlineClient extends pg.Client {
  constructor(config?: string | pg.ClientConfig) {
    super(config);
    /*
     * A connection that dies while the client is checked out emits 'error' on the client, and
     * pg-pool listens only while the client is idle: with no listener of our own that error is
     * unhandled and kills the process. Ignoring it here loses nothing: the same error reaches the
     * running query, the client turns unqueryable, and the pool drops it on release.
     */
    this.on('error', () => {});
    const onQueryError = (err: unknown): void => {
      markFromDatabase(err);
      if (isQueryTimeout(err)) void this.end();
    };
    const query = this.query.bind(this) as (...args: unknown[]) => unknown;
    this.query = ((...args: unknown[]) => {
      const last = args.length - 1;
      const callback = args[last];
      // pg-pool's own `pool.query` passes a callback; drizzle and the services use the promise.
      if (typeof callback === 'function') {
        args[last] = (err: unknown, res: unknown) => {
          if (err) onQueryError(err);
          (callback as (err: unknown, res: unknown) => void)(err, res);
        };
        return query(...args);
      }
      const result = query(...args);
      if (!(result instanceof Promise)) return result;
      return result.catch((err: unknown) => {
        onQueryError(err);
        throw err;
      });
    }) as pg.Client['query'];
    // pg-pool opens a client through the callback form; a refused or unresolved host fails here.
    const connect = this.connect.bind(this) as (...args: unknown[]) => unknown;
    this.connect = ((...args: unknown[]) => {
      const callback = args[0];
      if (typeof callback === 'function') {
        return connect((err: unknown, ...rest: unknown[]) => {
          if (err) markFromDatabase(err);
          (callback as (...a: unknown[]) => void)(err, ...rest);
        });
      }
      return (connect() as Promise<unknown>).catch((err: unknown) => {
        markFromDatabase(err);
        throw err;
      });
    }) as pg.Client['connect'];
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
  /*
   * pg-pool re-emits an idle client's connection error on the pool after dropping the client. An
   * 'error' event without a listener throws, so a failover that closed idle connections cleanly
   * used to take the whole process down with it.
   */
  pool.on('error', options.onIdleError);
  releaseClosedClients(pool);
  return pool;
}

/**
 * A checked-out client whose connection has closed goes back to the pool at once, and its holder's
 * own `release()` becomes a no-op.
 *
 * drizzle sends BEGIN before its `try` (drizzle-orm 0.45, `NodePgSession.transaction`), so a
 * transaction whose BEGIN fails never releases its client. Behind a dead socket that is the usual
 * way BEGIN fails, and every such transaction kept a slot for good: the client was ended, but the
 * pool still counted it as checked out. A closed client is useless to its holder anyway: every
 * further query on it fails at once.
 */
function releaseClosedClients(pool: pg.Pool): void {
  const checkedOut = new WeakSet<pg.PoolClient>();
  pool.on('acquire', (client) => checkedOut.add(client));
  pool.on('release', (_err, client) => checkedOut.delete(client));
  pool.on('connect', (client) => {
    client.once('end', () => {
      if (!checkedOut.has(client)) return;
      // pg-pool sets `release` anew on every checkout and throws on a second call, so the
      // holder's call must find a no-op here, not the pool's function.
      const release = client.release;
      client.release = () => {};
      release();
    });
  });
}

export interface PoolStall {
  waiting: number;
  total: number;
  silentMs: number;
}

/**
 * Calls `onStall` once when callers wait for a client and the pool has neither handed one out nor
 * taken one back for `stallMs`.
 *
 * Waiting alone is not a stall: under load the queue is seldom empty while clients turn over every
 * few milliseconds. Silence alone is not one either: an idle pool is silent for hours. Both together
 * are what 26.10.2026 looked like, and no amount of waiting repairs that. `stallMs` must exceed the
 * query deadline, which frees stuck clients by itself: the process must not be restarted while that
 * is still about to happen.
 */
export function watchPoolStall(
  pool: pg.Pool,
  options: {
    stallMs: number;
    onStall: (stall: PoolStall) => void;
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
  // The watch must not keep a process alive that is otherwise done, e.g. a script or a test.
  timer.unref();
  return stop;
}
