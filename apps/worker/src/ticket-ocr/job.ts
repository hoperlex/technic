/**
 * Задача очереди «прочитать талоны приложенного файла» (ADR 0114, план — Р11, Р12, Р13, Р14).
 *
 * Здесь сшиваются три готовые части: подготовка страниц (`preprocess.ts`), движок (`engine/`) и
 * база. Своей логики распознавания в файле нет — только порядок, и порядок этот и есть содержание
 * задачи. Он разложен на **три короткие транзакции и одно длинное действие между ними**:
 *
 * | шаг | что делает | блокировка |
 * | --- | --- | --- |
 * | T0 | проверка связи и статуса, файловая строка в `pending` с номером задачи | `waste_requests FOR UPDATE` |
 * | растеризация | скачивание из S3, страницы, `page_sha256` | нет |
 * | проверка | связь и статус читаются ещё раз, **до** обращения к модели | нет |
 * | T1 | advisory lock ключа кэша, чтение кэша, вызов модели, вставка попытки | только ключ кэша |
 * | T2 | повторная проверка, запись страниц и талонов, файловый статус | `waste_requests FOR UPDATE` |
 *
 * **Почему T1 отдельно.** Вызов к модели идёт до двух минут. Держи мы на это время строку заявки —
 * закрытие следующей заявки и откат этой ждали бы сеть. Поэтому дорогое вынесено в транзакцию,
 * которая строк заявки не касается вовсе и блокирует только свой ключ кэша.
 *
 * **Почему проверок три.** Заявку откатывают в любой момент, в том числе пока воркер растеризует
 * PDF. Первая проверка (T0) не даёт начать работу по уже откатанной заявке, вторая экономит платный
 * вызов, третья (в T2) — единственная обязательная: она под общим замком, и опоздавшая задача
 * становится no-op вместо того, чтобы дописать бумагу в заявку, где её уже сняли.
 *
 * **Границу не убрать**: если откат случился, когда запрос уже ушёл, скан передан и вызов оплачен.
 * T2 просто ничего не запишет. Устранимо только долгой блокировкой заявки, а она недопустима.
 */

import { createHash } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { wasteTicketNumberFuzzy, wasteTicketNumberKey } from '@technic/contracts';
import { prepareTicketFile, PREPROCESSING_VERSION } from './preprocess';
import { TicketFileError } from './errors';
import { attemptCacheKey } from './engine/keys';
import type { PageImage, RecognitionEngine, RecognitionOutcome } from './engine/types';
import { PROMPT_VERSION } from './engine/prompt';
import type { PreparedFile, PreprocessOptions } from './preprocess';

/** Пул `pg` в том виде, в каком его держит воркер: транзакции берутся клиентом из пула. */
export interface JobPool {
  connect(): Promise<JobClient>;
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface JobClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  release(): void;
}

export interface TicketJobDeps {
  pool: JobPool;
  s3: S3Client;
  bucket: string;
  engine: RecognitionEngine;
  model: string;
  escalationModel: string;
  preprocess: PreprocessOptions;
  log: (meta: Record<string, unknown>, msg: string) => void;
  /**
   * Скачивание и подготовка вынесены в зависимости ради проверяемости порядка транзакций: гонку
   * отката с записью результата приходится ловить барьером между шагами, и тянуть в такой тест
   * ещё и S3 с растеризатором значило бы проверять три вещи разом, не понимая, какая из них упала.
   * По умолчанию — настоящие S3 и `prepareTicketFile`.
   */
  download?: (objectKey: string) => Promise<Buffer>;
  prepare?: (source: Buffer) => Promise<PreparedFile>;
}

export interface TicketJobPayload {
  requestId: string;
  fileId: string;
  /** Принудительный проход мимо кэша — кнопка «перераспознать» при тех же версиях (Р13). */
  forced?: boolean;
}

/** Исход задачи для цикла воркера: перенос — это `Retry-After` прокси, а не наш backoff (Р5). */
export type TicketJobResult = { deferUntil: Date } | void;

/**
 * Связь файла с заявкой в том виде, в каком её проверяют все три раза. Версии заявки здесь нет
 * намеренно (Р11): правку выполненной заявки разрешена не только площадке, и она поднимает
 * `version` — сверка по ней молча отменяла бы распознавание после смены комментария.
 */
