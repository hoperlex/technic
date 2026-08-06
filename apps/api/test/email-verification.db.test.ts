import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` после того, как выставлено окружение.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Регистрация с подтверждением адреса и восстановление пароля (ADR 0072) — через настоящие
 * HTTP-пути, на живой схеме.
 *
 * Зачем база и зачем целиком. Сценарий состоит из шагов, каждый из которых меняет состояние
 * следующего: заявка → письмо → подтверждение → активация. Проверять их порознь бессмысленно —
 * ошибка живёт ровно на стыках, и самый дорогой стык здесь «активация без подтверждения»: он
 * охраняет то, ради чего всё и делалось.
 *
 * Токен тест достаёт оттуда же, откуда его берёт человек, — из тела письма: в базе лежит только
 * хеш, и другого способа нет ни у кого.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test email-verification
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-verify-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';
const USER_PASSWORD = 'db-user-password-456';
const NEW_PASSWORD = 'db-user-password-789';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  issueCaptcha: (issuedAt?: number) => { token: string; code: string };
}

let ctx: Ctx;
const created: string[] = [];

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
  // Письма составляются и остаются в журнале: наружу тест ничего не отправляет.
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

/** Свой адрес на каждый запрос: почтовые ручки ограничены пятью попытками с IP. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function freshEmail(): string {
  const email = `db-verify-${randomUUID().slice(0, 8)}@example.invalid`;
  created.push(email);
  return email;
}

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
      captchaToken: captcha.token,
      captchaAnswer: captcha.code,
    },
  });
  return res.statusCode;
}

/** Токен берётся из тела письма — единственного места, где он вообще есть. */
async function tokenFromMail(email: string, kind: 'verify_email' | 'password_reset') {
  const res = await ctx.db.execute<{ body_text: string }>(
    sql`SELECT body_text FROM mail_messages
         WHERE to_email = ${email} AND kind = ${kind}
         ORDER BY created_at DESC LIMIT 1`,
  );
  const body = res.rows[0]?.body_text ?? '';
  return /token=([\w-]+)/u.exec(body)?.[1] ?? '';
}

async function userRow(email: string) {
  const res = await ctx.db.execute<{
    id: string;
    is_active: boolean;
    email_verified_at: Date | null;
    auth_version: number;
  }>(
    sql`SELECT id, is_active, email_verified_at, auth_version FROM users
         WHERE email = ${email} AND deleted_at IS NULL`,
  );
  return res.rows[0];
}

async function mailCount(email: string, kind: string): Promise<number> {
  const res = await ctx.db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM mail_messages
         WHERE to_email = ${email} AND kind = ${kind}`,
  );
  return Number(res.rows[0]?.count ?? '0');
}

