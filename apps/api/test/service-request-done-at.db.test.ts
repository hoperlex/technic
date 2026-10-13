import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';

/**
 * The backfill of `service_requests.done_at` — the migration whose name ends in
 * `_service_request_done_at.sql` (ADR 0174, workflow-fixes plan Н14).
 *
 * WHAT IS CLAIMED. For a request in «Решена» the anchor becomes the LAST REAL entry into `done`
 * from the status history — a `done → done` row written later does not move it; without history
 * it becomes `GREATEST(status_changed_at, completed_at)`, never `completed_at` alone; a request
 * outside «Решена» stays empty; versions do not move; a second run changes nothing.
 *
 * WHY THE FIXTURES COME BEFORE THE MIGRATION. `service-request-auto-close.db.test.ts` applies every
 * migration first and creates rows afterwards — it checks the worker on data the backfill never
 * saw, and an error in the backfill's SQL would pass it whole. Here each case rebuilds the state
 * before the migration inside a transaction (the column is dropped), creates the rows, runs the
 * file's text as it is and rolls everything back. The file is found by its name, not its number: a
 * parallel stream may take the number, and the integrator renumbers.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:55982/technic_test \
 *     npx vitest run service-request-done-at --maxWorkers=1
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const MIGRATION_SUFFIX = '_service_request_done_at.sql';

const MIGRATION_SQL = ((): string => {
  const files = listMigrationFiles().filter((name) => name.endsWith(MIGRATION_SUFFIX));
  if (files.length !== 1) {
    throw new Error(`expected exactly one migration *${MIGRATION_SUFFIX}, found ${files.length}`);
  }
  return readMigration(files[0]!);
})();

let client: pg.Client;

interface Scene {
  userId: string;
  objectId: string;
  counterpartyId: string;
  typeId: string;
}

async function makeScene(): Promise<Scene> {
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                        is_active, email_verified_at)
     VALUES ($1, 'Тестовый', 'Якорь', $2, 'x', 'admin'::role, true, now())
     RETURNING id`,
    [`db-done-at-${RUN}@example.invalid`, RUN],
  );
  const object = await client.query<{ id: string }>(
    `INSERT INTO construction_objects (code, name, address)
     VALUES ($1, $2, 'г Москва, ул Тестовая, д 1') RETURNING id`,
    [`DA-${RUN}`, `Площадка якоря ${RUN}`],
  );
  const party = await client.query<{ id: string }>(
    `INSERT INTO counterparties (type, name, inn)
     VALUES ('service'::counterparty_type, $1, $2) RETURNING id`,
    [
      `Сервис якоря ${RUN}`,
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

interface Times {
  status: 'done' | 'in_work';
  /** Interval back from now, PostgreSQL syntax. */
  statusChangedAgo: string;
  completedAgo: string | null;
}

/** A contractor's request in the given status, without `done_at` (the column does not exist yet). */
async function makeRequest(scene: Scene, tag: string, times: Times): Promise<string> {
  const equipment = await client.query<{ id: string }>(
    `INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location,
                                   created_by)
     VALUES ($1, $2, $3, $4, 'к1', $5) RETURNING id`,
    [scene.typeId, `МФУ ${tag}`, `DA-${RUN}-${tag}`, scene.objectId, scene.userId],
  );
  const res = await client.query<{ id: string }>(
    `INSERT INTO service_requests (office_equipment_id, equipment_object_id, equipment_name,
                                   description, status, service_counterparty_id, created_by,
                                   status_changed_at, completed_at)
     VALUES ($1, $2, 'МФУ', $3, $4::service_request_status, $5, $6,
             now() - $7::interval, now() - $8::interval)
     RETURNING id`,
    [
      equipment.rows[0]!.id,
      scene.objectId,
      `Якорь ${tag}`,
      times.status,
      scene.counterpartyId,
      scene.userId,
      times.statusChangedAgo,
      times.completedAgo,
    ],
  );
  return res.rows[0]!.id;
}

async function history(
  scene: Scene,
  requestId: string,
  rows: ReadonlyArray<[from: string | null, to: string, ago: string]>,
): Promise<void> {
  for (const [from, to, ago] of rows) {
    await client.query(
      `INSERT INTO service_request_status_history (request_id, from_status, to_status, changed_by,
                                                   changed_at)
       VALUES ($1, $2::service_request_status, $3::service_request_status, $4,
               now() - $5::interval)`,
      [requestId, from, to, scene.userId, ago],
    );
  }
}

