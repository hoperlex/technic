import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SNOW_WASTE_TYPE_ID } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';

/**
 * `waste_requests_snow_subject_check` (migrations 0429 / 0430) by raw SQL, below the application
 * (snow-removal plan §4 «Directory and DB»: «Try a mismatched or NULL subject and volume below
 * 8 m³ via SQL»).
 *
 * The constraint is the last line of defence: the previous API keeps serving while the migration
 * runs and until the restart, and it knows nothing about snow. Every shape the new code refuses
 * must also be refused by the table — with the constraint's own name, so that a refusal by some
 * other constraint cannot pass for this one.
 *
 * TWO LAYERS OF ASSERTIONS, because older-named sibling constraints shadow some clauses. Postgres
 * evaluates a table's CHECKs in the alphabetical order of their names and reports the first
 * failure, so on the intact table a snow row with `containers_count = 2` is refused by
 * `waste_requests_containers_count_type_check` before the snow check is looked at, and the same
 * holds for a container owner (`..._container_owner_type_check`) and for a price or a tariff alone
 * (`..._price_snapshot_check`). Those clauses of the snow check are therefore untestable on the
 * intact table, and a mutation of them would stay green. The second layer drops exactly those
 * siblings INSIDE a rolled-back transaction (DDL is transactional) and repeats the cases: now the
 * snow check is the only one left to refuse them.
 *
 * WHY ITS OWN DATABASE. The second layer takes ACCESS EXCLUSIVE on `waste_requests` and the file
 * inserts and updates rows of every legacy shape; on the shared run database it would queue
 * parallel test files behind a DDL lock. Its name is `<run database>_snowchk_<run>`, so
 * `pnpm check:db` removes it with the run database if this file dies before `afterAll`.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:55961/technic_test \
 *     pnpm check:db snow-subject-check
 */

const SOURCE = process.env.TEST_DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const SNOW = SNOW_WASTE_TYPE_ID;
const SNOW_CHECK = 'waste_requests_snow_subject_check';
/** SQLSTATE of a CHECK violation. */
const CHECK_VIOLATION = '23514';

/** The siblings that shadow clauses of the snow check on the intact table (see above). */
const SHADOWING_SIBLINGS = [
  'waste_requests_price_snapshot_check',
  'waste_requests_price_positive_check',
  'waste_requests_container_owner_type_check',
  'waste_requests_containers_count_type_check',
] as const;

function withDatabase(url: string, name: string): string {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}

