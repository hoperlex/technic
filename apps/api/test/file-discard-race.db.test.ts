import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values are imported with `await import` after the environment is set — the
// config validates it on import and fails without it.
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as RequestFilesNs from '../src/services/request-files';

/**
 * `DELETE /files/:id` against a concurrent attachment or quarantine (snow-removal plan §3.3:
 * "Cleanup takes the same file row lock as attachment and rechecks the current links and
 * quarantine before deleting or scheduling storage deletion").
 *
 * The route reads the file, finds it free and discards it. In that gap a completion (or
 * `POST /:id/ticket-files`) may lock the row through `assertFilesAttachable`, link the file as a
 * ticket and commit — and an unconditional UPDATE after the read would delete the committed
 * ticket's file. The same gap fits a quarantine, which would be carried away with the object.
 *
 * Every case is deterministic, not lucky: the "other session" is a pool transaction that really
 * takes the row lock the way an attach path does and parks there; the barrier waits until the
 * discard is queued behind it (`pg_blocking_pids`); only then the session links or quarantines the
 * file and commits. Whatever the discard answers must be a refusal, and the file must be alive.
 *
 * Run on a fresh database like the other db tests:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:55961/technic_test \
 *     pnpm check:db file-discard-race
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const ADMIN_EMAIL = `db-file-discard-admin-${RUN}@example.invalid`;
const OUTSIDER_EMAIL = `db-file-discard-outsider-${RUN}@example.invalid`;
const PASSWORD = 'db-test-password-123';
const KEY_PREFIX = `db-file-discard-${RUN}/`;
const BLOCK_TIMEOUT_MS = 15_000;

type Auth = { authorization: string };
type Tx = Parameters<Parameters<typeof AppDb.transaction>[0]>[0];

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  files: typeof RequestFilesNs;
  closeDb: () => Promise<void>;
  adminId: string;
  auth: Auth;
  outsiderAuth: Auth;
  objectId: string;
  wasteTypeId: string;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

let requestNo = 0;
/** A fresh address per call: the login and the shared rate limiter count requests by address. */
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function discard(fileId: string, auth: Auth = ctx.auth): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method: 'DELETE',
    url: `/api/v1/files/${fileId}`,
    headers: auth,
    remoteAddress: nextAddress(),
  };
  return ctx.app.inject(options);
}

async function newFile(): Promise<{ id: string; objectKey: string }> {
  const objectKey = `${KEY_PREFIX}${randomUUID()}`;
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey,
      filename: 'Талон.pdf',
      contentType: 'application/pdf',
      size: 1024,
      status: 'active',
      storageVerifiedAt: new Date(),
      uploadedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.files.id });
  return { id: row!.id, objectKey };
}

async function newRequest(): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.wasteRequests)
    .values({
      objectId: ctx.objectId,
      requestType: 'waste_removal',
      wasteTypeId: ctx.wasteTypeId,
      volumeM3: 10,
      deliveryAt: new Date('2041-11-05T09:00:00Z'),
      status: 'new',
      createdBy: ctx.adminId,
      comment: 'ТЕСТОВЫЕ ДАННЫЕ: гонка удаления файла',
    })
    .returning({ id: ctx.schema.wasteRequests.id });
  return row!.id;
}

async function fileRow(
  fileId: string,
): Promise<{ status: string; deletedAt: Date | null; quarantinedAt: Date | null }> {
  const [row] = await ctx.db
    .select({
      status: ctx.schema.files.status,
      deletedAt: ctx.schema.files.deletedAt,
      quarantinedAt: ctx.schema.files.quarantinedAt,
    })
    .from(ctx.schema.files)
    .where(sql`${ctx.schema.files.id} = ${fileId}`);
  return row!;
}

