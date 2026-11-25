import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import type { InjectOptions, LightMyRequestResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SNOW_WASTE_TYPE_ID,
  WASTE_REQUEST_CAPABILITY_HEADER,
  WASTE_REQUEST_CAPABILITY_SNOW,
  type RequestStatus,
  type RequestType,
  type WasteRequestTicketsDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values are imported after the environment is set, because the config validates
// it at import time and `config.ticketOcr.enabled` must be decided before the first import.
import type { db as AppDb } from '../src/db/client';
import type { config as AppConfig } from '../src/config';
import type { buildApp } from '../src/app';

/**
 * Ticket review of snow and garbage on the live schema (snow-removal plan, §3.2 and §4 «Close and
 * review»).
 *
 * WHY A DATABASE. Every claim here is about how three readers agree: the list badge (stored state),
 * the "Требуют разбора" register (SQL over that state and the recognition queue) and the terminal
 * check (fresh checks under the request lock). Mocks would agree with whatever they were told; the
 * failure this file guards against is exactly one reader answering "settled" while another one
 * still sees paper in flight.
 *
 * The worker is not run here: its transactions are reproduced by direct writes (T0 file row with
 * the job number, T2 outcome, a dead or skipped job), which is what the review reads. The worker's
 * own type independence is covered in `apps/worker/test/ticket-ocr-job.db.test.ts`.
 *
 * Requests are inserted directly — snow creation is another area's subject; only the transitions
 * under test go through HTTP, with the snow capability header a snow-aware portal sends.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:55961/technic_test \
 *     pnpm check:db waste-ticket-snow-review
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const ADMIN_EMAIL = `db-snow-review-${RUN}@example.invalid`;
const ADMIN_PASSWORD = 'db-snow-review-password-123';
const KEY_PREFIX = `db-snow-review-${RUN}/`;
const REQUESTS = '/api/v1/waste-requests';
const JOB_TYPE = 'recognize_waste_ticket_file';

const RECOMPUTE_SCRIPT = resolve(
  fileURLToPath(new URL('../scripts/recompute-ticket-review.ts', import.meta.url)),
);
const TSX = resolve(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)));
const API_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  config: typeof AppConfig;
  closeDb: () => Promise<void>;
  auth: Record<string, string>;
  adminId: string;
  objectId: string;
}

let ctx: Ctx;
let requestNo = 0;

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
  process.env.MAIL_ENABLED ??= 'false';
  // Recognition is on, the transport is the stub: enqueueing is part of what is tested, and the
  // "OCR was off" cases switch the flag at run time instead of building a second app.
  process.env.TICKET_OCR_ENABLED = 'true';
  process.env.AI_PROVIDER_MODE = 'stub';
}

/** A fresh source address per call: the global limiter counts requests per address. */
function nextAddress(): string {
  requestNo += 1;
  return `10.77.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method,
    url,
    // A snow-aware portal sends the capability on every waste request call (plan §3.5).
    headers: { ...ctx.auth, [WASTE_REQUEST_CAPABILITY_HEADER]: WASTE_REQUEST_CAPABILITY_SNOW },
    remoteAddress: nextAddress(),
  };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return ctx.app.inject(options);
}

async function setOcrEnabled(enabled: boolean): Promise<void> {
  (ctx.config.ticketOcr as { enabled: boolean }).enabled = enabled;
}

/**
 * A request in the given status. Snow carries the reserved service type, an ordered volume of at
 * least 8 m³ and nothing priced — the shape `waste_requests_snow_subject_check` demands.
 */
async function newRequest(
  requestType: RequestType,
  opts: { status?: RequestStatus; factVolumeM3?: number } = {},
): Promise<string> {
  const status = opts.status ?? 'done';
  const snow = requestType === 'snow_removal';
  const volume = requestType === 'metal_removal' || requestType.startsWith('container') ? null : 20;
  const row = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO waste_requests (object_id, request_type, delivery_at, status, created_by, comment,
                                volume_m3, waste_type_id)
    VALUES (${ctx.objectId}, ${sql.raw(`'${requestType}'::request_type`)},
            '2026-11-20T09:00:00+03:00', ${sql.raw(`'${status}'::request_status`)},
            ${ctx.adminId}, ${KEY_PREFIX}, ${volume}, ${snow ? SNOW_WASTE_TYPE_ID : null})
    RETURNING id`);
  const id = row.rows[0]!.id;
  if (opts.factVolumeM3 !== undefined) {
    await ctx.db.execute(sql`
      INSERT INTO waste_request_completions (request_id, volume_m3, removed_on, removed_on_source,
                                             completed_by)
      VALUES (${id}, ${String(opts.factVolumeM3)}, '2026-11-20', 'entered', ${ctx.adminId})`);
  }
  return id;
}