interface LinkState {
  linked: boolean;
  objectKey: string;
  contentType: string;
}

const LINK_SQL = `
  SELECT f.object_key, f.content_type
    FROM request_files rf
    JOIN files f ON f.id = rf.file_id
    JOIN waste_requests wr ON wr.id = rf.request_id
   WHERE rf.request_id = $1
     AND rf.file_id = $2
     AND rf.kind = 'ticket'
     AND f.deleted_at IS NULL
     AND wr.deleted_at IS NULL
     AND wr.status = 'done'`;

async function readLink(client: JobClient, requestId: string, fileId: string): Promise<LinkState> {
  const res = await client.query<{ object_key: string; content_type: string }>(LINK_SQL, [
    requestId,
    fileId,
  ]);
  const row = res.rows[0];
  return {
    linked: !!row,
    objectKey: row?.object_key ?? '',
    contentType: row?.content_type ?? '',
  };
}

/** Общий замок контура: любая запись про талоны идёт после него (Р11). */
async function lockRequest(client: JobClient, requestId: string): Promise<void> {
  await client.query('SELECT id FROM waste_requests WHERE id = $1 FOR UPDATE', [requestId]);
}

async function inTransaction<T>(pool: JobPool, fn: (c: JobClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** `pg_advisory_xact_lock` берёт 64-битное число — ключ кэша сворачивается в него хэшем. */
function advisoryKey(cacheKey: string): string {
  const digest = createHash('sha256').update(cacheKey).digest();
  // BigInt со знаком: старший бит гасится, чтобы не выйти за bigint PostgreSQL.
  return (digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn).toString();
}

// ── T0: взять файл в работу ──

/**
 * Заводит файловую строку и записывает за ней номер задачи. `active_job_id` — не бухгалтерия: без
 * него интерфейс не покажет «попытка 3 из 5, следующая в 14:32», а человек не отличит «идёт» от
 * «зависло» (Р29).
 *
 * Возвращает `null`, если работать не над чем: заявка откатана, файл отвязан или удалён. Это не
 * ошибка и не повод тратить попытку — задача просто ничего не делает.
 */
async function beginFile(
  deps: TicketJobDeps,
  payload: TicketJobPayload,
  jobId: string,
): Promise<LinkState | null> {
  return inTransaction(deps.pool, async (client) => {
    await lockRequest(client, payload.requestId);
    const link = await readLink(client, payload.requestId, payload.fileId);
    if (!link.linked) return null;
    await client.query(
      `INSERT INTO waste_ticket_files (file_id, request_id, status, active_job_id)
            VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (file_id) DO UPDATE
              SET status = 'pending', reason = '', error_class = '', error_scope = '',
                  active_job_id = $3, updated_at = now()`,
      [payload.fileId, payload.requestId, jobId],
    );
    return link;
  });
}

// ── T2-error: отказ подготовки ──

/**
 * Пишет отказ файлу — с обеими осями классификации. `error_class` уезжает в текст на экране
 * («повторим автоматически» против «нужен администратор»), `error_scope` решает, поднимать ли
 * глобальный баннер: один упёршийся в лимит файл не означает, что сервис не настроен (Р29).
 */
async function failFile(
  deps: TicketJobDeps,
  payload: TicketJobPayload,
  err: TicketFileError,
): Promise<void> {
  await inTransaction(deps.pool, async (client) => {
    await lockRequest(client, payload.requestId);
    const link = await readLink(client, payload.requestId, payload.fileId);
    if (!link.linked) return;
    await client.query(
      `UPDATE waste_ticket_files
          SET status = $2, reason = $3, error_class = $4, error_scope = $5,
              active_job_id = NULL, updated_at = now()
        WHERE file_id = $1`,
      [
        payload.fileId,
        err.errorClass === 'terminal' ? 'unsupported' : 'failed',
        err.reason,
        err.errorClass,
        err.errorScope,
      ],
    );
  });
}

// ── T1: одна страница ──

/**
 * Распознаёт страницу и возвращает попытку. Кэш и advisory lock — в одной транзакции с вызовом:
 * замок держит **ключ кэша**, а не заявку, поэтому два воркера на одном листе выстраиваются в
 * очередь, и второй забирает готовый результат вместо второго платного вызова (Р12).
 *
 * Оговорка, которая стоит денег: дедуп прокси схлопывает только **конкурентные** запросы. Повтор
 * задачи через минуту — новый вызов, и его оплатят. От повторной оплаты последовательных попыток
 * спасает этот кэш, и только если предыдущая попытка успела записаться как `done`.
 */
async function recognizePage(
  deps: TicketJobDeps,
  page: PageImage,
  opts: { model: string; forced: boolean; jobId: string },
): Promise<{ attemptId: string; outcome: RecognitionOutcome | null; fromCache: boolean }> {
  const cacheKey = attemptCacheKey({
    pageSha256: page.sha256,
    engine: deps.engine.kind,
    model: opts.model,
    promptVersion: PROMPT_VERSION,
    preprocessingVersion: PREPROCESSING_VERSION,
  });

  return inTransaction(deps.pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryKey(cacheKey)]);

    if (!opts.forced) {
      const hit = await client.query<{ id: string; raw: unknown }>(
        `SELECT id, raw FROM waste_ticket_recognition_attempts
          WHERE page_sha256 = $1 AND engine = $2 AND model = $3
            AND prompt_version = $4 AND preprocessing_version = $5
            AND status = 'done' AND NOT forced
          LIMIT 1`,
        [page.sha256, deps.engine.kind, opts.model, PROMPT_VERSION, PREPROCESSING_VERSION],
      );
      const row = hit.rows[0];
      if (row) return { attemptId: row.id, outcome: null, fromCache: true };
    }

    const outcome = await deps.engine.recognize(page, {
      model: opts.model,
      forced: opts.forced,
      jobId: opts.jobId,
    });
    const meta = outcome.meta;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO waste_ticket_recognition_attempts
         (page_sha256, engine, model, model_reported, prompt_version, preprocessing_version,
          status, forced, raw, input_tokens, output_tokens, duration_ms,
          proxy_request_id, upstream_request_id, error_code, error_class, error_scope, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        page.sha256,
        meta.engine,
        meta.model,
        meta.modelReported,
        meta.promptVersion,
        meta.preprocessingVersion,
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
    return { attemptId: inserted.rows[0]!.id, outcome, fromCache: false };
  });
}

