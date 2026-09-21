import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runTicketRecognitionJob, type JobPool } from '../src/ticket-ocr/job';
import type {
  PageImage,
  RecognitionEngine,
  RecognitionOutcome,
} from '../src/ocr-engine';

/**
 * СУДЬЯ КРУГА 2: задача распознавания ВЫПОЛНЯЕТСЯ по карантинному файлу — уходит ли скан наружу.
 *
 * Проверяется не постановка задачи (её отбивает сервис заявок), а уже лежащая в очереди: задачу
 * поставили ДО карантина. Единственный способ это увидеть — позвать настоящую `runTicketRecognitionJob`
 * и подсунуть ей `download`-шпион: скачивание и есть первый шаг наружу.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const ANCHOR = '2026-08-17';

let admin: pg.Client;
let pool: pg.Pool;

function countingEngine(): { engine: RecognitionEngine; calls: string[] } {
  const calls: string[] = [];
  const engine: RecognitionEngine = {
    kind: 'stub',
    async recognize(page: PageImage, opts): Promise<RecognitionOutcome> {
      calls.push(`${opts.model}:${page.sha256.slice(0, 8)}`);
      return {
        status: 'done',
        response: {
          tickets: [
            {
              number: '30476',
              issuedOn: '2026-08-17',
              issuedOnRaw: '17.08.26',
              volumeM3: 20,
              workKind: 'removal',
              addressRaw: 'Автозаводская, лот 33',
            },
          ] as never,
          unreadable: [],
        },
        meta: {
          engine: 'stub',
          model: opts.model,
          modelReported: opts.model,
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

function preparedPages(sha: string) {
  return {
    sourceKind: 'image' as const,
    totalPages: 1,
    skippedPages: 0,
    preprocessingVersion: 1,
    pages: [
      {
        pageNo: 1,
        buffer: Buffer.from('page'),
        mediaType: 'image/jpeg',
        sha256: sha,
        width: 100,
        height: 100,
      },
    ],
  };
}

async function seed(quarantined: boolean): Promise<{ requestId: string; fileId: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const obj = await admin.query<{ id: string }>(
    `INSERT INTO construction_objects (code, name) VALUES ($1, $1) RETURNING id`,
    [`jq2-${suffix}`],
  );
  const user = await admin.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, last_name, first_name)
     VALUES ($1, 'x', 'Судьин', 'Суд') RETURNING id`,
    [`jq2-${suffix}@example.test`],
  );
  const req = await admin.query<{ id: string }>(
    `INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by, status)
     VALUES ($1, 'waste_removal', $3::timestamptz, $2, 'done') RETURNING id`,
    [obj.rows[0]!.id, user.rows[0]!.id, `${ANCHOR}T09:00:00+03:00`],
  );
  const file = await admin.query<{ id: string }>(
    `INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by, quarantined_at)
     VALUES ('test', $1, 'talon.jpg', 'image/jpeg', 100, 'active', $2, $3) RETURNING id`,
    [`jq2/${suffix}.jpg`, user.rows[0]!.id, quarantined ? new Date() : null],
  );
  await admin.query(
    `INSERT INTO request_files (request_id, file_id, kind) VALUES ($1, $2, 'ticket')`,
    [req.rows[0]!.id, file.rows[0]!.id],
  );
  return { requestId: req.rows[0]!.id, fileId: file.rows[0]!.id };
}

async function seedJob(payload: Record<string, unknown>): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO jobs (type, payload) VALUES ('recognize_waste_ticket_file', $1::jsonb) RETURNING id`,
    [JSON.stringify(payload)],
  );
  return res.rows[0]!.id;
}

describe.skipIf(!DB_URL)('судья: карантин и выполнение задачи распознавания', () => {
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
    await admin.query(
      `DELETE FROM waste_requests WHERE object_id IN (SELECT id FROM construction_objects WHERE code LIKE 'jq2-%')`,
    );
    // ТОЛЬКО СВОИ задачи: соседний `ticket-ocr-job.db.test.ts` ходит по той же очереди в том же
    // прогоне, и глобальный `DELETE` по типу уносил бы его строку посреди работы (поймано первым
    // же полным прогоном пакета).
    await admin.query(
      `DELETE FROM jobs WHERE type = 'recognize_waste_ticket_file'
         AND payload->>'fileId' IN (SELECT id::text FROM files WHERE object_key LIKE 'jq2/%')`,
    );
    await admin.query(`DELETE FROM files WHERE object_key LIKE 'jq2/%'`);
    await admin.query(`DELETE FROM construction_objects WHERE code LIKE 'jq2-%'`);
    await admin.query(`DELETE FROM users WHERE email LIKE 'jq2-%@example.test'`);
    // Свои страницы, а не все `stub`: попытки — общая таблица, и уборка «по движку» уносила бы
    // попытки соседнего файла, который в это же время их пишет.
    await admin.query(
      `DELETE FROM waste_ticket_recognition_attempts WHERE page_sha256 = ANY($1::text[])`,
      [['b'.repeat(64), 'c'.repeat(64)]],
    );
  });

  it('карантинный файл: задача не скачивает объект и ничего не пишет', async () => {
    const { requestId, fileId } = await seed(true);
    const jobId = await seedJob({ requestId, fileId });
    const downloads: string[] = [];
    const { engine, calls } = countingEngine();
    await runTicketRecognitionJob(
      {
        pool: pool as unknown as JobPool,
        s3: {} as never,
        bucket: 'test',
        engine,
        model: 'test/model',
        escalationModel: '',
        preprocess: {} as never,
        log: () => undefined,
        download: async (key: string) => {
          downloads.push(key);
          return Buffer.from('file');
        },
        prepare: async () => preparedPages('b'.repeat(64)) as never,
      } as never,
      { requestId, fileId },
      jobId,
    );
    expect(downloads, 'скан карантинного файла не должен скачиваться').toEqual([]);
    expect(calls, 'модель по карантинному файлу не зовётся').toEqual([]);
    const tickets = await admin.query(`SELECT id FROM waste_tickets WHERE request_id = $1`, [
      requestId,
    ]);
    expect(tickets.rows).toHaveLength(0);
    const fileRow = await admin.query(`SELECT file_id FROM waste_ticket_files WHERE file_id = $1`, [
      fileId,
    ]);
    expect(fileRow.rows, 'файловая строка распознавания не заводится').toHaveLength(0);
  });

  it('регресс: обычный файл скачивается и распознаётся', async () => {
    const { requestId, fileId } = await seed(false);
    const jobId = await seedJob({ requestId, fileId });
    const downloads: string[] = [];
    const { engine, calls } = countingEngine();
    await runTicketRecognitionJob(
      {
        pool: pool as unknown as JobPool,
        s3: {} as never,
        bucket: 'test',
        engine,
        model: 'test/model',
        escalationModel: '',
        preprocess: {} as never,
        log: () => undefined,
        download: async (key: string) => {
          downloads.push(key);
          return Buffer.from('file');
        },
        prepare: async () => preparedPages('c'.repeat(64)) as never,
      } as never,
      { requestId, fileId },
      jobId,
    );
    expect(downloads).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const tickets = await admin.query(`SELECT id FROM waste_tickets WHERE request_id = $1`, [
      requestId,
    ]);
    expect(tickets.rows).toHaveLength(1);
  });
});
