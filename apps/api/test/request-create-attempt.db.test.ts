import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { closeDb as CloseDb } from '../src/db/client';
import type * as AttemptService from '../src/services/request-create-attempt';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const DB_NAME = 'technic_receipt_' + randomUUID().replaceAll('-', '').slice(0, 12);
const DB_URL = SERVER_URL ? new URL(SERVER_URL) : null;
if (DB_URL) DB_URL.pathname = '/' + DB_NAME;
const ADMIN_URL = SERVER_URL ? new URL(SERVER_URL) : null;
if (ADMIN_URL) ADMIN_URL.pathname = '/postgres';
const ACTOR = randomUUID();
const OTHER_ACTOR = randomUUID();
let service: typeof AttemptService;
let closeDb: typeof CloseDb;

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
    await client.query('CREATE TABLE users (id uuid PRIMARY KEY)');
    await client.query('INSERT INTO users (id) VALUES ($1), ($2)', [ACTOR, OTHER_ACTOR]);
    await client.query(
      readFileSync(
        new URL('../drizzle/0384_request_create_idempotency.sql', import.meta.url),
        'utf8',
      ),
    );
  } finally {
    await client.end();
  }
  process.env.DATABASE_URL = DB_URL.toString();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PRIVATE_KEY_PEM = String(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.JWT_PUBLIC_KEY_PEM = String(publicKey.export({ type: 'spki', format: 'pem' }));
  process.env.PUBLIC_ORIGIN ??= 'http://localhost:5173';
  process.env.COOKIE_SECRET ??= 'test-cookie-secret-0123456789abcdef';
  process.env.CSRF_SECRET ??= 'test-csrf-secret-0123456789abcdef';
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_BUCKET ??= 'test';
  process.env.S3_ACCESS_KEY_ID ??= 'test';
  process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
  ({ closeDb } = await import('../src/db/client'));
  service = await import('../src/services/request-create-attempt');
}, 120_000);

afterAll(async () => {
  if (!ADMIN_URL || !DB_URL) return;
  await closeDb?.();
  const admin = new pg.Client({ connectionString: ADMIN_URL.toString() });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE ' + DB_NAME + ' WITH (FORCE)');
  } finally {
    await admin.end();
  }
}, 120_000);

