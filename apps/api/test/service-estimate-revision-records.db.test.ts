import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` уже после того, как выставлено окружение, —
// конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type {
  dropEstimateRevisions,
  readActiveEstimateFormat,
  recordEstimateRevision,
} from '../src/services/service-estimate-revision';

/**
 * Строка ревизии объёма работ: кто её пишет, кто гасит и что происходит при ПОЛНОМ СБРОСЕ сметы
 * (Э3 плана `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Р4).
 *
 * ЗАЧЕМ БАЗА. Предмет проверки — ровно то, чего на моках не существует: первичный ключ
 * `(request_id, revision)` и частичный уникальный индекс «одна активная ревизия на заявку». Сброс
 * сметы обнуляет номер, то есть следующее предъявление снова назовётся первым, — и без снятия
 * прежних строк оно упиралось бы в тот самый ключ. Проверить это можно только у базы: подменив её,
 * мы проверили бы собственное представление о ней.
 *
 * ПОЧЕМУ НЕ ЧЕРЕЗ РУЧКИ ПОРТАЛА. Цикл заявки водят соседние файлы (`service-request-flow`,
 * `service-estimate-breakdown`), и они же покрывают предъявление целиком. Здесь проверяется одно
 * узкое утверждение о таблице — фикстура прямым SQL короче и не ломается от переделки ручек,
 * которая идёт в соседних волнах.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: файл считает СВОИ строки уникальными индексами, а
 * в общей базе рядом работают соседи. Механизм тот же, что у `service-estimate-breakdown`.
 *
 * Запуск (из `apps/api`; базу тест заводит и сносит сам, из адреса берётся только кластер):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/service-estimate-revision-records.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_sr_estimate_revision_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  userId: string;
  requestId: string;
  record: typeof recordEstimateRevision;
  drop: typeof dropEstimateRevisions;
  readFormat: typeof readActiveEstimateFormat;
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

async function withAdmin(action: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_DB });
  await client.connect();
  try {
    await action(client);
  } finally {
    await client.end();
  }
}

describe.skipIf(!DB_URL)('строка ревизии объёма работ (живая схема)', () => {
  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await client.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    });
    const own = new pg.Client({ connectionString: OWN_DB });
    await own.connect();
    try {
      // Без расширений миграции не идут: их ставит владелец базы, а не миграция.
      for (const ext of ['pgcrypto', 'citext', 'pg_trgm']) {
        await own.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
      }
      await applyMigrations(own);
    } finally {
      await own.end();
    }
    prepareEnv(OWN_DB!);
    const client = await import('../src/db/client');
    const service = await import('../src/services/service-estimate-revision');
    const user = await client.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, last_name, first_name, is_active)
      VALUES (${`rev-${RUN}@example.test`}, 'x', 'Тестов', 'Тест', true)
      RETURNING id`);
    const userId = user.rows[0]!.id;
    // Предмет заявки обязателен ограничением `service_requests_subject_check`: либо площадка, либо
    // отдел. Берём отдел — он самый дешёвый из двух и к предмету проверки отношения не имеет.
    const department = await client.db.execute<{ id: string }>(sql`
      INSERT INTO departments (code, name)
      VALUES (${`REV-${RUN}`}, ${`Отдел ревизий ${RUN}`})
      RETURNING id`);
    const request = await client.db.execute<{ id: string }>(sql`
      INSERT INTO service_requests (equipment_name, description, created_by, customer_department_id)
      VALUES (${`Аппарат ${RUN}`}, 'Проверка ревизий', ${userId}, ${department.rows[0]!.id})
      RETURNING id`);
    ctx = {
      db: client.db,
      closeDb: client.closeDb,
      userId,
      requestId: request.rows[0]!.id,
      record: service.recordEstimateRevision,
      drop: service.dropEstimateRevisions,
      readFormat: service.readActiveEstimateFormat,
    };
  }, 180_000);

  afterAll(async () => {
    await ctx?.closeDb();
    if (!DB_URL) return;
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
    });
  });

  async function rows(): Promise<
    { revision: number; format: string; state: string; total: string | null }[]
  > {
    const res = await ctx.db.execute<{
      revision: number;
      format: string;
      state: string;
      total: string | null;
    }>(sql`SELECT revision, format, state, total_amount AS total
             FROM service_request_estimate_revisions
            WHERE request_id = ${ctx.requestId}
            ORDER BY revision`);
    return res.rows;
  }

  it('предъявление пишет действующую ревизию, следующее гасит прежнюю', async () => {
    await ctx.db.transaction(async (tx) =>
      ctx.record(tx, {
        requestId: ctx.requestId,
        revision: 1,
        format: 'items',
        submittedBy: ctx.userId,
        totalAmount: '7100.00',
      }),
    );
    await ctx.db.transaction(async (tx) =>
      ctx.record(tx, {
        requestId: ctx.requestId,
        revision: 2,
        // Гарантийный формат: ноль — законная цена, а не «сумма неизвестна».
        format: 'warranty',
        submittedBy: ctx.userId,
        totalAmount: '0.00',
      }),
    );
    expect(await rows()).toEqual([
      { revision: 1, format: 'items', state: 'superseded', total: '7100.00' },
      { revision: 2, format: 'warranty', state: 'active', total: '0.00' },
    ]);
    expect(await ctx.readFormat(ctx.db, ctx.requestId)).toBe('warranty');
  });

  it('полный сброс сметы снимает ревизии — иначе нумерация с нуля упрётся в первичный ключ', async () => {
    // Сперва показываем сам замок: номер, занятый прежним предъявлением, база второй раз не отдаст.
    await expect(
      ctx.db.transaction(async (tx) =>
        tx.execute(sql`
          INSERT INTO service_request_estimate_revisions (request_id, revision, format, state)
          VALUES (${ctx.requestId}, 1, 'items', 'superseded')`),
      ),
    ).rejects.toThrow();

    await ctx.db.transaction(async (tx) => ctx.drop(tx, ctx.requestId));
    expect(await rows()).toEqual([]);
    expect(await ctx.readFormat(ctx.db, ctx.requestId)).toBeNull();

    // После сброса нумерация идёт заново — и первое предъявление проходит, как у новой заявки.
    await ctx.db.transaction(async (tx) =>
      ctx.record(tx, {
        requestId: ctx.requestId,
        revision: 1,
        format: 'items',
        submittedBy: ctx.userId,
        totalAmount: '500.00',
      }),
    );
    expect(await rows()).toEqual([
      { revision: 1, format: 'items', state: 'active', total: '500.00' },
    ]);
  });

  it('вторая действующая ревизия невозможна: за этим следит индекс, а не порядок вызовов', async () => {
    await expect(
      ctx.db.transaction(async (tx) =>
        tx.execute(sql`
          INSERT INTO service_request_estimate_revisions (request_id, revision, format, state)
          VALUES (${ctx.requestId}, 9, 'items', 'active')`),
      ),
    ).rejects.toThrow();
    // Автор ревизии — его же и записали: без него денежное решение осталось бы безымянным (Н5).
    const active = await ctx.db.execute<{ submitted_by: string }>(sql`
      SELECT submitted_by FROM service_request_estimate_revisions
       WHERE request_id = ${ctx.requestId} AND state = 'active'`);
    expect(active.rows[0]!.submitted_by).toBe(ctx.userId);
  });
});
