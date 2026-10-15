import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { closeDb as CloseDb } from '../src/db/client';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const DB_NAME = 'technic_other_receipt_' + randomUUID().replaceAll('-', '').slice(0, 12);
const DB_URL = SERVER_URL ? new URL(SERVER_URL) : null;
if (DB_URL) DB_URL.pathname = '/' + DB_NAME;
const ADMIN_URL = SERVER_URL ? new URL(SERVER_URL) : null;
if (ADMIN_URL) ADMIN_URL.pathname = '/postgres';

type Kind = 'waste' | 'mech' | 'service';
const KINDS: Kind[] = ['waste', 'mech', 'service'];
const ROOT: Record<Kind, string> = {
  waste: '/api/v1/waste-requests',
  mech: '/api/v1/mech-requests',
  service: '/api/v1/service-requests',
};
const EMAIL = `other-receipt-${randomUUID()}@example.invalid`;
const PASSWORD = 'db-test-password-123';

let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let closeDb: typeof CloseDb | null = null;
let authorization = '';
let objectId = '';
let mechModelId = '';

function body(kind: Kind, label: string): Record<string, unknown> {
  const contact = {
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  };
  if (kind === 'waste')
    return {
      ...contact,
      objectId,
      requestType: 'metal_removal',
      deliveryAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      deliveryTimeUnspecified: true,
      comment: label,
    };
  if (kind === 'mech')
    return {
      ...contact,
      objectId,
      mechModelId,
      plannedFrom: shiftDateKey(moscowDateKeyOf(new Date()), 3),
      plannedTo: shiftDateKey(moscowDateKeyOf(new Date()), 4),
      comment: label,
    };
  return {
    ...contact,
    officeEquipmentId: null,
    customerDepartmentId: null,
    objectId,
    description: `Проверка квитанции ${label}`,
    isUrgent: false,
    urgencyReason: '',
  };
}

function headers(key?: string): Record<string, string> {
  return { authorization, ...(key ? { 'idempotency-key': key } : {}) };
}

