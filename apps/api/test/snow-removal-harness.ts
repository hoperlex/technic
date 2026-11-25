import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import type { InjectOptions, LightMyRequestResponse } from 'light-my-request';
import {
  SNOW_WASTE_TYPE_ID,
  WASTE_REQUEST_CAPABILITY_HEADER,
  WASTE_REQUEST_CAPABILITY_SNOW,
  type RequestStatus,
  type RequestType,
  type WasteRequestDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the modules read their environment at import, so values come through `await import`
// after `prepareEnv` has run.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Shared scene of the snow removal API db tests (snow-removal plan, §4 «Requests and permissions»,
 * «Close and review», «Rollout»). Not a test file: each `snow-removal-*.db.test.ts` builds its own
 * scene from here, on its OWN database with a random name, so parallel executors and the shared
 * check database never see each other's rows.
 *
 * Real PostgreSQL is the point: the guards under test are row locks, CHECK constraints, version
 * compares and scope predicates over real rows. Only the object storage is stubbed, by each test
 * file with `vi.mock('../src/lib/s3')`, because the ticket rule asks whether the completion route
 * saw the object — a storage answer, not a database one.
 */

export const REQUESTS = '/api/v1/waste-requests';
export const SNOW = {
  [WASTE_REQUEST_CAPABILITY_HEADER.toLowerCase()]: WASTE_REQUEST_CAPABILITY_SNOW,
};
export const PASSWORD = 'db-snow-removal-password-123';

export interface Auth {
  authorization: string;
}

export interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

export interface Scene {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  run: string;
  adminId: string;
  objectId: string;
  /** A second site in nobody's object scope: moving a request there takes it out of scope. */
  otherObjectId: string;
  /** Site bound to `operatorA` only. */
  operatorA: string;
  /** Another operator, also bound to the main site. */
  operatorB: string;
  users: Record<
    'admin' | 'dispatcher' | 'site' | 'reviewer' | 'opA' | 'opB' | 'opCreator',
    TestUser
  >;
  close: () => Promise<void>;
}

/** Inn with a valid check digit: the directory checks it on insert. */
function innOf(base9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(base9[i]), 0);
  return `${base9}${(sum % 11) % 10}`;
}

function prepareEnv(databaseUrl: string, extra: Record<string, string>): void {
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
  process.env.MAIL_ENABLED ??= 'false';
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
}

/** Own address per call: the global rate limiter counts requests per address (`app.ts`). */
let requestNo = 0;
export function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

let scene: Scene | null = null;

type ExtraUser = (input: {
  tag: string;
  role: string;
  counterpartyId?: string;
  objects?: string[];
  grant?: string[];
}) => Promise<TestUser>;
let extraUser: ExtraUser | null = null;

/** One more account for a single case: a role, an object scope and a free grant on top of it. */
export function addUser(input: Parameters<ExtraUser>[0]): Promise<TestUser> {
  if (!extraUser) throw new Error('scene is not built');
  return extraUser(input);
}

export function current(): Scene {
  if (!scene) throw new Error('scene is not built');
  return scene;
}

export function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
  headers: Record<string, string> = SNOW,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { ...auth, ...headers },
    remoteAddress: nextAddress(),
  };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return current().app.inject(options);
}

