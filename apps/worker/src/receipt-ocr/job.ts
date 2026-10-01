import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Pool, PoolClient } from 'pg';
import type { ReceiptRecognitionResponse } from '@technic/contracts';
import { attemptCacheKey, PROXY_CHOOSES_MODEL, type RecognitionEngine } from '../ocr-engine';
import { TicketFileError } from '../ticket-ocr/errors';
import {
  PREPROCESSING_VERSION,
  prepareTicketFile,
  type PreparedPage,
  type PreprocessOptions,
} from '../ticket-ocr/preprocess';
import { PROMPT_VERSION } from './prompt';

/**
 * Recognition precedes receipt creation, so the job belongs to a file rather than a receipt.
 * Downloading and rasterization happen outside transactions. Each cache key is protected by a
 * transaction-scoped advisory lock through cache lookup, model call and attempt insertion: two
 * workers must not pay twice for the same page, including through a transaction-pooling proxy.
 * Database transaction timeouts must accommodate the model timeout, as in ticket recognition.
 * Quarantine is checked before downloading because prohibited files must never reach the model.
 */

export interface ReceiptJobDeps {
  pool: Pool;
  s3: S3Client;
  bucket: string;
  engine: RecognitionEngine<ReceiptRecognitionResponse>;
  /** Заказанная модель: слаг каталога или заглушка `proxy` («выбирает прокси»). */
  model: string;
  preprocess: PreprocessOptions;
  log: (meta: Record<string, unknown>, msg: string) => void;
  /** Подмены для тестов: сеть и S3 в прогоне недоступны. */
  download?: (objectKey: string) => Promise<Buffer>;
  prepare?: (input: Buffer) => Promise<Awaited<ReturnType<typeof prepareTicketFile>>>;
}

export interface ReceiptJobPayload {
  fileId: string;
  /** «Распознать заново» при тех же версиях задания: проход мимо кэша. */
  forced?: boolean;
}

/** Задача откладывается ровно на срок, названный прокси (`Retry-After`), а не на наш backoff. */
export type ReceiptJobResult = void | { deferUntil: Date };

interface ScanFile {
  objectKey: string;
}

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Начало работы: файл жив, не в карантине, строка скана переведена в `pending`.
 *
 * Возвращает `null`, когда работать не над чем — файла нет или он под запретом. Это не сбой:
 * человек вправе снять скан, пока задача ждала очереди, и падать на этом задача не должна.
 */
async function beginScan(deps: ReceiptJobDeps, fileId: string): Promise<ScanFile | null> {
  return inTransaction(deps.pool, async (client) => {
    const found = await client.query<{ object_key: string; quarantined_at: string | null }>(
      `SELECT object_key, quarantined_at FROM files WHERE id = $1 AND status = 'active'`,
      [fileId],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.quarantined_at) {
      deps.log({ fileId }, 'Чтение чека: файл в карантине, задача закрыта');
      return null;
    }
    await client.query(
      `INSERT INTO auto_part_receipt_scans (file_id, status)
            VALUES ($1, 'pending')
       ON CONFLICT (file_id) DO UPDATE
          SET status = 'pending', error_class = '', error_scope = '', error = '',
              processed_pages = 0, updated_at = now()`,
      [fileId],
    );
    return { objectKey: row.object_key };
  });
}

/** Keep retryable preparation failures pending so the form continues polling the queued retry. */
async function failScan(deps: ReceiptJobDeps, fileId: string, e: TicketFileError): Promise<void> {
  await deps.pool.query(
    `UPDATE auto_part_receipt_scans
        SET status = $2, error_class = $3, error_scope = $4, error = $5, updated_at = now()
      WHERE file_id = $1`,
    [
      fileId,
      e.errorClass === 'terminal' ? 'unsupported' : 'pending',
      e.errorClass,
      e.errorScope,
      e.reason,
    ],
  );
}

interface PageOutcome {
  pageNo: number;
  sha256: string;
  status: 'done' | 'failed';
  errorClass: string;
  errorScope: string;
  error: string;
  retryAfterMs: number | null;
}

/**
 * Resolve one page from cache or the model and materialize every paid attempt. Cache is disabled
 * for variant A (`RECEIPT_OCR_MODEL=proxy`): the proxy may change the actual model behind that
 * placeholder, so a shared cache key would make quality metrics fictitious.
 */