async function deleteJobs(objectKey: string): Promise<{ runAt: Date }[]> {
  const res = await ctx.db.execute<{ next_run_at: string }>(sql`
    SELECT next_run_at FROM jobs
     WHERE type = 'delete_s3_object' AND payload->>'objectKey' = ${objectKey}`);
  return res.rows.map((r) => ({ runAt: new Date(r.next_run_at) }));
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until a session is queued behind the given backend. `pg_blocking_pids` instead of a bare
 * lock wait, so a neighbouring db test on the same server cannot release the barrier by accident.
 */
async function waitBlockedBy(pid: number): Promise<void> {
  const deadline = Date.now() + BLOCK_TIMEOUT_MS;
  for (;;) {
    const res = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity a
       WHERE a.datname = current_database() AND ${pid} = ANY(pg_blocking_pids(a.pid))`);
    if (Number(res.rows[0]!.n) >= 1) return;
    if (Date.now() > deadline) {
      throw new Error('the discard did not queue behind the file row lock of the other session');
    }
    await wait(25);
  }
}

/**
 * The other session: a pool transaction that locks the file row, parks until the discard has
 * queued behind it, then does `change` and commits. Returns the discard's answer.
 */
async function discardWhileHeld(
  fileId: string,
  hold: (tx: Tx) => Promise<void>,
  change: (tx: Tx) => Promise<void>,
): Promise<LightMyRequestResponse> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: (pid: number) => void;
  const heldPid = new Promise<number>((resolve) => (held = resolve));
  const session = ctx.db.transaction(async (tx) => {
    await hold(tx);
    const pid = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
    held(Number(pid.rows[0]!.pid));
    await released;
    await change(tx);
  });
  // A failure before the barrier must not leave the test waiting for a pid that never comes.
  session.catch(() => held(-1));
  const pid = await heldPid;
  if (pid < 0) await session;
  const answer = discard(fileId);
  try {
    await waitBlockedBy(pid);
  } finally {
    release();
  }
  await session;
  return answer;
}

describe.skipIf(!DB_URL)('удаление файла: гонка с подшивкой и карантином', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const files = await import('../src/services/request-files');
    const { hashPassword } = await import('../src/auth/password');

    const passwordHash = await hashPassword(PASSWORD);
    const user = async (email: string, role: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', 'Файл', ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const adminId = await user(ADMIN_EMAIL, 'admin');
    await user(OUTSIDER_EMAIL, 'shtab');

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `яя-file-discard-${RUN}`,
        name: `Площадка удаления файла ${RUN}`,
        address: 'г. Москва, тест удаления файла',
      })
      .returning({ id: schema.constructionObjects.id });
    const [wasteType] = await db
      .insert(schema.wasteTypes)
      .values({ code: `test_filediscard_${RUN}`, name: `ТЕСТ мусор удаления файла ${RUN}` })
      .returning({ id: schema.wasteTypes.id });

    const app = await buildApp();
    await app.ready();
    const login = async (email: string): Promise<Auth> => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    };
    ctx = {
      app,
      db,
      schema,
      files,
      closeDb,
      adminId,
      auth: await login(ADMIN_EMAIL),
      outsiderAuth: await login(OUTSIDER_EMAIL),
      objectId: object!.id,
      wasteTypeId: wasteType!.id,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const emails = sql`(${ADMIN_EMAIL}, ${OUTSIDER_EMAIL})`;
    await ctx.db.execute(sql`
      DELETE FROM waste_requests WHERE created_by IN (SELECT id FROM users WHERE email IN ${emails})`);
    await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
    await ctx.db.execute(
      sql`DELETE FROM jobs WHERE payload->>'objectKey' LIKE ${`${KEY_PREFIX}%`}`,
    );
    await ctx.db.execute(sql`DELETE FROM waste_types WHERE id = ${ctx.wasteTypeId}`);
    await ctx.db.execute(sql`DELETE FROM construction_objects WHERE id = ${ctx.objectId}`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email IN ${emails}`);
    await ctx.app.close();
    await ctx.closeDb();
  });

  describe('без гонки: прежние ответы', () => {
    it('свободный файл удаляется, а снос объекта ставится через тридцать суток', async () => {
      const file = await newFile();
      const res = await discard(file.id);
      expect(res.statusCode, res.body).toBe(200);
      const row = await fileRow(file.id);
      expect(row.status).toBe('deleted');
      expect(row.deletedAt).not.toBeNull();
      const jobs = await deleteJobs(file.objectKey);
      expect(jobs).toHaveLength(1);
      const days = (jobs[0]!.runAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
    });

    it('повторное удаление — 404 и вторую задачу не ставит', async () => {
      const file = await newFile();
      expect((await discard(file.id)).statusCode).toBe(200);
      const again = await discard(file.id);
      expect(again.statusCode, again.body).toBe(404);
      expect(await deleteJobs(file.objectKey)).toHaveLength(1);
    });

    it('прикреплённый файл — 409, файл и задачи целы', async () => {
      const file = await newFile();
      const requestId = await newRequest();
      await ctx.db
        .insert(ctx.schema.requestFiles)
        .values({ requestId, fileId: file.id, kind: 'ticket' });
      const res = await discard(file.id);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toContain('прикреплён');
      expect((await fileRow(file.id)).deletedAt).toBeNull();
      expect(await deleteJobs(file.objectKey)).toHaveLength(0);
    });

    it('карантинный файл — 409, файл и задачи целы', async () => {
      const file = await newFile();
      await ctx.db
        .update(ctx.schema.files)
        .set({ quarantinedAt: new Date() })
        .where(sql`${ctx.schema.files.id} = ${file.id}`);
      const res = await discard(file.id);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toContain('карантин');
      expect((await fileRow(file.id)).deletedAt).toBeNull();
      expect(await deleteJobs(file.objectKey)).toHaveLength(0);
    });

    it('чужой файл без права ведения — 403, несуществующий — 404', async () => {
      const file = await newFile();
      const foreign = await discard(file.id, ctx.outsiderAuth);
      expect(foreign.statusCode, foreign.body).toBe(403);
      expect((await fileRow(file.id)).deletedAt).toBeNull();
      expect((await discard(randomUUID())).statusCode).toBe(404);
    });
  });

  describe('гонка: между чтением удаления и записью другая сессия успевает закоммитить', () => {
    it('талон подшит под блокировкой строки — удаление отказывает, файл жив', async () => {
      const file = await newFile();
      const requestId = await newRequest();
      const res = await discardWhileHeld(
        file.id,
        // The real attach lock: the same call the completion and `POST /:id/ticket-files` make.
        (tx) => ctx.files.assertFilesAttachable(tx, [file.id], ctx.adminId),
        async (tx) => {
          await tx
            .insert(ctx.schema.requestFiles)
            .values({ requestId, fileId: file.id, kind: 'ticket' });
        },
      );
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toContain('прикреплён');
      const row = await fileRow(file.id);
      expect(row.deletedAt).toBeNull();
      expect(row.status).toBe('active');
      expect(await deleteJobs(file.objectKey)).toHaveLength(0);
    });

    it('карантин поставлен под блокировкой строки — удаление отказывает, предмет разбора цел', async () => {
      const file = await newFile();
      const res = await discardWhileHeld(
        file.id,
        async (tx) => {
          await tx.execute(sql`SELECT id FROM files WHERE id = ${file.id} FOR UPDATE`);
        },
        async (tx) => {
          await tx
            .update(ctx.schema.files)
            .set({ quarantinedAt: new Date() })
            .where(sql`${ctx.schema.files.id} = ${file.id}`);
        },
      );
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toContain('карантин');
      const row = await fileRow(file.id);
      expect(row.deletedAt).toBeNull();
      expect(row.quarantinedAt).not.toBeNull();
      expect(await deleteJobs(file.objectKey)).toHaveLength(0);
    });

    it('файл удалён другим удалением под блокировкой — второе отвечает 404 без второй задачи', async () => {
      const file = await newFile();
      const res = await discardWhileHeld(
        file.id,
        async (tx) => {
          await tx.execute(sql`SELECT id FROM files WHERE id = ${file.id} FOR UPDATE`);
        },
        async (tx) => {
          await tx.execute(
            sql`UPDATE files SET status = 'deleted', deleted_at = now() WHERE id = ${file.id}`,
          );
        },
      );
      expect(res.statusCode, res.body).toBe(404);
      expect(await deleteJobs(file.objectKey)).toHaveLength(0);
    });
  });
});