// ── Каскад по полям (Р14) ──

/** Поле, требующее второго прохода: пустое, названное нечитаемым или не прошедшее проверку формы. */
function fieldsNeedingEscalation(
  ticket: { number: string | null; issuedOn: string | null; volumeM3: number | null; workKind: string },
  unreadable: readonly string[],
): string[] {
  const need: string[] = [];
  if (!ticket.number || unreadable.includes('number')) need.push('number');
  if (!ticket.issuedOn || unreadable.includes('issuedOn')) need.push('issuedOn');
  // У простоя объёма нет законно — просить старшую модель перечитать пустоту незачем.
  const volumeExpected = ticket.workKind === 'removal';
  if (volumeExpected && (ticket.volumeM3 == null || unreadable.includes('volumeM3'))) {
    need.push('volumeM3');
  }
  return need;
}

/**
 * Сопоставление талонов между проходами (Р13). По позиции — только последним резервом: порядок
 * массива модель менять вправе, и сопоставление по `seq` показало бы предложение от одного талона
 * рядом с другим. Сперва номер (он напечатан типографски и читается надёжнее всего), затем пара
 * «дата + объём», и лишь потом позиция.
 */
function matchTicket<T extends { number: string | null; issuedOn: string | null; volumeM3: number | null }>(
  target: T,
  candidates: readonly T[],
  index: number,
): T | undefined {
  if (target.number) {
    const key = wasteTicketNumberKey(target.number);
    const byNumber = candidates.find((c) => c.number && wasteTicketNumberKey(c.number) === key);
    if (byNumber) return byNumber;
  }
  if (target.issuedOn && target.volumeM3 != null) {
    const byFields = candidates.find(
      (c) => c.issuedOn === target.issuedOn && c.volumeM3 === target.volumeM3,
    );
    if (byFields) return byFields;
  }
  return candidates[index];
}