/** Seconds between `done_at` and `now() - ago`; `null` when the anchor is empty. */
async function anchorOffset(id: string, ago: string): Promise<number | null> {
  const res = await client.query<{ offset: string | null }>(
    `SELECT extract(epoch FROM done_at - (now() - $2::interval)) AS offset
       FROM service_requests WHERE id = $1`,
    [id, ago],
  );
  const offset = res.rows[0]!.offset;
  return offset === null ? null : Number(offset);
}

async function doneAt(id: string): Promise<Date | null> {
  const res = await client.query<{ done_at: Date | null }>(
    'SELECT done_at FROM service_requests WHERE id = $1',
    [id],
  );
  return res.rows[0]!.done_at;
}

async function versionOf(id: string): Promise<number> {
  const res = await client.query<{ version: number }>(
    'SELECT version FROM service_requests WHERE id = $1',
    [id],
  );
  return res.rows[0]!.version;
}

describe.skipIf(!DB_URL)('done_at: the backfill sees the rows that existed before it', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await applyMigrations(client);
  }, 180_000);

  afterAll(async () => {
    await client?.end();
  });

  it('the migrated schema carries the column, empty for every row outside «Решена»', async () => {
    const res = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM service_requests WHERE status <> 'done' AND done_at IS NOT NULL`,
    );
    expect(Number(res.rows[0]!.n)).toBe(0);
  });

  it('the last real entry wins over done → done; no history falls back to GREATEST', async () => {
    await client.query('BEGIN');
    try {
      await client.query('ALTER TABLE service_requests DROP COLUMN done_at');
      const scene = await makeScene();

      // Two rounds into «Решена» and a `done → done` trace on top: the anchor is the second
      // round's entry, three days back — neither the first one nor the trace an hour ago.
      const rounds = await makeRequest(scene, 'rounds', {
        status: 'done',
        statusChangedAgo: '1 hour',
        completedAgo: '9 days',
      });
      await history(scene, rounds, [
        [null, 'new', '10 days'],
        ['new', 'in_work', '9 days'],
        ['in_work', 'done', '5 days'],
        ['done', 'in_work', '4 days'],
        ['in_work', 'done', '3 days'],
        ['done', 'done', '1 hour'],
      ]);

      // No history at all (a request older than the history table, or written around it): the
      // later of the two dates — here the status change, not the chosen completion date.
      const bare = await makeRequest(scene, 'bare', {
        status: 'done',
        statusChangedAgo: '2 days',
        completedAgo: '6 days',
      });
      // The same, with the completion date the later one: GREATEST takes it.
      const bareLate = await makeRequest(scene, 'bare-late', {
        status: 'done',
        statusChangedAgo: '3 days',
        completedAgo: '1 day',
      });
      // Not in «Решена»: nothing reads the anchor there, and the new code keeps it empty.
      const working = await makeRequest(scene, 'working', {
        status: 'in_work',
        statusChangedAgo: '1 day',
        completedAgo: null,
      });
      await history(scene, working, [
        ['in_work', 'done', '3 days'],
        ['done', 'in_work', '1 day'],
      ]);

      const versions = new Map<string, number>();
      for (const id of [rounds, bare, bareLate, working]) versions.set(id, await versionOf(id));

      // The scene's INSERTs queued events of the deferred `service_requests_executor_present`
      // (0178), and `ALTER TABLE` refuses a table with pending trigger events; in a deploy the
      // queue is empty. Flushed here so the file runs as it would there.
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query(MIGRATION_SQL);

      expect(Math.abs((await anchorOffset(rounds, '3 days'))!)).toBeLessThan(5);
      expect(Math.abs((await anchorOffset(bare, '2 days'))!)).toBeLessThan(5);
      expect(Math.abs((await anchorOffset(bareLate, '1 day'))!)).toBeLessThan(5);
      expect(await doneAt(working)).toBeNull();
      // The backfill does not bump versions: an open form on these requests must not get a 409.
      for (const [id, version] of versions) expect(await versionOf(id)).toBe(version);

      // A second run (a re-applied file, a manual rerun) changes nothing.
      const anchors = new Map<string, number | undefined>();
      for (const id of [rounds, bare, bareLate]) anchors.set(id, (await doneAt(id))?.getTime());
      await client.query(MIGRATION_SQL);
      for (const [id, at] of anchors) expect((await doneAt(id))?.getTime()).toBe(at);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
