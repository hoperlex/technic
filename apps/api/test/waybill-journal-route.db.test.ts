import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeReadModes, inLegacy, useReadModeDatabase } from './assignment-read-mode';
import { formatVehicleRouteNumber, moscowDateKeyOf } from '@technic/contracts';
import { runSeed, snilsOf } from './db-identity';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRouteWaybill } from './waybill-issue-helper';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Номер рейса в журнале путевых листов (ADR 0120, план «маршрут и заявка окнами», §3.6).
 *
 * Рейс перестал быть вкладкой и открывается окном поверх того экрана, где о нём спросили, —
 * журнала листов в том числе. Раньше журналу рейс был не нужен: из него ходили в заявку по талону.
 * Теперь ему нужно **чем** сослаться, и `WaybillDto` получил пару обязательных полей `routeId` и
 * `routeNumber`, а запрос журнала — левый join на рейсы.
 *
 * Проверяется на живой схеме и настоящим HTTP-путём, потому что ломается здесь не правило, а
 * сборка выдачи. Номер рейса у листа не хранится — он берётся из самого рейса join'ом
 * (`formatVehicleRouteNumber(row.routeNum)`), и потерянная колонка видна только в ответе сервера:
 * ответ остаётся успешным, в нём просто тихо появляется `null`, а кнопка «Открыть рейс» пропадает
 * из журнала целиком.
 *
 * Второй случай важнее первого. Join обязан быть **левым**: у листов ЭСМ-2 рейса нет по устройству
 * бланка (`waybill-esm2.ts` пишет `routeId: null`), и `inner` вырезал бы из журнала строгой
 * отчётности все недельные листы разом — то есть потерял бы выданные номера. Снаружи это выглядит
 * не как ошибка, а как «журнал стал короче», и заметить это можно только на паре строк: с рейсом и
 * без него, в одном ответе.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test -- test/waybill-journal-route.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

/*
 * ЭСМ2-РАЗРЕЗ. Файл заводит свою базу механикой двух режимов: режим чтения живёт в управляющей строке, одной на базу.
 */
const readMode = useReadModeDatabase('wbroute');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

/** Тестовый водитель: СНИЛС из одинаковых цифр с верной контрольной суммой, серия «00 00». */
// Свой на прогон, а не общая константа: файлы db-тестов делили водителя по одному номеру, и
// первый добежавший решал, с какими документами тот живёт до конца прогона (см. `db-identity`).
// Табельный номер уникален в паре с работодателем (`person_employments_personnel_no_unique`),
// и номер удостоверения — в паре с видом и серией: тот же хвост прогона разводит и их.
const PERSONNEL_RUN = Date.now().toString(36).slice(-5);
const DRIVER_SNILS = snilsOf(runSeed('waybill-journal-route'));
const ADMIN_EMAIL = 'db-journal-route-admin@example.invalid';
const PASSWORD = 'db-test-password-123';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  /** Своя грузовая машина: на неё заводится рейс, и бланк её типа — 4-П. */
  truckId: string;
  /** Своя спецтехника с категорией: ею берут в работу заказ, а он выписывает недельный ЭСМ-2. */
  special: { id: string; typeId: string; categoryId: string | null };
  objectId: string;
  personId: string;
  date: string;
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

/** Учётка и водитель: организация, объекты, парк и серии бланков приходят миграциями. */
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
          AND ${schema.qualificationCategories.code} in ('b', 'c')`,
    );

  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(schema.persons)
      .values({
        lastName: 'Тестовый',
        firstName: 'Рейсовый',
        middleName: 'Интеграционный',
        snils: DRIVER_SNILS,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: интеграционный тест номера рейса в журнале листов',
      })
      .returning({ id: schema.persons.id });
    const personId = person!.id;

    await tx.insert(schema.personSpecializations).values({
      personId,
      specializationId: specialization!.id,
      isPrimary: true,
      startedOn: '2024-01-15',
    });
    // Должность «Машинист» в списке ADR 0095 не значится, и документ у неё умолчанием
    // водительский: незнакомая должность поведения не меняет.
    await tx.insert(schema.personEmployments).values({
      personId,
      employmentType: 'staff',
      personnelNo: `Т-105-${PERSONNEL_RUN}`,
      jobTitle: 'Машинист',
      startedOn: '2024-01-15',
    });
    const [credential] = await tx
      .insert(schema.personCredentials)
      .values({
        personId,
        credentialTypeId: licenseType!.id,
        series: '00 00',
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

/** Лист журнала в том виде, в каком его читает тест. */
interface JournalRow {
  id: string;
  number: string;
  formCode: string;
  routeId: string | null;
  routeNumber: string | null;
  requests: { requestId: string }[];
}

/**
 * Страница журнала своим водителем.
 *
 * Сужение обязательно: база db-тестов общая и живёт между прогонами, соседние файлы засевают её
 * листами будущими датами, и первая страница журнала (`issued_for_date DESC`) принадлежит им.
 * Водитель здесь и есть граница — он заводится своим на каждый прогон (`db-identity`), и вся
 * бумага этого файла выписана на него.
 */
async function journal(): Promise<JournalRow[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/waybills?driverPersonId=${ctx.personId}&pageSize=100`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().items as JournalRow[];
}

