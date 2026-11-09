import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';
// Types only: the values of these modules are imported after the environment is set — the config
// validates it on import and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';

/**
 * The lessor's receipt of a mechanization rental (plan `docs/mechanization-lessor-receipt-plan.md`,
 * W2) on a real database.
 *
 * The rules themselves are pure functions checked without one (`mech-lessor-receipt-contracts.test.ts`);
 * here is what a substitute always gets right: the schema's own invariants, the migration's data
 * step over real permission sets, and — in the sections that follow — the doors under the request
 * lock, the version 409 before every 422, the write bound to the version the holder saw, and the
 * strict audit rolling the change back.
 *
 * What needs a lessor ACCOUNT (his doors, his scope, his cap) is not here: accounts of the type
 * `mech_lessor` become possible only after the scope guard of W2 step 6, and their suite is
 * `mech-lessor-scope.db.test.ts`.
 *
 * Run on its own database (the file applies the migrations itself):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/<own base> \
 *     npx vitest run test/mech-lessor-receipt.db.test.ts
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like the other `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-mech-lessor-receipt-${RUN}`;
/** Codes start with «яя»: half of the db tests take an object by `ORDER BY … LIMIT 1`. */
const CODE_PREFIX = `яя-MECHLR-${RUN}`;
const GRANT_PREFIX = `test_mech_lessor_receipt_${RUN}`;

const MIGRATION_SUFFIX = '_mech_lessor_receipts.sql';

/** The migration file, found by its suffix: the integrator may renumber it. */
const MIGRATION_FILE = ((): string => {
  const found = listMigrationFiles().filter((name) => name.endsWith(MIGRATION_SUFFIX));
  if (found.length !== 1) {
    throw new Error(`expected exactly one migration *${MIGRATION_SUFFIX}, found ${found.length}`);
  }
  return found[0]!;
})();

/**
 * The data step of the migration, read from the file itself: a copy written into the test would
 * check the copy. The statement is idempotent (`ON CONFLICT DO NOTHING`, and only inserted rows
 * move a version), which is what lets the test run it again over its own sets.
 */
const DATA_STEP = ((): string => {
  const match = /WITH touched AS \([\s\S]*?\)\s*UPDATE grants[\s\S]*?;/u.exec(
    readMigration(MIGRATION_FILE),
  );
  if (!match)
    throw new Error(`no data step "WITH touched AS (…) UPDATE grants …;" in ${MIGRATION_FILE}`);
  return match[0];
})();

type ReceiptInsert = (typeof SchemaNs.mechRequestLessorReceipts)['$inferInsert'];

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  closeDb: () => Promise<void>;
  adminId: string;
  objectId: string;
}

let ctx: Ctx;
let seq = 0;

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
  process.env.MAIL_ENABLED = 'false';
  process.env.RATE_LIMIT_MAX ??= '100000';
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

async function newUser(tag: string, role: SchemaNs.UserRow['role']): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${seq}-${tag}@example.invalid`,
      lastName: 'Тестовый',
      firstName: 'Сотрудник',
      middleName: tag,
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: ctx.schema.users.id });
  return row!.id;
}

/** A bare «Новая» inserted directly: the schema's invariants do not need the doors. */
async function bareRequest(): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.mechRequests)
    .values({
      objectId: ctx.objectId,
      plannedFrom: '2026-11-01',
      plannedTo: '2026-11-10',
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9990000000',
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.mechRequests.id });
  return row!.id;
}

async function bareFile(): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${EMAIL_PREFIX}/${randomUUID()}`,
      filename: 'чек.pdf',
      contentType: 'application/pdf',
      size: 1024,
      status: 'active',
      uploadedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.files.id });
  return row!.id;
}

/** The SQLSTATE and constraint of a refused statement; `null` when it passed. */
async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const cause = (e as { cause?: { constraint?: string; code?: string } }).cause ?? e;
    const { constraint, code } = cause as { constraint?: string; code?: string };
    return constraint ?? code ?? String(e);
  }
}

