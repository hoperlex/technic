import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * The pending estimate and its origin as one pair — the second half of release B of the on-site
 * invoice estimate wave (ADR 0183): the migration whose name ends in
 * `_service_estimate_pending_source_strict.sql`.
 *
 * WHAT IS CLAIMED. The backfill fixes exactly the two leftovers of release A's window — a wait
 * without an origin becomes `submit` (the value every reader assumed for it), an origin without a
 * wait is cleared — and touches nothing else, not even `version`. After it the constraint is
 * strict: no wait without an origin, no origin without a wait, no unknown origin. The guard before
 * the constraint names the requests the backfill could not fix; it is unreachable on a release A
 * schema (that constraint still enforces the value list, and the two updates cover both mixed
 * halves), so the test reaches it by removing the release A constraint first.
 *
 * WHAT IS NOT HERE. That every writer keeps the pair is proved where the writers are driven through
 * their routes, now against the strict constraint, each asserting both columns: submission and
 * re-issue (`service-request-flow`, `service-estimate-breakdown`, `service-estimate-document-submit`
 * for the exemption that opens no wait), approval, rejection, return for editing, handover, internal
 * close and the reset matrix of the return to «Новая» (`service-request-flow`), the dispute outcome
 * and the signature after it (`service-estimate-dispute`). A writer splitting the pair would fail
 * there with this constraint's name.
 *
 * WHY THE SQL IS TAKEN FROM THE FILE. The migration is already applied by `applyMigrations` in
 * `beforeAll`, and the journal will not run it twice — yet its work is exactly what has to be
 * checked on live rows. So each case rebuilds the state before the migration inside a transaction,
 * runs the file's text as is and rolls everything back: the database ends as it started, and no
 * retelling of the SQL next to the test can stay green after an edit of the original. The file is
 * found by its name, not its number — a parallel stream may take the number, and the integrator
 * renumbers.
 *
 * The migration locks `service_requests` exclusively inside each case's transaction, so this file
 * wants its own database or a run with one worker:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:55980/technic_test \
 *     pnpm check:db service-estimate-pending-source-strict
 *
 * Without `TEST_DATABASE_URL` the database cases are skipped, like every `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);

const MIGRATION_SUFFIX = '_service_estimate_pending_source_strict.sql';
const CONSTRAINT = 'service_requests_estimate_pending_source_check';

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
const RELEASE_A_PENDING_SOURCE_CHECK = `
  ALTER TABLE service_requests DROP CONSTRAINT ${CONSTRAINT};
  ALTER TABLE service_requests ADD CONSTRAINT ${CONSTRAINT} CHECK (
    estimate_pending_source IS NULL OR estimate_pending_source IN ('submit','dispute')
  );`;

interface Scene {
  userId: string;
  objectId: string;
  counterpartyId: string;
  typeId: string;
}

interface Wait {
  /** A pending revision (equal to the current one, as `service_requests_estimate_pending_check` wants). */
  pending: boolean;
  source: string | null;
}

interface RowState {
  estimate_pending_revision: number | null;
  estimate_pending_source: string | null;
  estimate_revision: number;
  version: number;
}

let client: pg.Client;

/** Prerequisites of a request, created inside the case's transaction and rolled back with it. */
async function makeScene(tag: string): Promise<Scene> {
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                        is_active, email_verified_at)
     VALUES ($1, 'Тестовый', 'Предъявитель', $2, 'x', 'admin'::role, true, now())
     RETURNING id`,
    [`db-eps-${RUN}-${tag}@example.invalid`, RUN],
  );
  const object = await client.query<{ id: string }>(
    `INSERT INTO construction_objects (code, name, address)
     VALUES ($1, $2, 'г Москва, ул Тестовая, д 2') RETURNING id`,
    [`EPS-${RUN}-${tag}`, `Площадка ожидания ${RUN} ${tag}`],
  );
  const party = await client.query<{ id: string }>(
    `INSERT INTO counterparties (type, name, inn)
     VALUES ('service'::counterparty_type, $1, $2) RETURNING id`,
    [
      `Сервис ожидания ${RUN} ${tag}`,
      String(7800000000 + (Math.abs(Number.parseInt(RUN, 16)) % 99999999)).slice(0, 10),
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

/** A request in «В работе» with revision 1 and the given wait. */
async function makeRequest(scene: Scene, tag: string, wait: Wait): Promise<string> {
  const equipment = await client.query<{ id: string }>(
    `INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location,
                                   created_by)
     VALUES ($1, $2, $3, $4, 'к2', $5) RETURNING id`,
    [scene.typeId, `МФУ ${tag}`, `EPS-${RUN}-${tag}`, scene.objectId, scene.userId],
  );
  const res = await client.query<{ id: string }>(
    `INSERT INTO service_requests (office_equipment_id, equipment_object_id, equipment_name,
                                   description, status, service_counterparty_id, created_by,
                                   estimate_revision, estimate_submitted_at,
                                   estimate_pending_revision, estimate_pending_source)
     VALUES ($1, $2, 'МФУ', $3, 'in_work'::service_request_status, $4, $5, 1, now(), $6, $7)
     RETURNING id`,
    [
      equipment.rows[0]!.id,
      scene.objectId,
      `Ожидание ${tag}`,
      scene.counterpartyId,
      scene.userId,
      wait.pending ? 1 : null,
      wait.source,
    ],
  );
  return res.rows[0]!.id;
}

async function stateOf(id: string): Promise<RowState> {
  const res = await client.query<RowState>(
    `SELECT estimate_pending_revision, estimate_pending_source, estimate_revision, version
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
  const anchor = plain.indexOf(`ADD CONSTRAINT ${CONSTRAINT} CHECK (`);
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

describe.skipIf(!DB_URL)('pending estimate ⇔ origin: backfill, guard, strict pair', () => {
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
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [CONSTRAINT],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.def).toContain(
      '((estimate_pending_revision IS NULL) = (estimate_pending_source IS NULL))',
    );
  });

  it('backfill fixes the two leftovers of release A, then the pair is strict', async () => {
    await client.query('BEGIN');
    try {
      await client.query(RELEASE_A_PENDING_SOURCE_CHECK);
      const scene = await makeScene('bf');
      const ids = {
        // Opened by code older than release A: a submission that did not name itself.
        pendingNoSource: await makeRequest(scene, 'pns', { pending: true, source: null }),
        // Cleared by code older than release A after release A code had named it.
        staleSubmit: await makeRequest(scene, 'ss', { pending: false, source: 'submit' }),
        staleDispute: await makeRequest(scene, 'sd', { pending: false, source: 'dispute' }),
        // Rows that already comply: the backfill must not touch them.
        pendingSubmit: await makeRequest(scene, 'ps', { pending: true, source: 'submit' }),
        pendingDispute: await makeRequest(scene, 'pd', { pending: true, source: 'dispute' }),
        idle: await makeRequest(scene, 'i', { pending: false, source: null }),
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

      expect(await stateOf(ids.pendingNoSource)).toMatchObject({
        estimate_pending_revision: 1,
        estimate_pending_source: 'submit',
      });
      for (const id of [ids.staleSubmit, ids.staleDispute]) {
        expect(await stateOf(id)).toMatchObject({
          estimate_pending_revision: null,
          estimate_pending_source: null,
        });
      }
      for (const id of [ids.pendingSubmit, ids.pendingDispute, ids.idle]) {
        expect(await stateOf(id)).toEqual(before.get(id));
      }
      // The backfill does not bump versions: an open form on these requests must not get a 409.
      for (const id of Object.values(ids)) {
        expect((await stateOf(id)).version).toBe(before.get(id)!.version);
      }

      // A wait whose origin is unknown.
      expect(
        await refusedBy(
          'UPDATE service_requests SET estimate_pending_source = NULL WHERE id = $1',
          [ids.pendingSubmit],
        ),
      ).toBe(CONSTRAINT);
      // An origin of nothing: the trace of a wait that is gone.
      expect(
        await refusedBy(
          `UPDATE service_requests SET estimate_pending_source = 'submit' WHERE id = $1`,
          [ids.idle],
        ),
      ).toBe(CONSTRAINT);
      // A wait cleared with its origin left behind — the stale `dispute` that would admit a
      // signature in «Решена» if a reader ever asked the origin alone.
      expect(
        await refusedBy(
          'UPDATE service_requests SET estimate_pending_revision = NULL WHERE id = $1',
          [ids.pendingDispute],
        ),
      ).toBe(CONSTRAINT);
      // An origin outside the list.
      expect(
        await refusedBy(
          `UPDATE service_requests SET estimate_pending_source = 'review' WHERE id = $1`,
          [ids.pendingSubmit],
        ),
      ).toBe(CONSTRAINT);
      // Both legal moves pass: open a wait with its origin, clear the two columns together.
      await client.query(
        `UPDATE service_requests
            SET estimate_pending_revision = 1, estimate_pending_source = 'dispute'
          WHERE id = $1`,
        [ids.idle],
      );
      await client.query(
        `UPDATE service_requests
            SET estimate_pending_revision = NULL, estimate_pending_source = NULL
          WHERE id = $1`,
        [ids.pendingSubmit],
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('the guard stops the migration and names a request the backfill cannot fix', async () => {
    await client.query('BEGIN');
    try {
      /*
       * Unreachable on a release A schema: its constraint forbids an unknown origin on every row,
       * and the backfill fixes only the mixed halves. Removing that constraint is the only way to
       * build such a row, and it is exactly the edit the guard exists for.
       */
      await client.query(`ALTER TABLE service_requests DROP CONSTRAINT ${CONSTRAINT}`);
      const scene = await makeScene('guard');
      const id = await makeRequest(scene, 'g', { pending: true, source: 'review' });
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

      expect(message).toContain('service_estimate_pending_source_strict');
      expect(message).toContain(`СО-${num} (${id})`);
      // The raise came from the guard, before the constraint: the row is still there unchanged.
      expect(await stateOf(id)).toMatchObject({
        estimate_pending_revision: 1,
        estimate_pending_source: 'review',
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
