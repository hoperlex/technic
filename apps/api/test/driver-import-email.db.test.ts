import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type { applyDriverImport as ApplyDriverImport } from '../src/services/driver-import-apply';

/**
 * Email водителя из кадровой выгрузки — на живой схеме.
 *
 * Зачем база. Адрес — единственное, что выгрузка правит у уже заведённого человека, и правило у
 * этой правки трёхчастное: колонки нет — не трогаем, адрес тот же — не трогаем, адрес другой —
 * пишем и поднимаем версию карточки. Проверяется оно записью в `persons`, а не разбором файла:
 * разбор про заведённых людей ничего не знает. Заодно проверяется, что `dryRun` действительно
 * ничего не пишет — на нём строится весь порядок работы с чужим файлом.
 *
 * Запуск — как у остальных db-тестов (README, `docs/runbook.md`):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test driver-import-email
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/**
 * СНИЛС генерируется, а не берётся из тестового набора сида: база общая, номера сида в ней уже
 * заняты живыми карточками, на которые ссылаются путевые листы, — и убрать за собой такого
 * человека тест не смог бы. Контрольное число считается правилами ПФР, иначе разбор отвергнет
 * номер раньше, чем дело дойдёт до базы.
 */
function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
}

const SNILS_A = makeSnils();
const SNILS_B = makeSnils();

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  applyDriverImport: typeof ApplyDriverImport;
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

/** Свои ФИО на каждый сценарий: однофамильцы в отчёте — отдельная история, здесь она мешает. */
function freshName(): string {
  return `Выгрузкин${randomUUID().slice(0, 8)} Иван Иванович`;
}

function file(who: string, snils: string, email?: string) {
  return { drivers: [{ fullName: who, snils, categories: 'B,C', ...(email ? { email } : {}) }] };
}

async function personBySnils(
  snils: string,
): Promise<{ id: string; email: string; version: number } | undefined> {
  const res = await ctx.db.execute<{ id: string; email: string; version: number }>(
    sql`SELECT id, email, version FROM persons WHERE snils = ${snils}`,
  );
  return res.rows[0];
}

describe.skipIf(!DB_URL)('email водителя из кадровой выгрузки (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { applyDriverImport } = await import('../src/services/driver-import-apply');
    ctx = { db, closeDb, applyDriverImport };
  });

  afterAll(async () => {
    if (!ctx) return;
    // Убирается только заведённое этим тестом: номера сгенерированы, ссылаться на них нечему.
    await ctx.db.execute(sql`DELETE FROM persons WHERE snils IN (${SNILS_A}, ${SNILS_B})`);
    await ctx.closeDb();
  });

  it('колонки нет — заводится без адреса, пустой строкой', async () => {
    const who = freshName();
    const report = await ctx.applyDriverImport(file(who, SNILS_A), { dryRun: false });

    expect(report.created).toContain(who);
    expect(report.emailUpdated).toEqual([]);
    expect((await personBySnils(SNILS_A))?.email).toBe('');
  });

  it('адрес из выгрузки проставляется заведённому раньше и поднимает версию карточки', async () => {
    const who = freshName();
    const before = await personBySnils(SNILS_A);

    const report = await ctx.applyDriverImport(file(who, SNILS_A, 'driver@example.invalid'), {
      dryRun: false,
    });

    // Человек не заводится заново — совпал СНИЛС, ключ человека (ADR 0037).
    expect(report.created).toEqual([]);
    expect(report.emailUpdated).toEqual([{ who, email: 'driver@example.invalid' }]);

    const after = await personBySnils(SNILS_A);
    expect(after?.email).toBe('driver@example.invalid');
    // Версия растёт: иначе открытая у кого-то форма сохранилась бы поверх и вернула прежний адрес.
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it('повтор той же выгрузки ничего не переписывает: адрес тот же — правки нет', async () => {
    const who = freshName();
    const before = await personBySnils(SNILS_A);

    const report = await ctx.applyDriverImport(file(who, SNILS_A, 'driver@example.invalid'), {
      dryRun: false,
    });

    expect(report.emailUpdated).toEqual([]);
    expect((await personBySnils(SNILS_A))?.version).toBe(before?.version);
  });

  it('выгрузка без колонки адрес не стирает: её молчание — не «адреса нет»', async () => {
    const who = freshName();

    const report = await ctx.applyDriverImport(file(who, SNILS_A), { dryRun: false });

    expect(report.emailUpdated).toEqual([]);
    expect((await personBySnils(SNILS_A))?.email).toBe('driver@example.invalid');
  });

  it('dryRun показывает будущую правку, но базу не трогает', async () => {
    const who = freshName();

    const report = await ctx.applyDriverImport(file(who, SNILS_A, 'another@example.invalid'), {
      dryRun: true,
    });

    expect(report.emailUpdated).toEqual([{ who, email: 'another@example.invalid' }]);
    expect((await personBySnils(SNILS_A))?.email).toBe('driver@example.invalid');
  });

  it('новый человек заводится сразу с адресом из выгрузки', async () => {
    const who = freshName();

    const report = await ctx.applyDriverImport(file(who, SNILS_B, 'new@example.invalid'), {
      dryRun: false,
    });

    expect(report.created).toContain(who);
    expect((await personBySnils(SNILS_B))?.email).toBe('new@example.invalid');
  });
});
