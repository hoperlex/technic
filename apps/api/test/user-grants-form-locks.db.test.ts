import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission, Role } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';

/**
 * Порядок захвата блокировок у полномочий в окне учётки (план `docs/account-form-grants-plan.md`,
 * Р6) — двумя параллельными транзакциями.
 *
 * **Зачем отдельный файл.** Правило ADR 0106 (решение 7) едино для любой операции, меняющей доступ:
 * сначала строки наборов по возрастанию `grant_id`, затем строки учёток. Фича переносит его в правку
 * учётки — то есть в маршрут, который прежде брал свою строку первой. Пока порядок держится тем, что
 * «так написано», всякая новая дверь, взявшая учётку раньше набора, вводит клинч и вводит его молча:
 * взаимная блокировка не падает в тестах и не видна в коде — она случается у двух администраторов,
 * нажавших одновременно, а Postgres разрывает её, убивая чью-то транзакцию, и человек получает 500
 * там, где ждал «сохранено».
 *
 * Устройство у пар то же, что в `route-locks.db.test.ts`, и приём оттуда же:
 *
 *   1. третья сессия (держатель) занимает спорные строки, и обе двери паркуются на первом же
 *      захвате — без держателя окно между их захватами короче миллисекунды, и тест мерил бы удачу;
 *   2. барьер ждёт, пока обе двери **действительно** встанут в очередь (`pg_blocking_pids`);
 *   3. держатель отпускает всё разом, и дальше решает код.
 *
 * **Чем здесь измеряется клинч — и почему не счётчиком базы.** Взаимная блокировка нашей пары
 * наблюдаема локально и целиком: Postgres разрывает её, убивая одну из транзакций, `40P01` доходит
 * до маршрута из глубины транзакции, и человек получает 500 — то есть `expectHonest` и есть
 * детектор. Если же жертвой выбран держатель, ошибку получает его `COMMIT`, и падает `release()`.
 * Мимо теста клинч нашей пары не проходит ни одним способом.
 *
 * `pg_stat_database.deadlocks` для этого не годится, и дело не в осторожности: счётчик общий на всю
 * базу, а база у db-тестов одна на все файлы, и `route-locks.db.test.ts` **намеренно** устраивает
 * один клинч — последним тестом, проверяя им свой инструмент. Попади он в окно измерения — и
 * «expected 57 to be 56» покрасит наш файл за чужую работу. Счётчик отвечает на вопрос «случился ли
 * клинч в базе», а спрашивать надо «случился ли он у нас»; сессионной разбивки у него нет вовсе.
 *
 * Держатель берёт строки `FOR NO KEY UPDATE`, а не `FOR UPDATE`: этот режим конфликтует с `FOR
 * UPDATE` двери и не конфликтует с `FOR KEY SHARE`, который берут проверки внешних ключей. Иначе
 * третий сценарий был бы невыразим — назначение, появляющееся между чтением и блокировкой, ссылается
 * и на учётку, и на набор, и вставка ждала бы держателя вместо того, чтобы состояться.
 *
 * **Третий сценарий — предмет, которого нет у остальных пар.** Множество наборов операции известно
 * не полностью: кандидаты читаются **до** блокировки строки учётки, и между чтением и захватом
 * параллельная выдача успевает добавить назначение, чей набор мы не заблокировали. Ответ на это —
 * повтор транзакции с расширенным множеством, а не вторая блокировка после строки учётки: та была бы
 * встречным порядком захвата. Проверяется здесь именно повтор — по тому, что вторая попытка идёт за
 * недостающей блокировкой, — и то, что появившийся набор операцией **не пропускается**.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/user-grants-form-locks.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const EMAIL_PREFIX = 'db-grants-locks';
/** Подчёркивание, а не дефис: `grantCodeSchema` иного кода не примет. */
const GRANT_PREFIX = 'db_grants_locks';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const ADMIN_PASSWORD = 'db-test-password-123';

/** Сколько ждать, пока дверь встанет в очередь за строкой: барьер, а не пауза «на глазок». */
const BLOCK_TIMEOUT_MS = 15_000;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  closeDb: () => Promise<void>;
  adminId: string;
  auth: { authorization: string };
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

