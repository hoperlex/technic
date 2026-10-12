import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeRegistration } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { REGISTRATION_KEY_CASES } from './registration-key-cases';

/**
 * The plate key in TS is pinned to the database function (ADR 0138, owner decision S-6).
 *
 * `vehicle_reg_normalize` (migration 0015) is the authority: the generated
 * `registration_number_normalized` columns, the unique indexes of vehicles and trailers and every
 * lookup by plate in SQL go through it. `normalizeRegistration` in the contracts is its copy for
 * code that compares plates without a query — the directory exchange, the fuel-norms file and the
 * trailer picker of the route form. The fuel-norms file searches a TS key among keys Postgres
 * computed, so a copy that drifts does not fail anything: a plate simply stops being found.
 *
 * Two checks, because a table alone proves only the cases someone thought of:
 *
 * - the named table (`registration-key-cases.ts`, shared with the unit test) — both sides give the
 *   key written there;
 * - a sweep over every code point from U+0001 to U+04FF (Basic Latin, Latin-1, Latin Extended,
 *   Cyrillic), one character per input. All three steps of the rule — drop what is not a letter or
 *   digit of the kept set, upper-case, replace look-alikes — work character by character, so
 *   agreement on every single character of the range is agreement on every string made of them.
 *
 * **The empty key is stated, not hidden.** Postgres returns `NULL` where nothing is left after the
 * separators (and for `NULL`, the function being STRICT); TS returns `''`. The comparison maps
 * `NULL` to `''`, and a separate case asserts that the database really answers `NULL` there: the
 * unique index of vehicles is partial on `registration_number_normalized IS NOT NULL`, and an `''`
 * key would make any two plates made of separators only collide.
 *
 * `upper()` follows the database's character type: on an `LC_CTYPE=C` database it leaves Cyrillic
 * alone, and the lower-case Cyrillic cases fail. That is a real divergence, not a test artefact —
 * on such a database «в094ет77» would not be the same vehicle as «B094ET77» — so the failure
 * message names the locale.
 *
 * Read-only: the test only calls the function and writes nothing, so it runs on the shared base.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/vehicle-reg-normalize-parity.db.test.ts
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like every `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

let client: pg.Client;
let locale = '';

/** The database answer for each input, in input order; `NULL` stays `null`. */
async function databaseKeys(inputs: readonly (string | null)[]): Promise<(string | null)[]> {
  const { rows } = await client.query<{ key: string | null }>(
    `SELECT vehicle_reg_normalize(u.t) AS key
       FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i)
      ORDER BY u.i`,
    [inputs],
  );
  return rows.map((row) => row.key);
}

describe.skipIf(!DB_URL)('ключ госномера: копия в контрактах = vehicle_reg_normalize', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await applyMigrations(client);
    const { rows } = await client.query<{ ctype: string; collate: string }>(
      `SELECT datctype AS ctype, datcollate AS collate
         FROM pg_database WHERE datname = current_database()`,
    );
    locale = `LC_CTYPE=${rows[0]!.ctype}, LC_COLLATE=${rows[0]!.collate}`;
  }, 240_000);

  afterAll(async () => {
    await client?.end();
  });

  it('таблица случаев: обе стороны дают записанный ключ', async () => {
    const keys = await databaseKeys(REGISTRATION_KEY_CASES.map((c) => c.input));
    const answers = REGISTRATION_KEY_CASES.map((c, i) => ({
      what: c.what,
      expected: c.key,
      database: keys[i],
      contracts: normalizeRegistration(c.input),
    }));
    // The whole table at once: a drift shows every case it touches, not just the first one.
    expect(answers, `база: ${locale}`).toEqual(
      REGISTRATION_KEY_CASES.map((c) => ({
        what: c.what,
        expected: c.key,
        database: c.key,
        contracts: c.key ?? '',
      })),
    );
  });

  it('пустой ключ: в базе NULL, в контрактах пустая строка — и сравнение их сводит', async () => {
    const empty = REGISTRATION_KEY_CASES.filter((c) => c.key === null);
    expect(empty.length).toBeGreaterThan(0);
    const keys = await databaseKeys(empty.map((c) => c.input));
    expect(keys).toEqual(empty.map(() => null));
    expect(empty.map((c) => normalizeRegistration(c.input))).toEqual(empty.map(() => ''));
  });

  it('каждый символ от U+0001 до U+04FF: ключи совпадают', async () => {
    const chars = Array.from({ length: 0x4ff }, (_, i) => String.fromCodePoint(i + 1));
    const keys = await databaseKeys(chars);
    const drift = chars.flatMap((c, i) => {
      const database = keys[i] ?? '';
      const contracts = normalizeRegistration(c);
      if (database === contracts) return [];
      const code = `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
      return [`${code} «${c}»: база «${database}», контракты «${contracts}»`];
    });
    expect(drift, `база: ${locale}`).toEqual([]);
  });
});
