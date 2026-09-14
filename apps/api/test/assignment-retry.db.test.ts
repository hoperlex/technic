import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Только типы: значения модуля берутся через `await import` уже после того, как выставлено
// окружение, — протокол читает конфигурацию, а она проверяет env при импорте.
import type * as AssignmentRetry from '../src/services/assignment-retry';

/**
 * Протокол повторов против настоящего PostgreSQL (план `docs/assignment-periods-plan.md`, В4;
 * закон конкуренции — [спайк](../../../docs/assignment-periods-spike.md), §4.2, §4.3).
 *
 * ЧЕГО НЕ ДОКАЗЫВАЕТ ЧИСТЫЙ ТЕСТ ПРОТОКОЛА. Соседний файл (`assignment-retry.test.ts`) бросает
 * синтетические ошибки и проверяет правило повтора. Но само правило опирается на два факта о живой
 * базе, и оба проверяются только базой:
 *
 * 1. **`40001` в `REPEATABLE READ` вообще случается там, где план его ждёт** — на записи в строку,
 *    изменённую и закоммиченную после того, как наш снимок был взят. Это несущая конструкция В4:
 *    не будь этого, протокол лечил бы то, чего не бывает;
 * 2. **код доходит до протокола сквозь обёртку drizzle.** Драйвер кладёт `40001` в свою ошибку, а
 *    ORM заворачивает её в `DrizzleQueryError`: проверка кода на верхнем объекте молча не
 *    срабатывает, и повтор не случался бы вовсе — каждая гонка выходила бы наружу пятисоткой,
 *    ровно как до протокола. Синтетическая цепочка причин это имитирует, но имитация обёртки
 *    доказывает поведение имитации.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test` (см. `analytics-facts-vehicle.db.test.ts`). Файл
 * **намеренно держит встречные транзакции и провоцирует отказы сериализации**: на общей базе его
 * конкурент — не наш второй клиент, а чужой прогон, и «повтор случился» стало бы неотличимо от
 * «повезло». Обратное тоже верно: наши отказы прилетали бы соседям.
 *
 * МИГРАЦИИ ФАЙЛУ НЕ НУЖНЫ, и это решение, а не экономия. Предмет проверки — поведение PostgreSQL и
 * обёртки, а не предметная таблица: сцена собирается на двух колонках, и разворачивать ради неё
 * две с половиной сотни миграций значило бы платить минутами прогона за декорацию. Предметные
 * гонки дверей проверяет свой файл на полной схеме (`assignment-races.db.test.ts`).
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/assignment-retry.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_assignment_retry_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/u, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/u, '/postgres');

/** Сцена: одна строка «заявки», её нынешняя машина и лист, выписанный по плану попытки. */
const ROW_ID = 1;

/**
 * Сколько соединение готово ждать чужую блокировку.
 *
 * Предел стоит по той же причине, что у `assignment-races.db.test.ts`: ошибка в порядке захвата
 * проявляется ожиданием, а ожидание без предела — это зависший прогон, который читается как
 * «тест сломался», а не «код сломался».
 */
const LOCK_TIMEOUT_MS = 10_000;

/** Потолок прогона: пауз нет, попыток две — сцене хватает, а прогон не ждёт джиттера. */
const POLICY = { attempts: 2, backoffMs: 0 } as const;

let retry: typeof AssignmentRetry;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
/** Второе соединение — «соседняя команда»: оно и коммитит то, что рушит наш снимок. */
let rival: pg.Client;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.NODE_ENV ??= 'test';
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
}

