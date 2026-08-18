import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Жизнь учётки после архива (ADR 0063) — на живой схеме, через настоящие HTTP-пути.
 *
 * Зачем база. Всё решение держится на двух частичных уникальных индексах (миграция 0093): адрес и
 * физлицо занимает действующая учётка, а не архивная. Проверить это на правилах нельзя — расходятся
 * не правила, а код и схема: с полным индексом повторная регистрация упирается в 500 от БД, а не в
 * 201, и никакой контрактный тест этого не увидит. По той же причине здесь же проверяется отказ по
 * ссылкам при удалении насовсем: его выдаёт внешний ключ, а не код.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   createdb technic_test && psql technic_test -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;
 *     CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm'
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5432/technic_test pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-archive-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';
const USER_PASSWORD = 'db-user-password-456';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  issueCaptcha: (issuedAt?: number) => { token: string; code: string };
  objectId: string;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
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
  // Регистрация без почты отклоняется (ADR 0072): заявку, которую невозможно подтвердить, портал
  // не заводит. Транспорт `log` — письма составляются в журнал и наружу не уходят.
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
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

/** Свой адрес на каждый запрос: регистрация ограничена пятью попытками за десять минут с IP. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Адрес заявки: свой у каждого сценария, чтобы порядок тестов ничего не решал. */
function freshEmail(): string {
  return `db-archive-${randomUUID().slice(0, 8)}@example.invalid`;
}

/** Саморегистрация с настоящей капчей: момент выдачи сдвинут в прошлое, чтобы не ждать. */
async function register(email: string): Promise<number> {
  const captcha = ctx.issueCaptcha(Date.now() - 5_000);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: nextAddress(),
    payload: {
      email,
      lastName: 'Заявкин',
      firstName: 'Пётр',
      middleName: '',
      phone: '',
      password: USER_PASSWORD,
      requestedRole: 'other',
      requestedObject: '',
      requestedCompany: '',
      // «Другое» без объяснения словами схема не пропускает: рассматривать такую заявку не по чему.
      requestedComment: 'Сметчик, нужен просмотр заявок',
      captchaToken: captcha.token,
      captchaAnswer: captcha.code,
    },
  });
  return res.statusCode;
}

/** Идентификаторы строк с этим адресом: архивные и действующая различаются `deleted_at`. */
async function rowsByEmail(
  email: string,
): Promise<{ id: string; deleted_at: Date | null; is_active: boolean; role: string | null }[]> {
  const res = await ctx.db.execute<{
    id: string;
    deleted_at: Date | null;
    is_active: boolean;
    role: string | null;
  }>(sql`SELECT id, deleted_at, is_active, role FROM users WHERE email = ${email}
         ORDER BY created_at`);
  return [...res.rows];
}

