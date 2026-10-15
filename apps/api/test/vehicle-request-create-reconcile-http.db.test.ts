import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { closeDb as CloseDb } from '../src/db/client';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const DB_NAME = 'technic_receipt_http_' + randomUUID().replaceAll('-', '').slice(0, 12);
const DB_URL = SERVER_URL ? new URL(SERVER_URL) : null;
if (DB_URL) DB_URL.pathname = '/' + DB_NAME;
const ADMIN_URL = SERVER_URL ? new URL(SERVER_URL) : null;
if (ADMIN_URL) ADMIN_URL.pathname = '/postgres';

const ROOT = '/api/v1/vehicle-requests';
const KEYED = `${ROOT}/_create-with-receipt`;
const RECONCILE = `${ROOT}/_create-attempts/reconcile`;
const EMAIL = `receipt-http-${randomUUID()}@example.invalid`;
const PASSWORD = 'db-test-password-123';

let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let closeDb: typeof CloseDb | null = null;
let authorization = '';
let objectId = '';
let vehicleTypeId = '';
let vehicleCategoryId: string | null = null;

function body(dateFrom: string): Record<string, unknown> {
  return {
    requestType: 'special_equipment',
    objectId,
    vehicleTypeId,
    vehicleCategoryId,
    dateFrom,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  };
}

function headers(key?: string): Record<string, string> {
  return {
    authorization,
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

beforeAll(async () => {
  if (!ADMIN_URL || !DB_URL) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL.toString() });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE ' + DB_NAME);
  } finally {
    await admin.end();
  }
  const client = new pg.Client({ connectionString: DB_URL.toString() });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(client);
    const installed = await client.query<{ name: string | null }>(
      "SELECT to_regclass('public.request_create_attempts')::text AS name",
    );
    if (!installed.rows[0]?.name) {
      await client.query(
        readFileSync(
          new URL('../drizzle/pending/request-create-idempotency.sql', import.meta.url),
          'utf8',
        ),
      );
    }
  } finally {
    await client.end();
  }

  process.env.DATABASE_URL = DB_URL.toString();
  process.env.NODE_ENV ??= 'test';
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  process.env.LOG_LEVEL ??= 'error';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));

  const { db, closeDb: close } = await import('../src/db/client');
  const { users } = await import('../src/db/schema');
  const { hashPassword } = await import('../src/auth/password');
  closeDb = close;
  await db.insert(users).values({
    email: EMAIL,
    lastName: 'Тестовый',
    firstName: 'Администратор',
    middleName: '',
    passwordHash: await hashPassword(PASSWORD),
    role: 'admin',
    isActive: true,
  });

  const references = new pg.Client({ connectionString: DB_URL.toString() });
  await references.connect();
  try {
    const objects = await references.query<{ id: string }>(
      'SELECT id FROM construction_objects WHERE is_active ORDER BY id DESC LIMIT 1',
    );
    const types = await references.query<{
      type_id: string;
      category_id: string | null;
    }>(`
      SELECT v.vehicle_type_id AS type_id, v.vehicle_category_id AS category_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vk.code = 'special_equipment' AND v.vehicle_category_id IS NOT NULL
      ORDER BY v.id DESC LIMIT 1
    `);
    objectId = objects.rows[0]?.id ?? '';
    vehicleTypeId = types.rows[0]?.type_id ?? '';
    vehicleCategoryId = types.rows[0]?.category_id ?? null;
    if (!objectId || !vehicleTypeId) throw new Error('Seeded object and vehicle type are required');
  } finally {
    await references.end();
  }

  const { buildApp } = await import('../src/app');
  app = await buildApp();
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  authorization = `Bearer ${login.json().accessToken}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  if (!ADMIN_URL) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL.toString() });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE ' + DB_NAME + ' WITH (FORCE)');
  } finally {
    await admin.end();
  }
}, 120_000);

describe.skipIf(!SERVER_URL)('Vehicle Request receipt HTTP protocol', () => {
  it('creates through the versioned route and reconciles the committed ID', async () => {
    const key = randomUUID();
    const submitted = body(shiftDateKey(moscowDateKeyOf(new Date()), 3));
    const created = await app!.inject({
      method: 'POST',
      url: KEYED,
      headers: headers(key),
      payload: submitted,
    });
    expect(created.statusCode, created.body).toBe(201);
    const repeated = await app!.inject({
      method: 'POST',
      url: KEYED,
      headers: headers(key),
      payload: submitted,
    });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toEqual(created.json());
    const reconciled = await app!.inject({
      method: 'POST',
      url: RECONCILE,
      headers: headers(key),
      payload: { originalBody: submitted },
    });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json()).toEqual({ state: 'created', requestId: created.json().id });
  });

  it('blocks correction bodies on both new routes while the headerless root route remains usable', async () => {
    const submitted = body(shiftDateKey(moscowDateKeyOf(new Date()), 3));
    const key = randomUUID();
    const correction = { ...submitted, operationId: randomUUID(), backdateReason: 'Correction' };
    const keyed = await app!.inject({
      method: 'POST',
      url: KEYED,
      headers: headers(key),
      payload: correction,
    });
    expect(keyed.statusCode, keyed.body).toBe(422);
    const reconcile = await app!.inject({
      method: 'POST',
      url: RECONCILE,
      headers: headers(key),
      payload: { originalBody: correction },
    });
    expect(reconcile.statusCode, reconcile.body).toBe(422);
    const missingKey = await app!.inject({
      method: 'POST',
      url: KEYED,
      headers: headers(),
      payload: submitted,
    });
    expect(missingKey.statusCode, missingKey.body).toBe(422);
    const legacy = await app!.inject({
      method: 'POST',
      url: ROOT,
      headers: headers(),
      payload: submitted,
    });
    expect(legacy.statusCode, legacy.body).toBe(201);
  });

  it('reconciles a rejected date to a tombstone before accepting a corrected request', async () => {
    const key = randomUUID();
    const rejectedBody = body(shiftDateKey(moscowDateKeyOf(new Date()), -1));
    const rejected = await app!.inject({
      method: 'POST',
      url: KEYED,
      headers: headers(key),
      payload: rejectedBody,
    });
    expect([400, 422]).toContain(rejected.statusCode);
    const resolved = await app!.inject({
      method: 'POST',
      url: RECONCILE,
      headers: headers(key),
      payload: { originalBody: rejectedBody },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json()).toMatchObject({ state: 'not-created' });
    const nextKey = resolved.json().nextOperationId as string;
    expect(nextKey).toMatch(/^[0-9a-f-]{36}$/);
    const oldKey = await app!.inject({
      method: 'POST',
      url: KEYED,
      headers: headers(key),
      payload: body(shiftDateKey(moscowDateKeyOf(new Date()), 3)),
    });
    expect(oldKey.statusCode, oldKey.body).toBe(409);
    const corrected = await app!.inject({
      method: 'POST',
      url: KEYED,
      headers: headers(nextKey),
      payload: body(shiftDateKey(moscowDateKeyOf(new Date()), 3)),
    });
    expect(corrected.statusCode, corrected.body).toBe(201);
  });
});
