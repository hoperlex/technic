import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SNOW_WASTE_TYPE_CODE,
  SNOW_WASTE_TYPE_ID,
  SNOW_WASTE_TYPE_NAME,
  type WasteTypeDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values of these modules are loaded with `await import` after the environment is
// set, because the config validates it at import time.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * The reserved service waste type «Снег» at the directory entry points (snow-removal plan, §3.2,
 * §4 «Directory and DB»; migration 0429).
 *
 * WHY A DATABASE. The point of these entry points is to refuse BEFORE the database does, in field
 * words, and to keep the database as the backstop. Both halves are only visible against the real
 * schema: the seeded row, `waste_type_name_key`, and the CHECKs and trigger of migration 0429.
 *
 * ISOLATION. Everything this file creates carries the run suffix `RUN` (codes, names, emails, the
 * operator's name) and `afterAll` removes exactly that. The reserved row is only read.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:55961/technic_test \
 *     pnpm check:db waste-service-type
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
/** Code prefix of this run's waste types: `afterAll` finds its own rows by it. */
const CODE = `wst_${RUN.replace(/[^a-z0-9]/gu, '')}`;
const EMAIL = (tag: string) => `db-waste-service-${tag}-${RUN}@example.invalid`;

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  /** Administrator: directory write, purge, import and export. */
  admin: Auth;
}

let ctx: Ctx;

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

/** A distinct address per request: the shared rate limiter counts requests per address. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload ? { payload } : {}),
  });
}

let typeNo = 0;
/** An ordinary waste type of this run, created by SQL: the form is not what is tested here. */
async function ordinaryType(isActive = true): Promise<{ id: string; code: string; name: string }> {
  typeNo += 1;
  const code = `${CODE}_${typeNo}`;
  const name = `Тестовый мусор ${RUN} ${typeNo}`;
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO waste_types (code, name, is_active) VALUES (${code}, ${name}, ${isActive})
    RETURNING id`);
  return { id: res.rows[0]!.id, code, name };
}

/** Every page of `GET /waste-types` with the given filter. */
async function listTypes(query: string): Promise<WasteTypeDto[]> {
  const res = await inject('GET', `/api/v1/waste-types?pageSize=200&${query}`, ctx.admin);
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<{ items: WasteTypeDto[]; total: number }>();
  expect(body.total, 'the test reads one page: the directory must fit in it').toBe(
    body.items.length,
  );
  return body.items;
}

describe.skipIf(!DB_URL)('служебный тип «Снег» в справочниках', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);
    const admin = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${EMAIL('admin')}, 'Тестовый', 'Администратор', 'Снегович', ${passwordHash},
              'admin'::role, true, now())
      RETURNING id`);
    expect(admin.rows).toHaveLength(1);

    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: EMAIL('admin'), password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = { app, db, admin: { authorization: `Bearer ${login.json().accessToken}` } };
  }, 120_000);

  afterAll(async () => {
    if (!ctx?.db) return;
    await ctx.app?.close();
    await ctx.db.execute(sql`DELETE FROM waste_types WHERE code LIKE ${`${CODE}%`}`);
    const users = sql`SELECT id FROM users WHERE email LIKE ${EMAIL('%')}`;
    // The audit log first: `audit_log.actor_user_id` is RESTRICT.
    await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
    await ctx.db.execute(sql`DELETE FROM users WHERE email LIKE ${EMAIL('%')}`);
    const { closeDb } = await import('../src/db/client');
    await closeDb();
  });

  it('миграция завела служебную строку с закреплёнными id, кодом и названием', async () => {
    const res = await ctx.db.execute<{ id: string; code: string; name: string; active: boolean }>(
      sql`SELECT id, code, name, is_active AS active FROM waste_types WHERE code = 'snow'`,
    );
    expect(res.rows).toEqual([
      {
        id: SNOW_WASTE_TYPE_ID,
        code: SNOW_WASTE_TYPE_CODE,
        name: SNOW_WASTE_TYPE_NAME,
        active: true,
      },
    ]);
  });

  // ── 1. Lists ──

  it('список типов не отдаёт служебный тип ни прайсу, ни выбору в заявке', async () => {
    const own = await ordinaryType();
    // The tariff editor and the registry filter read the whole directory; the garbage request
    // picker reads active types with an active tariff. Neither may offer «Снег».
    const all = await listTypes('');
    expect(all.map((t) => t.id)).toContain(own.id);
    expect(all.find((t) => t.id === SNOW_WASTE_TYPE_ID || t.code === 'snow')).toBeUndefined();

    const active = await listTypes('isActive=true');
    expect(active.find((t) => t.id === SNOW_WASTE_TYPE_ID)).toBeUndefined();

    const searched = await listTypes(`search=${encodeURIComponent('снег')}`);
    expect(searched.find((t) => t.id === SNOW_WASTE_TYPE_ID)).toBeUndefined();

    const withoutTariff = await listTypes('hasActiveTariff=false');
    expect(withoutTariff.find((t) => t.id === SNOW_WASTE_TYPE_ID)).toBeUndefined();
    expect(withoutTariff.map((t) => t.id)).toContain(own.id);
  });
});
