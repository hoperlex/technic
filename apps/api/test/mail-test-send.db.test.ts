import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` после того, как выставлено окружение.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Отладочная отправка письма администратору — через настоящие HTTP-пути, на живой схеме.
 *
 * Зачем база. Проверяется не вёрстка письма (это дело `mail-templates.test.ts`), а два свойства,
 * которые живут в данных: письмо уходит только действующему администратору и помечается
 * отладочным, то есть не попадает ни в статистику запусков, ни в алерты. Ошибка в первом означает
 * рабочие данные на чужом ящике, ошибка во втором — проверку вёрстки, прочитанную как сбой
 * доставки.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test mail-test-send
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-mailtest-admin@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';
const DISPATCHER_EMAIL = 'db-mailtest-dispatcher@example.invalid';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  adminId: string;
  dispatcherId: string;
}

let ctx: Ctx;

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

let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

async function sendTest(body: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/admin/mail/test',
    headers: ctx.auth,
    payload: body,
  });
}

describe.skipIf(!DB_URL)('отладочная отправка письма (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const schema = await import('../src/db/schema');
    const passwordHash = await hashPassword(ADMIN_PASSWORD);

    await db.execute(sql`DELETE FROM users WHERE email IN (${ADMIN_EMAIL}, ${DISPATCHER_EMAIL})`);
    const [admin] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: '',
        passwordHash,
        role: 'admin',
        isActive: true,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });
    // Диспетчер — получатель, которому тест отправлять нельзя: рабочие данные письма он в портале
    // видит не все.
    const [dispatcher] = await db
      .insert(schema.users)
      .values({
        email: DISPATCHER_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Диспетчер',
        middleName: '',
        passwordHash,
        role: 'dispatcher',
        isActive: true,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });

    const { buildApp } = await import('../src/app');
    const app = await buildApp();
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: nextAddress(),
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json<{ accessToken: string }>().accessToken}` },
      adminId: admin!.id,
      dispatcherId: dispatcher!.id,
    };
  });

  afterAll(async () => {
    if (!ctx) return;
    await ctx.db.execute(
      sql`DELETE FROM mail_messages WHERE to_email IN (${ADMIN_EMAIL}, ${DISPATCHER_EMAIL})`,
    );
    await ctx.db.execute(
      sql`DELETE FROM users WHERE email IN (${ADMIN_EMAIL}, ${DISPATCHER_EMAIL})`,
    );
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('письмо уходит администратору, помечено тестовым и названо тестом в теме', async () => {
    const res = await sendTest({ kind: 'verify_email', toUserId: ctx.adminId });
    expect(res.statusCode).toBe(200);

    const row = await ctx.db.execute<{
      is_test: boolean;
      subject: string;
      body_text: string;
      kind: string;
    }>(
      sql`SELECT is_test, subject, body_text, kind FROM mail_messages
           WHERE to_email = ${ADMIN_EMAIL} ORDER BY created_at DESC LIMIT 1`,
    );
    const mail = row.rows[0];
    expect(mail?.is_test).toBe(true);
    expect(mail?.subject).toMatch(/^\[ТЕСТ\]/u);
    expect(mail?.kind).toBe('verify_email');
    // Ссылка в тестовом письме нерабочая: настоящий одноразовый токен на чужую учётку по кнопке
    // не выпускают.
    expect(mail?.body_text).toContain('test-link-not-valid');
    expect(mail?.body_text).toMatch(/недействительны/u);
  });

  it('получателю без роли администратора письмо не отправляется', async () => {
    const res = await sendTest({ kind: 'password_reset', toUserId: ctx.dispatcherId });

    expect(res.statusCode).toBe(400);
    const count = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM mail_messages WHERE to_email = ${DISPATCHER_EMAIL}`,
    );
    expect(count.rows[0]?.count).toBe('0');
  });

  it('несуществующему получателю — тот же отказ, а не 500', async () => {
    const res = await sendTest({ kind: 'password_reset', toUserId: randomUUID() });
    expect(res.statusCode).toBe(400);
  });

  it('один и тот же тест шлётся сколько угодно раз: дедупликация ему не мешает', async () => {
    const before = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM mail_messages WHERE to_email = ${ADMIN_EMAIL}`,
    );

    await sendTest({ kind: 'password_changed', toUserId: ctx.adminId });
    await sendTest({ kind: 'password_changed', toUserId: ctx.adminId });

    const after = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM mail_messages WHERE to_email = ${ADMIN_EMAIL}`,
    );
    expect(Number(after.rows[0]!.count)).toBe(Number(before.rows[0]!.count) + 2);
  });

  it('каждая отправка попадает в аудит', async () => {
    await sendTest({ kind: 'verify_email', toUserId: ctx.adminId });

    const res = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM audit_log
           WHERE action = 'mailing.test_sent' AND entity_id = ${ctx.adminId}`,
    );
    expect(Number(res.rows[0]!.count)).toBeGreaterThan(0);
  });

  it('список получателей — только действующие администраторы', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/mail/test-recipients',
      headers: ctx.auth,
    });

    expect(res.statusCode).toBe(200);
    const items = res.json<{ id: string; email: string }[]>();
    expect(items.some((i) => i.id === ctx.adminId)).toBe(true);
    expect(items.some((i) => i.id === ctx.dispatcherId)).toBe(false);
  });
});
