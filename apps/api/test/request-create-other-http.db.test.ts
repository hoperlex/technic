import { generateKeyPairSync, randomUUID } from 'node:crypto';
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

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const client = new pg.Client({ connectionString: DB_URL!.toString() });
  await client.connect();
  try {
    return (await client.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

const receiptRows = (key: string) =>
  countRows('SELECT count(*)::int AS n FROM request_create_attempts WHERE key = $1', [key]);

/** Rows of the request table carrying the label that `body(kind, label)` writes. */
function requestRows(kind: Kind, label: string): Promise<number> {
  if (kind === 'service')
    return countRows('SELECT count(*)::int AS n FROM service_requests WHERE description = $1', [
      `Проверка квитанции ${label}`,
    ]);
  const table = kind === 'waste' ? 'waste_requests' : 'mech_requests';
  return countRows(`SELECT count(*)::int AS n FROM ${table} WHERE comment = $1`, [label]);
}

/** A body the create route refuses at its schema, before any handler code runs. */
function brokenBody(kind: Kind, label: string): Record<string, unknown> {
  return { ...body(kind, label), responsiblePhone: '123' };
}

/**
 * The same parsed body in another spelling: padded name, another phone mask, explicit defaults,
 * and for Waste Removal the same instant written with an offset. The raw bodies differ, the parsed
 * ones do not, so only a fingerprint taken from the parsed data can still match the receipt.
 */
function respelled(kind: Kind, sent: Record<string, unknown>): Record<string, unknown> {
  const common = {
    ...sent,
    responsibleName: '  Иванов Иван Иванович  ',
    responsiblePhone: '8 (999) 000-00-00',
    fileIds: [],
  };
  if (kind === 'waste')
    return {
      ...common,
      deliveryAt: new Date(new Date(sent.deliveryAt as string).getTime() + 3 * 3600_000)
        .toISOString()
        .replace('Z', '+03:00'),
      containersCount: 1,
    };
  if (kind === 'service')
    return { ...common, isUrgent: false, urgencyReason: '', objectOverridden: false, comment: '' };
  return { ...common, comment: sent.comment };
}

const reconcileKey = (
  kind: Kind,
  key: string | undefined,
  originalBody: unknown,
  extra: object = {},
) =>
  app!.inject({
    method: 'POST',
    url: `${ROOT[kind]}/_create-attempts/reconcile`,
    headers: headers(key),
    payload: { originalBody, ...extra },
  });

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
      throw new Error('Numbered migrations must install request_create_attempts');
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

describe.skipIf(!SERVER_URL)('ordinary request reconciliation by key outside Vehicle', () => {
  it.each(KINDS)(
    '%s releases a body that create refused with a 400, then accepts the corrected request',
    async (kind) => {
      const key = randomUUID();
      const label = `broken-${key}`;
      const url = `${ROOT[kind]}/_create-with-receipt`;
      const frozen = brokenBody(kind, label);
      const refused = await app!.inject({
        method: 'POST',
        url,
        headers: headers(key),
        payload: frozen,
      });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(await receiptRows(key)).toBe(0);

      const released = await reconcileKey(kind, key, frozen);
      expect(released.statusCode, released.body).toBe(200);
      expect(released.json()).toMatchObject({ state: 'not-created' });
      const nextKey = released.json().nextOperationId as string;
      expect(nextKey).toMatch(/^[0-9a-f-]{36}$/);
      const again = await reconcileKey(kind, key, frozen);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toEqual(released.json());

      const lateOld = await app!.inject({
        method: 'POST',
        url,
        headers: headers(key),
        payload: body(kind, label),
      });
      expect(lateOld.statusCode, lateOld.body).toBe(409);
      expect(await requestRows(kind, label)).toBe(0);

      const corrected = await app!.inject({
        method: 'POST',
        url,
        headers: headers(nextKey),
        payload: body(kind, label),
      });
      expect(corrected.statusCode, corrected.body).toBe(201);
      expect(await requestRows(kind, label)).toBe(1);
    },
  );

  it.each(KINDS)('%s gives both reconciliation modes the same replacement key', async (kind) => {
    for (const keyFirst of [true, false]) {
      const key = randomUUID();
      const label = `two-modes-${key}`;
      const broken = brokenBody(kind, label);
      const valid = body(kind, label);
      const [first, second] = keyFirst ? [broken, valid] : [valid, broken];
      const left = await reconcileKey(kind, key, first);
      expect(left.statusCode, left.body).toBe(200);
      expect(left.json()).toMatchObject({ state: 'not-created' });
      const right = await reconcileKey(kind, key, second);
      expect(right.statusCode, right.body).toBe(200);
      expect(right.json()).toEqual(left.json());
    }
  });

  it.each(KINDS)(
    '%s answers a committed key by the parsed body however it was spelled',
    async (kind) => {
      const key = randomUUID();
      const sent = body(kind, `spelling-${key}`);
      const created = await app!.inject({
        method: 'POST',
        url: `${ROOT[kind]}/_create-with-receipt`,
        headers: headers(key),
        payload: sent,
      });
      expect(created.statusCode, created.body).toBe(201);
      const reconciled = await reconcileKey(kind, key, respelled(kind, sent));
      expect(reconciled.statusCode, reconciled.body).toBe(200);
      expect(reconciled.json()).toEqual({
        state: 'created',
        requestId: createdId(kind, created.json()),
      });
      // A really different body under the same key is still a reuse.
      const changed = await reconcileKey(kind, key, {
        ...respelled(kind, sent),
        responsibleName: 'Петров Пётр Петрович',
      });
      expect(changed.statusCode, changed.body).toBe(409);
      // The original body is gone from the form, but the committed key still answers.
      const broken = await reconcileKey(kind, key, { ...sent, responsiblePhone: '123' });
      expect(broken.statusCode, broken.body).toBe(200);
      expect(broken.json()).toEqual({
        state: 'created',
        requestId: createdId(kind, created.json()),
      });
    },
  );

  it.each(KINDS)(
    '%s refuses a malformed envelope or a missing key without writing a receipt',
    async (kind) => {
      const valid = body(kind, `envelope-${randomUUID()}`);
      for (const originalBody of [[valid], null, 'text', 12]) {
        const key = randomUUID();
        const response = await reconcileKey(kind, key, originalBody);
        expect(response.statusCode, JSON.stringify(originalBody)).toBe(400);
        expect(await receiptRows(key)).toBe(0);
      }
      const key = randomUUID();
      const extra = await reconcileKey(kind, key, valid, { extra: true });
      expect(extra.statusCode, extra.body).toBe(400);
      expect(await receiptRows(key)).toBe(0);
      for (const original of [valid, { ...valid, responsiblePhone: '123' }]) {
        const absent = await reconcileKey(kind, undefined, original);
        expect(absent.statusCode, absent.body).toBe(422);
      }
    },
  );

  it('keeps Service candidate bodies out of the ordinary receipt table, valid or not', async () => {
    const candidate = {
      description: 'Не печатает, зажёвывает бумагу',
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
      equipmentCandidate: {
        equipmentTypeId: randomUUID(),
        declaredModel: 'Kyocera ECOSYS M3145',
        inventoryNumber: 'TEST-CANDIDATE-KEY-MODE',
        objectId,
        location: 'каб. 214',
      },
    };
    const bodies = [
      candidate,
      { ...candidate, responsiblePhone: '123' },
      { ...candidate, equipmentCandidate: { declaredModel: 'incomplete' } },
      { ...candidate, equipmentCandidate: 'not an object' },
    ];
    for (const original of bodies) {
      const key = randomUUID();
      const response = await reconcileKey('service', key, original);
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().message).toContain('отдельному ключу');
      expect(await receiptRows(key), JSON.stringify(original)).toBe(0);
    }
    // An empty candidate is no report at all, exactly as the create route reads it.
    const key = randomUUID();
    const plain = await reconcileKey('service', key, {
      ...body('service', `no-candidate-${key}`),
      equipmentCandidate: null,
      responsiblePhone: '123',
    });
    expect(plain.statusCode, plain.body).toBe(200);
    expect(plain.json()).toMatchObject({ state: 'not-created' });
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
