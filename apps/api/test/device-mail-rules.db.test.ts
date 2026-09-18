import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceParseRuleDto, DeviceParseRulePreviewDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * РУЧКИ ПРАВИЛ РАЗБОРА — `/device-mail/rules` (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §6.2).
 *
 * ЗАЧЕМ БАЗА. Предмет — ограничения таблицы и то, чем правило отвечает человеку: форма цели
 * («у ключа нет метрики»), уникальность правила и отказ словами вместо ошибки целостности. Всё
 * три живут в PostgreSQL.
 *
 * Что доказывается:
 *
 * - **правило заводится и читается** со следом автора;
 * - **дубль отклоняется словами**: два одинаковых правила — два ответа на один вопрос;
 * - **форма цели держится базой**: правило показания без разреза или ключа с метрикой не заводится;
 * - **опасное выражение не сохраняется вовсе**: барьер стоит до записи, а не при разборе письма —
 *   иначе оно легло бы в базу и роняло каждое письмо;
 * - **проверка на письме ничего не пишет** и объясняет исход словами — в том числе когда сырья
 *   нет;
 * - **право**: без `officeEquipment.telemetry` закрыты и чтение, и правки.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm check:db device-mail-rules
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_device_mail_rules_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-device-rules-password-123';
const PREFIX = '/api/v1/device-mail';
const RULES = `${PREFIX}/rules`;
const ACCOUNT = `rules-${RUN}@example.invalid`;

interface Auth {
  authorization: string;
}
interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}
interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  reviewer: TestUser;
  outsider: TestUser;
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
  process.env.MAIL_ENABLED ??= 'false';
}

let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: auth, payload, remoteAddress: nextAddress() });
}

const identityRule = (over: Record<string, unknown> = {}) => ({
  target: 'identity',
  keyKind: 'serial',
  matchKind: 'label',
  expression: 'machine id',
  scope: 'any',
  whenProfile: null,
  whenFrom: '',
  whenSubject: '',
  sortOrder: 100,
  isEnabled: true,
  ...over,
});

const metricRule = (over: Record<string, unknown> = {}) => ({
  target: 'metric',
  metricCode: 'printed_sheets_total',
  component: '',
  valueForm: 'number',
  matchKind: 'label',
  expression: 'pages printed',
  scope: 'any',
  whenProfile: null,
  whenFrom: '',
  whenSubject: '',
  sortOrder: 100,
  isEnabled: true,
  ...over,
});

async function listRules(user: TestUser): Promise<DeviceParseRuleDto[]> {
  const res = await inject('GET', RULES, user.auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: DeviceParseRuleDto[] }).items;
}

