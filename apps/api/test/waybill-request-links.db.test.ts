import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf } from '@technic/contracts';
import { runSeed, snilsOf } from './db-identity';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Талоны заказчиков в журнале путевых листов: чем сейчас стала заявка, на которую лист выписан.
 *
 * Состояние заявки журналу не колонка — им портал выбирает, куда вести нажатие на номер талона:
 * заявку в работе показывают в списке, закрытую — в журнале закрытых (ADR 0029). Лист же читают
 * позже самой работы, и к тому времени заявка чаще всего уже закрыта: отдай сервер снимок вместо
 * состояния на сейчас — ссылка вела бы в список, где этой заявки нет, и выглядело бы это как
 * «нажал и ничего не открылось».
 *
 * Проверяется на живой схеме, потому что ломается здесь не правило, а сборка выдачи: талон
 * собирается join'ом к заявке, и потерянная колонка видна только в ответе сервера.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_links_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Тестовый машинист: СНИЛС из одинаковых цифр с верной контрольной суммой, серия «00 00». */
// Свой на прогон, а не общая константа: пять файлов заводили водителя по одному номеру, и
// первый добежавший решал, с какими документами тот живёт до конца прогона (см. `db-identity`).
// Табельный номер уникален в паре с работодателем (`person_employments_personnel_no_unique`),
// и файлы делили его так же, как делили СНИЛС. Тот же хвост прогона разводит и его.
const PERSONNEL_RUN = Date.now().toString(36).slice(-5);
const DRIVER_SNILS = snilsOf(runSeed('waybill-request-links'));
/*
 * Номер намеренно не содержит «1234567»: база у db-тестов общая, а справочник водителей ищет по
 * подстроке цифр и проверяет, что номер находит ровно одного человека (`drivers-search`). Прежний
 * `9001234567` попадал в его выборку и ронял чужой файл в зависимости от порядка прогона.
 */
const DRIVER_PHONE = '9005550101';
const ADMIN_EMAIL = 'db-links-admin@example.invalid';
const PASSWORD = 'db-test-password-123';

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

/** Учётка и машинист: организация, объекты, парк и серии бланков приходят миграциями. */
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
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    });
  }

  const [existing] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(sql`${schema.persons.snils} = ${DRIVER_SNILS}`);
  if (existing) {
    await db.execute(
      sql`UPDATE persons SET phone = ${DRIVER_PHONE}, updated_at = now() WHERE id = ${existing.id}`,
    );
    return { personId: existing.id };
  }

  const [specialization] = await db
    .select({ id: schema.specializations.id })
    .from(schema.specializations)
    .where(sql`${schema.specializations.code} = 'driver'`);
  const [licenseType] = await db
    .select({ id: schema.credentialTypes.id })
    .from(schema.credentialTypes)
    .where(sql`${schema.credentialTypes.code} = 'driver_license'`);
  // Категории — своего вида документа: «B» и «C» есть и у удостоверения тракториста-машиниста
  // (миграция 0123), а составной внешний ключ чужую категорию в ВУ не пустит.
  const categories = await db
    .select({ id: schema.qualificationCategories.id })
    .from(schema.qualificationCategories)
    .where(
      sql`${schema.qualificationCategories.credentialTypeId} = ${licenseType!.id}
          AND ${schema.qualificationCategories.code} in ('b', 'c')`,
    );

  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(schema.persons)
      .values({
        lastName: 'Тестовый',
        firstName: 'Машинист',
        middleName: 'Интеграционный',
        phone: DRIVER_PHONE,
        snils: DRIVER_SNILS,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: интеграционный тест талонов журнала',
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
      personnelNo: `Т-102-${PERSONNEL_RUN}`,
      jobTitle: 'Машинист',
      startedOn: '2024-01-15',
    });
    const [credential] = await tx
      .insert(schema.personCredentials)
      .values({
        personId,
        credentialTypeId: licenseType!.id,
        series: '00 00',
        // Номер удостоверения уникален в паре с видом и серией
        // (`person_credentials_number_unique`) — тот же хвост прогона, что у табельного.
        number: `00${PERSONNEL_RUN.slice(-4).padStart(4, '0')}`,
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

/** Заявка на спецтехнику, взятая в работу: этим и выписываются недельные листы ЭСМ-2. */
async function requestInWork(): Promise<{ id: string; displayNumber: string; version: number }> {
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

  const confirmed = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${request.id}/status`,
    headers: ctx.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: approved.json().version,
      assignment: {
        vehicleId: ctx.vehicle.id,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.personId,
      },
      schedule: {
        requestType: 'special_equipment',
        dateFrom: ctx.dateFrom,
        dateTo: ctx.dateTo,
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return {
    id: request.id,
    displayNumber: request.displayNumber,
    version: confirmed.json().version,
  };
}

/** Талон журнала по заявке: журнал читают периодом, поэтому ищем среди листов на её срок. */
async function talonOf(requestId: string): Promise<{ displayNumber: string; status: string }> {
  const journal = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waybills?dateFrom=${ctx.dateFrom}&dateTo=${ctx.dateTo}&pageSize=100`,
    headers: ctx.auth,
  });
  expect(journal.statusCode, journal.body).toBe(200);
  const links = journal
    .json()
    .items.flatMap((w: { requests: { requestId: string }[] }) => w.requests)
    .filter((link: { requestId: string }) => link.requestId === requestId);
  expect(links.length).toBeGreaterThan(0);
  return links[0] as { displayNumber: string; status: string };
}

