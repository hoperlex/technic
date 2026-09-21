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
 * Чтение скана чека на автозапчасти — задача `recognize_auto_part_receipt_file`
 * (план `docs/auto-part-receipt-ocr-plan.md`, Р4, Р7, Р12).
 *
 * НАСКОЛЬКО ЭТО ПРОЩЕ ТАЛОНОВ. У талона есть заявка: её статус, её файлы, её откат, — и оттого
 * каждая пишущая транзакция там начинается с `waste_requests FOR UPDATE`, а половина файла занята
 * сверками. Здесь владельца нет вовсе: работа висит на `file_id`, чек появится потом и, может
 * быть, не появится. Блокировать нечего, сериализовать нечего, откатывать нечего.
 *
 * Остаётся ровно то, что и должно: подготовить страницы, прочитать каждую (кэш → модель), записать
 * результат. Порядок шагов и их границы — те же, что у талонов, и по тем же причинам:
 *
 * - **растеризация вне транзакций**: скачивание из S3 и рендер PDF занимают секунды;
 * - **на страницу своя короткая транзакция** с advisory-замком по ключу кэша: два воркера на одном
 *   листе не оплачивают его дважды;
 * - **карантин проверяется первым**, раньше скачивания: файл под запретом не читается никем и
 *   никогда (ADR 0168).
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
 * Замок на ключ кэша: два воркера, взявшиеся за один лист, иначе оплатили бы его дважды.
 * `hashtext` даёт знаковое 32-битное — ровно то, что принимает `pg_advisory_xact_lock`.
 */
function advisoryKey(cacheKey: string): string {
  return `hashtext(${JSON.stringify(cacheKey)})`;
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

/** Отказ обработки файла целиком: «это не изображение и не PDF», сорванная растеризация. */
async function failScan(deps: ReceiptJobDeps, fileId: string, e: TicketFileError): Promise<void> {
  await deps.pool.query(
    `UPDATE auto_part_receipt_scans
        SET status = $2, error_class = $3, error_scope = $4, error = $5, updated_at = now()
      WHERE file_id = $1`,
    [
      fileId,
      e.errorClass === 'terminal' ? 'unsupported' : 'failed',
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
 * Одна страница: кэш или модель, и в обоих случаях — запись в журнал попыток.
 *
 * Кэш выключается при варианте A (`RECEIPT_OCR_MODEL=proxy`, слаг выбирает оператор прокси) по той
 * же причине, что у талонов: за одной заглушкой в разное время стоит разная модель, и склеенные
 * под общим ключом ответы сделали бы метрику качества выдумкой.
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
    await client.query(`SELECT pg_advisory_xact_lock(${advisoryKey(cacheKey)}::bigint)`);

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
      // Временный отказ подготовки (кончилась память у рендера, сорвалось скачивание) стоит
      // повторить — тогда исключение уходит наверх и попытку считает цикл воркера.
      if (e.errorClass === 'transient') throw e;
      return;
    }
    throw e;
  }

  const outcomes: PageOutcome[] = [];
  for (const page of prepared.pages) {
    outcomes.push(await recognizePage(deps, page, { forced: !!payload.forced, jobId }));
  }

  const processed = outcomes.filter((o) => o.status === 'done').length;
  const failed = outcomes.find((o) => o.status === 'failed');
  await inTransaction(deps.pool, async (client) => {
    for (const outcome of outcomes) {
      await client.query(
        `INSERT INTO auto_part_receipt_scan_pages
           (file_id, page_no, page_sha256, status, error_class, error_scope, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (file_id, page_no) DO UPDATE
            SET page_sha256 = EXCLUDED.page_sha256, status = EXCLUDED.status,
                error_class = EXCLUDED.error_class, error_scope = EXCLUDED.error_scope,
                error = EXCLUDED.error, updated_at = now()`,
        [
          payload.fileId,
          outcome.pageNo,
          outcome.sha256,
          outcome.status,
          outcome.errorClass,
          outcome.errorScope,
          outcome.error,
        ],
      );
    }
    await client.query(
      `UPDATE auto_part_receipt_scans
          SET status = $2, total_pages = $3, processed_pages = $4,
              error_class = $5, error_scope = $6, error = $7, updated_at = now()
        WHERE file_id = $1`,
      [
        payload.fileId,
        // Хоть одна прочитанная страница — это `done`: форму уже есть чем заполнить, а про
        // непрочитанные окно скажет отдельно. `failed` остаётся для случая, когда не вышло ничего.
        processed > 0 ? 'done' : 'failed',
        prepared.totalPages,
        processed,
        processed > 0 ? '' : (failed?.errorClass ?? ''),
        processed > 0 ? '' : (failed?.errorScope ?? ''),
        processed > 0 ? '' : (failed?.error ?? ''),
      ],
    );
  });

  deps.log(
    { fileId: payload.fileId, jobId, pages: prepared.pages.length, processed },
    'Чтение чека: готово',
  );

  // Прокси назвал срок сам — переносим задачу ровно на него, а не на свой backoff.
  const retry = outcomes.find((o) => o.retryAfterMs !== null);
  if (processed === 0 && retry?.retryAfterMs) {
    return { deferUntil: new Date(Date.now() + retry.retryAfterMs) };
  }
  // Временный отказ без названного срока — повод повторить задачу: считать попытку будет цикл.
  if (processed === 0 && failed?.errorClass === 'transient') {
    throw new Error(`Чтение чека не удалось: ${failed.error}`);
  }
}
