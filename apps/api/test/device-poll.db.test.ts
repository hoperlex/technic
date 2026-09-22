import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DevicePollTargetDto, DevicePollTargetsDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { healthyReply, octet, silentPort, startFakeDevice, type FakeDevice } from './fake-snmp-device';

/**
 * РУЧКИ ОПРОСА ПО СЕТИ — `/device-poll/targets` (решение
 * `docs/adr/0205-device-network-poll.md`).
 *
 * ЗАЧЕМ БАЗА. Предмет — правила ЗАПИСИ: что попадает в журнал попыток, что в ряд наработки и что не
 * попадает никуда. Все три живут в PostgreSQL, и проверить их разбором ответа нельзя.
 *
 * ЗАЧЕМ ФАЛЬШИВЫЙ АППАРАТ. Живого принтера у прогона нет: он за NAT офисной сети. Агент на
 * localhost отвечает теми же байтами, что настоящий, и это единственный способ пройти весь путь
 * «нажали → опросили → записали» до первого ручного прогона.
 *
 * Что доказывается:
 *
 * - **снятое показание ложится в ряд наработки** источником `collector` и ссылкой на попытку;
 * - **попытка пишется любым исходом** — молчание сети тоже факт, и журнал его хранит;
 * - **повторный опрос не дубль**: две попытки — два наблюдения, уникальный ключ им не мешает;
 * - **без карточки показание не пишется**: ряд принадлежит аппарату, а не адресу, и исход об этом
 *   говорит прямо (`no_equipment`), не пряча снятое число;
 * - **чужой серийник не пишется никуда**, хотя ответ получен;
 * - **цель, которой нет в настройке**, отвечает 404, а не молчанием;
 * - **право**: без `officeEquipment.telemetry` закрыты и список, и опрос.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm check:db device-poll
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_device_poll_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-device-poll-password-123';
const PREFIX = '/api/v1/device-poll/targets';
const SERIAL = `Y505P4${RUN.slice(0, 5).toUpperCase()}`;
/** Серийник, которого в справочнике нет ни у одной карточки: аппарат есть, карточки нет. */
const UNKNOWN_SERIAL = `Z900X9${RUN.slice(0, 5).toUpperCase()}`;

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
  operator: TestUser;
  outsider: TestUser;
  equipmentId: string;
  device: FakeDevice;
  stranger: FakeDevice;
}

let ctx: Ctx;

function prepareEnv(databaseUrl: string, targets: string): void {
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
  // Реестр целей читается маршрутом при сборке приложения, поэтому задаётся ДО импорта `app`.
  process.env.DEVICE_POLL_TARGETS = targets;
  // Срок ожидания короче боевого: молчащая цель здесь проверяется трижды, и три секунды на каждую
  // превратили бы прогон в минуту ожидания ни о чём.
  process.env.DEVICE_POLL_TIMEOUT_MS = '400';
}

let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function inject(method: 'GET' | 'POST', url: string, auth: Auth) {
  return ctx.app.inject({ method, url, headers: auth, remoteAddress: nextAddress() });
}

