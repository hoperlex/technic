import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MECH_LESSOR_RECEIPT_CONTENT_TYPE_MESSAGE,
  MECH_LESSOR_RECEIPT_NOT_IN_WORK_MESSAGE,
  MECH_LESSOR_RECEIPT_REVOKE_NOT_IN_WORK_MESSAGE,
  MECH_LESSOR_RECEIPT_SCOPE_MESSAGE,
  MECH_LESSOR_RECEIPT_STALE_MESSAGE,
  MECH_LESSOR_RECEIPT_WAIVER_APPROVED_MESSAGE,
  MECH_LESSOR_RECEIPT_WAIVER_NOT_IN_WORK_MESSAGE,
  MECH_LESSOR_RECEIPT_WAIVER_REPEATED_MESSAGE,
  moscowDateKeyOf,
  shiftDateKey,
  type MechLessorReceiptFilter,
  type MechLessorReceiptReplyDto,
  type MechLessorReceiptRetireReason,
  type MechLessorReceiptStatus,
  type MechLessorReceiptVersionDto,
  type MechRequestDto,
  type RequestHistoryEntryDto,
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

const MARK = `ТЕСТОВЫЕ ДАННЫЕ: чек арендодателя механизации ${RUN}`;

const TODAY = moscowDateKeyOf(new Date());
const WEEK_AGO = shiftDateKey(TODAY, -7);
const PLANNED_TO = shiftDateKey(TODAY, 10);

/** The completion of a rental issued a week ago — what the status door asks for `done`. */
const COMPLETION = { actualFrom: WEEK_AGO, actualTo: TODAY, actualUnits: 6, finalCost: 9000 };

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
  otherObjectId: string;
  departmentId: string;
  lessorId: string;
  otherLessorId: string;
  modelId: string;
}

/** Who acts in the door suites, by role and scope (ADR 0171 decision 4 for the visa circle). */
interface People {
  /** The site's visa holder: files and signs the site's rentals. */
  rukstroy: string;
  /** A visa holder of another site: the permission without the scope. */
  otherRukstroy: string;
  /** The head of the department the site belongs to: signs his department's rentals only. */
  head: string;
  /** Runs rentals and attaches receipts; no visa. */
  dispatcher: string;
}

type Headers = { authorization: string };
type Injected = Awaited<ReturnType<Ctx['app']['inject']>>;

let admin: Headers;
let people: People;
let auth: Record<keyof People, Headers>;

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

