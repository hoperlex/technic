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
 * Адрес ездки, выбранный из справочника (ADR 0069), — на живой схеме, через настоящий HTTP-путь.
 *
 * Контракты проверяют форму метаданных: у справочного источника обязана быть ссылка на запись.
 * Но само утверждение «этот адрес взят из справочника» формой не проверяется — за ним должна
 * стоять живая запись с тем же адресом, и убедиться в этом может только сервер, у которого есть
 * база. Он единственный, кто отличает выбор из списка от строки, набранной руками и помеченной
 * как выбранная: ФИАС у справочного адреса нет, и больше подтверждать нечем.
 *
 * Поэтому проверяются обе стороны: адрес из справочника принимается, а расхождение с записью —
 * отклоняется, и отказ садится на то поле формы, где человек его увидит. Поле теперь адресуется
 * внутрь ездки (`trips.0.fromLocation`): пары адресов у самой заявки нет вовсе (план
 * `docs/route-trips-plan.md`, Р2), а с нею исчезло и место, куда такой отказ садился прежде.
 *
 * Запуск — как у остальных db-тестов; без `TEST_DATABASE_URL` файл пропускается:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test vehicle-request-address
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/*
 * Адрес свой у файла, а не общий `db-test@`: под тем же адресом заводили администратора ещё два
 * db-теста, а уборка опознаёт заведённое как раз по автору — общая учётка означала бы, что файл
 * сносит чужие, ещё живые заказы (та же беда, что и с общим СНИЛС, см. `db-identity`).
 */
const ADMIN_EMAIL = 'db-request-address@example.invalid';
const ADMIN_PASSWORD = 'db-test-password-123';

/** Фикстуры справочников заводятся один раз и переиспользуются: код и ИНН — их опознание. */
const OBJECT_CODE = 'ADR-TEST';
const OBJECT_ADDRESS = 'г Москва, ул Тестовая, д 1';
const SUPPLIER_INN = '7736050003';
const WAREHOUSE_ADDRESS = 'г Москва, ул Складская, д 7';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
  objectId: string;
  warehouseId: string;
  scheduledAt: string;
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