describe.skipIf(!DB_URL)('талоны заказчиков в журнале листов (живая схема)', () => {
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
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    // Своя спецтехника с категорией: заявку на тип с категориями сервер без неё не примет, а
    // недельные листы выписываются только на собственную машину.
    const vehicles = await db.execute<{ id: string; type_id: string; category_id: string | null }>(
      sql`
        SELECT v.id, v.vehicle_type_id AS type_id, v.vehicle_category_id AS category_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
        WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
          AND vk.code = 'special_equipment' AND v.vehicle_category_id IS NOT NULL
        LIMIT 1`,
    );
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
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь каждый
       * случай берёт заказ в работу и выписывает по нему лист — за прогон в ней оседало по три
       * заказа с их бумагой.
       *
       * Метка — собственная учётка файла: всё, что тут заводится, заводит она. Списком заведённого
       * уборка не пользуется намеренно — прибирать надо и за упавшим прогоном, который до записи в
       * список мог не дойти. Саму учётку уборка не трогает: её `beforeAll` ищет по адресу и заводит
       * один раз на все прогоны.
       *
       * Порядок обратен ссылкам: лист держит и заказ, и рейс ключами `restrict`, состав рейса —
       * заказ. Талоны листа, детали и история заказа уходят каскадом со своей головной строкой.
       *
       * Человек и его документы остаются: он ищется по СНИЛС и заводится один раз на все прогоны.
       */
      const ourUsers = sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
      const ourRequests = sql`SELECT id FROM vehicle_requests WHERE created_by IN (${ourUsers})`;
      await ctx.db.execute(sql`
        DELETE FROM waybills
        WHERE source_request_id IN (${ourRequests})
           OR id IN (SELECT waybill_id FROM waybill_requests WHERE request_id IN (${ourRequests}))
           OR route_id IN (SELECT id FROM vehicle_routes
                            WHERE source_request_id IN (${ourRequests}))`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_route_requests WHERE request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_routes WHERE source_request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${ourRequests})`);
      // Журнал — по автору: писала в него только здешняя учётка, а видов записей у неё несколько.
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  it('талон несёт номер заявки и её состояние на сейчас', async () => {
    const request = await requestInWork();

    const talon = await talonOf(request.id);
    expect(talon.displayNumber).toBe(request.displayNumber);
    expect(talon.status).toBe('confirmed');
  });

  it('заявка закрылась — талон говорит об этом, а не о состоянии на день выписки', async () => {
    const request = await requestInWork();

    const cancelled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: {
        status: 'cancelled',
        // Комментарий при отмене играет роль причины — сервер требует его непустым.
        comment: 'Работы отменены заказчиком',
        version: request.version,
      },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    // Лист остаётся в журнале и после отмены заявки: выданный бланк из него не исчезает.
    const talon = await talonOf(request.id);
    expect(talon.status).toBe('cancelled');
  });

  it('карточка получает машиниста с телефоном и после аннулирования листов', async () => {
    const request = await requestInWork();

    const active = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${request.id}/driver`,
      headers: ctx.auth,
    });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json()).toMatchObject({
      personId: ctx.personId,
      fullName: 'Тестовый Машинист Интеграционный',
      phone: DRIVER_PHONE,
    });

    const cancelled = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicle-requests/${request.id}/status`,
      headers: ctx.auth,
      payload: {
        status: 'cancelled',
        comment: 'Работы отменены заказчиком',
        version: request.version,
      },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const historical = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/${request.id}/driver`,
      headers: ctx.auth,
    });
    expect(historical.statusCode, historical.body).toBe(200);
    expect(historical.json()).toMatchObject({ personId: ctx.personId, phone: DRIVER_PHONE });
  });
});