describe.skipIf(!SERVER_URL)('shared request creation receipts', () => {
  it('canonicalizes the body and validates keys', () => {
    expect(service.createAttemptFingerprint({ b: 2, a: { y: 1, x: 3 } })).toBe(
      service.createAttemptFingerprint({ a: { x: 3, y: 1 }, b: 2 }),
    );
    expect(() => service.createAttemptKey('not-a-uuid')).toThrow();
    expect(
      service.createAttemptFingerprint({ deliveryAt: new Date('2026-10-15T07:00:00.000Z') }),
    ).not.toBe(
      service.createAttemptFingerprint({ deliveryAt: new Date('2026-10-16T07:00:00.000Z') }),
    );
  });

  it.each(['vehicle', 'waste', 'mech', 'service'] as const)(
    '%s reserves once and freezes one answer under concurrent retries',
    async (kind) => {
      const key = randomUUID();
      const fingerprint = service.createAttemptFingerprint({ kind, comment: 'original' });
      const id = randomUUID();
      let creates = 0;
      let reads = 0;
      let current = 'original';
      const create = async () => {
        creates++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { id, metadata: { mail: 'queued' } };
      };
      const load = async (requestId: string, metadata: { mail: string } | null) => {
        reads++;
        expect(requestId).toBe(id);
        return { id, comment: current, mail: metadata?.mail };
      };
      const args = { key, kind, actorUserId: ACTOR, fingerprint, create, load };
      const [first, second] = await Promise.all([
        service.createRequestOnce(args),
        service.createRequestOnce(args),
      ]);
      expect(creates).toBe(1);
      expect([first.repeated, second.repeated].sort()).toEqual([false, true]);
      expect(first.response).toEqual(second.response);
      current = 'edited later';
      const before = reads;
      expect(await service.replayRequestCreate(key, kind, ACTOR, fingerprint, load)).toEqual(
        first.response,
      );
      expect(reads).toBe(before);
    },
  );

  it('rejects key reuse across kind, actor or body without creating', async () => {
    const key = randomUUID();
    const fingerprint = service.createAttemptFingerprint({ comment: 'first' });
    const id = randomUUID();
    await service.createRequestOnce({
      key,
      kind: 'vehicle',
      actorUserId: ACTOR,
      fingerprint,
      create: async () => ({ id, metadata: null }),
      load: async () => ({ id }),
    });
    let called = false;
    const create = async () => {
      called = true;
      return { id: randomUUID(), metadata: null };
    };
    const load = async () => null;
    for (const [kind, actorUserId, changed] of [
      ['waste', ACTOR, fingerprint],
      ['vehicle', OTHER_ACTOR, fingerprint],
      ['vehicle', ACTOR, service.createAttemptFingerprint({ comment: 'changed' })],
    ] as const) {
      await expect(
        service.createRequestOnce({
          key,
          kind,
          actorUserId,
          fingerprint: changed,
          create,
          load,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(called).toBe(false);
  });

  it('rolls back failed reservations and finishes a committed response gap', async () => {
    const key = randomUUID();
    const fingerprint = service.createAttemptFingerprint({ comment: 'retry' });
    await expect(
      service.createRequestOnce({
        key,
        kind: 'service',
        actorUserId: ACTOR,
        fingerprint,
        create: async () => {
          throw new Error('validation');
        },
        load: async () => null,
      }),
    ).rejects.toThrow('validation');
    const id = randomUUID();
    const client = new pg.Client({ connectionString: DB_URL!.toString() });
    await client.connect();
    try {
      await client.query(
        'INSERT INTO request_create_attempts (key, kind, actor_user_id, fingerprint, request_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
        [key, 'service', ACTOR, fingerprint, id, { mail: 'queued' }],
      );
    } finally {
      await client.end();
    }
    expect(
      await service.replayRequestCreate(
        key,
        'service',
        ACTOR,
        fingerprint,
        async (_id, metadata: { mail: string } | null) => ({ id, mail: metadata?.mail }),
      ),
    ).toEqual({ id, mail: 'queued' });
  });

  it.each(['vehicle', 'waste', 'mech', 'service'] as const)(
    '%s reconciliation waits for an in-flight create and reports its committed request',
    async (kind) => {
      const key = randomUUID();
      const id = randomUUID();
      const fingerprint = service.createAttemptFingerprint({ comment: 'first' });
      let entered!: () => void;
      let release!: () => void;
      const insideCreate = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const heldCreate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = service.createRequestOnce({
        key,
        kind,
        actorUserId: ACTOR,
        fingerprint,
        create: async () => {
          entered();
          await heldCreate;
          return { id, metadata: null };
        },
        load: async () => ({ id }),
      });
      await insideCreate;
      let barrierSettled = false;
      const barrier = service.reconcileRequestCreate({
        key,
        kind,
        actorUserId: ACTOR,
        mode: 'fingerprint',
        fingerprint,
      });
      void barrier.then(() => {
        barrierSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(barrierSettled).toBe(false);
      release();
      expect((await first).response).toEqual({ id });
      expect(await barrier).toEqual({ state: 'created', requestId: id });
    },
  );

  it.each(['vehicle', 'waste', 'mech', 'service'] as const)(
    '%s reconciliation turns a refused create into a durable tombstone',
    async (kind) => {
      const key = randomUUID();
      const fingerprint = service.createAttemptFingerprint({ comment: 'refused' });
      let entered!: () => void;
      let release!: () => void;
      const insideCreate = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const heldCreate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = service.createRequestOnce({
        key,
        kind,
        actorUserId: ACTOR,
        fingerprint,
        create: async () => {
          entered();
          await heldCreate;
          throw new Error('validation');
        },
        load: async () => null,
      });
      await insideCreate;
      const barrier = service.reconcileRequestCreate({
        key,
        kind,
        actorUserId: ACTOR,
        mode: 'fingerprint',
        fingerprint,
      });
      const firstRefusal = expect(first).rejects.toThrow('validation');
      release();
      await firstRefusal;
      const outcome = await barrier;
      expect(outcome.state).toBe('not-created');
      if (outcome.state !== 'not-created') throw new Error('Expected tombstone');
      expect(
        await service.reconcileRequestCreate({
          key,
          kind,
          actorUserId: ACTOR,
          mode: 'fingerprint',
          fingerprint,
        }),
      ).toEqual(outcome);
      await expect(
        service.createRequestOnce({
          key,
          kind,
          actorUserId: ACTOR,
          fingerprint,
          create: async () => ({ id: randomUUID(), metadata: null }),
          load: async () => null,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        service.reconcileRequestCreate({
          key,
          kind,
          actorUserId: OTHER_ACTOR,
          mode: 'fingerprint',
          fingerprint,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const id = randomUUID();
      const corrected = await service.createRequestOnce({
        key: outcome.nextOperationId,
        kind,
        actorUserId: ACTOR,
        fingerprint: service.createAttemptFingerprint({ comment: 'corrected' }),
        create: async () => ({ id, metadata: null }),
        load: async () => ({ id }),
      });
      expect(corrected.response).toEqual({ id });
    },
  );

  it.each(['vehicle', 'waste', 'mech', 'service'] as const)(
    '%s key-mode reconciliation waits for an in-flight create and reports its committed request',
    async (kind) => {
      const key = randomUUID();
      const id = randomUUID();
      let entered!: () => void;
      let release!: () => void;
      const insideCreate = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const heldCreate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = service.createRequestOnce({
        key,
        kind,
        actorUserId: ACTOR,
        fingerprint: service.createAttemptFingerprint({ comment: 'first' }),
        create: async () => {
          entered();
          await heldCreate;
          return { id, metadata: null };
        },
        load: async () => ({ id }),
      });
      await insideCreate;
      let barrierSettled = false;
      // No fingerprint is available in this mode: the key alone must wait for the commit and answer.
      const barrier = service.reconcileRequestCreate({
        key,
        kind,
        actorUserId: ACTOR,
        mode: 'key',
      });
      void barrier.then(() => {
        barrierSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(barrierSettled).toBe(false);
      release();
      expect((await first).response).toEqual({ id });
      expect(await barrier).toEqual({ state: 'created', requestId: id });
    },
  );

  it.each(['vehicle', 'waste', 'mech', 'service'] as const)(
    '%s key-mode reconciliation turns a rolled back create into a durable tombstone',
    async (kind) => {
      const key = randomUUID();
      const fingerprint = service.createAttemptFingerprint({ comment: 'valid body' });
      let entered!: () => void;
      let release!: () => void;
      const insideCreate = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const heldCreate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = service.createRequestOnce({
        key,
        kind,
        actorUserId: ACTOR,
        fingerprint,
        create: async () => {
          entered();
          await heldCreate;
          throw new Error('validation');
        },
        load: async () => null,
      });
      await insideCreate;
      const barrier = service.reconcileRequestCreate({
        key,
        kind,
        actorUserId: ACTOR,
        mode: 'key',
      });
      const firstRefusal = expect(first).rejects.toThrow('validation');
      release();
      await firstRefusal;
      const outcome = await barrier;
      expect(outcome.state).toBe('not-created');
      if (outcome.state !== 'not-created') throw new Error('Expected tombstone');
      expect(
        await service.reconcileRequestCreate({ key, kind, actorUserId: ACTOR, mode: 'key' }),
      ).toEqual(outcome);

      // A create that reaches the key later is refused, whatever its body is.
      let created = false;
      await expect(
        service.createRequestOnce({
          key,
          kind,
          actorUserId: ACTOR,
          fingerprint,
          create: async () => {
            created = true;
            return { id: randomUUID(), metadata: null };
          },
          load: async () => null,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(created).toBe(false);
      await expect(
        service.replayRequestCreate(key, kind, ACTOR, fingerprint, async () => null),
      ).rejects.toMatchObject({ statusCode: 409 });

      const id = randomUUID();
      const corrected = await service.createRequestOnce({
        key: outcome.nextOperationId,
        kind,
        actorUserId: ACTOR,
        fingerprint: service.createAttemptFingerprint({ comment: 'corrected' }),
        create: async () => ({ id, metadata: null }),
        load: async () => ({ id }),
      });
      expect(corrected.response).toEqual({ id });
    },
  );

  it('keeps a key bound to its kind and actor in key mode without leaking the request ID', async () => {
    const committedKey = randomUUID();
    const requestId = randomUUID();
    await service.createRequestOnce({
      key: committedKey,
      kind: 'vehicle',
      actorUserId: ACTOR,
      fingerprint: service.createAttemptFingerprint({ comment: 'committed' }),
      create: async () => ({ id: requestId, metadata: null }),
      load: async () => ({ id: requestId }),
    });
    const tombstoneKey = randomUUID();
    const tombstone = await service.reconcileRequestCreate({
      key: tombstoneKey,
      kind: 'waste',
      actorUserId: ACTOR,
      mode: 'key',
    });
    expect(tombstone.state).toBe('not-created');
    if (tombstone.state !== 'not-created') throw new Error('Expected tombstone');

    const mismatches = [
      { key: committedKey, kind: 'waste', actorUserId: ACTOR },
      { key: committedKey, kind: 'vehicle', actorUserId: OTHER_ACTOR },
      { key: tombstoneKey, kind: 'vehicle', actorUserId: ACTOR },
      { key: tombstoneKey, kind: 'waste', actorUserId: OTHER_ACTOR },
    ] as const;
    for (const mismatch of mismatches) {
      const refusal = await service.reconcileRequestCreate({ ...mismatch, mode: 'key' }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal, JSON.stringify(mismatch)).toMatchObject({ statusCode: 409 });
      // The refusal is the only thing a foreign actor learns: no request ID, no replacement key.
      const disclosed = JSON.stringify(refusal, Object.getOwnPropertyNames(refusal as object));
      expect(disclosed).not.toContain(requestId);
      expect(disclosed).not.toContain(tombstone.nextOperationId);
    }

    // The key mode answers a committed key even when the body behind it is unknown.
    expect(
      await service.reconcileRequestCreate({
        key: committedKey,
        kind: 'vehicle',
        actorUserId: ACTOR,
        mode: 'key',
      }),
    ).toEqual({ state: 'created', requestId });
  });

  it('does not let the key-mode marker loosen the fingerprint match of a real receipt', async () => {
    const key = randomUUID();
    const id = randomUUID();
    await service.createRequestOnce({
      key,
      kind: 'mech',
      actorUserId: ACTOR,
      fingerprint: service.createAttemptFingerprint({ comment: 'original' }),
      create: async () => ({ id, metadata: null }),
      load: async () => ({ id }),
    });
    await expect(
      service.reconcileRequestCreate({
        key,
        kind: 'mech',
        actorUserId: ACTOR,
        mode: 'fingerprint',
        fingerprint: service.createAttemptFingerprint({ comment: 'another body' }),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await service.reconcileRequestCreate({
        key,
        kind: 'mech',
        actorUserId: ACTOR,
        mode: 'fingerprint',
        fingerprint: service.createAttemptFingerprint({ comment: 'original' }),
      }),
    ).toEqual({ state: 'created', requestId: id });
  });

  it.each([
    ['fingerprint then key', ['fingerprint', 'key']],
    ['key then fingerprint', ['key', 'fingerprint']],
  ] as const)('%s: a tombstone gives both tabs one replacement key', async (_name, order) => {
    const key = randomUUID();
    const base = { key, kind: 'service' as const, actorUserId: ACTOR };
    const fingerprint = service.createAttemptFingerprint({ comment: 'two modes' });
    const reconcile = (mode: 'fingerprint' | 'key') =>
      service.reconcileRequestCreate(
        mode === 'key' ? { ...base, mode } : { ...base, mode, fingerprint },
      );
    const first = await reconcile(order[0]);
    expect(first.state).toBe('not-created');
    expect(await reconcile(order[1])).toEqual(first);
    expect(await reconcile(order[0])).toEqual(first);
  });

  it('gives concurrent key-mode and fingerprint-mode tabs the same replacement key', async () => {
    const key = randomUUID();
    const base = { key, kind: 'waste' as const, actorUserId: ACTOR };
    const fingerprint = service.createAttemptFingerprint({ comment: 'racing modes' });
    const [left, right] = await Promise.all([
      service.reconcileRequestCreate({ ...base, mode: 'key' }),
      service.reconcileRequestCreate({ ...base, mode: 'fingerprint', fingerprint }),
    ]);
    expect(left).toEqual(right);
    expect(left.state).toBe('not-created');
  });

  it('gives two restored tabs the same replacement key without ever creating with the original', async () => {
    const key = randomUUID();
    const fingerprint = service.createAttemptFingerprint({ comment: 'two tabs' });
    const args = { key, kind: 'vehicle' as const, actorUserId: ACTOR, fingerprint };
    const [left, right] = await Promise.all([
      service.reconcileRequestCreate({ ...args, mode: 'fingerprint' }),
      service.reconcileRequestCreate({ ...args, mode: 'fingerprint' }),
    ]);
    expect(left).toEqual(right);
    expect(left.state).toBe('not-created');
    let created = false;
    await expect(
      service.createRequestOnce({
        ...args,
        create: async () => {
          created = true;
          return { id: randomUUID(), metadata: null };
        },
        load: async () => null,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(created).toBe(false);
  });
});
