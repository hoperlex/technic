import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` после того, как выставлено окружение.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type { collectMetrics as CollectMetrics } from '../src/services/metrics';

/**
 * Метрики почты на живой схеме (§20).
 *
 * Зачем база. Метрика — это готовый SQL плюс формат, и ошибиться в ней можно ровно двумя способами:
 * посчитать не то (например вместе с отладочными письмами) или отдать текст, который Prometheus не
 * разберёт. Первое проверяется только данными, второе — самой строкой ответа. Цена ошибки здесь
 * необычная: сломанная метрика не мешает работе портала вовсе, зато молча выключает алерт, ради
 * которого её и завели.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test metrics
 */

const DB_URL = process.env.TEST_DATABASE_URL;

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  collectMetrics: typeof CollectMetrics;
  scheduleId: string;
  userId: string;
}

let ctx: Ctx;
const suffix = randomUUID().slice(0, 8);
const FAILED_EMAIL = `metrics-failed-${suffix}@example.invalid`;
const TEST_EMAIL = `metrics-test-${suffix}@example.invalid`;

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

/** Значение метрики с указанной меткой из текста ответа. */
function metricValue(text: string, name: string, label?: string): number | null {
  const pattern = label
    ? new RegExp(`^${name}\\{status="${label}"\\} (\\d+)$`, 'mu')
    : new RegExp(`^${name} (\\d+)$`, 'mu');
  const found = pattern.exec(text);
  return found ? Number(found[1]) : null;
}

describe.skipIf(!DB_URL)('метрики почты (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { collectMetrics } = await import('../src/services/metrics');

    const [user] = await db
      .insert(schema.users)
      .values({
        email: `metrics-admin-${suffix}@example.invalid`,
        lastName: 'Метрикин',
        firstName: 'Тест',
        middleName: '',
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    // Расписание с давно прошедшим временем: ровно то, что должно поднять тревогу «планировщик
    // молчит». Заводится выключенным и включается в самой проверке.
    const [schedule] = await db
      .insert(schema.mailingSchedules)
      .values({
        type: 'driver_routes',
        name: `Метрики ${suffix}`,
        isEnabled: false,
        periodicity: 'daily',
        sendAt: '18:00',
        windowFromDays: 1,
        windowToDays: 1,
        nextRunAt: new Date('2000-01-01T00:00:00Z'),
        createdBy: user!.id,
      })
      .returning({ id: schema.mailingSchedules.id });

    ctx = {
      db,
      closeDb,
      schema,
      collectMetrics,
      scheduleId: schedule!.id,
      userId: user!.id,
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.db.execute(sql`DELETE FROM mail_messages WHERE to_email LIKE ${`%${suffix}%`}`);
    await ctx.db
      .delete(ctx.schema.mailingSchedules)
      .where(eq(ctx.schema.mailingSchedules.id, ctx.scheduleId));
    await ctx.db.delete(ctx.schema.users).where(eq(ctx.schema.users.id, ctx.userId));
    await ctx.closeDb();
  });

  it('ответ разбирается как Prometheus: у каждой метрики есть HELP и TYPE', async () => {
    const text = await ctx.collectMetrics();

    expect(text).toMatch(/^# HELP technic_up /mu);
    expect(text).toMatch(/^# TYPE technic_up gauge$/mu);
    expect(text).toMatch(/^technic_up 1$/mu);
    // Ни одна строка значения не должна остаться без объявления типа: без него метрику не
    // подхватит ни один сборщик, а выглядеть ответ будет правдоподобно.
    const names = [...text.matchAll(/^([a-z_]+)(\{[^}]*\})? \d+$/gmu)].map((m) => m[1]);
    for (const name of new Set(names)) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  it('упавшее письмо видно в метрике: по ней и настраивается алерт', async () => {
    const before = (await ctx.collectMetrics()) as string;
    const wasFailed = metricValue(before, 'technic_mail_messages', 'failed') ?? 0;

    await ctx.db.insert(ctx.schema.mailMessages).values({
      kind: 'password_changed',
      dedupeKey: `metrics-failed:${suffix}`,
      toEmail: FAILED_EMAIL,
      subject: 'Метрики: упавшее письмо',
      bodyText: 'тело',
      status: 'failed',
      lastError: 'SMTP 550',
    });

    const after = await ctx.collectMetrics();
    expect(metricValue(after, 'technic_mail_messages', 'failed')).toBe(wasFailed + 1);
  });

  it('отладочные письма в метрику не попадают: проверка вёрстки — не сбой доставки', async () => {
    const before = await ctx.collectMetrics();
    const wasFailed = metricValue(before, 'technic_mail_messages', 'failed') ?? 0;

    await ctx.db.insert(ctx.schema.mailMessages).values({
      kind: 'password_changed',
      dedupeKey: `metrics-test:${suffix}`,
      toEmail: TEST_EMAIL,
      subject: '[ТЕСТ] Метрики: отладочное письмо',
      bodyText: 'тело',
      status: 'failed',
      isTest: true,
    });

    const after = await ctx.collectMetrics();
    expect(metricValue(after, 'technic_mail_messages', 'failed')).toBe(wasFailed);
  });

  it('расписание с давно прошедшим временем поднимает счётчик просроченных', async () => {
    const before = await ctx.collectMetrics();
    const wasOverdue = metricValue(before, 'technic_mailing_schedules_overdue') ?? 0;

    await ctx.db
      .update(ctx.schema.mailingSchedules)
      .set({ isEnabled: true })
      .where(eq(ctx.schema.mailingSchedules.id, ctx.scheduleId));

    const after = await ctx.collectMetrics();
    // Растёт только когда планировщик молчит: штатный запуск сдвигает время сразу же.
    expect(metricValue(after, 'technic_mailing_schedules_overdue')).toBe(wasOverdue + 1);
  });

  it('выключенное расписание просроченным не считается', async () => {
    await ctx.db
      .update(ctx.schema.mailingSchedules)
      .set({ isEnabled: false })
      .where(eq(ctx.schema.mailingSchedules.id, ctx.scheduleId));

    const text = await ctx.collectMetrics();
    const overdue = metricValue(text, 'technic_mailing_schedules_overdue') ?? 0;

    await ctx.db
      .update(ctx.schema.mailingSchedules)
      .set({ isEnabled: true })
      .where(eq(ctx.schema.mailingSchedules.id, ctx.scheduleId));
    const enabled =
      metricValue(await ctx.collectMetrics(), 'technic_mailing_schedules_overdue') ?? 0;

    expect(enabled).toBe(overdue + 1);
  });
});
