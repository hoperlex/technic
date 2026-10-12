import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MECH_EXTENSION_NOT_PENDING_MESSAGE,
  MECH_EXTENSION_NOT_RUNNING_MESSAGE,
  MECH_EXTENSION_SCOPE_MESSAGE,
  MECH_EXTENSION_TERM_CHANGED_MESSAGE,
  moscowDateKeyOf,
  shiftDateKey,
  type MechRequestDto,
  type RequestHistoryEntryDto,
  type Role,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values of these modules are imported after the environment is set — the config
// validates it on import and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as TokensNs from '../src/auth/tokens';

/**
 * The extension visa of a running rental (ADR 0171, stage 3; plan
 * `docs/mechanization-approval-and-grants-plan.md`, R10, R12).
 *
 * Why this file needs a database. The rules are pure functions checked without one
 * (`mech-extension-contracts.test.ts`); here is what substitutes always get right:
 *
 * 1. the term moves in the same transaction as the approval, and the request row, the request's
 *    version and the history event change together or not at all;
 * 2. the scope of the decision is computed from real `user_construction_objects` and
 *    `department_construction_objects` rows — "the department head does not decide" is an answer
 *    of the principal built from SQL;
 * 3. the automatic drop lives inside the completion and the issue-revoke transactions;
 * 4. the order of refusals (409 "reread" before 422 "the rule forbids") is visible only on a real
 *    request with a stale version;
 * 5. the old door `PATCH /:id/extend` still works for old tabs and cannot double-move the term
 *    from one snapshot.
 *
 * Run on its own database (the file applies the migrations itself):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run test/mech-extension.db.test.ts
 *
 * Without `TEST_DATABASE_URL` the file is skipped, like the other `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const EMAIL_PREFIX = `db-mech-extension-${RUN}`;
/** Codes start with «яя»: half of the db tests take an object by `ORDER BY … LIMIT 1`. */
const CODE_PREFIX = `яя-MECHEXT-${RUN}`;
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: виза продления механизации ${RUN}`;

const TODAY = moscowDateKeyOf(new Date());
const WEEK_AGO = shiftDateKey(TODAY, -7);
const PLANNED_TO = shiftDateKey(TODAY, 10);
const ASKED = shiftDateKey(PLANNED_TO, 7);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  tokens: typeof TokensNs;
  closeDb: () => Promise<void>;
  objectId: string;
  otherObjectId: string;
  departmentId: string;
  lessorId: string;
  modelId: string;
}

type Headers = { authorization: string };

let ctx: Ctx;
let seq = 0;
let auth: {
  /** The site's visa holder: decides extensions of his site. */
  rukstroy: Headers;
  /** A visa holder of another site: the permission without the scope. */
  otherRukstroy: Headers;
  /** The head of the department the site belongs to: signs its requests, never its extensions. */
  head: Headers;
  /** Two dispatchers: the request queue is shared, any of them withdraws. */
  dispatcher: Headers;
  dispatcher2: Headers;
  admin: Headers;
};

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
  role: Role,
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
      // No password login here: the access token is signed directly.
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

type Injected = Awaited<ReturnType<Ctx['app']['inject']>>;

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
  return ok(await call(auth.admin, 'GET', `/${id}`)) as unknown as MechRequestDto;
}

async function history(id: string): Promise<RequestHistoryEntryDto[]> {
  return ok(await call(auth.admin, 'GET', `/${id}/history`)) as unknown as RequestHistoryEntryDto[];
}

function kinds(entries: RequestHistoryEntryDto[], kind: string): RequestHistoryEntryDto[] {
  return entries.filter((e) => e.kind === kind);
}

function changeOf(
  entry: RequestHistoryEntryDto | undefined,
  field: string,
): { from: string | null; to: string | null } {
  const change = entry?.changes.find((c) => c.field === field);
  expect(change, `${field} в событии ${entry?.kind}`).toBeDefined();
  return { from: change!.from, to: change!.to };
}

function day(dateKey: string): string {
  const [yyyy, mm, dd] = dateKey.split('-');
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * A running rental: filed by the site's visa holder (signed by the filing itself, ADR 0171 R6),
 * taken in work by the administrator with the deal and the issue date at once.
 */
async function runningRental(departmentId?: string): Promise<MechRequestDto> {
  const filer = departmentId ? auth.head : auth.rukstroy;
  const created = ok(
    await call(filer, 'POST', '/', {
      objectId: ctx.objectId,
      ...(departmentId ? { departmentId } : {}),
      mechModelId: ctx.modelId,
      plannedFrom: WEEK_AGO,
      plannedTo: PLANNED_TO,
      responsibleName: 'Иванов Иван',
      responsiblePhone: '9990000000',
      comment: MARK,
    }),
    201,
  ) as unknown as MechRequestDto;
  expect(created.approvedAt).not.toBeNull();
  ok(
    await call(auth.admin, 'PATCH', `/${created.id}/status`, {
      status: 'confirmed',
      deal: { lessorId: ctx.lessorId, rate: 1500, rateUnit: 'shift' },
      actualFrom: WEEK_AGO,
      version: created.version,
    }),
  );
  return card(created.id);
}

async function requestExtension(
  request: MechRequestDto,
  over: { plannedTo?: string; reason?: string; version?: number; headers?: Headers } = {},
): Promise<Injected> {
  return call(over.headers ?? auth.dispatcher, 'POST', `/${request.id}/extension`, {
    plannedTo: over.plannedTo ?? ASKED,
    reason: over.reason ?? 'Бетонирование сдвинулось на неделю',
    version: over.version ?? (await card(request.id)).version,
  });
}

async function decide(
  request: MechRequestDto,
  approved: boolean,
  over: { comment?: string; version?: number; headers?: Headers } = {},
): Promise<Injected> {
  return call(over.headers ?? auth.rukstroy, 'PATCH', `/${request.id}/extension`, {
    approved,
    ...(over.comment !== undefined ? { comment: over.comment } : {}),
    version: over.version ?? (await card(request.id)).version,
  });
}

async function withdraw(
  request: MechRequestDto,
  over: { version?: number; headers?: Headers } = {},
): Promise<Injected> {
  const version = over.version ?? (await card(request.id)).version;
  return call(
    over.headers ?? auth.dispatcher,
    'DELETE',
    `/${request.id}/extension?version=${version}`,
  );
}

describe.skipIf(!DB_URL)('механизация: виза продления аренды (ADR 0171, этап 3)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const tokens = await import('../src/auth/tokens');
    ctx = {
      app: await buildApp(),
      db,
      schema,
      tokens,
      closeDb,
      objectId: '',
      otherObjectId: '',
      departmentId: '',
      lessorId: '',
      modelId: '',
    };

    const object = async (tag: string): Promise<string> => {
      const [row] = await db
        .insert(schema.constructionObjects)
        .values({
          code: `${CODE_PREFIX}-${tag}`,
          name: `Площадка ${tag} ${RUN}`,
          address: 'г. Москва, тестовый проезд, 2',
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
        name: `Арендодатель продления ${RUN}`,
        inn: `9${String(Date.now() % 100_000_000).padStart(8, '0')}7`,
        isActive: true,
        comment: MARK,
      })
      .returning({ id: schema.counterparties.id });
    ctx.lessorId = lessor!.id;
    const [model] = await db
      .insert(schema.mechModels)
      .values({ code: `mech-extension-${RUN}`, name: `Компрессор продления ${RUN}` })
      .returning({ id: schema.mechModels.id });
    ctx.modelId = model!.id;

    auth = {
      rukstroy: await headersOf(
        await newUser('rukstroy', 'rukstroy', { objectIds: [ctx.objectId] }),
      ),
      otherRukstroy: await headersOf(
        await newUser('other-rukstroy', 'rukstroy', { objectIds: [ctx.otherObjectId] }),
      ),
      head: await headersOf(
        await newUser('head', 'department_head', { departmentIds: [ctx.departmentId] }),
      ),
      dispatcher: await headersOf(await newUser('dispatcher', 'dispatcher')),
      dispatcher2: await headersOf(await newUser('dispatcher-2', 'dispatcher')),
      admin: await headersOf(await newUser('admin', 'admin')),
    };
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const users = sql`(SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`;
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN ${users}`);
    // Extension rows go with their requests (`ON DELETE CASCADE`), before the accounts they name.
    await ctx.db.execute(
      sql`DELETE FROM mech_requests WHERE object_id IN
            (SELECT id FROM construction_objects WHERE code LIKE ${`${CODE_PREFIX}%`})`,
    );
    await ctx.db.execute(sql`DELETE FROM counterparties WHERE comment = ${MARK}`);
    await ctx.db.execute(sql`DELETE FROM mech_models WHERE code = ${`mech-extension-${RUN}`}`);
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

  // ── The request: asked, not moved ──

  it('the request waits for the visa: the term stays, the version rises, the history says why', async () => {
    const rental = await runningRental();
    const asked = ok(await requestExtension(rental)) as unknown as MechRequestDto;

    expect(asked.plannedTo).toBe(PLANNED_TO);
    expect(asked.version).toBe(rental.version + 1);
    expect(asked.extension).toMatchObject({
      status: 'pending',
      newPlannedTo: ASKED,
      previousPlannedTo: PLANNED_TO,
      reason: 'Бетонирование сдвинулось на неделю',
      decidedAt: null,
      decidedByName: null,
    });
    expect(asked.extension!.requestedByName).toContain('dispatcher');

    const requested = kinds(await history(rental.id), 'mechExtendRequested');
    expect(requested).toHaveLength(1);
    expect(changeOf(requested[0], 'plannedTo')).toEqual({ from: day(PLANNED_TO), to: day(ASKED) });
    expect(changeOf(requested[0], 'extendReason')).toEqual({
      from: null,
      to: 'Бетонирование сдвинулось на неделю',
    });
    expect(kinds(await history(rental.id), 'mechExtended')).toHaveLength(0);

    // The list carries it too, and the visa holder finds it by the tag's state.
    const list = ok(
      await call(auth.rukstroy, 'GET', `/?num=${rental.num}&rental=true`),
    ) as unknown as { items: MechRequestDto[] };
    expect(list.items.map((r) => r.extension?.status)).toEqual(['pending']);
  }, 60_000);

  it('a repeated request overwrites the row, and both requests stay in the history', async () => {
    const rental = await runningRental();
    ok(await requestExtension(rental));
    const later = shiftDateKey(ASKED, 3);
    const again = ok(
      await requestExtension(rental, {
        plannedTo: later,
        reason: 'Ещё три дня',
        headers: auth.dispatcher2,
      }),
    ) as unknown as MechRequestDto;
    expect(again.extension).toMatchObject({
      status: 'pending',
      newPlannedTo: later,
      reason: 'Ещё три дня',
    });
    expect(again.extension!.requestedByName).toContain('dispatcher-2');
    expect(kinds(await history(rental.id), 'mechExtendRequested')).toHaveLength(2);
  }, 60_000);

  it('only a running rental is extended, and only forward', async () => {
    const created = ok(
      await call(auth.rukstroy, 'POST', '/', {
        objectId: ctx.objectId,
        mechModelId: ctx.modelId,
        plannedFrom: TODAY,
        plannedTo: PLANNED_TO,
        responsibleName: 'Иванов Иван',
        responsiblePhone: '9990000000',
        comment: MARK,
      }),
      201,
    ) as unknown as MechRequestDto;
    const refusedNew = await requestExtension(created);
    expect(refusedNew.statusCode, refusedNew.body).toBe(422);
    expect(refusedNew.json().message).toBe(MECH_EXTENSION_NOT_RUNNING_MESSAGE);

    const rental = await runningRental();
    const same = await requestExtension(rental, { plannedTo: PLANNED_TO });
    expect(same.statusCode, same.body).toBe(422);
    expect(same.json().fields).toMatchObject({ plannedTo: expect.any(String) });
    expect((await card(rental.id)).extension).toBeNull();
  }, 60_000);

  // ── The decision ──

  it('the approval moves the term in the same transaction and writes «the term moved»', async () => {
    const rental = await runningRental();
    ok(await requestExtension(rental));
    const approved = ok(
      await decide(rental, true, { comment: 'Согласовано с главным инженером' }),
    ) as unknown as MechRequestDto;

    expect(approved.plannedTo).toBe(ASKED);
    expect(approved.extension).toMatchObject({
      status: 'approved',
      decisionComment: 'Согласовано с главным инженером',
    });
    expect(approved.extension!.decidedByName).toContain('rukstroy');
    expect(approved.extension!.decidedAt).not.toBeNull();

    const extended = kinds(await history(rental.id), 'mechExtended');
    expect(extended).toHaveLength(1);
    expect(changeOf(extended[0], 'plannedTo')).toEqual({ from: day(PLANNED_TO), to: day(ASKED) });
    expect(changeOf(extended[0], 'extendReason').to).toBe('Бетонирование сдвинулось на неделю');
    expect(changeOf(extended[0], 'extendApproveComment').to).toBe(
      'Согласовано с главным инженером',
    );
    // A second approval of the same, now decided request answers by the rule, not silently.
    const twice = await decide(rental, true);
    expect(twice.statusCode, twice.body).toBe(422);
    expect(twice.json().message).toBe(MECH_EXTENSION_NOT_PENDING_MESSAGE);
  }, 60_000);

  it('the refusal needs a reason and leaves the term; the next request overwrites it', async () => {
    const rental = await runningRental();
    ok(await requestExtension(rental));

    const bare = await decide(rental, false);
    expect(bare.statusCode, bare.body).toBe(400);

    const refused = ok(
      await decide(rental, false, { comment: 'Аренду закрываем, технику вернуть по сроку' }),
    ) as unknown as MechRequestDto;
    expect(refused.plannedTo).toBe(PLANNED_TO);
    expect(refused.extension).toMatchObject({
      status: 'rejected',
      decisionComment: 'Аренду закрываем, технику вернуть по сроку',
    });
    const rejected = kinds(await history(rental.id), 'mechExtendRejected');
    expect(changeOf(rejected[0], 'extendRejectReason').to).toBe(
      'Аренду закрываем, технику вернуть по сроку',
    );

    // A decided row is not withdrawn — it is the last answer; a new request replaces it.
    const late = await withdraw(rental);
    expect(late.statusCode, late.body).toBe(422);
    const asked = ok(await requestExtension(rental)) as unknown as MechRequestDto;
    expect(asked.extension).toMatchObject({
      status: 'pending',
      decidedAt: null,
      decisionComment: '',
    });
  }, 60_000);

  // ── Who decides (R10) ──

  it('the dispatcher asks but does not decide; the visa holder decides but does not ask', async () => {
    const rental = await runningRental();
    const refusedAsk = await requestExtension(rental, { headers: auth.rukstroy });
    expect(refusedAsk.statusCode, refusedAsk.body).toBe(403);

    ok(await requestExtension(rental));
    const refusedDecide = await decide(rental, true, { headers: auth.dispatcher });
    expect(refusedDecide.statusCode, refusedDecide.body).toBe(403);
    expect((await card(rental.id)).plannedTo).toBe(PLANNED_TO);
  }, 60_000);

  it('the department head signs his department request, but never its extension', async () => {
    const rental = await runningRental(ctx.departmentId);
    // He signed the request itself by filing it (ADR 0171, R6) — the scope of the request visa.
    expect(rental.approvedAt).not.toBeNull();
    ok(await requestExtension(rental));

    const head = await decide(rental, true, { headers: auth.head });
    expect(head.statusCode, head.body).toBe(403);
    expect(head.json().message).toBe(MECH_EXTENSION_SCOPE_MESSAGE);

    // A visa holder of another site does not even see the rental.
    const other = await decide(rental, true, { headers: auth.otherRukstroy });
    expect(other.statusCode, other.body).toBe(403);

    // The site's own holder and the administrator do.
    ok(await decide(rental, true));
    const second = await runningRental(ctx.departmentId);
    ok(await requestExtension(second));
    ok(await decide(second, true, { headers: auth.admin }));
  }, 60_000);

  // ── Withdrawal and the automatic drops ──

  it('any dispatcher withdraws a pending request; the row goes, the history keeps it', async () => {
    const rental = await runningRental();
    ok(await requestExtension(rental));
    const withdrawn = ok(
      await withdraw(rental, { headers: auth.dispatcher2 }),
    ) as unknown as MechRequestDto;
    expect(withdrawn.extension).toBeNull();
    expect(withdrawn.plannedTo).toBe(PLANNED_TO);

    const dropped = kinds(await history(rental.id), 'mechExtendDropped');
    expect(changeOf(dropped[0], 'extendDropReason').to).toBe('запрос отозван');

    const nothing = await withdraw(rental);
    expect(nothing.statusCode, nothing.body).toBe(422);
    expect(nothing.json().message).toBe(MECH_EXTENSION_NOT_PENDING_MESSAGE);
  }, 60_000);

  it('completion and the revoked issue mark drop the pending request in their transaction', async () => {
    const completed = await runningRental();
    ok(await requestExtension(completed));
    ok(
      await call(auth.admin, 'PATCH', `/${completed.id}/status`, {
        status: 'done',
        completion: { actualFrom: WEEK_AGO, actualTo: TODAY, actualUnits: 6, finalCost: 9000 },
        version: (await card(completed.id)).version,
      }),
    );
    expect((await card(completed.id)).extension).toBeNull();
    const byCompletion = kinds(await history(completed.id), 'mechExtendDropped');
    expect(changeOf(byCompletion[0], 'extendDropReason').to).toBe('аренда завершена');

    const revoked = await runningRental();
    ok(await requestExtension(revoked));
    ok(
      await call(auth.admin, 'POST', `/${revoked.id}/issue-revoke`, {
        reason: 'Отметили выдачу не той заявке',
        version: (await card(revoked.id)).version,
      }),
    );
    expect((await card(revoked.id)).extension).toBeNull();
    const byRevoke = kinds(await history(revoked.id), 'mechExtendDropped');
    expect(changeOf(byRevoke[0], 'extendDropReason').to).toBe('снята отметка выдачи');

    // The reason code is in the event's metadata for whoever reads the log by machine.
    const rows = await ctx.db.execute<{ reason: string }>(sql`
      SELECT metadata->>'reason' AS reason FROM audit_log
      WHERE entity_type = 'mech_request' AND action = 'mech_request.extend_drop'
        AND entity_id IN (${completed.id}, ${revoked.id})
      ORDER BY created_at`);
    expect(rows.rows.map((r) => r.reason)).toEqual(['completed', 'issue_revoked']);

    // A decided row survives the end of the rental: it is the last answer, not a hanging request.
    const decided = await runningRental();
    ok(await requestExtension(decided));
    ok(await decide(decided, false, { comment: 'Нет' }));
    ok(
      await call(auth.admin, 'PATCH', `/${decided.id}/status`, {
        status: 'done',
        completion: { actualFrom: WEEK_AGO, actualTo: TODAY, actualUnits: 6, finalCost: 9000 },
        version: (await card(decided.id)).version,
      }),
    );
    expect((await card(decided.id)).extension?.status).toBe('rejected');
  }, 90_000);

  // ── The protocol: 409 before 422, and the old door ──

  it('every door bumps the version, and a stale version is 409 before any rule', async () => {
    const rental = await runningRental();
    const v0 = rental.version;
    const stale = await requestExtension(rental, { version: v0 - 1 });
    expect(stale.statusCode, stale.body).toBe(409);

    ok(await requestExtension(rental, { version: v0 }));
    // Nothing would be wrong by the rule here — the request is pending — but the card is old.
    const staleDecision = await decide(rental, true, { version: v0 });
    expect(staleDecision.statusCode, staleDecision.body).toBe(409);
    const staleWithdraw = await withdraw(rental, { version: v0 });
    expect(staleWithdraw.statusCode, staleWithdraw.body).toBe(409);

    ok(await withdraw(rental, { version: v0 + 1 }));
    // Nothing is pending now, so the rule would refuse — but a stale version answers first.
    const ruleOrVersion = await decide(rental, true, { version: v0 + 1 });
    expect(ruleOrVersion.statusCode, ruleOrVersion.body).toBe(409);
    expect((await card(rental.id)).version).toBe(v0 + 2);
  }, 60_000);

  it('the old immediate door still works for old tabs and cannot double-move one snapshot', async () => {
    const rental = await runningRental();
    ok(await requestExtension(rental));

    // An old tab (contract 6) extends at once, as it always did, until R2 removes the door.
    const moved = shiftDateKey(PLANNED_TO, 2);
    const old = ok(
      await call(auth.dispatcher2, 'PATCH', `/${rental.id}/extend`, {
        plannedTo: moved,
        reason: 'Старая вкладка',
        version: (await card(rental.id)).version,
      }),
    ) as unknown as MechRequestDto;
    expect(old.plannedTo).toBe(moved);
    expect(old.extension?.status).toBe('pending');

    // The visa was asked against the old date: approving now would sign a move nobody asked for.
    const refused = await decide(rental, true);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().message).toBe(MECH_EXTENSION_TERM_CHANGED_MESSAGE);
    expect((await card(rental.id)).plannedTo).toBe(moved);
    // Refusing it stays possible.
    ok(await decide(rental, false, { comment: 'Срок уже продлён другим путём' }));
  }, 60_000);

  // ── The table's own invariants ──

  it('the table refuses a backward move, an unexplained refusal and a half decision', async () => {
    const rental = await runningRental();
    const [actor] = await ctx.db
      .select({ id: ctx.schema.users.id })
      .from(ctx.schema.users)
      .where(sql`${ctx.schema.users.email} LIKE ${`${EMAIL_PREFIX}%admin%`}`);
    /*
     * The name of the violated constraint, or `accepted`. Drizzle wraps the driver's error: the
     * constraint lies in the cause, and matching the top-level message would pass on any failure,
     * a typo in a column name included.
     */
    const violated = async (over: Record<string, unknown>): Promise<string> => {
      try {
        await ctx.db.execute(sql`
          INSERT INTO mech_request_extensions
            (request_id, status, new_planned_to, previous_planned_to, reason, requested_by,
             decided_by, decided_at, decision_comment)
          VALUES (${rental.id}, ${over.status ?? 'pending'}, ${over.newPlannedTo ?? ASKED},
                  ${PLANNED_TO}, ${over.reason ?? 'причина'}, ${actor!.id},
                  ${over.decidedBy ?? null}, ${over.decidedAt ?? null}, ${over.comment ?? ''})`);
        await ctx.db.execute(
          sql`DELETE FROM mech_request_extensions WHERE request_id = ${rental.id}`,
        );
        return 'accepted';
      } catch (e) {
        const cause = ((e as { cause?: unknown }).cause ?? e) as { constraint?: string };
        return cause.constraint ?? 'unknown';
      }
    };
    const now = new Date().toISOString();

    expect(await violated({})).toBe('accepted');
    expect(await violated({ newPlannedTo: PLANNED_TO })).toBe(
      'mech_request_extensions_later_check',
    );
    expect(await violated({ reason: '  ' })).toBe('mech_request_extensions_reason_check');
    expect(await violated({ status: 'rejected', decidedBy: actor!.id, decidedAt: now })).toBe(
      'mech_request_extensions_rejection_reason_check',
    );
    expect(await violated({ status: 'approved' })).toBe('mech_request_extensions_pending_check');
    expect(await violated({ decidedBy: actor!.id })).toBe('mech_request_extensions_decision_check');
  }, 60_000);
});
