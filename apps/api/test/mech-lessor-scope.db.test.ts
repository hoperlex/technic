import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isMechLessorRentalVisible,
  MECH_LESSOR_DOOR_MESSAGE,
  MECH_LESSOR_RECEIPT_CAP_MESSAGE,
  MECH_LESSOR_RECEIPT_LESSOR_CAP,
  MECH_LESSOR_RECEIPT_LESSOR_LOCKED_MESSAGE,
  moscowDateKeyOf,
  type MechLessorReceiptReplyDto,
  type MechLessorRentalDto,
  type MechRequestDto,
  type RequestStatus,
  shiftDateKey,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { ACCESS_MANIFEST } from '../src/lib/access-manifest';
// Types only: the values of these modules are imported after the environment is set — the config
// validates it on import and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';
import type * as PrincipalNs from '../src/auth/principal';
import type * as ListNs from '../src/services/mech-request-list';

/**
 * The mechanization lessor's scope (plan `docs/mechanization-lessor-receipt-plan.md`, W2: P10–P13)
 * on a real database, with real lessor accounts — the suite that has to be green before such an
 * account may exist in production.
 *
 * Three lines are proven here, each on its own:
 *
 * - the door guard: every route of the access manifest under `/api/v1/mech-requests` that is not
 *   marked a lessor door answers 403 to a lessor holding `mechRequests.read`, with an empty body —
 *   the list comes from the manifest and the marks from the app, not from this file;
 * - the lessor's own doors: his rentals «В работе» only, in an allow-list DTO, versions of the
 *   current deal only, 404 for anything else, the attach door included;
 * - files: receipt versions by the rental and the deal, the requester's attachments never, the
 *   archive's receipts for the archive holder in his area (O17).
 *
 * Run on its own database (the file applies the migrations itself):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/<own base> \
 *     npx vitest run test/mech-lessor-scope.db.test.ts
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like the other `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-mech-lessor-scope-${RUN}`;
/** Codes start with «яя»: half of the db tests take an object by `ORDER BY … LIMIT 1`. */
const CODE_PREFIX = `яя-MECHLS-${RUN}`;
const GRANT_PREFIX = `test_mech_lessor_scope_${RUN}`;
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: область арендодателя механизации ${RUN}`;
/**
 * The last name of every office account: a reply to the lessor must not carry it anywhere. The
 * lessor accounts get another one, so the check cannot be passed by their own name.
 */
const OFFICE_NAME = `Офисный${RUN}`;
const USER_PASSWORD = 'db-user-password-456';

const TODAY = moscowDateKeyOf(new Date());
const WEEK_AGO = shiftDateKey(TODAY, -7);
const COMPLETION = { actualFrom: WEEK_AGO, actualTo: TODAY, actualUnits: 6, finalCost: 9000 };

/** The allow-lists of P12, written out: a key added to the DTO tomorrow must fail here. */
const RENTAL_KEYS = [
  'actualFrom',
  'actualTo',
  'displayNumber',
  'id',
  'lessorReceipt',
  'mechModelName',
  'num',
  'objectAddress',
  'objectName',
  'plannedFrom',
  'plannedTo',
  'rate',
  'rateUnit',
  'responsibleName',
  'responsiblePhone',
  'status',
  'version',
];
const LESSOR_BLOCK_KEYS = ['audience', 'current', 'ownVersionCount', 'required', 'retired'];
const VERSION_VIEW_KEYS = [
  'createdAs',
  'createdAt',
  'decidedAt',
  'file',
  'id',
  'rejectionReason',
  'retiredAt',
  'retiredReason',
  'status',
  'versionNo',
];
const FILE_KEYS = ['contentType', 'filename', 'id', 'size'];

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  principal: typeof PrincipalNs;
  list: typeof ListNs;
  closeDb: () => Promise<void>;
  objectId: string;
  otherObjectId: string;
  modelId: string;
  /** Mechanization lessors: A and B carry the door suites, C the list suite alone. */
  lessorA: string;
  lessorB: string;
  lessorC: string;
  /** A vehicle lessor: the base still lets him be a rental's lessor (plan §7, risk 4). */
  vehicleLessor: string;
}

interface People {
  admin: string;
  dispatcher: string;
  /** The site's visa holder. */
  rukstroy: string;
  /** A visa holder of another site. */
  otherRukstroy: string;
  /** Two accounts of lessor A: the cap of P7 counts per account. */
  a1: string;
  a2: string;
  b1: string;
  c1: string;
  /** An account of the vehicle lessor. */
  v1: string;
  /** Holders of `archive.read` through a set, in and out of the site (O17). */
  archivistSite: string;
  archivistOther: string;
}

type Headers = { authorization: string };
type Injected = Awaited<ReturnType<Ctx['app']['inject']>>;

let ctx: Ctx;
let people: People;
let auth: Record<keyof People, Headers>;
/** Route marks as the app registered them: `METHOD /path` → marked a lessor door. */
const lessorDoors = new Map<string, boolean>();
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
  scope: { objectIds?: string[]; counterpartyId?: string; lastName?: string } = {},
): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(ctx.schema.users)
    .values({
      email: `${EMAIL_PREFIX}-${seq}-${tag}@example.invalid`,
      lastName: scope.lastName ?? OFFICE_NAME,
      firstName: 'Тест',
      middleName: tag,
      passwordHash: 'db-test-not-a-hash',
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
      counterpartyId: scope.counterpartyId ?? null,
    })
    .returning({ id: ctx.schema.users.id });
  for (const objectId of scope.objectIds ?? []) {
    await ctx.db
      .insert(ctx.schema.userConstructionObjects)
      .values({ userId: row!.id, constructionObjectId: objectId });
  }
  return row!.id;
}

/** A lessor account: the executor role with his counterparty (ADR 0038). */
function lessorAccount(tag: string, counterpartyId: string): Promise<string> {
  return newUser(tag, 'operator', { counterpartyId, lastName: 'Арендодательский' });
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
  headers: Headers | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<Injected> {
  return ctx.app.inject({
    method,
    url: `/api/v1/mech-requests${url}`,
    ...(headers ? { headers } : {}),
    ...(payload === undefined ? {} : { payload }),
  });
}

function ok<T = Record<string, unknown>>(res: Injected, code = 200): T {
  expect(res.statusCode, res.body).toBe(code);
  return res.json() as T;
}

function refusedWith(res: Injected, code: number, message?: string): void {
  expect(res.statusCode, res.body).toBe(code);
  if (message !== undefined) expect(res.json().message).toBe(message);
}

async function card(id: string): Promise<MechRequestDto> {
  return ok<MechRequestDto>(await call(auth.admin, 'GET', `/${id}`));
}

async function versionOf(id: string): Promise<number> {
  return (await card(id)).version;
}

/**
 * A rental through the doors: filed by the site's visa holder — signed by the filing itself, the
 * take-in-work waits for that visa (ADR 0171) — and taken into work by the administrator with the
 * given lessor; issued a week ago unless `issued: false` — the deal is edited only before the
 * issue. Attachments (`fileIds`) must be the filer's own uploads.
 */
async function rental(
  lessorId: string,
  over: { objectId?: string; plannedTo?: string; issued?: boolean; fileIds?: string[] } = {},
): Promise<string> {
  const filer = over.objectId === ctx.otherObjectId ? auth.otherRukstroy : auth.rukstroy;
  const created = ok<MechRequestDto>(
    await call(filer, 'POST', '/', {
      objectId: over.objectId ?? ctx.objectId,
      mechModelId: ctx.modelId,
      plannedFrom: WEEK_AGO,
      plannedTo: over.plannedTo ?? shiftDateKey(TODAY, 10),
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9990000000',
      comment: `${MARK}: комментарий заявителя`,
      fileIds: over.fileIds ?? [],
    }),
    201,
  );
  ok(
    await call(auth.admin, 'PATCH', `/${created.id}/status`, {
      status: 'confirmed',
      deal: { lessorId, rate: 1500, rateUnit: 'shift' },
      ...(over.issued === false ? {} : { actualFrom: WEEK_AGO }),
      version: created.version,
    }),
  );
  return created.id;
}

/** Completes a rental that requires no receipt: the gate is not this suite's subject. */
async function completeWithoutGate(id: string): Promise<void> {
  await ctx.db
    .update(ctx.schema.mechRequests)
    .set({ lessorReceiptRequired: false })
    .where(eq(ctx.schema.mechRequests.id, id));
  ok(
    await call(auth.admin, 'PATCH', `/${id}/status`, {
      status: 'done',
      completion: COMPLETION,
      version: await versionOf(id),
    }),
  );
}

async function archive(id: string): Promise<void> {
  await ctx.db
    .update(ctx.schema.mechRequests)
    .set({ deletedAt: new Date(), deletedBy: people.admin })
    .where(eq(ctx.schema.mechRequests.id, id));
}

/** An upload of `userId`, finished: the attach door asks for the uploader's own file. */
async function upload(userId: string): Promise<string> {
  const [row] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey: `${EMAIL_PREFIX}/${randomUUID()}`,
      filename: 'чек.pdf',
      contentType: 'application/pdf',
      size: 2048,
      status: 'active',
      uploadedBy: userId,
    })
    .returning({ id: ctx.schema.files.id });
  return row!.id;
}

/** Attach as `who` a fresh PDF of his own. */
async function attach(id: string, who: keyof People): Promise<Injected> {
  return call(auth[who], 'POST', `/${id}/lessor-receipt`, {
    fileId: await upload(people[who]),
    version: await versionOf(id),
  });
}

async function decide(
  id: string,
  decision: 'approve' | 'reject' | 'revoke',
  comment?: string,
): Promise<Injected> {
  const opened = await card(id);
  return call(auth.rukstroy, 'PATCH', `/${id}/lessor-receipt`, {
    receiptId: opened.lessorReceipt?.id,
    decision,
    ...(comment !== undefined ? { comment } : {}),
    version: opened.version,
  });
}

async function waive(id: string, comment: string): Promise<Injected> {
  return call(auth.rukstroy, 'POST', `/${id}/lessor-receipt/waiver`, {
    comment,
    version: await versionOf(id),
  });
}

async function changeDeal(id: string, deal: { lessorId: string; rate: number }): Promise<Injected> {
  return call(auth.admin, 'PATCH', `/${id}/deal`, {
    ...deal,
    rateUnit: 'shift',
    version: await versionOf(id),
  });
}

function lessorRental(headers: Headers, id: string): Promise<Injected> {
  return call(headers, 'GET', `/lessor-rentals/${id}`);
}

async function lessorList(headers: Headers, query = ''): Promise<MechLessorRentalDto[]> {
  const res = ok<{ items: MechLessorRentalDto[]; total: number }>(
    await call(headers, 'GET', `/lessor-rentals${query ? `?${query}` : ''}`),
  );
  expect(res.total).toBe(res.items.length);
  return res.items;
}

async function canDownload(who: keyof People, fileId: string): Promise<boolean> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/files/${fileId}/download`,
    headers: auth[who],
  });
  // 404, not 403, for a file that is not his (ADR 0160): anything else is a broken setup.
  expect([200, 404], `${who}: ${res.body}`).toContain(res.statusCode);
  return res.statusCode === 200;
}

