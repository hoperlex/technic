import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, readMigration } from '../src/db/migration-journal';

/**
 * The operator runs this CLI against the schema after 0363/0364. Its recovery advice must name
 * both seed sources: replaying 0155 alone cannot restore the later `mech_ordering` assignment.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const SCRATCH_DB = 'technic_role_migration_cli_test';
const API_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TSX = resolve(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)));
const PROBE_EMAIL = 'role-migration-cli-probe@example.invalid';
const TEST_PUBLIC_KEY = generateKeyPairSync('ed25519').publicKey.export({
  type: 'spki',
  format: 'pem',
});

let admin: pg.Client;
let client: pg.Client;

function urlFor(database: string): string {
  const url = new URL(DB_URL!);
  url.pathname = `/${database}`;
  return url.toString();
}

function runCli(): { status: number | null; output: string } {
  const result = spawnSync(TSX, ['src/check-role-migration.ts'], {
    cwd: API_DIR,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PUBLIC_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: urlFor(SCRATCH_DB),
      DATABASE_MIGRATION_URL: undefined,
      PGSSLROOTCERT: undefined,
      JWT_PUBLIC_KEY_PEM: TEST_PUBLIC_KEY,
      COOKIE_SECRET: 'test-cookie-secret-123456789',
      CSRF_SECRET: 'test-csrf-secret-123456789',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'test',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test',
    },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function mechOrderingSeed(): string {
  const migration = readMigration('0290_mech_ordering_grant.sql');
  const start = migration.indexOf('-- 6. Взведённые назначения');
  const end = migration.indexOf('-- 7. Два предохранителя');
  if (start < 0 || end <= start) throw new Error('Section 6 of migration 0290 was not found');
  return migration.slice(start, end);
}

describe.skipIf(!DB_URL)('role migration CLI on the schema after 0363/0364', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

    client = new pg.Client({ connectionString: urlFor(SCRATCH_DB) });
    await client.connect();
    for (const extension of ['pgcrypto', 'citext', 'pg_trgm']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`);
    }
    await applyMigrations(client);
    await client.query(
      `INSERT INTO users (email, last_name, first_name, password_hash, role, is_active)
       VALUES ($1, 'Probe', 'CLI', 'x', 'shtab', true)`,
      [PROBE_EMAIL],
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('refuses an account without a snapshot and names both seed sources', () => {
    const result = runCli();
    expect(result.status).toBe(1);
    expect(result.output).toContain('снимка нет');
    expect(result.output).toContain('раздела 6 миграции 0290');
  });

  it('still refuses after 0155 alone, then passes after the later 0290 seed', async () => {
    await client.query(readMigration('0155_site_role_prepare.sql'));
    const incomplete = runCli();
    expect(incomplete.status).toBe(1);
    expect(incomplete.output).toContain('не выдано: mech_ordering');

    await client.query(mechOrderingSeed());
    const ready = runCli();
    expect(ready.status).toBe(0);
    expect(ready.output).toContain('перевод эквивалентен для проверенных учёток');
  });

  it('does not describe zero remaining old roles as proof about transferred accounts', async () => {
    await client.query(`UPDATE users SET role = 'site' WHERE email = $1`, [PROBE_EMAIL]);
    const result = runCli();
    expect(result.status).toBe(0);
    expect(result.output).toContain('не подтверждает права уже переведённых учёток');
  });
});