/** Строка журнала по идентификатору листа — с внятным отказом, если бумага из журнала пропала. */
function rowOf(rows: JournalRow[], waybillId: string, what: string): JournalRow {
  const row = rows.find((w) => w.id === waybillId);
  expect(row, `${what} обязан быть в журнале: выданный номер из него не исчезает`).toBeDefined();
  return row!;
}

/**
 * Рейс с выписанным по нему листом: машина, дата и водитель — всё, чего требует бланк 4-П.
 *
 * Рейс намеренно пустой, без заявок (ADR 0071): предмет проверки — связь листа с рейсом, а не
 * задание, и лишний заказ добавил бы к сценарию половину модуля заявок.
 */
async function routeWithWaybill(): Promise<{ routeId: string; waybillId: string; num: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-routes',
    headers: ctx.auth,
    payload: {
      vehicleId: ctx.truckId,
      routeDate: ctx.date,
      driverPersonId: ctx.personId,
      trip: { communicationKind: 'городское' },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const route = created.json();

  /*
   * Выписка идёт через помощника: пустой рейс поднимает предупреждение `blank_task` (Р21), и
   * подтверждение здесь — обвязка, а не предмет. Само рукопожатие проверяет `waybill-ack`.
   */
  const { res } = await issueRouteWaybill({
    app: ctx.app,
    headers: ctx.auth,
    routeId: route.id,
    payload: { version: route.version },
  });

  // Число номера рейса читается из базы: в DTO его нет — там уже напечатанный вид, а проверяется
  // как раз то, что журнал печатает его тем же правилом, что и карточка рейса.
  const rows = await ctx.db.execute<{ num: string }>(
    sql`SELECT num FROM vehicle_routes WHERE id = ${route.id}`,
  );
  return { routeId: route.id, waybillId: res.json().waybill.id, num: Number(rows.rows[0]!.num) };
}

/**
 * Недельный ЭСМ-2: заказ спецтехники, взятый в работу. Отдельной ручки «выписать» у журнала нет —
 * лист рождается решением по заявке. Срок в один день, чтобы неделя была ровно одна и на заявку
 * пришёлся ровно один бланк.
 */
async function weeklyWaybill(): Promise<{ requestId: string; waybillId: string }> {
  // ЭСМ2-РАЗРЕЗ: сцена собирается в сегодняшнем мире — заказ заводит статусная ручка, а в `history`
  // её останавливает бэкстоп (Р22). Предмет файла — связь листа с рейсом, не подготовка заказа.
  return inLegacy(readMode, weeklyWaybillNow);
}

async function weeklyWaybillNow(): Promise<{ requestId: string; waybillId: string }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.auth,
    payload: {
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.special.typeId,
      vehicleCategoryId: ctx.special.categoryId,
      dateFrom: ctx.date,
      dateTo: ctx.date,
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
        vehicleId: ctx.special.id,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.personId,
      },
      schedule: {
        requestType: 'special_equipment',
        dateFrom: ctx.date,
        dateTo: ctx.date,
      },
    },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);

  const sheets = (await journal()).filter((w) =>
    w.requests.some((link) => link.requestId === request.id),
  );
  expect(sheets.length, 'заявка в работе выписывает ровно один недельный лист').toBe(1);
  return { requestId: request.id, waybillId: sheets[0]!.id };
}