describe.skipIf(!DB_URL)('механизация: чек арендодателя (план чека, W2)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');
    ctx = { app: await buildApp(), db, schema, tokens, closeDb, adminId: '', objectId: '' };

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `${CODE_PREFIX}-site`,
        name: `Площадка чека ${RUN}`,
        address: 'г. Москва, тестовый проезд, 3',
      })
      .returning({ id: schema.constructionObjects.id });
    ctx.objectId = object!.id;
    ctx.adminId = await newUser('admin', 'admin');
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const users = sql`(SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`;
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${users}`);
    // Receipt versions go with their requests (CASCADE) and hold their files by RESTRICT, so the
    // requests go first, then the files, then the accounts every row names.
    await ctx.db.execute(
      sql`DELETE FROM mech_requests WHERE object_id IN
            (SELECT id FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`})`,
    );
    await ctx.db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${EMAIL_PREFIX}/%`}`);
    await ctx.db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`}`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
    await ctx.db.execute(
      sql`DELETE FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`}`,
    );
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── The migration ──

  describe('миграция', () => {
    it('the lock timeout is the first statement, the ALTER of mech_requests precedes CREATE TABLE', () => {
      const lines = readMigration(MIGRATION_FILE)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('--'));
      expect(lines[0]).toBe("SET LOCAL lock_timeout = '10s';");
      const source = lines.join('\n');
      expect(source.indexOf('ALTER TABLE mech_requests')).toBeGreaterThan(0);
      expect(source.indexOf('ALTER TABLE mech_requests')).toBeLessThan(
        source.indexOf('CREATE TABLE mech_request_lessor_receipts'),
      );
    });

    /**
     * The data step over real sets (P4): every set holding `.status` gets `.lessorReceipt`,
     * deleted ones included, and only a set that actually changed moves its version — a version
     * moved for nothing would send an open editor into a 409 over a set nobody touched.
     *
     * Run inside a transaction that is rolled back: the statement touches every set of the base,
     * and a neighbouring file's set must not keep a change made by this test.
     */
    it('the data step adds the permission to every set holding .status and bumps those only', async () => {
      const client = new pg.Client({ connectionString: DB_URL! });
      await client.connect();
      try {
        await client.query('BEGIN');
        const grant = async (tag: string, permissions: string[], deleted = false) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO grants (code, name, version, deleted_at)
             VALUES ($1, $2, 3, ${deleted ? 'now()' : 'NULL'}) RETURNING id`,
            [`${GRANT_PREFIX}_${tag}`, `Набор ${tag} ${RUN}`],
          );
          const id = rows[0]!.id;
          for (const permission of permissions) {
            await client.query(
              'INSERT INTO grant_permissions (grant_id, permission) VALUES ($1, $2)',
              [id, permission],
            );
          }
          return id;
        };
        const live = await grant('live', ['mechRequests.read', 'mechRequests.status']);
        const deleted = await grant('deleted', ['mechRequests.status'], true);
        const already = await grant('already', [
          'mechRequests.status',
          'mechRequests.lessorReceipt',
        ]);
        const unrelated = await grant('unrelated', ['mechRequests.read']);

        await client.query(DATA_STEP);

        const state = async (id: string) => {
          const { rows } = await client.query<{ version: number; has: boolean }>(
            `SELECT g.version,
                    EXISTS (SELECT 1 FROM grant_permissions gp
                             WHERE gp.grant_id = g.id
                               AND gp.permission = 'mechRequests.lessorReceipt') AS has
               FROM grants g WHERE g.id = $1`,
            [id],
          );
          return rows[0];
        };
        expect(await state(live)).toEqual({ version: 4, has: true });
        expect(await state(deleted), 'a deleted set too: a restore stays consistent').toEqual({
          version: 4,
          has: true,
        });
        expect(await state(already), 'nothing inserted — the version stays').toEqual({
          version: 3,
          has: true,
        });
        expect(await state(unrelated)).toEqual({ version: 3, has: false });
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    });

    it('after the migration no set of the base holds .status without .lessorReceipt', async () => {
      // The post-deploy query of the checklist (plan §5) — expected: none.
      const res = await ctx.db.execute<{ code: string }>(sql`
        SELECT g.code FROM grants g
         WHERE EXISTS (SELECT 1 FROM grant_permissions gp
                        WHERE gp.grant_id = g.id AND gp.permission = 'mechRequests.status')
           AND NOT EXISTS (SELECT 1 FROM grant_permissions gp
                            WHERE gp.grant_id = g.id
                              AND gp.permission = 'mechRequests.lessorReceipt')`);
      expect(res.rows.map((r) => r.code)).toEqual([]);
    });
  });

  // ── The schema's own invariants (P1, P6) ──

  describe('инварианты таблицы версий', () => {
    const insert = (values: Partial<ReceiptInsert> & { requestId: string }) =>
      ctx.db.insert(ctx.schema.mechRequestLessorReceipts).values({
        versionNo: 1,
        status: 'pending',
        createdBy: ctx.adminId,
        createdAs: 'office',
        ...values,
      });

    it('one current version per request; retired ones stay beside it', async () => {
      const requestId = await bareRequest();
      await insert({ requestId, fileId: await bareFile() });
      expect(
        await refusal(async () => insert({ requestId, versionNo: 2, fileId: await bareFile() })),
      ).toBe('mech_lessor_receipts_current_unique');
      await ctx.db
        .update(ctx.schema.mechRequestLessorReceipts)
        .set({ retiredAt: new Date(), retiredBy: ctx.adminId, retiredReason: 'replaced' })
        .where(eq(ctx.schema.mechRequestLessorReceipts.requestId, requestId));
      expect(
        await refusal(async () => insert({ requestId, versionNo: 2, fileId: await bareFile() })),
      ).toBeNull();
      expect(
        await refusal(async () => insert({ requestId, versionNo: 2, fileId: await bareFile() })),
        'the version number is unique per request',
      ).toBe('mech_lessor_receipts_version_unique');
    });

    it('a waiver: no file, the office, born decided by its author, with a reason', async () => {
      const requestId = await bareRequest();
      const now = new Date();
      const waiver = {
        requestId,
        status: 'waived' as const,
        decidedBy: ctx.adminId,
        decidedAt: now,
        decisionComment: 'Арендодатель чек не выдаёт',
      };
      expect(
        await refusal(() => insert({ ...waiver, fileId: undefined, createdAs: 'lessor' })),
      ).toBe('mech_lessor_receipts_waiver_check');
      expect(await refusal(() => insert({ ...waiver, decisionComment: '  ' }))).toBe(
        'mech_lessor_receipts_reason_check',
      );
      expect(await refusal(async () => insert({ ...waiver, fileId: await bareFile() }))).toBe(
        'mech_lessor_receipts_file_check',
      );
      expect(await refusal(() => insert(waiver))).toBeNull();
    });

    it('a decision is whole; only a waiver is retired by revocation', async () => {
      const requestId = await bareRequest();
      expect(
        await refusal(async () =>
          insert({ requestId, fileId: await bareFile(), status: 'approved' }),
        ),
        'approved without who and when',
      ).toBe('mech_lessor_receipts_pending_check');
      expect(
        await refusal(async () =>
          insert({
            requestId,
            fileId: await bareFile(),
            retiredAt: new Date(),
            retiredBy: ctx.adminId,
            retiredReason: 'revoked',
          }),
        ),
      ).toBe('mech_lessor_receipts_revoked_check');
      expect(
        await refusal(async () =>
          insert({ requestId, fileId: await bareFile(), retiredAt: new Date() }),
        ),
        'retired without who and why',
      ).toBe('mech_lessor_receipts_retired_check');
    });

    it('a file version holds its file: deleting the file is refused, not cascaded', async () => {
      const requestId = await bareRequest();
      const fileId = await bareFile();
      await insert({ requestId, fileId });
      expect(
        await refusal(() => ctx.db.delete(ctx.schema.files).where(eq(ctx.schema.files.id, fileId))),
      ).toBe('mech_request_lessor_receipts_file_id_fkey');
    });

    it('old code takes rentals into work with lessor_receipt_required = false', async () => {
      // The deploy window (plan §5): old code does not know the column, and the default is what it
      // writes. Such rentals are not gated at completion, like those taken before the release.
      const requestId = await bareRequest();
      const [row] = await ctx.db
        .select({ required: ctx.schema.mechRequests.lessorReceiptRequired })
        .from(ctx.schema.mechRequests)
        .where(eq(ctx.schema.mechRequests.id, requestId));
      expect(row!.required).toBe(false);
    });
  });
});