/** Заявка на регистрацию, которой отказали: то, что чистит уборка по сроку и сносит purge. */
async function rejectedRegistration(email: string): Promise<string> {
  expect(await register(email)).toBe(201);
  const [row] = await rowsByEmail(email);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/users/${row!.id}/reject`,
    headers: ctx.auth,
    // Письма заявителю здесь не нужно: проверяется архив, а не почта (ADR 0087).
    payload: { reason: 'Проверка архива', notifyApplicant: false },
  });
  expect(res.statusCode, res.body).toBe(200);
  return row!.id;
}

describe.skipIf(!DB_URL)('учётка после архива (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { issueCaptcha } = await import('../src/auth/captcha');
    const schema = await import('../src/db/schema');

    const [admin] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
    if (!admin) {
      await db.insert(schema.users).values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: '',
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: 'admin',
        isActive: true,
      });
    }

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextAddress(),
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const object = objects.rows[0];
    if (!object) throw new Error('В базе нет объектов: миграции наполнения не применены');

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      issueCaptcha,
      objectId: object.id,
    };
  }, 120_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь
       * каждый сценарий регистрируется заново — да ещё и по нескольку строк на адрес, потому что
       * архивная и действующая учётки различаются только `deleted_at`. За прогон в базе оставался
       * десяток отказанных заявок на регистрацию, и они же попадали в отбор аудитории рассылок.
       *
       * Метка — адрес: `db-archive-<8 знаков>`, его же и выдаёт `freshEmail`. Списком заведённого
       * уборка не пользуется намеренно — прибирать надо и за упавшим прогоном, который до записи
       * в список мог не дойти. Администратор из-под метки выведен: его заводит `beforeAll` один
       * раз на все прогоны и ищет по адресу.
       *
       * Порядок обратен ссылкам: сначала заявка на вывоз (`waste_requests.created_by` — RESTRICT,
       * именно этим и держится сценарий отказа в `purge`), затем журнал, затем учётки. Журнал
       * подчищается ещё и по адресу в реквизитах: у purge-сценария учётки уже нет, а строка о ней
       * осталась — по ней тест и проверяет, что адрес в журнале сохранился.
       */
      const ours = sql`email LIKE 'db-archive-%' AND email <> ${ADMIN_EMAIL}`;
      await ctx.db.execute(sql`
        DELETE FROM waste_requests WHERE created_by IN (SELECT id FROM users WHERE ${ours})`);
      await ctx.db.execute(sql`
        DELETE FROM audit_log
        WHERE entity_type = 'user'
          AND (entity_id IN (SELECT id::text FROM users WHERE ${ours})
               OR metadata->>'email' LIKE 'db-archive-%')`);
      await ctx.db.execute(sql`DELETE FROM users WHERE ${ours}`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('отказ по заявке освобождает адрес: тем же email регистрируются заново', async () => {
    const email = freshEmail();
    await rejectedRegistration(email);

    expect(await register(email)).toBe(201);

    // Две строки на один адрес — то самое следствие частичного индекса: архивная и действующая.
    const rows = await rowsByEmail(email);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deleted_at === null)).toHaveLength(1);
  });

  it('вход находит действующую учётку, а не архивную', async () => {
    const email = freshEmail();
    await rejectedRegistration(email);
    expect(await register(email)).toBe(201);
    const live = (await rowsByEmail(email)).find((r) => r.deleted_at === null)!;

    // Заявка входить не может (учётка не активирована), и это здесь важнее самого 403: важно,
    // что сервер дошёл до живой строки, а не отказал по архивной как по «неверным данным».
    await ctx.db.execute(
      sql`UPDATE users SET is_active = true, role = 'admin' WHERE id = ${live.id}`,
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextAddress(),
      payload: { email, password: USER_PASSWORD },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user.id).toBe(live.id);
  });

  it('восстановление возвращает отказ в очередь заявок, но не активирует учётку', async () => {
    const email = freshEmail();
    const id = await rejectedRegistration(email);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${id}/restore`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ deletedAt: null, isActive: false, role: null });
    const [row] = await rowsByEmail(email);
    expect(row).toMatchObject({ deleted_at: null, is_active: false, role: null });
  });

  it('восстановление отказывает, если адрес занят другой учёткой', async () => {
    const email = freshEmail();
    const id = await rejectedRegistration(email);
    expect(await register(email)).toBe(201);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${id}/restore`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain(email);
  });

  it('удаление насовсем сносит архивную заявку и оставляет реквизиты в журнале', async () => {
    const email = freshEmail();
    const id = await rejectedRegistration(email);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${id}/purge`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(await rowsByEmail(email)).toHaveLength(0);
    // По entityId после удаления искать уже нечего — адрес обязан остаться в журнале.
    const audit = await ctx.db.execute<{ metadata: { email?: string } }>(
      sql`SELECT metadata FROM audit_log
          WHERE action = 'user.purge' AND entity_id = ${id} LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata.email).toBe(email);
  });

  it('учётку, на которую ссылается заявка вывоза, удалить насовсем нельзя', async () => {
    const email = freshEmail();
    const id = await rejectedRegistration(email);
    // Заявка заводится напрямую: важен сам внешний ключ `waste_requests.created_by` (RESTRICT),
    // а не путь, которым заявка появилась.
    await ctx.db.execute(sql`
      INSERT INTO waste_requests (object_id, request_type, delivery_at, created_by)
      VALUES (${ctx.objectId}, 'container_removal', now(), ${id})`);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${id}/purge`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(409);
    // Отказ называет, кто держит запись: без названия таблицы человеку нечего с ним делать.
    expect(res.json().message).toContain('заявки на вывоз мусора');
    expect(await rowsByEmail(email)).toHaveLength(1);
  });

  it('живую учётку удалить насовсем нельзя — сначала архив', async () => {
    const email = freshEmail();
    expect(await register(email)).toBe(201);
    const [row] = await rowsByEmail(email);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/users/${row!.id}/purge`,
      headers: ctx.auth,
    });

    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain('не в архиве');
  });
});