describe.skipIf(!DB_URL)('протокол повторов на живом PostgreSQL (В4)', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }

    prepareEnv(OWN_DB!);
    retry = await import('../src/services/assignment-retry');

    pool = new pg.Pool({
      connectionString: OWN_DB,
      max: 2,
      options: `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
    });
    db = drizzle(pool);
    rival = new pg.Client({ connectionString: OWN_DB });
    await rival.connect();
    await rival.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
    await rival.query(
      `CREATE TABLE probe (
         id int primary key,
         vehicle text not null,
         waybill text,
         unique (waybill)
       )`,
    );
  }, 60_000);

  afterAll(async () => {
    await rival?.end();
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  beforeEach(async () => {
    retry.resetAssignmentRetryCounters();
    await rival.query('TRUNCATE probe');
    await rival.query(`INSERT INTO probe (id, vehicle) VALUES (${ROW_ID}, 'машина A')`);
  });

  /**
   * Одна попытка канона в миниатюре: прочитать состояние (снимок фиксируется здесь), посчитать по
   * нему план и записать его. Между чтением и записью зовётся `interfere` — это и есть «соседняя
   * команда, успевшая закоммититься, пока мы стояли в очереди».
   */
  function attempt(planned: string[], interfere: () => Promise<void>): () => Promise<string> {
    return async () =>
      db.transaction(
        async (tx) => {
          const read = await tx.execute<{ vehicle: string }>(
            sql`SELECT vehicle FROM probe WHERE id = ${ROW_ID}`,
          );
          const plan = `лист на ${read.rows[0]!.vehicle}`;
          planned.push(plan);
          await interfere();
          await tx.execute(sql`UPDATE probe SET waybill = ${plan} WHERE id = ${ROW_ID}`);
          return plan;
        },
        // Изоляция та, которой требует Б5: у обеих фаз канона один снимок на всю транзакцию.
        { isolationLevel: 'repeatable read' },
      );
  }

  it('повтор перепланирует: вторая попытка выписывает лист по НОВОМУ состоянию', async () => {
    const planned: string[] = [];
    let interfered = false;

    const result = await retry.withAssignmentRetry(
      'assignment-changes',
      attempt(planned, async () => {
        if (interfered) return;
        interfered = true;
        // Соседняя команда сменила машину и закоммитилась после того, как наш снимок был взят:
        // наш `UPDATE` той же строки получит от PostgreSQL `40001`.
        await rival.query(`UPDATE probe SET vehicle = 'машина B' WHERE id = ${ROW_ID}`);
      }),
      POLICY,
    );

    // Настоящий `40001` от настоящей базы дошёл сквозь обёртку drizzle и был повторён.
    expect(retry.assignmentRetryCounters()).toEqual([
      { door: 'assignment-changes', retries: 1, exhaustions: 0 },
    ]);
    // Планов два, и второй посчитан по новому снимку: это и есть «повтор с повторным
    // планированием». Повтори протокол один упавший запрос — в базе лежал бы лист на машину A,
    // которой на этой заявке уже нет.
    expect(planned).toEqual(['лист на машина A', 'лист на машина B']);
    expect(result).toBe('лист на машина B');
    const { rows } = await rival.query<{ vehicle: string; waybill: string }>(
      `SELECT vehicle, waybill FROM probe WHERE id = ${ROW_ID}`,
    );
    expect(rows[0]).toEqual({ vehicle: 'машина B', waybill: 'лист на машина B' });
  });

  it('исчерпание попыток — 503 с Retry-After, и в базе не записано ничего', async () => {
    const planned: string[] = [];
    let round = 0;

    const refusal = await retry
      .withAssignmentRetry(
        'assignment-changes',
        attempt(planned, async () => {
          // Соседи коммитятся перед каждой нашей записью: сцена «`W` больше потолка» из §4.3
          // спайка, где повторы не спасают никого.
          round += 1;
          await rival.query(`UPDATE probe SET vehicle = 'машина ${round}' WHERE id = ${ROW_ID}`);
        }),
        POLICY,
      )
      .then(
        () => null,
        (e: unknown) => e as Error & { statusCode?: number; code?: string },
      );

    expect(planned).toHaveLength(POLICY.attempts);
    expect(refusal?.statusCode).toBe(503);
    expect(refusal?.code).toBe(retry.ASSIGNMENT_RETRY_EXHAUSTED_CODE);
    expect(retry.assignmentRetryCounters()).toEqual([
      { door: 'assignment-changes', retries: POLICY.attempts - 1, exhaustions: 1 },
    ]);

    // Ни одна из попыток следа не оставила: повтор законен ровно потому, что вся работа попытки
    // откатывается вместе с её транзакцией.
    const { rows } = await rival.query<{ waybill: string | null }>(
      `SELECT waybill FROM probe WHERE id = ${ROW_ID}`,
    );
    expect(rows[0]?.waybill).toBeNull();
  });

  it('нарушение уникальности повтором не заглушается', async () => {
    /*
     * `23505` — та ошибка, которой в `READ COMMITTED` отвечает нарушенный порядок захвата (спайк
     * §4.4): вторая транзакция дописывает актуальную строку по уже устаревшему решению. Повтор её
     * не лечит, а прячет — и прячет единственное, что о дефекте сообщает.
     */
    await rival.query(`INSERT INTO probe (id, vehicle, waybill) VALUES (2, 'машина B', 'занят')`);
    let attempts = 0;

    const refusal = await retry
      .withAssignmentRetry(
        'assignment-changes',
        async () => {
          attempts += 1;
          return db.execute(sql`UPDATE probe SET waybill = 'занят' WHERE id = ${ROW_ID}`);
        },
        POLICY,
      )
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(attempts).toBe(1);
    // Код спрашивается у причины, а не у текста обёртки: наружу drizzle отдаёт своё «Failed
    // query», и сам `23505` лежит в `cause` — там же, где его находит предикат протокола.
    expect((refusal?.cause as { code?: string } | undefined)?.code).toBe('23505');
    expect(retry.assignmentRetryCounters()).toEqual([]);
  });
});
