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
 * Перевод заказа спецтехники в работу с перегоном — на живой схеме, через настоящий HTTP-путь.
 *
 * Зачем отдельный вид теста. Всё остальное в `apps/api/test` проверяет правила: контракты, отбор
 * водителей, планы сверки. База в них не участвует, и ровно поэтому мимо них прошла поломка,
 * из-за которой этот файл и появился: код ушёл вперёд неприменённой миграции 0087, сверка листов
 * ЭСМ-2 полезла за колонками, которых в базе нет, — и вся транзакция «взять в работу»
 * откатывалась. Снаружи это выглядело как «форма не работает»: заявка оставалась «Новой», перегон
 * не заводился, лист не выписывался. Ни один тест на правилах такого поймать не может: расходятся
 * не правила, а код и схема.
 *
 * Отсюда и объём проверки — вся цепочка одним запросом: назначение техники, рейс-перегон
 * (миграция 0082) и недельные листы ЭСМ-2 (миграция 0087). Они и связаны одной транзакцией:
 * падение любого звена отменяет остальные, и проверять их по отдельности значило бы не проверить
 * главного.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   createdb technic_test && psql technic_test -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;
 *     CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm'
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5432/technic_test pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует и требовать
 * не должен — иначе `pnpm test` перестанет работать там, где PostgreSQL не поднят.
 *
 * Справочники не заводятся руками: организацию, объекты, виды и парк техники, серии бланков и
 * категории прав наполняют сами миграции. Тест добавляет только то, чего в них нет и быть не
 * может, — учётку и человека (персональные данные в миграции не кладут).
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Тестовый водитель: СНИЛС из одинаковых цифр с верной контрольной суммой, серия «00 00». */
const DRIVER_SNILS = '11111111145';
const ADMIN_EMAIL = 'db-test@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  vehicle: { id: string; typeId: string; categoryId: string | null };
  objectId: string;
  personId: string;
  dateFrom: string;
  dateTo: string;
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

/** Учётка и водитель: всё остальное — организация, объекты, парк, серии — приходит миграциями. */
async function seed(): Promise<{ personId: string }> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (!user) {
    await db.insert(schema.users).values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: '',
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: 'admin',
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
    .where(sql`${schema.qualificationCategories.code} in ('b', 'c')`);

  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(schema.persons)
      .values({
        lastName: 'Тестовый',
        firstName: 'Водитель',
        middleName: 'Интеграционный',
        snils: DRIVER_SNILS,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: интеграционный тест перегона',
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
      personnelNo: 'Т-100',
      jobTitle: 'Водитель',
      startedOn: '2024-01-15',
    });
    const [credential] = await tx
      .insert(schema.personCredentials)
      .values({
        personId,
        credentialTypeId: licenseType!.id,
        series: '00 00',
        number: '000100',
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
        // Вид документа дублируется в строке категории (составной FK): без него категория чужого
        // документа могла бы попасть в удостоверение.
        credentialTypeId: licenseType!.id,
        validFrom: '2021-03-12',
      })),
    );
    return { personId };
  });
}

