import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  WASTE_TICKET_FIELDS,
  type RecognizedWasteTicket,
  type WasteTicketField,
} from '@technic/contracts';
import { runTicketRecognitionJob, type JobClient, type JobPool } from '../src/ticket-ocr/job';
import type { PageImage, RecognitionEngine, RecognitionOutcome } from '../src/ticket-ocr/engine/types';

/**
 * Задача распознавания — на живой схеме, и главный её случай это ГОНКА.
 *
 * Порядок транзакций (T0 → растеризация → проверка → T1 → T2) написан ради одного сценария: заявку
 * откатывают, пока воркер работает. Проверить это без базы нечем — весь инвариант держится на
 * `SELECT … FOR UPDATE` и на том, что уборка отката и запись результата борются за одну строку.
 * Поэтому тест ставит **управляемый барьер** ровно между последней проверкой и записью: откат
 * выполняется в этот зазор, и задача обязана завершиться, ничего не записав.
 *
 * Цена ошибки та же, ради которой писался порядок: «Новая» заявка с талоном, которого никто не
 * прикладывал, и занятый чужой номер.
 *
 * Вторая половина файла — **журнал наблюдений** (миграция 0210): что именно задача записала о
 * каждом прочитанном поле. Она здесь, а не отдельным файлом, по прозаической причине: соседние
 * db-тесты идут параллельно и убирают за собой попытки `engine = 'stub'` целиком. Два файла на
 * одну очередь ловили бы чужую уборку посреди проверки — внутри одного они выполняются подряд.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/worker test
 */

const DB_URL = process.env.TEST_DATABASE_URL;

let admin: pg.Client;
let pool: pg.Pool;

/** Движок-счётчик: отвечает предсказуемо и рассказывает, сколько раз его позвали. */
function countingEngine(tickets: unknown[] = [{ number: '30476', issuedOn: '2026-08-17', volumeM3: 20, workKind: 'removal', addressRaw: 'Автозаводская, лот 33' }]) {
  const calls: string[] = [];
  const engine: RecognitionEngine = {
    kind: 'stub',
    async recognize(page: PageImage, opts): Promise<RecognitionOutcome> {
      calls.push(`${opts.model}:${page.sha256.slice(0, 8)}`);
      return {
        status: 'done',
        response: { tickets: tickets as never, unreadable: [] },
        meta: {
          engine: 'stub',
          model: opts.model,
          modelReported: opts.model,
          // Заведомо ЧУЖАЯ версия: движок вправе сообщить любую, а ключ кэша строится по нашей.
          // Совпади они здесь случайно — тест не заметил бы, что запись и чтение разъехались.
          promptVersion: 99,
          preprocessingVersion: 1,
          inputTokens: 100,
          outputTokens: 20,
          durationMs: 5,
          proxyRequestId: '',
          upstreamRequestId: '',
          idempotencyKey: 'k',
          requestId: 'r',
        },
      };
    },
  };
  return { engine, calls };
}

/** Фикстура: выполненная заявка с приложенным талоном. Возвращает идентификаторы. */
async function seed(): Promise<{ requestId: string; fileId: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const obj = await admin.query<{ id: string }>(
    `INSERT INTO construction_objects (code, name) VALUES ($1, $1) RETURNING id`,
    [`ocr-${suffix}`],
  );
  const user = await admin.query<{ id: string }>(
    // `full_name` — генерируемая колонка: собирается базой из фамилии и имени.
    `INSERT INTO users (email, password_hash, last_name, first_name)
     VALUES ($1, 'x', 'Тестов', 'Тест') RETURNING id`,
    [`ocr-${suffix}@example.test`],
  );
  const req = await admin.query<{ id: string }>(
    `INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by, status)
     VALUES ($1, 'waste_removal', now(), $2, 'done') RETURNING id`,
    [obj.rows[0]!.id, user.rows[0]!.id],
  );
  const file = await admin.query<{ id: string }>(
    `INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by)
     VALUES ('test', $1, 'talon.jpg', 'image/jpeg', 100, 'active', $2) RETURNING id`,
    [`ocr/${suffix}.jpg`, user.rows[0]!.id],
  );
  await admin.query(
    `INSERT INTO request_files (request_id, file_id, kind) VALUES ($1, $2, 'ticket')`,
    [req.rows[0]!.id, file.rows[0]!.id],
  );
  return { requestId: req.rows[0]!.id, fileId: file.rows[0]!.id };
}

/**
 * Настоящая строка очереди: `waste_ticket_files.active_job_id` ссылается на `jobs`, потому что
 * интерфейсу нужно показать «попытка 3 из 5, следующая в 14:32» — а это данные задачи, не файла.
 * Подставить сюда произвольную строку нельзя, и это правильно: висячий номер задачи означал бы
 * состояние, которое некому опровергнуть.
 */
