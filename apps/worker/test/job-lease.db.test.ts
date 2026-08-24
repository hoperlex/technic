import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  claimJobs,
  completeJob,
  deferJob,
  extendLease,
  killJob,
  reclaimExpiredJobs,
  retryJob,
} from '../src/job-lease';

/**
 * Аренда задачи — на живой схеме.
 *
 * Проверять её без базы нечем: и возврат просроченных, и проверка владельца — это условия в `WHERE`
 * и `CASE`, то есть SQL, а не правило на TypeScript. А цена ошибки здесь ровно та, ради которой всё
 * и делалось: задача, выполненная дважды, и задача, не выполненная никогда, выглядят в журнале
 * одинаково спокойно.
 *
 * Схему тест не накатывает: миграции живут в `@technic/api`, база должна быть уже промигрирована.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/worker test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
/** Тип задачи только для теста: обработчика у него нет, и в очередь портала он не попадает. */
const TEST_TYPE = 'test_lease_probe';
const WORKER_A = 'test-worker-a';
const WORKER_B = 'test-worker-b';

let client: pg.Client;

interface JobState {
  status: string;
  attempts: number;
  locked_by: string | null;
  locked_until: Date | null;
  next_run_at: Date;
  last_error: string | null;
}

async function insertJob(opts: {
  status?: 'pending' | 'running';
  attempts?: number;
  maxAttempts?: number;
  lockedBy?: string | null;
  /** Аренда относительно текущего момента: минус — истекла, плюс — ещё держится. */
  lockedUntilMs?: number | null;
}): Promise<string> {
  // `next_run_at` в далёком прошлом: очередь отбирает по нему, а в тестовой базе лежат чужие
  // задачи прошлых прогонов — без этого пачка набралась бы ими, и до задачи теста дело не дошло бы.
  const res = await client.query<{ id: string }>(
    `INSERT INTO jobs (type, payload, status, attempts, max_attempts, next_run_at, locked_by,
                       locked_until)
     VALUES ($1, jsonb_build_object('probe', true), $2, $3, $4, now() - interval '10 years', $5,
             CASE WHEN $6::double precision IS NULL THEN NULL
                  ELSE now() + ($6::double precision * interval '1 millisecond') END)
     RETURNING id`,
    [
      TEST_TYPE,
      opts.status ?? 'pending',
      opts.attempts ?? 0,
      opts.maxAttempts ?? 5,
      opts.lockedBy ?? null,
      opts.lockedUntilMs ?? null,
    ],
  );
  return res.rows[0]!.id;
}

async function state(id: string): Promise<JobState> {
  const res = await client.query<JobState>(
    `SELECT status::text AS status, attempts, locked_by, locked_until, next_run_at, last_error
       FROM jobs WHERE id = $1`,
    [id],
  );
  return res.rows[0]!;
}

