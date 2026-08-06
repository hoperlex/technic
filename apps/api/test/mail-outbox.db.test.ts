import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type { queueMail as QueueMail } from '../src/services/mail';

/**
 * Очередь исходящих писем на живой схеме (миграция 0097).
 *
 * Зачем база. Всё свойство «письмо не уйдёт дважды» держится на уникальном индексе
 * `(kind, dedupe_key)` и на порядке двух записей внутри транзакции: сначала журнал, потом задача.
 * Ни то, ни другое нельзя проверить на правилах — расходятся не правила, а код и схема: без индекса
 * второй вызов молча создаст второе письмо, и обнаружится это тем, что водитель получит задание
 * дважды. По той же причине здесь же проверяется, что дубль не оставляет задачу-сироту.
 *
 * Запуск — как у остальных db-тестов:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test mail-outbox
 */

const DB_URL = process.env.TEST_DATABASE_URL;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  queueMail: typeof QueueMail;
}

let ctx: Ctx;

/** Свой ключ на каждый сценарий: база общая, и порядок тестов ничего решать не должен. */
function freshKey(): string {
  return `db-test:${randomUUID()}`;
}

function content(text = 'Тело письма') {
  return { title: 'Проверка', blocks: [{ kind: 'paragraph' as const, text }] };
}

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
  // Почта включена, но без внешней доставки: тест проверяет очередь, а не SMTP.
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

async function jobsFor(mailId: string): Promise<number> {
  const res = await ctx.db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM jobs
        WHERE type = 'send_email' AND payload ->> 'mailMessageId' = ${mailId}`,
  );
  return Number(res.rows[0]?.count ?? '0');
}

describe.skipIf(!DB_URL)('очередь исходящих писем (живая схема)', () => {
  const keys: string[] = [];

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { queueMail } = await import('../src/services/mail');
    ctx = { db, closeDb, queueMail };
  });

  afterAll(async () => {
    if (!ctx) return;
    // Убирается только заведённое этим тестом: ключи свои, чужих писем в выборке нет.
    for (const key of keys) {
      await ctx.db.execute(sql`DELETE FROM jobs WHERE payload ->> 'mailMessageId' IN (
        SELECT id::text FROM mail_messages WHERE dedupe_key = ${key})`);
      await ctx.db.execute(sql`DELETE FROM mail_messages WHERE dedupe_key = ${key}`);
    }
    await ctx.closeDb();
  });

  function key(): string {
    const k = freshKey();
    keys.push(k);
    return k;
  }

  it('письмо и задача создаются вместе: одно без другого бессмысленно', async () => {
    const dedupeKey = key();
    const id = await ctx.queueMail({
      kind: 'password_changed',
      dedupeKey,
      to: 'driver@example.invalid',
      subject: 'Пароль изменён',
      content: content(),
    });

    expect(id).not.toBeNull();
    expect(await jobsFor(id!)).toBe(1);

    const res = await ctx.db.execute<{ status: string; body_text: string; sent_at: Date | null }>(
      sql`SELECT status, body_text, sent_at FROM mail_messages WHERE id = ${id}`,
    );
    // Тело сохраняется готовым: worker отправляет составленное, а не пересобранное.
    expect(res.rows[0]?.status).toBe('pending');
    expect(res.rows[0]?.body_text).toContain('Тело письма');
    expect(res.rows[0]?.sent_at).toBeNull();
  });

  it('повтор того же события не создаёт ни второго письма, ни второй задачи', async () => {
    const dedupeKey = key();
    const first = await ctx.queueMail({
      kind: 'driver_routes',
      dedupeKey,
      to: 'driver@example.invalid',
      subject: 'Задание на завтра',
      content: content(),
    });
    const second = await ctx.queueMail({
      kind: 'driver_routes',
      dedupeKey,
      to: 'driver@example.invalid',
      subject: 'Задание на завтра',
      content: content(),
    });

    // `null` — не ошибка: письмо уже составлено, работа сделана.
    expect(second).toBeNull();
    expect(await jobsFor(first!)).toBe(1);

    const res = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM mail_messages WHERE dedupe_key = ${dedupeKey}`,
    );
    expect(res.rows[0]?.count).toBe('1');
  });

  it('один ключ у разных видов писем — разные письма: ключ уникален внутри вида', async () => {
    const dedupeKey = key();
    const verify = await ctx.queueMail({
      kind: 'verify_email',
      dedupeKey,
      to: 'user@example.invalid',
      subject: 'Подтвердите адрес',
      content: content(),
    });
    const reset = await ctx.queueMail({
      kind: 'password_reset',
      dedupeKey,
      to: 'user@example.invalid',
      subject: 'Сброс пароля',
      content: content(),
    });

    expect(verify).not.toBeNull();
    expect(reset).not.toBeNull();
    expect(verify).not.toBe(reset);
  });

  it('отправленное письмо обязано знать, когда оно ушло', async () => {
    const dedupeKey = key();
    const id = await ctx.queueMail({
      kind: 'role_digest',
      dedupeKey,
      to: 'user@example.invalid',
      subject: 'Сводка за вчера',
      content: content(),
    });

    // Схема не даёт пометить письмо отправленным, не проставив время: иначе «отправлено» ничем
    // не подтверждается, а разбор жалобы упирается в пустую графу. Имя ограничения проверяется по
    // причине ошибки: drizzle заворачивает ответ БД в собственное сообщение «Failed query».
    const refused = await ctx.db
      .execute(sql`UPDATE mail_messages SET status = 'sent' WHERE id = ${id}`)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((refused as { cause?: { constraint?: string } })?.cause?.constraint).toBe(
      'mail_messages_sent_at_check',
    );

    await ctx.db.execute(
      sql`UPDATE mail_messages SET status = 'sent', sent_at = now() WHERE id = ${id}`,
    );
    const res = await ctx.db.execute<{ status: string }>(
      sql`SELECT status FROM mail_messages WHERE id = ${id}`,
    );
    expect(res.rows[0]?.status).toBe('sent');
  });

  it('при выключенной почте письмо не ставится молча — операция отказывает явно', async () => {
    const { config } = await import('../src/config');
    const enabled = config.mail.enabled;
    try {
      (config.mail as { enabled: boolean }).enabled = false;
      await expect(
        ctx.queueMail({
          kind: 'verify_email',
          dedupeKey: key(),
          to: 'user@example.invalid',
          subject: 'Подтвердите адрес',
          content: content(),
        }),
      ).rejects.toThrow(/отключена/u);
    } finally {
      (config.mail as { enabled: boolean }).enabled = enabled;
    }
  });
});
