import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReceiptRecognitionResponse } from '@technic/contracts';
import {
  PROXY_CHOOSES_MODEL,
  type RecognitionEngine,
  type RecognitionFailure,
} from '../src/ocr-engine';
import { runReceiptRecognitionJob, type ReceiptJobDeps } from '../src/receipt-ocr/job';
import { PROMPT_VERSION } from '../src/receipt-ocr/prompt';
import { retryableFile } from '../src/ticket-ocr/errors';
import { PREPROCESSING_VERSION } from '../src/ticket-ocr/preprocess';

// A mocked SQL client cannot catch a quoted cache key being parsed as a column identifier.
// These tests run the complete worker job against a fresh, migrated TEST_DATABASE_URL.
const DB_URL = process.env.TEST_DATABASE_URL;
const APPLICATION_NAME = `receipt-job-db-${randomUUID()}`;
const MODEL = 'test/receipt-job-db';
const RESPONSE: ReceiptRecognitionResponse = {
  documentNumber: 'TEST-001',
  purchasedOn: '2026-10-01',
  purchasedOnRaw: '01.10.2026',
  sellerName: 'ООО Тест',
  linesTotal: 4200,
  documentTotal: 4200,
  linesTruncated: false,
  lines: [
    {
      article: 'FILTER-42',
      name: 'Фильтр масляный',
      quantity: 2,
      quantityRaw: '2',
      unit: 'шт',
      amount: 4200,
      kind: 'part',
    },
  ],
};

let admin: pg.Client;
let pool: pg.Pool;
const fileIds: string[] = [];
const userIds: string[] = [];
const pageHashes: string[] = [];

function newPageHash(): string {
  const sha = randomBytes(32).toString('hex');
  pageHashes.push(sha);
  return sha;
}