async function poll(key: string, user: TestUser): Promise<DevicePollTargetDto> {
  const res = await inject('POST', `${PREFIX}/${key}/poll`, user.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as DevicePollTargetDto;
}

async function observations(): Promise<
  { metricCode: string; value: string; unit: string; source: string; sourceRef: string }[]
> {
  const rows = await ctx.db.execute<{
    metric_code: string;
    value: string;
    unit: string;
    source: string;
    source_ref: string;
  }>(sql`
    SELECT metric_code, value, unit, source, source_ref
      FROM device_observations
     WHERE equipment_id = ${ctx.equipmentId}
     ORDER BY observed_at`);
  return rows.rows.map((row) => ({
    metricCode: row.metric_code,
    value: row.value,
    unit: row.unit,
    source: row.source,
    sourceRef: row.source_ref,
  }));
}

async function attempts(targetKey: string): Promise<
  { outcome: string; value: string | null; equipmentId: string | null; requestedBy: string | null }[]
> {
  const rows = await ctx.db.execute<{
    outcome: string;
    value: string | null;
    equipment_id: string | null;
    requested_by: string | null;
  }>(sql`
    SELECT outcome, value, equipment_id, requested_by
      FROM device_poll_attempts
     WHERE target_key = ${targetKey}
     ORDER BY started_at`);
  return rows.rows.map((row) => ({
    outcome: row.outcome,
    value: row.value,
    equipmentId: row.equipment_id,
    requestedBy: row.requested_by,
  }));
}

describe.skipIf(!DB_URL)('опрос аппаратов по сети (живая схема)', () => {
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

    // Аппарат поднимается ДО приложения: его порт уезжает в реестр целей, а реестр читается на
    // старте маршрута.
    const device = await startFakeDevice(healthyReply({ serial: octet(SERIAL) }));
    /*
     * Второй аппарат — исправный и честный, но его серийника в справочнике нет. Разные аппараты
     * здесь принципиальны: поставь обе цели на один, и «карточки нет» превратилось бы в «отвечает
     * другой аппарат» — сверка сработала бы раньше поиска карточки, и проверялся бы не тот исход.
     */
    const stranger = await startFakeDevice(healthyReply({ serial: octet(UNKNOWN_SERIAL) }));
    const dead = await silentPort();
    prepareEnv(
      OWN_DB!,
      [
        `ricoh|RICOH, приёмная|127.0.0.1:${device.port}|public|${SERIAL}`,
        `stranger|Аппарат без карточки|127.0.0.1:${stranger.port}|public|${UNKNOWN_SERIAL}`,
        `silent|Выключенный аппарат|127.0.0.1:${dead}|public|${SERIAL}`,
      ].join(';'),
    );

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const passwordHash = await hashPassword(PASSWORD);

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`DP-${RUN}`}, ${`Площадка опроса ${RUN}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    const objectId = objectRow.rows[0]!.id;

    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    if (!typeRow.rows[0]) throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');

    /** Карточка заводится SQL: её форма — предмет своих тестов, здесь она декорация. */
    const equipmentRow = await db.execute<{ id: string }>(sql`
      INSERT INTO office_equipment (equipment_type_id, name, serial_number, inventory_number,
                                    object_id, location)
      VALUES (${typeRow.rows[0].id}, ${`Ricoh MP C2011SP ${RUN}`}, ${SERIAL},
              ${`ИНВ-DP-${RUN}`}, ${objectId}, 'приёмная')
      RETURNING id`);

    async function makeUser(tag: string): Promise<{ id: string; email: string }> {
      const email = `db-dp-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Оператор', ${tag}, ${passwordHash}, 'shtab'::role,
                true, now())
        RETURNING id`);
      const id = res.rows[0]!.id;
      await db.execute(sql`
        INSERT INTO user_construction_objects (user_id, construction_object_id)
        VALUES (${id}, ${objectId})`);
      return { id, email };
    }

    const operatorUser = await makeUser('operator');
    const outsiderUser = await makeUser('outsider');

    const grant = await db.execute<{ id: string }>(sql`
      INSERT INTO grants (code, name, is_system)
      VALUES (${`dp_telemetry_${RUN}`}, ${`Опрос аппаратов ${RUN}`}, false)
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
      VALUES (${operatorUser.id}, ${grantId}, ${operatorUser.id}, 'manual')`);

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
      operator: await withAuth(operatorUser),
      outsider: await withAuth(outsiderUser),
      equipmentId: equipmentRow.rows[0]!.id,
      device,
      stranger,
    };
  }, 300_000);

  afterAll(async () => {
    if (!ctx?.app) return;
    await ctx.device.close();
    await ctx.stranger.close();
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

  it('показывает настроенные цели и находит карточку по серийному номеру', async () => {
    const res = await inject('GET', PREFIX, ctx.operator.auth);
    expect(res.statusCode, res.body).toBe(200);
    const { items } = res.json() as DevicePollTargetsDto;

    expect(items.map((item) => item.key)).toEqual(['ricoh', 'stranger', 'silent']);
    const ricoh = items[0]!;
    expect(ricoh.equipment?.id).toBe(ctx.equipmentId);
    expect(ricoh.address).toBe(`127.0.0.1:${ctx.device.port}`);
    // Community в ответе нет ни под каким именем: это пароль чтения.
    expect(JSON.stringify(ricoh)).not.toContain('public');
  });

  it('снимает счётчик и кладёт его в ряд наработки', async () => {
    const target = await poll('ricoh', ctx.operator);

    expect(target.lastAttempt?.outcome).toBe('ok');
    expect(target.lastAttempt?.value).toBe(97_011);
    expect(target.lastAttempt?.metricCode).toBe('marker_life_total');
    expect(target.lastAttempt?.requestedBy).toContain('Тестовый');

    const rows = await observations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      metricCode: 'marker_life_total',
      unit: 'impressions',
      source: 'collector',
    });
    expect(Number(rows[0]!.value)).toBe(97_011);
    // Ссылка на попытку — та самая, которую вернула ручка: по ней показание и объясняется.
    expect(rows[0]!.sourceRef).toBe(target.lastAttempt?.id);
  });

  /**
   * Повторное нажатие — вторая попытка и второе наблюдение. Уникальный ключ наблюдений считает
   * `source_ref`, и попытки у них разные: склеивать два опроса в один было бы неверно (между ними
   * аппарат мог напечатать).
   */
  it('второй опрос пишет вторую попытку, а не спорит с первой', async () => {
    await poll('ricoh', ctx.operator);

    expect(await attempts('ricoh')).toHaveLength(2);
    expect(await observations()).toHaveLength(2);
  });

  it('снимает число, но не пишет его, когда карточки нет', async () => {
    const target = await poll('stranger', ctx.operator);

    expect(target.lastAttempt?.outcome).toBe('no_equipment');
    // Аппарат назвался, и сверка прошла — исход не про сомнительный ответ, а про справочник.
    expect(target.lastAttempt?.deviceSerial).toBe(UNKNOWN_SERIAL);
    // Число человек видит — прятать снятое нечестно, — но в ряд наработки оно не попало.
    expect(target.lastAttempt?.value).toBe(97_011);
    expect(target.equipment).toBeNull();
    expect(await observations()).toHaveLength(2);

    const rows = await attempts('stranger');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'no_equipment', equipmentId: null });
  });

  it('пишет попытку и при молчании сети', async () => {
    const target = await poll('silent', ctx.operator);

    expect(target.lastAttempt?.outcome).toBe('no_answer');
    expect(target.lastAttempt?.value).toBeNull();
    expect(target.lastAttempt?.message).toContain('не ответил');

    const rows = await attempts('silent');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBeNull();
    // Наработке молчание ничего не добавило: в ряду те же две строки.
    expect(await observations()).toHaveLength(2);
  });

  it('цель, которой нет в настройке, отвечает 404', async () => {
    const res = await inject('POST', `${PREFIX}/neizvestnaya/poll`, ctx.operator.auth);
    expect(res.statusCode).toBe(404);
  });

  it('без права опрос закрыт целиком', async () => {
    const list = await inject('GET', PREFIX, ctx.outsider.auth);
    expect(list.statusCode).toBe(403);

    const run = await inject('POST', `${PREFIX}/ricoh/poll`, ctx.outsider.auth);
    expect(run.statusCode).toBe(403);

    // И ни одной новой попытки от чужого нажатия: отказ стоит до опроса, а не после.
    expect(await attempts('ricoh')).toHaveLength(2);
  });
});
