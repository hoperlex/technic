import { EventEmitter } from 'node:events';
import net from 'node:net';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BoundedPoolOptions, createBoundedPool, watchPoolStall } from '../src/db-pool';

/**
 * The worker's copy of the bounded pool against a server that goes silent; the API's
 * `bounded-pool.test.ts` holds the full set. The fake speaks just enough of the protocol to open a
 * session and then answers queries only where told to, which from the client's side is a socket
 * whose peer is gone.
 */

const AUTH_OK = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
const READY = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
const COMPLETE = Buffer.concat([Buffer.from([0x43, 0, 0, 0, 13]), Buffer.from('SELECT 0\0')]);

interface FakePostgres {
  url: string;
  sessions: net.Socket[];
  close: () => Promise<void>;
}

async function fakePostgres(answers: (session: number) => boolean): Promise<FakePostgres> {
  const sessions: net.Socket[] = [];
  const server = net.createServer((socket) => {
    const session = sessions.push(socket);
    let buffer = Buffer.alloc(0);
    let started = false;
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
          socket.write(Buffer.concat([AUTH_OK, READY]));
        } else if (type === 'X') {
          socket.end();
          return;
        } else if (type === 'Q' && answers(session)) {
          socket.write(Buffer.concat([COMPLETE, READY]));
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

let server: FakePostgres | undefined;
let pool: pg.Pool | undefined;

function boundedPool(url: string, overrides: Partial<BoundedPoolOptions> = {}): pg.Pool {
  pool = createBoundedPool({
    connectionString: url,
    ssl: false,
    max: 2,
    connectTimeoutMs: 300,
    idleTimeoutMs: 10_000,
    queryTimeoutMs: 300,
    onIdleError: () => {},
    ...overrides,
  });
  return pool;
}

afterEach(async () => {
  vi.useRealTimers();
  await pool?.end();
  await server?.close();
  pool = undefined;
  server = undefined;
});

describe('worker createBoundedPool', () => {
  it('drops a client whose query hit the deadline even when it is released without the error', async () => {
    server = await fakePostgres((session) => session > 1);
    const p = boundedPool(server.url);

    const client = await p.connect();
    await expect(client.query('SELECT 1')).rejects.toThrow('Query read timeout');
    // The worker's `inTransaction` path: ROLLBACK, then a plain release.
    await expect(client.query('ROLLBACK')).rejects.toThrow();
    client.release();

    await expect(p.query('SELECT 1')).resolves.toBeDefined();
    expect(server.sessions).toHaveLength(2);
  });

  it('survives a connection dropped while its client is checked out', async () => {
    server = await fakePostgres(() => true);
    const p = boundedPool(server.url);

    const client = await p.connect();
    const ended = new Promise((resolve) => client.once('end', resolve));
    server.sessions[0]!.destroy();
    await ended;
    client.release();

    expect(p.totalCount).toBe(0);
  });

  it("reports an idle client's dropped connection instead of throwing it", async () => {
    server = await fakePostgres(() => true);
    const onIdleError = vi.fn();
    const p = boundedPool(server.url, { onIdleError });

    await p.query('SELECT 1');
    server.sessions[0]!.destroy();

    await vi.waitFor(() => expect(onIdleError).toHaveBeenCalledOnce());
  });
});

describe('worker watchPoolStall', () => {
  it('fires when callers wait and the pool stays silent, not while clients turn over', () => {
    vi.useFakeTimers();
    const fake = Object.assign(new EventEmitter(), { waitingCount: 1, totalCount: 4 });
    const onStall = vi.fn();
    watchPoolStall(fake as unknown as pg.Pool, { stallMs: 30_000, onStall });

    for (let second = 0; second < 60; second += 1) {
      vi.advanceTimersByTime(1_000);
      if (second % 10 === 0) fake.emit('release', undefined, {});
    }
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(31_000);
    expect(onStall).toHaveBeenCalledOnce();
  });
});
