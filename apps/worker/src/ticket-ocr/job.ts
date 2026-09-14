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
 * | T2 | повторная проверка, **перепроверка якоря**, запись страниц и талонов, файловый статус | `waste_requests FOR UPDATE` |
 *
 * **Что здесь делает якорь** (ADR 0166, Р5–Р8). Дата талона выбирается не только по ответу модели:
 * век двузначного года и решение «звать ли старшую модель» зависят от даты ЗАЯВКИ. Поэтому вместе
 * со связью читается якорь — фактический день вывоза или плановая дата, — и снимок берётся из
 * последней проверки перед первым вызовом. Человек правит заявку и во время вызова, так что в T2
 * якорь читается заново под общим замком: обе ступени нормализуются и сливаются по актуальному
 * значению прямо там. Отсрочка (`deferUntil` с причиной `anchor_changed`) берётся ровно тогда,
 * когда новому якорю нужен проход, которого не делали, — и у неё свой потолок.
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

import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  dateKeySpan,
  moscowDateKeyOf,
  resolveWasteTicketIssuedOn,
  WASTE_TICKET_FIELDS,
  wasteTicketNumberFuzzy,
  wasteTicketNumberKey,
  type WasteTicketField,
} from '@technic/contracts';
import { prepareTicketFile, PREPROCESSING_VERSION } from './preprocess';
import { TicketFileError } from './errors';
import { markReviewStale, markReviewStaleWithNeighbors } from './review-state';
import { attemptCacheKey, PROXY_CHOOSES_MODEL } from './engine/keys';
import type { AttemptMeta, PageImage, RecognitionEngine, RecognitionFailure } from './engine/types';
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
  /**
   * Окно вокруг якоря заявки, за которым дата талона становится поводом для второго прохода
   * (`TICKET_OCR_DATE_ANCHOR_DAYS`, ADR 0166 п. 4), и выключатель выбора века
   * (`TICKET_OCR_DATE_YEAR_FROM_ANCHOR`, п. 2).
   *
   * Необязательны здесь по одной причине: подставляет их `index.ts`, и до того, как он это
   * начнёт делать, задача обязана собираться и работать. Умолчания поэтому повторяют
   * `config.ts` до цифры — иначе воркер, которому забыли передать порог, вёл бы себя не так, как
   * написано в `.env.example`.
   */
  dateAnchorDays?: number;
  dateYearFromAnchor?: boolean;
}

export interface TicketJobPayload {
  requestId: string;
  fileId: string;
  /** Принудительный проход мимо кэша — кнопка «перераспознать» при тех же версиях (Р13). */
  forced?: boolean;
  /**
   * Сколько раз задачу уже откладывали из-за смены якоря заявки (Р8, ADR 0166 п. 4). Хранить
   * счётчик негде, кроме полезной нагрузки: отсрочка не тратит `attempts`, и потолка ей иначе
   * никто не ставит. Приращение делает `deferJob` тем же ownership-checked `UPDATE`, который
   * переводит задачу в `pending`, — отдельный запрос разъехался бы со статусом ровно тогда,
   * когда аренда потеряна.
   */
  anchorDeferrals?: number;
}

/**
 * Исход задачи для цикла воркера. Перенос бывает двух пород, и они считаются по-разному:
 * `Retry-After` прокси (Р5) идёт без причины, а `anchor_changed` — это правка заявки под
 * работающим разбором, и только её считает потолок `MAX_ANCHOR_DEFERRALS` (Р8). Смешай их — и
 * занятый прокси съедал бы лимит, заведённый против правок заявки.
 */
export type TicketJobResult = { deferUntil: Date; reason?: 'anchor_changed' } | void;

/**
 * Сколько раз задачу можно отложить из-за смены якоря, прежде чем страница будет записана тем,
 * что есть (Р8, ADR 0166 п. 4). Потолок — уступка, а не решение: заявку, которую правят третий
 * раз подряд, дешевле показать человеку, чем догонять её якорь платными вызовами.
 */
export const MAX_ANCHOR_DEFERRALS = 3;

/**
 * Срок отсрочки при смене якоря. Секунды, а не минуты: якорь сменил человек, который прямо сейчас
 * дозаполняет заявку, и ждать его правки часами незачем. Меньше `WORKER_POLL_INTERVAL_MS` (5 с)
 * ставить бессмысленно — очередь всё равно просыпается своим шагом, — а десять секунд дают
 * человеку дописать начатое и укладывают все три отсрочки в полминуты, то есть заметно меньше
 * одного вызова модели.
 */
const ANCHOR_DEFER_MS = 10_000;

/**
 * Связь файла с заявкой в том виде, в каком её проверяют все три раза. Версии заявки здесь нет
 * намеренно (Р11): правку выполненной заявки разрешена не только площадке, и она поднимает
 * `version` — сверка по ней молча отменяла бы распознавание после смены комментария.
 */
interface LinkState {
  linked: boolean;
  objectKey: string;
  contentType: string;
  /**
   * Якорь даты талона: календарный день `YYYY-MM-DD`, от которого считается век двузначного года
   * и расстояние до окна эскалации (ADR 0166, п. 2). Пусто ровно тогда, когда связи нет:
   * `delivery_at` в базе `NOT NULL`, поэтому у связанной заявки якорь есть всегда.
   */
  anchor: string;
}

/**
 * Связь и якорь одним запросом — отдельного обращения к базе якорь не добавляет (Р8).
 *
 * Фактический день вывоза берётся ТОЛЬКО при `removed_on_source = 'entered'`: у закрытий старше
 * колонки дня нет вовсе, и подстановка плановой даты выдала бы предположение за факт — то же
 * правило, по которому строит замечание сверка (`waste-ticket-checks.ts`).
 *
 * `f.quarantined_at IS NULL` здесь — КАРАНТИН (план
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р6, п. 4), и для задачи он значит
 * больше, чем отказ в доступе: дальше по шагам скан СКАЧИВАЕТСЯ и УХОДИТ НАРУЖУ, в чужой
 * распознаватель через прокси. Карантин ставят именно по такому случаю — в заявку попали чужие
 * персональные данные, — и повторная отправка того же скана наружу сделала бы инцидент
 * неустранимым: отозвать уже переданное нельзя ничем.
 *
 * Условие стоит в этом запросе, а не у точки скачивания, потому что ЭТОТ запрос и есть все три
 * проверки связи разом (T0 до скачивания, проверка до первого платного вызова и T2 под общим
 * замком): запертый файл читается задачей как отвязанный, и задача становится no-op на первом же
 * шаге — до скачивания. Постановку задачи карантин отбивает на своей стороне
 * (`enqueueTicketRecognition`), но проверок обязано быть две: задачу могли поставить ДО карантина, и
 * она уже лежит в очереди.
 */
const LINK_SQL = `
  SELECT f.object_key, f.content_type, wr.delivery_at,
         CASE WHEN c.removed_on_source = 'entered' THEN to_char(c.removed_on, 'YYYY-MM-DD') END
           AS removed_on
    FROM request_files rf
    JOIN files f ON f.id = rf.file_id
    JOIN waste_requests wr ON wr.id = rf.request_id
    LEFT JOIN waste_request_completions c ON c.request_id = wr.id
   WHERE rf.request_id = $1
     AND rf.file_id = $2
     AND rf.kind = 'ticket'
     AND f.deleted_at IS NULL
     AND f.quarantined_at IS NULL
     AND wr.deleted_at IS NULL
     AND wr.status = 'done'`;