/**
 * Слияние двух проходов по одному полю. Расхождение — **не ответ**: поле остаётся пустым, а имя
 * уходит в `needs_review_fields`, и человек видит двух кандидатов. Старшая модель ошибается реже,
 * но ошибается, и выбирать за человека молча портал не берётся (Р14).
 */
function mergeField<V>(
  primary: V | null,
  escalated: V | null | undefined,
): { value: V | null; review: boolean; candidates: [V, V] | null } {
  if (escalated === undefined) return { value: primary, review: false, candidates: null };
  if (primary === null || primary === undefined) {
    return { value: escalated ?? null, review: false, candidates: null };
  }
  if (escalated === null) return { value: primary, review: false, candidates: null };
  if (primary === escalated) return { value: primary, review: false, candidates: null };
  // Оба прочитанных значения сохраняются рядом с талоном: без них вопрос «поле спорное» отправляет
  // человека к скану вслепую, а «первая прочитала 20, вторая 28» решается взглядом (Р14).
  return { value: null, review: true, candidates: [primary, escalated] };
}

// ── T2: запись результата ──

interface PageResult {
  pageNo: number;
  sha256: string;
  primaryAttemptId: string;
  escalationAttemptId: string | null;
  tickets: {
    number: string | null;
    issuedOn: string | null;
    volumeM3: number | null;
    workKind: string;
    addressRaw: string | null;
    needsReview: string[];
    /** Что прочитал каждый проход по спорному полю — снимком, для экрана разбора (Р14). */
    candidates: { field: string; value: string; model: string }[];
  }[];
}

/**
 * Пишет страницы и талоны — под общим замком и после третьей, обязательной проверки связи. Всё,
 * что записано здесь, принадлежит заявке и уйдёт при её откате (Р22); попытки, наоборот, остаются:
 * они принадлежат содержимому страницы и служат кэшем.
 *
 * Талон заводится `unconfirmed`: распознанное — предложение, а не факт. Номер занимает место в
 * реестре только после подтверждения человеком, поэтому `operator_counterparty_id` здесь **не
 * заполняется** — снимок оператора берётся в момент подтверждения (Р17).
 */
