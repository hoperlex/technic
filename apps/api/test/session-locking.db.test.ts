import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as SessionsNs from '../src/auth/sessions';

/**
 * Порядок блокировок `users` → `refresh_sessions` (план «Площадки отдела набором», Р12) —
 * двумя параллельными транзакциями.
 *
 * **Что здесь считается сменой области.** Ровно то, что делает правка набора площадок отдела:
 * `UPDATE users SET auth_version = auth_version + 1` по учётке и **в той же транзакции**
 * `revokeAllForUsersTx`. Сервис `replaceDepartmentObjects` тут намеренно не зовётся: предмет файла —
 * примитивы `auth/sessions.ts`, и они обязаны держать обещание независимо от того, какая именно
 * дверь меняет область. Дверей таких будет больше одной (отделы, полномочия, роли), а порядок
 * захвата у них общий.
 *
 * **Что ловит файл.** Три обещания, каждое из которых при поломке не видно ни в коде, ни в логах:
 *
 * 1. «Все refresh-сессии погашены» — правда даже под конкурентной ротацией и конкурентным входом.
 *    Без `FOR SHARE` на строке учётки обе выдачи работают по снимку, где учётка ещё старая, и
 *    вставляют живую сессию мимо `UPDATE ... SET revoked_at`, который этой строки не видел;
 * 2. встречных блокировок между выдачей токенов и сменой области нет. Обратный порядок
 *    («сессия → учётка») дедлоком в тестах не падает и в коде не виден — он случается у человека,
 *    который обновил токен в ту же секунду, когда правили его отдел, и приходит к нему как 500;
 * 3. reuse-защита **фиксируется**: предъявили украденный токен — вся семья погашена и после
 *    коммита. До фикса `throw` стоял внутри callback транзакции и откатывал отзыв, который сам же
 *    и сделал, а по ответу это неотличимо — 401 приходил в обоих случаях.
 *
 * **Как синхронизированы транзакции — и почему не `pg_sleep`.** Пауза «на глазок» проверяет
 * скорость машины, а не порядок захвата: на нагруженном прогоне окно уезжает, и тест либо зеленеет
 * зря, либо краснеет зря. Приём здесь тот же, что в `user-grants-form-locks.db.test.ts` и
 * `route-locks.db.test.ts`:
 *
 *   1. **третья сессия (держатель)** занимает спорную строку — строку учётки или строку сессии — и
 *      оба соперника паркуются на первом же захвате. Без держателя окно между их захватами короче
 *      миллисекунды, и тест мерил бы удачу;
 *   2. **барьер** `waitBlockedBy` ждёт, пока соперники **действительно** встанут в очередь, — по
 *      `pg_blocking_pids`, то есть считая только тех, кого держит именно наш держатель, а не
 *      случайных ждущих соседнего db-теста в той же базе;
 *   3. **порядок в очереди задаёт исход**: очередь за строкой у Postgres честная (FIFO), поэтому
 *      «кто выиграл блокировку» — это «кого поставили в очередь первым», а не кому повезло.
 *      Отпускаем держателя, и дальше решает код.
 *
 * Барьер — не только синхронизация, но и **измерение**: он падает с внятным текстом, если путь
 * блокировку вовсе не берёт. Именно им проверяется `FOR SHARE` во входе (сценарий 5): итог у
 * «дождался и создал» и «не ждал и создал» один и тот же — живая сессия, — и различить их можно
 * только по тому, стоял ли вход в очереди.
 *
 * **Почему нужны отдельные соединения.** Две параллельные транзакции через один коннект — это
 * последовательные транзакции: второй `BEGIN` просто дождётся первого `COMMIT`, тест пройдёт и не
 * проверит ничего. Поэтому ротация и вход идут пулом приложения (у каждой транзакции свой коннект
 * из пула), смена области — **своим** пулом, а держатель — **своим** клиентом: заняв коннект
 * приложения, он спорил бы сам с собой.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm -C apps/api test -- session-locking
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Метка своих строк: уборка идёт по ней, а не «по последним записям». */
const EMAIL_PREFIX = 'db-session-locking';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');

