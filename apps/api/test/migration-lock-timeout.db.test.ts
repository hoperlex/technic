import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * A migration that cannot get its strong lock gives up instead of hanging the portal (owner decision
 * S-27). The migrations of a deploy run while the previous release serves; a file that needs ACCESS
 * EXCLUSIVE on a live table waits behind any transaction reading it, and every later query on the
 * table queues behind the waiting request. So each such file opens with
 * `SET LOCAL lock_timeout = '…'`, and this file proves on one of them — the one whose name ends in
 * `_service_request_done_at.sql` (`ADD COLUMN` on `service_requests`) — what the runbook promises:
 *
 *   · with a reader holding `service_requests`, the runner fails on the file with SQLSTATE 55P03
 *     after the declared timeout, not later and not at once;
 *   · nothing of the file stays: no journal row, no column, and the session's `lock_timeout` is back
 *     to what it was — `SET LOCAL` died with the runner's per-file transaction;
 *   · once the reader is gone, the same `applyMigrations` call — the rerun of the same deploy —
 *     applies the file.
 *
 * The file is applied by `applyMigrations` itself, not by a copy of its steps: the claim is about the
 * runner's transaction around each file, and a retelling could stay green after the runner changed.
 *
 * WHY ITS OWN DATABASE. The test rewinds the file (drops its column and deletes its journal row) and
 * holds a lock on `service_requests` for the whole timeout. On the shared run database a parallel
 * test file's `applyMigrations` would apply the rewound file itself, or wait behind the held lock and
 * fail its own setup. Locks and the runner's advisory lock are per database, so a database of its
 * own isolates both. Its name is `<run database>_lt_<run>`, so `pnpm check:db` removes it with the
 * run database if this file dies before `afterAll`.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:55980/technic_test \
 *     pnpm check:db migration-lock-timeout
 *
 * Without `TEST_DATABASE_URL` the database case is skipped, like every `*.db.test.ts`.
 */

const SOURCE = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const MIGRATION_SUFFIX = '_service_request_done_at.sql';

const MIGRATION_FILE = ((): string => {
  const files = listMigrationFiles().filter((name) => name.endsWith(MIGRATION_SUFFIX));
  if (files.length !== 1) {
    throw new Error(`expected exactly one migration *${MIGRATION_SUFFIX}, found ${files.length}`);
  }
  return files[0]!;
})();

/** The first SQL statement of the file: comments and blank lines skipped. */
const FIRST_STATEMENT = readMigration(MIGRATION_FILE)
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line !== '' && !line.startsWith('--'));

/**
 * The timeout the file declares, read from the file so that the bounds below follow an edit of the
 * value instead of pinning a copy of it.
 */
const DECLARED_TIMEOUT_MS = ((): number | null => {
  const match = /^SET LOCAL lock_timeout = '(\d+)s';$/.exec(FIRST_STATEMENT ?? '');
  return match ? Number(match[1]) * 1000 : null;
})();

/** `<source>_lt_<run>`, cut from the source name so that the run suffix always survives (limit 63). */
function ownDatabaseName(source: string): string {
  const suffix = `_lt_${RUN}`;
  return `${source.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
}

function withDatabase(url: string, name: string): string {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}

it('the file sets its lock timeout before it takes any lock', () => {
  // A lock taken before the `SET LOCAL` would wait without a limit, which is the hang this prevents.
  expect(DECLARED_TIMEOUT_MS, `first statement: ${FIRST_STATEMENT}`).not.toBeNull();
});

describe.skipIf(!SOURCE)('a strong lock not obtained in time rolls the file back', () => {
  let adminUrl = '';
  let ownName = '';
  let ownUrl = '';
  let migrator: pg.Client | null = null;
  let holder: pg.Client | null = null;
  let sessionTimeoutBefore = '';

  async function journalHas(client: pg.Client, name: string): Promise<boolean> {
    const res = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [name]);
    return res.rows.length > 0;
  }

  async function columnExists(client: pg.Client): Promise<boolean> {
    const res = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'service_requests'
          AND column_name = 'done_at'`,
    );
    return res.rows.length > 0;
  }

  async function sessionTimeout(client: pg.Client): Promise<string> {
    const res = await client.query<{ lock_timeout: string }>('SHOW lock_timeout');
    return res.rows[0]!.lock_timeout;
  }

  beforeAll(async () => {
    const source = new URL(SOURCE!);
    ownName = ownDatabaseName(source.pathname.slice(1));
    adminUrl = withDatabase(SOURCE!, 'postgres');
    ownUrl = withDatabase(SOURCE!, ownName);

    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${ownName}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${ownName}"`);
    } finally {
      await admin.end();
    }

    migrator = new pg.Client({ connectionString: ownUrl });
    await migrator.connect();
    // The first migrations need these and do not create them (ops does it before migrations).
    await migrator.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await migrator.query('CREATE EXTENSION IF NOT EXISTS citext');
    await migrator.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(migrator);

    // Rewind exactly this file: its column and its journal row. Nothing later in the chain depends
    // on the column; if something ever does, DROP COLUMN without CASCADE fails here, loudly.
    await migrator.query('ALTER TABLE service_requests DROP COLUMN done_at');
    await migrator.query('DELETE FROM _migrations WHERE name = $1', [MIGRATION_FILE]);
    sessionTimeoutBefore = await sessionTimeout(migrator);
  }, 180_000);

  afterAll(async () => {
    await holder?.end().catch(() => undefined);
    await migrator?.end().catch(() => undefined);
    if (!ownName) return;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${ownName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('a reader of service_requests: 55P03 after the declared timeout, nothing applied; the rerun applies the file', async () => {
    expect(DECLARED_TIMEOUT_MS).not.toBeNull();
    const declared = DECLARED_TIMEOUT_MS!;
    const runner = migrator!;
    expect(await journalHas(runner, MIGRATION_FILE)).toBe(false);
    expect(await columnExists(runner)).toBe(false);

    // The blocker is the weakest lock that conflicts with ACCESS EXCLUSIVE: a plain read inside an
    // open transaction, the "long report" of the deploy window.
    holder = new pg.Client({ connectionString: ownUrl });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT count(*) FROM service_requests');

    const started = Date.now();
    const failure = await applyMigrations(runner).then(
      () => null,
      (error: unknown) => error,
    );
    const elapsed = Date.now() - started;

    expect(failure).toMatchObject({ code: '55P03' });
    expect(String((failure as Error).message)).toContain('lock timeout');
    // Not at once (it really waited for the lock) and not much later than declared.
    expect(elapsed).toBeGreaterThanOrEqual(declared - 500);
    expect(elapsed).toBeLessThan(declared + 5_000);

    expect(await journalHas(runner, MIGRATION_FILE)).toBe(false);
    expect(await columnExists(runner)).toBe(false);
    expect(await sessionTimeout(runner)).toBe(sessionTimeoutBefore);

    await holder.query('ROLLBACK');
    await holder.end();
    holder = null;

    expect(await applyMigrations(runner)).toEqual([MIGRATION_FILE]);
    expect(await journalHas(runner, MIGRATION_FILE)).toBe(true);
    expect(await columnExists(runner)).toBe(true);
    // The successful file's SET LOCAL ended with its COMMIT and does not reach the next file.
    expect(await sessionTimeout(runner)).toBe(sessionTimeoutBefore);
  }, 60_000);
});
