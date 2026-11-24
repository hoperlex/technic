import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { moscowDateKeyOf } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values of these modules are taken through `await import` after the environment
// is set, because the config validates it at import time and throws without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Driver removal closes the open specialization and employment periods with the MOSCOW calendar
 * day, not the UTC one (`DELETE /api/v1/drivers/:id`).
 *
 * Why the database. The failure is a CHECK, `ended_on >= started_on` on both period tables: a
 * period that starts on the Moscow day D and is closed with the UTC day D-1 (the UTC day lags by
 * one between 00:00 and 03:00 MSK) is rejected inside the removal transaction, so the card cannot
 * be removed at all. Only a live schema has that constraint.
 *
 * Why only `Date` is faked. The anchor is 00:30 MSK of the current Moscow day, a moment at which
 * the UTC day is the previous one. The app reads the instant with `new Date()`, so faking `Date`
 * moves the handler there, while the database clock stays real: the app and the fixtures are built
 * in real time, and `now()` / `CURRENT_DATE` defaults are not what is under test. The start date is
 * therefore passed explicitly (`employedSince`), which keeps the test independent of whether the
 * column default is the UTC or the Moscow day. Timers stay real, otherwise the pool and the
 * request machinery would hang. A token issued in real time still verifies under the faked clock
 * because verification sets no `maxTokenAge`, and the access TTL is raised below so the anchor,
 * which may be ahead of the real time by up to half an hour just after midnight MSK, is not past
 * its expiry.
 *
 * Run (own database with the pgcrypto, citext and pg_trgm extensions):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/<db> \
 *     npx vitest run driver-removal-moscow-day --maxWorkers=1
 *
 * Without `TEST_DATABASE_URL` the file is skipped: an ordinary test run needs no database.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Own suffix per run: the database of db tests is shared and survives a rerun. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
const ADMIN_EMAIL = `db-drvrm-admin-${RUN}@example.invalid`;

/**
 * SNILS is generated, not taken from the seed: seed numbers in a shared database belong to live
 * cards. The checksum follows the pension fund rules, otherwise parsing rejects the number before
 * the database does.
 */
function makeSnils(): string {
  const nums = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = nums.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${nums.join('')}${String(checksum).padStart(2, '0')}`;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  headers: { authorization: string };
}

let ctx: Ctx | undefined;
const createdSnils: string[] = [];

/** The config is read at import, so the environment is set before the first `import('../src/...')`. */
function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  // The token is issued in real time and used at the faked anchor, which can be ahead of the real
  // clock by up to 30 minutes; the default 15-minute lifetime would then be over.
  process.env.ACCESS_TOKEN_TTL_SECONDS = '172800';
}

async function migrate(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

type PeriodRow = {
  started_on: string;
  ended_on: string | null;
};

/** Dates are read as text: the driver would turn a `date` into a local-midnight `Date`. */
async function periodsOf(
  table: 'person_specializations' | 'person_employments',
  personId: string,
): Promise<PeriodRow[]> {
  const res = await ctx!.db.execute<PeriodRow>(sql`
    SELECT started_on::text AS started_on, ended_on::text AS ended_on
      FROM ${sql.raw(table)}
     WHERE person_id = ${personId}`);
  return [...res.rows];
}

describe.skipIf(!DB_URL)('driver removal closes periods with the Moscow day', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    await db.execute(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${ADMIN_EMAIL}, 'Тестовый', 'Администратор', '',
              ${await hashPassword(PASSWORD)}, 'admin'::role, true, now())`);

    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    ctx = { app, db, closeDb, headers: { authorization: `Bearer ${login.json().accessToken}` } };
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    if (!ctx) return;
    await ctx.app.close();
    // Reverse order of references: the audit log holds the admin by a foreign key. Deleting the
    // person cascades to its periods.
    const ours = sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ours})`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email = ${ADMIN_EMAIL}`);
    if (createdSnils.length > 0) {
      await ctx.db.execute(
        sql`DELETE FROM persons WHERE snils IN (${sql.join(
          createdSnils.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      );
    }
    await ctx.closeDb();
  });

  it('removal at 00:30 MSK ends both periods on the Moscow day, not on the previous UTC day', async () => {
    const { app, db, headers } = ctx!;

    // The anchor is computed BEFORE the clock is faked: afterwards `new Date()` is the anchor.
    const moscowDay = moscowDateKeyOf(new Date());
    const anchor = new Date(`${moscowDay}T00:30:00+03:00`);
    // The point of the scenario: at the anchor the UTC day is the previous one.
    expect(anchor.toISOString().slice(0, 10)).not.toBe(moscowDay);

    const snils = makeSnils();
    createdSnils.push(snils);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/drivers',
      headers,
      payload: {
        lastName: 'Московский',
        firstName: 'Денис',
        middleName: 'Денисович',
        snils,
        phone: '',
        email: '',
        jobTitle: 'Водитель',
        // Explicit, so that the start date does not depend on the column default.
        employedSince: moscowDay,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const personId = created.json().id as string;

    // Preconditions: one open period of each kind, started on the Moscow day. Without them the
    // closing update would match nothing and the assertions below would prove nothing.
    expect(await periodsOf('person_specializations', personId)).toEqual([
      { started_on: moscowDay, ended_on: null },
    ]);
    expect(await periodsOf('person_employments', personId)).toEqual([
      { started_on: moscowDay, ended_on: null },
    ]);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(anchor);
    try {
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/drivers/${personId}`,
        headers,
      });
      expect(removed.statusCode, removed.body).toBe(204);
    } finally {
      vi.useRealTimers();
    }

    expect(await periodsOf('person_specializations', personId)).toEqual([
      { started_on: moscowDay, ended_on: moscowDay },
    ]);
    expect(await periodsOf('person_employments', personId)).toEqual([
      { started_on: moscowDay, ended_on: moscowDay },
    ]);

    // The faked clock really reached the handler: the removal instant is the anchor itself.
    // `db.execute` returns a timestamptz as a string, so the instant is compared as epoch seconds.
    const person = await db.execute<{ deleted_epoch: string | null }>(
      sql`SELECT EXTRACT(EPOCH FROM deleted_at)::text AS deleted_epoch
            FROM persons WHERE id = ${personId}`,
    );
    expect(Math.round(Number(person.rows[0]?.deleted_epoch) * 1000)).toBe(anchor.getTime());
  }, 60_000);
});