/** Учётка администратора: остальное (объекты, парк, серии) приходит миграциями наполнения. */
async function seedAdmin(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${ADMIN_EMAIL}`);
  if (user) return;
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

/**
 * Заявка на грузоперевозку с заданными адресами; возвращает ответ как есть — его и проверяем.
 *
 * Адреса, количество и контакты — у ездки, а не у заявки (Р2): у заявки с ездками `A→B` и `A→C`
 * «адрес разгрузки заявки» не существует. Одна ездка — то же, чем была пара полей, и проверяет
 * сервер именно её.
 */
function createFreight(trip: {
  fromLocation: string;
  fromAddress: Record<string, unknown>;
  toLocation?: string;
  toAddress?: Record<string, unknown>;
}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      vehicleCategoryId: ctx.vehicleCategoryId,
      scheduledAt: ctx.scheduledAt,
      trips: [{ ...freightTrip(), ...trip }],
    },
  });
}

/**
 * Ездка по умолчанию: разгрузка на своей площадке, груз и контакты на обоих концах. Проверяется
 * здесь погрузка, и всё остальное обязано быть заведомо годным — иначе 422 приходил бы не оттуда,
 * откуда его ждут.
 */
function freightTrip(): Record<string, unknown> {
  return {
    fromLocation: OBJECT_ADDRESS,
    fromAddress: { source: 'object', refId: ctx.objectId },
    toLocation: OBJECT_ADDRESS,
    toAddress: { source: 'object', refId: ctx.objectId },
    volumeM3: 10,
    fromResponsibleName: 'Иванов Иван',
    fromResponsiblePhone: '+79990000001',
    toResponsibleName: 'Петров Пётр',
    toResponsiblePhone: '+79990000002',
  };
}

describe.skipIf(!DB_URL)('адрес заявки из справочника (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedAdmin();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const auth = { authorization: `Bearer ${login.json().accessToken}` };

    // Грузоперевозку выполняет только грузовой вид ТС; категория берётся, если у типа она есть, —
    // тип с категориями сервер без неё не примет (ADR 0028).
    const types = await db.execute<{ type_id: string; category_id: string | null }>(sql`
      SELECT vt.id AS type_id,
             (SELECT vc.id FROM vehicle_categories vc
               WHERE vc.vehicle_type_id = vt.id AND vc.is_active LIMIT 1) AS category_id
      FROM vehicle_types vt
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE vk.code = 'freight_transport'
      LIMIT 1`);
    const type = types.rows[0];
    if (!type)
      throw new Error('В базе нет типа ТС грузового вида: миграции наполнения не применены');

    // Свои записи справочников, а не чужие из миграций: тест правит их состояние (гасит склад),
    // и трогать наполнение, на которое опираются другие тесты, он не должен.
    const objectId = await ensureObject(app, auth);
    const warehouseId = await ensureWarehouse(app, auth);

    ctx = {
      app,
      db,
      closeDb,
      auth,
      vehicleTypeId: type.type_id,
      vehicleCategoryId: type.category_id,
      objectId,
      warehouseId,
      // Подача — сегодня в рабочее окно: заявку задним числом сервер не принимает.
      scheduledAt: `${moscowDateKeyOf(new Date())}T10:00:00+03:00`,
    };
  }, 120_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь каждый
       * случай заводит грузоперевозку — за прогон в ней оседало по три заказа с их ездками и
       * историей.
       *
       * Метка — собственная учётка файла: всё, что тут заводится, заводит она. Списком заведённого
       * уборка не пользуется намеренно — прибирать надо и за упавшим прогоном, который до записи в
       * список мог не дойти. Саму учётку и фикстуры справочников (площадка, поставщик, склад)
       * уборка не трогает: их `beforeAll` ищет по коду и заводит один раз на все прогоны.
       *
       * Детали, ездки и история заказа уходят каскадом вместе с ним.
       */
      const ourUsers = sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE created_by IN (${ourUsers})`);
      // Журнал — по автору: писала в него только здешняя учётка, а видов записей у неё несколько.
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  it('принимает адрес объекта из справочника — без ФИАС, по ссылке на запись', async () => {
    const res = await createFreight({
      fromLocation: OBJECT_ADDRESS,
      fromAddress: { source: 'object', refId: ctx.objectId },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().trips[0].fromAddress).toEqual({ source: 'object', refId: ctx.objectId });
  });

  it('принимает адрес склада поставщика', async () => {
    const res = await createFreight({
      fromLocation: WAREHOUSE_ADDRESS,
      fromAddress: { source: 'warehouse', refId: ctx.warehouseId },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().trips[0].fromAddress).toEqual({
      source: 'warehouse',
      refId: ctx.warehouseId,
    });
  });

  it('отклоняет строку, не совпадающую с адресом записи справочника', async () => {
    const res = await createFreight({
      fromLocation: 'г Москва, ул Придуманная, д 2',
      fromAddress: { source: 'object', refId: ctx.objectId },
    });
    expect(res.statusCode, res.body).toBe(422);
    // Отказ садится на поле формы: общее сообщение поверх окна человек соотнести не может. Ездок в
    // форме несколько, поэтому и путь полный — `trips.0.fromLocation`: без номера строки портал не
    // знает, какую из шести подсветить.
    expect(res.json().fields?.['trips.0.fromLocation']).toBeTruthy();
  });

  it('отклоняет ссылку на несуществующую запись справочника', async () => {
    const res = await createFreight({
      fromLocation: OBJECT_ADDRESS,
      fromAddress: { source: 'object', refId: '11111111-2222-4333-8444-555555555555' },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().fields?.['trips.0.fromLocation']).toBeTruthy();
  });

  it('отклоняет выключенную запись справочника', async () => {
    const off = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/warehouses/${ctx.warehouseId}`,
      headers: ctx.auth,
      payload: { isActive: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    try {
      const res = await createFreight({
        fromLocation: WAREHOUSE_ADDRESS,
        fromAddress: { source: 'warehouse', refId: ctx.warehouseId },
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().fields?.['trips.0.fromLocation']).toBeTruthy();
    } finally {
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/warehouses/${ctx.warehouseId}`,
        headers: ctx.auth,
        payload: { isActive: true },
      });
    }
  });

  /**
   * Правка ездки — и договор Р2а вместе с ней.
   *
   * Ездки правятся **полным списком** (§7), и приёма «не отправлять нетронутое» у списка нет:
   * строка приезжает целиком. Поэтому существующая ездка обязана нести свой `id` — им сервер и
   * отличает перезапись от заведения. Под `id` непроверенный адрес и пустой контакт, доехавшие
   * бэкфилом, принимаются как есть, пока их не меняют; **изменённое** значение проходит жёсткую
   * модель целиком — ровно то, что здесь и проверяется: адрес меняют, значит спрашивают с него
   * так же, как при заведении.
   *
   * Обратная половина Р2а — ездка **без** `id` — отдельного случая не требует: это заведение, и
   * его проверяют случаи выше, теми же телами и теми же отказами.
   */
  it('правка ездки проверяет изменённый адрес так же, как создание (Р2а)', async () => {
    const created = await createFreight({
      fromLocation: OBJECT_ADDRESS,
      fromAddress: { source: 'object', refId: ctx.objectId },
    });
    expect(created.statusCode, created.body).toBe(201);
    const request = created.json();
    const tripId = request.trips[0].id as string;

    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}`,
      headers: ctx.auth,
      payload: {
        requestType: 'freight_transport',
        version: request.version,
        trips: [
          {
            ...freightTrip(),
            id: tripId,
            fromLocation: 'г Москва, ул Придуманная, д 2',
            fromAddress: { source: 'object', refId: ctx.objectId },
          },
        ],
      },
    });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.json().fields?.['trips.0.fromLocation']).toBeTruthy();

    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}`,
      headers: ctx.auth,
      payload: {
        requestType: 'freight_transport',
        version: request.version,
        trips: [
          {
            ...freightTrip(),
            id: tripId,
            fromLocation: WAREHOUSE_ADDRESS,
            fromAddress: { source: 'warehouse', refId: ctx.warehouseId },
          },
        ],
      },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    // Ездка та же, а не заведённая заново: правка с `id` перезаписывает строку, и номер у неё
    // остаётся прежним — «ТС-40/1» в выданном листе обязан означать ту же ездку (Р13а).
    expect(ok.json().trips).toHaveLength(1);
    expect(ok.json().trips[0].id).toBe(tripId);
    expect(ok.json().trips[0].fromLocation).toBe(WAREHOUSE_ADDRESS);
    expect(ok.json().trips[0].fromAddress?.refId).toBe(ctx.warehouseId);
  });
});