/** The file ids of the request's receipt versions, oldest first. */
async function versionFiles(requestId: string): Promise<string[]> {
  const receipts = ctx.schema.mechRequestLessorReceipts;
  const rows = await ctx.db
    .select({ fileId: receipts.fileId })
    .from(receipts)
    .where(eq(receipts.requestId, requestId))
    .orderBy(receipts.versionNo);
  return rows.map((row) => row.fileId!);
}

function sortedKeys(value: object): string[] {
  return Object.keys(value).sort();
}

describe.skipIf(!DB_URL)('механизация: область арендодателя (план чека, W2)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');
    const principal = await import('../src/auth/principal');
    const list = await import('../src/services/mech-request-list');
    ctx = {
      // The marks are taken from the app as it registers its routes: the guard suite below must
      // not trust a list written in this file.
      app: await buildApp({
        onRoute: (route) => {
          const methods = Array.isArray(route.method) ? route.method : [route.method];
          for (const method of methods) {
            const url = route.url.length > 1 ? route.url.replace(/\/$/, '') : route.url;
            lessorDoors.set(`${method} ${url}`, route.config?.mechLessorDoor === true);
          }
        },
      }),
      db,
      schema,
      tokens,
      principal,
      list,
      closeDb,
      objectId: '',
      otherObjectId: '',
      modelId: '',
      lessorA: '',
      lessorB: '',
      lessorC: '',
      vehicleLessor: '',
    };

    const object = async (tag: string): Promise<string> => {
      const [row] = await db
        .insert(schema.constructionObjects)
        .values({
          code: `${CODE_PREFIX}-${tag}`,
          name: `Площадка арендодателя ${tag} ${RUN}`,
          address: 'г. Москва, тестовый проезд, 7',
        })
        .returning({ id: schema.constructionObjects.id });
      return row!.id;
    };
    ctx.objectId = await object('site');
    ctx.otherObjectId = await object('other');
    const counterparty = async (
      type: 'mech_lessor' | 'vehicle_lessor',
      tag: string,
      n: number,
    ): Promise<string> => {
      const [row] = await db
        .insert(schema.counterparties)
        .values({
          type,
          name: `Арендодатель ${tag} ${RUN}`,
          inn: `7${String((Date.now() + n) % 100_000_000).padStart(8, '0')}${n}`,
          isActive: true,
          comment: MARK,
        })
        .returning({ id: schema.counterparties.id });
      return row!.id;
    };
    ctx.lessorA = await counterparty('mech_lessor', 'A', 1);
    ctx.lessorB = await counterparty('mech_lessor', 'B', 2);
    ctx.lessorC = await counterparty('mech_lessor', 'C', 3);
    ctx.vehicleLessor = await counterparty('vehicle_lessor', 'V', 4);
    const [model] = await db
      .insert(schema.mechModels)
      .values({ code: `mech-lessor-scope-${RUN}`, name: `Виброплита арендодателя ${RUN}` })
      .returning({ id: schema.mechModels.id });
    ctx.modelId = model!.id;

    people = {
      admin: await newUser('admin', 'admin'),
      dispatcher: await newUser('dispatcher', 'dispatcher'),
      rukstroy: await newUser('rukstroy', 'rukstroy', { objectIds: [ctx.objectId] }),
      otherRukstroy: await newUser('other-rukstroy', 'rukstroy', {
        objectIds: [ctx.otherObjectId],
      }),
      a1: await lessorAccount('a1', ctx.lessorA),
      a2: await lessorAccount('a2', ctx.lessorA),
      b1: await lessorAccount('b1', ctx.lessorB),
      c1: await lessorAccount('c1', ctx.lessorC),
      v1: await lessorAccount('v1', ctx.vehicleLessor),
      archivistSite: await newUser('archivist-site', 'rukstroy', { objectIds: [ctx.objectId] }),
      archivistOther: await newUser('archivist-other', 'rukstroy', {
        objectIds: [ctx.otherObjectId],
      }),
    };
    /*
     * `archive.read` for a site role, through a set written DIRECTLY into the test database —
     * bypassing the grant form and its barriers on purpose (approved by the owner, survey of
     * 09.11.2026). The grant matrix refuses the `records` module to a site axis, so no real
     * principal holds both today; but the O17 branch promises "inside his mechScopeWhere", and only
     * such a principal can prove the archive does not open another site's receipts. The set exists
     * for this proof only and is removed with the suite.
     */
    const [grant] = await db
      .insert(schema.grants)
      .values({ code: `${GRANT_PREFIX}_archive`, name: `Архив ${RUN}` })
      .returning({ id: schema.grants.id });
    await db
      .insert(schema.grantPermissions)
      .values({ grantId: grant!.id, permission: 'archive.read' });
    await db.insert(schema.grantRoles).values({ grantId: grant!.id, role: 'rukstroy' });
    for (const userId of [people.archivistSite, people.archivistOther]) {
      await db.insert(schema.userGrants).values({ userId, grantId: grant!.id });
    }

    const entries = await Promise.all(
      (Object.keys(people) as (keyof People)[]).map(
        async (key) => [key, await headersOf(people[key])] as const,
      ),
    );
    auth = Object.fromEntries(entries) as Record<keyof People, Headers>;
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
    await ctx.db.execute(sql`DELETE FROM user_grants WHERE user_id IN ${users}`);
    await ctx.db.execute(sql`DELETE FROM grants WHERE code LIKE ${`${GRANT_PREFIX}%`}`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
    await ctx.db.execute(sql`DELETE FROM counterparties WHERE comment = ${MARK}`);
    await ctx.db.execute(sql`DELETE FROM mech_models WHERE code = ${`mech-lessor-scope-${RUN}`}`);
    await ctx.db.execute(
      sql`DELETE FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`}`,
    );
    await ctx.app.close();
    await ctx.closeDb();
  });

  // ── The door guard (P11, first line) ──

  describe('страж двери', () => {
    /** The manifest's mechanization routes, with the app's own lessor marks. */
    function moduleRoutes(): { key: string; method: string; path: string; door: boolean }[] {
      const keys = Object.keys(ACCESS_MANIFEST).filter((key) =>
        /^[A-Z]+ \/api\/v1\/mech-requests(\/|$)/.test(key),
      );
      return keys.map((key) => {
        const [method, path] = key.split(' ') as [string, string];
        expect(lessorDoors.has(key), `${key}: in the manifest, not in the app`).toBe(true);
        return { key, method, path, door: lessorDoors.get(key)! };
      });
    }

    it('the manifest and the app agree on the three lessor doors', () => {
      const routes = moduleRoutes();
      expect(routes.length).toBeGreaterThan(30);
      expect(
        routes
          .filter((r) => r.door)
          .map((r) => r.key)
          .sort(),
      ).toEqual([
        'GET /api/v1/mech-requests/lessor-rentals',
        'GET /api/v1/mech-requests/lessor-rentals/:id',
        'POST /api/v1/mech-requests/:id/lessor-receipt',
      ]);
    });

    /**
     * His OWN rental's id in every path: a 404 or a 400 would prove nothing about the guard, and
     * the rental must come out of the sweep untouched.
     */
    it('every unmarked route answers 403 to a mechanization lessor, with an empty body', async () => {
      const own = await rental(ctx.lessorA);
      const before = await card(own);
      const wrong: string[] = [];
      for (const route of moduleRoutes().filter((r) => !r.door)) {
        const res = await ctx.app.inject({
          method: route.method as 'GET',
          url: route.path.replace(':id', own),
          headers: auth.a1,
        });
        const message = res.statusCode === 403 ? res.json().message : null;
        if (res.statusCode !== 403 || message !== MECH_LESSOR_DOOR_MESSAGE) {
          wrong.push(`${route.key}: ${res.statusCode} ${res.body.slice(0, 120)}`);
        }
      }
      expect(wrong).toEqual([]);
      const after = await card(own);
      expect(after.version).toBe(before.version);
      expect(after.deletedAt).toBeNull();
      expect(after.status).toBe('confirmed');
    });

    it('without a token every route of the module still answers 401', async () => {
      const own = await rental(ctx.lessorA);
      const wrong: string[] = [];
      for (const route of moduleRoutes()) {
        const res = await ctx.app.inject({
          method: route.method as 'GET',
          url: route.path.replace(':id', own),
        });
        if (res.statusCode !== 401) wrong.push(`${route.key}: ${res.statusCode}`);
      }
      expect(wrong).toEqual([]);
    });

    /**
     * At an unmarked route the door guard refuses him before validation. At a lessor door the guard
     * lets an executor through and the route's permission refuses him — after validation, as on
     * every route of the API — so the attach door gets a valid body: an empty one would answer 400
     * and prove nothing about the permission.
     */
    it('a vehicle lessor is refused on every route, the lessor doors included', async () => {
      const own = await rental(ctx.lessorA);
      const wrong: string[] = [];
      for (const route of moduleRoutes()) {
        const res = await ctx.app.inject({
          method: route.method as 'GET',
          url: route.path.replace(':id', own),
          headers: auth.v1,
          ...(route.door && route.method === 'POST'
            ? { payload: { fileId: randomUUID(), version: 0 } }
            : {}),
        });
        if (res.statusCode !== 403) wrong.push(`${route.key}: ${res.statusCode}`);
      }
      expect(wrong).toEqual([]);
    });

    it('the office passes the guard, and is refused at the lessor reads by their handler', async () => {
      ok(await call(auth.dispatcher, 'GET', '/'));
      const own = await rental(ctx.lessorA);
      ok(await call(auth.rukstroy, 'GET', `/${own}`));
      for (const who of ['admin', 'dispatcher', 'rukstroy'] as const) {
        refusedWith(await call(auth[who], 'GET', '/lessor-rentals'), 403);
        refusedWith(await lessorRental(auth[who], own), 403);
      }
    });
  });

  // ── The lessor's reads (P12) ──

  describe('аренды арендодателя', () => {
    it('his own rentals «В работе» only, whatever the site; sorted by the planned return', async () => {
      const later = await rental(ctx.lessorC, { plannedTo: shiftDateKey(TODAY, 20) });
      const sooner = await rental(ctx.lessorC, {
        objectId: ctx.otherObjectId,
        plannedTo: shiftDateKey(TODAY, 5),
      });
      const foreign = await rental(ctx.lessorB);
      const done = await rental(ctx.lessorC);
      await completeWithoutGate(done);
      const cancelled = await rental(ctx.lessorC, { issued: false });
      ok(
        await call(auth.admin, 'PATCH', `/${cancelled}/status`, {
          status: 'cancelled',
          comment: 'Передумали',
          version: await versionOf(cancelled),
        }),
      );
      const archived = await rental(ctx.lessorC);
      await archive(archived);

      const items = await lessorList(auth.c1);
      expect(items.map((item) => item.id)).toEqual([sooner, later]);
      expect(items.every((item) => item.status === 'confirmed')).toBe(true);
      const desc = await lessorList(auth.c1, 'sortOrder=desc');
      expect(desc.map((item) => item.id)).toEqual([later, sooner]);

      ok(await lessorRental(auth.c1, later));
      for (const id of [foreign, done, cancelled, archived]) {
        refusedWith(await lessorRental(auth.c1, id), 404);
      }
      refusedWith(await lessorRental(auth.c1, randomUUID()), 404);
    });

    it('filters: the period crosses the term, the receipt state is the current version', async () => {
      const items = await lessorList(auth.c1);
      expect(items).toHaveLength(2);
      const [sooner, later] = items as [MechLessorRentalDto, MechLessorRentalDto];
      // `sooner` returns in five days, `later` in twenty: a window after the first return finds
      // only the second.
      const window = `periodFrom=${shiftDateKey(TODAY, 15)}&periodTo=${shiftDateKey(TODAY, 30)}`;
      expect((await lessorList(auth.c1, window)).map((item) => item.id)).toEqual([later.id]);

      ok(await attach(later.id, 'c1'));
      expect((await lessorList(auth.c1, 'lessorReceipt=pending')).map((item) => item.id)).toEqual([
        later.id,
      ]);
      expect((await lessorList(auth.c1, 'lessorReceipt=missing')).map((item) => item.id)).toEqual([
        sooner.id,
      ]);
      expect(await lessorList(auth.c1, 'lessorReceipt=approved')).toEqual([]);
    });

    /**
     * The allow-lists of P12 exactly, nested blocks included — after a rejection, an approval and
     * its revocation, a waiver and its revocation, so every status and every reason has passed
     * through the DTO.
     */
    it('the DTO keys are the allow-list, and only a rejection shows its reason', async () => {
      const id = await rental(ctx.lessorA);
      ok(await attach(id, 'a1'));
      ok(await decide(id, 'reject', `Отказ видимый ${RUN}`));
      ok(await attach(id, 'a1'));
      ok(await decide(id, 'approve', `Замечание скрытое ${RUN}`));
      ok(await decide(id, 'revoke', `Отзыв утверждения скрытый ${RUN}`));
      ok(await waive(id, `Без чека скрытое ${RUN}`));
      ok(await decide(id, 'revoke', `Отзыв без чека скрытый ${RUN}`));
      ok(await attach(id, 'a1'));

      const res = await lessorRental(auth.a1, id);
      const dto = ok<MechLessorRentalDto>(res);
      expect(sortedKeys(dto)).toEqual(RENTAL_KEYS);
      expect(sortedKeys(dto.lessorReceipt)).toEqual(LESSOR_BLOCK_KEYS);
      const versions = [dto.lessorReceipt.current!, ...dto.lessorReceipt.retired];
      expect(versions.map((v) => v.status)).toEqual(['pending', 'waived', 'pending', 'rejected']);
      for (const version of versions) {
        expect(sortedKeys(version), version.status).toEqual(VERSION_VIEW_KEYS);
        if (version.file) expect(sortedKeys(version.file)).toEqual(FILE_KEYS);
      }
      const waiver = versions[1]!;
      expect(waiver.file).toBeNull();
      expect(waiver.rejectionReason, 'a waiver shows no reason').toBeNull();
      expect(waiver.retiredReason, 'a revoked waiver shows only that').toBe('revoked');
      expect(versions[3]!.rejectionReason).toBe(`Отказ видимый ${RUN}`);
      expect(dto.lessorReceipt.ownVersionCount).toBe(3);
      for (const hidden of [
        'Замечание скрытое',
        'Отзыв утверждения',
        'Без чека скрытое',
        'Отзыв без чека',
      ]) {
        expect(res.body, hidden).not.toContain(hidden);
      }
      expect(res.body).not.toContain(OFFICE_NAME);
      expect(res.body).not.toContain('комментарий заявителя');
      // The list row is the same DTO.
      const row = (await lessorList(auth.a1)).find((item) => item.id === id);
      expect(row).toEqual(dto);
    });

    it('after a deal change the old lessor loses the rental, the new one sees none of his versions', async () => {
      const id = await rental(ctx.lessorA, { issued: false });
      ok(await attach(id, 'a1'));
      ok(await changeDeal(id, { lessorId: ctx.lessorB, rate: 1500 }));
      expect((await lessorList(auth.a1)).map((item) => item.id)).not.toContain(id);
      refusedWith(await lessorRental(auth.a1, id), 404);
      refusedWith(await attach(id, 'a1'), 404);

      const seen = ok<MechLessorRentalDto>(await lessorRental(auth.b1, id));
      expect(seen.lessorReceipt.current).toBeNull();
      expect(seen.lessorReceipt.retired).toEqual([]);
      expect(seen.lessorReceipt.ownVersionCount).toBe(0);
    });

    it('a return to «Новая» starts a new deal: the same lessor sees no version from before it', async () => {
      const id = await rental(ctx.lessorA, { issued: false });
      ok(await attach(id, 'a1'));
      ok(
        await call(auth.admin, 'PATCH', `/${id}/status`, {
          status: 'new',
          comment: 'Не та модель',
          version: await versionOf(id),
        }),
      );
      refusedWith(await lessorRental(auth.a1, id), 404);
      ok(
        await call(auth.admin, 'PATCH', `/${id}/status`, {
          status: 'confirmed',
          deal: { lessorId: ctx.lessorA, rate: 1500, rateUnit: 'shift' },
          version: await versionOf(id),
        }),
      );
      const seen = ok<MechLessorRentalDto>(await lessorRental(auth.a1, id));
      expect(seen.lessorReceipt.current).toBeNull();
      expect(seen.lessorReceipt.retired).toEqual([]);
      expect(seen.lessorReceipt.ownVersionCount, 'the cap starts again with the deal').toBe(0);
    });
  });

  /**
   * The deal boundary when NO version is current (review of W2). A revoked waiver leaves the
   * request without a current version, so a deal change writes no retire marker anywhere; the
   * boundary must still hold — it is the request's deal number, moved by the deal and status
   * doors whatever the versions say.
   */
  describe('граница договорённости без текущей версии', () => {
    /** Lessor A's file version, then a waiver over it, then the waiver revoked: nothing current. */
    async function afterRevokedWaiver(id: string): Promise<string> {
      ok(await attach(id, 'a1'));
      ok(await waive(id, 'Арендодатель чеков не выдаёт'));
      ok(await decide(id, 'revoke', 'Чек всё-таки будет'));
      expect((await card(id)).lessorReceipt, 'no current version').toBeNull();
      const [aFile] = (await versionFiles(id)) as [string];
      expect(await canDownload('a1', aFile), 'his own file before the change').toBe(true);
      return aFile;
    }

    it('a deal moved to another lessor: B sees none of A, opens none of his files; A loses it', async () => {
      const id = await rental(ctx.lessorA, { issued: false });
      const aFile = await afterRevokedWaiver(id);
      ok(await changeDeal(id, { lessorId: ctx.lessorB, rate: 1500 }));

      const seen = ok<MechLessorRentalDto>(await lessorRental(auth.b1, id));
      expect(seen.lessorReceipt.current).toBeNull();
      expect(seen.lessorReceipt.retired).toEqual([]);
      expect(seen.lessorReceipt.ownVersionCount).toBe(0);
      expect(await canDownload('b1', aFile), "the predecessor's file").toBe(false);

      refusedWith(await lessorRental(auth.a1, id), 404);
      expect((await lessorList(auth.a1)).map((item) => item.id)).not.toContain(id);
      expect(await canDownload('a1', aFile), 'no longer his rental').toBe(false);
      // The office still sees every version of the request.
      expect(await canDownload('dispatcher', aFile)).toBe(true);
    });

    it('a new rate for the same lessor: his earlier-deal versions are gone, the cap restarts', async () => {
      const id = await rental(ctx.lessorA, { issued: false });
      const aFile = await afterRevokedWaiver(id);
      ok(await changeDeal(id, { lessorId: ctx.lessorA, rate: 1900 }));

      const seen = ok<MechLessorRentalDto>(await lessorRental(auth.a1, id));
      expect(seen.lessorReceipt.current).toBeNull();
      expect(seen.lessorReceipt.retired).toEqual([]);
      expect(seen.lessorReceipt.ownVersionCount, 'the cap restarts with the deal').toBe(0);
      expect(await canDownload('a1', aFile), 'his own file of the earlier deal').toBe(false);

      const reply = ok<MechLessorReceiptReplyDto>(await attach(id, 'a1'));
      if (reply.lessorReceipt.audience !== 'lessor')
        throw new Error('expected the lessor audience');
      expect(reply.lessorReceipt.retired).toEqual([]);
      expect(reply.lessorReceipt.ownVersionCount).toBe(1);
      expect(reply.lessorReceipt.current?.versionNo).toBe(3);
    });

    it('a return to «Новая» and a new take-in-work: the next lessor sees none of the old deal', async () => {
      const id = await rental(ctx.lessorA, { issued: false });
      const aFile = await afterRevokedWaiver(id);
      ok(
        await call(auth.admin, 'PATCH', `/${id}/status`, {
          status: 'new',
          comment: 'Не та модель',
          version: await versionOf(id),
        }),
      );
      ok(
        await call(auth.admin, 'PATCH', `/${id}/status`, {
          status: 'confirmed',
          deal: { lessorId: ctx.lessorB, rate: 1500, rateUnit: 'shift' },
          version: await versionOf(id),
        }),
      );
      const seen = ok<MechLessorRentalDto>(await lessorRental(auth.b1, id));
      expect(seen.lessorReceipt.current).toBeNull();
      expect(seen.lessorReceipt.retired).toEqual([]);
      expect(await canDownload('b1', aFile)).toBe(false);
      expect(await canDownload('a1', aFile)).toBe(false);
      refusedWith(await lessorRental(auth.a1, id), 404);
    });
  });

  // ── The lessor's attach (P7 for the lessor) ──

  describe('прикрепление арендодателем', () => {
    it('a foreign, closed or archived rental is 404 at the attach door', async () => {
      const foreign = await rental(ctx.lessorB);
      refusedWith(await attach(foreign, 'a1'), 404);
      const done = await rental(ctx.lessorA);
      await completeWithoutGate(done);
      refusedWith(await attach(done, 'a1'), 404);
      const archived = await rental(ctx.lessorA);
      const version = await versionOf(archived);
      await archive(archived);
      refusedWith(
        await call(auth.a1, 'POST', `/${archived}/lessor-receipt`, {
          fileId: await upload(people.a1),
          version,
        }),
        404,
      );
    });

    it('his own: created as «lessor», the reply in his audience without a staff name', async () => {
      const id = await rental(ctx.lessorA);
      ok(await attach(id, 'dispatcher'));
      const res = await attach(id, 'a1');
      const reply = ok<MechLessorReceiptReplyDto>(res);
      if (reply.lessorReceipt.audience !== 'lessor')
        throw new Error('expected the lessor audience');
      expect(reply.lessorReceipt.current?.createdAs).toBe('lessor');
      expect(reply.lessorReceipt.retired.map((v) => v.createdAs)).toEqual(['office']);
      expect(reply.lessorReceipt.ownVersionCount).toBe(1);
      expect(res.body).not.toContain(OFFICE_NAME);
      const receipts = ctx.schema.mechRequestLessorReceipts;
      const [row] = await ctx.db
        .select({ createdAs: receipts.createdAs })
        .from(receipts)
        .where(and(eq(receipts.requestId, id), eq(receipts.createdBy, people.a1)));
      expect(row?.createdAs).toBe('lessor');
    });

    it('the reply holds no version of an earlier deal', async () => {
      const id = await rental(ctx.lessorA, { issued: false });
      ok(await attach(id, 'dispatcher'));
      ok(await changeDeal(id, { lessorId: ctx.lessorA, rate: 1700 }));
      const reply = ok<MechLessorReceiptReplyDto>(await attach(id, 'a1'));
      if (reply.lessorReceipt.audience !== 'lessor')
        throw new Error('expected the lessor audience');
      expect(reply.lessorReceipt.current?.versionNo).toBe(2);
      expect(reply.lessorReceipt.retired).toEqual([]);
    });

    it("an approved or waived version is the office's to replace", async () => {
      const id = await rental(ctx.lessorA);
      ok(await attach(id, 'a1'));
      ok(await decide(id, 'approve'));
      refusedWith(await attach(id, 'a1'), 422, MECH_LESSOR_RECEIPT_LESSOR_LOCKED_MESSAGE);
      const waived = await rental(ctx.lessorA);
      ok(await waive(waived, 'Арендодатель чеков не выдаёт'));
      refusedWith(await attach(waived, 'a1'), 422, MECH_LESSOR_RECEIPT_LESSOR_LOCKED_MESSAGE);
      ok(await attach(waived, 'dispatcher'));
    });

    it(`the cap: ${MECH_LESSOR_RECEIPT_LESSOR_CAP} per account within the deal; the office past it`, async () => {
      const id = await rental(ctx.lessorA);
      for (let n = 0; n < MECH_LESSOR_RECEIPT_LESSOR_CAP; n += 1) ok(await attach(id, 'a1'));
      refusedWith(await attach(id, 'a1'), 422, MECH_LESSOR_RECEIPT_CAP_MESSAGE);
      // Per account: the lessor's second account still attaches.
      ok(await attach(id, 'a2'));
      refusedWith(await attach(id, 'a1'), 422, MECH_LESSOR_RECEIPT_CAP_MESSAGE);
      // The office is never capped: a lessor's loop must not lock out the real receipt.
      ok(await attach(id, 'dispatcher'));
    });
  });

  // ── Files (P11, P13, O17) ──

  describe('файлы', () => {
    it('a receipt opens for the office in scope and its own lessor, nobody else', async () => {
      const id = await rental(ctx.lessorA);
      ok(await attach(id, 'dispatcher'));
      const [fileId] = (await versionFiles(id)) as [string];
      expect(await canDownload('dispatcher', fileId)).toBe(true);
      expect(await canDownload('rukstroy', fileId)).toBe(true);
      expect(await canDownload('otherRukstroy', fileId), 'a foreign site').toBe(false);
      expect(await canDownload('a1', fileId), 'his own rental').toBe(true);
      expect(await canDownload('a2', fileId), 'another account of his company').toBe(true);
      expect(await canDownload('b1', fileId), 'a foreign lessor').toBe(false);
      expect(await canDownload('v1', fileId), 'a vehicle lessor').toBe(false);
    });

    it('the versions of an earlier deal are closed to the lessor, open to the office', async () => {
      const id = await rental(ctx.lessorA, { issued: false });
      ok(await attach(id, 'a1'));
      ok(await changeDeal(id, { lessorId: ctx.lessorA, rate: 1800 }));
      ok(await attach(id, 'a1'));
      const [earlier, current] = (await versionFiles(id)) as [string, string];
      expect(await canDownload('a1', earlier), 'his own file of the earlier deal').toBe(false);
      expect(await canDownload('a1', current)).toBe(true);
      expect(await canDownload('dispatcher', earlier)).toBe(true);
    });

    it('the files of his rental close with the rental', async () => {
      const id = await rental(ctx.lessorA);
      ok(await attach(id, 'a1'));
      ok(await decide(id, 'approve'));
      const [fileId] = (await versionFiles(id)) as [string];
      expect(await canDownload('a1', fileId)).toBe(true);
      ok(
        await call(auth.admin, 'PATCH', `/${id}/status`, {
          status: 'done',
          completion: COMPLETION,
          version: await versionOf(id),
        }),
      );
      expect(await canDownload('a1', fileId)).toBe(false);
      expect(await canDownload('dispatcher', fileId)).toBe(true);
    });

    it("the requester's attachment is closed to the lessor of that very rental", async () => {
      const attachment = await upload(people.rukstroy);
      const id = await rental(ctx.lessorA, { fileIds: [attachment] });
      expect(await canDownload('dispatcher', attachment)).toBe(true);
      expect(await canDownload('a1', attachment)).toBe(false);
      ok(await lessorRental(auth.a1, id));
    });

    /**
     * O17: the receipt is the evidence of a payment, examined after archiving too — the archive
     * holder opens it in his area without a restore; the attachments of the same archived request
     * stay closed, as they were before the receipt existed. `archivistOther` holds `archive.read`
     * only through the set inserted directly in `beforeAll` (see the comment there).
     */
    it('an archived request: receipts open for the archive holder in his area, attachments never', async () => {
      const attachment = await upload(people.rukstroy);
      const id = await rental(ctx.lessorA, { fileIds: [attachment] });
      ok(await attach(id, 'dispatcher'));
      const [receipt] = (await versionFiles(id)) as [string];
      expect(await canDownload('archivistSite', receipt), 'his site, live').toBe(true);
      expect(await canDownload('archivistOther', receipt), 'not his site, live').toBe(false);
      await archive(id);

      expect(await canDownload('admin', receipt)).toBe(true);
      expect(await canDownload('archivistSite', receipt)).toBe(true);
      expect(await canDownload('archivistOther', receipt), 'out of his area').toBe(false);
      expect(await canDownload('rukstroy', receipt), 'no archive permission').toBe(false);
      expect(await canDownload('dispatcher', receipt), 'no archive permission').toBe(false);
      expect(await canDownload('a1', receipt), 'the lessor never sees the archive').toBe(false);
      for (const who of ['admin', 'archivistSite', 'rukstroy', 'a1'] as const) {
        expect(await canDownload(who, attachment), `${who}: an archived attachment`).toBe(false);
      }
    });
  });

  // ── The one predicate and its SQL twin (P11) ──

  describe('предикат и его SQL-двойник', () => {
    interface GridRow {
      id: string;
      lessorId: string | null;
      status: RequestStatus;
      deleted: boolean;
    }
    let grid: GridRow[] = [];

    /**
     * Rows written directly, over every status, lessor and archive state the base allows: the doors
     * would refuse some of them (a vehicle lessor in a new deal, a rental in work archived), and
     * the predicates must answer on those too.
     */
    beforeAll(async () => {
      const lessors: { id: string | null; type: 'mech_lessor' | 'vehicle_lessor' | null }[] = [
        { id: ctx.lessorA, type: 'mech_lessor' },
        { id: ctx.lessorB, type: 'mech_lessor' },
        { id: ctx.vehicleLessor, type: 'vehicle_lessor' },
        { id: null, type: null },
      ];
      const statuses: RequestStatus[] = ['new', 'confirmed', 'done', 'cancelled'];
      grid = [];
      for (const status of statuses) {
        for (const lessor of lessors) {
          // The base's own rules: «Новая» has no deal, «В работе» and «Выполнена» have one.
          if (status === 'new' && lessor.id) continue;
          if ((status === 'confirmed' || status === 'done') && !lessor.id) continue;
          for (const deleted of [false, true]) {
            const [row] = await ctx.db
              .insert(ctx.schema.mechRequests)
              .values({
                objectId: ctx.objectId,
                plannedFrom: WEEK_AGO,
                plannedTo: TODAY,
                responsibleName: 'Иванов Иван',
                responsiblePhone: '9990000000',
                createdBy: people.admin,
                status,
                ...(lessor.id && lessor.type
                  ? {
                      lessorId: lessor.id,
                      lessorType: lessor.type,
                      lessorIsActive: true,
                      rate: '1500',
                      rateUnit: 'shift' as const,
                    }
                  : {}),
                ...(status === 'done'
                  ? { actualFrom: WEEK_AGO, actualTo: TODAY, actualUnits: '6', finalCost: '9000' }
                  : {}),
                ...(deleted ? { deletedAt: new Date(), deletedBy: people.admin } : {}),
              })
              .returning({ id: ctx.schema.mechRequests.id });
            grid.push({ id: row!.id, lessorId: lessor.id, status, deleted });
          }
        }
      }
    });

    /** The grid rows a condition selects, sorted. */
    async function gridRowsWhere(condition: SQL | undefined): Promise<string[]> {
      const rows = await ctx.db
        .select({ id: ctx.schema.mechRequests.id })
        .from(ctx.schema.mechRequests)
        .where(
          and(
            inArray(
              ctx.schema.mechRequests.id,
              grid.map((row) => row.id),
            ),
            condition,
          ),
        );
      return rows.map((row) => row.id).sort();
    }

    it('isMechLessorRentalVisible and mechLessorRentalVisibleWhere agree over a grid', async () => {
      // «Новая» 1 lessor × 2, «В работе» and «Выполнена» 3 × 2 each, «Отменена» 4 × 2.
      expect(grid.length).toBe(22);
      for (const who of ['a1', 'b1', 'v1', 'dispatcher', 'admin'] as const) {
        const p = (await ctx.principal.loadPrincipal(people[who]))!;
        const bySql = await gridRowsWhere(ctx.list.mechLessorRentalVisibleWhere(p));
        const byPredicate = grid
          .filter((row) =>
            isMechLessorRentalVisible(p, {
              lessorId: row.lessorId,
              status: row.status,
              deletedAt: row.deleted ? new Date().toISOString() : null,
            }),
          )
          .map((row) => row.id)
          .sort();
        expect(bySql, who).toEqual(byPredicate);
        // Not empty by accident: each mechanization lessor sees exactly his one live rental in
        // work of the grid, and nobody else sees any.
        expect(bySql.length, who).toBe(who === 'a1' || who === 'b1' ? 1 : 0);
      }
    });

    /**
     * The second line on its own (P11): `mechScopeWhere`, which the module's list, summary,
     * journal, journal summary, export and file branches ask, limits an executor to his
     * counterparty's rentals — whatever their status or archive state, those are the doors'
     * questions — and an executor of another type to nothing. The door guard stands in front of
     * every such read, so without this check the axis could vanish and no request would notice
     * (the mutation check of W2 step 6 found exactly that).
     */
    it('mechScopeWhere alone limits an executor to his counterparty, another type to nothing', async () => {
      const expected: Record<'a1' | 'b1' | 'v1' | 'dispatcher' | 'admin', string[]> = {
        a1: grid.filter((row) => row.lessorId === ctx.lessorA).map((row) => row.id),
        b1: grid.filter((row) => row.lessorId === ctx.lessorB).map((row) => row.id),
        // The vehicle lessor sees nothing, the rentals that name his own counterparty included.
        v1: [],
        dispatcher: grid.map((row) => row.id),
        admin: grid.map((row) => row.id),
      };
      expect(expected.a1).toHaveLength(6);
      for (const who of ['a1', 'b1', 'v1', 'dispatcher', 'admin'] as const) {
        const p = (await ctx.principal.loadPrincipal(people[who]))!;
        expect(await gridRowsWhere(ctx.list.mechScopeWhere(p)), who).toEqual(
          [...expected[who]].sort(),
        );
      }
    });
  });

  // ── Accounts (P10) ──

  describe('учётки', () => {
    it('an account can be created for a mechanization lessor (resolveCounterpartyId)', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: auth.admin,
        payload: {
          email: `${EMAIL_PREFIX}-created@example.invalid`,
          lastName: 'Арендодательский',
          firstName: 'Новый',
          middleName: 'Учёточный',
          password: USER_PASSWORD,
          role: 'operator',
          isActive: true,
          counterpartyId: ctx.lessorA,
          notifyUser: false,
        },
      });
      const created = ok<{ user: { id: string } }>(res, 201);
      const p = await ctx.principal.loadPrincipal(created.user.id);
      expect(p?.counterpartyId).toBe(ctx.lessorA);
      expect(p?.counterpartyType).toBe('mech_lessor');
    });
  });
});