/** `<source>_snowchk_<run>`, cut from the source name so that the run suffix survives (limit 63). */
function ownDatabaseName(source: string): string {
  const suffix = `_snowchk_${RUN}`;
  return `${source.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
}

type Column = Record<string, unknown>;

describe.skipIf(!SOURCE)('waste_requests_snow_subject_check on the live schema', () => {
  let adminUrl = '';
  let ownName = '';
  let client: pg.Client;

  const ids = { object: '', user: '', garbageType: '', tariff: '', container: '', owner: '' };

  /**
   * A request row from named columns; the rest takes the table defaults. `request_type` is cast
   * to its enum, every other value goes as a parameter.
   */
  async function insert(columns: Column): Promise<string> {
    const base: Column = {
      object_id: ids.object,
      delivery_at: '2041-11-05T09:00:00Z',
      created_by: ids.user,
      comment: `ТЕСТОВЫЕ ДАННЫЕ: ограничение снега ${RUN}`,
    };
    const all = { ...base, ...columns };
    const names = Object.keys(all);
    const marks = names.map((name, i) =>
      name === 'request_type' ? `$${i + 1}::request_type` : `$${i + 1}`,
    );
    const res = await client.query<{ id: string }>(
      `INSERT INTO waste_requests (${names.join(', ')}) VALUES (${marks.join(', ')}) RETURNING id`,
      names.map((name) => all[name]),
    );
    return res.rows[0]!.id;
  }

  /** What the database answered to a statement that must fail: the SQLSTATE and the constraint. */
  async function refusal(
    run: () => Promise<unknown>,
  ): Promise<{ code: string | undefined; constraint: string | undefined }> {
    try {
      await run();
    } catch (e) {
      const error = e as { code?: string; constraint?: string };
      return { code: error.code, constraint: error.constraint };
    }
    throw new Error('the statement was accepted, but the database had to refuse it');
  }

  const snowRow = (over: Column = {}): Column => ({
    request_type: 'snow_removal',
    waste_type_id: SNOW,
    volume_m3: 8,
    ...over,
  });

  beforeAll(async () => {
    const source = new URL(SOURCE!);
    ownName = ownDatabaseName(source.pathname.slice(1));
    adminUrl = withDatabase(SOURCE!, 'postgres');
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${ownName}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${ownName}"`);
    } finally {
      await admin.end();
    }

    client = new pg.Client({ connectionString: withDatabase(SOURCE!, ownName) });
    await client.connect();
    // The first migrations need these and do not create them (ops does it before migrations).
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(client);

    const one = async (query: string, params: unknown[] = []): Promise<string> =>
      (await client.query<{ id: string }>(query, params)).rows[0]!.id;
    ids.user = await one(
      `INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                          is_active, email_verified_at)
       VALUES ($1, 'Тестовый', 'Пользователь', 'Снег', 'x', 'admin', true, now())
       RETURNING id`,
      [`db-snow-subject-${RUN}@example.invalid`],
    );
    ids.object = await one(
      `INSERT INTO construction_objects (code, name, address)
       VALUES ($1, $2, 'г. Москва, тест ограничения снега') RETURNING id`,
      [`яя-snow-subject-${RUN}`, `Площадка ограничения снега ${RUN}`],
    );
    ids.garbageType = await one(
      `INSERT INTO waste_types (code, name) VALUES ($1, $2) RETURNING id`,
      [`test_snowsubject_${RUN}`, `ТЕСТ мусор рядом со снегом ${RUN}`],
    );
    ids.owner = await one(
      `INSERT INTO counterparties (type, name, inn)
       VALUES ('operator', $1, $2) RETURNING id`,
      [
        `Оператор ограничения снега ${RUN}`,
        String(7_700_000_000 + Math.floor(Math.random() * 99_999_999)).slice(0, 10),
      ],
    );
    ids.tariff = await one(
      `INSERT INTO waste_tariffs (operator_counterparty_id, waste_type_id, container_kind,
                                  price_per_m3)
       VALUES ($1, $2, 'truck', 100.00) RETURNING id`,
      [ids.owner, ids.garbageType],
    );
    ids.container = await one(
      `INSERT INTO container_types (code, name) VALUES ($1, $2) RETURNING id`,
      [`test_snowsubject_${RUN}`, `ТЕСТ контейнер ${RUN}`],
    );
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

  it('the constraint exists and is validated (migration 0430)', async () => {
    const res = await client.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint
        WHERE conname = $1 AND conrelid = 'waste_requests'::regclass`,
      [SNOW_CHECK],
    );
    expect(res.rows).toEqual([{ convalidated: true }]);
  });

  describe('shapes the snow check alone refuses (23514 and its own name)', () => {
    const cases: [string, () => Column][] = [
      ['snow with volume 7 (below the 8 m³ floor)', () => snowRow({ volume_m3: 7 })],
      ['snow with volume 0', () => snowRow({ volume_m3: 0 })],
      ['snow with NULL volume', () => snowRow({ volume_m3: null })],
      ['snow with NULL waste type', () => snowRow({ waste_type_id: null })],
      ['snow with another waste type', () => snowRow({ waste_type_id: ids.garbageType })],
      [
        'waste_removal carrying the reserved id',
        () => ({ request_type: 'waste_removal', waste_type_id: SNOW, volume_m3: 20 }),
      ],
      [
        'container_removal carrying the reserved id',
        () => ({
          request_type: 'container_removal',
          waste_type_id: SNOW,
          container_type_id: ids.container,
        }),
      ],
      ['snow with a container type', () => snowRow({ container_type_id: ids.container })],
      [
        'snow with a tariff and a price',
        () => snowRow({ waste_tariff_id: ids.tariff, price_per_m3: '100.00' }),
      ],
    ];

    it.each(cases)('%s', async (_name, row) => {
      const got = await refusal(() => insert(row()));
      expect(got).toEqual({ code: CHECK_VIOLATION, constraint: SNOW_CHECK });
    });
  });

  describe('clauses shadowed by older-named siblings', () => {
    const cases: [string, () => Column, string][] = [
      [
        'snow with containers_count 2',
        () => snowRow({ containers_count: 2 }),
        'waste_requests_containers_count_type_check',
      ],
      [
        'snow with a container owner',
        () => snowRow({ container_owner_counterparty_id: ids.owner }),
        'waste_requests_container_owner_type_check',
      ],
      [
        'snow with a price and no tariff',
        () => snowRow({ price_per_m3: '100.00' }),
        'waste_requests_price_snapshot_check',
      ],
      [
        'snow with a tariff and no price',
        () => snowRow({ waste_tariff_id: ids.tariff }),
        'waste_requests_price_snapshot_check',
      ],
    ];

    it.each(cases)(
      '%s: refused on the intact table, by the sibling',
      async (_name, row, sibling) => {
        expect(await refusal(() => insert(row()))).toEqual({
          code: CHECK_VIOLATION,
          constraint: sibling,
        });
      },
    );

    it.each(cases)(
      '%s: the snow check refuses it once the siblings are out of the way',
      async (_name, row) => {
        await client.query('BEGIN');
        try {
          for (const sibling of SHADOWING_SIBLINGS) {
            await client.query(`ALTER TABLE waste_requests DROP CONSTRAINT ${sibling}`);
          }
          const got = await refusal(() => insert(row()));
          expect(got).toEqual({ code: CHECK_VIOLATION, constraint: SNOW_CHECK });
        } finally {
          await client.query('ROLLBACK');
        }
        // The rollback really restored the siblings: DDL inside the transaction left nothing behind.
        const left = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_constraint
          WHERE conrelid = 'waste_requests'::regclass AND conname = ANY($1)`,
          [SHADOWING_SIBLINGS],
        );
        expect(Number(left.rows[0]!.n)).toBe(SHADOWING_SIBLINGS.length);
      },
    );
  });

  describe('shapes that must still be accepted', () => {
    const cases: [string, () => Column][] = [
      ['snow at exactly 8 m³ with the reserved id', () => snowRow({ volume_m3: 8 })],
      ['snow at a large volume', () => snowRow({ volume_m3: 400 })],
      [
        'garbage: waste_removal with a type, a volume and a price snapshot',
        () => ({
          request_type: 'waste_removal',
          waste_type_id: ids.garbageType,
          volume_m3: 20,
          waste_tariff_id: ids.tariff,
          price_per_m3: '100.00',
        }),
      ],
      [
        'garbage without a type or a volume (an unfinished legacy row)',
        () => ({ request_type: 'waste_removal' }),
      ],
      ['scrap: metal_removal with no subject', () => ({ request_type: 'metal_removal' })],
      [
        'container_install with a container type',
        () => ({ request_type: 'container_install', container_type_id: ids.container }),
      ],
      [
        'container_replace with a count and an owner',
        () => ({
          request_type: 'container_replace',
          container_type_id: ids.container,
          containers_count: 3,
          container_owner_counterparty_id: ids.owner,
        }),
      ],
      [
        'container_removal with a count',
        () => ({
          request_type: 'container_removal',
          container_type_id: ids.container,
          containers_count: 2,
        }),
      ],
    ];

    it.each(cases)('%s', async (_name, row) => {
      expect(await insert(row())).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('updates cannot reach a refused shape either', () => {
    async function update(id: string, set: string, params: unknown[] = []): Promise<unknown> {
      return client.query(`UPDATE waste_requests SET ${set} WHERE id = $1`, [id, ...params]);
    }

    it('a snow row cannot drop below 8 m³, lose its volume or its waste type', async () => {
      const id = await insert(snowRow({ volume_m3: 8 }));
      for (const set of ['volume_m3 = 7', 'volume_m3 = NULL', 'waste_type_id = NULL']) {
        expect(await refusal(() => update(id, set)), set).toEqual({
          code: CHECK_VIOLATION,
          constraint: SNOW_CHECK,
        });
      }
      // Growing the order is an ordinary edit.
      await update(id, 'volume_m3 = 20');
    });

    it('the type and the reserved id move only together', async () => {
      const snow = await insert(snowRow({ volume_m3: 10 }));
      expect(await refusal(() => update(snow, `request_type = 'waste_removal'`))).toEqual({
        code: CHECK_VIOLATION,
        constraint: SNOW_CHECK,
      });

      const garbage = await insert({
        request_type: 'waste_removal',
        waste_type_id: ids.garbageType,
        volume_m3: 20,
      });
      expect(await refusal(() => update(garbage, `request_type = 'snow_removal'`))).toEqual({
        code: CHECK_VIOLATION,
        constraint: SNOW_CHECK,
      });
      expect(await refusal(() => update(garbage, 'waste_type_id = $2', [SNOW]))).toEqual({
        code: CHECK_VIOLATION,
        constraint: SNOW_CHECK,
      });
      // A legacy garbage row stays editable.
      await update(garbage, 'volume_m3 = 30');
    });
  });
});