async function readLink(client: JobClient, requestId: string, fileId: string): Promise<LinkState> {
  const res = await client.query<{
    object_key: string;
    content_type: string;
    delivery_at: Date;
    removed_on: string | null;
  }>(LINK_SQL, [requestId, fileId]);
  const row = res.rows[0];
  return {
    linked: !!row,
    objectKey: row?.object_key ?? '',
    contentType: row?.content_type ?? '',
    // Плановая дата приводится к московскому дню ТОЙ ЖЕ функцией, что и в сверке
    // (`moscowDateKeyOf`), а не выражением в SQL: правило должно совпадать до дня, иначе воркер
    // выберет один век, а замечание предложит заменить год ровно на тот, который сам и поставил.
    // Фактический день — уже `date`, и приводить его не к чему.
    anchor: row ? (row.removed_on ?? moscowDateKeyOf(row.delivery_at)) : '',
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

/**
 * Канонический uuid. Номер задачи обычно им и является, но проверять это дешевле, чем узнавать о
 * несовпадении типов из упавшей вставки.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // Файловая строка — уже изменение значка разбора: у заявки появилась бумага, о которой кому-то
    // отвечать. Считать числа воркер не умеет (правило сверки живёт в API), поэтому он объявляет
    // состояние устаревшим — пересчитает ближайшее чтение реестра (Р20). Пометка идёт в ЭТОЙ
    // транзакции и под уже взятым `lockRequest`: разойдись они, окно между записью строки и
    // пометкой оставило бы значок с прежними числами до следующей мутации, то есть надолго.
    await markReviewStale(client, [payload.requestId]);
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
    // Отказ — такое же число значка, как талон: нечитаемый файл считается отдельно (`failures`), и
    // без пометки заявка выглядела бы разобранной, хотя её бумагу не прочитал никто (Р20).
    await markReviewStale(client, [payload.requestId]);
  });
  // Отказ по файлу — то, что человек увидит в карточке; в журнале он нужен той же строкой, чтобы
  // «у нас талон не читается» разбиралось без захода в базу.
  deps.log(
    {
      requestId: payload.requestId,
      fileId: payload.fileId,
      code: err.code,
      errorClass: err.errorClass,
      errorScope: err.errorScope,
    },
    `Распознавание талона: файл отвергнут — ${err.reason}`,
  );
}

// ── T1: одна страница ──

/**
 * Материализованная попытка одной ступени каскада (Р6, ADR 0166 п. 3).
 *
 * Ключевое здесь — чего в типе НЕТ: следа того, откуда взялся ответ. Свежий `outcome` и
 * сохранённые в строке попытки `raw` с `model_reported` дают одну и ту же величину, и дальше по
 * коду обе ступени обрабатываются одинаково. Прежде этого не было, и стоило это настоящего
 * дефекта: ветка эскалации проверяла `outcome`, которого у попадания в кэш нет вовсе, — страница,
 * уже прочитанная двумя моделями, при повторе задачи теряла старшую.
 */
interface StageResult {
  attemptId: string;
  /** Сырой ответ модели: `outcome.response` или `raw` попытки. Якорь-независим — см. Р6. */
  raw: { tickets?: unknown; unreadable?: unknown };
  /** Фактическая модель (`model_reported`, Р7): пусто, когда её не назвали ни ответ, ни попытка. */
  modelReported: string;
  /** Заказанный слаг ступени — им подписывается вторая ступень, когда фактическая неизвестна. */
  model: string;
  /** Ответ отдал кэш попыток: вызова наружу на ЭТОЙ ступени не было (§2.1 плана аудита). */
  fromCache: boolean;
}

/**
 * Что вернула ступень: ответ (свежий или из кэша) либо настоящий отказ свежего вызова. Источник
 * ответа веткой НЕ является — он спрятан внутри `StageResult` признаком `fromCache` (Р6).
 *
 * `called` есть у обеих ветвей потому, что по нему, а не по составу итога, считается
 * `PageResult.cacheHit` (Р6): свежая эскалация, завершившаяся отказом, в результат не входит, а
 * оплачена, и признак «денег не потратили» после неё был бы неправдой.
 */
type StageAttempt =
  | { status: 'read'; result: StageResult; called: boolean }
  /** Отказ: с ним разбирается вызывающий — терминальный, `Retry-After` или бросок наверх. */
  | { status: 'failed'; failure: RecognitionFailure; meta: AttemptMeta; called: true };

/**
 * Распознаёт страницу и возвращает попытку. Кэш и advisory lock — в одной транзакции с вызовом:
 * замок держит **ключ кэша**, а не заявку, поэтому два воркера на одном листе выстраиваются в
 * очередь, и второй забирает готовый результат вместо второго платного вызова (Р12).
 *
 * Оговорка, которая стоит денег: дедуп прокси схлопывает только **конкурентные** запросы. Повтор
 * задачи через минуту — новый вызов, и его оплатят. От повторной оплаты последовательных попыток
 * спасает этот кэш, и только если предыдущая попытка успела записаться как `done`.
 *
 * Якорь заявки в ключ кэша НЕ входит и входить не может (Р6): содержимое кэша — сырой ответ
 * модели, величина якорь-независимая, а повторно использованная попытка просто нормализуется
 * заново. Обратное сделало бы одну и ту же страницу завтра другой работой.
 */
async function recognizePage(
  deps: TicketJobDeps,
  page: PageImage,
  opts: { model: string; forced: boolean; jobId: string },
): Promise<StageAttempt> {
  const cacheKey = attemptCacheKey({
    pageSha256: page.sha256,
    engine: deps.engine.kind,
    model: opts.model,
    promptVersion: PROMPT_VERSION,
    preprocessingVersion: PREPROCESSING_VERSION,
  });

  // Вариант A (`TICKET_OCR_MODEL=proxy` — слаг выбирает оператор): кэш ВЫКЛЮЧЕН (Р7). Заглушка
  // `proxy` стоит в ключе вместо модели, а за ней в разное время может отработать разная — и
  // склеенные под одним ключом ответы сделали бы метрики качества, привязанные к модели, выдумкой.
  // Это стоит повторных вызовов, и это осознанная цена варианта, в котором мы не выбираем модель.
  const cacheable = opts.model !== PROXY_CHOOSES_MODEL;

  return inTransaction(deps.pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryKey(cacheKey)]);

    if (!opts.forced && cacheable) {
      // `raw` и `model_reported` читаются ЗДЕСЬ, вместе с попаданием, а не отдельной транзакцией
      // выше по стеку (Р6): материализация у обеих ступеней одна, и второго места, где ответ
      // достают из попытки, быть не должно — именно оно и разъехалось с веткой эскалации.
      const hit = await client.query<{ id: string; raw: unknown; model_reported: string }>(
        `SELECT id, raw, model_reported FROM waste_ticket_recognition_attempts
          WHERE page_sha256 = $1 AND engine = $2 AND model = $3
            AND prompt_version = $4 AND preprocessing_version = $5
            AND status = 'done' AND NOT forced
          LIMIT 1`,
        [page.sha256, deps.engine.kind, opts.model, PROMPT_VERSION, PREPROCESSING_VERSION],
      );
      const row = hit.rows[0];
      if (row) {
        // Кэш — единственное место, где вызова не было, а результат есть. В журнале это видно
        // отдельной строкой: иначе «страница разобрана за 20 мс» выглядит подозрительно.
        deps.log(
          { pageSha256: page.sha256.slice(0, 12), model: opts.model, attemptId: row.id },
          'Распознавание талона: страница взята из кэша попыток',
        );
        return {
          status: 'read',
          result: {
            attemptId: row.id,
            // Форма `raw` — обещание схемы контракта, а не факт: писала его прошлая версия кода.
            raw: (row.raw ?? {}) as { tickets?: unknown; unreadable?: unknown },
            // Вызова не было, значит нет и `meta` ответа: фактическую модель называет сама
            // попытка. Возьми мы заказанный слаг — метрика приписала бы чтение не тому, кто
            // читал (Р7). Пусто, когда не знает и попытка: при варианте A в колонке фактической
            // модели стояло бы слово `proxy`, то есть выдумка вместо ответа «неизвестно».
            modelReported: row.model_reported ?? '',
            model: opts.model,
            fromCache: true,
          },
          called: false,
        };
      }
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
        // Версии берутся из НАШИХ констант, а не из ответа движка, хотя движок их и сообщает.
        // Ключ кэша строится здесь же и по ним — разойдись запись с чтением хоть на единицу, и
        // кэш перестал бы находить собственные записи: каждый второй проход шёл бы в модель и
        // падал бы на уникальности. Ровно это и случилось при первой же смене версии промпта.
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
    const attemptId = inserted.rows[0]!.id;
    if (outcome.status === 'failed') {
      return { status: 'failed', failure: outcome.failure, meta: outcome.meta, called: true };
    }
    return {
      status: 'read',
      result: {
        attemptId,
        raw: outcome.response,
        modelReported: outcome.meta.modelReported,
        model: opts.model,
        fromCache: false,
      },
      called: true,
    };
  });
}