describe.skipIf(!DB_URL)('аренда фоновых задач (живая схема)', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });

  afterEach(async () => {
    await client.query(`DELETE FROM jobs WHERE type = $1`, [TEST_TYPE]);
    // Чужие задачи, попавшие в пачку заодно с нашими, возвращаются в очередь: тест не должен
    // оставлять после себя строки, занятые несуществующим воркером.
    await client.query(
      `UPDATE jobs SET status = 'pending', locked_by = NULL, locked_until = NULL
        WHERE locked_by = ANY($1::text[]) AND type <> $2`,
      [[WORKER_A, WORKER_B], TEST_TYPE],
    );
  });

  afterAll(async () => {
    await client?.end();
  });

  it('захват ставит аренду по переданному сроку, а не по зашитым пяти минутам', async () => {
    const id = await insertJob({});

    const claimed = await claimJobs(client, { workerId: WORKER_A, limit: 10, leaseMs: 120_000 });

    expect(claimed.map((j) => j.id)).toContain(id);
    const after = await state(id);
    expect(after.status).toBe('running');
    expect(after.locked_by).toBe(WORKER_A);
    const leftMs = after.locked_until!.getTime() - Date.now();
    // Две минуты с поправкой на дорогу до базы: важно, что это не пять минут по умолчанию.
    expect(leftMs).toBeGreaterThan(100_000);
    expect(leftMs).toBeLessThan(130_000);
  });

  it('просроченная running возвращается в очередь и тратит попытку, а не обнуляет счётчик', async () => {
    const id = await insertJob({
      status: 'running',
      attempts: 2,
      lockedBy: WORKER_B,
      lockedUntilMs: -60_000,
    });

    const reclaimed = await reclaimExpiredJobs(client, { limit: 50 });

    expect(reclaimed.map((j) => j.id)).toContain(id);
    const after = await state(id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(3);
    expect(after.locked_by).toBeNull();
    expect(after.locked_until).toBeNull();
    expect(after.last_error).toContain(WORKER_B);
    // Задача снова видна выборке: возврат без этого был бы возвратом на бумаге. Пачка берётся с
    // запасом — возврат ставит `next_run_at = now()`, то есть в конец очереди, а в тестовой базе
    // перед ней лежат сотни чужих задач прошлых прогонов.
    const claimed = await claimJobs(client, { workerId: WORKER_A, limit: 1000, leaseMs: 60_000 });
    expect(claimed.map((j) => j.id)).toContain(id);
  });

  it('задача, пережившая аренду столько раз, сколько было попыток, уходит в dead, а не по кругу', async () => {
    const id = await insertJob({
      status: 'running',
      attempts: 4,
      maxAttempts: 5,
      lockedBy: WORKER_B,
      lockedUntilMs: -1_000,
    });

    const reclaimed = await reclaimExpiredJobs(client, { limit: 50 });

    expect(reclaimed.find((j) => j.id === id)?.status).toBe('dead');
    const after = await state(id);
    expect(after.status).toBe('dead');
    expect(after.attempts).toBe(5);
    // Мёртвую задачу выборка не берёт: иначе вечный цикл «взял — умер — взял» так и остался бы.
    const claimed = await claimJobs(client, { workerId: WORKER_A, limit: 10, leaseMs: 60_000 });
    expect(claimed.map((j) => j.id)).not.toContain(id);
  });

  it('живая аренда не трогается: возврат — только для просроченных', async () => {
    const id = await insertJob({
      status: 'running',
      attempts: 1,
      lockedBy: WORKER_B,
      lockedUntilMs: 60_000,
    });

    const reclaimed = await reclaimExpiredJobs(client, { limit: 50 });

    expect(reclaimed.map((j) => j.id)).not.toContain(id);
    expect((await state(id)).attempts).toBe(1);
  });

  it('продление отодвигает срок только у своих задач', async () => {
    const mine = await insertJob({ status: 'running', lockedBy: WORKER_A, lockedUntilMs: 10_000 });
    const alien = await insertJob({ status: 'running', lockedBy: WORKER_B, lockedUntilMs: 10_000 });

    const extended = await extendLease(client, {
      workerId: WORKER_A,
      jobIds: [mine, alien],
      leaseMs: 300_000,
    });

    // Продлена одна из двух — по этому числу воркер и узнаёт, что задачу у него отобрали.
    expect(extended).toBe(1);
    expect((await state(mine)).locked_until!.getTime() - Date.now()).toBeGreaterThan(200_000);
    expect((await state(alien)).locked_until!.getTime() - Date.now()).toBeLessThan(20_000);
  });

  it('чужую задачу не завершить, не перенести, не провалить и не убить', async () => {
    const id = await insertJob({ status: 'running', lockedBy: WORKER_B, lockedUntilMs: 60_000 });
    const later = new Date(Date.now() + 60_000);

    expect(await completeJob(client, { jobId: id, workerId: WORKER_A })).toBe(false);
    expect(await deferJob(client, { jobId: id, workerId: WORKER_A, nextRunAt: later })).toBe(false);
    expect(
      await retryJob(client, {
        jobId: id,
        workerId: WORKER_A,
        attempts: 9,
        nextRunAt: later,
        error: 'чужая',
      }),
    ).toBe(false);
    expect(
      await killJob(client, { jobId: id, workerId: WORKER_A, attempts: 9, error: 'чужая' }),
    ).toBe(false);

    // Ни одна из четырёх попыток не оставила следа: строка осталась ровно такой, какой была.
    const after = await state(id);
    expect(after.status).toBe('running');
    expect(after.attempts).toBe(0);
    expect(after.locked_by).toBe(WORKER_B);
    expect(after.last_error).toBeNull();
  });

  it('свою задачу завершает и переносит владелец', async () => {
    const done = await insertJob({ status: 'running', lockedBy: WORKER_A, lockedUntilMs: 60_000 });
    const later = new Date(Date.now() + 900_000);
    const deferred = await insertJob({
      status: 'running',
      lockedBy: WORKER_A,
      lockedUntilMs: 60_000,
    });

    expect(await completeJob(client, { jobId: done, workerId: WORKER_A })).toBe(true);
    expect(await deferJob(client, { jobId: deferred, workerId: WORKER_A, nextRunAt: later })).toBe(
      true,
    );

    expect((await state(done)).status).toBe('done');
    const afterDefer = await state(deferred);
    expect(afterDefer.status).toBe('pending');
    expect(afterDefer.attempts).toBe(0); // перенос попытку не тратит
    expect(afterDefer.locked_by).toBeNull();
    expect(afterDefer.next_run_at.getTime()).toBeGreaterThan(Date.now() + 800_000);
  });
});
