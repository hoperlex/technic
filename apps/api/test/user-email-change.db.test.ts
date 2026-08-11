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
 * Смена адреса учётной записи администратором (ADR 0092) — через настоящие HTTP-пути, на живой
 * схеме.
 *
 * Зачем база. Адрес — это логин, и почти всё, что смена обязана сделать, держится не кодом, а
 * схемой: занятость адреса — частичным UNIQUE (архив адрес не занимает, ADR 0063), одновременные
 * запросы — блокировкой строки, письма и сама смена — общей транзакцией, а одноразовость ссылок
 * восстановления — условием обновления. На моках всё это выглядело бы работающим: два запроса
 * увидели бы одно старое состояние и оба сочли бы адрес свободным.
 *
 * Вторая причина — вход. Проверять «старым адресом больше не пускает» осмысленно только настоящим
 * `POST /auth/login` с настоящим хешем пароля: именно там сходятся адрес, `deleted_at` и версия
 * токенов.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   createdb technic_email_change_test && psql technic_email_change_test -c
 *     'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;
 *      CREATE EXTENSION IF NOT EXISTS pg_trgm'
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_email_change_test \
 *     pnpm --filter @technic/api test user-email-change
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-email-change-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';
/** Пароль подопытных учёток: им же проверяется вход по новому адресу. */
const USER_PASSWORD = 'db-user-password-456';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  hashPassword: (password: string) => Promise<string>;
  adminId: string;
}

let ctx: Ctx;
/** Адреса, заведённые тестом: по ним же он за собой и убирает — база общая с другими файлами. */
const created: string[] = [];

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
  // Почта включена, но без внешней доставки: письма составляются в журнал и наружу не уходят.
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

/** Свой адрес на каждый запрос: вход ограничен по частоте с одного IP. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function freshEmail(prefix = 'db-mailchg'): string {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.invalid`;
  created.push(email);
  return email;
}

/**
 * Действующая учётка с известным паролем. Заводится напрямую в базе, а не через API: предмет
 * теста — смена адреса, и путь появления учётки на неё не влияет.
 */
async function makeUser(
  opts: { role?: string | null; isActive?: boolean; deleted?: boolean; email?: string } = {},
): Promise<{ id: string; email: string }> {
  const email = opts.email ?? freshEmail();
  if (!created.includes(email)) created.push(email);
  const hash = await ctx.hashPassword(USER_PASSWORD);
  // `null` — учётка без роли, то есть нерассмотренная заявка; по умолчанию — рядовой наблюдатель.
  const role = opts.role === undefined ? 'observer' : opts.role;
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active,
                       email_verified_at, deleted_at)
    VALUES (${email}, 'Тестов', 'Иван', '', ${hash}, ${role}::role,
            ${opts.isActive ?? true}, now(), ${opts.deleted ? sql`now()` : null})
    RETURNING id`);
  return { id: res.rows[0]!.id, email };
}

/** Нерассмотренная заявка на регистрацию: роли нет, учётка неактивна (ADR 0034). */
function makePendingRegistration(): Promise<{ id: string; email: string }> {
  return makeUser({ role: null, isActive: false });
}

function changeEmail(id: string, payload: Record<string, unknown>, auth = ctx.auth) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/users/${id}/email`,
    headers: auth,
    payload,
  });
}

function login(email: string, password = USER_PASSWORD) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email, password },
  });
}

interface MailRow {
  id: string;
  to_email: string;
  subject: string;
  body_text: string;
  dedupe_key: string;
}

/** Письма о смене адреса по учётке — в порядке появления. */
async function changeMails(userId: string): Promise<MailRow[]> {
  const res = await ctx.db.execute<MailRow>(
    sql`SELECT id, to_email, subject, body_text, dedupe_key FROM mail_messages
         WHERE user_id = ${userId} AND kind = 'email_changed' ORDER BY dedupe_key`,
  );
  return [...res.rows];
}

async function auditMeta(userId: string, action: string): Promise<Record<string, unknown>> {
  const res = await ctx.db.execute<{ metadata: Record<string, unknown> }>(
    sql`SELECT metadata FROM audit_log WHERE entity_id = ${userId} AND action = ${action}
         ORDER BY created_at DESC LIMIT 1`,
  );
  return res.rows[0]?.metadata ?? {};
}

async function userRow(id: string) {
  const res = await ctx.db.execute<{
    email: string;
    email_verified_at: Date | null;
    auth_version: number;
  }>(sql`SELECT email, email_verified_at, auth_version FROM users WHERE id = ${id}`);
  return res.rows[0]!;
}