// ── Дата: якорь, нормализация прохода (Р5, Р6) ──

/**
 * Всё, что нужно знать о дате, чтобы разобрать ответ модели. Величина **контекстная**: якорь
 * меняет человек, правя заявку, и один и тот же сырой ответ по разным якорям даёт разные даты.
 * Поэтому она не хранится внутри материализованной попытки, а передаётся туда, где ответ
 * превращается в талон, — и передаётся в T2 второй раз, уже с перечитанным под замком якорем.
 */
interface AnchorContext {
  /** Календарный день `YYYY-MM-DD`, к которому привязана заявка (ADR 0166, п. 2). */
  anchor: string;
  /** `TICKET_OCR_DATE_YEAR_FROM_ANCHOR`: выбирать ли век по якорю. */
  yearFromAnchor: boolean;
  /** `TICKET_OCR_DATE_ANCHOR_DAYS`: за этим окном дата становится поводом для второго прохода. */
  dateAnchorDays: number;
}

/** Умолчания повторяют `config.ts` (см. оговорку у `TicketJobDeps`). */
function anchorContextOf(deps: TicketJobDeps, anchor: string): AnchorContext {
  return {
    anchor,
    yearFromAnchor: deps.dateYearFromAnchor ?? true,
    dateAnchorDays: deps.dateAnchorDays ?? 30,
  };
}

/** Расстояние между календарными днями в сутках — тем же счётом, каким его считает сверка. */
function daysApart(a: string, b: string): number {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return Math.max(dateKeySpan(from, to) - 1, 0);
}

/** Талон в ответе модели, как он лежит в `raw`: и у свежего ответа, и у попытки из кэша. */
interface RawStageTicket {
  number: string | null;
  issuedOn: string | null;
  issuedOnRaw?: unknown;
  volumeM3: number | null;
  workKind: string;
  addressRaw: string | null;
}

/**
 * Талон ОДНОГО прохода после нормализации даты (Р6, ADR 0166 п. 3). Сюда попадает уже выбранная
 * дата, а не догадка модели о веке, — и только поэтому два прохода, одинаково прочитавшие
 * «17.08.25», сравниваются как одинаковые, а не спорят из-за 1925 против 2025.
 */
interface StageTicket {
  number: string | null;
  issuedOn: string | null;
  /** Транскрипция графы «Дата» — её же записывает талон (Р12). Нормализация её не трогает. */
  issuedOnRaw: string | null;
  volumeM3: number | null;
  workKind: string;
  addressRaw: string | null;
  /**
   * `issuedOn` модели разошёлся с её же транскрипцией по дню или месяцу. Молча выбрать одну из
   * двух дат нельзя — обе прочитала одна модель, — и расхождение становится четвёртым поводом
   * для второго прохода (Р7, ADR 0166 п. 4).
   */
  dateConflict: boolean;
}

/**
 * Талоны прохода с нормализованной датой. Зовётся сразу после материализации попытки и ДО
 * сопоставления и слияния — одинаково для свежего ответа и для взятого из кэша (Р6).
 *
 * `raw` попытки при этом НЕ переписывается: сырой ответ остаётся якорь-независимым содержимым
 * кэша, и завтрашний повтор по изменившемуся якорю нормализует его заново.
 */
function stageTickets(raw: { tickets?: unknown }, ctx: AnchorContext): StageTicket[] {
  // Форма талона в ответе — обещание схемы контракта, а не факт: из кэша сюда приходит `jsonb`,
  // который писала прошлая версия кода.
  const list = (Array.isArray(raw.tickets) ? raw.tickets : []) as RawStageTicket[];
  return list.map((ticket) => {
    // У попыток, записанных до промпта версии 4, транскрипции нет вовсе. Это не пустота ответа, а
    // отсутствие вопроса — и правило разбора её так и понимает: нет написания, остаётся `issuedOn`.
    const issuedOnRaw = typeof ticket.issuedOnRaw === 'string' ? ticket.issuedOnRaw : null;
    const choice = resolveWasteTicketIssuedOn(
      { issuedOn: ticket.issuedOn ?? null, issuedOnRaw },
      ctx.anchor,
      { yearFromAnchor: ctx.yearFromAnchor },
    );
    return {
      number: ticket.number ?? null,
      issuedOn: choice.issuedOn,
      issuedOnRaw,
      volumeM3: ticket.volumeM3 ?? null,
      workKind: ticket.workKind,
      addressRaw: ticket.addressRaw ?? null,
      dateConflict: choice.conflict,
    };
  });
}

// ── Каскад по полям (Р14, Р7) ──

/**
 * Поле, требующее второго прохода: пустое, названное нечитаемым или не прошедшее проверку формы.
 *
 * У даты поводов четыре (Р7, ADR 0166 п. 4), и два последних — новые. Противоречие транскрипции и
 * `issuedOn` по дню или месяцу означает, что модель прочитала графу двумя способами и способы
 * разошлись; выход за окно якоря — что бумагу принесли на месяц позже плановой даты, чего не
 * бывает. Ни то ни другое не делает дату спорной само по себе (Р9): это повод посмотреть
 * внимательнее вторым голосом, а не утверждение, что прочитанное неверно.
 */
function fieldsNeedingEscalation(
  ticket: StageTicket,
  unreadable: readonly string[],
  ctx: AnchorContext,
): string[] {
  const need: string[] = [];
  if (!ticket.number || unreadable.includes('number')) need.push('number');
  if (
    !ticket.issuedOn ||
    unreadable.includes('issuedOn') ||
    ticket.dateConflict ||
    daysApart(ticket.issuedOn, ctx.anchor) > ctx.dateAnchorDays
  ) {
    need.push('issuedOn');
  }
  // У простоя объёма нет законно — просить старшую модель перечитать пустоту незачем.
  const volumeExpected = ticket.workKind === 'removal';
  if (volumeExpected && (ticket.volumeM3 == null || unreadable.includes('volumeM3'))) {
    need.push('volumeM3');
  }
  return need;
}

/**
 * Нужен ли странице второй проход по ЭТОМУ якорю. Решение принимается по первому проходу — и
 * одинаково для свежего и для взятого из кэша (Р7): ветка кэша не имеет права завершать обработку
 * раньше этой проверки, иначе временный отказ старшей модели или её позднее включение навсегда
 * оставили бы страницу с одним проходом — при повторе задача снова попала бы в кэш и снова
 * остановилась.
 *
 * Зовётся дважды: в разборе — по снимку якоря, и в T2 — по перечитанному под замком (Р8).
 */
function pageNeedsSecond(primary: StageResult, ctx: AnchorContext): boolean {
  const unreadable = readUnreadable(primary.raw.unreadable);
  return stageTickets(primary.raw, ctx).some(
    (ticket) => fieldsNeedingEscalation(ticket, unreadable, ctx).length > 0,
  );
}

/**
 * Сопоставление талонов между проходами (Р13). По позиции — только последним резервом: порядок
 * массива модель менять вправе, и сопоставление по `seq` показало бы предложение от одного талона
 * рядом с другим. Сперва номер (он напечатан типографски и читается надёжнее всего), затем пара
 * «дата + объём», и лишь потом позиция.
 */