export async function buildScene(
  tag: string,
  opts: { env?: Record<string, string> } = {},
): Promise<Scene | null> {
  const server = process.env.TEST_DATABASE_URL;
  if (!server) return null;
  const run = randomUUID().replaceAll('-', '').slice(0, 10);
  const dbName = `technic_snow_${tag}_${run}`;
  const ownUrl = new URL(server);
  ownUrl.pathname = `/${dbName}`;
  const adminUrl = new URL(server);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  const client = new pg.Client({ connectionString: ownUrl.toString() });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query('CREATE EXTENSION IF NOT EXISTS citext');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await applyMigrations(client);
  } finally {
    await client.end();
  }

  prepareEnv(ownUrl.toString(), opts.env ?? {});
  const { db, closeDb } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const { buildApp } = await import('../src/app');
  const passwordHash = await hashPassword(PASSWORD);

  const object = async (code: string): Promise<string> => {
    const row = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`${code}-${run}`}, ${`Площадка ${code} ${run}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    return row.rows[0]!.id;
  };
  const objectId = await object('SN');
  const otherObjectId = await object('SX');

  const digits = String(Date.now()).slice(-6);
  let cpNo = 0;
  const counterparty = async (tag2: string, active = true): Promise<string> => {
    cpNo += 1;
    const row = await db.execute<{ id: string }>(sql`
      INSERT INTO counterparties (type, name, inn, is_active)
      VALUES ('operator'::counterparty_type, ${`Оператор ${tag2} ${run}`},
              ${innOf(`${70 + cpNo}${digits}0`.slice(0, 9))}, ${active})
      RETURNING id`);
    return row.rows[0]!.id;
  };
  const operatorA = await counterparty('A');
  const operatorB = await counterparty('B');
  for (const cp of [operatorA, operatorB]) {
    await db.execute(sql`
      INSERT INTO construction_object_operators (construction_object_id, counterparty_id)
      VALUES (${objectId}, ${cp})`);
  }

  const makeUser = async (input: {
    tag: string;
    role: string;
    counterpartyId?: string;
    objects?: string[];
  }): Promise<{ id: string; email: string }> => {
    const email = `db-snow-${input.tag}-${run}@example.invalid`;
    const res = await db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at, counterparty_id)
      VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
              ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
      RETURNING id`);
    const id = res.rows[0]!.id;
    for (const o of input.objects ?? []) {
      await db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${id}, ${o})`);
    }
    return { id, email };
  };
  const admin2 = await makeUser({ tag: 'admin', role: 'admin' });
  const grant = async (holder: { id: string }, role: string, permissions: string[]) => {
    const code = `snow_${randomUUID().slice(0, 8)}`;
    const row = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, is_system) VALUES (${code}, ${`Набор ${code}`}, false)
      RETURNING id`);
    const grantId = row.rows[0]!.id;
    await db.execute(sql`INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, ${role})`);
    for (const permission of permissions) {
      await db.execute(sql`
        INSERT INTO grant_permissions (grant_id, permission) VALUES (${grantId}, ${permission})`);
    }
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
      VALUES (${holder.id}, ${grantId}, ${admin2.id}, 'manual')`);
  };

  const dispatcher = await makeUser({ tag: 'disp', role: 'dispatcher' });
  const site = await makeUser({ tag: 'site', role: 'shtab', objects: [objectId] });
  // A reviewer who settles paper but does not drive the cycle: ticket review without the ordinary
  // status right (snow-removal plan, §3.2).
  const reviewer = await makeUser({ tag: 'rev', role: 'observer' });
  await grant(reviewer, 'observer', ['wasteRequests.ticketReview']);
  const opA = await makeUser({ tag: 'opa', role: 'operator', counterpartyId: operatorA });
  const opB = await makeUser({ tag: 'opb', role: 'operator', counterpartyId: operatorB });
  // A counterparty granted creation and assignment: may file only for its own operator.
  const opCreator = await makeUser({ tag: 'opc', role: 'operator', counterpartyId: operatorA });
  await grant(opCreator, 'operator', ['wasteRequests.create', 'wasteRequests.assignOperator']);

  const app = await buildApp();
  await app.ready();
  const login = async (u: { id: string; email: string }): Promise<TestUser> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: u.email, password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    if (res.statusCode !== 200) throw new Error(`login ${u.email}: ${res.body}`);
    return { ...u, auth: { authorization: `Bearer ${res.json().accessToken}` } };
  };

  extraUser = async (input) => {
    const u = await makeUser(input);
    if (input.grant) await grant(u, input.role, input.grant);
    return login(u);
  };

  scene = {
    app,
    db,
    run,
    adminId: admin2.id,
    objectId,
    otherObjectId,
    operatorA,
    operatorB,
    users: {
      admin: await login(admin2),
      dispatcher: await login(dispatcher),
      site: await login(site),
      reviewer: await login(reviewer),
      opA: await login(opA),
      opB: await login(opB),
      opCreator: await login(opCreator),
    },
    close: async () => {
      await app.close();
      await closeDb();
      const drop = new pg.Client({ connectionString: adminUrl.toString() });
      await drop.connect();
      try {
        await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await drop.end();
      }
    },
  };
  return scene;
}

/** A fresh operator counterparty, optionally inactive, bound to the given sites only. */
export async function newOperator(objects: string[], active = true): Promise<string> {
  const s = current();
  const row = await s.db.execute<{ id: string }>(sql`
    INSERT INTO counterparties (type, name, inn, is_active)
    VALUES ('operator'::counterparty_type, ${`Оператор ${randomUUID().slice(0, 6)}`},
            ${innOf(String(100_000_000 + Math.floor(Math.random() * 800_000_000)))}, ${active})
    RETURNING id`);
  const id = row.rows[0]!.id;
  for (const o of objects) {
    await s.db.execute(sql`
      INSERT INTO construction_object_operators (construction_object_id, counterparty_id)
      VALUES (${o}, ${id})`);
  }
  return id;
}

export async function newSite(): Promise<string> {
  const s = current();
  const row = await s.db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${`SS-${randomUUID().slice(0, 8)}`}, 'Площадка без своих операторов',
            'г Москва, ул Тестовая, д 2')
    RETURNING id`);
  return row.rows[0]!.id;
}