/** Объект справочника с известным адресом; повторный прогон переиспользует заведённый. */
async function ensureObject(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: { authorization: string },
): Promise<string> {
  const found = await app.inject({
    method: 'GET',
    url: `/api/v1/objects?search=${encodeURIComponent(OBJECT_CODE)}&pageSize=50`,
    headers: auth,
  });
  expect(found.statusCode, found.body).toBe(200);
  const existing = found.json().items.find((o: { code: string }) => o.code === OBJECT_CODE) as
    { id: string } | undefined;
  if (existing) return existing.id;

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/objects',
    headers: auth,
    payload: { code: OBJECT_CODE, name: 'Тестовая площадка (адреса)', address: OBJECT_ADDRESS },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().id;
}

/** Склад тестового поставщика; заводится вместе с поставщиком и тоже переиспользуется. */
async function ensureWarehouse(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: { authorization: string },
): Promise<string> {
  const foundWarehouse = await app.inject({
    method: 'GET',
    url: `/api/v1/warehouses?search=${encodeURIComponent(WAREHOUSE_ADDRESS)}&pageSize=50`,
    headers: auth,
  });
  expect(foundWarehouse.statusCode, foundWarehouse.body).toBe(200);
  const existingWarehouse = foundWarehouse
    .json()
    .items.find((w: { address: string }) => w.address === WAREHOUSE_ADDRESS) as
    { id: string } | undefined;
  if (existingWarehouse) return existingWarehouse.id;

  const foundSupplier = await app.inject({
    method: 'GET',
    url: `/api/v1/counterparties?search=${SUPPLIER_INN}&pageSize=50`,
    headers: auth,
  });
  expect(foundSupplier.statusCode, foundSupplier.body).toBe(200);
  const existingSupplier = foundSupplier
    .json()
    .items.find((c: { inn: string }) => c.inn === SUPPLIER_INN) as { id: string } | undefined;
  const supplierId =
    existingSupplier?.id ??
    (await (async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/counterparties',
        headers: auth,
        payload: { type: 'supplier', name: 'Тестовый поставщик (адреса)', inn: SUPPLIER_INN },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    })());

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/warehouses',
    headers: auth,
    payload: { supplierId, address: WAREHOUSE_ADDRESS, name: 'Основной' },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().id;
}
