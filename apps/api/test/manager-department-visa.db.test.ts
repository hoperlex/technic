import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values are imported after the environment is set — the config reads it at import.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as Schema from '../src/db/schema';
import type * as UserScopes from '../src/services/user-scopes';

/**
 * «Виза отдела» on a manager (ADR 0245, hotfix 05.11.2026) on live routes.
 *
 * What is proven here:
 *
 * 1. Migration 0410 makes the grant compatible with `manager` in the database — the grant gate reads
 *    `grant_roles`, not the contract.
 * 2. The account refuses a visa grant without a visa department (owner decision 05.11.2026), and
 *    the point assignment from the registry refuses it too.
 * 3. A manager with a visa department signs a site order of that department and gets 403 on a
 *    foreign site — the visa endpoint asks the visa predicate, not only the scope check, which an
 *    axis-less role passes for every row.
 * 4. The session carries the visa departments and their sites; visibility stays company-wide.
 * 5. An edit without the field keeps the visa departments (old bundles never send it); a change of
 *    them bumps `authVersion`; a change of a department's sites bumps its visa holders too.
 *
 * Own database, not the shared one: the assertions count exact rows.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/manager-department-visa.db.test.ts --maxWorkers=1
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_manager_department_visa';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const ADMIN_EMAIL = 'db-visa-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
const RUN = Date.now().toString(36);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof Schema;
  scopes: typeof UserScopes;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  grant: { id: string; version: number };
  ownDepartmentId: string;
  otherDepartmentId: string;
  ownSiteId: string;
  foreignSiteId: string;
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
  today: string;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV ??= 'test';
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
  process.env.RATE_LIMIT_MAX ??= '100000';
}

async function login(email: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  return { auth: { authorization: `Bearer ${body.accessToken}` }, user: body.user };
}

function createManager(tag: string, extra: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/users',
    headers: ctx.auth,
    payload: {
      email: `db-visa-${tag}-${RUN}@example.invalid`,
      lastName: 'Визирующий',
      firstName: 'Тест',
      role: 'manager',
      password: PASSWORD,
      notifyUser: false,
      ...extra,
    },
  });
}

async function siteOrder(objectId: string): Promise<{ id: string; version: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      ...(ctx.vehicleCategoryId ? { vehicleCategoryId: ctx.vehicleCategoryId } : {}),
      dateFrom: shiftDateKey(ctx.today, 1),
      dateTo: shiftDateKey(ctx.today, 3),
      responsibleName: 'Визин Пётр Иванович',
      responsiblePhone: '9007770245',
      comment: 'ТЕСТ ADR 0245: виза отдела у менеджера',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function authVersionOf(userId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ v: ctx.schema.users.authVersion })
    .from(ctx.schema.users)
    .where(eq(ctx.schema.users.id, userId));
  return row!.v;
}

describe.skipIf(!DB_URL)('«Виза отдела» у менеджера (ADR 0245)', () => {
  beforeAll(async () => {
    const adminClient = new pg.Client({ connectionString: ADMIN_DB });
    await adminClient.connect();
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
      await adminClient.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await adminClient.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await client.query('CREATE EXTENSION IF NOT EXISTS unaccent');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const schema = await import('../src/db/schema');

    await db.insert(schema.users).values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    });

    const [own, other] = await db
      .insert(schema.departments)
      .values([
        { code: `visa_own_${RUN}`, name: `ОАТ СМ тест ${RUN}` },
        { code: `visa_other_${RUN}`, name: `Чужой отдел ${RUN}` },
      ])
      .returning({ id: schema.departments.id });
    const sites = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active ORDER BY id LIMIT 2`,
    );
    const [ownSite, foreignSite] = sites.rows;
    if (!ownSite || !foreignSite) throw new Error('migrations brought fewer than two sites');
    await db
      .insert(schema.departmentConstructionObjects)
      .values({ departmentId: own!.id, constructionObjectId: ownSite.id });

    const types = await db.execute<{ id: string }>(sql`
      SELECT vt.id FROM vehicle_types vt
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE vk.code = 'special_equipment' AND vt.is_active AND vt.is_linear = false
       ORDER BY vt.id LIMIT 1`);
    const vehicleType = types.rows[0];
    if (!vehicleType) throw new Error('no special equipment vehicle type');
    const categories = await db.execute<{ id: string }>(sql`
      SELECT id FROM vehicle_categories
       WHERE vehicle_type_id = ${vehicleType.id} AND is_active ORDER BY id LIMIT 1`);

    const [grant] = await db
      .select({ id: schema.grants.id, version: schema.grants.version })
      .from(schema.grants)
      .where(eq(schema.grants.code, 'department_approval'));
    if (!grant) throw new Error('grant department_approval is missing');

    ctx = {
      app: await buildApp(),
      db,
      schema,
      scopes: await import('../src/services/user-scopes'),
      closeDb,
      auth: { authorization: '' },
      grant,
      ownDepartmentId: own!.id,
      otherDepartmentId: other!.id,
      ownSiteId: ownSite.id,
      foreignSiteId: foreignSite.id,
      vehicleTypeId: vehicleType.id,
      vehicleCategoryId: categories.rows[0]?.id ?? null,
      today: moscowDateKeyOf(new Date()),
    };
    ctx.auth = (await login(ADMIN_EMAIL)).auth;
  }, 180_000);

  afterAll(async () => {
    await ctx?.app?.close();
    await ctx?.closeDb?.();
    if (!ADMIN_DB) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('migration 0410 makes the grant compatible with the manager in the database', async () => {
    const rows = await ctx.db.execute<{ role: string }>(sql`
      SELECT gr.role::text AS role FROM grant_roles gr
        JOIN grants g ON g.id = gr.grant_id
       WHERE g.code = 'department_approval' ORDER BY gr.role::text`);
    expect(rows.rows.map((r) => r.role)).toEqual(['department', 'manager']);
  });

  it('refuses the visa grant without a visa department, field named', async () => {
    const res = await createManager('empty', {
      grants: [{ ...ctx.grant, selected: true }],
      approvalDepartmentIds: [],
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().fields?.approvalDepartmentIds).toBeTruthy();
  });

  it('a manager without the visa keeps no visa departments: the visa itself is optional', async () => {
    const res = await createManager('plain', { approvalDepartmentIds: [ctx.ownDepartmentId] });
    expect(res.statusCode, res.body).toBe(201);
    // The role accepts the field, so the departments are stored; without the grant they give
    // nothing — the visa predicate asks the permission first.
    const plain = await login(`db-visa-plain-${RUN}@example.invalid`);
    expect(plain.user.permissions).not.toContain('vehicleRequests.approve');
  });

  it('signs a site order of its visa department and gets 403 on a foreign site', async () => {
    const created = await createManager('signer', {
      grants: [{ ...ctx.grant, selected: true }],
      approvalDepartmentIds: [ctx.ownDepartmentId],
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().user.approvalDepartments.map((d: { id: string }) => d.id)).toEqual([
      ctx.ownDepartmentId,
    ]);

    const signer = await login(`db-visa-signer-${RUN}@example.invalid`);
    expect(signer.user.permissions).toContain('vehicleRequests.approve');
    expect(signer.user.approvalDepartmentIds).toEqual([ctx.ownDepartmentId]);
    expect(signer.user.approvalDepartmentObjectIds).toEqual([ctx.ownSiteId]);
    // Not a scope axis: the account is not a member of the department.
    expect(signer.user.departmentIds).toEqual([]);

    const own = await siteOrder(ctx.ownSiteId);
    const foreign = await siteOrder(ctx.foreignSiteId);

    const signed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${own.id}/approval`,
      headers: signer.auth,
      payload: { approved: true, version: own.version },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json().approvedAt).toBeTruthy();

    const refused = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${foreign.id}/approval`,
      headers: signer.auth,
      payload: { approved: true, version: foreign.version },
    });
    expect(refused.statusCode, refused.body).toBe(403);

    // Visibility stays company-wide: the foreign order is readable, only not signable.
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${foreign.id}`,
      headers: signer.auth,
    });
    expect(read.statusCode, read.body).toBe(200);
  });

  it('an edit without the field keeps the visa departments; a change bumps authVersion', async () => {
    const created = await createManager('edit', {
      grants: [{ ...ctx.grant, selected: true }],
      approvalDepartmentIds: [ctx.ownDepartmentId],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().user.id as string;

    // An old bundle: it knows nothing of the field and never sends it.
    const phoneOnly = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: ctx.auth,
      payload: { phone: '9001110245' },
    });
    expect(phoneOnly.statusCode, phoneOnly.body).toBe(200);
    expect(phoneOnly.json().user.approvalDepartments).toHaveLength(1);

    // Emptying them while the grant stays would leave a visa that gives nothing.
    const emptied = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: ctx.auth,
      payload: { approvalDepartmentIds: [] },
    });
    expect(emptied.statusCode, emptied.body).toBe(400);

    const before = await authVersionOf(id);
    const widened = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${id}`,
      headers: ctx.auth,
      payload: { approvalDepartmentIds: [ctx.ownDepartmentId, ctx.otherDepartmentId] },
    });
    expect(widened.statusCode, widened.body).toBe(200);
    expect(widened.json().user.approvalDepartments).toHaveLength(2);
    expect(await authVersionOf(id)).toBe(before + 1);

    // A change of the department's sites changes what the holder may sign: tokens follow.
    const bumped = await ctx.db.transaction((tx) =>
      ctx.scopes.markDepartmentScopeChanged(tx, ctx.otherDepartmentId),
    );
    expect(bumped).toContain(id);
  });

  it('the point assignment from the registry refuses a manager without a visa department', async () => {
    const created = await createManager('point', {});
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().user.id as string;
    const preview = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${id}/grants/preview`,
      headers: ctx.auth,
      payload: { operation: 'assign', grantId: ctx.grant.id },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const assigned = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${id}/grants`,
      headers: ctx.auth,
      payload: { grantId: ctx.grant.id, expectedImpactHash: preview.json().expectedImpactHash },
    });
    expect(assigned.statusCode, assigned.body).toBe(400);
    expect(assigned.json().message).toContain('отдел');
  });
});