function createdId(kind: Kind, value: Record<string, unknown>): string {
  return kind === 'service'
    ? ((value.request as Record<string, unknown>).id as string)
    : (value.id as string);
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
    const receipt = await client.query<{ name: string | null }>(
      "SELECT to_regclass('public.request_create_attempts')::text AS name",
    );
    if (!receipt.rows[0]?.name)
      await client.query(
        readFileSync(
          new URL('../drizzle/pending/request-create-idempotency.sql', import.meta.url),
          'utf8',
        ),
      );
    objectId =
      (
        await client.query<{ id: string }>(
          'SELECT id FROM construction_objects WHERE is_active ORDER BY id DESC LIMIT 1',
        )
      ).rows[0]?.id ?? '';
    mechModelId =
      (
        await client.query<{ id: string }>(
          'SELECT id FROM mech_models WHERE is_active ORDER BY id DESC LIMIT 1',
        )
      ).rows[0]?.id ?? '';
    if (!objectId || !mechModelId) throw new Error('Seeded object and mech model are required');
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
  process.env.MAIL_ENABLED ??= 'false';
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

describe.skipIf(!SERVER_URL)('ordinary request receipt HTTP protocol outside Vehicle', () => {
  it.each(KINDS)(
    '%s uses a versioned create, replays once, and reconciles its ID',
    async (kind) => {
      const key = randomUUID();
      const submitted = body(kind, `keyed-${key}`);
      const url = `${ROOT[kind]}/_create-with-receipt`;
      const first = await app!.inject({
        method: 'POST',
        url,
        headers: headers(key),
        payload: submitted,
      });
      expect(first.statusCode, first.body).toBe(201);
      const repeated = await app!.inject({
        method: 'POST',
        url,
        headers: headers(key),
        payload: submitted,
      });
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(repeated.json()).toEqual(first.json());
      const check = await app!.inject({
        method: 'POST',
        url: `${ROOT[kind]}/_create-attempts/reconcile`,
        headers: headers(key),
        payload: { originalBody: submitted },
      });
      expect(check.statusCode, check.body).toBe(200);
      expect(check.json()).toEqual({ state: 'created', requestId: createdId(kind, first.json()) });
    },
  );

  it.each(KINDS)(
    '%s keeps the headerless root route and requires a key on the new route',
    async (kind) => {
      const submitted = body(kind, `legacy-${randomUUID()}`);
      const missing = await app!.inject({
        method: 'POST',
        url: `${ROOT[kind]}/_create-with-receipt`,
        headers: headers(),
        payload: submitted,
      });
      expect(missing.statusCode, missing.body).toBe(422);
      const old = await app!.inject({
        method: 'POST',
        url: ROOT[kind],
        headers: headers(),
        payload: submitted,
      });
      expect(old.statusCode, old.body).toBe(201);
    },
  );

  it.each(KINDS)('%s tombstones an absent attempt before a corrected create', async (kind) => {
    const key = randomUUID();
    const submitted = body(kind, `absent-${key}`);
    const check = await app!.inject({
      method: 'POST',
      url: `${ROOT[kind]}/_create-attempts/reconcile`,
      headers: headers(key),
      payload: { originalBody: submitted },
    });
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json()).toMatchObject({ state: 'not-created' });
    const replacement = check.json().nextOperationId as string;
    const blocked = await app!.inject({
      method: 'POST',
      url: `${ROOT[kind]}/_create-with-receipt`,
      headers: headers(key),
      payload: submitted,
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    const created = await app!.inject({
      method: 'POST',
      url: `${ROOT[kind]}/_create-with-receipt`,
      headers: headers(replacement),
      payload: body(kind, `corrected-${key}`),
    });
    expect(created.statusCode, created.body).toBe(201);
  });

  it('keeps the Service candidate protocol outside ordinary receipt reconciliation', async () => {
    const candidate = {
      description: 'Не печатает, зажёвывает бумагу',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      equipmentCandidate: {
        equipmentTypeId: randomUUID(),
        declaredModel: 'Kyocera ECOSYS M3145',
        inventoryNumber: 'TEST-CANDIDATE-RECEIPT',
        objectId,
        location: 'каб. 214',
      },
    };
    const key = randomUUID();
    const keyed = await app!.inject({
      method: 'POST',
      url: `${ROOT.service}/_create-with-receipt`,
      headers: headers(key),
      payload: candidate,
    });
    expect(keyed.statusCode, keyed.body).toBe(422);
    expect(keyed.json().message).toContain('основной маршрут');
    const check = await app!.inject({
      method: 'POST',
      url: `${ROOT.service}/_create-attempts/reconcile`,
      headers: headers(key),
      payload: { originalBody: candidate },
    });
    expect(check.statusCode, check.body).toBe(422);
    expect(check.json().message).toContain('отдельному ключу');
  });
});

describe.skipIf(!SERVER_URL)('Mechanization duplicate receipt HTTP protocol', () => {
  const createSource = async (label: string) => {
    const response = await app!.inject({
      method: 'POST',
      url: ROOT.mech,
      headers: headers(),
      payload: body('mech', label),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; version: number };
  };
  const duplicate = (sourceId: string, key?: string) =>
    app!.inject({
      method: 'POST',
      url: `${ROOT.mech}/${sourceId}/_duplicate-with-receipt`,
      headers: headers(key),
      payload: {},
    });
  const reconcile = (sourceId: string, key: string) =>
    app!.inject({
      method: 'POST',
      url: `${ROOT.mech}/${sourceId}/_duplicate-attempts/reconcile`,
      headers: headers(key),
      payload: { originalBody: {} },
    });

  it('keeps the legacy door and rejects a missing key on the versioned door', async () => {
    const source = await createSource(`duplicate-legacy-${randomUUID()}`);
    const missing = await duplicate(source.id);
    expect(missing.statusCode, missing.body).toBe(422);
    const old = await app!.inject({
      method: 'POST',
      url: `${ROOT.mech}/${source.id}/duplicate`,
      headers: headers(),
      payload: {},
    });
    expect(old.statusCode, old.body).toBe(201);
    expect(old.json().id).toBeTypeOf('string');
  });

  it('replays one ID after the source changes and is hard deleted', async () => {
    const source = await createSource(`duplicate-replay-${randomUUID()}`);
    const key = randomUUID();
    const [first, concurrent] = await Promise.all([
      duplicate(source.id, key),
      duplicate(source.id, key),
    ]);
    expect([first.statusCode, concurrent.statusCode].sort()).toEqual([200, 201]);
    expect(concurrent.json()).toEqual(first.json());
    const requestId = first.json().requestId as string;
    expect(requestId).toBeTypeOf('string');

    const edit = await app!.inject({
      method: 'PATCH',
      url: `${ROOT.mech}/${source.id}`,
      headers: headers(),
      payload: { version: source.version, comment: `source changed ${randomUUID()}` },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const removed = await app!.inject({
      method: 'DELETE',
      url: `${ROOT.mech}/${source.id}?version=${edit.json().version}`,
      headers: headers(),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const replay = await duplicate(source.id, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ requestId });
    const checked = await reconcile(source.id, key);
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json()).toEqual({ state: 'created', requestId });
  });

  it('binds a key to the source and tombstones an absent attempt', async () => {
    const source = await createSource(`duplicate-tombstone-${randomUUID()}`);
    const other = await createSource(`duplicate-other-${randomUUID()}`);
    const key = randomUUID();
    const checked = await reconcile(source.id, key);
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json()).toMatchObject({ state: 'not-created' });
    const old = await duplicate(source.id, key);
    expect(old.statusCode, old.body).toBe(409);
    const replacement = checked.json().nextOperationId as string;
    const created = await duplicate(source.id, replacement);
    expect(created.statusCode, created.body).toBe(201);
    const mismatch = await duplicate(other.id, replacement);
    expect(mismatch.statusCode, mismatch.body).toBe(409);
    const next = await duplicate(source.id, randomUUID());
    expect(next.statusCode, next.body).toBe(201);
    expect(next.json().requestId).not.toBe(created.json().requestId);
  });
});