/** Уборка: журнал, затем учётки (они уносят назначения каскадом), затем наборы под RESTRICT. */
async function cleanup(db: typeof AppDb): Promise<void> {
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'user' AND entity_id IN (
    SELECT id::text FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'grant' AND entity_id IN (
    SELECT id::text FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`}`);
}

// ── Подопытные ──

interface TestGrant {
  id: string;
  code: string;
  name: string;
  version: number;
}

async function createGrant(
  roles: readonly Role[],
  permissions: readonly Permission[] = ['wasteRequests.read'],
): Promise<TestGrant> {
  seq += 1;
  const code = `${GRANT_PREFIX}_${RUN}_${seq}`;
  const name = `Набор блокировок ${seq}`;
  const [grant] = await ctx.db
    .insert(ctx.schema.grants)
    .values({ code, name, description: 'Набор заведён тестом блокировок', createdBy: ctx.adminId })
    .returning({ id: ctx.schema.grants.id, version: ctx.schema.grants.version });
  const id = grant!.id;
  await ctx.db
    .insert(ctx.schema.grantPermissions)
    .values(permissions.map((permission) => ({ grantId: id, permission })));
  await ctx.db.insert(ctx.schema.grantRoles).values(roles.map((role) => ({ grantId: id, role })));
  return { id, code, name, version: grant!.version };
}

async function newHolder(role: Role = 'mechanic'): Promise<string> {
  seq += 1;
  const [created] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-holder-${RUN}-${seq}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Держатель',
      middleName: '',
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return created!.id;
}

async function assignRaw(userId: string, grantId: string): Promise<void> {
  await ctx.db
    .insert(ctx.schema.userGrants)
    .values({ userId, grantId, grantedBy: ctx.adminId, origin: 'manual' });
}

async function grantIdsOf(userId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ grantId: ctx.schema.userGrants.grantId })
    .from(ctx.schema.userGrants)
    .where(eq(ctx.schema.userGrants.userId, userId))
    .orderBy(asc(ctx.schema.userGrants.grantId));
  return rows.map((row) => row.grantId).sort();
}

function say(grant: TestGrant, selected: boolean): Record<string, unknown> {
  return { id: grant.id, version: grant.version, selected };
}

// ── Ручки ──