describe.skipIf(!DB_URL)('номер рейса в журнале путевых листов (живая схема)', () => {
  beforeAll(async () => {
    // Окружение и своя база готовы хуком механики (`useReadModeDatabase`).

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

    // Своя активная грузовая машина: рейс заводится только на неё, а бланк её типа — 4-П.
    const trucks = await db.execute<{ id: string }>(sql`
      SELECT v.id
      FROM vehicles v
      JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
      WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
        AND vt.waybill_form_code = '4p'
      LIMIT 1`);
    // Своя спецтехника с категорией: заявку на тип с категориями сервер без неё не примет, а
    // недельные листы выписываются только на собственную машину.
    const specials = await db.execute<{ id: string; type_id: string; category_id: string | null }>(
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
    const truck = trucks.rows[0];
    const special = specials.rows[0];
    const object = objects.rows[0];
    if (!truck || !special || !object) {
      throw new Error('В базе нет своей машины, спецтехники или объекта: миграции не применены');
    }

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      truckId: truck.id,
      special: { id: special.id, typeId: special.type_id, categoryId: special.category_id },
      objectId: object.id,
      personId,
      // Заявку задним числом сервер не принимает (`isAllowedRequestDate`) — и заявка, и рейс
      // живут сегодняшним днём.
      date: moscowDateKeyOf(new Date()),
    };
  }, 120_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а здесь
       * каждый случай выписывает бумагу — за прогон в ней оседали рейсы, заказы и их листы.
       *
       * Метка — собственная учётка файла: всё, что тут заводится, заводит она, а чужого под ней не
       * бывает. Списком заведённого уборка не пользуется намеренно — прибирать надо и за упавшим
       * прогоном, который до записи в список мог не дойти. Саму учётку уборка не трогает: её
       * `beforeAll` ищет по адресу и заводит один раз на все прогоны.
       *
       * Порядок обратен ссылкам: лист держит и заказ, и рейс ключами `restrict`, состав рейса —
       * заказ. Талоны листа, детали и история заказа уходят каскадом со своей головной строкой.
       *
       * Человек и его документы остаются: он ищется по СНИЛС и заводится один раз на прогон.
       */
      const ourUsers = sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
      const ourRequests = sql`SELECT id FROM vehicle_requests WHERE created_by IN (${ourUsers})`;
      const ourRoutes = sql`
        SELECT id FROM vehicle_routes
        WHERE created_by IN (${ourUsers}) OR source_request_id IN (${ourRequests})`;
      await ctx.db.execute(sql`
        DELETE FROM waybills
        WHERE source_request_id IN (${ourRequests})
           OR route_id IN (${ourRoutes})
           OR id IN (SELECT waybill_id FROM waybill_requests WHERE request_id IN (${ourRequests}))`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_route_requests WHERE request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_routes WHERE id IN (${ourRoutes})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${ourRequests})`);
      // Журнал — по автору: писала в него только здешняя учётка, а видов записей у неё несколько.
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  /*
   * Случаи гоняются в обоих режимах чтения; инфраструктура файла (`beforeAll`/`afterAll`) остаётся
   * снаружи — два блока означали бы два `afterAll`, и первый закрыл бы соединение.
   *
   * Сегодня половины совпадают: предмет — левый join листа с рейсом, разрезом он не затрагивается. На этапе 5 править придётся только помощник, если строк у заявки станет несколько.
   */
  describeReadModes(readMode, 'журнал: лист и рейс', (mode) => {
    void mode;

  it('лист, выписанный по рейсу, несёт в журнале и сам рейс, и его читаемый номер', async () => {
    const { routeId, waybillId, num } = await routeWithWaybill();

    const row = rowOf(await journal(), waybillId, 'лист рейса');
    // Идентификатором открывается окно рейса поверх журнала, номером он подписан на экране.
    expect(row.routeId).toBe(routeId);
    // Номер печатается тем же правилом, что и в карточке рейса: у номера один владелец, и второй
    // способ его напечатать разошёлся бы с первым на первой же правке формата.
    expect(row.routeNumber).toBe(formatVehicleRouteNumber(num));
    expect(row.routeNumber).toMatch(/^Р-\d+$/u);
  }, 60_000);

  it('недельный ЭСМ-2 остаётся в журнале без рейса — join левый, а не внутренний', async () => {
    const weekly = await weeklyWaybill();
    const route = await routeWithWaybill();

    // Обе строки читаются одним ответом: именно так их и видят — журнал строгой отчётности один
    // на все бланки, и недельные листы стоят в нём вперемешку с рейсовыми.
    const rows = await journal();

    const esm2 = rowOf(rows, weekly.waybillId, 'недельный лист ЭСМ-2');
    expect(esm2.formCode).toBe('esm2');
    // Рейса у недели работы на площадке нет вовсе, и место рейса пусто у обоих полей: «Р-» без
    // номера читалось бы как рейс, которого нет.
    expect(esm2.routeId).toBeNull();
    expect(esm2.routeNumber).toBeNull();

    // А сосед по той же странице рейс несёт: если бы join был внутренним, из журнала пропал бы не
    // он, а недельный лист — и заметить это можно только на паре.
    expect(rowOf(rows, route.waybillId, 'лист рейса').routeId).toBe(route.routeId);
  }, 60_000);
  });
});