/**
 * A file row of `owner`. `verified` — the completion route saw the object in the storage; without
 * it the row is a promoted or pending upload that a ticket path must refuse.
 */
export async function newFile(
  owner: TestUser,
  opts: { status?: 'pending' | 'active'; verified?: boolean; name?: string } = {},
): Promise<{ id: string; objectKey: string }> {
  const s = current();
  const objectKey = `db-snow/${s.run}/${randomUUID()}`;
  const status = opts.status ?? 'active';
  const verified = opts.verified ?? status === 'active';
  const row = await s.db.execute<{ id: string }>(sql`
    INSERT INTO files (bucket, object_key, filename, content_type, size, status, uploaded_by,
                       storage_verified_at)
    VALUES ('test', ${objectKey}, ${opts.name ?? `талон-${randomUUID().slice(0, 6)}.pdf`},
            'application/pdf', 1024, ${sql.raw(`'${status}'::file_status`)}, ${owner.id},
            ${verified ? sql`now()` : null})
    RETURNING id`);
  return { id: row.rows[0]!.id, objectKey };
}

export function deliveryAt(daysAhead = 3): string {
  return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
}

export function snowBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectId: current().objectId,
    requestType: 'snow_removal',
    volumeM3: 8,
    deliveryAt: deliveryAt(),
    deliveryTimeUnspecified: true,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
    comment: `snow ${randomUUID().slice(0, 8)}`,
    ...extra,
  };
}

/** A request row in the given state, inserted directly: the cycle itself is not the subject. */
export async function insertRequest(
  opts: {
    type?: RequestType;
    status?: RequestStatus;
    operator?: string | null;
    objectId?: string;
    volume?: number;
    wasteTypeId?: string | null;
    deleted?: boolean;
  } = {},
): Promise<string> {
  const s = current();
  const type = opts.type ?? 'snow_removal';
  const wasteTypeId =
    opts.wasteTypeId !== undefined
      ? opts.wasteTypeId
      : type === 'snow_removal'
        ? SNOW_WASTE_TYPE_ID
        : null;
  const volume = opts.volume ?? (type === 'snow_removal' || type === 'waste_removal' ? 10 : null);
  const row = await s.db.execute<{ id: string }>(sql`
    INSERT INTO waste_requests (object_id, request_type, waste_type_id, volume_m3, delivery_at,
                                status, created_by, operator_counterparty_id,
                                responsible_name, responsible_phone, deleted_at, deleted_by)
    VALUES (${opts.objectId ?? s.objectId}, ${sql.raw(`'${type}'::request_type`)},
            ${wasteTypeId}, ${volume}, now(),
            ${sql.raw(`'${opts.status ?? 'new'}'::request_status`)}, ${s.adminId},
            ${opts.operator === undefined ? s.operatorA : opts.operator},
            'Иванов Иван Иванович', '+79990000000',
            ${opts.deleted ? sql`now()` : null}, ${opts.deleted ? s.adminId : null})
    RETURNING id`);
  const id = row.rows[0]!.id;
  await s.db.execute(sql`
    INSERT INTO request_status_history (request_id, from_status, to_status, changed_by)
    VALUES (${id}, NULL, 'new', ${s.adminId})`);
  return id;
}

/** A garbage waste type of the directory: the reserved «Снег» is never one of them. */
export async function garbageWasteType(): Promise<string> {
  const s = current();
  const code = `g${randomUUID().slice(0, 6)}`;
  const row = await s.db.execute<{ id: string }>(sql`
    INSERT INTO waste_types (code, name) VALUES (${code}, ${`Мусор ${code}`})
    RETURNING id`);
  return row.rows[0]!.id;
}

export async function card(id: string, auth: Auth): Promise<WasteRequestDto> {
  const res = await inject('GET', `${REQUESTS}/${id}`, auth);
  if (res.statusCode !== 200) throw new Error(`card ${id}: ${res.statusCode} ${res.body}`);
  return res.json() as WasteRequestDto;
}

export async function linkTicket(requestId: string, owner: TestUser): Promise<string> {
  const s = current();
  const file = await newFile(owner);
  await s.db.execute(sql`
    INSERT INTO request_files (request_id, file_id, kind)
    VALUES (${requestId}, ${file.id}, 'ticket')`);
  return file.id;
}

export async function scalar<T>(query: ReturnType<typeof sql>): Promise<T | undefined> {
  const res = await current().db.execute<{ v: T }>(query);
  return res.rows[0]?.v;
}
