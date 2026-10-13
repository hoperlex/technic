import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MODULE_GRANTS,
  ROLE_ADDON_PERMISSIONS,
  type Permission,
  type RoleAddon,
} from '@technic/contracts';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * The catalog migration of the cancel right — the file whose name ends in
 * `_service_request_cancel_grant.sql` (ADR 0174, wave 2; workflow-fixes plan Р2).
 *
 * WHAT IS CLAIMED. The migration appends `serviceRequests.cancel` to the system set
 * `office_equipment_it_approver` and to no other; it touches no row of `user_grants`, no role, no
 * other right; a second run changes nothing. Its in-file guard raises, with a readable sentence,
 * on every state the INSERT itself could corrupt — the set missing, the right landing in a second
 * system set, the composition growing by more than one right, a grant row appearing or vanishing —
 * and on nothing else (it compares with a snapshot taken before the insert, never with a
 * hard-coded size of a set).
 *
 * WHY THE FIXTURES COME BEFORE THE MIGRATION. `grants-catalog.db.test.ts` applies every migration
 * and compares the result with the contracts: it proves the END state and would pass an empty file
 * as soon as the contracts and the migration were both wrong in the same way, or a file that
 * did the insert but broke the neighbours. Here each case rebuilds the state BEFORE the file inside
 * a rolled-back transaction (the right is taken out of the set), runs the text of the file as it is
 * and reads what changed. The file is found by its suffix, not its number: a parallel stream may
 * take the number, and the integrator renumbers.
 *
 * OWN DATABASE, NOT THE SHARED ONE: the guard cases create a trigger on `grant_permissions` inside
 * a transaction (a lock on the table held under the neighbouring files). Created, migrated and
 * dropped by the file, as the sibling replay tests do.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:55990/technic_test \
 *     npx vitest run service-request-cancel-grant --maxWorkers=1
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_service_request_cancel_grant_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');
const RUN = randomUUID().slice(0, 8);
const MIGRATION_SUFFIX = '_service_request_cancel_grant.sql';
const CANCEL: Permission = 'serviceRequests.cancel';
const IT = 'office_equipment_it_approver';
const SYSTEM_SETS = [
  'office_equipment_operator',
  IT,
  'office_equipment_executor',
  'office_equipment_requester',
] as const;

const MIGRATION_SQL = ((): string => {
  const files = listMigrationFiles().filter((name) => name.endsWith(MIGRATION_SUFFIX));
  if (files.length !== 1) {
    throw new Error(`expected exactly one migration *${MIGRATION_SUFFIX}, found ${files.length}`);
  }
  return readMigration(files[0]!);
})();

let client: pg.Client;

/** The rights of one system set, sorted — the whole composition, not a count. */
async function rightsOf(code: string): Promise<string[]> {
  const res = await client.query<{ permission: string }>(
    `SELECT gp.permission FROM grant_permissions gp JOIN grants g ON g.id = gp.grant_id
      WHERE g.code = $1 ORDER BY gp.permission`,
    [code],
  );
  return res.rows.map((row) => row.permission);
}

async function holdersOf(code: string): Promise<number> {
  const res = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM user_grants ug JOIN grants g ON g.id = ug.grant_id WHERE g.code = $1`,
    [code],
  );
  return Number(res.rows[0]!.n);
}

/** Runs `fn` in a transaction that is always rolled back: the next case sees the migrated base. */
async function inRolledBack<T>(fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** The state BEFORE the file: the right is taken out of the IT set, as it was before the release. */
async function takeCancelOut(): Promise<void> {
  await client.query(
    `DELETE FROM grant_permissions
      WHERE permission = $1
        AND grant_id IN (SELECT id FROM grants WHERE code = $2)`,
    [CANCEL, IT],
  );
}

/** Two holders of the IT set, created inside the transaction: the guard counts holders. */
async function holdTheItSet(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                          is_active, email_verified_at)
       VALUES ($1, 'Тестовый', 'Держатель', $2, 'x', 'shtab'::role, true, now())
       RETURNING id`,
      [`db-cancel-grant-${RUN}-${i}@example.invalid`, `${RUN}${i}`],
    );
    await client.query(
      `INSERT INTO user_grants (user_id, grant_id, granted_by)
       SELECT $1, g.id, $1 FROM grants g WHERE g.code = $2`,
      [user.rows[0]!.id, IT],
    );
  }
}

