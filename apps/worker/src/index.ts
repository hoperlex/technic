import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { pino } from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

// ── Конфигурация (минимальная; секреты приложения воркеру не нужны) ──
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения ${name}`);
  return v;
}

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const BATCH = Number(process.env.WORKER_BATCH ?? 10);
const CLEANUP_INTERVAL_MS = Number(process.env.WORKER_CLEANUP_INTERVAL_MS ?? 3_600_000); // 1 час
const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

const JOB_DELETE_S3_OBJECT = 'delete_s3_object';

const caPath = process.env.PGSSLROOTCERT;
const ca = caPath ? readFileSync(caPath, 'utf8') : undefined;
const dbUrl = new URL(required('DATABASE_URL'));
dbUrl.searchParams.delete('sslmode');

const pool = new pg.Pool({
  connectionString: dbUrl.toString(),
  ssl: ca ? { ca, rejectUnauthorized: true } : false,
  max: Number(process.env.WORKER_DB_POOL_MAX ?? 4),
});

const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'ru-central-1',
  endpoint: required('S3_ENDPOINT'),
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'false') === 'true',
  credentials: {
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  },
  // Отключаем авто-checksum AWS SDK v3 (см. apps/api/src/lib/s3-client.ts).
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const bucket = required('S3_BUCKET');

// Диагностика: без секретов; помогает заметить неверный bucket/endpoint в проде.
logger.info(
  {
    s3Endpoint: process.env.S3_ENDPOINT,
    s3Region: process.env.S3_REGION ?? 'ru-central-1',
    s3Bucket: bucket,
    s3ForcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'false') === 'true',
  },
  'S3 конфигурация worker',
);

async function deleteObject(objectKey: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return; // идемпотентно
    throw e;
  }
}

interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

async function handleJob(job: JobRow): Promise<void> {
  switch (job.type) {
    case JOB_DELETE_S3_OBJECT: {
      const objectKey = String(job.payload.objectKey ?? '');
      if (objectKey) await deleteObject(objectKey);
      return;
    }
    default:
      throw new Error(`Неизвестный тип задачи: ${job.type}`);
  }
}

function backoffMs(attempts: number): number {
  const base = Math.min(300, 5 * 2 ** attempts); // сек, максимум 5 минут
  const jitter = Math.floor(Math.random() * 1000);
  return base * 1000 + jitter;
}

async function processJobs(): Promise<number> {
  const claimed = await pool.query<JobRow>(
    `UPDATE jobs SET status='running', locked_by=$1, locked_until=now() + interval '5 minutes', updated_at=now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE status='pending' AND next_run_at <= now()
       ORDER BY next_run_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, type, payload, attempts, max_attempts`,
    [WORKER_ID, BATCH],
  );

  for (const job of claimed.rows) {
    try {
      await handleJob(job);
      await pool.query(`UPDATE jobs SET status='done', updated_at=now() WHERE id=$1`, [job.id]);
    } catch (e) {
      const attempts = job.attempts + 1;
      const message = e instanceof Error ? e.message : String(e);
      if (attempts >= job.max_attempts) {
        await pool.query(
          `UPDATE jobs SET status='dead', attempts=$2, last_error=$3, updated_at=now() WHERE id=$1`,
          [job.id, attempts, message],
        );
        logger.error({ jobId: job.id, type: job.type }, `Задача переведена в dead: ${message}`);
      } else {
        const next = new Date(Date.now() + backoffMs(attempts));
        await pool.query(
          `UPDATE jobs SET status='pending', attempts=$2, next_run_at=$3, last_error=$4, updated_at=now() WHERE id=$1`,
          [job.id, attempts, next, message],
        );
        logger.warn({ jobId: job.id, attempts }, `Повтор задачи: ${message}`);
      }
    }
  }
  return claimed.rows.length;
}

/** Очистка незавершённых загрузок старше 24ч. */
async function cleanupOrphanUploads(): Promise<void> {
  const res = await pool.query<{ id: string; object_key: string }>(
    `SELECT id, object_key FROM files
     WHERE status='pending' AND created_at < now() - interval '24 hours'
     LIMIT 200`,
  );
  for (const row of res.rows) {
    try {
      await deleteObject(row.object_key);
      await pool.query(`UPDATE files SET status='deleted', deleted_at=now() WHERE id=$1`, [row.id]);
    } catch (e) {
      logger.warn({ fileId: row.id, err: e }, 'Не удалось очистить orphan-загрузку');
    }
  }
  if (res.rows.length > 0) {
    logger.info({ count: res.rows.length }, 'Очищены orphan-загрузки');
  }
}

let stopping = false;
let lastCleanup = 0;

async function loop(): Promise<void> {
  logger.info({ workerId: WORKER_ID }, 'Worker запущен');
  while (!stopping) {
    try {
      const processed = await processJobs();
      if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
        lastCleanup = Date.now();
        await cleanupOrphanUploads();
      }
      if (processed === 0) await sleep(POLL_INTERVAL_MS);
    } catch (e) {
      logger.error({ err: e }, 'Ошибка в цикле worker');
      await sleep(POLL_INTERVAL_MS);
    }
  }
  await pool.end();
  logger.info('Worker остановлен');
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

void loop();