/** Живые (непогашенные) ссылки учётки — по ним проверяется, что смена их сняла. */
async function liveTokens(userId: string, purpose: string): Promise<number> {
  const res = await ctx.db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM user_email_tokens
         WHERE user_id = ${userId} AND purpose = ${purpose}::email_token_purpose
           AND used_at IS NULL`,
  );
  return Number(res.rows[0]!.count);
}

describe.skipIf(!DB_URL)('смена адреса учётной записи (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const schema = await import('../src/db/schema');

    const [existing] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
    let adminId = existing?.id;
    if (!adminId) {
      const [row] = await db
        .insert(schema.users)
        .values({
          email: ADMIN_EMAIL,
          lastName: 'Тестовый',
          firstName: 'Администратор',
          middleName: '',
          passwordHash: await hashPassword(ADMIN_PASSWORD),
          role: 'admin',
          isActive: true,
          emailVerifiedAt: new Date(),
        })
        .returning({ id: schema.users.id });
      adminId = row!.id;
    }

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const auth = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextAddress(),
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(auth.statusCode, auth.body).toBe(200);

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${auth.json<{ accessToken: string }>().accessToken}` },
      hashPassword,
      adminId: adminId!,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    for (const email of created) {
      await ctx.db.execute(sql`DELETE FROM jobs WHERE payload ->> 'mailMessageId' IN (
        SELECT id::text FROM mail_messages WHERE to_email = ${email})`);
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE to_email = ${email}`);
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE entity_type = 'user'
        AND entity_id IN (SELECT id::text FROM users WHERE email = ${email})`);
      await ctx.db.execute(sql`DELETE FROM users WHERE email = ${email}`);
    }
    await ctx.app.close();
    await ctx.closeDb();
  });

  describe('состоявшаяся смена', () => {
    it('переносит вход, подтверждает адрес и шлёт письма на оба ящика', async () => {
      const user = await makeUser();
      const next = freshEmail('db-mailchg-new');

      const res = await changeEmail(user.id, { newEmail: next });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        notifiedNew: 'queued',
        notifiedOld: 'queued',
        shadowsArchived: false,
        user: { email: next },
      });

      // Вход перенесён: прежний адрес портал больше не знает, новый пускает с тем же паролем.
      expect((await login(user.email)).statusCode).toBe(401);
      expect((await login(next)).statusCode).toBe(200);

      const row = await userRow(user.id);
      expect(row.email).toBe(next);
      // Адрес, который ввёл администратор, он же и проверил (ADR 0072): сброс подтверждения тихо
      // выключил бы человеку ролевые дайджесты — они рассылаются только подтверждённым.
      expect(row.email_verified_at).not.toBeNull();

      // Письма два и уходят они на разные ящики. На прежний — с маскированным новым адресом:
      // ящик уже чужой учётке, и полный адрес в нём лишний.
      const mails = await changeMails(user.id);
      expect(mails.map((m) => m.to_email).sort()).toEqual([next, user.email].sort());
      const old = mails.find((m) => m.to_email === user.email)!;
      expect(old.body_text).toContain(`${next.slice(0, 1)}***@example.invalid`);
      expect(old.body_text).not.toContain(next);
      expect(mails.find((m) => m.to_email === next)!.body_text).toContain(next);

      expect(await auditMeta(user.id, 'user.change_email')).toMatchObject({
        oldEmail: user.email,
        newEmail: next,
        notifiedNew: 'queued',
        notifiedOld: 'queued',
        self: false,
      });
    });

    it('гасит живые ссылки восстановления, ушедшие на прежний адрес', async () => {
      const user = await makeUser();
      const { issueEmailToken } = await import('../src/services/email-tokens');
      const { token } = await issueEmailToken({
        userId: user.id,
        purpose: 'password_reset',
        ttlSeconds: 3600,
      });
      expect(await liveTokens(user.id, 'password_reset')).toBe(1);

      const next = freshEmail('db-mailchg-new');
      expect((await changeEmail(user.id, { newEmail: next })).statusCode).toBe(200);

      expect(await liveTokens(user.id, 'password_reset')).toBe(0);
      // Ссылка, ушедшая на прежний ящик, больше не работает: иначе его владелец задал бы пароль
      // учётке, которая теперь живёт на другом адресе.
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password-reset/confirm',
        remoteAddress: nextAddress(),
        payload: { token, newPassword: 'another-strong-password-987' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('смену туда и обратно не глушит дедупликацией писем', async () => {
      const user = await makeUser();
      const next = freshEmail('db-mailchg-new');

      expect((await changeEmail(user.id, { newEmail: next })).statusCode).toBe(200);
      // Обратно — то же событие с теми же адресами наоборот: ключ письма содержит время, иначе
      // второй паре писем помешал бы UNIQUE `(kind, dedupe_key)`.
      expect((await changeEmail(user.id, { newEmail: user.email })).statusCode).toBe(200);

      expect(await changeMails(user.id)).toHaveLength(4);
      expect((await userRow(user.id)).email).toBe(user.email);
    });
  });

  describe('занятость адреса', () => {
    it('отказывает, если адрес у действующей учётки', async () => {
      const user = await makeUser();
      const other = await makeUser();

      const res = await changeEmail(user.id, { newEmail: other.email });

      expect(res.statusCode).toBe(409);
      expect((await userRow(user.id)).email).toBe(user.email);
    });

    it('разрешает адрес архивной учётки и предупреждает об этом', async () => {
      const archived = await makeUser({ deleted: true });
      const user = await makeUser();

      const res = await changeEmail(user.id, { newEmail: archived.email });

      // Архив адрес не занимает (ADR 0063) — смена проходит; но восстановить архивную уже нельзя,
      // и портал обязан сказать об этом сразу, а не через полгода отказом на восстановление.
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ shadowsArchived: true });
      expect(await auditMeta(user.id, 'user.change_email')).toMatchObject({
        shadowsArchived: true,
      });
    });

    it('на два одновременных запроса с одним адресом отвечает 200 и 409', async () => {
      const first = await makeUser();
      const second = await makeUser();
      const target = freshEmail('db-mailchg-race');

      const results = await Promise.all([
        changeEmail(first.id, { newEmail: target }),
        changeEmail(second.id, { newEmail: target }),
      ]);

      // Проверка занятости внутри транзакции гонку не закрывает — её держит частичный UNIQUE, и
      // проигравший обязан получить тот же 409, что и при обычном дубле, а не 500.
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    });
  });

  describe('кого и когда трогать нельзя', () => {
    it('не меняет адрес нерассмотренной заявки', async () => {
      const pending = await makePendingRegistration();

      const res = await changeEmail(pending.id, { newEmail: freshEmail() });

      expect(res.statusCode).toBe(400);
      expect((await userRow(pending.id)).email).toBe(pending.email);
    });

    it('не меняет адрес архивной учётки', async () => {
      const archived = await makeUser({ deleted: true });

      expect((await changeEmail(archived.id, { newEmail: freshEmail() })).statusCode).toBe(404);
    });

    it('не меняет адрес чужой администраторской учётки', async () => {
      const otherAdmin = await makeUser({ role: 'admin' });

      const res = await changeEmail(otherAdmin.id, { newEmail: freshEmail() });

      // Смена логина отдаёт учётку целиком и тихо: администратора уводит только он сам.
      expect(res.statusCode).toBe(403);
      expect((await userRow(otherAdmin.id)).email).toBe(otherAdmin.email);
    });

    it('отказывает на адрес, совпадающий с текущим', async () => {
      const user = await makeUser();

      // Регистр адреса ничего не меняет: в БД он `citext`, и это тот же самый адрес.
      const res = await changeEmail(user.id, { newEmail: user.email.toUpperCase() });

      expect(res.statusCode).toBe(400);
      expect(await changeMails(user.id)).toHaveLength(0);
    });
  });

  describe('своя учётка', () => {
    it('без пароля не меняется, с верным паролем меняется', async () => {
      const selfEmail = freshEmail('db-mailchg-self');
      const next = freshEmail('db-mailchg-self-new');
      // Свой администратор с известным паролем: правило «чужого админа не трогают» проверяется
      // именно на своей учётке — она из-под запрета выведена.
      const me = await makeUser({ role: 'admin', email: selfEmail });
      const session = await login(selfEmail);
      expect(session.statusCode, session.body).toBe(200);
      const auth = {
        authorization: `Bearer ${session.json<{ accessToken: string }>().accessToken}`,
      };

      const without = await changeEmail(me.id, { newEmail: next }, auth);
      expect(without.statusCode).toBe(400);

      const wrong = await changeEmail(me.id, { newEmail: next, currentPassword: 'not-my' }, auth);
      expect(wrong.statusCode).toBe(400);
      expect((await userRow(me.id)).email).toBe(selfEmail);

      const ok = await changeEmail(me.id, { newEmail: next, currentPassword: USER_PASSWORD }, auth);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await userRow(me.id)).email).toBe(next);
      expect(await auditMeta(me.id, 'user.change_email')).toMatchObject({ self: true });
    });
  });
});