function matchTicket<
  T extends { number: string | null; issuedOn: string | null; volumeM3: number | null },
>(target: T, candidates: readonly T[], index: number): T | undefined {
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
 * Ступень каскада, давшая итоговое значение поля (`source_stage`, §2.1 плана аудита):
 * `merged` — оба прохода прочитали одно и то же, `escalation` — первый промолчал, прочитал второй.
 */
type FieldStage = 'primary' | 'escalation' | 'merged';

/**
 * Слияние двух проходов по одному полю. Расхождение — **не ответ**: поле остаётся пустым, а имя
 * уходит в `needs_review_fields`, и человек видит двух кандидатов. Старшая модель ошибается реже,
 * но ошибается, и выбирать за человека молча портал не берётся (Р14).
 *
 * Вместе со значением возвращается и ступень, его давшая. По одному итогу она невосстановима, а
 * без неё «вторая ступень заполнила пустое поле» и «обе прочитали одинаково» — одно и то же число,
 * и вопрос «окупается ли эскалация» остаётся без ответа (§2.1 плана аудита). Ступени нет там, где
 * нет и значения: спор портал не разрешил, а пустоту не прочитала ни одна ступень.
 */
function mergeField<V>(
  primary: V | null,
  escalated: V | null | undefined,
): { value: V | null; review: boolean; candidates: [V, V] | null; stage: FieldStage | null } {
  if (escalated === undefined) {
    return {
      value: primary,
      review: false,
      candidates: null,
      stage: primary === null || primary === undefined ? null : 'primary',
    };
  }
  if (primary === null || primary === undefined) {
    return {
      value: escalated ?? null,
      review: false,
      candidates: null,
      stage: escalated === null ? null : 'escalation',
    };
  }
  if (escalated === null)
    return { value: primary, review: false, candidates: null, stage: 'primary' };
  if (primary === escalated) {
    return { value: primary, review: false, candidates: null, stage: 'merged' };
  }
  // Оба прочитанных значения сохраняются рядом с талоном: без них вопрос «поле спорное» отправляет
  // человека к скану вслепую, а «первая прочитала 20, вторая 28» решается взглядом (Р14).
  return { value: null, review: true, candidates: [primary, escalated], stage: null };
}

// ── T2: запись результата ──

/**
 * Что случилось с полем при слиянии проходов — то, чего по итоговому значению уже не видно
 * (§2.1 плана аудита). Значения обеих ступеней хранятся текстом и обе: без них нельзя сказать,
 * какая ступень была права, а спор читается как «поле пустое» без всякого объяснения.
 */
interface FieldReading {
  stage: FieldStage | null;
  primaryValue: string | null;
  escalationValue: string | null;
}

interface PageResult {
  pageNo: number;
  sha256: string;
  primaryAttemptId: string;
  escalationAttemptId: string | null;
  /** Фактическая модель первого прохода (`model_reported`, Р7): её и записывает журнал. */
  modelReported: string;
  /** Фактическая модель второй ступени; пусто, когда её чтение в итог не вошло. */
  escalationModelReported: string;
  /**
   * Поля, названные моделью нечитаемыми. Свойство СТРАНИЦЫ, а не талона — так устроен контракт
   * ответа, и при двух талонах на листе признак ложится на оба.
   */
  unreadable: readonly WasteTicketField[];
  /**
   * При разборе страницы НЕ БЫЛО НИ ОДНОГО свежего вызова наружу (Р6, §2.1 плана аудита).
   *
   * Определение буквальное, и «все участвовавшие в итоге ступени пришли из кэша» тут не годится:
   * свежая эскалация, завершившаяся отказом, в результат не входит, а вызов состоялся и оплачен.
   * Считай мы по составу итога — расход занижался бы и в журнале наблюдений, и в итоговой строке.
   */
  cacheHit: boolean;
  tickets: {
    number: string | null;
    issuedOn: string | null;
    /** Транскрипция графы «Дата», выбранная по правилу Р12: чья именно — см. `issuedOnRawOf`. */
    issuedOnRaw: string;
    volumeM3: number | null;
    workKind: string;
    addressRaw: string | null;
    needsReview: string[];
    /** Что прочитал каждый проход по спорному полю — снимком, для экрана разбора (Р14). */
    candidates: { field: string; value: string; model: string }[];
    /** Чем прочитано каждое из пяти полей — из этого собирается наблюдение журнала (§2.1). */
    readings: Record<WasteTicketField, FieldReading>;
  }[];
}

/**
 * Страница с сохранёнными сырыми ступенями (Р8). Именно она, а не готовый `PageResult`, доезжает
 * до T2: под замком якорь читается заново, и обе ступени нормализуются и сливаются по нему ещё
 * раз. Пересборка бесплатна — нормализация и слияние чистые функции без обращений наружу.
 */
interface PageDraft {
  page: PageImage & { pageNo: number };
  primary: StageResult;
  /** Вторая ступень, если её ответ получен: свежий или из кэша (Р7). */
  escalation: StageResult | null;
  /**
   * Второй проход в этом разборе **был предпринят** — включая свежий, завершившийся отказом.
   * Это не то же самое, что «ступень есть в результате» (Р8): отказавшая эскалация состоялась и
   * оплачена, и повторять её из-за смены якоря нельзя — иначе каждая правка заявки оплачивала бы
   * отказавшую модель заново.
   */
  escalationAttempted: boolean;
  /** Ни одного свежего вызова наружу на этой странице (Р6). */
  cacheHit: boolean;
}

/**
 * Исход записи результата (Р8, ADR 0166 п. 4). Три, а не два: прежде `saveResult` возвращал
 * `boolean`, и «не записал» означало единственный случай — отвязку файла. Теперь их два разных, и
 * путать их нельзя: отвязка — успешное завершение (работать больше не над чем), а смена якоря —
 * незаконченная работа, и завершись задача как выполненная, талоны так и не появились бы.
 */
type SaveOutcome = 'written' | 'unlinked' | 'anchor_changed';

/**
 * Пишет страницы и талоны — под общим замком и после третьей, обязательной проверки связи. Всё,
 * что записано здесь, принадлежит заявке и уйдёт при её откате (Р22); попытки, наоборот, остаются:
 * они принадлежат содержимому страницы и служат кэшем.
 *
 * Талон заводится `unconfirmed`: распознанное — предложение, а не факт. Номер занимает место в
 * реестре только после подтверждения человеком, поэтому `operator_counterparty_id` здесь **не
 * заполняется** — снимок оператора берётся в момент подтверждения (Р17).
 *
 * Здесь же перепроверяется якорь (Р8): между снимком и этой транзакцией лежат внешние вызовы
 * длиной до двух минут, и за это время человек успевает ввести фактический день вывоза или
 * сдвинуть плановую дату.
 */
async function saveResult(
  deps: TicketJobDeps,
  payload: TicketJobPayload,
  prepared: { totalPages: number; skippedPages: number },
  drafts: readonly PageDraft[],
  recognitionRunId: string,
  snapshot: AnchorContext,
): Promise<SaveOutcome> {
  return inTransaction(deps.pool, async (client) => {
    await lockRequest(client, payload.requestId);
    const link = await readLink(client, payload.requestId, payload.fileId);
    if (!link.linked) {
      deps.log(
        { requestId: payload.requestId, fileId: payload.fileId },
        'Распознавание завершилось в пустоту: заявку откатили или файл отвязали — результат не пишем',
      );
      return 'unlinked';
    }

    // Якорь под замком. Совпал со снимком — пишем по нему же; разошёлся — результат по старому
    // контексту не годится, но откладывать задачу нужно далеко не всегда (Р8).
    let ctx = snapshot;
    if (link.anchor !== snapshot.anchor) {
      ctx = { ...snapshot, anchor: link.anchor };
      const canEscalate = !!deps.escalationModel && deps.escalationModel !== deps.model;
      // Отсрочка берётся ровно в одном случае: новому якорю нужен проход, которого НЕ ДЕЛАЛИ.
      // Всё остальное — пересчёт: сырьё обеих ступеней уже здесь, и слияние по новому якорю
      // стоит столько же, сколько по старому.
      const missing = drafts.some(
        (draft) => !draft.escalationAttempted && canEscalate && pageNeedsSecond(draft.primary, ctx),
      );
      const deferrals = payload.anchorDeferrals ?? 0;
      if (missing && deferrals < MAX_ANCHOR_DEFERRALS) {
        deps.log(
          {
            requestId: payload.requestId,
            fileId: payload.fileId,
            anchor: link.anchor,
            previousAnchor: snapshot.anchor,
            anchorDeferrals: deferrals,
          },
          'Якорь заявки изменился, а новому нужен непредпринятый второй проход: задача отложена',
        );
        return 'anchor_changed';
      }
      // Обе оставшиеся ветки пишут результат, и обе — новые: первые недели по ним смотрят, часто
      // ли заявку правят под работающим разбором и как дорого это обходится (ADR 0166,
      // последствия). Строка одна на смену якоря, а не на страницу: заявку правят целиком.
      deps.log(
        {
          requestId: payload.requestId,
          fileId: payload.fileId,
          anchor: link.anchor,
          previousAnchor: snapshot.anchor,
          anchorDeferrals: deferrals,
        },
        missing
          ? // Потолок исчерпан — пишем тем, что есть, без ступени, которой требует новый якорь.
            // Это СОЗНАТЕЛЬНАЯ УСТУПКА (Р8): у такого талона может остаться дата, которую второй
            // проход прочитал бы иначе, и обещать, что её кто-то поймает, нельзя — сверка молчит,
            // когда значение совпало с якорем, даже если оно противоречит транскрипции по дню.
            // Гоняться за якорем, который правят третий раз подряд, дороже, чем показать талон.
            'Потолок отсрочек по смене якоря исчерпан: страница пишется без недостающей ступени'
          : 'Якорь заявки изменился: результат пересчитан по новому якорю и записан тут же',
      );
    }
    const pages = drafts.map((draft) => toPageResult(draft, ctx));

    // Ключи для поиска соседей собираются в ДВА захода, и первый из них — здесь, до единой записи.
    // Соседа задевает не только то, что проход запишет, но и то, что он затрёт: перечитывание
    // файла меняет номер нетронутого талона с A на B, и заявка, где предъявлен A, остаётся с
    // замечанием о дубле, которого больше нет, — да ещё и со `stale = false`, то есть врёт до
    // собственной следующей мутации. Поэтому метятся соседи и по старому, и по новому значению
    // (Р12), а прочитать старое можно только сейчас: после `UPDATE` его уже нигде нет.
    const neighborKeys = {
      numberKeys: [] as string[],
      numberFuzzy: [] as string[],
      pageSha256: [] as string[],
    };
    const previousTickets = await client.query<{ number_key: string; number_fuzzy: string }>(
      'SELECT number_key, number_fuzzy FROM waste_tickets WHERE request_id = $1',
      [payload.requestId],
    );
    for (const row of previousTickets.rows) {
      neighborKeys.numberKeys.push(row.number_key);
      neighborKeys.numberFuzzy.push(row.number_fuzzy);
    }
    // Страницы берутся по заявке, а не через её талоны: лист, на котором модель не нашла ни одного
    // талона, остаётся поводом для замечания о повторе скана — совпал он с чужим или нет, решает
    // сверка, а не эта выборка.
    const previousPages = await client.query<{ page_sha256: string }>(
      'SELECT page_sha256 FROM waste_ticket_pages WHERE request_id = $1',
      [payload.requestId],
    );
    for (const row of previousPages.rows) {
      neighborKeys.pageSha256.push(row.page_sha256);
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
          // Транскрипция графы (Р12, ADR 0166 п. 7). Пишется и при спорной дате — она нужна для
          // разбора; решение «не показывать подпись до разрешения спора» принимает портал, а не
          // запись: колонка отвечает на вопрос «что модель прочитала в графе», и у спорного
          // талона ответ на него есть.
          ticket.issuedOnRaw,
        ];
        // Строка, к которой человек не прикасался, переписывается новым проходом целиком: она и
        // была предложением машины, а не решением. Тронутая — нет (Р13): подтверждённая занимает
        // номер, ручная написана человеком, правленая исправлена им же, и перезапись стёрла бы
        // работу, ради которой кнопку «перераспознать» и нажимают.
        const written = await client.query<{ id: string }>(
          `INSERT INTO waste_tickets
             (request_id, page_id, seq, primary_attempt_id, escalation_attempt_id,
              number_raw, number_key, number_fuzzy, issued_on, volume_m3, work_kind,
              address_raw, origin, status, needs_review_fields, candidates, issued_on_raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ocr','unconfirmed',$13::text[],
                   $14::jsonb,$15)
           ON CONFLICT (page_id, seq) WHERE page_id IS NOT NULL AND origin = 'ocr'
           DO UPDATE SET primary_attempt_id = EXCLUDED.primary_attempt_id,
                         escalation_attempt_id = EXCLUDED.escalation_attempt_id,
                         number_raw = EXCLUDED.number_raw,
                         number_key = EXCLUDED.number_key,
                         number_fuzzy = EXCLUDED.number_fuzzy,
                         issued_on = EXCLUDED.issued_on,
                         issued_on_raw = EXCLUDED.issued_on_raw,
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
        if (written.rows[0]) {
          // Журнал распознавания (Р30, миграции 0206 и 0210): что модель прочитала, что осталось
          // спорным и чем читали. Пишется В ТОЙ ЖЕ транзакции, что и талон: событие о строке,
          // которой нет, — мусор, а строка без события — дыра в метрике.
          await recordRecognizedFields(client, {
            ticketId: written.rows[0].id,
            requestId: payload.requestId,
            fileId: payload.fileId,
            recognitionRunId,
            model: deps.model,
            page,
            ticket,
          });
          continue;
        }

        // Талон тронут человеком — новый проход ложится РЯДОМ предложением (Р13). Снимком, а не
        // ссылкой на попытку: сырьё убирается по сроку (Р31), обе ссылки объявлены `SET NULL`, и
        // предложение обязано читаться и тогда — теряя лишь возможность заглянуть в исходный ответ.
        //
        // Сравнение с талоном делает база и ЗДЕСЬ, под общим замком: `differs` — свойство момента
        // чтения (§1.2.2 плана аудита), а между чтением и решением человек успеет талон поправить.
        // Поле в поле, а не кортежем: исход предложения раскладывается по полям, и «отличалось ли
        // хоть что-то» на этот вопрос не отвечает.
        const current = await client.query<{
          id: string;
          number_differs: boolean;
          issued_on_differs: boolean;
          volume_differs: boolean;
          work_kind_differs: boolean;
          address_differs: boolean;
          issued_on_raw: string;
        }>(
          `SELECT wt.id,
                  wt.number_raw  IS DISTINCT FROM $4          AS number_differs,
                  wt.issued_on   IS DISTINCT FROM $5::date    AS issued_on_differs,
                  wt.volume_m3   IS DISTINCT FROM $6::numeric AS volume_differs,
                  wt.work_kind   IS DISTINCT FROM $7          AS work_kind_differs,
                  wt.address_raw IS DISTINCT FROM $8          AS address_differs,
                  wt.issued_on_raw
             FROM waste_tickets wt
            WHERE wt.page_id = $1 AND wt.seq = $2 AND wt.origin = 'ocr'
              AND wt.request_id = $3`,
          [
            pageId,
            seq,
            payload.requestId,
            raw,
            ticket.issuedOn,
            ticket.volumeM3,
            ticket.workKind,
            ticket.addressRaw ?? '',
          ],
        );
        const target = current.rows[0];
        if (!target) continue;
        const differs: Record<WasteTicketField, boolean> = {
          number: target.number_differs,
          issuedOn: target.issued_on_differs,
          volumeM3: target.volume_differs,
          workKind: target.work_kind_differs,
          addressRaw: target.address_differs,
        };
        // Написание графы «Дата» в `differs` НЕ участвует и своим изменением предложения не
        // заводит (Р12, ADR 0166 п. 7). Оно не шестое поле талона: в `WASTE_TICKET_FIELDS` его
        // нет, домен журнала наблюдений закрыт `CHECK`, и решать по нему человеку в предложении
        // нечего — сравниваются те же пять полей, что и раньше.
        //
        // Но у тронутого талона написание иначе не появится никогда: строку сам проход не
        // переписывает (Р13 ADR 0114), а талон, разобранный до этой волны, живёт с пустой графой,
        // и подпись «OCR в графе» ему не нарисовать даже после явного перераспознавания. Поэтому
        // написание ДОПИСЫВАЕТСЯ, и правило у дописи узкое: только пустое и только при совпавшей
        // дате.
        //
        //   · пустое поле диагностики — не решение человека, и заполнить его новым проходом
        //     законно: Р13 запрещает переписывать РАБОТУ человека, а не дополнять диагностику;
        //   · непустое не трогаем: оно уже относится к той самой дате, что стоит в талоне, и
        //     новое чтение стёрло бы объяснение неизменившейся даты;
        //   · разошлись даты — не пишем вовсе, иначе подпись описывала бы дату, которой в талоне
        //     нет. Этот случай и есть предложение (дата в `differs`), и написание приедет вместе
        //     с его принятием — дата и её написание одна пара.
        //
        // Условие продублировано в самом `UPDATE`: стоит предикат ничего, а читается как
        // обещание — этот запрос не в состоянии переписать непустое написание, чем бы его ни
        // позвали.
        if (!differs.issuedOn && !target.issued_on_raw && ticket.issuedOnRaw) {
          await client.query(
            `UPDATE waste_tickets
                SET issued_on_raw = $2, updated_at = now()
              WHERE id = $1 AND issued_on_raw = ''`,
            [target.id, ticket.issuedOnRaw],
          );
        }
        // Предложение, повторяющее то, что в талоне уже стоит, не заводится: «модель прочитала то
        // же самое» — не новость, а лишняя строка, которую человеку придётся закрывать руками.
        // Наблюдений тоже нет: исход наблюдения предложения приходит решением человека по этому
        // предложению, а решать нечего — пять строк остались бы `pending` навсегда и завышали бы
        // «ждут решения» на каждом повторном проходе (§1.2.2).
        if (!WASTE_TICKET_FIELDS.some((field) => differs[field])) continue;

        // Порядок вынужденный: связи нужен идентификатор наблюдения, а самой связи — строка
        // предложения, которой до вставки нет.
        const observations = await recordRecognizedFields(client, {
          ticketId: target.id,
          requestId: payload.requestId,
          fileId: payload.fileId,
          recognitionRunId,
          model: deps.model,
          page,
          ticket,
        });
        await client.query(
          // Написание графы едет вместе с датой (Р12, миграция 0283): принятие предложения
          // переносит в талон обе величины разом, и подпись «OCR в графе» остаётся объяснением
          // той даты, что после принятия и стоит в талоне. Собственным поводом для предложения
          // написание при этом не является — см. правило дописи выше.
          `INSERT INTO waste_ticket_proposals
             (ticket_id, number_raw, issued_on, issued_on_raw, volume_m3, work_kind, address_raw,
              primary_attempt_id, escalation_attempt_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (ticket_id) DO UPDATE
                  SET number_raw = EXCLUDED.number_raw, issued_on = EXCLUDED.issued_on,
                      issued_on_raw = EXCLUDED.issued_on_raw,
                      volume_m3 = EXCLUDED.volume_m3, work_kind = EXCLUDED.work_kind,
                      address_raw = EXCLUDED.address_raw,
                      primary_attempt_id = EXCLUDED.primary_attempt_id,
                      escalation_attempt_id = EXCLUDED.escalation_attempt_id,
                      created_at = now()`,
          [
            target.id,
            raw,
            ticket.issuedOn,
            ticket.issuedOnRaw,
            ticket.volumeM3,
            ticket.workKind,
            ticket.addressRaw ?? '',
            page.primaryAttemptId,
            page.escalationAttemptId,
          ],
        );
        // Перезапись предложения меняет и чтение, о котором оно: связи прежнего снимаются целиком,
        // иначе исход нового решения приписался бы наблюдениям, которых человек уже не увидит.
        // Сами наблюдения остаются на месте — они случились, и `RESTRICT` их бережёт.
        await client.query(
          'DELETE FROM waste_ticket_proposal_observations WHERE proposal_ticket_id = $1',
          [target.id],
        );
        // Связь по всем пяти полям, а не только по отличавшимся: без строки на совпавшее поле его
        // потом нечем назвать `uninformative` (§1.2.2 плана аудита).
        for (const [field, observationId] of observations) {
          await client.query(
            `INSERT INTO waste_ticket_proposal_observations
               (proposal_ticket_id, field, observation_id, differs)
             VALUES ($1,$2,$3,$4)`,
            [target.id, field, observationId, differs[field]],
          );
        }
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

    // Второй заход: ключи записанного. По ВСЕМ талонам прохода, а не только по строкам, которые
    // запись действительно завела, — тронутый человеком талон новый проход не переписывает, но
    // кладёт рядом предложение (Р13), и вопрос «не тот ли это номер, что у соседа» от этого никуда
    // не девается. Лишняя пометка стоит одного пересчёта, пропущенная — молчащего предупреждения.
    for (const page of pages) {
      neighborKeys.pageSha256.push(page.sha256);
      for (const ticket of page.tickets) {
        const raw = ticket.number ?? '';
        if (!raw) continue;
        neighborKeys.numberKeys.push(wasteTicketNumberKey(raw));
        neighborKeys.numberFuzzy.push(wasteTicketNumberFuzzy(raw));
      }
    }
    // Последней записью транзакции и под тем же замком: к этому моменту записано всё, что меняет
    // числа, — страницы, талоны, файловый статус. Соседи метятся вместе со своей заявкой, потому
    // что замечание о дубле живёт в ЧУЖОЙ карточке: подтверждённый талон этой заявки делает дублем
    // талон заявки Б, и Б узнает об этом, только если её состояние объявлено устаревшим (Р12, Р20).
    // Пустые ключи и повторы отбрасывает сама пометка — старый и новый наборы пересекаются почти
    // всегда, и без этого один и тот же сосед искался бы дважды.
    await markReviewStaleWithNeighbors(client, payload.requestId, neighborKeys);
    return 'written';
  });
}

// ── Задача целиком ──

async function downloadObject(deps: TicketJobDeps, objectKey: string): Promise<Buffer> {
  const res = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: objectKey }));
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
  // Начало работы над файлом. Без этой строки успешный путь молчит целиком: в журнале видны только
  // отказы, и «распознавание не работает» неотличимо от «задача ещё не дошла до очереди».
  deps.log(
    { requestId: payload.requestId, fileId: payload.fileId, jobId, forced: !!payload.forced },
    'Распознавание талона: начало',
  );

  // Разбор как единица работы (§2.1 плана аудита): все наблюдения одного файла помечаются общим
  // идентификатором, и «сколько разборов было» перестаёт считаться эвристикой по времени. Задача
  // на файл ровно одна, поэтому её номер годится сам — он уникален и связывает журнал с очередью.
  // Но задачу зовут и из тестов, и вручную, где номер бывает не uuid, а колонка типизирована
  // строго: тогда идентификатор свой, один на весь вызов.
  const recognitionRunId = UUID_RE.test(jobId) ? jobId : randomUUID();

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

  // Снимок якоря берётся ИМЕННО ЗДЕСЬ — из последней проверки связи перед первым вызовом модели
  // (Р8). Не из T0: между ними лежат скачивание из S3 и рендер PDF, и брать якорь оттуда значило
  // бы начинать расхождение раньше, чем начнётся работа.
  const snapshot = anchorContextOf(deps, stillLinked.anchor);
  const canEscalate = !!deps.escalationModel && deps.escalationModel !== deps.model;

  const drafts: PageDraft[] = [];
  for (const page of prepared.pages) {
    const first = await recognizePage(deps, page, {
      model: deps.model,
      forced: !!payload.forced,
      jobId,
    });

    if (first.status === 'failed') {
      const { failure, meta } = first;
      deps.log(
        {
          requestId: payload.requestId,
          fileId: payload.fileId,
          pageNo: page.pageNo,
          code: failure.code,
          errorClass: failure.errorClass,
          errorScope: failure.errorScope,
          model: meta.model,
          proxyRequestId: meta.proxyRequestId,
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
      // Перенос по сроку прокси идёт БЕЗ причины: счётчик отсрочек заведён против правок заявки,
      // и занятый прокси его тратить не должен (Р8).
      if (failure.retryAfterMs != null)
        return { deferUntil: new Date(Date.now() + failure.retryAfterMs) };
      throw new Error(`${failure.code}: ${failure.message}`);
    }

    // Эскалация: старшая модель перечитывает страницу, если хоть у одного талона поле не прошло
    // проверку. Просить её о том же, что уже прочитано, незачем — она получает то же задание,
    // отличается только модель, и это её единственное отличие (Р14). Решение принимается и по
    // ЗАКЭШИРОВАННОМУ первому проходу (Р7): ветка кэша больше не завершает страницу раньше.
    const primary = first.result;
    if (!canEscalate || !pageNeedsSecond(primary, snapshot)) {
      drafts.push({
        page,
        primary,
        escalation: null,
        escalationAttempted: false,
        cacheHit: !first.called,
      });
      continue;
    }

    const second = await recognizePage(deps, page, {
      model: deps.escalationModel,
      forced: !!payload.forced,
      jobId,
    });
    // Отброшен только настоящий ОТКАЗ эскалации: тогда, как и прежде, пишется первый проход, а
    // второй ступени в наблюдении нет — назови мы её моделью, метрика засчитала бы старшей чтение,
    // которого та не сделала. Попадание же в кэш старшей модели — это СОСТОЯВШИЙСЯ второй проход
    // (Р7), и в слияние он идёт наравне со свежим.
    drafts.push({
      page,
      primary,
      escalation: second.status === 'read' ? second.result : null,
      // Предпринятой считается любая попытка второго прохода, включая неуспешную: она оплачена, и
      // смена якоря не должна оплачивать отказавшую модель заново (Р8).
      escalationAttempted: true,
      cacheHit: !first.called && !second.called,
    });
  }

  const outcome = await saveResult(
    deps,
    payload,
    { totalPages: prepared.totalPages, skippedPages: prepared.skippedPages },
    drafts,
    recognitionRunId,
    snapshot,
  );
  if (outcome === 'anchor_changed') {
    // Причина уходит наверх вместе со сроком: только по ней очередь приращает `anchorDeferrals`
    // (Р8). Задача при этом не проваливается — `deferJob` не тратит `attempts`.
    return { deferUntil: new Date(Date.now() + ANCHOR_DEFER_MS), reason: 'anchor_changed' };
  }
  if (outcome === 'written') {
    // Итог одной строкой: сколько страниц разобрано, сколько талонов нашлось, сколько вызовов
    // ушло мимо кэша. По ней видно и работу, и её цену — а без неё пришлось бы считать попытки
    // запросом к базе.
    deps.log(
      {
        requestId: payload.requestId,
        fileId: payload.fileId,
        jobId,
        pages: drafts.length,
        skippedPages: prepared.skippedPages,
        // Талоны считаются по первому проходу: слияние их число не меняет — оно ходит по талонам
        // первой ступени, — а собирать `PageResult` второй раз ради строки журнала незачем.
        tickets: drafts.reduce(
          (sum, draft) => sum + stageTickets(draft.primary.raw, snapshot).length,
          0,
        ),
        cached: drafts.filter((draft) => draft.cacheHit).length,
      },
      'Распознавание талона: файл разобран',
    );
  }
}

/**
 * Версия сбора, которую реализует этот код (§2.1 плана аудита). Пишется числом, а не берётся
 * дефолтом базы: наблюдение делает второй версией именно код, и, разойдись они, метрика молча
 * зачла бы события, собранные по прежним правилам.
 */
const COLLECTION_VERSION = 2;

/**
 * Прочитано ли поле — по §2.1.1 плана аудита, и только ПОСЛЕ слияния проходов.
 *
 * Без этого признака «не прочитано» пришлось бы угадывать по пустому значению, а пустое значение
 * законно сразу у двух разных случаев: у объёма талона простоя графы нет вовсе, а спорное поле
 * портал очистил сам, не выбирая между двумя состоявшимися чтениями.
 */
function readState(args: {
  field: WasteTicketField;
  value: string | null;
  workKind: string;
  disputed: boolean;
  unreadable: readonly WasteTicketField[];
}): 'read' | 'unreadable' | 'not_applicable' {
  // Спор — это ДВА состоявшихся чтения, разошедшихся в оценке (Р14): читали обе ступени, пустым
  // поле оставил портал. Считать его непрочитанным значило бы списать на немоту модели решение,
  // принятое за неё.
  if (args.disputed) return 'read';
  if (args.value !== null && args.value !== '') return 'read';
  // У простоя объёма нет законно (Р2) — графы на такой бумаге не существует. Но если модель сама
  // назвала объём нечитаемым, это уже немота: назвав её «неприменимо», мы записали бы неудачное
  // чтение в законную пустоту и потеряли бы его из метрики целиком.
  if (
    args.field === 'volumeM3' &&
    args.workKind === 'idle' &&
    !args.unreadable.includes('volumeM3')
  ) {
    return 'not_applicable';
  }
  return 'unreadable';
}

/**
 * Журнал распознавания: пять полей одной строкой каждое (ADR 0114, Р30, миграции 0206 и 0210).
 *
 * Событие `recognized` — знаменатель всей метрики: сколько модель прочитала, из них столько-то
 * потом исправили. Подтверждения при этом не пишутся намеренно (Р31): человек смотрит на
 * подставленное значение и склонен согласиться, так что «согласился» ничего не говорит о качестве.
 *
 * Спорное поле пишется отдельным событием `disputed` вместо `recognized`: значения у него нет
 * вовсе — проходы каскада разошлись, и портал не выбрал за человека (Р14). Считать его
 * «прочитанным» значило бы завышать знаменатель на самых трудных полях.
 *
 * Строка события — НАБЛЮДЕНИЕ (§1.1 плана аудита): человеческие события сошлются на её
 * идентификатор, и метрика считается по ним, а не по правкам. Поэтому здесь записывается всё, чего
 * потом не восстановить: чем читала каждая ступень, что каждая дала, чья работа стала итогом, был
 * ли вызов наружу и куда смотреть человеку. Модели и версии дублируются текстом рядом со ссылками
 * на попытки намеренно — попытки убираются по сроку (Р31), а модель старой когорты и есть то, ради
 * чего журнал ведётся.
 *
 * Возвращает карту «поле → наблюдение»: предложению она нужна связью (§1.2.2).
 */
async function recordRecognizedFields(
  client: JobClient,
  args: {
    ticketId: string;
    requestId: string;
    fileId: string;
    /** Разбор как единица работы: один вызов задачи — один идентификатор на весь файл (§2.1). */
    recognitionRunId: string;
    /** Заказанная модель (Р7). Фактические лежат в самой странице — их вернул движок. */
    model: string;
    page: PageResult;
    ticket: PageResult['tickets'][number];
  },
): Promise<Map<WasteTicketField, string>> {
  const { page, ticket } = args;
  const values: Record<WasteTicketField, string | null> = {
    number: ticket.number,
    issuedOn: ticket.issuedOn,
    volumeM3: asText(ticket.volumeM3),
    workKind: ticket.workKind,
    addressRaw: ticket.addressRaw,
  };
  const escalated = page.escalationAttemptId !== null;
  const observations = new Map<WasteTicketField, string>();
  for (const field of WASTE_TICKET_FIELDS) {
    const value = values[field];
    const reading = ticket.readings[field];
    const disputed = ticket.needsReview.includes(field);
    // Итог дала одна ступень — её попытку и называем «выбранной». У слияния и спора их две, и
    // выбранной среди них нет: ссылка остаётся пустой, а обе попытки записаны рядом.
    const selectedAttemptId =
      reading.stage === 'primary'
        ? page.primaryAttemptId
        : reading.stage === 'escalation'
          ? page.escalationAttemptId
          : null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO waste_ticket_field_events
         (ticket_id, request_id, page_sha256, event, field, old_value, new_value,
          model, model_reported, prompt_version, preprocessing_version, passes, escalated,
          read_state, source_stage, primary_attempt_id, escalation_attempt_id, selected_attempt_id,
          primary_model_reported, escalation_model_reported, primary_value, escalation_value,
          file_id, page_no, recognition_run_id, cache_hit, collection_version)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$12,
               $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING id`,
      [
        args.ticketId,
        args.requestId,
        page.sha256,
        disputed ? 'disputed' : 'recognized',
        field,
        disputed ? null : value,
        args.model,
        // Старая колонка остаётся моделью ПЕРВОГО прохода: по ней построен индекс выгрузки 0206, и
        // сменить её смысл значило бы разъехаться с уже собранной историей. Обе ступени названы
        // отдельными снимками ниже.
        page.modelReported,
        PROMPT_VERSION,
        PREPROCESSING_VERSION,
        escalated ? 2 : 1,
        escalated,
        readState({
          field,
          value,
          workKind: ticket.workKind,
          disputed,
          unreadable: page.unreadable,
        }),
        reading.stage,
        page.primaryAttemptId,
        page.escalationAttemptId,
        selectedAttemptId,
        page.modelReported,
        page.escalationModelReported,
        reading.primaryValue,
        reading.escalationValue,
        args.fileId,
        page.pageNo,
        args.recognitionRunId,
        page.cacheHit,
        COLLECTION_VERSION,
      ],
    );
    observations.set(field, inserted.rows[0]!.id);
  }
  return observations;
}

/**
 * Значение поля текстом — ровно так, как его хранит журнал (0206): и дата, и объём. Приведение к
 * типу стёрло бы половину случая — обрезанный номер `262` и пустая строка выглядели бы одинаково.
 */
function asText(value: string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Список нечитаемых полей из ответа модели. Проверяется поимённо, а не принимается на веру: у
 * страницы, взятой из кэша, он приезжает сырым `jsonb` попытки, который писала прошлая версия кода.
 */
function readUnreadable(value: unknown): WasteTicketField[] {
  if (!Array.isArray(value)) return [];
  const known: readonly string[] = WASTE_TICKET_FIELDS;
  return value.filter((f): f is WasteTicketField => typeof f === 'string' && known.includes(f));
}

/**
 * Чья транскрипция уезжает в талон (Р12, ADR 0166 п. 7).
 *
 * Правило идёт за датой: итог дал только второй проход — берётся его написание, иначе приоритет у
 * непустого написания первого. Подмешивать первое к дате второго нельзя: подпись «OCR в графе»
 * обещает написание ТОЙ модели, чья дата стоит рядом, а собранная из двух ответов пара объясняла
 * бы дату чужим чтением графы.
 *
 * У спорной и пустой даты ступени нет, и написание всё равно сохраняется — для разбора; подпись
 * до разрешения спора не рисует портал (Р12).
 */
function issuedOnRawOf(
  stage: FieldStage | null,
  primary: string | null | undefined,
  escalation: string | null | undefined,
): string {
  if (stage === 'escalation') return escalation ?? '';
  return (primary || escalation) ?? '';
}

/**
 * Собирает страницу результата: нормализует ОБЕ ступени по якорю и сливает их по полям (Р6, Р14).
 *
 * Чистая функция от чернового результата и контекста — и это её главное свойство: T2 зовёт её
 * второй раз, уже с якорем, перечитанным под замком заявки (Р8), и ничего, кроме дат, от этого
 * не меняется.
 */
function toPageResult(draft: PageDraft, ctx: AnchorContext): PageResult {
  const escalationAttemptId = draft.escalation?.attemptId ?? null;
  const primaryModel = draft.primary.modelReported;
  // Вторая ступень подписывается заказанным слагом, когда фактическую не назвал никто: у первой
  // такой подстановки нет намеренно (при варианте A там стояло бы слово `proxy`), а у старшей
  // слаг заказан прямо в настройке и другой моделью быть не может.
  const escalationModel = draft.escalation
    ? draft.escalation.modelReported || draft.escalation.model
    : '';
  // Нормализация — до сопоставления и слияния, отдельно у каждого прохода и одинаково у свежего и
  // взятого из кэша (Р6, ADR 0166 п. 3).
  const primaryTickets = stageTickets(draft.primary.raw, ctx);
  const escalatedTickets = draft.escalation ? stageTickets(draft.escalation.raw, ctx) : [];
  const unreadable = readUnreadable(draft.primary.raw.unreadable);

  const tickets = primaryTickets.map((ticket, index) => {
    const pair = escalationAttemptId ? matchTicket(ticket, escalatedTickets, index) : undefined;
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
    // Вид работ и адрес каскад не сливает: в талон уходит чтение первого прохода, чем бы ни
    // ответил второй. Ступень поэтому только `merged` (второй прочитал то же самое) или
    // `primary`, а расхождение видно значениями — оба записаны, и спорным поле от этого не станет.
    const kept = (
      value: string | null,
      escalatedValue: string | null | undefined,
    ): FieldReading => ({
      stage:
        value === null || value === '' ? null : escalatedValue === value ? 'merged' : 'primary',
      primaryValue: asText(value),
      escalationValue: asText(escalatedValue),
    });
    const readings: Record<WasteTicketField, FieldReading> = {
      number: {
        stage: number.stage,
        primaryValue: asText(ticket.number),
        escalationValue: asText(pair?.number),
      },
      issuedOn: {
        stage: issuedOn.stage,
        primaryValue: asText(ticket.issuedOn),
        escalationValue: asText(pair?.issuedOn),
      },
      volumeM3: {
        stage: volume.stage,
        primaryValue: asText(ticket.volumeM3),
        escalationValue: asText(pair?.volumeM3),
      },
      workKind: kept(ticket.workKind, pair?.workKind),
      addressRaw: kept(ticket.addressRaw, pair?.addressRaw),
    };
    return {
      number: number.value,
      issuedOn: issuedOn.value,
      issuedOnRaw: issuedOnRawOf(issuedOn.stage, ticket.issuedOnRaw, pair?.issuedOnRaw),
      volumeM3: volume.value,
      workKind: ticket.workKind,
      addressRaw: ticket.addressRaw,
      needsReview,
      candidates,
      readings,
    };
  });

  return {
    pageNo: draft.page.pageNo,
    sha256: draft.page.sha256,
    primaryAttemptId: draft.primary.attemptId,
    escalationAttemptId,
    modelReported: primaryModel,
    escalationModelReported: escalationModel,
    unreadable,
    cacheHit: draft.cacheHit,
    tickets,
  };
}