/** Заявка на спецтехнику, доведённая до визы: с неё начинается каждый случай ниже. */
async function approvedRequest(): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicle.typeId,
      vehicleCategoryId: ctx.vehicle.categoryId,
      dateFrom: ctx.dateFrom,
      dateTo: ctx.dateTo,
      responsibleName: 'Иванов Иван Иванович',
      responsiblePhone: '+79990000000',
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();

  const approved = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/approval`,
    headers: ctx.auth,
    payload: { approved: true, version: request.version },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return { id: request.id, version: approved.json().version };
}

/** Тело формы «Взять в работу»: с включённым перегоном либо без него. */
function confirmPayload(
  version: number,
  delivery: boolean,
): Record<string, unknown> {
  return {
    status: 'confirmed',
    comment: '',
    version,
    assignment: {
      vehicleId: ctx.vehicle.id,
      pricePerHour: null,
      pricePerShift: null,
      shiftHours: null,
      // Машинист заказа техники на объект: на него выписываются недельные листы ЭСМ-2.
      driverPersonId: ctx.personId,
      ...(delivery
        ? {
            delivery: {
              routeDate: ctx.dateFrom,
              driverPersonId: ctx.personId,
              moveFrom: 'База, ул. Автомобильная, 3',
              moveTo: 'Объект, площадка',
              trip: { communicationKind: 'городское' },
            },
          }
        : {}),
    },
    schedule: {
      requestType: 'special_equipment',
      dateFrom: ctx.dateFrom,
      dateTo: ctx.dateTo,
    },
  };
}

describe.skipIf(!DB_URL)('перевод заказа спецтехники в работу (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { personId } = await seed();
    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    // Своя спецтехника с заведённой категорией: заявку на тип с категориями сервер без неё
    // не примет, а перегон заводится только на собственную машину.
    const vehicles = await db.execute<{
      id: string;
      type_id: string;
      category_id: string | null;
    }>(sql`
      SELECT v.id, v.vehicle_type_id AS type_id, v.vehicle_category_id AS category_id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vk.code = 'special_equipment' AND v.vehicle_category_id IS NOT NULL
      LIMIT 1`);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const vehicle = vehicles.rows[0];
    const object = objects.rows[0];
    if (!vehicle || !object) {
      throw new Error('В базе нет своей спецтехники или объекта: миграции наполнения не применены');
    }

    const day = 24 * 60 * 60 * 1000;
    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      vehicle: { id: vehicle.id, typeId: vehicle.type_id, categoryId: vehicle.category_id },
      objectId: object.id,
      personId,
      // Срок — от сегодня: заявку задним числом сервер не принимает (`isAllowedRequestDate`).
      dateFrom: moscowDateKeyOf(new Date()),
      dateTo: moscowDateKeyOf(new Date(Date.now() + 2 * day)),
    };
  }, 120_000);

  afterAll(async () => {
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('заводит перегон и выписывает листы ЭСМ-2 тем же запросом, что и статус', async () => {
    const request = await approvedRequest();

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: confirmPayload(request.version, true),
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('confirmed');
    expect(res.json().assignment?.vehicleId).toBe(ctx.vehicle.id);

    // Перегон — отдельным рейсом, а не составом заявки: у спецтехники маршрута нет вовсе.
    const relocations = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${request.id}/relocations`,
      headers: ctx.auth,
    });
    expect(relocations.statusCode, relocations.body).toBe(200);
    const routes = relocations.json();
    expect(routes).toHaveLength(1);
    expect(routes[0].purpose).toBe('delivery');
    expect(routes[0].routeDate).toBe(ctx.dateFrom);
    expect(routes[0].moveTo).toBe('Объект, площадка');
    expect(routes[0].driverPersonId).toBe(ctx.personId);
    // Бланк перегона — 4-П независимо от типа машины: экскаватор идёт по дорогам как ТС.
    expect(routes[0].formCode).toBe('4p');
    // Сам лист не выписывается: его печатают с карточки маршрута, когда рейс собран.
    expect(routes[0].waybill).toBeNull();

    // Недельные листы ЭСМ-2 родились той же транзакцией — по листу на каждую неделю срока.
    const sheets = await ctx.db.execute<{ number: string; period_from: string; status: string }>(
      sql`SELECT number, period_from, status FROM waybills
          WHERE source_request_id = ${request.id} ORDER BY period_from`,
    );
    expect(sheets.rows.length).toBeGreaterThan(0);
    expect(sheets.rows[0]!.status).toBe('issued');
    expect(sheets.rows[0]!.period_from).toBe(ctx.dateFrom);
  });

  it('без перегона заявка уходит в работу как прежде — рейс не заводится молча', async () => {
    const request = await approvedRequest();

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: confirmPayload(request.version, false),
    });

    expect(res.statusCode, res.body).toBe(200);
    const relocations = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${request.id}/relocations`,
      headers: ctx.auth,
    });
    expect(relocations.json()).toEqual([]);
  });

  it('второй перегон на ту же заявку отклоняется, а не заводит двойник', async () => {
    const request = await approvedRequest();
    const first = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: confirmPayload(request.version, true),
    });
    expect(first.statusCode, first.body).toBe(200);

    // Повторный перегон заводят уже из карточки заявки — тем же правилом «одна доставка и один
    // вывоз», что держит частичный индекс `vehicle_routes_source_request_unique`.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/vehicle-requests/${request.id}/relocations`,
      headers: ctx.auth,
      payload: {
        purpose: 'delivery',
        routeDate: ctx.dateFrom,
        driverPersonId: ctx.personId,
        moveFrom: 'База, ул. Автомобильная, 3',
        moveTo: 'Объект, площадка',
      },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/уже заведён/);
  });
});