/** Сколько ждать, пока соперник встанет в очередь за строкой: барьер, а не пауза «на глазок». */
const BLOCK_TIMEOUT_MS = 15_000;

interface Ctx {
  db: typeof AppDb;
  /** Второй пул — под смену области. Через пул приложения она шла бы за ротацией по очереди. */
  sideDb: typeof AppDb;
  schema: typeof SchemaNs;
  sessions: typeof SessionsNs;
  closeDb: () => Promise<void>;
  closeSide: () => Promise<void>;
}

let ctx: Ctx;
let seq = 0;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
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
  process.env.MAIL_ENABLED = 'false';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

/** Уборка по метке: сессии уходят каскадом за учёткой, чужих строк файл не трогает. */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
}

// ── Подопытные ──

async function newUser(): Promise<string> {
  seq += 1;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${RUN}-${seq}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: 'Сессий',
      passwordHash: 'db-test-not-a-hash',
      role: 'mechanic',
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return created!.id;
}

interface SessionRow {
  id: string;
  familyId: string;
  revokedAt: Date | null;
}

async function sessionsOf(userId: string): Promise<SessionRow[]> {
  return ctx.db
    .select({
      id: ctx.schema.refreshSessions.id,
      familyId: ctx.schema.refreshSessions.familyId,
      revokedAt: ctx.schema.refreshSessions.revokedAt,
    })
    .from(ctx.schema.refreshSessions)
    .where(eq(ctx.schema.refreshSessions.userId, userId));
}

async function liveSessionIds(userId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: ctx.schema.refreshSessions.id })
    .from(ctx.schema.refreshSessions)
    .where(
      and(
        eq(ctx.schema.refreshSessions.userId, userId),
        isNull(ctx.schema.refreshSessions.revokedAt),
      ),
    );
  return rows.map((row) => row.id);
}

async function authVersionOf(userId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ authVersion: ctx.schema.users.authVersion })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  return row!.authVersion;
}

// ── Смена области доступа ──

interface ScopeChangeOptions {
  /**
   * Сигнал «строка учётки взята, сессии погашены, коммита ещё нет» с backend pid транзакции: по
   * нему барьер видит, кого именно ждёт вход. Зовётся **после** отзыва — иначе соперник, стартовав
   * по сигналу, успел бы занять строку раньше самой смены области.
   */
  onHeld?: (pid: number) => void;
  /** Ворота: транзакция держит строку учётки открытой, пока промис не разрешится. */
  hold?: Promise<void>;
}

/**
 * То же, что делает правка набора площадок отдела: счётчик в строке учётки, затем отзыв её сессий
 * **в той же транзакции**. Порядок здесь и есть предмет проверки — сначала `users`, потом
 * `refresh_sessions` (Р12, этап 2, шаг 7): счётчик обесценивает выданные access-токены, отзыв гасит
 * живые refresh-сессии, и оба действия обязаны быть атомарны с правкой.
 */
async function changeScope(userId: string, opts: ScopeChangeOptions = {}): Promise<void> {
  await ctx.sideDb.transaction(async (tx) => {
    await tx
      .update(ctx.schema.users)
      .set({ authVersion: sql`${ctx.schema.users.authVersion} + 1`, updatedAt: new Date() })
      .where(eq(ctx.schema.users.id, userId));
    await ctx.sessions.revokeAllForUsersTx(tx, [userId]);
    if (opts.onHeld) {
      const res = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      opts.onHeld(Number(res.rows[0]!.pid));
    }
    if (opts.hold) await opts.hold;
  });
}

