import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * The contract step of ADR 0059 §14: `vehicle_request_assignments.ordered_vehicle_type_id`
 * becomes NOT NULL after a backfill from `vehicle_requests`, behind a guard that names the rows
 * the backfill cannot reach.
 *
 * The migration is run from its file, not retold here: the subject is the SQL that ships, and a
 * copy in the test would stay green until the first edit of the original. It is found by name
 * without its number, because parallel streams take migration numbers and the integrator
 * renumbers at merge time.
 *
 * Each case first returns the table to its pre-migration shape (`DROP NOT NULL`, and for the guard
 * also without the request FK), runs the file inside the same transaction and rolls everything
 * back, so cases do not see each other.
 *
 * OWN DATABASE, NOT THE SHARED ONE: the cases run DDL on `vehicle_request_assignments` and drop
 * its foreign keys inside a transaction; on the shared base that would hold an ACCESS EXCLUSIVE
 * lock under neighbouring files. The database is created, migrated from scratch and dropped in
 * `afterAll`.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/assignment-ordered-type-not-null.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_assignment_ordered_type_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const MIGRATION_SUFFIX = '_assignment_ordered_type_not_null.sql';

function migrationSql(): string {
  const files = listMigrationFiles().filter((f) => f.endsWith(MIGRATION_SUFFIX));
  // Exactly one: zero means the file was renamed and the test would check nothing; two means a
  // copy landed under a second number and the migrator would run it twice.
  if (files.length !== 1) {
    throw new Error(
      `expected one migration *${MIGRATION_SUFFIX}, found: ${files.join(', ') || 'none'}`,
    );
  }
  return readMigration(files[0]!);
}

let client: pg.Client;

interface Scene {
  userId: string;
  objectId: string;
  vehicleId: string;
  /** Type of the assigned vehicle: the target of the vehicle composite FK. */
  vehicleTypeId: string;
  /** A different type, ordered by the request: the backfill must take this one. */
  orderedTypeId: string;
}

let scene: Scene;

async function one<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T> {
  const { rows } = await client.query<T>(text, params);
  if (!rows[0]) throw new Error(`no row: ${text}`);
  return rows[0];
}

async function newRequest(typeId: string): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, created_by)
     VALUES ('special_equipment', $1, $2, 'confirmed', $3) RETURNING id`,
    [scene.objectId, typeId, scene.userId],
  );
  return row.id;
}

async function assign(requestId: string, ordered: string | null): Promise<void> {
  await client.query(
    `INSERT INTO vehicle_request_assignments
       (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [requestId, scene.vehicleId, scene.vehicleTypeId, ordered, scene.userId],
  );
}

async function orderedOf(requestId: string): Promise<string | null> {
  const row = await one<{ ordered: string | null }>(
    'SELECT ordered_vehicle_type_id AS ordered FROM vehicle_request_assignments WHERE request_id = $1',
    [requestId],
  );
  return row.ordered;
}

async function isNullable(): Promise<boolean> {
  const row = await one<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vehicle_request_assignments'
        AND column_name = 'ordered_vehicle_type_id'`,
  );
  return row.is_nullable === 'YES';
}

/** One case in a transaction that is always rolled back; the column starts nullable again. */
async function beforeMigration(run: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(
      'ALTER TABLE vehicle_request_assignments ALTER COLUMN ordered_vehicle_type_id DROP NOT NULL',
    );
    await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

describe.skipIf(!DB_URL)('migration: ordered_vehicle_type_id NOT NULL (ADR 0059 §14)', () => {
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

    const user = await one<{ id: string }>(
      `INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
       VALUES ($1, 'Тестов', 'Тест', '', 'x', 'admin', false) RETURNING id`,
      [`db-ordered-type-${RUN}@example.invalid`],
    );
    const object = await one<{ id: string }>(
      `INSERT INTO construction_objects (code, name, address)
       VALUES ($1, $2, 'г Москва, ул Тестовая, д 1') RETURNING id`,
      [`OT-${RUN}`, `Площадка ${RUN}`],
    );
    const vehicle = await one<{ id: string; vehicle_type_id: string }>(
      `SELECT id, vehicle_type_id FROM vehicles
        WHERE deleted_at IS NULL AND ownership = 'own' ORDER BY id LIMIT 1`,
    );
    const other = await one<{ id: string }>(
      'SELECT id FROM vehicle_types WHERE id <> $1 ORDER BY code LIMIT 1',
      [vehicle.vehicle_type_id],
    );
    scene = {
      userId: user.id,
      objectId: object.id,
      vehicleId: vehicle.id,
      vehicleTypeId: vehicle.vehicle_type_id,
      orderedTypeId: other.id,
    };
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

  it('after the full migration run the column is NOT NULL', async () => {
    expect(await isNullable()).toBe(false);
  });

  it("backfills a NULL row with the request's ordered type, not the vehicle's, and restores NOT NULL", async () => {
    await beforeMigration(async () => {
      const legacy = await newRequest(scene.orderedTypeId);
      await assign(legacy, null);
      // A row written by current code: the backfill must leave it as it is.
      const current = await newRequest(scene.vehicleTypeId);
      await assign(current, scene.vehicleTypeId);
      expect(await isNullable()).toBe(true);

      await client.query(migrationSql());

      expect(await orderedOf(legacy)).toBe(scene.orderedTypeId);
      expect(await orderedOf(current)).toBe(scene.vehicleTypeId);
      expect(await isNullable()).toBe(false);

      await client.query('SAVEPOINT null_insert');
      const fresh = await newRequest(scene.orderedTypeId);
      await expect(assign(fresh, null)).rejects.toMatchObject({ code: '23502' });
      await client.query('ROLLBACK TO SAVEPOINT null_insert');
    });
  });

  it('runs clean on a table with nothing to backfill', async () => {
    await beforeMigration(async () => {
      const filled = await newRequest(scene.orderedTypeId);
      await assign(filled, scene.orderedTypeId);
      await client.query(migrationSql());
      expect(await orderedOf(filled)).toBe(scene.orderedTypeId);
      expect(await isNullable()).toBe(false);
    });
  });

  it('the guard names the rows the backfill cannot reach instead of a bare NOT NULL failure', async () => {
    await beforeMigration(async () => {
      // The only way to get an unbackfillable row is to bypass the request FK, which is exactly
      // the situation the guard exists for.
      await client.query(
        'ALTER TABLE vehicle_request_assignments DROP CONSTRAINT vehicle_request_assignments_request_fk',
      );
      await client.query(
        'ALTER TABLE vehicle_request_assignments DROP CONSTRAINT vehicle_request_assignments_ordered_type_fk',
      );
      const orphan = randomUUID();
      await assign(orphan, null);

      const failure = await client.query(migrationSql()).then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
      expect(failure, 'the migration must refuse').not.toBeNull();
      expect(failure!.message).toContain('ordered_vehicle_type_id cannot become NOT NULL');
      expect(failure!.message).toContain('1 row(s)');
      expect(failure!.message).toContain(orphan);
    });
  });
});
