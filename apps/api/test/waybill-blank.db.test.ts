import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Пустой путевой лист 4-П: рейс без заявок, с машиной, водителем и датой (ADR 0071).
 *
 * Проверяется на живой схеме и настоящим HTTP-путём, потому что ломается здесь не правило.
 * `canIssueWaybill` — чистая функция, и её случаи закрыты контрактными тестами; а вот выдача сама
 * по себе идёт по коду, который до этой ADR не знал рейса без заявок: снимок собирался по первому
 * талону, а талоны вставлялись одним `INSERT ... VALUES` — и на пустом списке этот запрос падает,
 * унося всю транзакцию. Снаружи это выглядело бы как «кнопка не работает»: номер бланка сгорел,
 * листа нет.
 *
 * Запуск — как у прочих db-тестов, база пустая или уже промигрированная:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_blank_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Тестовый водитель: СНИЛС из одинаковых цифр с верной контрольной суммой, серия «00 00». */
const DRIVER_SNILS = '11111111145';
const ADMIN_EMAIL = 'db-blank-admin@example.invalid';
/** Диспетчер: листы выписывает каждый день, а пустой бланк — не его право. */
const DISPATCHER_EMAIL = 'db-blank-dispatcher@example.invalid';
const PASSWORD = 'db-test-password-123';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: { authorization: string };
  dispatcher: { authorization: string };
  vehicleId: string;
  personId: string;
  routeDate: string;
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
  // S3 в этом сценарии не участвует, но конфиг обязателен — заглушки заведомо нерабочие.
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

