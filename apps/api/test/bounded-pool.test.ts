import { EventEmitter } from 'node:events';
import net from 'node:net';
import type pg from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BoundedPoolOptions, createBoundedPool, watchPoolStall } from '../src/db/bounded-pool';
import { isDbUnavailable, QUERY_TIMEOUT_MESSAGE } from '../src/lib/pg-error';

/**
 * The pool's deadlines against a server that goes silent (incident of 26.10.2026).
 *
 * A real PostgreSQL cannot play a half-open socket: it answers or it closes. The fake below speaks
 * just enough of the protocol to open a session and then answers queries only on the sessions it is
 * told to, which from the client's side is exactly a socket whose peer is gone. The main test is
 * the first one: a client whose query hit the deadline must not come back from a plain `release()`,
 * the path drizzle's transactions take.
 */

const AUTH_OK = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
const READY = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
const COMPLETE = (() => {
  const tag = Buffer.from('SELECT 0\0');
  const head = Buffer.alloc(5);
  head.write('C', 0);
  head.writeInt32BE(4 + tag.length, 1);
  return Buffer.concat([head, tag]);
})();

interface FakePostgres {
  url: string;
  /** Sessions in the order they opened. */
  sessions: net.Socket[];
  close: () => Promise<void>;
}

async function fakePostgres(behavior: {
  /** `false`: accept TCP and never finish the handshake. */
  handshake?: boolean;
  /** Whether the `query`-th query (from 1) of the `session`-th session (from 1) gets a reply. */
  answers: (session: number, query: number) => boolean;
}): Promise<FakePostgres> {
  const sessions: net.Socket[] = [];
  const server = net.createServer((socket) => {
    const session = sessions.push(socket);
    let buffer = Buffer.alloc(0);
    let started = false;
    let queries = 0;
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        // The startup message has no type byte; every later message has one.
        const offset = started ? 1 : 0;
        if (buffer.length < offset + 4) return;
        const end = offset + buffer.readInt32BE(offset);
        if (buffer.length < end) return;
        const type = started ? String.fromCharCode(buffer[0]!) : '';
        buffer = buffer.subarray(end);
        if (!started) {
          started = true;
          if (behavior.handshake !== false) socket.write(Buffer.concat([AUTH_OK, READY]));
        } else if (type === 'X') {
          socket.end();
          return;
        } else if (type === 'Q') {
          queries += 1;
          if (behavior.answers(session, queries)) socket.write(Buffer.concat([COMPLETE, READY]));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `postgres://test@127.0.0.1:${port}/test`,
    sessions,
    close: async () => {
      for (const socket of sessions) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const QUERY_TIMEOUT_MS = 500;

let server: FakePostgres | undefined;
let pool: pg.Pool | undefined;

function boundedPool(url: string, overrides: Partial<BoundedPoolOptions> = {}): pg.Pool {
  pool = createBoundedPool({
    connectionString: url,
    ssl: false,
    max: 2,
    connectTimeoutMs: 300,
    idleTimeoutMs: 10_000,
    queryTimeoutMs: QUERY_TIMEOUT_MS,
    onIdleError: () => {},
    ...overrides,
  });
  return pool;
}

afterEach(async () => {
  await pool?.end();
  await server?.close();
  pool = undefined;
  server = undefined;
});

describe('createBoundedPool', () => {
  it('drops a client whose query hit the deadline even when it is released without the error', async () => {
    server = await fakePostgres({ answers: (session) => session > 1 });
    const p = boundedPool(server.url);

    const client = await p.connect();
    const failure = await client.query('SELECT 1').catch((e: unknown) => e);
    expect((failure as Error).message).toBe(QUERY_TIMEOUT_MESSAGE);
    expect(isDbUnavailable(failure)).toBe(true);
    client.release();

    // Kept, the client would serve this query and queue it behind a reply that never comes.
    await expect(p.query('SELECT 1')).resolves.toBeDefined();
    expect(server.sessions).toHaveLength(2);
  });

  it('fails a drizzle transaction after one deadline: the ROLLBACK does not wait out a second', async () => {
    // BEGIN is answered, the query inside the transaction is not.
    server = await fakePostgres({ answers: (session, query) => session > 1 || query === 1 });
    const p = boundedPool(server.url);
    const db = drizzle(p);

    const started = Date.now();
    const failure = await db
      .transaction(async (tx) => {
        await tx.execute(sql`select 1`);
      })
      .catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(isDbUnavailable(failure)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(QUERY_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(1.8 * QUERY_TIMEOUT_MS);
    await expect(p.query('SELECT 1')).resolves.toBeDefined();
  });

  it('returns the slot of a drizzle transaction whose BEGIN never got a reply', async () => {
    // drizzle sends BEGIN outside its try and never releases the client when BEGIN fails.
    server = await fakePostgres({ answers: (session) => session > 1 });
    const p = boundedPool(server.url, { max: 1 });
    const db = drizzle(p);

    const failure = await db
      .transaction(async (tx) => {
        await tx.execute(sql`select 1`);
      })
      .catch((e: unknown) => e);

    expect(isDbUnavailable(failure)).toBe(true);
    // With the only slot kept by the dead client, this would wait for a free client and fail.
    await expect(p.query('SELECT 1')).resolves.toBeDefined();
  });

  it('gives up waiting for a free client after the connect deadline', async () => {
    server = await fakePostgres({ answers: () => true });
    const p = boundedPool(server.url, { max: 1 });

    const held = await p.connect();
    const failure = await p.connect().catch((e: unknown) => e);
    held.release();

    expect((failure as Error).message).toBe('timeout exceeded when trying to connect');
    expect(isDbUnavailable(failure)).toBe(true);
  });

  it('gives up on a connection whose handshake never completes', async () => {
    server = await fakePostgres({ handshake: false, answers: () => true });
    const p = boundedPool(server.url);

    const failure = await p.query('SELECT 1').catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(isDbUnavailable(failure)).toBe(true);
  });

  it("marks a refused connection as the database's, so it is told from a refused S3", async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as net.AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const p = boundedPool(`postgres://test@127.0.0.1:${port}/test`);

    const failure = await p.query('SELECT 1').catch((e: unknown) => e);

    expect((failure as { code?: string }).code).toBe('ECONNREFUSED');
    expect(isDbUnavailable(failure)).toBe(true);
  });

  it("marks an error that breaks a running query as the database's", async () => {
    server = await fakePostgres({ answers: () => false });
    const p = boundedPool(server.url, { queryTimeoutMs: 10_000 });

    const client = await p.connect();
    const pending = client.query('SELECT 1').catch((e: unknown) => e);
    // A reset socket under a running query; the client hands its error to the query.
    server.sessions[0]!.resetAndDestroy();
    const failure = await pending;
    client.release();

    expect(isDbUnavailable(failure)).toBe(true);
  });

  it('survives a connection dropped while its client is checked out', async () => {
    server = await fakePostgres({ answers: () => true });
    const p = boundedPool(server.url);

    const client = await p.connect();
    const ended = new Promise((resolve) => client.once('end', resolve));
    server.sessions[0]!.destroy();
    // Without the client's own listener the 'error' before 'end' is unhandled and fails the run.
    await ended;
    // The pool has already taken the client back; the holder's release must be harmless.
    client.release();

    expect(p.totalCount).toBe(0);
    await expect(p.query('SELECT 1')).resolves.toBeDefined();
  });

  it("reports an idle client's dropped connection instead of throwing it", async () => {
    server = await fakePostgres({ answers: () => true });
    const onIdleError = vi.fn();
    const p = boundedPool(server.url, { onIdleError });

    await p.query('SELECT 1');
    server.sessions[0]!.destroy();

    await vi.waitFor(() => expect(onIdleError).toHaveBeenCalledOnce());
    expect(p.totalCount).toBe(0);
  });
});

describe('watchPoolStall', () => {
  /** Only what the watch reads: the counters and the pool's turnover events. */
  function fakePool(): EventEmitter & { waitingCount: number; totalCount: number } {
    return Object.assign(new EventEmitter(), { waitingCount: 0, totalCount: 10 });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once when callers wait and the pool stays silent for the whole span', () => {
    vi.useFakeTimers();
    const fake = fakePool();
    const onStall = vi.fn();
    watchPoolStall(fake as unknown as pg.Pool, { stallMs: 30_000, onStall });

    fake.waitingCount = 3;
    vi.advanceTimersByTime(29_000);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(onStall).toHaveBeenCalledOnce();
    expect(onStall).toHaveBeenCalledWith(expect.objectContaining({ waiting: 3, total: 10 }));

    vi.advanceTimersByTime(60_000);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it('does not fire while clients keep turning over, however long the queue', () => {
    vi.useFakeTimers();
    const fake = fakePool();
    const onStall = vi.fn();
    watchPoolStall(fake as unknown as pg.Pool, { stallMs: 30_000, onStall });

    fake.waitingCount = 5;
    for (let second = 0; second < 120; second += 1) {
      vi.advanceTimersByTime(1_000);
      if (second % 10 === 0) fake.emit('release', undefined, {});
    }

    expect(onStall).not.toHaveBeenCalled();
  });

  it('does not fire on a silent pool that nobody waits for', () => {
    vi.useFakeTimers();
    const fake = fakePool();
    const onStall = vi.fn();
    watchPoolStall(fake as unknown as pg.Pool, { stallMs: 30_000, onStall });

    vi.advanceTimersByTime(3_600_000);

    expect(onStall).not.toHaveBeenCalled();
  });

  it('measures silence from the last turnover, not from the first waiter', () => {
    vi.useFakeTimers();
    const fake = fakePool();
    const onStall = vi.fn();
    watchPoolStall(fake as unknown as pg.Pool, { stallMs: 30_000, onStall });

    vi.advanceTimersByTime(60_000);
    // Every client has been held for a minute without a release when the first caller queues: a
    // caller queues only on a full pool, so this is the incident, not a quiet night.
    fake.waitingCount = 1;
    vi.advanceTimersByTime(1_000);

    expect(onStall).toHaveBeenCalledOnce();
  });
});