/** A ticket scan linked to the request: storage-verified and active, as a finished upload is. */
async function attachTicketFile(requestId: string, filename = 'талон.pdf'): Promise<string> {
  const file = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by,
                       storage_verified_at)
    VALUES ('test', ${`${KEY_PREFIX}${randomUUID()}`}, ${filename}, 'application/pdf', 1024,
            'active', ${ctx.adminId}, now())
    RETURNING id`);
  const fileId = file.rows[0]!.id;
  await ctx.db.execute(sql`
    INSERT INTO request_files (request_id, file_id, kind) VALUES (${requestId}, ${fileId}, 'ticket')`);
  return fileId;
}

/** A queue row as `enqueueTicketRecognition` writes it. */
async function seedJob(
  requestId: string,
  fileId: string,
  status: 'pending' | 'running' | 'done' | 'dead' = 'pending',
  opts: { forced?: boolean } = {},
): Promise<string> {
  const payload = opts.forced ? { requestId, fileId, forced: true } : { requestId, fileId };
  const row = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO jobs (type, payload, status)
    VALUES (${JOB_TYPE}, ${JSON.stringify(payload)}::jsonb, ${sql.raw(`'${status}'::job_status`)})
    RETURNING id`);
  return row.rows[0]!.id;
}

/** A recognition file row as the worker leaves it: T0 (`pending` + job) or an outcome. */
async function seedFileRow(
  requestId: string,
  fileId: string,
  status: 'pending' | 'done' | 'failed' | 'unsupported',
  activeJobId: string | null = null,
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO waste_ticket_files (file_id, request_id, status, active_job_id, total_pages,
                                    processed_pages)
    VALUES (${fileId}, ${requestId}, ${status},
            ${activeJobId}, 1, ${status === 'done' ? 1 : 0})
    ON CONFLICT (file_id) DO UPDATE
       SET status = EXCLUDED.status, active_job_id = EXCLUDED.active_job_id,
           updated_at = now()`);
}

function pageSha(): string {
  return randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
}

/** A recognized page of the file with one ticket in the given state. */
async function seedReadTicket(
  requestId: string,
  fileId: string,
  opts: { status?: 'unconfirmed' | 'confirmed'; volumeM3?: number; pageStatus?: string } = {},
): Promise<string> {
  const status = opts.status ?? 'confirmed';
  const page = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO waste_ticket_pages (file_id, request_id, page_no, page_sha256, status, tickets_found)
    VALUES (${fileId}, ${requestId}, 1, ${pageSha()},
            ${opts.pageStatus ?? 'done'}, 1)
    RETURNING id`);
  const number = String(Math.floor(Math.random() * 1e8));
  const ticket = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO waste_tickets (request_id, page_id, seq, number_raw, number_key, number_fuzzy,
                               issued_on, volume_m3, work_kind, origin, status, confirmed_by,
                               confirmed_at)
    VALUES (${requestId}, ${page.rows[0]!.id}, 1, ${number}, ${number}, ${number}, '2026-11-20',
            ${String(opts.volumeM3 ?? 20)}, 'removal', 'ocr',
            ${status},
            ${status === 'confirmed' ? ctx.adminId : null},
            ${status === 'confirmed' ? sql`now()` : null})
    RETURNING id`);
  return ticket.rows[0]!.id;
}

async function versionOf(requestId: string): Promise<number> {
  const res = await ctx.db.execute<{ version: number }>(
    sql`SELECT version FROM waste_requests WHERE id = ${requestId}`,
  );
  return res.rows[0]!.version;
}

/** «Выполнена» → «Завершена»: the terminal review transition. */
async function complete(requestId: string): Promise<LightMyRequestResponse> {
  return inject('PATCH', `${REQUESTS}/${requestId}/status`, {
    status: 'completed',
    version: await versionOf(requestId),
  });
}

/** Ids of this run's requests in the "Требуют разбора" register. */
async function registry(): Promise<string[]> {
  const res = await inject(
    'GET',
    `${REQUESTS}?ticketReview=pending&objectId=${ctx.objectId}&pageSize=100`,
  );
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: { id: string }[] }).items.map((item) => item.id);
}

async function storedState(requestId: string) {
  const res = await ctx.db.execute<{
    unreviewed_paper: number;
    failures: number;
    pending_confirmation: number;
    stale: boolean;
  }>(sql`
    SELECT unreviewed_paper, failures, pending_confirmation, stale
      FROM waste_ticket_review_state WHERE request_id = ${requestId}`);
  return res.rows[0] ?? null;
}

async function cardOf(requestId: string): Promise<WasteRequestTicketsDto> {
  const res = await inject('GET', `${REQUESTS}/${requestId}/tickets`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as WasteRequestTicketsDto;
}

async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`
    DELETE FROM jobs
     WHERE type = ${JOB_TYPE}
       AND payload->>'requestId' IN (
             SELECT id::text FROM waste_requests WHERE comment = ${KEY_PREFIX})`);
  await db.execute(sql`DELETE FROM waste_requests WHERE comment = ${KEY_PREFIX}`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${KEY_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code = ${`SNOW-REVIEW-${RUN}`}`);
  await db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
}

