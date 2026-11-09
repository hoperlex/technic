import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  MechLessorReceiptFilter,
  MechLessorReceiptRetireReason,
  MechLessorReceiptStatus,
  MechRequestDto,
} from '@technic/contracts';
import { applyMigrations, listMigrationFiles, readMigration } from '../src/db/migration-journal';
// Types only: the values of these modules are imported after the environment is set — the config
// validates it on import and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';
import type * as ReceiptServiceNs from '../src/services/mech-lessor-receipt';
import type * as DtoServiceNs from '../src/services/mech-request-dto';

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
  receipts: typeof ReceiptServiceNs;
  dto: typeof DtoServiceNs;
  closeDb: () => Promise<void>;
  adminId: string;
  objectId: string;
}

type Headers = { authorization: string };
type Injected = Awaited<ReturnType<Ctx['app']['inject']>>;

let admin: Headers;

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

async function headersOf(userId: string): Promise<Headers> {
  const [row] = await ctx.db
    .select({ role: ctx.schema.users.role, authVersion: ctx.schema.users.authVersion })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  const token = await ctx.tokens.signAccessToken({
    sub: userId,
    role: row!.role,
    av: row!.authVersion,
  });
  return { authorization: `Bearer ${token}` };
}

function call(
  headers: Headers,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/mech-requests${url}`,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
}

function ok(res: Injected, code = 200): Record<string, unknown> {
  expect(res.statusCode, res.body).toBe(code);
  return res.json();
}

async function card(id: string): Promise<MechRequestDto> {
  return ok(await call(admin, 'GET', `/${id}`)) as unknown as MechRequestDto;
}

/**
 * A bare request inserted directly: the schema's invariants and the read side do not need the
 * doors. A «Новая» by default; a cancelled one is just as legal without a deal (`cancel_check`).
 */
async function bareRequest(
  over: { status?: 'new' | 'cancelled'; lessorReceiptRequired?: boolean } = {},
): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.mechRequests)
    .values({
      objectId: ctx.objectId,
      plannedFrom: '2026-11-01',
      plannedTo: '2026-11-10',
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9990000000',
      createdBy: ctx.adminId,
      ...over,
    })
    .returning({ id: ctx.schema.mechRequests.id });
  return row!.id;
}

/**
 * Versions written directly, oldest first: `retired` names why a version is no longer current.
 * A waiver has no file and is born decided by its author; a decided file version carries the
 * decision; the last version without `retired` is the current one.
 */
async function seedVersions(
  requestId: string,
  versions: { status: MechLessorReceiptStatus; retired?: MechLessorReceiptRetireReason }[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, version] of versions.entries()) {
    const decided = version.status !== 'pending';
    const [row] = await ctx.db
      .insert(ctx.schema.mechRequestLessorReceipts)
      .values({
        requestId,
        versionNo: index + 1,
        fileId: version.status === 'waived' ? null : await bareFile(),
        status: version.status,
        createdBy: ctx.adminId,
        createdAs: 'office',
        decidedBy: decided ? ctx.adminId : null,
        decidedAt: decided ? new Date() : null,
        decisionComment:
          version.status === 'rejected' || version.status === 'waived' ? 'Причина' : '',
        ...(version.retired
          ? { retiredAt: new Date(), retiredBy: ctx.adminId, retiredReason: version.retired }
          : {}),
      })
      .returning({ id: ctx.schema.mechRequestLessorReceipts.id });
    ids.push(row!.id);
  }
  return ids;
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
    const receipts = await import('../src/services/mech-lessor-receipt');
    const dto = await import('../src/services/mech-request-dto');
    ctx = {
      app: await buildApp(),
      db,
      schema,
      tokens,
      receipts,
      dto,
      closeDb,
      adminId: '',
      objectId: '',
    };

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
    admin = await headersOf(ctx.adminId);
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

  // ── The read side: the current version, the count and the filter «Чек» (P8, P16) ──

  describe('строки списка и карточка: текущая версия, число версий, фильтр «Чек»', () => {
    /**
     * The count is right per row, read every way the server reads it: the delete door's plain
     * count under the lock, the grouped subquery the list joins, and the DTO. Neighbouring rows with
     * different counts are the point: a count that read the wrong row (the drizzle rewrite of a
     * correlated subquery in a single-table select) gives every row the same number, or zero.
     */
    it('the version count is right per row, neighbours with other counts beside it', async () => {
      const two = await bareRequest();
      const none = await bareRequest();
      const one = await bareRequest();
      await seedVersions(two, [{ status: 'rejected', retired: 'replaced' }, { status: 'pending' }]);
      await seedVersions(one, [{ status: 'pending' }]);
      const expected = { [two]: 2, [none]: 0, [one]: 1 };

      for (const [id, n] of Object.entries(expected)) {
        expect(await ctx.receipts.countMechLessorReceiptVersions(ctx.db, id)).toBe(n);
        expect((await card(id)).lessorReceiptVersionCount).toBe(n);
      }
      const counts = ctx.receipts.mechLessorReceiptVersionCounts;
      const rows = await ctx.db
        .select({
          id: ctx.schema.mechRequests.id,
          n: sql<number>`coalesce(${counts.versionCount}, 0)`,
        })
        .from(ctx.schema.mechRequests)
        .leftJoin(counts, eq(counts.requestId, ctx.schema.mechRequests.id))
        .where(inArray(ctx.schema.mechRequests.id, [two, none, one]));
      expect(Object.fromEntries(rows.map((r) => [r.id, Number(r.n)]))).toEqual(expected);

      // The list reads the count from a joined grouped subquery, not from a correlated subquery
      // in its select list — the form that drizzle's single-table rewrite breaks.
      const listed = ctx.dto.mechBaseQuery().toSQL().sql;
      expect(listed).toMatch(
        /left join \(select .*count\(\*\)::int.* group by .*\) "mech_lessor_receipt_counts"/is,
      );
      const selectList = listed.slice(0, listed.indexOf(' from '));
      expect(selectList).not.toMatch(/select\s+count/i);
    });

    it('a list row carries the current version, the card also the retired ones, newest first', async () => {
      const id = await bareRequest();
      const [first, second, third] = await seedVersions(id, [
        { status: 'rejected', retired: 'replaced' },
        { status: 'approved', retired: 'replaced' },
        { status: 'pending' },
      ]);
      const listed = ok(
        await call(admin, 'GET', `/?placeObjectId=${ctx.objectId}&pageSize=100`),
      ) as unknown as { items: MechRequestDto[] };
      const row = listed.items.find((item) => item.id === id)!;
      expect(row.lessorReceipt).toMatchObject({
        id: third,
        versionNo: 3,
        status: 'pending',
        createdAs: 'office',
        createdByName: expect.stringContaining('Тестовый'),
        retiredAt: null,
        file: { filename: 'чек.pdf', contentType: 'application/pdf' },
      });
      expect(row.lessorReceiptVersionCount).toBe(3);
      expect(row.lessorReceiptRetired, 'list rows never load the retired versions').toBeNull();

      const opened = await card(id);
      expect(opened.lessorReceipt?.id).toBe(third);
      expect(opened.lessorReceiptRetired?.map((v) => [v.id, v.status, v.retiredReason])).toEqual([
        [second, 'approved', 'replaced'],
        [first, 'rejected', 'replaced'],
      ]);
      expect(opened.lessorReceiptRetired?.[0]?.retiredByName).toContain('Тестовый');
    });

    /**
     * The filter is asked of the current row by `EXISTS`, so the count query of the list — which
     * joins only the site and the model — agrees with the page: `total` equals the rows found.
     */
    it('«Чек» picks by the current version; «нет» is required without a current one', async () => {
      const make = async (
        versions: { status: MechLessorReceiptStatus; retired?: MechLessorReceiptRetireReason }[],
        required = true,
      ) => {
        const id = await bareRequest({ lessorReceiptRequired: required });
        await seedVersions(id, versions);
        return id;
      };
      const pending = await make([
        { status: 'rejected', retired: 'replaced' },
        { status: 'pending' },
      ]);
      const rejected = await make([{ status: 'rejected' }]);
      const approved = await make([{ status: 'approved' }]);
      const waived = await make([{ status: 'pending', retired: 'replaced' }, { status: 'waived' }]);
      const missing = await make([]);
      const retiredByDeal = await make([{ status: 'approved', retired: 'deal_changed' }]);
      const notRequired = await make([], false);
      const mine = [pending, rejected, approved, waived, missing, retiredByDeal, notRequired];

      const pick = async (filter: MechLessorReceiptFilter) => {
        const res = ok(
          await call(
            admin,
            'GET',
            `/?placeObjectId=${ctx.objectId}&lessorReceipt=${filter}&pageSize=100`,
          ),
        ) as unknown as { items: MechRequestDto[]; total: number };
        // Rows of the other cases of this file live on the same site: only this case's rows count.
        const ids = res.items.map((item) => item.id).filter((id) => mine.includes(id));
        return { ids: ids.sort(), total: res.total, all: res.items.length };
      };
      const expected: Record<MechLessorReceiptFilter, string[]> = {
        pending: [pending],
        rejected: [rejected],
        approved: [approved],
        waived: [waived],
        missing: [missing, retiredByDeal],
      };
      for (const [filter, ids] of Object.entries(expected)) {
        const found = await pick(filter as MechLessorReceiptFilter);
        expect(found.ids, filter).toEqual([...ids].sort());
        expect(found.total, `${filter}: the count query agrees with the page`).toBe(found.all);
      }
    });

    it('the journal filters closed rentals by «Чек» too, with its summary', async () => {
      const waiting = await bareRequest({ status: 'cancelled', lessorReceiptRequired: true });
      await seedVersions(waiting, [{ status: 'pending' }]);
      const without = await bareRequest({ status: 'cancelled', lessorReceiptRequired: true });
      const old = await bareRequest({ status: 'cancelled' });

      const journal = async (filter: MechLessorReceiptFilter) => {
        const url = `?placeObjectId=${ctx.objectId}&lessorReceipt=${filter}&pageSize=100`;
        const page = ok(await call(admin, 'GET', `/history${url}`)) as unknown as {
          items: MechRequestDto[];
          total: number;
        };
        const summary = ok(await call(admin, 'GET', `/history/summary${url}`)) as unknown as {
          closed: number;
        };
        expect(summary.closed, 'the summary counts the same rows').toBe(page.total);
        return page.items.map((item) => item.id);
      };
      expect(await journal('pending')).toContain(waiting);
      expect(await journal('pending')).not.toContain(without);
      expect(await journal('missing')).toContain(without);
      expect(await journal('missing'), 'not required — not waiting for anything').not.toContain(
        old,
      );
    });

    /**
     * P8: a rental returned to «Новая» may hold an approved prepayment receipt; deleting it archives
     * it, and every version stays. Its neighbour without versions is still deleted for good — the
     * count is per row, read under the lock.
     */
    it('deleting a «Новая» with versions archives it; one without is still hard-deleted', async () => {
      const withVersions = await bareRequest();
      await seedVersions(withVersions, [{ status: 'approved', retired: 'rolled_back' }]);
      const without = await bareRequest();

      const removed = ok(
        await call(
          admin,
          'DELETE',
          `/${withVersions}?version=${(await card(withVersions)).version}`,
        ),
      );
      expect(removed.mode).toBe('soft');
      expect((await card(withVersions)).deletedAt).not.toBeNull();
      expect(await ctx.receipts.countMechLessorReceiptVersions(ctx.db, withVersions)).toBe(1);

      const hard = ok(
        await call(admin, 'DELETE', `/${without}?version=${(await card(without)).version}`),
      );
      expect(hard.mode).toBe('hard');
    });
  });
});