// ── Инструмент: держатель строк и барьер ──

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Третья сессия, которая держит спорную строку, пока соперники встают в очередь.
 *
 * Своим соединением, а не транзакцией пула: пул отдаёт коннекты выдаче токенов, и держатель, заняв
 * один из них, спорил бы сам с собой. `pid` нужен барьеру — по нему видно, кого именно ждут.
 */
async function openHolder(): Promise<{
  pid: number;
  hold: (query: string, params?: unknown[]) => Promise<void>;
  release: () => Promise<void>;
}> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const pid = Number(
    (await client.query<{ pid: string }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
  );
  await client.query('BEGIN');
  let closed = false;
  return {
    pid,
    hold: async (query, params = []) => {
      await client.query(query, params);
    },
    release: async () => {
      if (closed) return;
      closed = true;
      try {
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    },
  };
}

/**
 * Занять строку учётки так, чтобы соперник встал, а проверки внешних ключей — нет.
 *
 * `FOR NO KEY UPDATE`, а не `FOR UPDATE`, и это существенно: вставка в `refresh_sessions` проверяет
 * внешний ключ и берёт на строке учётки `FOR KEY SHARE`, который с `FOR UPDATE` конфликтует. Взяв
 * `FOR UPDATE`, держатель тормозил бы саму вставку — то есть проверял бы свою блокировку, а не ту,
 * которую берёт код. `FOR NO KEY UPDATE` — ровно то, что берёт `UPDATE users SET auth_version`, и с
 * `FOR SHARE` выдачи токенов он конфликтует, а с `FOR KEY SHARE` внешнего ключа — нет.
 */
function holdUserRow(
  holder: { hold: (q: string, p?: unknown[]) => Promise<void> },
  userId: string,
): Promise<void> {
  return holder.hold('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
}

/** То же для строки сессии: паркует ротацию на третьем шаге — перечитывании сессии `FOR UPDATE`. */
function holdSessionRow(
  holder: { hold: (q: string, p?: unknown[]) => Promise<void> },
  sessionId: string,
): Promise<void> {
  return holder.hold('SELECT id FROM refresh_sessions WHERE id = $1 FOR NO KEY UPDATE', [
    sessionId,
  ]);
}

/**
 * Ждёт, пока за строками держателя выстроится ровно столько сессий, сколько ожидается.
 *
 * `pg_blocking_pids` вместо `wait_event_type = 'Lock'` намеренно: считаются только те, кого держит
 * **этот** держатель, — иначе барьер снимала бы чужая блокировка соседнего db-теста в общей базе.
 * Обход рекурсивный: второй ждущий за той же строкой ждёт не держателя, а первого ждущего.
 */
async function waitBlockedBy(pid: number, expected: number, what: string): Promise<void> {
  const deadline = Date.now() + BLOCK_TIMEOUT_MS;
  let seen = 0;
  for (;;) {
    const rows = await ctx.db.execute<{ n: number }>(sql`
      WITH RECURSIVE waiters AS (
        SELECT a.pid
        FROM pg_stat_activity a
        WHERE a.datname = current_database() AND ${pid} = ANY(pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid
        FROM pg_stat_activity a
        JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
        WHERE a.datname = current_database()
      )
      SELECT count(*)::int AS n FROM waiters`);
    seen = Number(rows.rows[0]!.n);
    if (seen >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: в очередь за строкой встали не все (ждали ${expected}, дождались ${seen}). ` +
          'Так выглядит путь, который спорную строку вовсе не блокирует, — например выдача ' +
          'токенов без `FOR SHARE` на строке учётки: она не ждёт смены области и вставляет ' +
          'сессию мимо её снимка (Р12).',
      );
    }
    await wait(25);
  }
}

// ── Исходы конкурентных вызовов ──

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Промис берётся под наблюдение **в момент создания**, а не там, где проверяется исход: между
 * запуском соперника и барьером проходят десятки тактов цикла, и отказ, случившийся в этом окне,
 * иначе улетел бы в `unhandledRejection` и покрасил файл мимо всякой проверки.
 */
function capture<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
}

/** Исход, которого ждали успехом: заодно сужает тип, чего `expect(...).toBe(true)` не делает. */
function expectOk<T>(label: string, outcome: Outcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`${label}: ожидался успех, а операция отказала — ${String(outcome.error)}`);
  }
  return outcome.value;
}

/** Обратное: исход, которого ждали отказом. Возвращает ошибку — её разбирают дальше по коду. */
function expectFailed(label: string, outcome: Outcome<unknown>): unknown {
  if (outcome.ok) {
    throw new Error(
      `${label}: ожидался отказ, а операция прошла — ${JSON.stringify(outcome.value)}`,
    );
  }
  return outcome.error;
}

/** Код ответа отказа — по цепочке `cause`: drizzle оборачивает ошибки запроса своим типом. */
function statusOf(error: unknown): number | undefined {
  for (let cur: unknown = error, depth = 0; cur && depth < 5; depth += 1) {
    const e = cur as { statusCode?: unknown; cause?: unknown };
    if (typeof e.statusCode === 'number') return e.statusCode;
    cur = e.cause;
  }
  return undefined;
}

/**
 * Разорванная взаимная блокировка — по цепочке `cause` тем же обходом. `40P01` приходит из глубины
 * транзакции, повторов у этого кода нет, и наружу он уходит пятисоткой; `pg_stat_database.deadlocks`
 * для проверки не годится — счётчик общий на всю базу, а база у db-тестов одна на все файлы.
 */
function deadlockOf(error: unknown): string | null {
  for (let cur: unknown = error, depth = 0; cur && depth < 5; depth += 1) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === '40P01') return String(e.message ?? 'deadlock detected');
    if (typeof e.message === 'string' && /deadlock detected/iu.test(e.message)) return e.message;
    cur = e.cause;
  }
  return null;
}

describe.skipIf(!DB_URL)('порядок блокировок сессий: users → refresh_sessions (Р12)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const sessions = await import('../src/auth/sessions');

    // Схема и `casing` — те же, что у пула приложения: `revokeAllForUsersTx` принимает транзакцию
    // именно этого типа, и собранный иначе экземпляр в неё не передать.
    const sidePool = new pg.Pool({ connectionString: DB_URL!, max: 6 });
    const sideDb = drizzle(sidePool, { schema, casing: 'snake_case' });

    ctx = {
      db,
      sideDb,
      schema,
      sessions,
      closeDb,
      closeSide: () => sidePool.end(),
    };
    await cleanup(db);
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.closeSide();
    await ctx.closeDb();
  });

  /**
   * Сценарий 1: блокировку выиграла ротация.
   *
   * Ротация встаёт в очередь первой, поэтому она проходит целиком — выдаёт новую сессию и
   * коммитится, — а смена области ждёт её коммита и гасит **обе** сессии: и предъявленную, и
   * выданную секунду назад. Это и есть обещание «все refresh-сессии погашены»: оно про итог, а не
   * про снимок, с которого отзыв начинался.
   *
   * Барьер здесь работает и как проверка: ротация без `FOR SHARE` на строке учётки в очередь за
   * ней не встанет вовсе, и тест упадёт на `waitBlockedBy` с объяснением, а не молча разъедется по
   * времени.
   */
  it('ротация выиграла блокировку — её новая сессия отозвана сменой области', async () => {
    const userId = await newUser();
    const first = await ctx.sessions.createRefreshSession(userId);
    const versionBefore = await authVersionOf(userId);

    const holder = await openHolder();
    try {
      await holdUserRow(holder, userId);

      const rotation = capture(ctx.sessions.rotateRefreshSession(first.token));
      await waitBlockedBy(holder.pid, 1, 'ротация');
      const scope = capture(changeScope(userId));
      await waitBlockedBy(holder.pid, 2, 'смена области');
      await holder.release();

      const rotated = expectOk('ротация, выигравшая очередь', await rotation);
      expectOk('смена области', await scope);

      const rows = await sessionsOf(userId);
      expect(rows).toHaveLength(2);
      const fresh = rows.find((row) => row.id === rotated.sessionId);
      expect(fresh, 'ротация обязана была создать новую сессию').toBeDefined();
      // Главное утверждение: сессия, выданная ротацией, после коммита смены области не живая.
      expect(fresh!.revokedAt).not.toBeNull();
      expect(await liveSessionIds(userId)).toEqual([]);
      expect(await authVersionOf(userId)).toBe(versionBefore + 1);
    } finally {
      await holder.release();
    }
  }, 60_000);

  /**
   * Сценарий 2: блокировку выиграла смена области.
   *
   * Ротация стоит в очереди второй и получает строку учётки уже после коммита отзыва. Дальше
   * решает третий шаг — **перечитывание сессии `FOR UPDATE` свежим запросом**: строка из join'а,
   * прочитанная до ожидания, всё ещё говорит «сессия жива», и ротация по ней выдала бы токен,
   * переживший смену области. Свежее чтение видит `revoked_at` и уводит ветку в reuse: новой сессии
   * нет, наружу 401.
   *
   * Отсюда проверка «в таблице по-прежнему одна строка»: она краснеет ровно тогда, когда шаг 3
   * снова начнут делать по снимку, снятому до блокировки, — а такой код выглядит совершенно
   * безобидно («зачем читать дважды одно и то же»).
   */
  it('смена области выиграла — ротация перечитывает отозванный токен и отвечает 401', async () => {
    const userId = await newUser();
    const first = await ctx.sessions.createRefreshSession(userId);

    const holder = await openHolder();
    try {
      await holdUserRow(holder, userId);

      const scope = capture(changeScope(userId));
      await waitBlockedBy(holder.pid, 1, 'смена области');
      const rotation = capture(ctx.sessions.rotateRefreshSession(first.token));
      await waitBlockedBy(holder.pid, 2, 'ротация');
      await holder.release();

      expectOk('смена области, выигравшая очередь', await scope);
      const refusal = expectFailed('ротация по отозванному токену', await rotation);
      expect(statusOf(refusal), `ожидали 401, получили ${String(refusal)}`).toBe(401);

      // Новой сессии не появилось — токен не пережил смену области ни в каком виде.
      const rows = await sessionsOf(userId);
      expect(rows.map((row) => row.id)).toEqual([first.sessionId]);
      expect(await liveSessionIds(userId)).toEqual([]);
    } finally {
      await holder.release();
    }
  }, 60_000);

  /**
   * Сценарий 3: повторное предъявление старого токена гасит **всю семью** — и отзыв переживает
   * коммит. Это проверка починенного дефекта: раньше 401 бросался внутри callback транзакции, и
   * исключение откатывало отзыв, который эта же ветка только что сделала. Снаружи разницы не видно —
   * 401 приходил и тогда, и сейчас, — поэтому утверждение здесь только о состоянии базы.
   *
   * Сценарий конкурентный, и вторая транзакция тут не для красоты: вор паркуется на перечитывании
   * старой строки `FOR UPDATE`, а хозяин в это время спокойно ротирует живой токен (обе транзакции
   * держат на учётке `FOR SHARE`, а он разделяемый — друг друга они не ждут). Пока вор стоит,
   * появляется сессия, которой на момент начала его транзакции не было, — и отзыв семьи обязан
   * захватить и её: `UPDATE` берёт свой снимок в момент выполнения, уже после коммита хозяина.
   *
   * Порядок задан держателем, а не удачей: без него «кто первым дошёл до строки» решала бы
   * планировщик и загрузка машины.
   */
  it('повторное предъявление старого токена оставляет всю семью отозванной после коммита', async () => {
    const userId = await newUser();
    const first = await ctx.sessions.createRefreshSession(userId);
    // Обычная ротация: первый токен отозван и заменён вторым, семья у них общая.
    const second = await ctx.sessions.rotateRefreshSession(first.token);

    const holder = await openHolder();
    try {
      await holdSessionRow(holder, first.sessionId);

      // Вор предъявляет украденный первый токен — и встаёт на перечитывании его строки.
      const thief = capture(ctx.sessions.rotateRefreshSession(first.token));
      await waitBlockedBy(holder.pid, 1, 'повторное предъявление');

      // Хозяин тем временем ротирует живой токен целиком: третья сессия рождается, пока вор ждёт.
      const owner = await ctx.sessions.rotateRefreshSession(second.token);
      expect(await liveSessionIds(userId)).toEqual([owner.sessionId]);

      await holder.release();
      const refusal = expectFailed('повторное предъявление старого токена', await thief);
      expect(statusOf(refusal), `ожидали 401, получили ${String(refusal)}`).toBe(401);

      /*
       * Вот здесь и падал старый код: 401 из середины транзакции уносил с собой её отзыв, и семья
       * оставалась жить — украденный токен приводил ровно к тому, от чего защита писалась. Ни одной
       * живой строки, и все три — с `revoked_at`, включая ту, что появилась во время ожидания.
       */
      const rows = await sessionsOf(userId);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.familyId)).size).toBe(1);
      expect(rows.filter((row) => row.revokedAt === null)).toEqual([]);
      expect(await liveSessionIds(userId)).toEqual([]);
    } finally {
      await holder.release();
    }
  }, 60_000);

  /**
   * Сценарий 4: встречных блокировок нет.
   *
   * Четыре ротации и три смены области паркуются на одной и той же строке учётки и стартуют разом.
   * Если бы выдача токенов брала строку сессии раньше строки учётки (а «одной строкой» это и
   * получается: `FOR SHARE` дописали к запросу, идущему после `FOR UPDATE` на сессии), пересечение
   * дало бы клинч, и Postgres разорвал бы его, убив чью-то транзакцию с `40P01`.
   *
   * Отказы здесь ожидаемы и честны: чью-то сессию соседняя смена области успела погасить, и
   * ротация отвечает 401. Нечестен ровно один исход — `40P01`, и он проверяется по своей паре, а не
   * счётчиком `pg_stat_database.deadlocks`: тот общий на всю базу и краснел бы от чужого клинча.
   *
   * Семьи у сессий разные (каждая заведена входом, а не ротацией) — так и в жизни: телефон,
   * ноутбук, планшет. Пересечения ротаций между собой это не отменяет, а вот случайный клинч двух
   * reuse-веток на строках одной семьи из измерения убирает: файл проверяет пару «выдача × смена
   * области», а не устойчивость семьи к самой себе.
   */
  it('параллельные ротации и смены области не дают взаимных блокировок', async () => {
    const userId = await newUser();
    const issued = await Promise.all(
      [0, 1, 2, 3].map(() => ctx.sessions.createRefreshSession(userId)),
    );

    const holder = await openHolder();
    try {
      await holdUserRow(holder, userId);

      const rotations = issued.map((session) =>
        capture(ctx.sessions.rotateRefreshSession(session.token)),
      );
      const changes = [0, 1, 2].map(() => capture(changeScope(userId)));
      await waitBlockedBy(holder.pid, rotations.length + changes.length, 'встречные транзакции');
      await holder.release();

      const rotated = await Promise.all(rotations);
      const changed = await Promise.all(changes);

      for (const outcome of [...rotated, ...changed]) {
        if (outcome.ok) continue;
        expect(
          deadlockOf(outcome.error),
          'взаимная блокировка: порядок захвата у выдачи токенов разошёлся со сменой области (Р12)',
        ).toBeNull();
        // Единственный честный отказ ротации — 401 по сессии, погашенной сменой области.
        expect(statusOf(outcome.error), `неожиданный отказ: ${String(outcome.error)}`).toBe(401);
      }
      // Смена области ни при каком порядке не отказывает: спорить ей не с чем, только ждать.
      expect(changed.every((outcome) => outcome.ok)).toBe(true);
      expect(await authVersionOf(userId)).toBe(changes.length);
    } finally {
      await holder.release();
    }
  }, 60_000);

  /**
   * Сценарий 5: вход под блокировкой.
   *
   * Смена области держит строку учётки открытой транзакцией — счётчик поднят, сессии погашены,
   * коммита ещё нет. Вход в этот момент обязан **ждать**: он берёт `FOR SHARE` на той же строке.
   * После коммита он создаёт живую сессию, и это правильно — операция линейно случилась уже после
   * изменения, человек вошёл с новой областью.
   *
   * ЭТОТ ТЕСТ ЗАЩИЩАЕТ `FOR SHARE` В `createRefreshSession` ОТ БУДУЩЕГО УДАЛЕНИЯ КАК «ЛИШНЕГО
   * ЗАПРОСА» (Р12 п. 5). Запрос и правда выглядит бессмысленным: строку читают, ничего из неё не
   * берут, ничего в ней не меняют — а вставка одной строки атомарна и без транзакции. Итог у обоих
   * вариантов вдобавок **одинаковый**: живая сессия. Разница только в том, случилась она внутри
   * чужой незакоммиченной транзакции или после неё, и увидеть её можно ровно одним способом —
   * проверив, что вход стоял в очереди. Поэтому утверждение здесь двойное: `waitBlockedBy` (без
   * `FOR SHARE` вход в очередь не встанет, и барьер упадёт с объяснением) и `settled === false`
   * (вставка не могла состояться раньше коммита смены области). Уберут запрос — красным станет
   * барьер, а не итог.
   *
   * Внешний ключ вставки этого не заменяет: он берёт на строке учётки `FOR KEY SHARE`, а
   * `UPDATE users SET auth_version` — `FOR NO KEY UPDATE`, и эти два режима не конфликтуют. Вставка
   * прошла бы сквозь открытую смену области, не заметив её.
   */
  it('вход дожидается смены области и создаёт живую сессию уже после неё', async () => {
    const userId = await newUser();
    const before = await ctx.sessions.createRefreshSession(userId);

    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let tellHeld = (_pid: number): void => {};
    const held = new Promise<number>((resolve) => {
      tellHeld = resolve;
    });
    const scope = capture(changeScope(userId, { hold: gate, onHeld: tellHeld }));

    // Вход стартует только после сигнала «строка взята, сессии погашены»: иначе он успел бы занять
    // строку первым, и проверялся бы обратный порядок, а не этот.
    const scopePid = await Promise.race([
      held,
      scope.then<number>(() => {
        throw new Error('смена области завершилась, не дойдя до сигнала');
      }),
    ]);

    let settled = false;
    const login = capture(
      ctx.sessions.createRefreshSession(userId).finally(() => {
        settled = true;
      }),
    );
    try {
      await waitBlockedBy(scopePid, 1, 'вход под открытой сменой области');
      // Вход стоит в очереди — значит вставки ещё не было. Без `FOR SHARE` сюда бы не дошли:
      // барьер упал бы первым.
      expect(settled, 'вход вставил сессию, не дождавшись коммита смены области').toBe(false);
    } finally {
      openGate();
    }

    expectOk('смена области', await scope);
    const fresh = expectOk('вход после коммита смены области', await login).sessionId;
    // Сессия, бывшая до смены области, погашена; выданная после — жива, и она одна.
    const rows = await sessionsOf(userId);
    expect(rows.find((row) => row.id === before.sessionId)!.revokedAt).not.toBeNull();
    expect(await liveSessionIds(userId)).toEqual([fresh]);
  }, 60_000);
});