async function recognizePage(
  deps: ReceiptJobDeps,
  page: PreparedPage,
  opts: { forced: boolean; jobId: string },
): Promise<PageOutcome> {
  const cacheKey = attemptCacheKey({
    pageSha256: page.sha256,
    engine: deps.engine.kind,
    model: deps.model,
    promptVersion: PROMPT_VERSION,
    preprocessingVersion: PREPROCESSING_VERSION,
  });
  const cacheable = deps.model !== PROXY_CHOOSES_MODEL;

  return inTransaction(deps.pool, async (client) => {
    // JSON quoting produces a SQL identifier, not a string value; the lock would fail before
    // calling the model and leave no attempt for health to count. Bind the key as data instead.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [cacheKey]);

    if (!opts.forced && cacheable) {
      const hit = await client.query<{ id: string }>(
        `SELECT id FROM auto_part_receipt_recognition_attempts
          WHERE page_sha256 = $1 AND engine = $2 AND model = $3
            AND prompt_version = $4 AND preprocessing_version = $5
            AND status = 'done' AND NOT forced
          LIMIT 1`,
        [page.sha256, deps.engine.kind, deps.model, PROMPT_VERSION, PREPROCESSING_VERSION],
      );
      if (hit.rows[0]) {
        // Единственное место, где вызова не было, а результат есть: в журнале это отдельной
        // строкой, иначе «страница разобрана за 20 мс» выглядит подозрительно.
        deps.log(
          { pageSha256: page.sha256.slice(0, 12), attemptId: hit.rows[0].id },
          'Чтение чека: страница взята из кэша попыток',
        );
        return {
          pageNo: page.pageNo,
          sha256: page.sha256,
          status: 'done' as const,
          errorClass: '',
          errorScope: '',
          error: '',
          retryAfterMs: null,
        };
      }
    }

    const outcome = await deps.engine.recognize(
      { sha256: page.sha256, buffer: page.buffer, mediaType: page.mediaType },
      { model: deps.model, forced: opts.forced, jobId: opts.jobId },
    );
    const meta = outcome.meta;
    await client.query(
      `INSERT INTO auto_part_receipt_recognition_attempts
         (page_sha256, engine, model, model_reported, prompt_version, preprocessing_version,
          status, forced, raw, input_tokens, output_tokens, duration_ms,
          proxy_request_id, upstream_request_id, error_code, error_class, error_scope, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        page.sha256,
        meta.engine,
        meta.model,
        meta.modelReported,
        // Версии — из НАШИХ констант, теми же, по которым собран ключ кэша выше: разойдись запись
        // с чтением хоть на единицу, кэш перестал бы находить собственные записи.
        PROMPT_VERSION,
        PREPROCESSING_VERSION,
        outcome.status,
        opts.forced,
        JSON.stringify(outcome.status === 'done' ? outcome.response : {}),
        meta.inputTokens,
        meta.outputTokens,
        meta.durationMs,
        meta.proxyRequestId,
        meta.upstreamRequestId,
        outcome.status === 'failed' ? outcome.failure.code : '',
        outcome.status === 'failed' ? outcome.failure.errorClass : '',
        outcome.status === 'failed' ? outcome.failure.errorScope : '',
        outcome.status === 'failed' ? outcome.failure.message : '',
      ],
    );

    return {
      pageNo: page.pageNo,
      sha256: page.sha256,
      status: outcome.status,
      errorClass: outcome.status === 'failed' ? outcome.failure.errorClass : '',
      errorScope: outcome.status === 'failed' ? outcome.failure.errorScope : '',
      error: outcome.status === 'failed' ? outcome.failure.message : '',
      retryAfterMs: outcome.status === 'failed' ? outcome.failure.retryAfterMs : null,
    };
  });
}

async function setPreparedPageCount(
  deps: ReceiptJobDeps,
  fileId: string,
  totalPages: number,
): Promise<void> {
  await deps.pool.query(
    `UPDATE auto_part_receipt_scans
        SET total_pages = $2, processed_pages = 0, updated_at = now()
      WHERE file_id = $1 AND status = 'pending'`,
    [fileId, totalPages],
  );
}

async function recordPageProgress(
  deps: ReceiptJobDeps,
  fileId: string,
  outcome: PageOutcome,
  processedPages: number,
): Promise<void> {
  await inTransaction(deps.pool, async (client) => {
    await client.query(
      `INSERT INTO auto_part_receipt_scan_pages
         (file_id, page_no, page_sha256, status, error_class, error_scope, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (file_id, page_no) DO UPDATE
          SET page_sha256 = EXCLUDED.page_sha256, status = EXCLUDED.status,
              error_class = EXCLUDED.error_class, error_scope = EXCLUDED.error_scope,
              error = EXCLUDED.error, updated_at = now()`,
      [
        fileId,
        outcome.pageNo,
        outcome.sha256,
        outcome.status,
        outcome.errorClass,
        outcome.errorScope,
        outcome.error,
      ],
    );
    await client.query(
      `UPDATE auto_part_receipt_scans
          SET processed_pages = $2, updated_at = now()
        WHERE file_id = $1 AND status = 'pending'`,
      [fileId, processedPages],
    );
  });
}

async function downloadObject(deps: ReceiptJobDeps, objectKey: string): Promise<Buffer> {
  const res = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: objectKey }));
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error('S3 вернул пустое тело объекта');
  return Buffer.from(await body.transformToByteArray());
}

/**
 * Точка входа задачи.
 *
 * Возвращает `{ deferUntil }`, когда прокси назвал срок сам: очередь у него общая с чужими
 * сервисами, и наша вежливость — единственное, что мешает нам её занять. Бросает исключение только
 * на временных сбоях, которые стоит повторить; терминальные записаны скану и повторять их нечем.
 */
export async function runReceiptRecognitionJob(
  deps: ReceiptJobDeps,
  payload: ReceiptJobPayload,
  jobId: string,
): Promise<ReceiptJobResult> {
  const scan = await beginScan(deps, payload.fileId);
  if (!scan) return;
  deps.log({ fileId: payload.fileId, jobId, forced: !!payload.forced }, 'Чтение чека: начало');

  let prepared;
  try {
    const source = await (deps.download
      ? deps.download(scan.objectKey)
      : downloadObject(deps, scan.objectKey));
    prepared = await (deps.prepare
      ? deps.prepare(source)
      : prepareTicketFile(source, deps.preprocess));
  } catch (e: unknown) {
    if (e instanceof TicketFileError) {
      await failScan(deps, payload.fileId, e);
      // The queue owns retry exhaustion. Keeping the scan pending until then prevents the form
      // from stopping its poll before a later preparation attempt succeeds.
      if (e.errorClass === 'transient') throw e;
      return;
    }
    throw e;
  }

  await setPreparedPageCount(deps, payload.fileId, prepared.totalPages);

  const outcomes: PageOutcome[] = [];
  for (const page of prepared.pages) {
    const outcome = await recognizePage(deps, page, { forced: !!payload.forced, jobId });
    outcomes.push(outcome);
    const processedPages = outcomes.filter((item) => item.status === 'done').length;
    await recordPageProgress(deps, payload.fileId, outcome, processedPages);
  }

  const processed = outcomes.filter((o) => o.status === 'done').length;
  const failed = outcomes.find((o) => o.status === 'failed');
  const retryAfterMs = outcomes.find((o) => o.retryAfterMs !== null)?.retryAfterMs ?? null;
  const retrying = processed === 0 && (retryAfterMs !== null || failed?.errorClass === 'transient');
  await deps.pool.query(
    `UPDATE auto_part_receipt_scans
        SET status = $2, total_pages = $3, processed_pages = $4,
            error_class = $5, error_scope = $6, error = $7, updated_at = now()
      WHERE file_id = $1`,
    [
      payload.fileId,
      // Partial results can fill the form. With no usable page, a live retry must remain pending:
      // the form stops polling terminal statuses and would otherwise miss its eventual success.
      processed > 0 ? 'done' : retrying ? 'pending' : 'failed',
      prepared.totalPages,
      processed,
      processed > 0 ? '' : (failed?.errorClass ?? ''),
      processed > 0 ? '' : (failed?.errorScope ?? ''),
      processed > 0 ? '' : (failed?.error ?? ''),
    ],
  );

  deps.log(
    { fileId: payload.fileId, jobId, pages: prepared.pages.length, processed },
    'Чтение чека: готово',
  );

  // Honor the proxy's shared-queue deadline, including an immediate retry, instead of our backoff.
  if (processed === 0 && retryAfterMs !== null) {
    return { deferUntil: new Date(Date.now() + retryAfterMs) };
  }
  // The queue applies backoff and marks the scan failed only after retry exhaustion.
  if (processed === 0 && failed?.errorClass === 'transient') {
    throw new Error(`Чтение чека не удалось: ${failed.error}`);
  }
}
