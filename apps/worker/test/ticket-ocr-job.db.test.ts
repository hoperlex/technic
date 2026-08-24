import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
          promptVersion: 1,
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
});