describe.skipIf(!DB_URL)('ticket review of snow and garbage (live schema)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    try {
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    const { db, closeDb } = await import('../src/db/client');
    const { config } = await import('../src/config');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const admin = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active,
                         email_verified_at)
      VALUES (${ADMIN_EMAIL}, 'Тестовый', 'Разбор', 'Снега', ${await hashPassword(ADMIN_PASSWORD)},
              'admin', true, now())
      RETURNING id`);
    const object = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`SNOW-REVIEW-${RUN}`}, ${`Площадка снега ${RUN}`}, 'г Москва, ул Снежная, д 1')
      RETURNING id`);

    const app = await buildApp();
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = {
      app,
      db,
      config,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken as string}` },
      adminId: admin.rows[0]!.id,
      objectId: object.rows[0]!.id,
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  describe('unreviewed paper counts for garbage and snow (countsUnreviewedTicketPaper)', () => {
    it('a snow ticket attached while OCR was off is in the register and blocks completion', async () => {
      await setOcrEnabled(false);
      try {
        const id = await newRequest('snow_removal', { factVolumeM3: 20 });
        await attachTicketFile(id);

        expect(await registry()).toContain(id);
        const res = await complete(id);
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().message).toContain('приложенных талонов не разобрано: 1');
      } finally {
        await setOcrEnabled(true);
      }
    });

    it('an old scrap request with a ticket file keeps the ADR 0150 boundary', async () => {
      const id = await newRequest('metal_removal');
      await attachTicketFile(id);

      expect(await registry()).not.toContain(id);
      const res = await complete(id);
      expect(res.statusCode, res.body).toBe(200);
    });

    it('the recompute script warms the state of a snow request with attached paper', async () => {
      const id = await newRequest('snow_removal', { factVolumeM3: 20 });
      await attachTicketFile(id);
      expect(await storedState(id)).toBeNull();

      const out = spawnSync(TSX, [RECOMPUTE_SCRIPT], {
        cwd: API_DIR,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: DB_URL },
        timeout: 170_000,
      });
      expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0);
      expect(await storedState(id)).toMatchObject({ unreviewed_paper: 1, stale: false });
    }, 180_000);
  });
});
