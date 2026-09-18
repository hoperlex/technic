import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceIdentityApplyResultDto, DeviceIdentityDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * РЕЕСТР КЛЮЧЕЙ ОПОЗНАНИЯ — маршруты `/device-mail/identities` (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §5.1 и §6.1).
 *
 * ЗАЧЕМ БАЗА. Предмет проверки — ЧАСТИЧНЫЙ уникальный индекс, транзакция применения и резолв: всё
 * три живут в PostgreSQL и на моках сошлись бы моками. Частичность здесь несущая: снятый ключ
 * обязан освобождать значение, иначе снятие ничем не отличается от вечного запрета.
 *
 * Что доказывается, и почему каждое отдельно:
 *
 * - **ключ заводится БЕЗ письма и подбирает накопленное**: ради этого реестр и появился — парк в
 *   три сотни карточек нельзя разбирать по одному письму;
 * - **опознающий ключ применяет пачку, неопознающий — ничего**: у ключа, заведённого из карточки,
 *   нажатой строки нет вовсе, и «ничего» здесь законный исход, а не отказ;
 * - **чужой ключ отклоняется словами**: один живой ключ ведёт к одному аппарату, и ответом обязан
 *   быть `422` с объяснением, а не ошибка целостности пятисоткой;
 * - **снятие освобождает значение**: после снятия тот же ключ вправе завести другой аппарат;
 * - **снятая привязка не опознаёт**: резолв читает только живые, и это проверяется им самим, а не
 *   пересказом условия в тесте;
 * - **снятие требует причины и не повторяется**: «сняли ещё раз» означает, что человек видит не то
 *   состояние, которое есть;
 * - **право**: без `officeEquipment.telemetry` закрыты и чтение реестра, и все действия.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ: файл считает множества строк по всему реестру, а по общей базе идут
 * параллельные прогоны.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm check:db device-mail-identity-registry
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_device_mail_registry_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-device-registry-password-123';

/** Адрес реестра внутри приложения — тот же, каким он зарегистрирован в `app.ts`. */
const PREFIX = '/api/v1/device-mail';
const IDENTITIES = `${PREFIX}/identities`;
const ACCOUNT = `registry-${RUN}@example.invalid`;

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
  unitId: string;
  otherUnitId: string;
}

let ctx: Ctx;

/** Конфиг читается при импорте, поэтому окружение выставляется до первого `import('../src/...')`. */
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

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET' | 'POST', url: string, auth: Auth, payload?: unknown) {
  return ctx.app.inject({ method, url, headers: auth, payload, remoteAddress: nextAddress() });
}

let uid = 0;

/** Снимок разбора — ровно той формы, какую применяет слой привязки. */
function snapshot(serial: string | null, value: string): unknown {
  return {
    profileCode: 'ricoh',
    parserVersion: 1,
    observations: [
      {
        metricCode: 'printed_impressions_total',
        component: '',
        value,
        unit: 'impressions',
        deviceTime: null,
        rawLabel: 'Total Counter',
      },
    ],
    events: [],
    identity: {
      serial,
      inventory: null,
      deviceName: null,
      host: null,
      ip: '10.10.0.7',
      model: 'Ricoh Aficio MP C2011SP',
    },
  };
}

async function message(serial: string | null, value: string): Promise<string> {
  uid += 1;
  const row = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO device_mail_messages (account, uid_validity, uid, status, raw_state, s3_object_key,
                                      from_address, subject, received_at, profile_code,
                                      parser_version, parsed_payload, observation_count, event_count)
    VALUES (${ACCOUNT}, 1, ${uid}, 'unmatched'::device_message_status, 'stored'::device_raw_state,
            ${`device-mail/2026/09/${randomUUID()}.eml`},
            ${`mfp-${RUN}@example.invalid`}, 'Counter Information', now() - interval '20 minutes',
            'ricoh', 1, ${JSON.stringify(snapshot(serial, value))}::jsonb, 1, 0)
    RETURNING id`);
  return row.rows[0]!.id;
}

async function countObservations(equipmentId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM device_observations WHERE equipment_id = ${equipmentId}`);
  return rows.rows[0]!.n;
}

async function registry(user: TestUser, query = ''): Promise<DeviceIdentityDto[]> {
  const res = await inject('GET', `${IDENTITIES}${query}`, user.auth);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: DeviceIdentityDto[] }).items;
}