function patchUser(
  id: string,
  payload: Record<string, unknown>,
): ReturnType<typeof ctx.app.inject> {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/users/${id}`,
    headers: ctx.auth,
    payload,
  });
}

/** Точечная выдача так, как её делает реестр: свежий предпросмотр и подтверждение отпечатком. */
async function assignFromRegistry(
  userId: string,
  grantId: string,
): ReturnType<typeof ctx.app.inject> {
  const preview = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/users/${userId}/grants/preview`,
    headers: ctx.auth,
    payload: { operation: 'assign', grantId },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const { expectedImpactHash } = preview.json<{ expectedImpactHash: string }>();
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/users/${userId}/grants`,
    headers: ctx.auth,
    payload: { grantId, expectedImpactHash },
  });
}

/** Правка состава набора так, как её делает конструктор: предпросмотр, затем отпечаток. */
async function patchGrant(
  grant: TestGrant,
  permissions: readonly Permission[],
): ReturnType<typeof ctx.app.inject> {
  const body = { permissions: [...permissions] };
  const preview = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/grants/${grant.id}/preview`,
    headers: ctx.auth,
    payload: body,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const { expectedImpactHash } = preview.json<{ expectedImpactHash: string }>();
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/grants/${grant.id}`,
    headers: ctx.auth,
    payload: { ...body, expectedVersion: grant.version, expectedImpactHash },
  });
}

// ── Инструмент: держатель строк, барьер и счётчик клинчей ──

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Третья сессия, которая держит спорные строки, пока обе двери встают в очередь.
 *
 * Своим соединением, а не транзакцией пула: пул отдаёт соединения приложению, и держатель, занявший
 * одно из них, спорил бы сам с собой. `pid` нужен барьеру — по нему видно, кого именно ждут двери, и
 * соседний файл, работающий с той же базой параллельно, барьер не обманет.
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
    /**
     * Отпустить строки. Ошибку `COMMIT` глушить нельзя: если жертвой разорванной взаимной
     * блокировки Postgres выбрал держателя, только она об этом и расскажет — двери в таком исходе
     * ответят как ни в чём не бывало. Соединение при этом закрывается в любом случае.
     */
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

/** Занять строку набора так, чтобы дверь встала, а проверки внешних ключей — нет. */
function holdGrant(
  holder: { hold: (q: string, p?: unknown[]) => Promise<void> },
  grantId: string,
): Promise<void> {
  return holder.hold('SELECT id FROM grants WHERE id = $1 FOR NO KEY UPDATE', [grantId]);
}

/** То же для строки учётки. */
function holdUser(
  holder: { hold: (q: string, p?: unknown[]) => Promise<void> },
  userId: string,
): Promise<void> {
  return holder.hold('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
}

/**
 * Ждёт, пока за строками держателя выстроится ровно столько сессий, сколько ожидается.
 *
 * `pg_blocking_pids` вместо `wait_event_type = 'Lock'` намеренно: считаются только те, кого держит
 * **этот** держатель, — иначе барьер снимала бы чужая блокировка соседнего db-теста. Обход
 * рекурсивный: второй ждущий за той же строкой ждёт не держателя, а первого ждущего.
 */
async function waitBlockedBy(pid: number, expected: number): Promise<void> {
  const deadline = Date.now() + BLOCK_TIMEOUT_MS;
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
    if (Number(rows.rows[0]!.n) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `дверь не встала в очередь за строками держателя (ждали ${expected}, дождались ${rows.rows[0]!.n}): ` +
          'либо путь берёт не те строки, либо ответил раньше, чем дошёл до захвата',
      );
    }
    await wait(25);
  }
}

/**
 * Ответ двери, который человек в состоянии прочитать: сделано, либо отказ по делу, либо «откройте
 * заново». 500 сюда не входит — и это не общая придирка к пятисоткам, а **измерение клинча**:
 * разорванная взаимная блокировка приходит в маршрут как `40P01` из глубины транзакции, повторов у
 * этого кода ни в `withGrantLocks`, ни в drizzle нет, и обработчик ошибок отдаёт её ровно 500.
 * Значит клинч нашей пары мимо этой проверки не проходит — в отличие от счётчика базы, который
 * считает вдобавок чужие (см. шапку файла).
 */
function expectHonest(label: string, res: { statusCode: number; body: string }): void {
  expect(
    [200, 201, 400, 409],
    `${label}: ответ не читается человеком — так выглядит разорванная взаимная блокировка: ${res.body}`,
  ).toContain(res.statusCode);
}

describe.skipIf(!DB_URL)('полномочия в окне учётки: порядок блокировок (Р6)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    await cleanup(db);

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const email = `${EMAIL_PREFIX}-admin-${RUN}@example.invalid`;
    const { hashPassword } = await import('../src/auth/password');
    const [admin] = await db
      .insert(schema.users)
      .values({
        email,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: '',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: 'admin',
        isActive: true,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = {
      app,
      db,
      schema,
      closeDb,
      adminId: admin!.id,
      auth: { authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}` },
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await cleanup(ctx.db);
    await ctx.app.close();
    await ctx.closeDb();
  });

  /**
   * Первая пара: форма учётки против точечной выдачи из реестра. Предмет у них один — назначения
   * одного человека, — а файлы разные, и порядок захвата у обоих обязан быть одним. Обе двери спорят
   * за строку набора `B` и за строку учётки: форма заменяет `A` на `B`, реестр выдаёт `B`.
   *
   * Итог совпадает при любом порядке — `{B}`, — и это не совпадение, а следствие сериализации:
   * пришедший вторым видит уже применённое первым и либо ничего не делает, либо отвечает «откройте
   * заново». Разошёлся бы итог — значит одна из дверей считала разницу от состояния, которого в
   * момент записи уже не было.
   */
  it('правка учётки против точечной выдачи не встаёт в взаимную блокировку', async () => {
    const holder = await newHolder();
    const [a, b] = [await createGrant(['mechanic']), await createGrant(['mechanic'])];
    await assignRaw(holder, a.id);

    const gate = await openHolder();
    try {
      // Порядок захвата у держателя тот же, что в коде: наборы по возрастанию `id`, потом учётка.
      for (const id of [a.id, b.id].sort()) await holdGrant(gate, id);
      await holdUser(gate, holder);

      const form = patchUser(holder, { grants: [say(a, false), say(b, true)] });
      await waitBlockedBy(gate.pid, 1);
      // Предпросмотр реестра читает без блокировок и потому проходит; ждёт уже сама выдача.
      const registry = assignFromRegistry(holder, b.id);
      await waitBlockedBy(gate.pid, 2);
      await gate.release();

      const [formRes, registryRes] = await Promise.all([form, registry]);
      expectHonest('правка учётки', formRes);
      expectHonest('выдача из реестра', registryRes);
      expect(await grantIdsOf(holder)).toEqual([b.id]);
    } finally {
      await gate.release();
    }
  }, 60_000);

  /**
   * Вторая пара: форма учётки против правки состава набора. Правка каталога берёт строку набора
   * первой и держателей второй (`routes/grants.ts`), и форма обязана идти тем же порядком — иначе
   * первое же пересечение «правят набор, который в этот момент снимают» даёт клинч.
   *
   * Ответы здесь расходятся по смыслу, и оба честные: пришедший вторым либо видит другую версию
   * состава (409 «откройте карточку заново»), либо другой список держателей (409 отпечатка).
   */
  it('правка учётки против правки состава набора не встаёт в взаимную блокировку', async () => {
    const holder = await newHolder();
    const grant = await createGrant(['mechanic']);
    await assignRaw(holder, grant.id);

    const gate = await openHolder();
    try {
      await holdGrant(gate, grant.id);
      await holdUser(gate, holder);

      const form = patchUser(holder, { grants: [say(grant, false)] });
      await waitBlockedBy(gate.pid, 1);
      const catalog = patchGrant(grant, ['wasteRequests.read', 'wasteRequests.create']);
      await waitBlockedBy(gate.pid, 2);
      await gate.release();

      const [formRes, catalogRes] = await Promise.all([form, catalog]);
      expectHonest('правка учётки', formRes);
      expectHonest('правка состава набора', catalogRes);
      /*
       * Итог следует ответу, а не удаче: приняли правку учётки — назначения нет; отказали ей —
       * назначение живо, потому что состав подписывали другой. Третьего исхода быть не должно, и
       * именно он означал бы, что одна из дверей записала разницу от состояния, которого в момент
       * записи уже не было.
       */
      expect(await grantIdsOf(holder)).toEqual(formRes.statusCode === 200 ? [] : [grant.id]);
    } finally {
      await gate.release();
    }
  }, 60_000);

  /**
   * Третий сценарий — тот, ради которого в правке учётки появился повтор транзакции.
   *
   * Назначение набора `C` появляется **после** того, как правка прочитала список назначений, и до
   * того, как она взяла строку учётки: множество наборов операции известно не полностью, и `C` в
   * захваченное множество не попал. Взять его блокировку сейчас нельзя — это встречный порядок
   * захвата и ровно тот дедлок, ради предотвращения которого правило и объявлено, — поэтому
   * транзакция откатывается и повторяется с расширенным множеством.
   *
   * Повтор здесь **виден**: строку набора `C` держит вторая сессия, и вторая попытка встаёт за ней в
   * очередь — то есть идёт за недостающей блокировкой заново и с самого начала, а не докупает её
   * после строки учётки. А итог доказывает вторую половину обещания: появившийся набор операцией не
   * пропускается — правка отвечает отказом, называя его, и назначение остаётся жить.
   */
  it('назначение, появившееся между чтением и блокировкой, вызывает повтор, а не пропуск набора', async () => {
    const holder = await newHolder();
    const named = await createGrant(['mechanic']);
    const sneaked = await createGrant(['mechanic']);
    await assignRaw(holder, named.id);

    const userGate = await openHolder();
    const grantGate = await openHolder();
    try {
      await holdUser(userGate, holder);
      await holdGrant(grantGate, sneaked.id);

      // Тело говорит только о том назначении, которое учётка держала на момент открытия формы.
      const form = patchUser(holder, { grants: [say(named, false)] });
      // Первая попытка уже взяла строку названного набора и встала за строкой учётки.
      await waitBlockedBy(userGate.pid, 1);

      // Выдача мимо формы — так её делает реестр, пока карточка открыта.
      await assignRaw(holder, sneaked.id);
      await userGate.release();

      // Вторая попытка идёт за недостающей блокировкой — и встаёт за держателем строки набора.
      await waitBlockedBy(grantGate.pid, 1);
      await grantGate.release();

      const res = await form;
      // Полнота высказывания: о появившемся наборе тело не сказало ничего, и тихо отзывать его
      // нельзя — «не показали» и «сняли» сервер различить не может.
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain(sneaked.name);
      // Ни одна из сторон не потеряна: снимать названное правка тоже не стала — она откатилась.
      expect(await grantIdsOf(holder)).toEqual([named.id, sneaked.id].sort());
    } finally {
      await userGate.release();
      await grantGate.release();
    }
  }, 60_000);
});