/** Учётки и водитель: организация, парк, серии бланков и категории прав приходят миграциями. */
async function seed(): Promise<{ personId: string }> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  for (const [email, role] of [
    [ADMIN_EMAIL, 'admin'],
    [DISPATCHER_EMAIL, 'dispatcher'],
  ] as const) {
    const [user] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.email} = ${email}`);
    if (user) continue;
    await db.insert(schema.users).values({
      email,
      lastName: 'Тестовый',
      firstName: role === 'admin' ? 'Администратор' : 'Диспетчер',
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
    });
  }

  const [existing] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(sql`${schema.persons.snils} = ${DRIVER_SNILS}`);
  if (existing) return { personId: existing.id };

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  const [licenseType] = await db
    .select({ id: schema.credentialTypes.id })
    .from(schema.credentialTypes)
    .where(sql`${schema.credentialTypes.code} = 'driver_license'`);
  const categories = await db
    .select({ id: schema.qualificationCategories.id })
    .from(schema.qualificationCategories)
    .where(sql`${schema.qualificationCategories.code} in ('b', 'c', 'ce')`);

  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(schema.persons)
      .values({
        lastName: 'Тестовый',
        firstName: 'Водитель',
        middleName: 'Интеграционный',
        snils: DRIVER_SNILS,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: интеграционный тест пустого бланка',
      })
      .returning({ id: schema.persons.id });
    const personId = person!.id;

    await tx.insert(schema.personSpecializations).values({
      personId,
      specializationId: specialization!.id,
      isPrimary: true,
      startedOn: '2024-01-15',
    });
    await tx.insert(schema.personEmployments).values({
      personId,
      employmentType: 'staff',
      personnelNo: 'Т-101',
      jobTitle: 'Водитель',
      startedOn: '2024-01-15',
    });
    const [credential] = await tx
      .insert(schema.personCredentials)
      .values({
        personId,
        credentialTypeId: licenseType!.id,
        series: '00 00',
        number: '000101',
        issuedOn: '2021-03-12',
        // Срок заведомо длинный: тест идёт «на сегодня», и истечение сломало бы отбор водителя
        // через несколько лет молча — пустым списком вместо понятного отказа.
        expiresOn: '2099-03-12',
        verificationStatus: 'verified',
        verifiedAt: new Date('2021-03-12T12:00:00Z'),
      })
      .returning({ id: schema.personCredentials.id });
    await tx.insert(schema.personCredentialCategories).values(
      categories.map((c) => ({
        credentialId: credential!.id,
        qualificationCategoryId: c.id,
        credentialTypeId: licenseType!.id,
        validFrom: '2021-03-12',
      })),
    );
    return { personId };
  });
}

/** Пустой рейс: машина, дата и водитель — всё, чего лист требует помимо задания. */
async function emptyRoute(): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-routes',
    headers: ctx.admin,
    payload: {
      vehicleId: ctx.vehicleId,
      routeDate: ctx.routeDate,
      driverPersonId: ctx.personId,
      trip: { communicationKind: 'городское' },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const route = created.json();
  expect(route.requests).toEqual([]);
  return { id: route.id, version: route.version };
}

async function login(email: string): Promise<{ authorization: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

describe.skipIf(!DB_URL)('пустой путевой лист по рейсу без заявок (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { personId } = await seed();
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    // Своя активная грузовая машина: рейс заводится только на неё, а бланк её типа — 4-П.
    const vehicles = await db.execute<{ id: string }>(sql`
      SELECT v.id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = '4p'
      LIMIT 1`);
    const vehicle = vehicles.rows[0];
    if (!vehicle) throw new Error('В базе нет своей машины с бланком 4-П: миграции не применены');

    ctx = {
      app,
      db,
      closeDb,
      admin: { authorization: '' },
      dispatcher: { authorization: '' },
      vehicleId: vehicle.id,
      personId,
      routeDate: moscowDateKeyOf(new Date()),
    };
    ctx.admin = await login(ADMIN_EMAIL);
    ctx.dispatcher = await login(DISPATCHER_EMAIL);
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('администратор выписывает лист по пустому рейсу — без единого талона', async () => {
    const route = await emptyRoute();

    const issued = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-routes/${route.id}/waybill`,
      headers: ctx.admin,
      payload: { version: route.version },
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const waybill = issued.json().waybill;
    expect(waybill.status).toBe('issued');

    const rows = await ctx.db.execute<{
      form_code: string;
      driver_person_id: string;
      data: Record<string, string>;
      talons: string;
    }>(sql`
      SELECT w.form_code, w.driver_person_id, w.data,
             (SELECT count(*) FROM waybill_requests wr WHERE wr.waybill_id = w.id) AS talons
      FROM waybills w WHERE w.id = ${waybill.id}`);
    const row = rows.rows[0]!;

    // Реквизиты на месте, задание пусто: ровно этим пустой бланк и отличается от обычного листа.
    expect(row.form_code).toBe('4p');
    expect(row.driver_person_id).toBe(ctx.personId);
    expect(Number(row.talons)).toBe(0);
    expect(row.data.driver_fio).not.toBe('');
    expect(row.data.vehicle_reg_number).not.toBe('');
    expect(row.data.customer_name).toBe('');
    expect(row.data.task_from).toBe('');
    expect(row.data.task_cargo).toBe('');
    expect(row.data.task5_line).toBe('');
  });

  it('диспетчеру пустой бланк не выписывается: своё право (ADR 0071)', async () => {
    const route = await emptyRoute();

    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-routes/${route.id}/waybill`,
      headers: ctx.dispatcher,
      payload: { version: route.version },
    });
    expect(denied.statusCode, denied.body).toBe(422);
    expect(denied.json().message).toMatch(/нет заявок/);

    // Номер бланка при отказе не расходуется: листа по рейсу нет вовсе.
    const rows = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM waybills WHERE route_id = ${route.id}`,
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);
  });

  it('без водителя пустой бланк не выписывается и администратору', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-routes',
      headers: ctx.admin,
      payload: { vehicleId: ctx.vehicleId, routeDate: ctx.routeDate },
    });
    expect(created.statusCode, created.body).toBe(201);
    const route = created.json();

    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-routes/${route.id}/waybill`,
      headers: ctx.admin,
      payload: { version: route.version },
    });
    expect(denied.statusCode, denied.body).toBe(422);
    expect(denied.json().message).toMatch(/водителя/);
  });
});
