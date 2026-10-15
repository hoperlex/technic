import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
let mechModelId = '';

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
    const models = await references.query<{ id: string }>(
      'SELECT id FROM mech_models WHERE is_active ORDER BY id LIMIT 1',
    );
    mechModelId = models.rows[0]?.id ?? '';
    if (!mechModelId) throw new Error('Seeded mechanization model is required');
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

  it('keeps the first attempt after a 422 retry and replays it across Moscow midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T20:59:00.000Z'));
    const blocker = new pg.Client({ connectionString: DB_URL!.toString() });
    await blocker.connect();
    let first: Promise<Awaited<ReturnType<NonNullable<typeof app>['inject']>>> | null = null;
    try {
      const login = await app!.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: EMAIL, password: PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);
      const actorHeaders = {
        authorization: `Bearer ${login.json().accessToken}`,
        'idempotency-key': randomUUID(),
      };
      const submitted = body('2026-10-15');
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE vehicle_requests IN ACCESS EXCLUSIVE MODE');
      first = app!
        .inject({ method: 'POST', url: KEYED, headers: actorHeaders, payload: submitted })
        .then((response) => response);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        await blocker.query('SELECT pg_stat_clear_snapshot()');
        const result = await blocker.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE '%vehicle_requests%' AND pid <> pg_backend_pid()`,
        );
        if (result.rows[0]?.n) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting, 'the first POST must reach its insert before midnight').toBe(true);
      vi.setSystemTime(new Date('2026-10-15T21:01:00.000Z'));
      const refused = await app!.inject({
        method: 'POST',
        url: KEYED,
        headers: actorHeaders,
        payload: { ...submitted, responsiblePhone: null },
      });
      expect([400, 422], refused.body).toContain(refused.statusCode);
      await blocker.query('ROLLBACK');
      const created = await first;
      expect(created.statusCode, created.body).toBe(201);
      const repeated = await app!.inject({
        method: 'POST',
        url: KEYED,
        headers: actorHeaders,
        payload: submitted,
      });
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(repeated.json()).toEqual(created.json());
      const newAttempt = await app!.inject({
        method: 'POST',
        url: KEYED,
        headers: { ...actorHeaders, 'idempotency-key': randomUUID() },
        payload: submitted,
      });
      expect([400, 422], newAttempt.body).toContain(newAttempt.statusCode);
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
      await first?.catch(() => undefined);
      vi.useRealTimers();
    }
  });
});

const ordinaryScenarios = [
  {
    kind: 'waste',
    url: '/api/v1/waste-requests',
    table: 'waste_requests',
    payload: () => ({
      objectId,
      requestType: 'metal_removal',
      deliveryAt: `${shiftDateKey(moscowDateKeyOf(new Date()), 3)}T00:00:00+03:00`,
      deliveryTimeUnspecified: true,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      comment: 'first',
    }),
    idOf: (value: { id: string }) => value.id,
  },
  {
    kind: 'mech',
    url: '/api/v1/mech-requests',
    table: 'mech_requests',
    payload: () => ({
      objectId,
      mechModelId,
      plannedFrom: shiftDateKey(moscowDateKeyOf(new Date()), 3),
      plannedTo: shiftDateKey(moscowDateKeyOf(new Date()), 4),
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      comment: 'first',
    }),
    idOf: (value: { id: string }) => value.id,
  },
  {
    kind: 'service',
    url: '/api/v1/service-requests',
    table: 'service_requests',
    payload: () => ({
      officeEquipmentId: null,
      objectId,
      description: 'Проверка повторного создания заявки',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      comment: 'first',
    }),
    idOf: (value: { request: { id: string } }) => value.request.id,
  },
] as const;

describe.skipIf(!SERVER_URL)('ordinary request receipt HTTP replays', () => {
  it.each(ordinaryScenarios)(
    '$kind: concurrent requests, lost response, and changed body',
    async (scenario) => {
      const key = randomUUID();
      const payload = scenario.payload();
      const send = (bodyToSend: Record<string, unknown>) =>
        app!.inject({
          method: 'POST',
          url: scenario.url,
          headers: headers(key),
          payload: bodyToSend,
        });
      const [left, right] = await Promise.all([send(payload), send(payload)]);
      expect([left.statusCode, right.statusCode].sort(), `${left.body}\n${right.body}`).toEqual([
        200, 201,
      ]);
      const created = left.statusCode === 201 ? left : right;
      const replayed = left.statusCode === 200 ? left : right;
      expect(replayed.json()).toEqual(created.json());
      const id = scenario.idOf(created.json());

      // The client may never receive the first response; only its key and body survive.
      const afterLostResponse = await send(payload);
      expect(afterLostResponse.statusCode, afterLostResponse.body).toBe(200);
      expect(afterLostResponse.json()).toEqual(created.json());
      const changed = await send({ ...payload, comment: 'edited after first send' });
      expect(changed.statusCode, changed.body).toBe(409);
      const client = new pg.Client({ connectionString: DB_URL!.toString() });
      await client.connect();
      try {
        const count = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${scenario.table} WHERE id = $1`,
          [id],
        );
        expect(count.rows[0]?.n).toBe(1);
      } finally {
        await client.end();
      }
    },
  );

  it.each(ordinaryScenarios)(
    '$kind: rejected retry while the first HTTP request is in flight',
    async (scenario) => {
      const key = randomUUID();
      const payload = scenario.payload();
      const blocker = new pg.Client({ connectionString: DB_URL!.toString() });
      await blocker.connect();
      let first: Promise<Awaited<ReturnType<NonNullable<typeof app>['inject']>>> | null = null;
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE request_create_attempts IN ACCESS EXCLUSIVE MODE');
        first = app!
          .inject({ method: 'POST', url: scenario.url, headers: headers(key), payload })
          .then((response) => response);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          await blocker.query('SELECT pg_stat_clear_snapshot()');
          const result = await blocker.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE '%request_create_attempts%' AND pid <> pg_backend_pid()`,
          );
          if (result.rows[0]?.n) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting, 'the first HTTP request must be blocked inside the receipt path').toBe(
          true,
        );
        const refused = await app!.inject({
          method: 'POST',
          url: scenario.url,
          headers: headers(key),
          payload: { ...payload, responsiblePhone: null },
        });
        expect([400, 422], refused.body).toContain(refused.statusCode);
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
        await first?.catch(() => undefined);
      }
      const created = await first!;
      expect(created.statusCode, created.body).toBe(201);
      const retry = await app!.inject({
        method: 'POST',
        url: scenario.url,
        headers: headers(key),
        payload,
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual(created.json());
    },
  );
});