describe.skipIf(!DB_URL)('правила разбора писем (живая схема)', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
    const client = new pg.Client({ connectionString: OWN_DB });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query('CREATE EXTENSION IF NOT EXISTS citext');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyMigrations(client);
    } finally {
      await client.end();
    }

    prepareEnv(OWN_DB!);
    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`RL-${RUN}`}, ${`Площадка ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(tag: string): Promise<{ id: string; email: string }> {
      const email = `db-drl-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash}, 'shtab'::role,
                true, now())
        RETURNING id`);
      const id = res.rows[0]!.id;
      await db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${id}, ${objectId})`);
      return { id, email };
    }

    const reviewerUser = await makeUser('reviewer');
    const outsiderUser = await makeUser('outsider');

    const grant = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, is_system)
      VALUES (${`drl_telemetry_${RUN}`}, ${`Разбор писем ${RUN}`}, false)
      RETURNING id`);
    const grantId = grant.rows[0]!.id;
    await db.execute(
      sql`INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, 'shtab'::role)`,
    );
    await db.execute(sql`
      INSERT INTO grant_permissions (grant_id, permission)
      VALUES (${grantId}, 'officeEquipment.read'), (${grantId}, 'officeEquipment.telemetry')`);
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
      VALUES (${reviewerUser.id}, ${grantId}, ${reviewerUser.id}, 'manual')`);

    await db.execute(sql`
      INSERT INTO device_mail_accounts (account, uid_validity, last_uid, last_poll_at,
                                        stuck_attempts, last_error)
      VALUES (${ACCOUNT}, 1, 1, now(), 0, '')`);

    const { buildApp: build } = await import('../src/app');
    const app = await build();
    await app.ready();

    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }
    const withAuth = async (u: { id: string; email: string }): Promise<TestUser> => ({
      ...u,
      auth: await login(u.email),
    });

    ctx = {
      app,
      db,
      closeDb,
      reviewer: await withAuth(reviewerUser),
      outsider: await withAuth(outsiderUser),
    };
  }, 300_000);

  afterAll(async () => {
    if (!ctx?.app) return;
    await ctx.app.close();
    await ctx.closeDb();
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
    } finally {
      await admin.end();
    }
  }, 120_000);

  async function clear(): Promise<void> {
    await ctx.db.execute(sql`DELETE FROM device_mail_parse_rules`);
    await ctx.db.execute(sql`DELETE FROM device_mail_messages`);
  }

  it('правило заводится и читается со следом автора', async () => {
    await clear();
    const res = await inject('POST', RULES, ctx.reviewer.auth, identityRule());
    expect(res.statusCode, res.body).toBe(201);

    const [rule] = await listRules(ctx.reviewer);
    expect(rule).toMatchObject({
      target: 'identity',
      keyKind: 'serial',
      expression: 'machine id',
      isEnabled: true,
    });
    expect(rule!.updatedByName).not.toBe('');
    // Ни одного письма не разбирали — правило ещё можно удалить совсем.
    expect(rule!.canDelete).toBe(true);
  });

  it('дубль правила отклоняется словами, а не ошибкой целостности', async () => {
    await clear();
    expect((await inject('POST', RULES, ctx.reviewer.auth, identityRule())).statusCode).toBe(201);
    const again = await inject('POST', RULES, ctx.reviewer.auth, identityRule());
    expect(again.statusCode, again.body).toBe(422);
    expect(again.body).toContain('уже заведено');
  });

  it('форма цели держится базой: у правила показания нет рода ключа', async () => {
    await clear();
    // Схема контракта различает цели, поэтому «ключ с метрикой» не проходит уже разбор тела: это
    // и есть обещание формы — заполнить оба поля нельзя ни через форму, ни запросом.
    const res = await inject('POST', RULES, ctx.reviewer.auth, {
      ...identityRule(),
      metricCode: 'printed_sheets_total',
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('правило показания заводится с разрезом и формой числа', async () => {
    await clear();
    const res = await inject(
      'POST',
      RULES,
      ctx.reviewer.auth,
      metricRule({ metricCode: 'supply_level_percent', component: 'black', valueForm: 'percent' }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const [rule] = await listRules(ctx.reviewer);
    expect(rule).toMatchObject({ target: 'metric', component: 'black', valueForm: 'percent' });
    // Единицы у правила нет ни одной колонкой: она свойство метрики.
    expect(rule).not.toHaveProperty('unit');
  });

  it('опасное выражение не сохраняется вовсе', async () => {
    await clear();
    const res = await inject(
      'POST',
      RULES,
      ctx.reviewer.auth,
      identityRule({ matchKind: 'regex', expression: '(a+)+$' }),
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(await listRules(ctx.reviewer)).toHaveLength(0);
  });

  it('нечитаемое выражение отклоняется до записи', async () => {
    await clear();
    const res = await inject(
      'POST',
      RULES,
      ctx.reviewer.auth,
      identityRule({ matchKind: 'regex', expression: '([' }),
    );
    expect(res.statusCode, res.body).toBe(422);
    expect(await listRules(ctx.reviewer)).toHaveLength(0);
  });

  it('правило выключается правкой и остаётся видимым', async () => {
    await clear();
    const created = await inject('POST', RULES, ctx.reviewer.auth, identityRule());
    const id = (created.json() as DeviceParseRuleDto).id;
    const patched = await inject(
      'PATCH',
      `${RULES}/${id}`,
      ctx.reviewer.auth,
      identityRule({ isEnabled: false }),
    );
    expect(patched.statusCode, patched.body).toBe(200);
    const [rule] = await listRules(ctx.reviewer);
    expect(rule!.isEnabled).toBe(false);
  });

  it('проверка на письме без сырья объясняет отказ словами', async () => {
    await clear();
    const row = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO device_mail_messages (account, uid_validity, uid, status, raw_state,
                                        from_address, subject, received_at)
      VALUES (${ACCOUNT}, 1, 1, 'unrecognized'::device_message_status, 'absent'::device_raw_state,
              'mfp@example.invalid', 'Report', now())
      RETURNING id`);
    const res = await inject('POST', `${RULES}/preview`, ctx.reviewer.auth, {
      messageId: row.rows[0]!.id,
      rule: identityRule(),
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('сырь');
  });

  it('проверка на несуществующем письме — 404, а не пятисотка', async () => {
    await clear();
    const res = await inject('POST', `${RULES}/preview`, ctx.reviewer.auth, {
      messageId: randomUUID(),
      rule: identityRule(),
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  it('удалить можно только правило, при жизни которого писем не разбирали', async () => {
    await clear();
    const created = await inject('POST', RULES, ctx.reviewer.auth, identityRule());
    const id = (created.json() as DeviceParseRuleDto).id;

    // Письмо, разобранное ПОСЛЕ появления правила: теперь правило объясняет прошлое.
    await ctx.db.execute(sql`
      INSERT INTO device_mail_messages (account, uid_validity, uid, status, raw_state,
                                        from_address, subject, received_at, rules_revision)
      VALUES (${ACCOUNT}, 1, 77, 'unmatched'::device_message_status, 'absent'::device_raw_state,
              'mfp@example.invalid', 'Report', now(), now())`);

    const res = await inject('DELETE', `${RULES}/${id}`, ctx.reviewer.auth);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('выключить');
    const [rule] = await listRules(ctx.reviewer);
    expect(rule!.canDelete).toBe(false);
  });

  it('без права `officeEquipment.telemetry` закрыты и чтение, и правки', async () => {
    await clear();
    expect((await inject('GET', RULES, ctx.outsider.auth)).statusCode).toBe(403);
    expect((await inject('POST', RULES, ctx.outsider.auth, identityRule())).statusCode).toBe(403);
  });
});

/** Ответ проверки на письме описан контрактом; здесь он только для читаемости утверждений. */
export type { DeviceParseRulePreviewDto };