async function seedJob(payload: Record<string, unknown>): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO jobs (type, payload) VALUES ('recognize_waste_ticket_file', $1::jsonb) RETURNING id`,
    [JSON.stringify(payload)],
  );
  return res.rows[0]!.id;
}

/** Подмена подготовки: сеть и растеризация в тесте не нужны, нужна страница с известным хэшем. */
function preparedPages(sha: string) {
  return {
    sourceKind: 'image' as const,
    totalPages: 1,
    skippedPages: 0,
    preprocessingVersion: 1,
    pages: [
      { pageNo: 1, buffer: Buffer.from('page'), mediaType: 'image/jpeg', sha256: sha, width: 100, height: 100 },
    ],
  };
}

/**
 * Пул с барьером: на N-м обращении к `BEGIN` выполняет колбэк и только потом отдаёт клиента. Так
 * между последней проверкой связи и записью результата (T2) вклинивается откат — тот самый зазор,
 * из-за которого весь порядок и придуман.
 */
function poolWithBarrier(real: pg.Pool, beginNo: number, onBarrier: () => Promise<void>): JobPool {
  let begins = 0;
  return {
    query: ((sql: string, params?: unknown[]) => real.query(sql, params)) as JobPool['query'],
    async connect(): Promise<JobClient> {
      const client = await real.connect();
      return {
        async query(sql: string, params?: unknown[]) {
          if (typeof sql === 'string' && sql.trim().toUpperCase().startsWith('BEGIN')) {
            begins += 1;
            if (begins === beginNo) await onBarrier();
          }
          return client.query(sql, params) as never;
        },
        release: () => client.release(),
      };
    },
  };
}

function deps(overrides: Partial<Parameters<typeof runTicketRecognitionJob>[0]>) {
  const { engine } = countingEngine();
  return {
    pool: pool as unknown as JobPool,
    s3: {} as never,
    bucket: 'test',
    engine,
    model: 'test/model',
    escalationModel: '',
    preprocess: {} as never,
    log: () => undefined,
    download: async () => Buffer.from('file'),
    prepare: async () => preparedPages('a'.repeat(64)) as never,
    ...overrides,
  };
}

// ── Наблюдения журнала (миграция 0210, план `docs/waste-ticket-audit-plan.md` §1.1, §2.1.1) ──

/**
 * Свои слаги моделей, а НЕ `test/model` соседних тестов. Уборка `ticket-attempt-cleanup.db.test.ts`
 * сносит попытки `engine = 'stub' AND model = 'test/model'` целиком, и вертись она параллельно —
 * ссылки наблюдений на попытки обнулились бы посреди проверки (`SET NULL`), а тест упал бы по
 * причине, к предмету проверки отношения не имеющей.
 */
const OBS_MODEL = 'test/obs';
const OBS_SENIOR = 'test/obs-senior';
/**
 * Фактические модели (`model_reported`, Р7) — заведомо ДРУГИЕ строки, чем заказанные слаги.
 * Совпади они, тест не отличил бы «журнал записал то, что назвал движок» от «журнал подставил то,
 * что мы заказали». Ровно так и жила прежняя ошибка: фактическая модель попадала в наблюдение
 * только при эскалации, а обычный проход уезжал в метрику пустой строкой.
 */
const OBS_PRIMARY_REPORTED = 'vendor/primary-2026-08';
const OBS_SENIOR_REPORTED = 'vendor/senior-2026-08';

/** Страницы, которые завели проверки наблюдений: по ним же убирается журнал. */
const observationShas: string[] = [];

/** Свой хэш страницы на каждую проверку: общий сделал бы кэш попыток случайной связью между ними. */
function newSha(): string {
  const sha = randomBytes(32).toString('hex');
  observationShas.push(sha);
  return sha;
}

/** Талон, каким его вернула модель. По умолчанию прочитан целиком — тест портит ровно одно поле. */
function recognizedTicket(overrides: Partial<RecognizedWasteTicket> = {}): RecognizedWasteTicket {
  return {
    number: '70476',
    issuedOn: '2026-08-17',
    volumeM3: 20,
    workKind: 'removal',
    addressRaw: 'Автозаводская, лот 33',
    ...overrides,
  };
}

/** Ответ движка на один заказанный слаг. */
interface StubAnswer {
  tickets: RecognizedWasteTicket[];
  /** Поля, которые модель сама назвала нечитаемыми: признак страничный, а не талонный. */
  unreadable?: WasteTicketField[];
  /** Фактическая модель, которую называет прокси. */
  reported: string;
}

/**
 * Движок, отвечающий ПО ЗАКАЗАННОМУ СЛАГУ: каскад ходит по одной странице дважды, отличаясь только
 * моделью, — этого хватает, чтобы развести проходы. Отличие от `countingEngine` выше одно, но
 * существенное: фактическая модель здесь своя у каждой ступени, и её видно в наблюдении.
 *
 * Слаг без заготовленного ответа — падение, а не пустой ответ: пустота выглядела бы честным «поле
 * не прочитано» и увела бы проверку в зелёное по ложной причине.
 */
function modelAwareEngine(answers: Record<string, StubAnswer>): {
  engine: RecognitionEngine;
  calls: string[];
} {
  const calls: string[] = [];
  const engine: RecognitionEngine = {
    kind: 'stub',
    async recognize(page: PageImage, opts): Promise<RecognitionOutcome> {
      const answer = answers[opts.model];
      if (!answer) throw new Error(`Тест не задал ответа для модели ${opts.model}`);
      calls.push(`${opts.model}:${page.sha256.slice(0, 8)}`);
      return {
        status: 'done',
        response: { tickets: answer.tickets, unreadable: answer.unreadable ?? [] },
        meta: {
          engine: 'stub',
          model: opts.model,
          modelReported: answer.reported,
          // Заведомо чужая версия промпта — по той же причине, что и у `countingEngine`.
          promptVersion: 99,
          preprocessingVersion: 1,
          inputTokens: 100,
          outputTokens: 20,
          durationMs: 5,
          proxyRequestId: '',
          upstreamRequestId: '',
          idempotencyKey: 'k',
          requestId: 'r',
        },
      };
    },
  };
  return { engine, calls };
}

/** Зависимости проверок наблюдения: своя страница, свои слаги. */
function observationDeps(args: {
  sha: string;
  engine: RecognitionEngine;
  escalationModel?: string;
}): ReturnType<typeof deps> {
  return deps({
    engine: args.engine,
    model: OBS_MODEL,
    escalationModel: args.escalationModel ?? '',
    prepare: async () => preparedPages(args.sha) as never,
  });
}

/** Наблюдение журнала — ровно те колонки, ради которых писалась миграция 0210. */
type ObservationRow = {
  field: WasteTicketField;
  event: string;
  new_value: string | null;
  read_state: string | null;
  source_stage: string | null;
  primary_attempt_id: string | null;
  escalation_attempt_id: string | null;
  selected_attempt_id: string | null;
  model: string;
  primary_model_reported: string;
  escalation_model_reported: string;
  primary_value: string | null;
  escalation_value: string | null;
  file_id: string | null;
  page_no: number | null;
  recognition_run_id: string | null;
  cache_hit: boolean;
  collection_version: number;
  passes: number;
  escalated: boolean;
  proposal_differs: boolean | null;
};

/**
 * Наблюдения ОДНОГО разбора, по полям. Отбор идёт по `recognition_run_id`, а не по талону: у
 * тронутого талона наблюдений несколько разборов, и «последнее по времени» — ровно то правило,
 * которое план запрещает для предложения и арбитража (§1.1).
 */
async function observationsOfRun(runId: string): Promise<Map<WasteTicketField, ObservationRow>> {
  const res = await admin.query<ObservationRow>(
    `SELECT field, event, new_value, read_state, source_stage,
            primary_attempt_id, escalation_attempt_id, selected_attempt_id,
            model, primary_model_reported, escalation_model_reported,
            primary_value, escalation_value, file_id, page_no, recognition_run_id,
            cache_hit, collection_version, passes, escalated, proposal_differs
       FROM waste_ticket_field_events
      WHERE recognition_run_id = $1
      ORDER BY field`,
    [runId],
  );
  return new Map(res.rows.map((row) => [row.field, row]));
}

/** Попытки по странице в порядке появления. */
async function attemptsOfPage(sha: string): Promise<{ id: string; model: string }[]> {
  const res = await admin.query<{ id: string; model: string }>(
    `SELECT id, model FROM waste_ticket_recognition_attempts
      WHERE page_sha256 = $1 ORDER BY created_at, model`,
    [sha],
  );
  return res.rows;
}

async function singleTicketId(requestId: string): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `SELECT id FROM waste_tickets WHERE request_id = $1`,
    [requestId],
  );
  expect(res.rows).toHaveLength(1);
  return res.rows[0]!.id;
}

describe.skipIf(!DB_URL)('задача распознавания талонов', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  afterEach(async () => {
    // Порядок уборки — от зависимых к владельцам: заявки держат объект и учётку внешними ключами,
    // а попытки, наоборот, ничьи и уходят последними.
    await admin.query(
      `DELETE FROM waste_requests WHERE object_id IN (SELECT id FROM construction_objects WHERE code LIKE 'ocr-%')`,
    );
    // Наблюдения журнала талон за собой НЕ уносит: `ticket_id` объявлен `SET NULL` намеренно —
    // метрика переживает откат заявки (§1.2.2 плана аудита, исход `lost`). Значит убирать их надо
    // отдельно, и по своей странице: чужие страницы разбирают соседние файлы тестов параллельно.
    await admin.query(`DELETE FROM waste_ticket_field_events WHERE page_sha256 = ANY($1::text[])`, [
      observationShas,
    ]);
    await admin.query(`DELETE FROM jobs WHERE type = 'recognize_waste_ticket_file'`);
    await admin.query(`DELETE FROM files WHERE object_key LIKE 'ocr/%'`);
    await admin.query(`DELETE FROM construction_objects WHERE code LIKE 'ocr-%'`);
    await admin.query(`DELETE FROM users WHERE email LIKE 'ocr-%@example.test'`);
    await admin.query(`DELETE FROM waste_ticket_recognition_attempts WHERE engine = 'stub'`);
  });

  it('пишет страницу и талон, когда заявка на месте', async () => {
    const { requestId, fileId } = await seed();
    const { engine, calls } = countingEngine();
    const jobId = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(deps({ engine }) as never, { requestId, fileId }, jobId);

    const tickets = await admin.query(
      `SELECT number_key, status, origin FROM waste_tickets WHERE request_id = $1`,
      [requestId],
    );
    expect(calls).toHaveLength(1);
    expect(tickets.rows).toEqual([{ number_key: '30476', status: 'unconfirmed', origin: 'ocr' }]);

    const file = await admin.query(`SELECT status, total_pages, processed_pages FROM waste_ticket_files WHERE file_id = $1`, [fileId]);
    expect(file.rows[0]).toMatchObject({ status: 'done', total_pages: 1, processed_pages: 1 });
  });

  it('расхождение проходов оставляет поле пустым и сохраняет обоих кандидатов', async () => {
    // Эскалация прочитала объём иначе. Значение не выбирается ни одно: старшая модель ошибается
    // реже, но ошибается, и выбор за человеком (Р14). Но вопрос без вариантов не задать — рядом с
    // талоном ложится снимок того, что прочитал каждый проход.
    // Эскалацию запускает ПУСТОЕ обязательное поле — здесь дата (Р14): просить старшую модель
    // перечитать то, что и так прочитано, незачем. Спор возникает попутно, по объёму: страницу
    // старшая читает целиком, и её чтение сверяется со всеми полями первой.
    const { requestId, fileId } = await seed();
    const primary = countingEngine([
      { number: '30476', issuedOn: null, volumeM3: 20, workKind: 'removal', addressRaw: 'Автозаводская, лот 33' },
    ]);
    const escalated = countingEngine([
      { number: '30476', issuedOn: '2026-08-17', volumeM3: 28, workKind: 'removal', addressRaw: 'Автозаводская, лот 33' },
    ]);
    /** Первый вызов отвечает основной моделью, второй — старшей: каскад ходит по одной странице. */
    const engine: RecognitionEngine = {
      kind: 'stub',
      recognize: (page, opts) =>
        opts.model === 'test/senior'
          ? escalated.engine.recognize(page, opts)
          : primary.engine.recognize(page, opts),
    };
    const jobId = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine, escalationModel: 'test/senior' }) as never,
      { requestId, fileId },
      jobId,
    );

    const tickets = await admin.query<{
      volume_m3: string | null;
      needs_review_fields: string[];
      candidates: { field: string; value: string; model: string }[];
    }>(
      `SELECT volume_m3, needs_review_fields, candidates FROM waste_tickets WHERE request_id = $1`,
      [requestId],
    );
    const row = tickets.rows[0]!;
    expect(row.volume_m3).toBeNull();
    expect(row.needs_review_fields).toEqual(['volumeM3']);
    // Пустое у первой и прочитанное старшей — не спор, а ответ: дата встала без вопросов.
    expect(row.candidates).toEqual([
      { field: 'volumeM3', value: '20', model: 'test/model' },
      { field: 'volumeM3', value: '28', model: 'test/senior' },
    ]);
  });

  it('сошедшиеся проходы кандидатов не заводят: спорить не о чем', async () => {
    const { requestId, fileId } = await seed();
    const { engine } = countingEngine();
    const jobId = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine, escalationModel: 'test/senior' }) as never,
      { requestId, fileId },
      jobId,
    );

    const tickets = await admin.query<{ candidates: unknown[]; needs_review_fields: string[] }>(
      `SELECT candidates, needs_review_fields FROM waste_tickets WHERE request_id = $1`,
      [requestId],
    );
    expect(tickets.rows[0]!.candidates).toEqual([]);
    expect(tickets.rows[0]!.needs_review_fields).toEqual([]);
  });

  it('нетронутый талон новый проход переписывает целиком', async () => {
    // Неподтверждённая строка и была предложением машины, а не решением человека: держаться за
    // прежнее чтение, когда есть новое, незачем.
    const { requestId, fileId } = await seed();
    const jobId = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine: countingEngine().engine }) as never,
      { requestId, fileId },
      jobId,
    );

    const second = countingEngine([
      { number: '30999', issuedOn: '2026-08-18', volumeM3: 25, workKind: 'removal', addressRaw: 'Автозаводская, лот 33' },
    ]);
    const jobId2 = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine: second.engine }) as never,
      { requestId, fileId, forced: true },
      jobId2,
    );

    const tickets = await admin.query<{ number_key: string; volume_m3: string }>(
      `SELECT number_key, volume_m3 FROM waste_tickets WHERE request_id = $1`,
      [requestId],
    );
    expect(tickets.rows).toHaveLength(1);
    expect(tickets.rows[0]!.number_key).toBe('30999');
    const proposals = await admin.query(
      `SELECT 1 FROM waste_ticket_proposals p
         JOIN waste_tickets wt ON wt.id = p.ticket_id WHERE wt.request_id = $1`,
      [requestId],
    );
    // Переписанной строке предложение не нужно: новое чтение уже стоит в самом талоне.
    expect(proposals.rows).toHaveLength(0);
  });

  it('подтверждённый талон новый проход не трогает, а кладёт предложение рядом', async () => {
    const { requestId, fileId } = await seed();
    const jobId = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine: countingEngine().engine }) as never,
      { requestId, fileId },
      jobId,
    );
    await admin.query(
      `UPDATE waste_tickets SET status = 'confirmed', confirmed_at = now(),
              confirmed_by = (SELECT created_by FROM waste_requests WHERE id = $1)
        WHERE request_id = $1`,
      [requestId],
    );

    const second = countingEngine([
      { number: '30999', issuedOn: '2026-08-18', volumeM3: 25, workKind: 'removal', addressRaw: 'Автозаводская, лот 33' },
    ]);
    const jobId2 = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine: second.engine }) as never,
      { requestId, fileId, forced: true },
      jobId2,
    );

    const tickets = await admin.query<{ number_key: string; status: string }>(
      `SELECT number_key, status FROM waste_tickets WHERE request_id = $1`,
      [requestId],
    );
    // Подтверждённая строка занимает номер и осталась как была: перезапись стёрла бы работу
    // человека, ради которой кнопку и нажимают.
    expect(tickets.rows[0]).toMatchObject({ number_key: '30476', status: 'confirmed' });

    const proposals = await admin.query<{ number_raw: string; volume_m3: string }>(
      `SELECT p.number_raw, p.volume_m3 FROM waste_ticket_proposals p
         JOIN waste_tickets wt ON wt.id = p.ticket_id WHERE wt.request_id = $1`,
      [requestId],
    );
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]!.number_raw).toBe('30999');
  });

  it('повтор того же чтения предложения не заводит: «то же самое» — не новость', async () => {
    const { requestId, fileId } = await seed();
    const jobId = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine: countingEngine().engine }) as never,
      { requestId, fileId },
      jobId,
    );
    await admin.query(`UPDATE waste_tickets SET status = 'confirmed', confirmed_at = now(),
              confirmed_by = (SELECT created_by FROM waste_requests WHERE id = $1)
        WHERE request_id = $1`, [requestId]);

    const jobId2 = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine: countingEngine().engine }) as never,
      { requestId, fileId, forced: true },
      jobId2,
    );

    const proposals = await admin.query(
      `SELECT 1 FROM waste_ticket_proposals p
         JOIN waste_tickets wt ON wt.id = p.ticket_id WHERE wt.request_id = $1`,
      [requestId],
    );
    expect(proposals.rows).toHaveLength(0);
  });

  it('ГОНКА: откат в зазоре перед записью — задача ничего не пишет', async () => {
    const { requestId, fileId } = await seed();
    const { engine, calls } = countingEngine();

    // Четвёртое `BEGIN` — это T2 (T0, проверка, T1, T2). В зазор перед ним выполняется откат:
    // связь талона снимается и статус заявки возвращается в «Новую», как это делает маршрут.
    const barrierPool = poolWithBarrier(pool, 4, async () => {
      await admin.query(`DELETE FROM request_files WHERE request_id = $1`, [requestId]);
      await admin.query(`UPDATE waste_requests SET status = 'confirmed' WHERE id = $1`, [requestId]);
    });

    await runTicketRecognitionJob(
      deps({ engine, pool: barrierPool }) as never,
      { requestId, fileId },
      await seedJob({ requestId, fileId }),
    );

    const tickets = await admin.query(`SELECT id FROM waste_tickets WHERE request_id = $1`, [requestId]);
    const pages = await admin.query(`SELECT id FROM waste_ticket_pages WHERE request_id = $1`, [requestId]);
    expect(tickets.rows).toHaveLength(0);
    expect(pages.rows).toHaveLength(0);
    // Вызов модели всё же был и оплачен — эту границу порядок транзакций не убирает, и попытка
    // остаётся в журнале: кэшем, который сэкономит повторное закрытие тем же листом.
    expect(calls).toHaveLength(1);
    const attempts = await admin.query(`SELECT status FROM waste_ticket_recognition_attempts WHERE engine = 'stub'`);
    expect(attempts.rows).toHaveLength(1);
  });

  it('кэш попыток не тратит второй вызов', async () => {
    const first = await seed();
    const { engine, calls } = countingEngine();
    await runTicketRecognitionJob(deps({ engine }) as never, first, await seedJob(first));
    const second = await seed();
    await runTicketRecognitionJob(deps({ engine }) as never, second, await seedJob(second));

    expect(calls).toHaveLength(1);
    const tickets = await admin.query(`SELECT request_id FROM waste_tickets WHERE request_id = ANY($1::uuid[])`, [
      [first.requestId, second.requestId],
    ]);
    expect(tickets.rows).toHaveLength(2);
  });

  it('вариант A («выбирает прокси») кэш не использует: за одним слагом стоят разные модели', async () => {
    // Заглушка `proxy` в ключе склеила бы ответы разных моделей, а метрики качества, привязанные
    // к модели, стали бы выдумкой (Р7). Цена — повторный вызов; она осознанная.
    const { requestId, fileId } = await seed();
    const first = countingEngine();
    const jobId = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine: first.engine, model: 'proxy' }) as never,
      { requestId, fileId },
      jobId,
    );

    const second = countingEngine();
    const jobId2 = await seedJob({ requestId, fileId });
    await runTicketRecognitionJob(
      deps({ engine: second.engine, model: 'proxy' }) as never,
      { requestId, fileId },
      jobId2,
    );

    // Второй проход по той же странице всё равно позвал модель.
    expect(second.calls).toHaveLength(1);
  });

  it('принудительный проход идёт мимо кэша', async () => {
    const { requestId, fileId } = await seed();
    const { engine, calls } = countingEngine();
    await runTicketRecognitionJob(deps({ engine }) as never, { requestId, fileId }, await seedJob({ requestId, fileId }));
    await runTicketRecognitionJob(
      deps({ engine }) as never,
      { requestId, fileId, forced: true },
      await seedJob({ requestId, fileId, forced: true }),
    );

    expect(calls).toHaveLength(2);
    const attempts = await admin.query(`SELECT forced FROM waste_ticket_recognition_attempts WHERE engine = 'stub' ORDER BY forced`);
    expect(attempts.rows.map((r) => r.forced)).toEqual([false, true]);
  });

  it('откат до старта: задача завершается no-op и не заводит файловую строку', async () => {
    const { requestId, fileId } = await seed();
    await admin.query(`UPDATE waste_requests SET status = 'confirmed' WHERE id = $1`, [requestId]);
    const { engine, calls } = countingEngine();

    await runTicketRecognitionJob(deps({ engine }) as never, { requestId, fileId }, await seedJob({ requestId, fileId }));

    expect(calls).toHaveLength(0);
    const file = await admin.query(`SELECT file_id FROM waste_ticket_files WHERE file_id = $1`, [fileId]);
    expect(file.rows).toHaveLength(0);
  });

  /**
   * Наблюдение — единица измерения качества (§1.1 плана аудита): одно машинное чтение одного поля
   * в одном разборе. Записанное неверно, оно не падает и не мешает работать — талон в карточке
   * выглядит правильно, а метрика через месяц показывает долю исправлений, посчитанную не по тем
   * чтениям. Поэтому каждая проверка ниже названа своей ошибкой.
   */
  describe('журнал наблюдений (миграция 0210)', () => {
    it('обычный разбор: пять наблюдений второй версии сбора, все — чтением первой ступени', async () => {
      const { requestId, fileId } = await seed();
      const sha = newSha();
      const { engine, calls } = modelAwareEngine({
        [OBS_MODEL]: { tickets: [recognizedTicket()], reported: OBS_PRIMARY_REPORTED },
      });
      const jobId = await seedJob({ requestId, fileId });
      await runTicketRecognitionJob(
        observationDeps({ sha, engine }) as never,
        { requestId, fileId },
        jobId,
      );

      expect(calls).toHaveLength(1);
      const rows = await observationsOfRun(jobId);
      // Ровно пять: наблюдение заводится на КАЖДОЕ поле, а не только на заполненные. Пропусти мы
      // хоть одно — у доли исправлений по этому полю не станет знаменателя.
      expect([...rows.keys()].sort()).toEqual([...WASTE_TICKET_FIELDS].sort());

      const [attempt] = await attemptsOfPage(sha);
      expect(attempt).toBeDefined();
      for (const field of WASTE_TICKET_FIELDS) {
        const row = rows.get(field)!;
        expect(row).toMatchObject({
          event: 'recognized',
          // Прочитано: все пять полей модель назвала. Спора не было, эскалации не было.
          read_state: 'read',
          source_stage: 'primary',
          collection_version: 2,
          cache_hit: false,
          escalated: false,
          passes: 1,
          // Куда смотреть человеку: файл и страница. Без них разбор ошибки идёт вслепую, а лупу
          // некуда открыть — талон могли и откатить, ссылка на файл это переживает.
          file_id: fileId,
          page_no: 1,
          // Разбор как единица работы: номер задачи и есть идентификатор разбора.
          recognition_run_id: jobId,
          primary_attempt_id: attempt!.id,
          escalation_attempt_id: null,
          // Итог дал один проход — его попытка и «выбранная».
          selected_attempt_id: attempt!.id,
          // Заказанный слаг и фактическая модель — РАЗНЫЕ величины (Р7). Прежний код заполнял
          // фактическую только при эскалации, и обычный проход уезжал в метрику пустой строкой:
          // вся когорта без каскада оказывалась «прочитанной неизвестно кем».
          model: OBS_MODEL,
          primary_model_reported: OBS_PRIMARY_REPORTED,
          // Второй ступени не было — назови мы её моделью, метрика зачла бы старшей чтение,
          // которого та не делала.
          escalation_model_reported: '',
          proposal_differs: null,
        });
        expect(row.primary_model_reported).not.toBe('');
      }
      expect(rows.get('number')!.new_value).toBe('70476');
      expect(rows.get('volumeM3')!.new_value).toBe('20');
      expect(rows.get('issuedOn')!.new_value).toBe('2026-08-17');
    });

    /**
     * Каскад целиком: первый проход не прочитал дату, старшая модель перечитала страницу и
     * разошлась с ним по объёму. Один разбор даёт разом три случая слияния — спор, «заполнила
     * вторая» и «прочитали одинаково», — и три следующие проверки смотрят на него с трёх сторон.
     */
    async function runCascade(escalated: RecognizedWasteTicket): Promise<{
      requestId: string;
      jobId: string;
      sha: string;
    }> {
      const { requestId, fileId } = await seed();
      const sha = newSha();
      const { engine } = modelAwareEngine({
        [OBS_MODEL]: {
          tickets: [recognizedTicket({ issuedOn: null })],
          reported: OBS_PRIMARY_REPORTED,
        },
        [OBS_SENIOR]: { tickets: [escalated], reported: OBS_SENIOR_REPORTED },
      });
      const jobId = await seedJob({ requestId, fileId });
      await runTicketRecognitionJob(
        observationDeps({ sha, engine, escalationModel: OBS_SENIOR }) as never,
        { requestId, fileId },
        jobId,
      );
      return { requestId, jobId, sha };
    }

    it('спор каскада: событие disputed, оба кандидата рядом, ступени и выбранной попытки нет', async () => {
      const { requestId, jobId } = await runCascade(recognizedTicket({ volumeM3: 28 }));

      const written = await admin.query<{ volume_m3: string | null; needs_review_fields: string[] }>(
        `SELECT volume_m3, needs_review_fields FROM waste_tickets WHERE request_id = $1`,
        [requestId],
      );
      expect(written.rows[0]!.needs_review_fields).toEqual(['volumeM3']);
      expect(written.rows[0]!.volume_m3).toBeNull();

      const row = (await observationsOfRun(jobId)).get('volumeM3')!;
      expect(row.event).toBe('disputed');
      // ДВА состоявшихся чтения, разошедшихся в оценке (§2.1.1). Пустым поле оставил портал, а не
      // модель: посчитай мы его непрочитанным — на самых трудных полях доля «не читается» выросла
      // бы за счёт решения, принятого за модель.
      expect(row.read_state).toBe('read');
      // Ступени у спора нет: портал не выбрал между проходами, и называть победителя нечем.
      expect(row.source_stage).toBeNull();
      expect(row.selected_attempt_id).toBeNull();
      // Но обе попытки записаны — без них не сказать, какая ступень была права.
      expect(row.primary_attempt_id).not.toBeNull();
      expect(row.escalation_attempt_id).not.toBeNull();
      // Значения у спорного поля нет вовсе, и оба кандидата живут в своих колонках: без них спор
      // читается как «поле пустое» без всякого объяснения.
      expect(row.new_value).toBeNull();
      expect(row.primary_value).toBe('20');
      expect(row.escalation_value).toBe('28');
      expect(row.primary_model_reported).toBe(OBS_PRIMARY_REPORTED);
      expect(row.escalation_model_reported).toBe(OBS_SENIOR_REPORTED);
    });

    it('эскалация заполнила пустое: ступень вторая, выбрана её попытка, старшая модель названа', async () => {
      const { jobId, sha } = await runCascade(recognizedTicket({ volumeM3: 28 }));

      const escalation = (await attemptsOfPage(sha)).find((a) => a.model === OBS_SENIOR);
      expect(escalation).toBeDefined();

      const row = (await observationsOfRun(jobId)).get('issuedOn')!;
      expect(row.event).toBe('recognized');
      expect(row.read_state).toBe('read');
      // Пустое у первой и прочитанное старшей — не спор, а ответ: пустой кандидат уступает
      // непустому молча. Держи мы это спором, поле попало бы разом в «эскалация заполнила» и в
      // «не прочитано» — то есть в обе метрики сразу и ни в одну честно (§2.1.1).
      expect(row.source_stage).toBe('escalation');
      // Итог дала одна ступень — вторая: её попытку и называем выбранной, иначе вопрос
      // «окупается ли эскалация» остаётся без ответа.
      expect(row.selected_attempt_id).toBe(escalation!.id);
      expect(row.escalation_attempt_id).toBe(escalation!.id);
      expect(row.new_value).toBe('2026-08-17');
      expect(row.primary_value).toBeNull();
      expect(row.escalation_value).toBe('2026-08-17');
      expect(row.escalation_model_reported).toBe(OBS_SENIOR_REPORTED);
      expect(row.escalated).toBe(true);
      expect(row.passes).toBe(2);
    });

    it('оба прохода прочитали одинаково: ступень merged, выбранной попытки нет', async () => {
      // Эскалацию всё равно запускает пустая дата — номер и объём при этом читают обе ступени, и
      // читают одно и то же.
      const { jobId } = await runCascade(recognizedTicket());

      const rows = await observationsOfRun(jobId);
      for (const field of ['number', 'volumeM3'] as const) {
        const row = rows.get(field)!;
        expect(row.event).toBe('recognized');
        expect(row.read_state).toBe('read');
        // Совпадение — не заслуга одной ступени. Запиши мы сюда `primary`, «вторая ступень
        // подтвердила чтение» стало бы неотличимо от «вторую не спрашивали», и цена каскада
        // посчиталась бы по числу, которого нет.
        expect(row.source_stage).toBe('merged');
        // Ступеней две — выбранной среди них нет.
        expect(row.selected_attempt_id).toBeNull();
        expect(row.primary_attempt_id).not.toBeNull();
        expect(row.escalation_attempt_id).not.toBeNull();
        expect(row.primary_value).toBe(row.escalation_value);
      }
    });

    it('пустой адрес обязательного поля — «не прочитано», а не молчаливая пустота', async () => {
      const { requestId, fileId } = await seed();
      const sha = newSha();
      const { engine } = modelAwareEngine({
        [OBS_MODEL]: {
          tickets: [recognizedTicket({ addressRaw: null })],
          reported: OBS_PRIMARY_REPORTED,
        },
      });
      const jobId = await seedJob({ requestId, fileId });
      await runTicketRecognitionJob(
        observationDeps({ sha, engine }) as never,
        { requestId, fileId },
        jobId,
      );

      const rows = await observationsOfRun(jobId);
      const row = rows.get('addressRaw')!;
      // Событие всё равно `recognized` с пустым значением: чтение состоялось, результата у него нет.
      expect(row.event).toBe('recognized');
      expect(row.new_value).toBeNull();
      // Немота модели. Без этого признака её пришлось бы угадывать по пустому значению — а пустое
      // значение законно сразу у двух других случаев, и все три слиплись бы в один.
      expect(row.read_state).toBe('unreadable');
      // Ступени нет: пустоту не прочитала ни одна.
      expect(row.source_stage).toBeNull();
      expect(row.selected_attempt_id).toBeNull();
      // Остальные поля прочитаны — «не прочитано» не расползлось на весь талон.
      expect(rows.get('number')!.read_state).toBe('read');
      expect(rows.get('volumeM3')!.read_state).toBe('read');
    });

    it('пустой объём простоя — «графы нет», а не «не смогли прочесть»', async () => {
      const idle = await seed();
      const sha = newSha();
      const { engine } = modelAwareEngine({
        [OBS_MODEL]: {
          tickets: [recognizedTicket({ workKind: 'idle', volumeM3: null })],
          reported: OBS_PRIMARY_REPORTED,
        },
      });
      const jobId = await seedJob(idle);
      await runTicketRecognitionJob(observationDeps({ sha, engine }) as never, idle, jobId);

      const row = (await observationsOfRun(jobId)).get('volumeM3')!;
      // У талона простоя графы объёма не существует (Р2). Назови мы это немотой — доля «не
      // читается» по объёму росла бы ровно на числе простоев, и модель отвечала бы за графу,
      // которой на бумаге нет.
      expect(row.read_state).toBe('not_applicable');
      expect(row.event).toBe('recognized');
      expect(row.new_value).toBeNull();

      // Обратный случай, ради которого «неприменимо» смотрит на список нечитаемых, а не на один
      // вид работ: модель САМА назвала объём нечитаемым. Это уже немота, и списать её на законную
      // пустоту значило бы потерять неудачное чтение из метрики целиком.
      const blurred = await seed();
      const sha2 = newSha();
      const second = modelAwareEngine({
        [OBS_MODEL]: {
          tickets: [recognizedTicket({ workKind: 'idle', volumeM3: null })],
          unreadable: ['volumeM3'],
          reported: OBS_PRIMARY_REPORTED,
        },
      });
      const jobId2 = await seedJob(blurred);
      await runTicketRecognitionJob(
        observationDeps({ sha: sha2, engine: second.engine }) as never,
        blurred,
        jobId2,
      );

      expect((await observationsOfRun(jobId2)).get('volumeM3')!.read_state).toBe('unreadable');
    });

    /** Подтверждённый талон: новый проход ложится рядом предложением, а не переписывает работу. */
    async function seedConfirmedTicket(): Promise<{ requestId: string; fileId: string; sha: string }> {
      const { requestId, fileId } = await seed();
      const sha = newSha();
      const { engine } = modelAwareEngine({
        [OBS_MODEL]: { tickets: [recognizedTicket()], reported: OBS_PRIMARY_REPORTED },
      });
      await runTicketRecognitionJob(
        observationDeps({ sha, engine }) as never,
        { requestId, fileId },
        await seedJob({ requestId, fileId }),
      );
      await admin.query(
        `UPDATE waste_tickets SET status = 'confirmed', confirmed_at = now(),
                confirmed_by = (SELECT created_by FROM waste_requests WHERE id = $1)
          WHERE request_id = $1`,
        [requestId],
      );
      return { requestId, fileId, sha };
    }

    /** Ещё один принудительный проход по тому же листу — с другим чтением. */
    async function reReadWithNumber(
      args: { requestId: string; fileId: string; sha: string },
      number: string,
    ): Promise<string> {
      const { engine } = modelAwareEngine({
        [OBS_MODEL]: {
          tickets: [recognizedTicket({ number, issuedOn: '2026-08-18', volumeM3: 25 })],
          reported: OBS_PRIMARY_REPORTED,
        },
      });
      const payload = { requestId: args.requestId, fileId: args.fileId, forced: true };
      const jobId = await seedJob(payload);
      await runTicketRecognitionJob(
        observationDeps({ sha: args.sha, engine }) as never,
        payload,
        jobId,
      );
      return jobId;
    }

    it('предложение пишет свои пять наблюдений и связывает их по всем полям, а не только по разошедшимся', async () => {
      const seeded = await seedConfirmedTicket();
      const jobId = await reReadWithNumber(seeded, '70999');

      const ticketId = await singleTicketId(seeded.requestId);
      const proposals = await admin.query<{ number_raw: string }>(
        `SELECT number_raw FROM waste_ticket_proposals WHERE ticket_id = $1`,
        [ticketId],
      );
      expect(proposals.rows[0]!.number_raw).toBe('70999');

      // Пять наблюдений и у ветки предложения тоже. Прежде она не писала ни одного, и чтение, по
      // которому человек примет решение, в знаменатель не попадало вовсе.
      const rows = await observationsOfRun(jobId);
      expect([...rows.keys()].sort()).toEqual([...WASTE_TICKET_FIELDS].sort());
      for (const row of rows.values()) {
        expect(row.event).toBe('recognized');
        expect(row.collection_version).toBe(2);
        // Наблюдение — машинное чтение; исход придёт человеческим событием и уже со своим
        // `differs`, а до решения человека колонка обязана быть пустой (§1.2.2).
        expect(row.proposal_differs).toBeNull();
      }

      const links = await admin.query<{
        field: WasteTicketField;
        differs: boolean;
        observation_id: string;
      }>(
        `SELECT field, differs, observation_id FROM waste_ticket_proposal_observations
          WHERE proposal_ticket_id = $1 ORDER BY field`,
        [ticketId],
      );
      // Ровно пять связей: строка на СОВПАВШЕЕ поле нужна не меньше, чем на разошедшееся — без
      // неё его потом нечем назвать `uninformative`, и исход умрёт вместе со строкой предложения.
      expect(links.rows).toHaveLength(5);
      expect(Object.fromEntries(links.rows.map((r) => [r.field, r.differs]))).toEqual({
        number: true,
        issuedOn: true,
        volumeM3: true,
        // Вид работ и адрес модель прочитала так же, как они стоят в талоне: `differs` — свойство
        // момента чтения, и «не отличалось» здесь такой же ответ, как «отличалось».
        workKind: false,
        addressRaw: false,
      });
      // Связи указывают на наблюдения ЭТОГО разбора, а не на первое чтение талона: приписав исход
      // прежнему наблюдению, метрика записала бы ошибку не той модели (§1.1).
      const own = await admin.query<{ id: string }>(
        `SELECT id FROM waste_ticket_field_events WHERE recognition_run_id = $1`,
        [jobId],
      );
      const ids = new Set(own.rows.map((r) => r.id));
      for (const link of links.rows) expect(ids.has(link.observation_id)).toBe(true);
    });

    it('повторный проход перезаписывает предложение: связей снова пять и все на новые наблюдения', async () => {
      const seeded = await seedConfirmedTicket();
      const firstProposalRun = await reReadWithNumber(seeded, '70999');
      const secondProposalRun = await reReadWithNumber(seeded, '71000');

      const ticketId = await singleTicketId(seeded.requestId);
      const links = await admin.query<{ observation_id: string }>(
        `SELECT observation_id FROM waste_ticket_proposal_observations WHERE proposal_ticket_id = $1`,
        [ticketId],
      );
      // Не десять: связи прежнего предложения снимаются целиком. Останься они — исход одного
      // решения человека приписался бы разом двум чтениям, и «ждут решения» никогда не сошлось бы.
      expect(links.rows).toHaveLength(5);

      const fresh = await admin.query<{ id: string }>(
        `SELECT id FROM waste_ticket_field_events WHERE recognition_run_id = $1`,
        [secondProposalRun],
      );
      const freshIds = new Set(fresh.rows.map((r) => r.id));
      expect(freshIds.size).toBe(5);
      for (const link of links.rows) expect(freshIds.has(link.observation_id)).toBe(true);

      // Наблюдения прежнего разбора при этом никуда не делись: они случились, `RESTRICT` их
      // бережёт, а исход им назначат правила приоритета (`superseded`). Снеси их перезапись — из
      // журнала пропало бы чтение, которое человек уже видел.
      expect((await observationsOfRun(firstProposalRun)).size).toBe(5);
    });

    it('попадание в кэш: вызова наружу не было, и наблюдения об этом говорят', async () => {
      const first = await seed();
      const sha = newSha();
      const cached = modelAwareEngine({
        [OBS_MODEL]: { tickets: [recognizedTicket()], reported: OBS_PRIMARY_REPORTED },
      });
      const firstRun = await seedJob(first);
      await runTicketRecognitionJob(
        observationDeps({ sha, engine: cached.engine }) as never,
        first,
        firstRun,
      );

      // Второй лист с тем же растром — тот же `page_sha256`, те же версии, тот же слаг. Движок
      // второго разбора отвечает ЗАВЕДОМО другим номером: сходи задача всё-таки в модель, тест
      // увидел бы это талоном, а не только счётчиком вызовов.
      const second = await seed();
      const missed = modelAwareEngine({
        [OBS_MODEL]: {
          tickets: [recognizedTicket({ number: '79999' })],
          reported: 'vendor/other',
        },
      });
      const secondRun = await seedJob(second);
      await runTicketRecognitionJob(
        observationDeps({ sha, engine: missed.engine }) as never,
        second,
        secondRun,
      );

      expect(cached.calls).toHaveLength(1);
      expect(missed.calls).toHaveLength(0);
      const tickets = await admin.query<{ number_key: string }>(
        `SELECT number_key FROM waste_tickets WHERE request_id = $1`,
        [second.requestId],
      );
      expect(tickets.rows[0]!.number_key).toBe('70476');

      // Новой попытки не появилось — платить было не за что. Считай мы вызовы к прокси по числу
      // разборов, счёт вышел бы вдвое больше настоящего.
      expect(await attemptsOfPage(sha)).toHaveLength(1);

      const rows = await observationsOfRun(secondRun);
      expect(rows.size).toBe(5);
      for (const row of rows.values()) {
        // Признак «вызова не было» хранится, а не выводится по времени разбора: эвристика
        // «страница разобрана за 20 мс» не отличает кэш от быстрой модели.
        expect(row.cache_hit).toBe(true);
        // Модель называет сама попытка, а не заказанный слаг: чтение сделала она, и приписать его
        // тому, что стоит в настройке воркера, — та же подмена фактической модели заказанной.
        expect(row.primary_model_reported).toBe(OBS_PRIMARY_REPORTED);
        expect(row.read_state).toBe('read');
        expect(row.collection_version).toBe(2);
      }
      // У первого разбора вызов был — признак обязан их различать.
      for (const row of (await observationsOfRun(firstRun)).values()) {
        expect(row.cache_hit).toBe(false);
      }
    });
  });
});