async function seedFile(): Promise<string> {
  const user = await admin.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, last_name, first_name)
     VALUES ($1, 'test-only', 'Receipt', 'Worker') RETURNING id`,
    [`receipt-job-${randomUUID()}@example.test`],
  );
  const userId = user.rows[0]!.id;
  userIds.push(userId);
  const file = await admin.query<{ id: string }>(
    `INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
     VALUES ('test', $1, 'receipt.jpg', 'image/jpeg', 100, 'active', $2) RETURNING id`,
    [`receipt-job/${randomUUID()}.jpg`, userId],
  );
  const fileId = file.rows[0]!.id;
  fileIds.push(fileId);
  return fileId;
}

function makeEngine(
  options: {
    beforeResponse?: () => Promise<void>;
    failure?: RecognitionFailure;
  } = {},
) {
  const recognize = vi.fn<RecognitionEngine<ReceiptRecognitionResponse>['recognize']>(
    async (_page, opts) => {
      await options.beforeResponse?.();
      const meta = {
        engine: 'proxy' as const,
        model: opts.model,
        modelReported: 'vendor/receipt-model',
        // Cache versions belong to the worker task, not the transport's reported metadata.
        promptVersion: 99,
        preprocessingVersion: 99,
        inputTokens: 3389,
        outputTokens: 267,
        durationMs: 20_000,
        proxyRequestId: 'receipt-proxy-request',
        upstreamRequestId: 'receipt-upstream-request',
        idempotencyKey: 'receipt-idempotency-key',
        requestId: 'receipt-request',
      };
      return options.failure
        ? { status: 'failed', failure: options.failure, meta }
        : { status: 'done', response: RESPONSE, meta };
    },
  );
  const engine: RecognitionEngine<ReceiptRecognitionResponse> = { kind: 'proxy', recognize };
  return { engine, recognize };
}

function deps(
  engine: RecognitionEngine<ReceiptRecognitionResponse>,
  hashes: string[],
): ReceiptJobDeps {
  return {
    pool,
    s3: {} as never,
    bucket: 'test',
    engine,
    model: MODEL,
    preprocess: { maxPages: 5, maxEdgePx: 2576 },
    log: () => undefined,
    download: async () => Buffer.from('source'),
    prepare: async () => ({
      sourceKind: 'jpeg',
      totalPages: hashes.length,
      skippedPages: 0,
      preprocessingVersion: PREPROCESSING_VERSION,
      pages: hashes.map((sha256, index) => ({
        pageNo: index + 1,
        buffer: Buffer.from('page'),
        mediaType: 'image/jpeg',
        sha256,
        width: 100,
        height: 100,
      })),
    }),
  };
}

async function scan(fileId: string) {
  const result = await admin.query(
    `SELECT status, total_pages, processed_pages, error_class, error_scope, error
       FROM auto_part_receipt_scans WHERE file_id = $1`,
    [fileId],
  );
  return result.rows[0];
}

async function attempts(sha: string) {
  return (
    await admin.query(
      `SELECT * FROM auto_part_receipt_recognition_attempts
      WHERE page_sha256 = $1 ORDER BY created_at, id`,
      [sha],
    )
  ).rows;
}

describe.skipIf(!DB_URL)('receipt recognition job (db)', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: DB_URL, statement_timeout: 5000 });
    pool = new pg.Pool({
      connectionString: DB_URL,
      application_name: APPLICATION_NAME,
      statement_timeout: 5000,
    });
    await admin.connect();
  });

  afterEach(async () => {
    // Other DB suites may run concurrently; cleanup owns only these IDs and random hashes.
    await admin.query('DELETE FROM files WHERE id = ANY($1::uuid[])', [fileIds]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
    await admin.query(
      'DELETE FROM auto_part_receipt_recognition_attempts WHERE page_sha256 = ANY($1::text[])',
      [pageHashes],
    );
    fileIds.length = 0;
    userIds.length = 0;
    pageHashes.length = 0;
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it('executes the page lock SQL and persists attempts, page progress and the completed scan', async () => {
    const fileId = await seedFile();
    const hashes = [newPageHash(), newPageHash()];
    let calls = 0;
    const { engine, recognize } = makeEngine({
      beforeResponse: async () => {
        expect(await scan(fileId)).toMatchObject({
          status: 'pending',
          total_pages: 2,
          processed_pages: calls,
        });
        calls += 1;
      },
    });

    await runReceiptRecognitionJob(deps(engine, hashes), { fileId }, randomUUID());

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(await scan(fileId)).toEqual({
      status: 'done',
      total_pages: 2,
      processed_pages: 2,
      error_class: '',
      error_scope: '',
      error: '',
    });
    const pages = await admin.query(
      `SELECT page_no, page_sha256, status FROM auto_part_receipt_scan_pages
        WHERE file_id = $1 ORDER BY page_no`,
      [fileId],
    );
    expect(pages.rows).toEqual(
      hashes.map((sha, index) => ({
        page_no: index + 1,
        page_sha256: sha,
        status: 'done',
      })),
    );
    for (const sha of hashes) {
      expect(await attempts(sha)).toEqual([
        expect.objectContaining({
          status: 'done',
          forced: false,
          raw: RESPONSE,
          model: MODEL,
          model_reported: 'vendor/receipt-model',
          prompt_version: PROMPT_VERSION,
          preprocessing_version: PREPROCESSING_VERSION,
          input_tokens: 3389,
          output_tokens: 267,
          duration_ms: 20_000,
          proxy_request_id: 'receipt-proxy-request',
        }),
      ]);
    }
  });

  it('reuses a successful raster after the original file is removed', async () => {
    const first = await seedFile();
    const second = await seedFile();
    const sha = newPageHash();
    const { engine, recognize } = makeEngine();
    const jobDeps = deps(engine, [sha]);

    await runReceiptRecognitionJob(jobDeps, { fileId: first }, randomUUID());
    await admin.query('DELETE FROM files WHERE id = $1', [first]);
    await runReceiptRecognitionJob(jobDeps, { fileId: second }, randomUUID());

    expect(recognize).toHaveBeenCalledTimes(1);
    expect(await attempts(sha)).toHaveLength(1);
    expect(await scan(second)).toMatchObject({ status: 'done', processed_pages: 1 });
  });

  it('serializes parallel jobs for the same raster before the paid call', async () => {
    const first = await seedFile();
    const second = await seedFile();
    const sha = newPageHash();
    let releaseModel!: () => void;
    const modelBarrier = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const { engine, recognize } = makeEngine({ beforeResponse: () => modelBarrier });
    const jobDeps = deps(engine, [sha]);
    const firstJob = runReceiptRecognitionJob(jobDeps, { fileId: first }, randomUUID());
    // Collect rejections immediately so a regression cannot escape as an unhandled rejection.
    const results = [firstJob];
    void firstJob.catch(() => undefined);
    try {
      await expect.poll(() => recognize.mock.calls.length).toBe(1);
      const secondJob = runReceiptRecognitionJob(jobDeps, { fileId: second }, randomUUID());
      results.push(secondJob);
      void secondJob.catch(() => undefined);
      await expect
        .poll(async () => {
          const waiting = await admin.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE application_name = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
            [APPLICATION_NAME],
          );
          return waiting.rows[0]!.count;
        })
        .toBe(1);
      expect(recognize).toHaveBeenCalledTimes(1);
    } finally {
      releaseModel();
      await Promise.allSettled(results);
    }
    await Promise.all(results);
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(await attempts(sha)).toHaveLength(1);
    expect(await scan(first)).toMatchObject({ status: 'done', processed_pages: 1 });
    expect(await scan(second)).toMatchObject({ status: 'done', processed_pages: 1 });
  });

  it('bypasses the cache for forced runs and never caches their responses', async () => {
    const fileId = await seedFile();
    const sha = newPageHash();
    const { engine, recognize } = makeEngine();
    const jobDeps = deps(engine, [sha]);

    await runReceiptRecognitionJob(jobDeps, { fileId, forced: true }, randomUUID());
    await runReceiptRecognitionJob(jobDeps, { fileId }, randomUUID());
    await runReceiptRecognitionJob(jobDeps, { fileId, forced: true }, randomUUID());
    await runReceiptRecognitionJob(jobDeps, { fileId }, randomUUID());

    expect(recognize).toHaveBeenCalledTimes(3);
    expect((await attempts(sha)).map((row) => row.forced)).toEqual([true, false, true]);
    expect(await scan(fileId)).toMatchObject({ status: 'done', processed_pages: 1 });
  });

  it('stores two paid successes when the proxy chooses the model for the same raster', async () => {
    const first = await seedFile();
    const second = await seedFile();
    const sha = newPageHash();
    const { engine, recognize } = makeEngine();
    const jobDeps = { ...deps(engine, [sha]), model: PROXY_CHOOSES_MODEL };

    await runReceiptRecognitionJob(jobDeps, { fileId: first }, randomUUID());
    await runReceiptRecognitionJob(jobDeps, { fileId: second }, randomUUID());

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(await attempts(sha)).toEqual([
      expect.objectContaining({ status: 'done', model: PROXY_CHOOSES_MODEL, forced: false }),
      expect.objectContaining({ status: 'done', model: PROXY_CHOOSES_MODEL, forced: false }),
    ]);
    expect(await scan(first)).toMatchObject({ status: 'done', processed_pages: 1 });
    expect(await scan(second)).toMatchObject({ status: 'done', processed_pages: 1 });
  });

  it('commits a failed attempt while keeping the scan pending for a successful retry', async () => {
    const fileId = await seedFile();
    const sha = newPageHash();
    const failure: RecognitionFailure = {
      code: 'upstream_timeout',
      errorClass: 'transient',
      errorScope: 'subsystem',
      message: 'Model request timed out',
      retryAfterMs: null,
    };
    const failed = makeEngine({ failure });

    await expect(
      runReceiptRecognitionJob(deps(failed.engine, [sha]), { fileId }, randomUUID()),
    ).rejects.toThrow('Model request timed out');

    expect(await attempts(sha)).toEqual([
      expect.objectContaining({
        status: 'failed',
        error_code: failure.code,
        error_class: 'transient',
        error_scope: 'subsystem',
        error: failure.message,
        raw: {},
      }),
    ]);
    expect(await scan(fileId)).toMatchObject({
      status: 'pending',
      total_pages: 1,
      processed_pages: 0,
      error_class: 'transient',
      error_scope: 'subsystem',
      error: failure.message,
    });
    const pages = await admin.query(
      'SELECT status, error_scope FROM auto_part_receipt_scan_pages WHERE file_id = $1',
      [fileId],
    );
    expect(pages.rows).toEqual([{ status: 'failed', error_scope: 'subsystem' }]);

    const recovered = makeEngine();
    await runReceiptRecognitionJob(deps(recovered.engine, [sha]), { fileId }, randomUUID());
    expect(recovered.recognize).toHaveBeenCalledTimes(1);
    expect((await attempts(sha)).map((row) => row.status)).toEqual(['failed', 'done']);
    expect(await scan(fileId)).toMatchObject({
      status: 'done',
      processed_pages: 1,
      error_class: '',
      error_scope: '',
      error: '',
    });
  });

  it.each([0, 30_000])(
    'keeps the scan pending when the proxy defers it by %i ms',
    async (retryAfterMs) => {
      const fileId = await seedFile();
      const sha = newPageHash();
      const { engine } = makeEngine({
        failure: {
          code: 'queue_full',
          errorClass: 'transient',
          errorScope: 'subsystem',
          message: 'Retry after the proxy queue drains',
          retryAfterMs,
        },
      });
      const startedAt = Date.now();

      const result = await runReceiptRecognitionJob(deps(engine, [sha]), { fileId }, randomUUID());

      expect(result).toBeDefined();
      expect(result!.deferUntil.getTime()).toBeGreaterThanOrEqual(startedAt + retryAfterMs);
      expect(result!.deferUntil.getTime()).toBeLessThanOrEqual(Date.now() + retryAfterMs);
      expect(await scan(fileId)).toMatchObject({
        status: 'pending',
        total_pages: 1,
        processed_pages: 0,
        error_class: 'transient',
        error_scope: 'subsystem',
      });
      expect(await attempts(sha)).toEqual([
        expect.objectContaining({
          status: 'failed',
          error_code: 'queue_full',
          error_class: 'transient',
        }),
      ]);
    },
  );

  it('finishes a terminal model refusal as failed instead of waiting for a retry', async () => {
    const fileId = await seedFile();
    const sha = newPageHash();
    const { engine } = makeEngine({
      failure: {
        code: 'unreadable_image',
        errorClass: 'terminal',
        errorScope: 'item',
        message: 'The image is unreadable',
        retryAfterMs: null,
      },
    });

    await expect(
      runReceiptRecognitionJob(deps(engine, [sha]), { fileId }, randomUUID()),
    ).resolves.toBeUndefined();

    expect(await scan(fileId)).toMatchObject({
      status: 'failed',
      total_pages: 1,
      processed_pages: 0,
      error_class: 'terminal',
      error_scope: 'item',
      error: 'The image is unreadable',
    });
    expect(await attempts(sha)).toEqual([
      expect.objectContaining({
        status: 'failed',
        error_code: 'unreadable_image',
        error_class: 'terminal',
      }),
    ]);
  });

  it('keeps a preparation failure pending until the next queue attempt succeeds', async () => {
    const fileId = await seedFile();
    const sha = newPageHash();
    const { engine, recognize } = makeEngine();
    const jobDeps = deps(engine, [sha]);

    await expect(
      runReceiptRecognitionJob(
        {
          ...jobDeps,
          prepare: async () => {
            throw retryableFile('render_timeout', 'PDF rendering timed out');
          },
        },
        { fileId },
        randomUUID(),
      ),
    ).rejects.toThrow('PDF rendering timed out');

    expect(recognize).not.toHaveBeenCalled();
    expect(await attempts(sha)).toHaveLength(0);
    expect(await scan(fileId)).toMatchObject({
      status: 'pending',
      total_pages: 0,
      processed_pages: 0,
      error_class: 'transient',
      error_scope: 'item',
      error: 'PDF rendering timed out',
    });

    await runReceiptRecognitionJob(jobDeps, { fileId }, randomUUID());
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(await scan(fileId)).toMatchObject({
      status: 'done',
      total_pages: 1,
      processed_pages: 1,
      error_class: '',
      error_scope: '',
      error: '',
    });
  });
});