describe.skipIf(!DB_URL)('подтверждение адреса и сброс пароля (живая схема)', () => {
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
        emailVerifiedAt: new Date(),
      });
    }

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextAddress(),
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const token = login.json<{ accessToken: string }>().accessToken;

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${token}` },
      issueCaptcha: (issuedAt) => {
        const challenge = issueCaptcha(issuedAt);
        return { token: challenge.token, code: challenge.code };
      },
    };
  });

  afterAll(async () => {
    if (!ctx) return;
    for (const email of created) {
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE to_email = ${email}`);
      await ctx.db.execute(sql`DELETE FROM users WHERE email = ${email}`);
    }
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('регистрация создаёт неподтверждённую заявку и письмо со ссылкой', async () => {
    const email = freshEmail();
    expect(await register(email)).toBe(201);

    const user = await userRow(email);
    expect(user?.email_verified_at).toBeNull();
    expect(await mailCount(email, 'verify_email')).toBe(1);
    // Ссылка ведёт на портал и несёт токен — иначе подтверждать нечем.
    expect(await tokenFromMail(email, 'verify_email')).not.toBe('');
  });

  it('активировать неподтверждённую заявку нельзя — ради этого всё и заведено', async () => {
    const email = freshEmail();
    await register(email);
    const user = await userRow(email);

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${user!.id}`,
      headers: ctx.auth,
      payload: { isActive: true, role: 'dispatcher' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/не подтверждён/u);
  });

  it('после подтверждения активация проходит', async () => {
    const email = freshEmail();
    await register(email);
    const token = await tokenFromMail(email, 'verify_email');

    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: nextAddress(),
      payload: { token },
    });
    expect(verify.statusCode).toBe(200);
    expect((await userRow(email))?.email_verified_at).not.toBeNull();

    const user = await userRow(email);
    const activate = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${user!.id}`,
      headers: ctx.auth,
      payload: { isActive: true, role: 'dispatcher' },
    });
    expect(activate.statusCode).toBe(200);
  });

  it('ссылка подтверждения срабатывает один раз', async () => {
    const email = freshEmail();
    await register(email);
    const token = await tokenFromMail(email, 'verify_email');

    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: nextAddress(),
      payload: { token },
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: nextAddress(),
      payload: { token },
    });

    expect(second.statusCode).toBe(400);
  });

  it('запрос сброса не рассказывает, есть ли такой адрес', async () => {
    const unknown = `db-verify-unknown-${randomUUID().slice(0, 8)}@example.invalid`;
    const captcha = ctx.issueCaptcha(Date.now() - 5_000);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      remoteAddress: nextAddress(),
      payload: { email: unknown, captchaToken: captcha.token, captchaAnswer: captcha.code },
    });

    // Тот же 202 и тот же текст, что и для существующей учётки, — но письма нет.
    expect(res.statusCode).toBe(202);
    expect(await mailCount(unknown, 'password_reset')).toBe(0);
  });

  it('сброс меняет пароль, поднимает auth_version и шлёт уведомление', async () => {
    const email = freshEmail();
    await register(email);
    const verifyToken = await tokenFromMail(email, 'verify_email');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      remoteAddress: nextAddress(),
      payload: { token: verifyToken },
    });
    const user = await userRow(email);
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${user!.id}`,
      headers: ctx.auth,
      payload: { isActive: true, role: 'dispatcher' },
    });
    const before = await userRow(email);

    const captcha = ctx.issueCaptcha(Date.now() - 5_000);
    const request = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      remoteAddress: nextAddress(),
      payload: { email, captchaToken: captcha.token, captchaAnswer: captcha.code },
    });
    expect(request.statusCode).toBe(202);

    const resetToken = await tokenFromMail(email, 'password_reset');
    const confirm = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      remoteAddress: nextAddress(),
      payload: { token: resetToken, newPassword: NEW_PASSWORD },
    });
    expect(confirm.statusCode).toBe(200);

    const after = await userRow(email);
    // Версия выросла: выданные access-токены перестают действовать сразу.
    expect(after!.auth_version).toBe(before!.auth_version + 1);
    // О смене пришло письмо — единственный сигнал владельцу, если восстанавливал не он.
    expect(await mailCount(email, 'password_changed')).toBe(1);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextAddress(),
      payload: { email, password: NEW_PASSWORD },
    });
    expect(login.statusCode).toBe(200);

    const oldLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextAddress(),
      payload: { email, password: USER_PASSWORD },
    });
    expect(oldLogin.statusCode).toBe(401);

    // Ссылка сброса погашена: повторно ею пароль не сменить.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/confirm',
      remoteAddress: nextAddress(),
      payload: { token: resetToken, newPassword: USER_PASSWORD },
    });
    expect(again.statusCode).toBe(400);
  });

  it('неподтверждённой заявке ссылку на сброс не присылают: у неё другой сценарий', async () => {
    const email = freshEmail();
    await register(email);

    const captcha = ctx.issueCaptcha(Date.now() - 5_000);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      remoteAddress: nextAddress(),
      payload: { email, captchaToken: captcha.token, captchaAnswer: captcha.code },
    });

    expect(res.statusCode).toBe(202);
    expect(await mailCount(email, 'password_reset')).toBe(0);
  });
});
