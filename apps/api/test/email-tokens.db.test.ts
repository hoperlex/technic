import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` после того, как выставлено окружение.
import type { db as AppDb } from '../src/db/client';
import type {
  consumeEmailToken as ConsumeEmailToken,
  issueEmailToken as IssueEmailToken,
  revokeEmailTokens as RevokeEmailTokens,
} from '../src/services/email-tokens';

/**
 * Одноразовые ссылки из писем на живой схеме (ADR 0072, миграция 0098).
 *
 * Зачем база. Одноразовость держит условие обновления, а не код: строку гасит тот же `UPDATE`,
 * который её находит. Проверить это на правилах нельзя — расходятся не правила, а код и схема, и
 * ошибка здесь означает ссылку, срабатывающую дважды. По той же причине тут проверяется, что в
 * базе лежит хеш, а не сам токен: увидеть это можно только в самой строке.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test email-tokens
 */

const DB_URL = process.env.TEST_DATABASE_URL;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  issueEmailToken: typeof IssueEmailToken;
  consumeEmailToken: typeof ConsumeEmailToken;
  revokeEmailTokens: typeof RevokeEmailTokens;
  userId: string;
  sha256hex: (v: string) => string;
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

const EMAIL = `db-tokens-${randomUUID().slice(0, 8)}@example.invalid`;

describe.skipIf(!DB_URL)('одноразовые ссылки из писем (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const tokens = await import('../src/services/email-tokens');
    const { sha256hex } = await import('../src/lib/crypto');
    const schema = await import('../src/db/schema');

    const [user] = await db
      .insert(schema.users)
      .values({
        email: EMAIL,
        lastName: 'Токенов',
        firstName: 'Тест',
        middleName: '',
        passwordHash: 'x',
        isActive: false,
      })
      .returning({ id: schema.users.id });

    ctx = {
      db,
      closeDb,
      issueEmailToken: tokens.issueEmailToken,
      consumeEmailToken: tokens.consumeEmailToken,
      revokeEmailTokens: tokens.revokeEmailTokens,
      userId: user!.id,
      sha256hex,
    };
  });

  afterAll(async () => {
    if (!ctx) return;
    // Токены уедут каскадом вместе с учёткой (ON DELETE CASCADE).
    await ctx.db.execute(sql`DELETE FROM users WHERE email = ${EMAIL}`);
    await ctx.closeDb();
  });

  it('в базе лежит хеш, а не сам токен', async () => {
    const { token } = await ctx.issueEmailToken({
      userId: ctx.userId,
      purpose: 'verify_email',
      ttlSeconds: 3600,
    });

    const res = await ctx.db.execute<{ token_hash: string }>(
      sql`SELECT token_hash FROM user_email_tokens WHERE user_id = ${ctx.userId}
          AND purpose = 'verify_email' AND used_at IS NULL`,
    );
    expect(res.rows[0]?.token_hash).toBe(ctx.sha256hex(token));
    expect(res.rows[0]?.token_hash).not.toBe(token);
  });

  it('ссылка срабатывает один раз', async () => {
    const { token } = await ctx.issueEmailToken({
      userId: ctx.userId,
      purpose: 'verify_email',
      ttlSeconds: 3600,
    });

    expect(await ctx.consumeEmailToken(token, 'verify_email')).toEqual({ userId: ctx.userId });
    // Второй переход по той же ссылке — как по несуществующей.
    expect(await ctx.consumeEmailToken(token, 'verify_email')).toBeNull();
  });

  it('выпуск новой ссылки гасит прежнюю: иначе действующих было бы несколько', async () => {
    const first = await ctx.issueEmailToken({
      userId: ctx.userId,
      purpose: 'password_reset',
      ttlSeconds: 3600,
    });
    const second = await ctx.issueEmailToken({
      userId: ctx.userId,
      purpose: 'password_reset',
      ttlSeconds: 3600,
    });

    expect(await ctx.consumeEmailToken(first.token, 'password_reset')).toBeNull();
    expect(await ctx.consumeEmailToken(second.token, 'password_reset')).toEqual({
      userId: ctx.userId,
    });
  });

  it('просроченная ссылка не срабатывает', async () => {
    const { token } = await ctx.issueEmailToken({
      userId: ctx.userId,
      purpose: 'verify_email',
      ttlSeconds: 3600,
    });
    // Состаривается вся строка: CHECK держит `expires_at > created_at`, и сдвинуть один только
    // срок нельзя — в проде такой строки и не бывает.
    await ctx.db.execute(
      sql`UPDATE user_email_tokens
             SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
           WHERE token_hash = ${ctx.sha256hex(token)}`,
    );

    expect(await ctx.consumeEmailToken(token, 'verify_email')).toBeNull();
  });

  it('ссылка одного назначения не годится для другого', async () => {
    const { token } = await ctx.issueEmailToken({
      userId: ctx.userId,
      purpose: 'verify_email',
      ttlSeconds: 3600,
    });

    // Подтверждением адреса нельзя сменить пароль, даже зная значение.
    expect(await ctx.consumeEmailToken(token, 'password_reset')).toBeNull();
    expect(await ctx.consumeEmailToken(token, 'verify_email')).toEqual({ userId: ctx.userId });
  });

  it('после смены пароля все оставшиеся ссылки сброса гаснут', async () => {
    const { token } = await ctx.issueEmailToken({
      userId: ctx.userId,
      purpose: 'password_reset',
      ttlSeconds: 3600,
    });

    await ctx.revokeEmailTokens(ctx.userId, 'password_reset');
    expect(await ctx.consumeEmailToken(token, 'password_reset')).toBeNull();
  });
});
