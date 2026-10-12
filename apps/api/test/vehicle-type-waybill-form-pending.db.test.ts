import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, migrationsDir } from '../src/db/migration-journal';

/**
 * The prepared, not yet released CHECK on `vehicle_types.waybill_form_code`
 * (`drizzle/pending/vehicle-type-waybill-form-check.sql`, ADR 0128): narrowed to '4p' | 'leg3'
 * behind a guard that names every type still carrying another form.
 *
 * Why test what does not ship yet: the file waits at least one release, while the table and its
 * neighbours keep changing. Run here, it stays a checked statement instead of a draft that turns
 * out to be written for last month's schema in the middle of a deploy.
 *
 * OWN DATABASE, NOT THE SHARED ONE: the cases drop and re-add a constraint of `vehicle_types`
 * inside a transaction, and on the shared base that holds an ACCESS EXCLUSIVE lock on a directory
 * every neighbouring file reads. Each case rolls back, so they do not see each other.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/vehicle-type-waybill-form-pending.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_type_waybill_form_pending_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);

/** The test must run the SQL that will ship, not a copy of it. */
const PENDING_SQL = readFileSync(
  join(migrationsDir, 'pending', 'vehicle-type-waybill-form-check.sql'),
  'utf8',
);

let client: pg.Client;
let kindId: string;

async function newType(code: string, form: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO vehicle_types (kind_id, code, name, waybill_form_code)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [kindId, code, `Тип ${code}`, form],
  );
  return rows[0]!.id;
}

/** One case in a transaction that is always rolled back. */
async function rolledBack(run: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

describe.skipIf(!DB_URL)('pending: vehicle_types waybill form CHECK 4p|leg3 (ADR 0128)', () => {
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
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM vehicle_kinds ORDER BY code LIMIT 1',
    );
    kindId = rows[0]!.id;
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

  it('before the file a type can still be stored with esm2: the gap the file closes', async () => {
    await rolledBack(async () => {
      await expect(newType(`pre_${RUN}`, 'esm2')).resolves.toBeTypeOf('string');
    });
  });

  it('the guard names every type with another form and changes nothing', async () => {
    await rolledBack(async () => {
      const first = await newType(`esm_a_${RUN}`, 'esm2');
      await newType(`esm_b_${RUN}`, 'esm2');

      const failure = await client.query(PENDING_SQL).then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
      expect(failure, 'the file must refuse').not.toBeNull();
      expect(failure!.message).toContain('cannot be narrowed to 4p|leg3: 2 type(s)');
      expect(failure!.message).toContain(`esm_a_${RUN} "Тип esm_a_${RUN}" [esm2] (id ${first})`);
      expect(failure!.message).toContain(`esm_b_${RUN}`);
    });
    // Rolled back with the transaction: the old three-valued CHECK is still in place.
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'vehicle_types_waybill_form_check'`,
    );
    expect(rows[0]!.def).toContain('esm2');
  });

  it('with no such types the CHECK narrows: esm2 is refused, 4p and leg3 pass', async () => {
    await rolledBack(async () => {
      await client.query(PENDING_SQL);
      await expect(newType(`ok_4p_${RUN}`, '4p')).resolves.toBeTypeOf('string');
      await expect(newType(`ok_leg3_${RUN}`, 'leg3')).resolves.toBeTypeOf('string');
      await client.query('SAVEPOINT refused');
      await expect(newType(`bad_${RUN}`, 'esm2')).rejects.toMatchObject({
        code: '23514',
        constraint: 'vehicle_types_waybill_form_check',
      });
      await client.query('ROLLBACK TO SAVEPOINT refused');
    });
  });
});