async function newUser(
  tag: string,
  role: SchemaNs.UserRow['role'],
  scope: { objectIds?: string[]; departmentIds?: string[] } = {},
): Promise<string> {
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
  for (const objectId of scope.objectIds ?? []) {
    await ctx.db
      .insert(ctx.schema.userConstructionObjects)
      .values({ userId: row!.id, constructionObjectId: objectId });
  }
  for (const departmentId of scope.departmentIds ?? []) {
    await ctx.db
      .insert(ctx.schema.userDepartments)
      .values({ userId: row!.id, departmentId, isHead: true });
  }
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
  payload?: Record<string, unknown>,
): Promise<Injected> {
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
        dealNo: 1,
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

/**
 * A rental taken into work through the doors: filed by the site's visa holder (or by the department
 * head for his department) — signed by the filing itself — and taken in by the administrator with
 * the deal, issued a week ago unless `issued: false`.
 */
async function rental(
  over: { department?: boolean; issued?: boolean } = {},
): Promise<MechRequestDto> {
  const created = ok(
    await call(over.department ? auth.head : auth.rukstroy, 'POST', '/', {
      objectId: ctx.objectId,
      ...(over.department ? { departmentId: ctx.departmentId } : {}),
      mechModelId: ctx.modelId,
      plannedFrom: WEEK_AGO,
      plannedTo: PLANNED_TO,
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9990000000',
      comment: MARK,
    }),
    201,
  ) as unknown as MechRequestDto;
  ok(
    await call(admin, 'PATCH', `/${created.id}/status`, {
      status: 'confirmed',
      deal: { lessorId: ctx.lessorId, rate: 1500, rateUnit: 'shift' },
      ...(over.issued === false ? {} : { actualFrom: WEEK_AGO }),
      version: created.version,
    }),
  );
  return card(created.id);
}

/** An upload of `userId`, finished unless said otherwise: the door asks for the uploader's own. */
async function upload(
  userId: string,
  over: { contentType?: string; status?: 'pending' | 'active'; filename?: string } = {},
): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${EMAIL_PREFIX}/${randomUUID()}`,
      filename: over.filename ?? 'чек.pdf',
      contentType: over.contentType ?? 'application/pdf',
      size: 2048,
      status: over.status ?? 'active',
      uploadedBy: userId,
    })
    .returning({ id: ctx.schema.files.id });
  return row!.id;
}

async function versionOf(id: string): Promise<number> {
  return (await card(id)).version;
}

/** Attach as `who` (the dispatcher by default) a fresh PDF of his own, or the given file. */
async function attach(
  id: string,
  over: { who?: keyof People | 'admin'; fileId?: string; version?: number } = {},
): Promise<Injected> {
  const who = over.who ?? 'dispatcher';
  const fileId = over.fileId ?? (await upload(who === 'admin' ? ctx.adminId : people[who]));
  return call(who === 'admin' ? admin : auth[who], 'POST', `/${id}/lessor-receipt`, {
    fileId,
    version: over.version ?? (await versionOf(id)),
  });
}

async function attached(
  id: string,
  who?: keyof People | 'admin',
): Promise<MechLessorReceiptReplyDto> {
  return ok(await attach(id, { who })) as unknown as MechLessorReceiptReplyDto;
}

/** The office branch of a reply's block — every caller in this file is the office. */
function officeOf(reply: MechLessorReceiptReplyDto) {
  if (reply.lessorReceipt.audience !== 'office') throw new Error('expected the office audience');
  return reply.lessorReceipt;
}

async function decide(
  id: string,
  body: {
    decision: 'approve' | 'reject' | 'revoke';
    receiptId?: string;
    comment?: string;
    version?: number;
  },
  headers: Headers = auth.rukstroy,
): Promise<Injected> {
  const opened = await card(id);
  return call(headers, 'PATCH', `/${id}/lessor-receipt`, {
    receiptId: body.receiptId ?? opened.lessorReceipt?.id,
    decision: body.decision,
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
    version: body.version ?? opened.version,
  });
}

async function waive(
  id: string,
  over: { comment?: string; version?: number; headers?: Headers } = {},
): Promise<Injected> {
  return call(over.headers ?? auth.rukstroy, 'POST', `/${id}/lessor-receipt/waiver`, {
    comment: over.comment ?? 'Арендодатель чеков не выдаёт',
    version: over.version ?? (await versionOf(id)),
  });
}

async function complete(id: string): Promise<Injected> {
  return call(admin, 'PATCH', `/${id}/status`, {
    status: 'done',
    completion: COMPLETION,
    version: await versionOf(id),
  });
}

async function setStatus(
  id: string,
  status: 'new' | 'confirmed' | 'cancelled',
  extra: Record<string, unknown> = {},
): Promise<Injected> {
  return call(admin, 'PATCH', `/${id}/status`, { status, ...extra, version: await versionOf(id) });
}

function refusedWith(res: Injected, code: number, message?: string): void {
  expect(res.statusCode, res.body).toBe(code);
  if (message !== undefined) expect(res.json().message).toBe(message);
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
      otherObjectId: '',
      departmentId: '',
      lessorId: '',
      otherLessorId: '',
      modelId: '',
    };

    const object = async (tag: string): Promise<string> => {
      const [row] = await db
        .insert(schema.constructionObjects)
        .values({
          code: `${CODE_PREFIX}-${tag}`,
          name: `Площадка чека ${tag} ${RUN}`,
          address: 'г. Москва, тестовый проезд, 3',
        })
        .returning({ id: schema.constructionObjects.id });
      return row!.id;
    };
    ctx.objectId = await object('site');
    ctx.otherObjectId = await object('other');
    const [department] = await db
      .insert(schema.departments)
      .values({ code: `${CODE_PREFIX}-DEP`, name: `Отдел снабжения ${RUN}` })
      .returning({ id: schema.departments.id });
    ctx.departmentId = department!.id;
    await db
      .insert(schema.departmentConstructionObjects)
      .values({ departmentId: ctx.departmentId, constructionObjectId: ctx.objectId });
    const [lessor] = await db
      .insert(schema.counterparties)
      .values({
        type: 'mech_lessor',
        name: `Арендодатель чека ${RUN}`,
        inn: `8${String(Date.now() % 100_000_000).padStart(8, '0')}5`,
        isActive: true,
        comment: MARK,
      })
      .returning({ id: schema.counterparties.id });
    ctx.lessorId = lessor!.id;
    const [otherLessor] = await db
      .insert(schema.counterparties)
      .values({
        type: 'mech_lessor',
        name: `Другой арендодатель чека ${RUN}`,
        inn: `8${String((Date.now() + 1) % 100_000_000).padStart(8, '0')}6`,
        isActive: true,
        comment: MARK,
      })
      .returning({ id: schema.counterparties.id });
    ctx.otherLessorId = otherLessor!.id;
    const [model] = await db
      .insert(schema.mechModels)
      .values({ code: `mech-lessor-receipt-${RUN}`, name: `Виброплита чека ${RUN}` })
      .returning({ id: schema.mechModels.id });
    ctx.modelId = model!.id;

    ctx.adminId = await newUser('admin', 'admin');
    admin = await headersOf(ctx.adminId);
    people = {
      rukstroy: await newUser('rukstroy', 'rukstroy', { objectIds: [ctx.objectId] }),
      otherRukstroy: await newUser('other-rukstroy', 'rukstroy', {
        objectIds: [ctx.otherObjectId],
      }),
      head: await newUser('head', 'department_head', { departmentIds: [ctx.departmentId] }),
      dispatcher: await newUser('dispatcher', 'dispatcher'),
    };
    auth = {
      rukstroy: await headersOf(people.rukstroy),
      otherRukstroy: await headersOf(people.otherRukstroy),
      head: await headersOf(people.head),
      dispatcher: await headersOf(people.dispatcher),
    };
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
    await ctx.db.execute(sql`DELETE FROM counterparties WHERE comment = ${MARK}`);
    await ctx.db.execute(sql`DELETE FROM mech_models WHERE code = ${`mech-lessor-receipt-${RUN}`}`);
    await ctx.db.execute(
      sql`DELETE FROM department_construction_objects WHERE department_id IN
            (SELECT id FROM departments WHERE code = ${`${CODE_PREFIX}-DEP`})`,
    );
    await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
    await ctx.db.execute(sql`DELETE FROM departments WHERE code = ${`${CODE_PREFIX}-DEP`}`);
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
        dealNo: 1,
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

  // ── Attaching and replacing (P7) ──

  describe('прикрепление и замена (P7)', () => {
    it('the office attaches: a pending version, the rental gated, the request version moved', async () => {
      const request = await rental();
      const reply = await attached(request.id);
      const block = officeOf(reply);
      const opened = await card(request.id);
      expect(reply.version).toBe(opened.version);
      expect(opened.version).toBe(request.version + 1);
      expect(block.required).toBe(true);
      expect(block.retired).toEqual([]);
      expect(block.current).toMatchObject({
        versionNo: 1,
        status: 'pending',
        createdAs: 'office',
        createdBy: people.dispatcher,
        createdByName: expect.stringContaining('dispatcher'),
        decidedAt: null,
        file: { filename: 'чек.pdf', contentType: 'application/pdf' },
      });
      expect(opened.lessorReceiptRequired).toBe(true);
      expect(opened.lessorReceipt?.id).toBe(block.current!.id);
    });

    it('replacing retires the previous version, its status intact — an approval stays approved', async () => {
      const request = await rental();
      const first = officeOf(await attached(request.id)).current!;
      ok(await decide(request.id, { decision: 'approve' }));
      // The office replaces even an approved receipt (O13); the new version asks for a new visa.
      const reply = officeOf(await attached(request.id));
      expect(reply.current).toMatchObject({ versionNo: 2, status: 'pending' });
      expect(
        reply.retired.map((v: MechLessorReceiptVersionDto) => [v.id, v.status, v.retiredReason]),
      ).toEqual([[first.id, 'approved', 'replaced']]);
      expect(reply.retired[0]!.retiredByName).toContain('dispatcher');
      expect((await card(request.id)).lessorReceiptVersionCount).toBe(2);
    });

    it('a JPEG is accepted; another declared type is refused with the receipt words', async () => {
      const request = await rental();
      const png = await upload(people.dispatcher, {
        contentType: 'image/png',
        filename: 'чек.png',
      });
      refusedWith(
        await attach(request.id, { fileId: png }),
        422,
        MECH_LESSOR_RECEIPT_CONTENT_TYPE_MESSAGE,
      );
      const jpeg = await upload(people.dispatcher, {
        contentType: 'image/jpeg',
        filename: 'чек.jpg',
      });
      ok(await attach(request.id, { fileId: jpeg }));
    });

    it('an unfinished, foreign or already attached file is refused', async () => {
      const request = await rental();
      const unfinished = await upload(people.dispatcher, { status: 'pending' });
      refusedWith(await attach(request.id, { fileId: unfinished }), 400);
      const foreign = await upload(ctx.adminId);
      refusedWith(await attach(request.id, { fileId: foreign }), 400);
      const once = await upload(people.dispatcher);
      ok(await attach(request.id, { fileId: once }));
      const neighbour = await rental();
      refusedWith(await attach(neighbour.id, { fileId: once }), 400);
    });

    it('only a rental in work takes a receipt: not «Новая», cancelled, done or archived', async () => {
      const fresh = ok(
        await call(auth.rukstroy, 'POST', '/', {
          objectId: ctx.objectId,
          mechModelId: ctx.modelId,
          plannedFrom: WEEK_AGO,
          plannedTo: PLANNED_TO,
          responsibleName: 'Иванов Иван',
          responsiblePhone: '9990000000',
          comment: MARK,
        }),
        201,
      ) as unknown as MechRequestDto;
      refusedWith(await attach(fresh.id), 422, MECH_LESSOR_RECEIPT_NOT_IN_WORK_MESSAGE);

      const cancelled = await rental({ issued: false });
      ok(await setStatus(cancelled.id, 'cancelled', { comment: 'Передумали' }));
      refusedWith(await attach(cancelled.id), 422, MECH_LESSOR_RECEIPT_NOT_IN_WORK_MESSAGE);

      const done = await rental();
      await ctx.db
        .update(ctx.schema.mechRequests)
        .set({ lessorReceiptRequired: false })
        .where(eq(ctx.schema.mechRequests.id, done.id));
      ok(await complete(done.id));
      refusedWith(await attach(done.id), 422, MECH_LESSOR_RECEIPT_NOT_IN_WORK_MESSAGE);

      const archived = await rental({ issued: false });
      ok(await call(admin, 'DELETE', `/${archived.id}?version=${archived.version}`));
      const refused = await attach(archived.id, { who: 'admin' });
      refusedWith(refused, 422);
      expect(refused.json().message).toMatch(/в архиве/);
    });

    it('the version 409 comes before any 422', async () => {
      const fresh = ok(
        await call(auth.rukstroy, 'POST', '/', {
          objectId: ctx.objectId,
          mechModelId: ctx.modelId,
          plannedFrom: WEEK_AGO,
          plannedTo: PLANNED_TO,
          responsibleName: 'Иванов Иван',
          responsiblePhone: '9990000000',
          comment: MARK,
        }),
        201,
      ) as unknown as MechRequestDto;
      // «Новая» would be a 422; a stale version answers first.
      refusedWith(await attach(fresh.id, { version: fresh.version + 5 }), 409);
    });

    it('a holder without the permission is refused before the door', async () => {
      const request = await rental();
      refusedWith(await attach(request.id, { who: 'rukstroy' }), 403);
    });
  });

  // ── Deciding (P5) ──

  describe('решение визирующего (P5)', () => {
    it('the site visa holder approves, his remark kept', async () => {
      const request = await rental();
      await attached(request.id);
      const reply = officeOf(
        ok(
          await decide(request.id, { decision: 'approve', comment: 'Сумма сверена' }),
        ) as unknown as MechLessorReceiptReplyDto,
      );
      expect(reply.current).toMatchObject({
        status: 'approved',
        decidedBy: people.rukstroy,
        decidedByName: expect.stringContaining('rukstroy'),
        decisionComment: 'Сумма сверена',
      });
      expect(reply.current!.decidedAt).not.toBeNull();
    });

    it('a rejection needs its reason', async () => {
      const request = await rental();
      await attached(request.id);
      refusedWith(await decide(request.id, { decision: 'reject' }), 400);
      const reply = officeOf(
        ok(
          await decide(request.id, { decision: 'reject', comment: 'Не та сумма' }),
        ) as unknown as MechLessorReceiptReplyDto,
      );
      expect(reply.current).toMatchObject({ status: 'rejected', decisionComment: 'Не та сумма' });
    });

    it('a pending receipt of a rental cancelled after it was attached is still decided', async () => {
      const request = await rental({ issued: false });
      await attached(request.id);
      ok(await setStatus(request.id, 'cancelled', { comment: 'Передумали' }));
      ok(await decide(request.id, { decision: 'approve' }));
    });

    it('no decision while the rental is archived', async () => {
      const request = await rental({ issued: false });
      await attached(request.id);
      ok(await call(admin, 'DELETE', `/${request.id}?version=${await versionOf(request.id)}`));
      const refused = await decide(request.id, { decision: 'approve' }, admin);
      refusedWith(refused, 422);
      expect(refused.json().message).toMatch(/в архиве/);
    });

    it('revoking an approval returns the version to pending, and the gate closes again', async () => {
      const request = await rental();
      await attached(request.id);
      ok(await decide(request.id, { decision: 'approve', comment: 'Сверено' }));
      refusedWith(await decide(request.id, { decision: 'revoke' }), 400);
      const reply = officeOf(
        ok(
          await decide(request.id, { decision: 'revoke', comment: 'Сумма не та' }),
        ) as unknown as MechLessorReceiptReplyDto,
      );
      expect(reply.current).toMatchObject({
        versionNo: 1,
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        decisionComment: '',
        retiredAt: null,
      });
      refusedWith(
        await complete(request.id),
        422,
        'Чек арендодателя ждёт визы — аренду завершают после неё',
      );
    });

    it('revoking a waiver retires it «revoked»; the rental needs a receipt again', async () => {
      const request = await rental();
      await attached(request.id);
      ok(await waive(request.id));
      const waiver = (await card(request.id)).lessorReceipt!;
      expect(waiver.status).toBe('waived');
      const reply = officeOf(
        ok(
          await decide(request.id, { decision: 'revoke', comment: 'Чек нашёлся' }),
        ) as unknown as MechLessorReceiptReplyDto,
      );
      expect(reply.current).toBeNull();
      expect(reply.retired[0]).toMatchObject({
        id: waiver.id,
        status: 'waived',
        retiredReason: 'revoked',
      });
      refusedWith(
        await complete(request.id),
        422,
        'Прикрепите чек арендодателя или получите визу «без чека»',
      );
    });

    it('no revocation after completion: the approval is the basis of a closed rental', async () => {
      const request = await rental();
      await attached(request.id);
      ok(await decide(request.id, { decision: 'approve' }));
      ok(await complete(request.id));
      refusedWith(
        await decide(request.id, { decision: 'revoke', comment: 'Поздно' }),
        422,
        MECH_LESSOR_RECEIPT_REVOKE_NOT_IN_WORK_MESSAGE,
      );
    });

    it('a stale receiptId gets the receipt words on the version 409', async () => {
      const request = await rental();
      const first = officeOf(await attached(request.id)).current!;
      const seenVersion = await versionOf(request.id);
      await attached(request.id);
      // The window opened before the replacement: its version and its receipt are both stale.
      refusedWith(
        await decide(request.id, {
          decision: 'approve',
          receiptId: first.id,
          version: seenVersion,
        }),
        409,
        MECH_LESSOR_RECEIPT_STALE_MESSAGE,
      );
      // A fresh version with the old receipt is the same answer.
      refusedWith(
        await decide(request.id, { decision: 'approve', receiptId: first.id }),
        409,
        MECH_LESSOR_RECEIPT_STALE_MESSAGE,
      );
      // A stale version with the current receipt keeps the module's own words.
      const refused = await decide(request.id, { decision: 'approve', version: seenVersion });
      refusedWith(refused, 409);
      expect(refused.json().message).not.toBe(MECH_LESSOR_RECEIPT_STALE_MESSAGE);
    });

    it('a receiptId of another request is refused 409 and changes neither request', async () => {
      const mine = await rental();
      const theirs = await rental();
      await attached(mine.id);
      const foreign = officeOf(await attached(theirs.id)).current!;
      const before = [await card(mine.id), await card(theirs.id)];
      refusedWith(
        await decide(mine.id, { decision: 'approve', receiptId: foreign.id }),
        409,
        MECH_LESSOR_RECEIPT_STALE_MESSAGE,
      );
      const after = [await card(mine.id), await card(theirs.id)];
      expect(after.map((r) => [r.version, r.lessorReceipt?.status])).toEqual(
        before.map((r) => [r.version, r.lessorReceipt?.status]),
      );
    });

    it('the version 409 comes before the 422 of a decided receipt', async () => {
      const request = await rental();
      await attached(request.id);
      const seenVersion = await versionOf(request.id);
      ok(await decide(request.id, { decision: 'approve' }));
      refusedWith(await decide(request.id, { decision: 'approve', version: seenVersion }), 409);
    });

    it('the visa circle: another site 403, a head of the site but not of this request 403', async () => {
      const request = await rental();
      await attached(request.id);
      refusedWith(await decide(request.id, { decision: 'approve' }, auth.otherRukstroy), 403);
      // The department head sees the site's rental (his department's site) but did not file it.
      refusedWith(
        await decide(request.id, { decision: 'approve' }, auth.head),
        403,
        MECH_LESSOR_RECEIPT_SCOPE_MESSAGE,
      );
      refusedWith(await decide(request.id, { decision: 'approve' }, auth.dispatcher), 403);
    });

    it('the department head signs the receipt of his department rental (ADR 0171 decision 4)', async () => {
      const request = await rental({ department: true });
      await attached(request.id);
      ok(await decide(request.id, { decision: 'approve' }, auth.head));
    });

    it('the one who attached may approve his own version (O14)', async () => {
      const request = await rental();
      await attached(request.id, 'admin');
      ok(await decide(request.id, { decision: 'approve' }, admin));
    });
  });

  // ── The «без чека» visa (P6) ──

  describe('«без чека» (P6)', () => {
    it('over nothing, over a pending file (replacing it) and over a rejection', async () => {
      const bare = await rental();
      const overNothing = officeOf(
        ok(await waive(bare.id)) as unknown as MechLessorReceiptReplyDto,
      );
      expect(overNothing.current).toMatchObject({
        versionNo: 1,
        status: 'waived',
        file: null,
        createdAs: 'office',
        createdBy: people.rukstroy,
        decidedBy: people.rukstroy,
        decisionComment: 'Арендодатель чеков не выдаёт',
      });

      const pending = await rental();
      const file = officeOf(await attached(pending.id)).current!;
      const overPending = officeOf(
        ok(await waive(pending.id)) as unknown as MechLessorReceiptReplyDto,
      );
      expect(overPending.current).toMatchObject({ versionNo: 2, status: 'waived' });
      expect(
        overPending.retired.map((v: MechLessorReceiptVersionDto) => [
          v.id,
          v.status,
          v.retiredReason,
        ]),
      ).toEqual([[file.id, 'pending', 'replaced']]);

      const rejected = await rental();
      await attached(rejected.id);
      ok(await decide(rejected.id, { decision: 'reject', comment: 'Нечитаемо' }));
      ok(await waive(rejected.id));
    });

    it('not over an approval, not twice, only in work', async () => {
      const approved = await rental();
      await attached(approved.id);
      ok(await decide(approved.id, { decision: 'approve' }));
      refusedWith(await waive(approved.id), 422, MECH_LESSOR_RECEIPT_WAIVER_APPROVED_MESSAGE);

      const twice = await rental();
      ok(await waive(twice.id));
      refusedWith(await waive(twice.id), 422, MECH_LESSOR_RECEIPT_WAIVER_REPEATED_MESSAGE);

      const cancelled = await rental({ issued: false });
      ok(await setStatus(cancelled.id, 'cancelled', { comment: 'Передумали' }));
      refusedWith(await waive(cancelled.id), 422, MECH_LESSOR_RECEIPT_WAIVER_NOT_IN_WORK_MESSAGE);
    });

    it('a reason is required, and only the visa circle waives', async () => {
      const request = await rental();
      refusedWith(await waive(request.id, { comment: ' ' }), 400);
      refusedWith(await waive(request.id, { headers: auth.dispatcher }), 403);
      refusedWith(
        await waive(request.id, { headers: auth.head }),
        403,
        MECH_LESSOR_RECEIPT_SCOPE_MESSAGE,
      );
    });
  });

  // ── The completion gate (P3) ──

  describe('ворота завершения (P3)', () => {
    it('a required receipt holds completion: 422 while pending, passes once approved', async () => {
      const request = await rental();
      await attached(request.id);
      refusedWith(
        await complete(request.id),
        422,
        'Чек арендодателя ждёт визы — аренду завершают после неё',
      );
      ok(await decide(request.id, { decision: 'reject', comment: 'Не та сумма' }));
      refusedWith(
        await complete(request.id),
        422,
        'Чек арендодателя отклонён — прикрепите исправленный',
      );
      await attached(request.id);
      ok(await decide(request.id, { decision: 'approve' }));
      ok(await complete(request.id));
    });

    it('a waiver lets the rental complete', async () => {
      const request = await rental();
      await attached(request.id);
      ok(await waive(request.id));
      ok(await complete(request.id));
    });

    it('a rental not requiring a receipt completes; attaching one gates it', async () => {
      // A rental taken into work before the release, or by the old code in the deploy window.
      const old = await rental();
      await ctx.db
        .update(ctx.schema.mechRequests)
        .set({ lessorReceiptRequired: false })
        .where(eq(ctx.schema.mechRequests.id, old.id));
      ok(await complete(old.id));

      const gated = await rental();
      await ctx.db
        .update(ctx.schema.mechRequests)
        .set({ lessorReceiptRequired: false })
        .where(eq(ctx.schema.mechRequests.id, gated.id));
      await attached(gated.id);
      expect((await card(gated.id)).lessorReceiptRequired).toBe(true);
      refusedWith(await complete(gated.id), 422);
    });
  });

  // ── What else touches the receipt (P8) ──

  describe('договорённость, откаты, удаление и purge (P8)', () => {
    async function deal(
      id: string,
      body: { lessorId?: string; rate?: number; rateUnit?: 'hour' | 'shift' },
    ): Promise<Injected> {
      return call(admin, 'PATCH', `/${id}/deal`, {
        lessorId: body.lessorId ?? ctx.lessorId,
        rate: body.rate ?? 1500,
        rateUnit: body.rateUnit ?? 'shift',
        version: await versionOf(id),
      });
    }

    async function approvedRental(over: { issued?: boolean } = {}): Promise<MechRequestDto> {
      const request = await rental(over);
      await attached(request.id);
      ok(await decide(request.id, { decision: 'approve' }));
      return card(request.id);
    }

    it('taking a «Новая» into work makes it require a receipt', async () => {
      const request = await rental({ issued: false });
      expect(request.lessorReceiptRequired).toBe(true);
      expect(request.lessorReceipt).toBeNull();
    });

    it('the same deal again retires nothing: 1500 against the stored 1500.00 is no change', async () => {
      const request = await approvedRental({ issued: false });
      const [stored] = await ctx.db
        .select({ rate: ctx.schema.mechRequests.rate })
        .from(ctx.schema.mechRequests)
        .where(eq(ctx.schema.mechRequests.id, request.id));
      expect(stored!.rate).toBe('1500.00');
      ok(await deal(request.id, { rate: 1500 }));
      const opened = await card(request.id);
      expect(opened.lessorReceipt?.status).toBe('approved');
      expect(opened.lessorReceiptRetired).toEqual([]);
    });

    it('a new rate, unit or lessor retires the current version «deal_changed»', async () => {
      for (const change of [
        { rate: 1600 },
        { rateUnit: 'hour' as const },
        { lessorId: ctx.otherLessorId },
      ]) {
        const request = await approvedRental({ issued: false });
        const approved = request.lessorReceipt!;
        ok(await deal(request.id, change));
        const opened = await card(request.id);
        expect(opened.lessorReceipt, JSON.stringify(change)).toBeNull();
        expect(opened.lessorReceiptRetired?.[0]).toMatchObject({
          id: approved.id,
          status: 'approved',
          retiredReason: 'deal_changed',
        });
      }
    });

    it('«В работе» → «Новая» retires the current version «rolled_back»', async () => {
      const request = await approvedRental({ issued: false });
      ok(await setStatus(request.id, 'new', { comment: 'Не та модель' }));
      const opened = await card(request.id);
      expect(opened.lessorReceipt).toBeNull();
      expect(opened.lessorReceiptRetired?.[0]).toMatchObject({
        status: 'approved',
        retiredReason: 'rolled_back',
      });
      expect(opened.lessorReceiptVersionCount).toBe(1);
    });

    /**
     * The chain the plan names: naming only `confirmed → new` would leave the old deal's approved
     * receipt current after `cancelled → new → confirmed`, passing the new deal's gate.
     */
    it('«Отменена» → «Новая» retires it too, and the next deal starts without a receipt', async () => {
      const request = await approvedRental({ issued: false });
      ok(await setStatus(request.id, 'cancelled', { comment: 'Передумали' }));
      expect((await card(request.id)).lessorReceipt?.status, 'cancellation keeps it').toBe(
        'approved',
      );
      ok(await setStatus(request.id, 'new', { comment: 'Снова нужна' }));
      expect((await card(request.id)).lessorReceipt).toBeNull();
      ok(
        await setStatus(request.id, 'confirmed', {
          deal: { lessorId: ctx.otherLessorId, rate: 1700, rateUnit: 'shift' },
          actualFrom: WEEK_AGO,
        }),
      );
      refusedWith(
        await complete(request.id),
        422,
        'Прикрепите чек арендодателя или получите визу «без чека»',
      );
    });

    it('«Вернуть в работу» keeps the approval: the repeat completion passes', async () => {
      const request = await approvedRental();
      ok(await complete(request.id));
      ok(await setStatus(request.id, 'confirmed', { comment: 'Исправить отработанное' }));
      expect((await card(request.id)).lessorReceipt?.status).toBe('approved');
      ok(await complete(request.id));
    });

    it('deleting a «Новая» that kept versions archives it, the versions stay', async () => {
      const request = await approvedRental({ issued: false });
      ok(await setStatus(request.id, 'new', { comment: 'Не та модель' }));
      const removed = ok(
        await call(admin, 'DELETE', `/${request.id}?version=${await versionOf(request.id)}`),
      );
      expect(removed.mode).toBe('soft');
      const opened = await card(request.id);
      expect(opened.deletedAt).not.toBeNull();
      expect(opened.lessorReceiptVersionCount).toBe(1);
    });

    it('purge removes every version and every version file', async () => {
      const request = await rental({ issued: false });
      const first = officeOf(await attached(request.id)).current!;
      const second = officeOf(await attached(request.id)).current!;
      ok(await setStatus(request.id, 'cancelled', { comment: 'Передумали' }));
      ok(await call(admin, 'DELETE', `/${request.id}?version=${await versionOf(request.id)}`));
      ok(
        await call(admin, 'DELETE', `/${request.id}/purge?version=${await versionOf(request.id)}`),
      );
      const fileIds = [first.file!.id, second.file!.id];
      const left = await ctx.db
        .select({ id: ctx.schema.files.id })
        .from(ctx.schema.files)
        .where(inArray(ctx.schema.files.id, fileIds));
      expect(left, 'every version file is deleted with the request').toEqual([]);
      const versions = await ctx.db
        .select({ id: ctx.schema.mechRequestLessorReceipts.id })
        .from(ctx.schema.mechRequestLessorReceipts)
        .where(eq(ctx.schema.mechRequestLessorReceipts.requestId, request.id));
      expect(versions).toEqual([]);
    });
  });

  // ── History and the strict audit (P9) ──

  describe('история и строгий аудит (P9)', () => {
    async function history(id: string): Promise<RequestHistoryEntryDto[]> {
      const entries = ok(
        await call(admin, 'GET', `/${id}/history`),
      ) as unknown as RequestHistoryEntryDto[];
      // Chronological, as the card shows them.
      return entries.filter((e) => e.kind.startsWith('mechLessorReceipt'));
    }

    function lines(entry: RequestHistoryEntryDto | undefined): Record<string, string | null> {
      return Object.fromEntries((entry?.changes ?? []).map((c) => [c.field, c.to]));
    }

    it('every receipt event reaches the card as its own kind, with its change keys', async () => {
      const request = await rental({ issued: false });
      const first = officeOf(await attached(request.id)).current!;
      ok(await decide(request.id, { decision: 'reject', comment: 'Нечитаемо' }));
      await attached(request.id);
      ok(await decide(request.id, { decision: 'approve', comment: 'Сверено' }));
      ok(await decide(request.id, { decision: 'revoke', comment: 'Сумма не та' }));
      ok(await waive(request.id, { comment: 'Чек потерян' }));
      ok(await decide(request.id, { decision: 'revoke', comment: 'Чек нашёлся' }));
      await attached(request.id);
      ok(
        await call(admin, 'PATCH', `/${request.id}/deal`, {
          lessorId: ctx.lessorId,
          rate: 1600,
          rateUnit: 'shift',
          version: await versionOf(request.id),
        }),
      );

      const events = await history(request.id);
      expect(events.map((e) => e.kind)).toEqual([
        'mechLessorReceiptAttached',
        'mechLessorReceiptRejected',
        'mechLessorReceiptAttached',
        'mechLessorReceiptApproved',
        'mechLessorReceiptRevoked',
        'mechLessorReceiptWaived',
        'mechLessorReceiptRevoked',
        'mechLessorReceiptAttached',
        'mechLessorReceiptRetired',
      ]);
      const [attach1, reject, attach2, approve, revoke, waiver, unwaive, attach4, retire] = events;
      expect(lines(attach1)).toEqual({ lessorReceiptVersion: '1', filesAdded: 'чек.pdf' });
      // The file rides as a file list with its id, so the history line opens the version (O8).
      expect(attach1!.changes.find((c) => c.field === 'filesAdded')?.files).toEqual([
        { id: first.file!.id, filename: 'чек.pdf' },
      ]);
      expect(lines(reject)).toEqual({
        lessorReceiptVersion: '1',
        lessorReceiptRejectReason: 'Нечитаемо',
      });
      expect(lines(attach2)).toMatchObject({
        lessorReceiptVersion: '2',
        lessorReceiptReplaced: '1 — отклонён',
      });
      expect(lines(approve)).toEqual({
        lessorReceiptVersion: '2',
        lessorReceiptApproveComment: 'Сверено',
      });
      expect(lines(revoke)).toEqual({
        lessorReceiptVersion: '2',
        lessorReceiptRevoked: 'утверждение',
        lessorReceiptRevokeReason: 'Сумма не та',
      });
      expect(lines(waiver)).toEqual({
        lessorReceiptVersion: '3',
        lessorReceiptWaiveReason: 'Чек потерян',
        lessorReceiptReplaced: '2 — ждёт визы',
      });
      expect(lines(unwaive)).toEqual({
        lessorReceiptVersion: '3',
        lessorReceiptRevoked: '«без чека»',
        lessorReceiptRevokeReason: 'Чек нашёлся',
      });
      expect(lines(attach4)).toEqual({ lessorReceiptVersion: '4', filesAdded: 'чек.pdf' });
      expect(lines(retire)).toEqual({
        lessorReceiptVersion: '4',
        lessorReceiptRetireReason: 'изменилась договорённость',
      });
      expect(retire!.actorId).toBe(ctx.adminId);
    });

    it('a return to «Новая» names its own reason in the retire event', async () => {
      const request = await rental({ issued: false });
      await attached(request.id);
      ok(await setStatus(request.id, 'new', { comment: 'Не та модель' }));
      const events = await history(request.id);
      expect(lines(events.at(-1))).toEqual({
        lessorReceiptVersion: '1',
        lessorReceiptRetireReason: 'заявка возвращена в «Новую»',
      });
    });

    /**
     * The events are strict (`writeAuditTx`): a failure after the audit row was written rolls the
     * receipt change back with it. The failure is a deferred constraint trigger on `audit_log`
     * itself — the one way to fail AFTER the audit insert, at commit — aimed at this request's id,
     * so neighbouring runs never see it. That it fires also proves the event is written in the
     * door's transaction: had it not been, the change would have gone through.
     */
    it('a failing strict audit rolls the receipt change back', async () => {
      const request = await rental();
      const fn = `zz_test_lessor_receipt_audit_boom_${RUN}`;
      await ctx.db.execute(
        sql.raw(`
        CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'ИСКУССТВЕННЫЙ СБОЙ ПОСЛЕ ЗАПИСИ АУДИТА' USING ERRCODE = 'check_violation';
        END
        $fn$`),
      );
      await ctx.db.execute(
        sql.raw(`
        CREATE CONSTRAINT TRIGGER ${fn} AFTER INSERT ON audit_log
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (NEW.entity_id = '${request.id}')
          EXECUTE FUNCTION ${fn}()`),
      );
      const before = await card(request.id);
      try {
        const refused = await attach(request.id);
        expect(refused.statusCode, refused.body).toBe(500);
      } finally {
        await ctx.db.execute(sql.raw(`DROP TRIGGER ${fn} ON audit_log`));
        await ctx.db.execute(sql.raw(`DROP FUNCTION ${fn}()`));
      }
      const after = await card(request.id);
      expect(after.version, 'the request version stays').toBe(before.version);
      expect(after.lessorReceipt, 'no version survives the rollback').toBeNull();
      expect(after.lessorReceiptVersionCount).toBe(0);
      const events = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM audit_log
         WHERE entity_type = 'mech_request' AND entity_id = ${request.id}
           AND action LIKE 'mech_request.lessor_receipt_%'`);
      expect(events.rows[0]!.c).toBe(0);
      // Without the trigger the same door goes through and writes its event.
      ok(await attach(request.id));
      expect((await history(request.id)).map((e) => e.kind)).toEqual(['mechLessorReceiptAttached']);
    });
  });
});