describe.skipIf(!DB_URL)('реестр ключей опознания (живая схема)', () => {
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
      VALUES (${`DR-${RUN}`}, ${`Площадка ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    async function makeUser(tag: string): Promise<{ id: string; email: string }> {
      const email = `db-dri-${tag}-${RUN}@example.invalid`;
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
      VALUES (${`dri_telemetry_${RUN}`}, ${`Разбор писем ${RUN}`}, false)
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

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');

    let unitNo = 0;
    async function makeEquipment(tag: string): Promise<string> {
      unitNo += 1;
      const row = await db.execute<{ id: string }>(sql`
        INSERT INTO office_equipment (equipment_type_id, name, inventory_number, object_id, location)
        VALUES (${typeId}, ${`Ricoh Aficio ${tag} ${RUN}`}, ${`ДР-${RUN}-${unitNo}`},
                ${objectId}, 'кабинет 214')
        RETURNING id`);
      return row.rows[0]!.id;
    }

    await db.execute(sql`
      INSERT INTO device_mail_accounts (account, uid_validity, last_uid, last_poll_at,
                                        stuck_attempts, last_error)
      VALUES (${ACCOUNT}, 1, 10, now(), 0, '')`);

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
      unitId: await makeEquipment('main'),
      otherUnitId: await makeEquipment('other'),
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
    await ctx.db.execute(sql`DELETE FROM device_observations`);
    await ctx.db.execute(sql`DELETE FROM device_events`);
    await ctx.db.execute(sql`DELETE FROM device_mail_identities`);
    await ctx.db.execute(sql`DELETE FROM device_mail_messages`);
  }

  it('ключ, заведённый из карточки без письма, подбирает накопленную пачку', async () => {
    await clear();
    const serial = `SN-${RUN}-ПАЧКА`;
    await message(serial, '100');
    await message(serial, '200');
    // Чужое письмо: пачка обязана взять только свои.
    await message(`SN-${RUN}-ЧУЖОЙ`, '300');

    const res = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'serial',
      value: serial.toLowerCase(),
      note: 'по табличке на корпусе',
    });
    expect(res.statusCode, res.body).toBe(201);
    const outcome = res.json() as DeviceIdentityApplyResultDto;
    expect(outcome.appliedMessages).toBe(2);
    // Значение нормализуется тем же способом, что и резолв: человек ввёл строчными.
    expect(outcome.value).toBe(serial.toUpperCase());
    expect(await countObservations(ctx.unitId)).toBe(2);
  });

  it('ключ неопознающего рода заводится, но сам по себе не применяет ничего', async () => {
    await clear();
    await message(`SN-${RUN}-ХОСТ`, '100');

    const res = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'host',
      value: `mfp-${RUN}.office.local`,
    });
    expect(res.statusCode, res.body).toBe(201);
    const outcome = res.json() as DeviceIdentityApplyResultDto;
    // Нажатой строки нет вовсе, пачки у сетевого имени не бывает: «ничего» — законный исход.
    expect(outcome.appliedMessages).toBe(0);
    expect(await countObservations(ctx.unitId)).toBe(0);

    // Но резолв его видит: следующее письмо с этим узлом опознается само.
    const { resolveDeviceIdentity } = await import('../src/services/device-mail/identity');
    const { deviceIdentityHintsSchema } = await import('@technic/contracts');
    const resolution = await resolveDeviceIdentity(ctx.db, {
      hints: deviceIdentityHintsSchema.parse({ host: `MFP-${RUN}.OFFICE.LOCAL` }),
    });
    expect(resolution.status).toBe('matched');
    expect(resolution.status === 'matched' && resolution.equipmentId).toBe(ctx.unitId);
  });

  it('ключ, уже ведущий к другому аппарату, отклоняется словами', async () => {
    await clear();
    const value = `SN-${RUN}-СПОР`;
    const first = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'serial',
      value,
    });
    expect(first.statusCode, first.body).toBe(201);

    const second = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.otherUnitId,
      kind: 'serial',
      value,
    });
    expect(second.statusCode, second.body).toBe(422);
    expect(second.body).toContain('другому аппарату');
  });

  it('снятие освобождает значение, и снятая привязка больше не опознаёт', async () => {
    await clear();
    const value = `SN-${RUN}-СНЯТИЕ`;
    const created = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'serial',
      value,
    });
    expect(created.statusCode, created.body).toBe(201);
    const [row] = await registry(ctx.reviewer);
    expect(row!.value).toBe(value.toUpperCase());

    const revoked = await inject('POST', `${IDENTITIES}/${row!.id}/revoke`, ctx.reviewer.auth, {
      note: 'аппарат списан',
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    // Резолв спрашивается сам: пересказ условия в тесте доказывал бы тест, а не резолв. Серийника
    // с таким значением в карточках нет, поэтому единственный путь к аппарату был снят.
    const { resolveDeviceIdentity } = await import('../src/services/device-mail/identity');
    const { deviceIdentityHintsSchema } = await import('@technic/contracts');
    const resolution = await resolveDeviceIdentity(ctx.db, {
      hints: deviceIdentityHintsSchema.parse({ serial: value }),
    });
    expect(resolution.status).toBe('unmatched');

    // И значение свободно: тот же ключ вправе завести другой аппарат.
    const again = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.otherUnitId,
      kind: 'serial',
      value,
    });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('снятие требует причины, а повтор снятия отклоняется', async () => {
    await clear();
    const created = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'serial',
      value: `SN-${RUN}-ПОВТОР`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const [row] = await registry(ctx.reviewer);

    const empty = await inject('POST', `${IDENTITIES}/${row!.id}/revoke`, ctx.reviewer.auth, {
      note: '',
    });
    expect(empty.statusCode, empty.body).toBe(400);

    const ok = await inject('POST', `${IDENTITIES}/${row!.id}/revoke`, ctx.reviewer.auth, {
      note: 'ошиблись карточкой',
    });
    expect(ok.statusCode, ok.body).toBe(200);

    const twice = await inject('POST', `${IDENTITIES}/${row!.id}/revoke`, ctx.reviewer.auth, {
      note: 'ещё раз',
    });
    expect(twice.statusCode, twice.body).toBe(422);
  });

  it('снятые строки скрыты, но показываются по просьбе — вместе с причиной', async () => {
    await clear();
    const created = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'deviceName',
      value: `ИНВ-${RUN}`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const [row] = await registry(ctx.reviewer);
    await inject('POST', `${IDENTITIES}/${row!.id}/revoke`, ctx.reviewer.auth, {
      note: 'переехал в другой кабинет',
    });

    expect(await registry(ctx.reviewer)).toHaveLength(0);
    const withRevoked = await registry(ctx.reviewer, '?includeRevoked=true');
    expect(withRevoked).toHaveLength(1);
    expect(withRevoked[0]!.revokeNote).toBe('переехал в другой кабинет');
    expect(withRevoked[0]!.revokedByName).not.toBe('');
    // Строка по-прежнему называет аппарат: она объясняет прошлое, а не просто помечена снятой.
    expect(withRevoked[0]!.equipmentTitle).toContain(`ДР-${RUN}`);
  });

  it('снятая привязка ничего не применяет, и ручка говорит об этом словами', async () => {
    await clear();
    const created = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'serial',
      value: `SN-${RUN}-ПРИМЕНЕНИЕ`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const [row] = await registry(ctx.reviewer);
    await inject('POST', `${IDENTITIES}/${row!.id}/revoke`, ctx.reviewer.auth, { note: 'снято' });

    const applied = await inject('POST', `${IDENTITIES}/${row!.id}/apply`, ctx.reviewer.auth);
    expect(applied.statusCode, applied.body).toBe(422);
  });

  it('применение живого ключа подбирает письма, пришедшие позже', async () => {
    await clear();
    const serial = `SN-${RUN}-ПОЗЖЕ`;
    const created = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'serial',
      value: serial,
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((created.json() as DeviceIdentityApplyResultDto).appliedMessages).toBe(0);

    // Письмо приехало ПОСЛЕ заведения ключа и осталось непривязанным (например, приём шёл, пока
    // резолв ещё не знал ключа): кнопка «применить» — второй заход тем же отбором.
    await message(serial, '777');
    const [row] = await registry(ctx.reviewer);
    const applied = await inject('POST', `${IDENTITIES}/${row!.id}/apply`, ctx.reviewer.auth);
    expect(applied.statusCode, applied.body).toBe(200);
    expect((applied.json() as DeviceIdentityApplyResultDto).appliedMessages).toBe(1);
    expect(await countObservations(ctx.unitId)).toBe(1);
  });

  it('число затронутых писем считает сервер тем же отбором, что и применение', async () => {
    await clear();
    const serial = `SN-${RUN}-СЧЁТ`;
    await message(serial, '100');
    await message(serial, '200');

    const counted = await inject(
      'GET',
      `${IDENTITIES}/targets?kind=serial&value=${encodeURIComponent(serial)}`,
      ctx.reviewer.auth,
    );
    expect(counted.statusCode, counted.body).toBe(200);
    expect(counted.json()).toEqual({ messages: 2, batch: true });

    const created = await inject('POST', IDENTITIES, ctx.reviewer.auth, {
      equipmentId: ctx.unitId,
      kind: 'serial',
      value: serial,
    });
    expect((created.json() as DeviceIdentityApplyResultDto).appliedMessages).toBe(2);
  });

  it('без права `officeEquipment.telemetry` закрыты и чтение реестра, и действия', async () => {
    await clear();
    const read = await inject('GET', IDENTITIES, ctx.outsider.auth);
    expect(read.statusCode).toBe(403);
    const write = await inject('POST', IDENTITIES, ctx.outsider.auth, {
      equipmentId: ctx.unitId,
      kind: 'serial',
      value: `SN-${RUN}-ЧУЖОЙ-ПРАВА`,
    });
    expect(write.statusCode).toBe(403);
  });

  it('чужая ссылка «показать ещё» получает отказ словами, а не пятисотку', async () => {
    await clear();
    const res = await inject(
      'GET',
      `${IDENTITIES}?cursor=1~device-events~мусор~x`,
      ctx.reviewer.auth,
    );
    expect(res.statusCode, res.body).toBe(422);
  });
});
