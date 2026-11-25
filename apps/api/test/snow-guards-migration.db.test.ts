import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SNOW_WASTE_TYPE_ID, SNOW_WASTE_TYPE_NAME } from '@technic/contracts';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * Preflight and safe retry of migration 0429 (snow-removal plan §3.1, S11, and §4 «Rollout»).
 *
 * The owner reported that «Снег» was never created on production, but the plan does not rely on a
 * report: the file refuses to start when the reserved id, the code `snow` or the normalized name of
 * «Снег» is already taken, with a message a person can act on. What this file proves, per collision:
 *
 *   · `applyMigrations` fails on 0429 with the readable preflight message naming the colliding row,
 *     and the failure leaves NOTHING behind: no constraint, no trigger, no guard function, no
 *     reserved row, no journal row for 0429 or 0430, and the session's `lock_timeout` is what it
 *     was (the file's `SET LOCAL` died with its transaction);
 *   · a second attempt fails the same way (the deploy is retried before anyone has fixed anything);
 *   · after the collision is removed the SAME call applies 0429 and 0430 — the guards stand and the
 *     request check is validated (`convalidated = true`).
 *
 * The files are applied by `applyMigrations` itself, not by a retelling of their steps: the claims
 * are about the runner's transaction around each file.
 *
 * THE DATABASES. The database state "journal up to 0428" cannot be had by running the runner (it
 * applies everything), so a template database is built file by file up to the file before 0429 with
 * the runner's own transaction pattern, and every case is a copy of it (`CREATE DATABASE …
 * TEMPLATE`): a case that applied 0429 leaves nothing for the next one to undo. The names are
 * `<run database>_snowgrd_<run>…`, so `pnpm check:db` removes them with the run database if this
 * file dies before `afterAll`.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:55961/technic_test \
 *     pnpm check:db snow-guards-migration
 *
 * Without `TEST_DATABASE_URL` the database cases are skipped, like every `*.db.test.ts`.
 */

const SOURCE = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const RESERVED_ID = SNOW_WASTE_TYPE_ID;
const GUARDS_FILE = listMigrationFiles().find((f) => f.startsWith('0429_'))!;
const VALIDATE_FILE = listMigrationFiles().find((f) => f.startsWith('0430_'))!;
const PREFLIGHT_MESSAGE = 'Reserved waste type «Снег» collides with existing rows';

function withDatabase(url: string, name: string): string {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}

/** `<source>_snowgrd_<run><tail>`, cut from the source name so that the suffix survives (limit 63). */
function databaseName(source: string, tail: string): string {
  const suffix = `_snowgrd_${RUN}${tail}`;
  return `${source.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
}

/** The runner's own per-file transaction, for the files before 0429 only. */
async function applyBefore(client: pg.Client, firstExcluded: string): Promise<void> {
  await client.query(
    'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  for (const file of listMigrationFiles().filter((f) => f < firstExcluded)) {
    await client.query('BEGIN');
    try {
      await client.query(readMigration(file));
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
}

interface Collision {
  label: string;
  /** Rows that make the preflight stop. */
  insert: string;
  /** Fragments the message must carry: the row a person has to deal with. */
  names: string[];
}

const COLLISIONS: Collision[] = [
  {
    label: 'a waste type holds the reserved id',
    insert: `INSERT INTO waste_types (id, code, name)
             VALUES ('${RESERVED_ID}', 'occupied_${RUN}', 'Чужой тип на зарезервированном номере')`,
    names: [RESERVED_ID, 'occupied_', 'Чужой тип на зарезервированном номере'],
  },
  {
    label: 'a waste type has the code snow',
    insert: `INSERT INTO waste_types (code, name) VALUES ('snow', 'Снежный вывоз')`,
    names: ['code=snow', 'Снежный вывоз'],
  },
  {
    label: 'a name that normalizes like «Снег» («снег!»)',
    insert: `INSERT INTO waste_types (code, name) VALUES ('shouted_${RUN}', 'снег!')`,
    names: ['shouted_', 'снег!'],
  },
  {
    label: 'the same name with «ё» («Снёг»)',
    insert: `INSERT INTO waste_types (code, name) VALUES ('yo_${RUN}', 'Снёг')`,
    names: ['yo_', 'Снёг'],
  },
];

describe.skipIf(!SOURCE)('migration 0429: preflight and safe retry', () => {
  const sourceName = SOURCE ? new URL(SOURCE).pathname.slice(1) : '';
  const adminUrl = SOURCE ? withDatabase(SOURCE, 'postgres') : '';
  const templateName = databaseName(sourceName, '_tpl');
  const created: string[] = [templateName];

  async function admin(run: (client: pg.Client) => Promise<void>): Promise<void> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await run(client);
    } finally {
      await client.end();
    }
  }

  /** A copy of the "journal up to 0428" database, connected. */
  async function freshCopy(tail: string): Promise<{ client: pg.Client; name: string }> {
    const name = databaseName(sourceName, tail);
    created.push(name);
    await admin(async (a) => {
      await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await a.query(`CREATE DATABASE "${name}" TEMPLATE "${templateName}"`);
    });
    const client = new pg.Client({ connectionString: withDatabase(SOURCE!, name) });
    await client.connect();
    return { client, name };
  }

  async function dropCopy(client: pg.Client, name: string): Promise<void> {
    await client.end().catch(() => undefined);
    await admin((a) =>
      a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).then(() => undefined),
    );
  }

  /** What 0429 creates, as the catalog sees it. */
  async function guards(client: pg.Client): Promise<{
    constraints: string[];
    trigger: boolean;
    guardFunction: boolean;
    reservedRow: { code: string; name: string } | null;
    journal: string[];
  }> {
    const constraints = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('waste_types_service_snow_check',
                          'waste_tariffs_not_service_type_check',
                          'waste_requests_snow_subject_check')
        ORDER BY conname`,
    );
    const trigger = await client.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'waste_types_service_row_no_delete'`,
    );
    const fn = await client.query(
      `SELECT 1 FROM pg_proc WHERE proname = 'waste_types_service_row_guard'`,
    );
    const row = await client.query<{ code: string; name: string }>(
      'SELECT code, name FROM waste_types WHERE id = $1',
      [RESERVED_ID],
    );
    const journal = await client.query<{ name: string }>(
      'SELECT name FROM _migrations WHERE name = ANY($1) ORDER BY name',
      [[GUARDS_FILE, VALIDATE_FILE]],
    );
    return {
      constraints: constraints.rows.map((r) => r.conname),
      trigger: trigger.rows.length > 0,
      guardFunction: fn.rows.length > 0,
      reservedRow: row.rows[0] ?? null,
      journal: journal.rows.map((r) => r.name),
    };
  }

  async function failureOf(
    client: pg.Client,
  ): Promise<{ message: string; hint?: string; code?: string }> {
    const failure = await applyMigrations(client).then(
      () => null,
      (error: unknown) => error as { message: string; hint?: string; code?: string },
    );
    if (!failure) throw new Error('the runner applied 0429 over a collision');
    return failure;
  }

  async function sessionLockTimeout(client: pg.Client): Promise<string> {
    return (await client.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0]!
      .lock_timeout;
  }

  beforeAll(async () => {
    await admin(async (a) => {
      await a.query(`DROP DATABASE IF EXISTS "${templateName}" WITH (FORCE)`);
      await a.query(`CREATE DATABASE "${templateName}"`);
    });
    const template = new pg.Client({ connectionString: withDatabase(SOURCE!, templateName) });
    await template.connect();
    try {
      // The first migrations need these and do not create them (ops does it before migrations).
      await template.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await template.query('CREATE EXTENSION IF NOT EXISTS citext');
      await template.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyBefore(template, GUARDS_FILE);
    } finally {
      // A template database must have no sessions when it is copied.
      await template.end();
    }
  }, 240_000);

  afterAll(async () => {
    await admin(async (a) => {
      for (const name of created) await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    });
  }, 120_000);

  it('the template is what it claims: journal up to the file before 0429, no snow guards', async () => {
    const { client, name } = await freshCopy('_probe');
    try {
      expect(await guards(client)).toEqual({
        constraints: [],
        trigger: false,
        guardFunction: false,
        reservedRow: null,
        journal: [],
      });
      // And the value the guards refer to is the foundation's: 0427 added it.
      const enumValue = await client.query(
        `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'request_type' AND e.enumlabel = 'snow_removal'`,
      );
      expect(enumValue.rows).toHaveLength(1);
    } finally {
      await dropCopy(client, name);
    }
  });

  it.each(COLLISIONS.map((c, i) => [c.label, c, i] as const))(
    '%s: readable refusal, nothing left behind, the rerun applies 0429 and 0430',
    async (_label, collision, index) => {
      const { client, name } = await freshCopy(`_c${index}`);
      try {
        const lockTimeoutBefore = await sessionLockTimeout(client);
        await client.query(collision.insert);

        for (const attempt of [1, 2]) {
          const failure = await failureOf(client);
          expect(failure.code, `attempt ${attempt}`).toBe('P0001');
          expect(failure.message, `attempt ${attempt}`).toContain(PREFLIGHT_MESSAGE);
          for (const fragment of collision.names) {
            expect(failure.message, `attempt ${attempt}: ${fragment}`).toContain(fragment);
          }
          expect(failure.hint, `attempt ${attempt}`).toContain(
            'Resolve the collision with the owner',
          );

          // Nothing of 0429 or 0430 stays. The row at the reserved id, if there is one, is the
          // collision itself and keeps its own name: the INSERT never ran.
          const after = await guards(client);
          expect(after.constraints, `attempt ${attempt}`).toEqual([]);
          expect(after.trigger, `attempt ${attempt}`).toBe(false);
          expect(after.guardFunction, `attempt ${attempt}`).toBe(false);
          expect(after.journal, `attempt ${attempt}`).toEqual([]);
          if (after.reservedRow) {
            expect(after.reservedRow.name, `attempt ${attempt}`).not.toBe(SNOW_WASTE_TYPE_NAME);
          }
          expect(await sessionLockTimeout(client)).toBe(lockTimeoutBefore);
        }

        // The owner resolves the collision, and the very same call goes through.
        await client.query(
          'DELETE FROM waste_types WHERE id = $1 OR code = ANY($2) OR name = ANY($3)',
          [
            RESERVED_ID,
            [`occupied_${RUN}`, 'snow', `shouted_${RUN}`, `yo_${RUN}`],
            ['снег!', 'Снёг', 'Снежный вывоз'],
          ],
        );
        const applied = await applyMigrations(client);
        expect(applied.slice(0, 2)).toEqual([GUARDS_FILE, VALIDATE_FILE]);

        const done = await guards(client);
        expect(done.constraints).toEqual([
          'waste_requests_snow_subject_check',
          'waste_tariffs_not_service_type_check',
          'waste_types_service_snow_check',
        ]);
        expect(done.trigger).toBe(true);
        expect(done.guardFunction).toBe(true);
        expect(done.reservedRow).toEqual({ code: 'snow', name: SNOW_WASTE_TYPE_NAME });
        expect(done.journal).toEqual([GUARDS_FILE, VALIDATE_FILE]);
        const validated = await client.query<{ convalidated: boolean }>(
          `SELECT convalidated FROM pg_constraint
            WHERE conname = 'waste_requests_snow_subject_check'
              AND conrelid = 'waste_requests'::regclass`,
        );
        expect(validated.rows).toEqual([{ convalidated: true }]);
        expect(await sessionLockTimeout(client)).toBe(lockTimeoutBefore);
      } finally {
        await dropCopy(client, name);
      }
    },
    120_000,
  );

  it('all three collisions at once: one message names every colliding row', async () => {
    const { client, name } = await freshCopy('_all');
    try {
      for (const collision of COLLISIONS.slice(0, 3)) await client.query(collision.insert);
      const failure = await failureOf(client);
      expect(failure.message).toContain(PREFLIGHT_MESSAGE);
      for (const collision of COLLISIONS.slice(0, 3)) {
        for (const fragment of collision.names) expect(failure.message).toContain(fragment);
      }
      expect((await guards(client)).journal).toEqual([]);
    } finally {
      await dropCopy(client, name);
    }
  }, 120_000);

  it('a clean database applies both files without the preflight getting in the way', async () => {
    const { client, name } = await freshCopy('_clean');
    try {
      const applied = await applyMigrations(client);
      expect(applied.slice(0, 2)).toEqual([GUARDS_FILE, VALIDATE_FILE]);
      expect((await guards(client)).reservedRow).toEqual({
        code: 'snow',
        name: SNOW_WASTE_TYPE_NAME,
      });
    } finally {
      await dropCopy(client, name);
    }
  }, 120_000);
});
