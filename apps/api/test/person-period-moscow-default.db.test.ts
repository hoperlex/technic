import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, listMigrationFiles, migrationsDir } from '../src/db/migration-journal';

/**
 * The import and driver route omit `started_on` when the source has no employment date. Both DB
 * defaults must therefore use the same Moscow day even when the connection runs in UTC. A fixed
 * instant is evaluated through each installed default expression so the midnight case is stable
 * at any hour. The real inserts also prove that both columns still accept old API writes.
 *
 * An isolated database lets this test apply the prepared DDL without changing the shared db-test
 * schema. It works before and after the SQL is promoted from `pending/` into a numbered migration.
 */
const SOURCE = process.env.TEST_DATABASE_URL;
const OWN_SUFFIX = `_person_date_${randomUUID().slice(0, 8)}`;
const TABLES = ['person_employments', 'person_specializations'] as const;

function withDatabase(source: string, database: string): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

function preparedSql(): string {
  const promoted = listMigrationFiles().filter((name) =>
    name.endsWith('_person_period_moscow_start_default.sql'),
  );
  if (promoted.length > 1) throw new Error('person period default migration has duplicate numbers');
  const path = promoted[0]
    ? join(migrationsDir, promoted[0])
    : join(migrationsDir, 'pending', 'person-period-moscow-start-default.sql');
  return readFileSync(path, 'utf8');
}

async function installedDefault(client: pg.Client, table: string): Promise<string> {
  const result = await client.query<{ expression: string }>(
    `SELECT pg_get_expr(d.adbin, d.adrelid) AS expression
       FROM pg_attrdef d
       JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = $1::regclass AND a.attname = 'started_on'`,
    [table],
  );
  const expression = result.rows[0]?.expression;
  if (!expression) throw new Error(`${table}.started_on has no default`);
  return expression;
}

describe.skipIf(!SOURCE)('person period defaults use Moscow calendar dates', () => {
  let client: pg.Client | undefined;
  let ownName: string | undefined;
  let adminUrl: string;

  beforeAll(async () => {
    const sourceName = new URL(SOURCE!).pathname.slice(1);
    ownName = `${sourceName.slice(0, 63 - OWN_SUFFIX.length)}${OWN_SUFFIX}`;
    adminUrl = withDatabase(SOURCE!, 'postgres');
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${ownName}"`);
    } finally {
      await admin.end();
    }

    client = new pg.Client({ connectionString: withDatabase(SOURCE!, ownName) });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(client);
    await client.query(preparedSql());
  }, 180_000);

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    if (!ownName) return;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${ownName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('uses the next Moscow day after 21:00 UTC, for both installed defaults', async () => {
    await client!.query("SET TIME ZONE 'UTC'");
    for (const table of TABLES) {
      const expression = await installedDefault(client!, table);
      expect(expression).toMatch(/Europe\/Moscow/);
      expect(expression).toMatch(/now\(\)/i);
      const atFixedInstant = expression.replace(/now\(\)/gi, '$1::timestamptz');
      const before = await client!.query<{ day: string }>(
        `SELECT (${atFixedInstant})::text AS day`,
        ['2026-10-14T20:30:00Z'],
      );
      const after = await client!.query<{ day: string }>(
        `SELECT (${atFixedInstant})::text AS day`,
        ['2026-10-14T21:30:00Z'],
      );
      expect(before.rows[0]?.day).toBe('2026-10-14');
      expect(after.rows[0]?.day).toBe('2026-10-15');
    }
  });

  it('accepts omitted dates from old writers and stores one Moscow day', async () => {
    await client!.query('BEGIN');
    try {
      await client!.query("SET LOCAL TIME ZONE 'UTC'");
      const person = await client!.query<{ id: string }>(
        "INSERT INTO persons (last_name, first_name) VALUES ('Test', 'Moscow') RETURNING id",
      );
      const specialization = await client!.query<{ id: string }>(
        "INSERT INTO specializations (code, name) VALUES ('moscow_date_test', 'Date test') RETURNING id",
      );
      const employment = await client!.query<{ day: string }>(
        'INSERT INTO person_employments (person_id) VALUES ($1) RETURNING started_on::text AS day',
        [person.rows[0]!.id],
      );
      const personSpecialization = await client!.query<{ day: string }>(
        'INSERT INTO person_specializations (person_id, specialization_id) VALUES ($1, $2) RETURNING started_on::text AS day',
        [person.rows[0]!.id, specialization.rows[0]!.id],
      );
      const expected = await client!.query<{ day: string }>(
        "SELECT (now() AT TIME ZONE 'Europe/Moscow')::date::text AS day",
      );
      expect(employment.rows[0]?.day).toBe(expected.rows[0]?.day);
      expect(personSpecialization.rows[0]?.day).toBe(expected.rows[0]?.day);
    } finally {
      await client!.query('ROLLBACK');
    }
  });
});
