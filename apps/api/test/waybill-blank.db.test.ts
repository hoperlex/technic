import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf } from '@technic/contracts';
import { runSeed, snilsOf } from './db-identity';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRouteWaybill } from './waybill-issue-helper';
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
// Свой на прогон, а не общая константа: пять файлов заводили водителя по одному номеру, и
// первый добежавший решал, с какими документами тот живёт до конца прогона (см. `db-identity`).
// Табельный номер уникален в паре с работодателем (`person_employments_personnel_no_unique`),
// и файлы делили его так же, как делили СНИЛС. Тот же хвост прогона разводит и его.
const PERSONNEL_RUN = Date.now().toString(36).slice(-5);
const DRIVER_SNILS = snilsOf(runSeed('waybill-blank'));
/**
 * Реквизиты его водительского удостоверения: должность «Водитель» требует именно ВУ (ADR 0095), и
 * снимок листа обязан заполнить графу из него. Значения — выдуманные, как и СНИЛС.
 */
const LICENSE_SERIES = '00 00';
const LICENSE_NUMBER = '000101';
const LICENSE_ISSUED_ON = '2021-03-12';
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
  // Категории — своего вида документа: «B» и «C» есть и у удостоверения тракториста-машиниста
  // (миграция 0123), а составной внешний ключ чужую категорию в ВУ не пустит.
  const categories = await db
    .select({ id: schema.qualificationCategories.id })
    .from(schema.qualificationCategories)
    .where(
      sql`${schema.qualificationCategories.credentialTypeId} = ${licenseType!.id}
          AND ${schema.qualificationCategories.code} in ('b', 'c', 'ce')`,
    );

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
      personnelNo: `Т-101-${PERSONNEL_RUN}`,
      jobTitle: 'Водитель',
      startedOn: '2024-01-15',
    });
    const [credential] = await tx
      .insert(schema.personCredentials)
      .values({
        personId,
        credentialTypeId: licenseType!.id,
        series: LICENSE_SERIES,
        number: LICENSE_NUMBER,
        issuedOn: LICENSE_ISSUED_ON,
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
async function emptyRoute(
  trip: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-routes',
    headers: ctx.admin,
    payload: {
      vehicleId: ctx.vehicleId,
      routeDate: ctx.routeDate,
      driverPersonId: ctx.personId,
      trip: { communicationKind: 'городское', ...trip },
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
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь каждый
       * случай заводит пустой рейс — за прогон в ней оседало по три рейса и по листу.
       *
       * Метка — собственные учётки файла: рейсы заводят они, а чужого под ними не бывает. Списком
       * заведённого уборка не пользуется намеренно — прибирать надо и за упавшим прогоном, который
       * до записи в список мог не дойти. Сами учётки уборка не трогает: их `beforeAll` ищет по
       * адресам и заводит один раз на все прогоны.
       *
       * Порядок обратен ссылкам: лист держит рейс ключом `restrict`. Счёт номеров это не ломает —
       * он считается разницей, а не сдвигом счётчика (см. `burnedSince` в `waybill-ack`).
       */
      const ourUsers = sql`
        SELECT id FROM users WHERE email IN (${ADMIN_EMAIL}, ${DISPATCHER_EMAIL})`;
      const ourRoutes = sql`SELECT id FROM vehicle_routes WHERE created_by IN (${ourUsers})`;
      await ctx.db.execute(sql`DELETE FROM waybills WHERE route_id IN (${ourRoutes})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_routes WHERE id IN (${ourRoutes})`);
      // Журнал — по автору: писали в него только здешние учётки, а видов записей у них несколько.
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  it('администратор выписывает лист по пустому рейсу — без единого талона', async () => {
    const route = await emptyRoute();

    /*
     * Выписка идёт через помощника: пустой маршрут поднимает предупреждение `blank_task` (Р21), и
     * подтверждение здесь — обвязка, а не предмет. Что рукопожатие вообще спрашивается и что на
     * отказе номер не расходуется, проверяет `waybill-ack.db.test.ts`; здесь смотрят на бумагу.
     */
    const { res: issued } = await issueRouteWaybill({
      app: ctx.app,
      headers: ctx.admin,
      routeId: route.id,
      payload: { version: route.version },
    });
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
    /*
     * Документ листа выбирается должностью (ADR 0095), и у водителя это по-прежнему водительское
     * удостоверение: серия с номером склеены, как напечатаны в документе. Проверка стоит здесь,
     * потому что 4-П его печатает — в отличие от ЭСМ-2, где граф под удостоверение нет вовсе.
     *
     * Сверяется с живой записью, а не с константой: база db-тестов общая, человек ищется по СНИЛС,
     * и завести его мог соседний файл со своими реквизитами. Доказывается тут не значение, а то,
     * что в графу попало водительское удостоверение этого человека.
     */
    const licenses = await ctx.db.execute<{ requisites: string; issued_on: string }>(sql`
      SELECT btrim(c.series || ' ' || c.number) AS requisites,
             -- Дата в снимке — та, что уйдёт на бумагу: «дд.мм.гггг», а не календарный ключ.
             to_char(c.issued_on, 'DD.MM.YYYY') AS issued_on
      FROM person_credentials c
      JOIN credential_types t ON t.id = c.credential_type_id
      WHERE c.person_id = ${ctx.personId} AND c.deleted_at IS NULL AND t.code = 'driver_license'`);
    const license = licenses.rows[0]!;
    expect(row.data.driver_license_number).toBe(license.requisites);
    expect(row.data.driver_license_issued_on).toBe(license.issued_on);
    /*
     * Графа «В чьё распоряжение» у пустого бланка заполнена — и это не противоречие пустому
     * заданию: заказчик берётся из настройки портала (миграция 0164), а не из заявки, которой у
     * этого рейса нет вовсе. Сверяется с живой настройкой, как и удостоверение: база db-тестов
     * общая, и реквизиты в ней мог поправить соседний файл.
     */
    const customers = await ctx.db.execute<{ name: string; address: string }>(
      sql`SELECT name, address FROM waybill_customer`,
    );
    const customer = customers.rows[0]!;
    expect(customer.name).not.toBe('');
    expect(row.data.customer_name).toBe(customer.name);
    expect(row.data.customer_address).toBe(customer.address);
    // А объект пуст: заявки у рейса нет, и объекта, ради которого выписан лист, не существует.
    expect(row.data.object_line).toBe('');
    expect(row.data.task_from).toBe('');
    expect(row.data.task_cargo).toBe('');
    expect(row.data.task5_line).toBe('');
  });

  /*
   * Второй прицеп: от тела запроса до снимка бланка.
   *
   * Колонки `trailer2_*` лежали в `waybills` с миграции 0061, ключи `trailer2_brand` и
   * `trailer2_reg_number` — в `WAYBILL_SNAPSHOT_KEYS`, а шаблон `waybill-4p.xlsx` печатает их в
   * `J22`/`AV22`. Не спрашивало второй прицеп только окно — и потому вся цепочка ни разу не была
   * пройдена целиком. Тест закрывает её на живой схеме: графа, дошедшая до снимка, дойдёт и до
   * бумаги, потому что печать берёт снимок.
   */
  it('оба прицепа доезжают до снимка бланка, а не только первый', async () => {
    const route = await emptyRoute({
      withTrailer: true,
      trailer1Model: 'ШМИТЦ SPR-24',
      trailer1RegNumber: 'ВХ933277',
      trailer2Model: 'КРОНА SDP27',
      trailer2RegNumber: 'ЕН806277',
    });

    const { res: issued } = await issueRouteWaybill({
      app: ctx.app,
      headers: ctx.admin,
      routeId: route.id,
      payload: { version: route.version },
    });

    const waybill = issued.json().waybill;
    const rows = await ctx.db.execute<{
      with_trailer: boolean;
      trailer2_model: string;
      trailer2_reg_number: string;
      data: Record<string, string>;
    }>(sql`
      SELECT w.with_trailer, w.trailer2_model, w.trailer2_reg_number, w.data
      FROM waybills w WHERE w.id = ${waybill.id}`);
    const row = rows.rows[0]!;

    // Колонки листа: лист помнит состав целиком, а не его начало.
    expect(row.with_trailer).toBe(true);
    expect(row.trailer2_model).toBe('КРОНА SDP27');
    expect(row.trailer2_reg_number).toBe('ЕН806277');

    // Снимок: печать идёт из него, и графа, до него не дошедшая, до бумаги не дойдёт молча.
    expect(row.data.trailer1_brand).toBe('ШМИТЦ SPR-24');
    expect(row.data.trailer1_reg_number).toBe('ВХ933277');
    expect(row.data.trailer2_brand).toBe('КРОНА SDP27');
    expect(row.data.trailer2_reg_number).toBe('ЕН806277');

    // Журнал листов называет оба — та самая подпись, которая до этой работы знала первый.
    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/waybills?search=${waybill.number}`,
      headers: ctx.admin,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const found = listed.json().items.find((w: { id: string }) => w.id === waybill.id);
    expect(found?.trailerLabel).toBe('ШМИТЦ SPR-24 ВХ933277 · КРОНА SDP27 ЕН806277');
  });

  /* Порядок пар — свойство бланка: заполненный второй слот при пустом первом печатался бы дырой. */
  it('второй прицеп без первого рейс не принимает', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-routes',
      headers: ctx.admin,
      payload: {
        vehicleId: ctx.vehicleId,
        routeDate: ctx.routeDate,
        driverPersonId: ctx.personId,
        trip: {
          communicationKind: 'городское',
          withTrailer: true,
          trailer2Model: 'КРОНА SDP27',
          trailer2RegNumber: 'ЕН806277',
        },
      },
    });
    expect(created.statusCode, created.body).toBe(400);
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
