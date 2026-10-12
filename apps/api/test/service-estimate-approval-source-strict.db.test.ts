import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * The estimate signature and its source as one pair — release B of the on-site invoice estimate
 * wave (ADR 0183, ADR 0208): the migration whose name ends in
 * `_service_estimate_approval_source_strict.sql`.
 *
 * WHAT IS CLAIMED. The backfill fixes exactly the two leftovers of release A's window — a signature
 * without a source becomes `human` (author kept, also when the author is gone), a source without a
 * signature is cleared — and touches nothing else, not even `version`. After it the constraint is
 * strict: no signature without a source, no source without a signature, no author for `auto`. The
 * guard before the constraint names the requests the backfill could not fix; it is unreachable on
 * a release A schema, so the test reaches it by removing the release A constraint first.
 *
 * WHY THE SQL IS TAKEN FROM THE FILE. The migration is already applied by `applyMigrations` in
 * `beforeAll`, and the journal will not run it twice — yet its work is exactly what has to be
 * checked on live rows. So each case rebuilds the state before the migration inside a transaction,
 * runs the file's text as is and rolls everything back: the database ends as it started, and a
 * retelling of the SQL next to the test (which would stay green after the first edit of the
 * original) is not needed. The file is found by its name, not its number — a parallel stream may
 * take the number, and the integrator renumbers.
 *
 * The migration locks `service_requests` exclusively inside each case's transaction, so this file
 * wants its own database or a run with one worker:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:55975/technic_test \
 *     npx vitest run service-estimate-approval-source-strict --maxWorkers=1
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like every `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);

const MIGRATION_SUFFIX = '_service_estimate_approval_source_strict.sql';

const MIGRATION_SQL = ((): string => {
  const files = listMigrationFiles().filter((name) => name.endsWith(MIGRATION_SUFFIX));
  if (files.length !== 1) {
    throw new Error(`expected exactly one migration *${MIGRATION_SUFFIX}, found ${files.length}`);
  }
  return readMigration(files[0]!);
})();

/**
 * The release A text of the constraint (0306, section 5.3) — the state this migration starts from.
 * 0306 is applied history and never changes, so writing its text here cannot drift.
 */
const RELEASE_A_SOURCE_CHECK = `
  ALTER TABLE service_requests DROP CONSTRAINT service_requests_estimate_approval_source_check;
  ALTER TABLE service_requests ADD CONSTRAINT service_requests_estimate_approval_source_check CHECK (
    estimate_approval_source IS NULL
    OR (estimate_approval_source IN ('human','auto')
        AND (estimate_approval_source <> 'auto' OR estimate_approved_by IS NULL))
  );`;

interface Scene {
  userId: string;
  objectId: string;
  counterpartyId: string;
  typeId: string;
}

interface Signature {
  approvedAt: boolean;
  by: 'user' | null;
  source: 'human' | 'auto' | null;
}

interface RowState {
  estimate_approval_source: string | null;
  estimate_approved_by: string | null;
  estimate_approved_at: Date | null;
  version: number;
}

let client: pg.Client;

/** Prerequisites of a request, created inside the case's transaction and rolled back with it. */
async function makeScene(tag: string): Promise<Scene> {
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                        is_active, email_verified_at)
     VALUES ($1, 'Тестовый', 'Подписант', $2, 'x', 'admin'::role, true, now())
     RETURNING id`,
    [`db-eas-${RUN}-${tag}@example.invalid`, RUN],
  );
  const object = await client.query<{ id: string }>(
    `INSERT INTO construction_objects (code, name, address)
     VALUES ($1, $2, 'г Москва, ул Тестовая, д 1') RETURNING id`,
    [`EAS-${RUN}-${tag}`, `Площадка подписи ${RUN} ${tag}`],
  );
  const party = await client.query<{ id: string }>(
    `INSERT INTO counterparties (type, name, inn)
     VALUES ('service'::counterparty_type, $1, $2) RETURNING id`,
    [
      `Сервис подписи ${RUN} ${tag}`,
      String(7700000000 + (Math.abs(Number.parseInt(RUN, 16)) % 99999999)).slice(0, 10),
    ],
  );
  const type = await client.query<{ id: string }>(
    `SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
  );
  if (!type.rows[0]) throw new Error('no office equipment types: migration 0104 is not applied');
  return {
    userId: user.rows[0]!.id,
    objectId: object.rows[0]!.id,
    counterpartyId: party.rows[0]!.id,
    typeId: type.rows[0]!.id,
  };
}

/** A request in «В работе» with revision 1 and the given signature snapshot. */
async function makeRequest(scene: Scene, tag: string, signature: Signature): Promise<string> {
  const equipment = await client.query<{ id: string }>(
    `INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location,
                                   created_by)
     VALUES ($1, $2, $3, $4, 'к1', $5) RETURNING id`,
    [scene.typeId, `МФУ ${tag}`, `EAS-${RUN}-${tag}`, scene.objectId, scene.userId],
  );
  const signed = signature.approvedAt;
  const res = await client.query<{ id: string }>(
    `INSERT INTO service_requests (office_equipment_id, equipment_object_id, equipment_name,
                                   description, status, service_counterparty_id, created_by,
                                   estimate_revision, approved_estimate_revision,
                                   estimate_approved_at, estimate_approved_by,
                                   estimate_approval_source)
     VALUES ($1, $2, 'МФУ', $3, 'in_work'::service_request_status, $4, $5, 1, $6, $7, $8, $9)
     RETURNING id`,
    [
      equipment.rows[0]!.id,
      scene.objectId,
      `Подпись ${tag}`,
      scene.counterpartyId,
      scene.userId,
      signed ? 1 : null,
      signed ? new Date('2026-09-01T10:00:00Z') : null,
      signature.by === 'user' ? scene.userId : null,
      signature.source,
    ],
  );
  return res.rows[0]!.id;
}

async function stateOf(id: string): Promise<RowState> {
  const res = await client.query<RowState>(
    `SELECT estimate_approval_source, estimate_approved_by, estimate_approved_at, version
       FROM service_requests WHERE id = $1`,
    [id],
  );
  return res.rows[0]!;
}

/** A statement the database must refuse, isolated by a savepoint so the transaction lives on. */
async function refusedBy(statement: string, params: unknown[]): Promise<string | undefined> {
  await client.query('SAVEPOINT refusal');
  try {
    await client.query(statement, params);
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT refusal');
    return (e as { constraint?: string }).constraint ?? (e as Error).message;
  }
  await client.query('RELEASE SAVEPOINT refusal');
  throw new Error(`the database accepted: ${statement}`);
}

/**
 * Every top-level `( … ) IS FALSE` predicate of the guard and the body of the strict `CHECK`, with
 * comments dropped and whitespace collapsed. The header promises they are word for word the same:
 * a guard that tests a different predicate than the constraint would let the constraint fail with
 * a bare name, or stop a migration the constraint would accept.
 */
function predicatesOf(text: string): { guard: string[]; check: string } {
  const plain = text
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
  const balanced = (from: number): string => {
    let depth = 0;
    for (let i = from; i < plain.length; i += 1) {
      if (plain[i] === '(') depth += 1;
      if (plain[i] === ')') depth -= 1;
      if (depth === 0) return plain.slice(from + 1, i).trim();
    }
    throw new Error('unbalanced parentheses in the migration');
  };
  const guard: string[] = [];
  for (const match of plain.matchAll(/WHERE \(/g)) {
    const body = balanced(match.index + 'WHERE '.length);
    const after = plain.slice(match.index + 'WHERE '.length + body.length + 2).trimStart();
    if (after.startsWith('IS FALSE')) guard.push(body.replace(/\s+/g, ' '));
  }
  const anchor = plain.indexOf(
    'ADD CONSTRAINT service_requests_estimate_approval_source_check CHECK (',
  );
  if (anchor < 0) throw new Error('the strict constraint is not in the migration');
  const check = balanced(plain.indexOf('CHECK (', anchor) + 'CHECK '.length);
  return { guard, check: check.replace(/\s+/g, ' ') };
}

const normalize = (predicate: string): string =>
  predicate.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');

describe('the guard tests the very predicate of the strict constraint', () => {
  it('both guard queries and the CHECK body are word for word the same', () => {
    const { guard, check } = predicatesOf(MIGRATION_SQL);
    expect(guard).toHaveLength(2);
    for (const predicate of guard) expect(normalize(predicate)).toBe(normalize(check));
  });
});

describe.skipIf(!DB_URL)('estimate signature ⇔ source: backfill, guard, strict pair', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await applyMigrations(client);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
  });

  it('the migrated schema carries the strict pair', async () => {
    const res = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'service_requests_estimate_approval_source_check'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.def).toContain(
      '((estimate_approved_at IS NULL) = (estimate_approval_source IS NULL))',
    );
  });

  it('backfill fixes the two leftovers of release A, then the pair is strict', async () => {
    await client.query('BEGIN');
    try {
      await client.query(RELEASE_A_SOURCE_CHECK);
      const scene = await makeScene('bf');
      const ids = {
        // Signed by pre-release-A code: a person's signature without a source.
        signedNoSource: await makeRequest(scene, 'sns', {
          approvedAt: true,
          by: 'user',
          source: null,
        }),
        // The same, and the signer's account has since been deleted (`SET NULL`).
        signedNoSourceNoAuthor: await makeRequest(scene, 'snsna', {
          approvedAt: true,
          by: null,
          source: null,
        }),
        // A signature cleared by pre-release-A code after 0306 backfilled its source.
        staleHuman: await makeRequest(scene, 'sh', {
          approvedAt: false,
          by: null,
          source: 'human',
        }),
        staleAuto: await makeRequest(scene, 'sa', { approvedAt: false, by: null, source: 'auto' }),
        // Rows that already comply: the backfill must not touch them.
        signedHuman: await makeRequest(scene, 'h', {
          approvedAt: true,
          by: 'user',
          source: 'human',
        }),
        signedAuto: await makeRequest(scene, 'a', { approvedAt: true, by: null, source: 'auto' }),
        unsigned: await makeRequest(scene, 'u', { approvedAt: false, by: null, source: null }),
      };
      const before = new Map<string, RowState>();
      for (const id of Object.values(ids)) before.set(id, await stateOf(id));

      /*
       * The scene's INSERTs queued events of the deferred `service_requests_executor_present`
       * (0178), and `ALTER TABLE` refuses a table with pending trigger events. The migration's own
       * UPDATEs queue none — that trigger fires only on status and contractor columns — so in a
       * deploy the queue is empty; here it is flushed so the file runs as it would there.
       */
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query(MIGRATION_SQL);

      expect(await stateOf(ids.signedNoSource)).toMatchObject({
        estimate_approval_source: 'human',
        estimate_approved_by: scene.userId,
      });
      expect(await stateOf(ids.signedNoSourceNoAuthor)).toMatchObject({
        estimate_approval_source: 'human',
        estimate_approved_by: null,
      });
      expect((await stateOf(ids.staleHuman)).estimate_approval_source).toBeNull();
      expect((await stateOf(ids.staleAuto)).estimate_approval_source).toBeNull();
      for (const id of [ids.signedHuman, ids.signedAuto, ids.unsigned]) {
        expect(await stateOf(id)).toEqual(before.get(id));
      }
      // The backfill does not bump versions: an open form on these requests must not get a 409.
      for (const id of Object.values(ids)) {
        expect((await stateOf(id)).version).toBe(before.get(id)!.version);
      }

      const constraint = 'service_requests_estimate_approval_source_check';
      // Signed, but by what is unknown.
      expect(
        await refusedBy(
          'UPDATE service_requests SET estimate_approval_source = NULL WHERE id = $1',
          [ids.signedHuman],
        ),
      ).toBe(constraint);
      // A source of nothing: the trace of a signature that is gone.
      expect(
        await refusedBy(
          `UPDATE service_requests SET estimate_approval_source = 'human' WHERE id = $1`,
          [ids.unsigned],
        ),
      ).toBe(constraint);
      // A signature cleared with its source left behind.
      expect(
        await refusedBy(
          `UPDATE service_requests
              SET estimate_approved_at = NULL, approved_estimate_revision = NULL,
                  estimate_approved_by = NULL
            WHERE id = $1`,
          [ids.signedAuto],
        ),
      ).toBe(constraint);
      // An automatic signature with an author.
      expect(
        await refusedBy('UPDATE service_requests SET estimate_approved_by = $2 WHERE id = $1', [
          ids.signedAuto,
          scene.userId,
        ]),
      ).toBe(constraint);
      // Both legal moves pass: sign with a source, clear the four columns together.
      await client.query(
        `UPDATE service_requests
            SET approved_estimate_revision = 1, estimate_approved_at = now(),
                estimate_approved_by = $2, estimate_approval_source = 'human'
          WHERE id = $1`,
        [ids.unsigned, scene.userId],
      );
      await client.query(
        `UPDATE service_requests
            SET approved_estimate_revision = NULL, estimate_approved_at = NULL,
                estimate_approved_by = NULL, estimate_approval_source = NULL
          WHERE id = $1`,
        [ids.signedAuto],
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('the guard stops the migration and names a request the backfill cannot fix', async () => {
    await client.query('BEGIN');
    try {
      /*
       * Unreachable on a release A schema: its constraint forbids `auto` with an author on every
       * row, and the backfill fixes only the mixed halves. Removing that constraint is the only way
       * to build such a row, and it is exactly the edit the guard exists for.
       */
      await client.query(
        'ALTER TABLE service_requests DROP CONSTRAINT service_requests_estimate_approval_source_check',
      );
      const scene = await makeScene('guard');
      const id = await makeRequest(scene, 'g', { approvedAt: true, by: 'user', source: 'auto' });
      const num = (
        await client.query<{ num: number }>('SELECT num FROM service_requests WHERE id = $1', [id])
      ).rows[0]!.num;

      await client.query('SAVEPOINT migration');
      let message = '';
      try {
        await client.query(MIGRATION_SQL);
      } catch (e) {
        message = (e as Error).message;
      }
      await client.query('ROLLBACK TO SAVEPOINT migration');

      expect(message).toContain('service_estimate_approval_source_strict');
      expect(message).toContain(`СО-${num} (${id})`);
      // The raise came from the guard, before the constraint: the row is still there unchanged.
      expect(await stateOf(id)).toMatchObject({
        estimate_approval_source: 'auto',
        estimate_approved_by: scene.userId,
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