async function saveResult(
  deps: TicketJobDeps,
  payload: TicketJobPayload,
  prepared: { totalPages: number; skippedPages: number },
  pages: readonly PageResult[],
): Promise<boolean> {
  return inTransaction(deps.pool, async (client) => {
    await lockRequest(client, payload.requestId);
    const link = await readLink(client, payload.requestId, payload.fileId);
    if (!link.linked) {
      deps.log(
        { requestId: payload.requestId, fileId: payload.fileId },
        'Распознавание завершилось в пустоту: заявку откатили или файл отвязали — результат не пишем',
      );
      return false;
    }

    for (const page of pages) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO waste_ticket_pages
           (file_id, request_id, page_no, page_sha256, status, tickets_found)
         VALUES ($1,$2,$3,$4,'done',$5)
         ON CONFLICT (file_id, page_no) DO UPDATE
                SET page_sha256 = EXCLUDED.page_sha256, status = 'done',
                    tickets_found = EXCLUDED.tickets_found, updated_at = now()
         RETURNING id`,
        [payload.fileId, payload.requestId, page.pageNo, page.sha256, page.tickets.length],
      );
      const pageId = inserted.rows[0]!.id;

      let seq = 0;
      for (const ticket of page.tickets) {
        seq += 1;
        const raw = ticket.number ?? '';
        const values = [
          payload.requestId,
          pageId,
          seq,
          page.primaryAttemptId,
          page.escalationAttemptId,
          raw,
          raw ? wasteTicketNumberKey(raw) : '',
          raw ? wasteTicketNumberFuzzy(raw) : '',
          ticket.issuedOn,
          ticket.volumeM3,
          ticket.workKind,
          ticket.addressRaw ?? '',
          ticket.needsReview,
          JSON.stringify(ticket.candidates),
        ];
        // Строка, к которой человек не прикасался, переписывается новым проходом целиком: она и
        // была предложением машины, а не решением. Тронутая — нет (Р13): подтверждённая занимает
        // номер, ручная написана человеком, правленая исправлена им же, и перезапись стёрла бы
        // работу, ради которой кнопку «перераспознать» и нажимают.
        const written = await client.query<{ id: string }>(
          `INSERT INTO waste_tickets
             (request_id, page_id, seq, primary_attempt_id, escalation_attempt_id,
              number_raw, number_key, number_fuzzy, issued_on, volume_m3, work_kind,
              address_raw, origin, status, needs_review_fields, candidates)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ocr','unconfirmed',$13::text[],
                   $14::jsonb)
           ON CONFLICT (page_id, seq) WHERE page_id IS NOT NULL AND origin = 'ocr'
           DO UPDATE SET primary_attempt_id = EXCLUDED.primary_attempt_id,
                         escalation_attempt_id = EXCLUDED.escalation_attempt_id,
                         number_raw = EXCLUDED.number_raw,
                         number_key = EXCLUDED.number_key,
                         number_fuzzy = EXCLUDED.number_fuzzy,
                         issued_on = EXCLUDED.issued_on,
                         volume_m3 = EXCLUDED.volume_m3,
                         work_kind = EXCLUDED.work_kind,
                         address_raw = EXCLUDED.address_raw,
                         needs_review_fields = EXCLUDED.needs_review_fields,
                         candidates = EXCLUDED.candidates,
                         updated_at = now()
                   WHERE waste_tickets.status = 'unconfirmed'
                     AND waste_tickets.edited_at IS NULL
           RETURNING id`,
          values,
        );
        if (written.rows[0]) continue;

        // Талон тронут человеком — новый проход ложится РЯДОМ предложением (Р13). Снимком, а не
        // ссылкой на попытку: сырьё убирается по сроку (Р31), обе ссылки объявлены `SET NULL`, и
        // предложение обязано читаться и тогда — теряя лишь возможность заглянуть в исходный ответ.
        //
        // Предложение, повторяющее то, что в талоне уже стоит, не заводится: «модель прочитала то
        // же самое» — не новость, а лишняя строка, которую человеку придётся закрывать руками.
        await client.query(
          `INSERT INTO waste_ticket_proposals
             (ticket_id, number_raw, issued_on, volume_m3, work_kind, address_raw,
              primary_attempt_id, escalation_attempt_id)
           SELECT wt.id, $4, $5, $6, $7, $8, $9, $10
             FROM waste_tickets wt
            WHERE wt.page_id = $1 AND wt.seq = $2 AND wt.origin = 'ocr'
              AND wt.request_id = $3
              AND (wt.number_raw, wt.issued_on, wt.volume_m3, wt.work_kind, wt.address_raw)
                  IS DISTINCT FROM ($4, $5::date, $6::numeric, $7, $8)
           ON CONFLICT (ticket_id) DO UPDATE
                  SET number_raw = EXCLUDED.number_raw, issued_on = EXCLUDED.issued_on,
                      volume_m3 = EXCLUDED.volume_m3, work_kind = EXCLUDED.work_kind,
                      address_raw = EXCLUDED.address_raw,
                      primary_attempt_id = EXCLUDED.primary_attempt_id,
                      escalation_attempt_id = EXCLUDED.escalation_attempt_id,
                      created_at = now()`,
          [
            pageId,
            seq,
            payload.requestId,
            raw,
            ticket.issuedOn,
            ticket.volumeM3,
            ticket.workKind,
            ticket.addressRaw ?? '',
            page.primaryAttemptId,
            page.escalationAttemptId,
          ],
        );
      }
    }

    await client.query(
      `UPDATE waste_ticket_files
          SET status = 'done', reason = $2, error_class = '', error_scope = '',
              total_pages = $3, processed_pages = $4, active_job_id = NULL, updated_at = now()
        WHERE file_id = $1`,
      [
        payload.fileId,
        prepared.skippedPages > 0
          ? `Страниц в файле ${prepared.totalPages}, обработано ${pages.length} (лимит)`
          : '',
        prepared.totalPages,
        pages.length,
      ],
    );
    return true;
  });
}

// ── Задача целиком ──

async function downloadObject(deps: TicketJobDeps, objectKey: string): Promise<Buffer> {
  const res = await deps.s3.send(
    new GetObjectCommand({ Bucket: deps.bucket, Key: objectKey }),
  );
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error('S3 вернул пустое тело объекта');
  return Buffer.from(await body.transformToByteArray());
}

/**
 * Точка входа задачи `recognize_waste_ticket_file`.
 *
 * Возвращает `{ deferUntil }`, когда прокси назвал срок сам (`Retry-After` при 503): задача
 * переносится **ровно на него**, а не на наш экспоненциальный backoff — очередь у прокси общая с
 * чужими сервисами. Бросает исключение только на временных сбоях, которые стоит повторить: цикл
 * воркера сам посчитает попытку и разведёт паузу. Терминальные отказы исключением не бросаются —
 * они уже записаны файлу, и повторять их нечем.
 */
export async function runTicketRecognitionJob(
  deps: TicketJobDeps,
  payload: TicketJobPayload,
  jobId: string,
): Promise<TicketJobResult> {
  const link = await beginFile(deps, payload, jobId);
  if (!link) return;

  // Растеризация — вне транзакций: скачивание из S3 и рендер PDF занимают секунды, и держать на
  // это время строку заявки незачем.
  let prepared;
  try {
    const source = await (deps.download
      ? deps.download(link.objectKey)
      : downloadObject(deps, link.objectKey));
    prepared = await (deps.prepare
      ? deps.prepare(source)
      : prepareTicketFile(source, deps.preprocess));
  } catch (e: unknown) {
    if (e instanceof TicketFileError) {
      await failFile(deps, payload, e);
      // Временный отказ подготовки (кончилась память у рендера, сорвалось скачивание) стоит
      // повторить — тогда исключение уходит наверх и попытку считает цикл воркера.
      if (e.errorClass === 'transient') throw e;
      return;
    }
    throw e;
  }

  // Вторая проверка — до первого платного вызова. Откат, случившийся во время растеризации,
  // остановит работу здесь; дальше этой точки скан уже уйдёт наружу и будет оплачен.
  const stillLinked = await inTransaction(deps.pool, (client) =>
    readLink(client, payload.requestId, payload.fileId),
  );
  if (!stillLinked.linked) return;

  const results: PageResult[] = [];
  for (const page of prepared.pages) {
    const first = await recognizePage(deps, page, {
      model: deps.model,
      forced: !!payload.forced,
      jobId,
    });

    // Кэш: страницу этими же версиями уже читали. Вызова нет, денег нет, попытка та же.
    if (first.fromCache) {
      const cached = await inTransaction(deps.pool, (client) =>
        client.query<{ raw: { tickets?: unknown[]; unreadable?: string[] } }>(
          'SELECT raw FROM waste_ticket_recognition_attempts WHERE id = $1',
          [first.attemptId],
        ),
      );
      const raw = cached.rows[0]?.raw ?? {};
      results.push(toPageResult(page, first.attemptId, null, raw, []));
      continue;
    }

    const outcome = first.outcome!;
    if (outcome.status === 'failed') {
      const failure = outcome.failure;
      deps.log(
        {
          requestId: payload.requestId,
          fileId: payload.fileId,
          pageNo: page.pageNo,
          code: failure.code,
          errorClass: failure.errorClass,
          errorScope: failure.errorScope,
          model: outcome.meta.model,
          proxyRequestId: outcome.meta.proxyRequestId,
        },
        `Распознавание страницы не удалось: ${failure.message}`,
      );
      // Терминальный отказ дальше не поедет: он записан попыткой и файлом, и повторять его нечем.
      if (failure.errorClass === 'terminal') {
        await failFile(
          deps,
          payload,
          new TicketFileError({
            code: failure.code,
            reason: failure.message,
            errorClass: failure.errorClass,
            errorScope: failure.errorScope,
          }),
        );
        return;
      }
      if (failure.retryAfterMs != null) return { deferUntil: new Date(Date.now() + failure.retryAfterMs) };
      throw new Error(`${failure.code}: ${failure.message}`);
    }

    // Эскалация: старшая модель перечитывает страницу, если хоть у одного талона пусто поле,
    // которое обязано быть заполненным. Просить её о том же, что уже прочитано, незачем — она
    // получает то же задание, отличается только модель, и это её единственное отличие (Р14).
    const primaryTickets = outcome.response.tickets;
    const needsSecond =
      !!deps.escalationModel &&
      deps.escalationModel !== deps.model &&
      primaryTickets.some(
        (t) => fieldsNeedingEscalation(t, outcome.response.unreadable ?? []).length > 0,
      );

    if (!needsSecond) {
      results.push(toPageResult(page, first.attemptId, null, outcome.response, []));
      continue;
    }

    const second = await recognizePage(deps, page, {
      model: deps.escalationModel,
      forced: !!payload.forced,
      jobId,
    });
    const secondOutcome = second.outcome;
    if (!secondOutcome || secondOutcome.status === 'failed') {
      // Эскалация не удалась — это не повод терять первый проход: пишем его как есть.
      results.push(toPageResult(page, first.attemptId, null, outcome.response, []));
      continue;
    }
    results.push(
      toPageResult(
        page,
        first.attemptId,
        second.attemptId,
        outcome.response,
        secondOutcome.response.tickets,
        {
          primary: outcome.meta.modelReported || deps.model,
          escalation: secondOutcome.meta.modelReported || deps.escalationModel,
        },
      ),
    );
  }

  await saveResult(
    deps,
    payload,
    { totalPages: prepared.totalPages, skippedPages: prepared.skippedPages },
    results,
  );
}

/** Собирает страницу результата, сливая проходы по полям (Р14). */
function toPageResult(
  page: PageImage & { pageNo: number },
  primaryAttemptId: string,
  escalationAttemptId: string | null,
  primary: { tickets?: unknown[]; unreadable?: string[] } | Record<string, unknown>,
  escalated: readonly unknown[],
  /**
   * Чем читали проходы. Фактические модели (`model_reported`, Р7), а не заказанные: человеку в
   * споре важно, кто именно так прочитал, а прокси вправе подставить свою (Р7).
   */
  models: { primary: string; escalation: string } = { primary: '', escalation: '' },
): PageResult {
  const primaryModel = models.primary;
  const escalationModel = models.escalation;
  type T = {
    number: string | null;
    issuedOn: string | null;
    volumeM3: number | null;
    workKind: string;
    addressRaw: string | null;
  };
  const primaryTickets = ((primary as { tickets?: T[] }).tickets ?? []) as T[];
  const escalatedTickets = escalated as T[];

  const tickets = primaryTickets.map((ticket, index) => {
    const pair = escalationAttemptId
      ? matchTicket(ticket, escalatedTickets, index)
      : undefined;
    const number = mergeField(ticket.number, pair?.number);
    const issuedOn = mergeField(ticket.issuedOn, pair?.issuedOn);
    const volume = mergeField(ticket.volumeM3, pair?.volumeM3);
    const needsReview = [
      ...(number.review ? ['number'] : []),
      ...(issuedOn.review ? ['issuedOn'] : []),
      ...(volume.review ? ['volumeM3'] : []),
    ];
    // Значение кандидата — строка при любом поле, включая дату и объём: кандидат это то, что
    // модель ПРОЧИТАЛА, а не то, что портал принял, и приведение к числу стёрло бы половину
    // вопроса ещё до показа («28» и «2 8» различаются ровно там, где человек выбирает верное).
    const candidates: { field: string; value: string; model: string }[] = [];
    const addCandidates = (field: string, pairValues: [unknown, unknown] | null): void => {
      if (!pairValues) return;
      candidates.push({ field, value: String(pairValues[0]), model: primaryModel });
      candidates.push({ field, value: String(pairValues[1]), model: escalationModel });
    };
    addCandidates('number', number.candidates);
    addCandidates('issuedOn', issuedOn.candidates);
    addCandidates('volumeM3', volume.candidates);
    return {
      number: number.value,
      issuedOn: issuedOn.value,
      volumeM3: volume.value,
      workKind: ticket.workKind,
      addressRaw: ticket.addressRaw,
      needsReview,
      candidates,
    };
  });

  return {
    pageNo: page.pageNo,
    sha256: page.sha256,
    primaryAttemptId,
    escalationAttemptId,
    tickets,
  };
}