describe.skipIf(!DB_URL)('migration of the cancel right: the IT service, and only it', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    // The first migrations expect these extensions and do not create them.
    for (const ext of ['pgcrypto', 'citext', 'pg_trgm']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    }
    await applyMigrations(client);
  }, 240_000);

  afterAll(async () => {
    await client?.end();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it('the end state is the declared one: the right is in the IT set and in no other system set', async () => {
    expect(await rightsOf(IT)).toContain(CANCEL);
    for (const code of SYSTEM_SETS.filter((set) => set !== IT)) {
      expect(await rightsOf(code), code).not.toContain(CANCEL);
    }
    // And the contracts say the same — the catalog guard compares the whole composition.
    expect(ROLE_ADDON_PERMISSIONS[IT as RoleAddon]).toContain(CANCEL);
    expect(MODULE_GRANTS.office_equipment_executor.permissions).not.toContain(CANCEL);
  });

  it('from the state before: appends exactly the one right to the IT set, touches nothing else', async () => {
    await inRolledBack(async () => {
      await takeCancelOut();
      const before = Object.fromEntries(
        await Promise.all(SYSTEM_SETS.map(async (code) => [code, await rightsOf(code)] as const)),
      );
      const holdersBefore = await Promise.all(SYSTEM_SETS.map((code) => holdersOf(code)));
      expect(before[IT]).not.toContain(CANCEL);

      await client.query(MIGRATION_SQL);

      expect(await rightsOf(IT)).toEqual([...before[IT]!, CANCEL].sort());
      for (const code of SYSTEM_SETS.filter((set) => set !== IT)) {
        expect(await rightsOf(code), code).toEqual(before[code]);
      }
      expect(await Promise.all(SYSTEM_SETS.map((code) => holdersOf(code)))).toEqual(holdersBefore);
    });
  });

  it('holders of the IT set keep their grants: no row of user_grants appears, vanishes or moves', async () => {
    await inRolledBack(async () => {
      await takeCancelOut();
      await holdTheItSet(2);
      const before = await client.query(
        `SELECT user_id, grant_id, origin FROM user_grants ORDER BY user_id, grant_id`,
      );
      const versions = await client.query(`SELECT id, auth_version FROM users ORDER BY id`);

      await client.query(MIGRATION_SQL);

      const after = await client.query(
        `SELECT user_id, grant_id, origin FROM user_grants ORDER BY user_id, grant_id`,
      );
      expect(after.rows).toEqual(before.rows);
      // The sessions are not invalidated: a right is added, not taken away.
      expect((await client.query(`SELECT id, auth_version FROM users ORDER BY id`)).rows).toEqual(
        versions.rows,
      );
    });
  });

  it('a second run changes nothing and does not trip its own guard', async () => {
    await inRolledBack(async () => {
      await takeCancelOut();
      await client.query(MIGRATION_SQL);
      const once = await rightsOf(IT);
      // The snapshot table lives to the end of the migration's own transaction (`ON COMMIT DROP`);
      // the second run is a new transaction in life, so the table of the first is dropped by hand.
      await client.query('DROP TABLE grant_snapshot_cancel');
      await client.query(MIGRATION_SQL);
      expect(await rightsOf(IT)).toEqual(once);
    });
  });

  describe('the guard raises, readably, on a state the insert itself must not produce', () => {
    it('the right in a second system set — the lock of the wave is broken', async () => {
      await inRolledBack(async () => {
        await takeCancelOut();
        await client.query(
          `INSERT INTO grant_permissions (grant_id, permission)
           SELECT id, $1 FROM grants WHERE code = 'office_equipment_operator'`,
          [CANCEL],
        );
        await expect(client.query(MIGRATION_SQL)).rejects.toThrow(
          /office_equipment_operator.*the lock of the wave is broken/s,
        );
      });
    });

    it('the IT set missing — nothing to hand the right to', async () => {
      await inRolledBack(async () => {
        await client.query(`UPDATE grants SET code = $1 WHERE code = $2`, [`gone-${RUN}`, IT]);
        await expect(client.query(MIGRATION_SQL)).rejects.toThrow(
          /office_equipment_it_approver is missing/,
        );
      });
    });

    it('the composition growing by more than the one right', async () => {
      await inRolledBack(async () => {
        await takeCancelOut();
        // A trigger that makes the insert do more than it says — the state the guard is for.
        await client.query(`
          CREATE FUNCTION pg_temp.extra_right() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            INSERT INTO grant_permissions (grant_id, permission)
            VALUES (NEW.grant_id, 'serviceRequests.urgency') ON CONFLICT DO NOTHING;
            RETURN NEW;
          END $$`);
        await client.query(`
          CREATE TRIGGER extra_right AFTER INSERT ON grant_permissions
          FOR EACH ROW WHEN (NEW.permission = 'serviceRequests.cancel')
          EXECUTE FUNCTION pg_temp.extra_right()`);
        // The right is taken out and the extra one is out of the set too, so the trigger adds a
        // second right and the guard sees the growth by two.
        await client.query(
          `DELETE FROM grant_permissions WHERE permission = 'serviceRequests.urgency'
             AND grant_id IN (SELECT id FROM grants WHERE code = $1)`,
          [IT],
        );
        await expect(client.query(MIGRATION_SQL)).rejects.toThrow(/adds one right, not 2/);
      });
    });

    it('a grant row vanishing — the composition is edited, not the grants', async () => {
      await inRolledBack(async () => {
        await takeCancelOut();
        await holdTheItSet(1);
        await client.query(`
          CREATE FUNCTION pg_temp.drop_holder() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            DELETE FROM user_grants WHERE grant_id = NEW.grant_id;
            RETURN NEW;
          END $$`);
        await client.query(`
          CREATE TRIGGER drop_holder AFTER INSERT ON grant_permissions
          FOR EACH ROW WHEN (NEW.permission = 'serviceRequests.cancel')
          EXECUTE FUNCTION pg_temp.drop_holder()`);
        await expect(client.query(MIGRATION_SQL)).rejects.toThrow(
          /office_equipment_it_approver" had 1 holders and has 0/,
        );
      });
    });
  });
});
