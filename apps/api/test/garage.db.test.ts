import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  busyWaybillForms,
  type DriverOptionDto,
  type GarageBusyEntry,
  type GarageDriverDto,
  type GarageVehicleDto,
  moscowDateKeyOf,
  type WaybillFormCode,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Гараж на живой схеме: срез дня собирается из четырёх источников сразу (ADR 0076).
 *
 * Правил у модуля почти нет — есть SQL: три EXISTS-подзапроса, `CASE` старшинства состояний и
 * доборы занятостей. Проверить это тестом на правилах невозможно в принципе: ошибка здесь живёт
 * не в ветвлении, а в имени колонки, в приведении даты и в том, попадает ли граница периода
 * внутрь. Поэтому файл идёт по настоящему HTTP-пути на настоящей базе.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Тестовый водитель гаража: свой СНИЛС, чтобы не пересечься с водителем соседнего db-теста. */
const DRIVER_SNILS = '22222222290';
const ADMIN_EMAIL = 'garage-db-test@example.invalid';
const ADMIN_PASSWORD = 'garage-db-test-password-123';

/** Метка прогона: в общей базе рядом живут данные соседних db-тестов и прошлых запусков. */
const RUN = randomUUID().slice(0, 8);

/**
 * Гаражный номер машин этого прогона — он же ключ отбора «только свои» (`?search=`).
 *
 * Собственные машины, а не первые попавшиеся свободные из парка, — и это не удобство фикстуры.
 * Срез гаража отвечает про **весь** парк, поэтому проверять по нему глобальные суммы нельзя: db-
 * тесты идут по одной базе, соседние заводят свою технику, и «в отборе столько же строк, сколько в
 * сводке» ломалось от чужой машины, появившейся между двумя запросами. Своя метка сужает обе
 * ручки до трёх машин теста — и сумма состояний, и согласие фильтра со сводкой считаются тогда по
 * тому, что тест сам и завёл.
 *
 * Гаражным номером, а не моделью: поиск перечня смотрит и в него (`vehicleWhere`), а лишней строки
 * в справочнике моделей ради метки заводить незачем.
 */
const MARK = `гараж-${RUN}`;
/** Отбор «только машины этого прогона» — приставка к адресам обеих ручек техники. */
const ONLY_MINE = `&search=${encodeURIComponent(MARK)}`;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  /** Спецтехника с категорией: на неё заводится заказ на объект. */
  special: { id: string; typeId: string; categoryId: string | null };
  /** Своя активная машина под рейс — заведомо другая, иначе состояния наложились бы. */
  routeVehicle: { id: string };
  /** Третья машина: ею проверяются «свободна» и «недоступна». */
  spare: { id: string };
  objectId: string;
  personId: string;
  today: string;
}

let ctx: Ctx;

/** Что тест завёл в общей базе — за это и держится уборка в `afterAll`. */
const created: { requestId?: string; routeId?: string; vehicleIds: string[] } = { vehicleIds: [] };

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

/** Учётка и водитель: парк, объекты, серии бланков и категории прав приходят миграциями. */
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
      middleName: 'Гаражный',
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
  // Категории — водительские, и вид документа в условии обязателен: с миграции 0123 «b» и «c»
  // есть и у удостоверения тракториста-машиниста (буквы у видов общие, ADR 0095), а составной
  // внешний ключ не пустит тракторную категорию в водительское удостоверение.
  const categories = await db
    .select({ id: schema.qualificationCategories.id })
    .from(schema.qualificationCategories)
    .where(
      sql`${schema.qualificationCategories.code} in ('b', 'c')
        AND ${schema.qualificationCategories.credentialTypeId} = ${licenseType!.id}`,
    );

  return db.transaction(async (tx) => {
    const [person] = await tx
      .insert(schema.persons)
      .values({
        lastName: 'Гаражный',
        firstName: 'Водитель',
        middleName: 'Тестовый',
        snils: DRIVER_SNILS,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: срез гаража',
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
      personnelNo: 'Г-100',
      jobTitle: 'Водитель',
      startedOn: '2024-01-15',
    });
    const [credential] = await tx
      .insert(schema.personCredentials)
      .values({
        personId,
        credentialTypeId: licenseType!.id,
        series: '00 00',
        number: '000600',
        issuedOn: '2021-03-12',
        // Срок заведомо длинный: иначе тест однажды сломается молча — пробелами комплекта.
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

/**
 * Своя машина прогона: собственная, активная и помеченная гаражным номером `MARK`.
 *
 * Заводится, а не выбирается из парка. Выбранная свободная машина держалась на трёх условиях «на
 * сегодня ничего не назначено», и всё равно оставалась чужой: параллельный db-тест мог занять её
 * между отбором и проверкой, а на большом парке она просто не попадала на страницу ответа.
 * Заведённая машина принадлежит тесту целиком — и уборка в `afterAll` знает, что за собой убирать.
 *
 * База передаётся параметром: первые три машины заводятся до того, как собран `ctx`, а машины
 * сценариев отбора — уже после, из вложенного `beforeAll`.
 */
async function addVehicle(
  db: typeof AppDb,
  typeId: string,
  categoryId: string | null,
): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`INSERT INTO vehicles (ownership, status, vehicle_type_id, vehicle_category_id,
                              registration_number, garage_number)
        VALUES ('own', 'active', ${typeId}::uuid, ${categoryId}::uuid,
                ${`Т${randomUUID().slice(0, 3).toUpperCase()}${created.vehicleIds.length}ГР777`},
                ${MARK})
        RETURNING id`,
  );
  const id = rows.rows[0]!.id;
  created.vehicleIds.push(id);
  return id;
}

/**
 * Строка гаража по машине — из отбора «только свои» (`ONLY_MINE`).
 *
 * Отбор здесь не для скорости: без него страница отвечала бы по всему парку, и строка теста
 * зависела бы от того, сколько машин завели соседние db-тесты, — а на парке крупнее страницы её и
 * вовсе не оказалось бы в ответе.
 */
async function vehicleRow(
  vehicleId: string,
  query = '',
  on = ctx.today,
): Promise<GarageVehicleDto | undefined> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/garage/vehicles?on=${on}&pageSize=500${ONLY_MINE}${query}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().onDate).toBe(on);
  return (res.json().items as GarageVehicleDto[]).find((row) => row.id === vehicleId);
}

function busyKinds(entries: readonly GarageBusyEntry[]): string[] {
  return entries.map((entry) => entry.kind);
}

/**
 * Ответ ручки водителей целиком — с любым набором фильтров и на любой день среза.
 *
 * Целиком, а не одной строкой: у отбора спрашивают и счётчик (`total`), и число строк своего
 * водителя — фильтр по бланку обязан оставить его в выдаче **один раз**, сколько бы работ дня в
 * набор ни попало.
 */
async function driverList(
  query = '',
  on = ctx.today,
): Promise<{ items: GarageDriverDto[]; total: number }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/garage/drivers?on=${on}&pageSize=500${query}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().onDate).toBe(on);
  return res.json();
}

/** Строка гаража по водителю теста — с любым набором фильтров перечня. */
async function driverRow(query = '', on = ctx.today): Promise<GarageDriverDto | undefined> {
  const { items } = await driverList(query, on);
  return items.find((row) => row.personId === ctx.personId);
}

/** Набор площадок в адресе: тем же видом, каким его собирает портал, — через запятую. */
function objectsQuery(ids: string[]): string {
  return `&objects=${encodeURIComponent(ids.join(','))}`;
}

/** Набор бланков в адресе: `forms=4p,esm2`. */
function formsQuery(codes: WaybillFormCode[]): string {
  return `&forms=${encodeURIComponent(codes.join(','))}`;
}

/**
 * День далеко от дня среза: сценарии отбора живут каждый в своём дне.
 *
 * Разными днями одного водителя, а не разными людьми: правило считает работу **дня**, и два рейса
 * разных бланков на одном человеке в один день слились бы в общий набор — проверить «перегон идёт
 * по 4-П независимо от типа машины» стало бы нечем. Далеко — потому что недельный лист заказа
 * накрывает свой период, и работа одного сценария попадала бы в ответ соседнего.
 */
function dayAfter(days: number): string {
  return moscowDateKeyOf(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

/** Должность действующего трудового отношения — ею тест и меняет вид требуемого документа. */
async function setJobTitle(jobTitle: string): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE person_employments SET job_title = ${jobTitle}
        WHERE person_id = ${ctx.personId} AND ended_on IS NULL`,
  );
}

/** Срок удостоверения: им тест и делает единственный документ водителя негодным на день среза. */
async function setLicenseExpiry(expiresOn: string): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE person_credentials SET expires_on = ${expiresOn} WHERE person_id = ${ctx.personId}`,
  );
}

describe.skipIf(!DB_URL)('гараж: срез дня на живой схеме', () => {
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

    const today = moscowDateKeyOf(new Date());

    /**
     * Позиции классификатора под три машины прогона.
     *
     * Спецтехника берётся с категорией и **нелинейная**: заказ такого типа ведётся сроком и
     * выписывает недельный лист ЭСМ-2 сам (ADR 0060), а линейный ведётся по дням и бумагу заводит
     * только по требованию (ADR 0100) — сценарий заказа проверяет как раз первое. Сами позиции
     * приходят миграциями и общие у всех: заводить свои значило бы проверять срез на классификаторе,
     * которого в портале нет.
     */
    const special = await db.execute<{ type_id: string; category_id: string }>(
      sql`SELECT vt.id AS type_id, vc.id AS category_id
          FROM vehicle_types vt
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          JOIN vehicle_categories vc ON vc.vehicle_type_id = vt.id AND vc.is_active
          WHERE vk.code = 'special_equipment' AND NOT vt.is_linear
          ORDER BY vt.code, vc.sort_order, vc.name
          LIMIT 1`,
    );
    const specialType = special.rows[0];
    if (!specialType) throw new Error('В классификаторе нет спецтехники с категорией');

    const freight = await db.execute<{ id: string }>(
      sql`SELECT vt.id FROM vehicle_types vt
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          WHERE vk.code = 'freight_transport' AND NOT vt.is_linear
          ORDER BY vt.code LIMIT 1`,
    );
    const freightType = freight.rows[0];
    if (!freightType) throw new Error('В классификаторе нет грузового типа техники');

    const makeVehicle = (typeId: string, categoryId: string | null): Promise<string> =>
      addVehicle(db, typeId, categoryId);

    // Три машины: заказ на объект, рейс и свободная, которая уйдёт в ремонт. Разные машины
    // намеренно — состояние у машины ровно одно, и на общей они наложились бы друг на друга.
    const specialVehicleId = await makeVehicle(specialType.type_id, specialType.category_id);
    const routeVehicleId = await makeVehicle(freightType.id, null);
    const spareVehicleId = await makeVehicle(freightType.id, null);

    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const object = objects.rows[0];
    if (!object) throw new Error('В базе нет активного объекта');

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      special: {
        id: specialVehicleId,
        typeId: specialType.type_id,
        categoryId: specialType.category_id,
      },
      routeVehicle: { id: routeVehicleId },
      spare: { id: spareVehicleId },
      objectId: object.id,
      personId,
      // День среза — сегодня по Москве: заявку задним числом сервер не принимает.
      today,
    };
  }, 120_000);

  /**
   * Уборка за собой: бумага, рейс, заявка и три машины прогона.
   *
   * Раньше машины лишь **помечались удалёнными**: на них ссылались назначение заявки и
   * аннулированный бланк, а заявку было «нечем и незачем» сносить — номер побывавшего бланка
   * держит её строкой в `waybill_requests`. Портал накопленного и правда не видит (гараж отбирает
   * `deleted_at IS NULL`), но база у db-тестов общая и живёт месяцами: за прогон в ней оседало по
   * три машины, заказ и лист, и через полгода парк насчитывал их сотнями. Правильный ответ —
   * снести всю цепочку целиком, в порядке, обратном ссылкам: лист, состав рейса, рейс, заявка и
   * только потом машины.
   *
   * Опознаётся заведённое по меткам — гаражному номеру и собственной учётке файла, — а не по
   * спискам: прибирать надо и за упавшим прогоном, который до записи в список мог не дойти. Метка
   * машин взята шире одного прогона (`гараж-%`), чтобы уборка добрала и хвосты прежних падений.
   *
   * Ошибки уборки прогон не роняют: тест уже отработал.
   */
  afterAll(async () => {
    if (ctx?.db) {
      const ourUsers = sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
      const ourVehicles = sql`SELECT id FROM vehicles WHERE garage_number LIKE 'гараж-%'`;
      const ourRequests = sql`SELECT id FROM vehicle_requests WHERE created_by IN (${ourUsers})`;
      await ctx.db.execute(sql`
        DELETE FROM waybills
        WHERE vehicle_id IN (${ourVehicles})
           OR source_request_id IN (${ourRequests})
           OR id IN (SELECT waybill_id FROM waybill_requests WHERE request_id IN (${ourRequests}))
           OR route_id IN (SELECT id FROM vehicle_routes
                            WHERE source_request_id IN (${ourRequests}))`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_route_requests WHERE request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`
        DELETE FROM vehicle_routes
        WHERE vehicle_id IN (${ourVehicles}) OR source_request_id IN (${ourRequests})`);
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE id IN (${ourRequests})`);
      await ctx.db.execute(sql`DELETE FROM vehicles WHERE id IN (${ourVehicles})`);
      // Журнал — по автору: писала в него только здешняя учётка, а видов записей у неё несколько.
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  it('заказ спецтехники на сегодня делает машину «на объекте» и приводит заявку с недельным листом', async () => {
    const createdRequest = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-requests',
      headers: ctx.auth,
      payload: {
        requestType: 'special_equipment',
        objectId: ctx.objectId,
        vehicleTypeId: ctx.special.typeId,
        vehicleCategoryId: ctx.special.categoryId,
        dateFrom: ctx.today,
        dateTo: ctx.today,
        responsibleName: 'Иванов Иван Иванович',
        responsiblePhone: '+79990000000',
      },
    });
    expect(createdRequest.statusCode, createdRequest.body).toBe(201);
    const request = createdRequest.json();
    created.requestId = request.id;

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
        schedule: { requestType: 'special_equipment', dateFrom: ctx.today, dateTo: ctx.today },
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const row = await vehicleRow(ctx.special.id);
    expect(row?.state).toBe('on_site');
    // Заказ и недельный лист — два самостоятельных источника занятости: лист ЭСМ-2 выписывается
    // той же транзакцией (ADR 0060), и в срезе он стоит рядом с заявкой, а не вместо неё.
    expect(busyKinds(row!.busy)).toContain('special');
    expect(busyKinds(row!.busy)).toContain('esm2');

    // Именно наша заявка, а не первая попавшаяся: машина свободна на сегодня по трём условиям
    // отбора, но вчерашние заказы у неё бывают.
    const special = row!.busy.find(
      (entry) => entry.kind === 'special' && entry.requestId === request.id,
    );
    expect(special).toMatchObject({
      requestId: request.id,
      displayNumber: request.displayNumber,
      dateFrom: ctx.today,
      // Смену за день ещё не заполняли — строки в `vehicle_request_shifts` нет.
      shift: null,
      earlyEndPending: false,
    });
    // Машинист недельного листа виден в строке машины: колонку «Водители» собирает сервер.
    expect(row!.drivers.map((d) => d.personId)).toContain(ctx.personId);
  });

  it('рейс на сегодня делает машину «в рейсе», а её водителя — назначенным', async () => {
    const route = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-routes',
      headers: ctx.auth,
      payload: {
        vehicleId: ctx.routeVehicle.id,
        routeDate: ctx.today,
        driverPersonId: ctx.personId,
      },
    });
    expect(route.statusCode, route.body).toBe(201);
    created.routeId = route.json().id;

    const row = await vehicleRow(ctx.routeVehicle.id);
    expect(row?.state).toBe('on_route');
    expect(busyKinds(row!.busy)).toEqual(['route']);
    expect(row!.busy[0]).toMatchObject({
      kind: 'route',
      routeId: route.json().id,
      displayNumber: route.json().displayNumber,
      driverPersonId: ctx.personId,
      // Лист по рейсу не выписывали — и «не выписан» здесь означает именно это.
      waybill: null,
    });

    const driver = await driverRow();
    expect(driver?.state).toBe('assigned');
    expect(driver?.personnelNo).toBe('Г-100');
    // Комплект документов полон — пустой список пробелов означает «лист выпишется без пропусков».
    expect(driver?.gaps).toEqual([]);
    // Должность водительская, и пробелы гараж подписывает водительским удостоверением (ADR 0095).
    expect(driver?.credentialTypeCode).toBe('driver_license');
    expect(driver!.busy.map((entry: GarageBusyEntry) => entry.kind)).toContain('route');
  });

  /**
   * Должность решает, каким документом закрывается комплект (ADR 0095), — и решает одинаково в
   * двух местах сразу: в строке перечня её считает TypeScript (`driverDocumentGaps`), а в фильтре и
   * в сводке — SQL (`documentsCompleteCondition`). Тому и другому нужна живая база: приведение
   * должности к сравнимому виду делает Postgres, и разойтись эти два счёта могут только здесь.
   *
   * Должность записывается с двумя пробелами намеренно: кадровая выгрузка так и присылает, а
   * лишний пробел не должен превращать машиниста в водителя.
   */
  it('машинисту тот же комплект документов больше не полон: за экскаватор садятся по УТМ', async () => {
    await setJobTitle('Машинист  экскаватора');
    try {
      const row = await driverRow();
      expect(row?.credentialTypeCode).toBe('tractor_license');
      // Водительское удостоверение у человека то же самое и заполнено целиком — но оно не того
      // вида, и лист по нему не выпишется: пробел ровно один — самого документа нет.
      expect(row?.gaps).toEqual(['license']);
      expect(row?.licenseNumber).toBe('');
      expect(row?.categories).toEqual([]);

      // Фильтр перечня отбирает тем же правилом, что показывает строка.
      expect(await driverRow('&documents=complete')).toBeUndefined();
      expect(await driverRow('&documents=incomplete')).toBeDefined();
    } finally {
      // База общая: должность возвращается на место, иначе соседние db-тесты увидят машиниста.
      await setJobTitle('Водитель');
    }

    const restored = await driverRow('&documents=complete');
    expect(restored?.credentialTypeCode).toBe('driver_license');
    expect(restored?.gaps).toEqual([]);
  });

  /**
   * Просроченное удостоверение строка обязана **показать** — номером и сроком, — а лист по нему
   * по-прежнему не выписывается.
   *
   * Два счёта в одной строке, и в этом весь смысл проверки: показанный документ выбирает
   * `displayDocumentOf` (годного нет — берётся самый свежий негодный), а пробелы считает
   * `driverDocumentGaps` по годному, которого нет вовсе. Считай оба одной функцией — строка либо
   * молчала бы о вышедшем сроке пустой графой, либо объявляла комплект полным по негодной бумаге.
   */
  it('просроченное удостоверение видно в строке, но комплекта не закрывает', async () => {
    // Позже выдачи (2021-03-12) и раньше сегодня: БД держит порядок дат документа, и «истёк до
    // того, как выдан» она не примет.
    const past = '2025-05-01';
    await setLicenseExpiry(past);
    try {
      const row = await driverRow();
      expect(row?.licenseNumber).toBe('00 00 000600');
      expect(row?.licenseExpiresOn).toBe(past);
      expect(row?.licenseDefect).toBe('expired');
      // Пробелы прежние: годного документа нет, и это ровно один пробел — самого документа.
      expect(row?.gaps).toEqual(['license']);
      expect(await driverRow('&documents=complete')).toBeUndefined();

      // Форма выписки листа того же человека показывает без номера: документ ей выбирает
      // `waybillDocumentOf`, и негодного он не отдаёт никогда — снимок бланка взять неоткуда.
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/drivers/available?vehicleId=${ctx.routeVehicle.id}&on=${ctx.today}`,
        headers: ctx.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      const option = (res.json().drivers as DriverOptionDto[]).find(
        (d) => d.personId === ctx.personId,
      );
      expect(option?.licenseNumber).toBe('');
      expect(option?.gaps).toEqual(['license']);
    } finally {
      // База общая: срок возвращается на место, иначе соседние db-тесты увидят водителя без прав.
      await setLicenseExpiry('2099-03-12');
    }

    const restored = await driverRow();
    expect(restored?.licenseDefect).toBeNull();
    expect(restored?.gaps).toEqual([]);
  });

  it('нерабочий статус машины перекрывает всё остальное', async () => {
    const free = await vehicleRow(ctx.spare.id);
    expect(free?.state).toBe('free');
    expect(free?.busy).toEqual([]);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/vehicles/${ctx.spare.id}`,
      headers: ctx.auth,
      payload: { status: 'maintenance' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    try {
      const row = await vehicleRow(ctx.spare.id);
      expect(row?.state).toBe('unavailable');
      expect(row?.status).toBe('maintenance');
    } finally {
      // Машина возвращается в строй: база одна на все db-тесты, и оставлять её в ремонте нельзя.
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/vehicles/${ctx.spare.id}`,
        headers: ctx.auth,
        payload: { status: 'active' },
      });
    }
  });

  /**
   * Сводка и фильтр состояния считают одно и то же — и спрашиваются оба **по машинам прогона**
   * (`ONLY_MINE`), а не по всему парку.
   *
   * Глобальные суммы здесь были бы проверкой не среза, а базы: db-тесты идут по одной, соседние
   * заводят свою технику, и «в отборе столько же строк, сколько в сводке» — два разных запроса,
   * между которыми чужая машина успевает появиться. Сузив обе ручки одним и тем же отбором, тест
   * спрашивает ровно то, ради чего эта проверка написана: сводка и фильтр отвечают про один день и
   * одним выражением состояния.
   */
  it('фильтр состояния и сводка считают один и тот же день', async () => {
    const summary = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/garage/vehicles/summary?on=${ctx.today}${ONLY_MINE}`,
      headers: ctx.auth,
    });
    expect(summary.statusCode, summary.body).toBe(200);
    const totals = summary.json();
    expect(totals.onDate).toBe(ctx.today);
    // Три машины прогона, каждая в своём состоянии: заказ, рейс и свободная.
    expect(totals.total).toBe(3);
    // Состояние у машины ровно одно, поэтому четыре цифры складываются в парк без остатка.
    expect(totals.free + totals.onRoute + totals.onSite + totals.unavailable).toBe(totals.total);
    expect(totals.onSite).toBe(1);
    expect(totals.onRoute).toBe(1);
    expect(totals.free).toBe(1);

    // Фильтр отбирает по тому же выражению, что считает колонку: занятые в него не попадают.
    const freeOnly = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/garage/vehicles?on=${ctx.today}&state=free&pageSize=500${ONLY_MINE}`,
      headers: ctx.auth,
    });
    expect(freeOnly.statusCode, freeOnly.body).toBe(200);
    const rows = freeOnly.json().items as GarageVehicleDto[];
    expect(rows.every((row) => row.state === 'free')).toBe(true);
    expect(rows.map((row) => row.id)).toEqual([ctx.spare.id]);
    // Счётчик отбора отвечает про тот же отбор, что и список, — и про ту же цифру, что сводка.
    expect(freeOnly.json().total).toBe(totals.free);
  });

  /**
   * Показания и рейс без листа (план «Показания техники», Р26б, §14 п. 4).
   *
   * Рейс этого теста заведён **без путевого листа** — так его и создаёт предыдущий сценарий, и это
   * ровно тот случай, ради которого гараж приводили к общему правилу. Раньше колонка красила такую
   * машину расхождением («источник дня в отчёт не вошёл»), а кабинет водителя рейса без бумаги не
   * показывал вовсе: спросить показание было не с кого, а день горел. Теперь оба места спрашивают
   * ожидаемую смену одним правилом — рейс без действующего листа ею не является.
   *
   * Сигнал «рейс есть, лист не выписали» при этом не потерян: его показывает журнал маршрутов
   * фильтром «Без листа», а в самой строке гаража — отсутствие номера бланка у занятости рейса.
   */
  it('рейс без листа гараж показаниями не красит и в «не сданы» не отбирает', async () => {
    const row = (await vehicleRow(ctx.routeVehicle.id)) as
      (GarageVehicleDto & { readingState: string }) | undefined;
    // Занятость рейсом на месте, бланка у неё нет — это и есть «рейс есть, бумаги нет».
    expect(busyKinds(row!.busy)).toEqual(['route']);
    expect((row!.busy[0] as { waybill: unknown }).waybill).toBeNull();
    // А показаний по такому рейсу не ждут: колонка молчит.
    expect(row?.readingState).toBe('none');

    const pending = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/garage/vehicles?on=${ctx.today}&pageSize=500&readings=pending${ONLY_MINE}`,
      headers: ctx.auth,
    });
    expect(pending.statusCode, pending.body).toBe(200);
    const ids = (pending.json().items as GarageVehicleDto[]).map((item) => item.id);
    expect(ids).not.toContain(ctx.routeVehicle.id);
    // Фильтр отбирает до страницы, а не после: счётчик отвечает про тот же отбор, что и список.
    expect(pending.json().total).toBe(ids.length);
    // И отобранные строки согласованы с колонкой: «сданы» в отборе «не сданы» не бывает.
    for (const item of pending.json().items as Array<{ readingState: string }>) {
      expect(item.readingState).not.toBe('reported');
    }
  });

  it('вчерашний день ничего этого не знает: занятость считается по дате, а не «вообще»', async () => {
    const yesterday = moscowDateKeyOf(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/garage/vehicles?on=${yesterday}&pageSize=500${ONLY_MINE}`,
      headers: ctx.auth,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().onDate).toBe(yesterday);
    const row = (res.json().items as GarageVehicleDto[]).find(
      (item) => item.id === ctx.routeVehicle.id,
    );
    // Рейс заведён на сегодня — вчера машина свободна, и граница периода здесь строгая.
    expect(row?.state).toBe('free');
    expect(row?.busy).toEqual([]);
  });

  /**
   * Отбор среза по площадке и по бланку работы дня (план «Гараж: правки интерфейса», этап 2).
   *
   * Данные заводятся прямыми вставками, а не ручками портала: состав рейса, перегон, заявка отдела
   * и недельный лист без заказа нужны здесь ради **условий отбора**, и проводить их через формы
   * значило бы проверять формы. Убирает всё вставленное общий `afterAll`: машины помечены `MARK`,
   * заявки заведены здешней учёткой, а рейсы и листы стоят на тех же машинах.
   */
  describe('отбор по площадке и по бланку', () => {
    interface FilterCtx {
      /** Площадка заявки в составе грузового рейса. */
      routeObject: string;
      /** Площадка заявки-основания перегона. */
      relocationObject: string;
      /** Площадка заказа спецтехники, у которого листа на этот день нет вовсе. */
      specialObject: string;
      /** Площадка заявки-основания недельного листа, у которого нет заказа. */
      esm2Object: string;
      compositionDay: string;
      relocationDay: string;
      passengerDay: string;
      departmentDay: string;
      idleDay: string;
      specialDay: string;
      esm2Day: string;
      /** Легковая машина: бланк её типа — форма № 3, и на ней же едет перегон. */
      passengerVehicleId: string;
      specialVehicleId: string;
      esm2VehicleId: string;
    }
    let f: FilterCtx;

    beforeAll(async () => {
      const admin = await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`,
      );
      const adminId = admin.rows[0]!.id;

      // Четыре площадки помимо той, на которой стоит заказ первого сценария: у каждой ветки отбора
      // своя, иначе «нашлось» не отвечало бы, какой именно веткой.
      const objects = await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM construction_objects
            WHERE is_active AND id <> ${ctx.objectId}::uuid ORDER BY code LIMIT 4`,
      );
      if (objects.rows.length < 4) throw new Error('В базе меньше пяти активных площадок');
      const [routeObject, relocationObject, specialObject, esm2Object] = objects.rows.map(
        (row) => row.id,
      );

      const departments = await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM departments ORDER BY code LIMIT 1`,
      );
      const departmentId = departments.rows[0]?.id;
      if (!departmentId) throw new Error('В базе нет отделов');

      // Бланк типа рейсовой машины проверяется, а не подразумевается: на нём держатся сразу два
      // сценария — «грузовой рейс идёт бланком типа» и «перегон идёт 4-П независимо от типа».
      const freight = await ctx.db.execute<{ id: string; waybill_form_code: string }>(
        sql`SELECT vt.id, vt.waybill_form_code FROM vehicles v
            JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
            WHERE v.id = ${ctx.routeVehicle.id}::uuid`,
      );
      const freightType = freight.rows[0]!;
      expect(freightType.waybill_form_code).toBe('4p');

      const passenger = await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM vehicle_types
            WHERE waybill_form_code = 'leg3' AND NOT is_linear ORDER BY code LIMIT 1`,
      );
      const passengerType = passenger.rows[0]?.id;
      if (!passengerType) throw new Error('В классификаторе нет легкового типа техники');

      const passengerVehicleId = await addVehicle(ctx.db, passengerType, null);
      const specialVehicleId = await addVehicle(ctx.db, ctx.special.typeId, ctx.special.categoryId);
      const esm2VehicleId = await addVehicle(ctx.db, ctx.special.typeId, ctx.special.categoryId);

      /** Заявка сценария: заказчиком либо площадка, либо отдел (ADR 0040) — ровно одно из двух. */
      const addRequest = async (input: {
        requestType: 'freight_transport' | 'special_equipment';
        vehicleTypeId: string;
        objectId?: string;
        departmentId?: string;
      }): Promise<string> => {
        const rows = await ctx.db.execute<{ id: string }>(
          sql`INSERT INTO vehicle_requests (request_type, object_id, department_id,
                                            vehicle_type_id, status, created_by)
              VALUES (${input.requestType}::vehicle_request_type, ${input.objectId ?? null}::uuid,
                      ${input.departmentId ?? null}::uuid, ${input.vehicleTypeId}::uuid,
                      'confirmed', ${adminId}::uuid)
              RETURNING id`,
        );
        return rows.rows[0]!.id;
      };

      const addRoute = async (input: {
        vehicleId: string;
        on: string;
        purpose: 'freight' | 'delivery' | 'pickup';
        sourceRequestId?: string;
      }): Promise<string> => {
        const relocation = input.purpose !== 'freight';
        const rows = await ctx.db.execute<{ id: string }>(
          sql`INSERT INTO vehicle_routes (vehicle_id, route_date, purpose, source_request_id,
                                          move_from, move_to, driver_person_id, created_by)
              VALUES (${input.vehicleId}::uuid, ${input.on}::date, ${input.purpose},
                      ${input.sourceRequestId ?? null}::uuid,
                      ${relocation ? 'База' : ''}, ${relocation ? 'Объект' : ''},
                      ${ctx.personId}::uuid, ${adminId}::uuid)
              RETURNING id`,
        );
        return rows.rows[0]!.id;
      };

      const addRouteRequest = async (routeId: string, requestId: string): Promise<void> => {
        await ctx.db.execute(
          sql`INSERT INTO vehicle_route_requests (route_id, request_id, position)
              VALUES (${routeId}::uuid, ${requestId}::uuid, 1)`,
        );
      };

      const compositionDay = dayAfter(31);
      const relocationDay = dayAfter(32);
      const passengerDay = dayAfter(33);
      const departmentDay = dayAfter(34);
      const idleDay = dayAfter(35);
      const specialDay = dayAfter(36);
      const esm2Day = dayAfter(37);

      // Грузовой рейс с составом: площадку называет заявка состава, бланк — тип машины (4-П).
      const compositionRequest = await addRequest({
        requestType: 'freight_transport',
        vehicleTypeId: freightType.id,
        objectId: routeObject,
      });
      await addRouteRequest(
        await addRoute({ vehicleId: ctx.routeVehicle.id, on: compositionDay, purpose: 'freight' }),
        compositionRequest,
      );

      // Перегон на **легковой** машине: площадку называет заявка-основание, бланк всё равно 4-П.
      const relocationRequest = await addRequest({
        requestType: 'special_equipment',
        vehicleTypeId: ctx.special.typeId,
        objectId: relocationObject,
      });
      await addRoute({
        vehicleId: passengerVehicleId,
        on: relocationDay,
        purpose: 'delivery',
        sourceRequestId: relocationRequest,
      });

      // Грузовой рейс той же легковой машиной: здесь бланк типа и решает — форма № 3.
      await addRoute({ vehicleId: passengerVehicleId, on: passengerDay, purpose: 'freight' });

      // Заявка отдела в составе рейса: работа в этот день есть, площадки у неё нет вовсе (Р10).
      const departmentRequest = await addRequest({
        requestType: 'freight_transport',
        vehicleTypeId: freightType.id,
        departmentId,
      });
      await addRouteRequest(
        await addRoute({ vehicleId: ctx.spare.id, on: departmentDay, purpose: 'freight' }),
        departmentRequest,
      );

      // Заказ спецтехники **без листа**: ветка заказа проверяется в одиночку — иначе «нашлось»
      // ничего не сказало бы про неё, а сказало бы про недельный лист той же заявки.
      const specialRequest = await addRequest({
        requestType: 'special_equipment',
        vehicleTypeId: ctx.special.typeId,
        objectId: specialObject,
      });
      await ctx.db.execute(
        sql`INSERT INTO special_equipment_request_details (request_id, date_from, date_to,
                                                           responsible_name, responsible_phone)
            VALUES (${specialRequest}::uuid, ${specialDay}::date, ${specialDay}::date,
                    'Иванов Иван Иванович', '+79990000000')`,
      );
      await ctx.db.execute(
        sql`INSERT INTO vehicle_request_assignments (request_id, vehicle_id, vehicle_type_id,
                                                     ordered_vehicle_type_id, assigned_by)
            VALUES (${specialRequest}::uuid, ${specialVehicleId}::uuid,
                    ${ctx.special.typeId}::uuid, ${ctx.special.typeId}::uuid, ${adminId}::uuid)`,
      );

      // Недельный лист **без заказа**: заявку-основание он несёт, а назначения на машине нет —
      // так проверяется третья ветка отдельно от первой.
      const esm2Request = await addRequest({
        requestType: 'special_equipment',
        vehicleTypeId: ctx.special.typeId,
        objectId: esm2Object,
      });
      const series = await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM waybill_series WHERE code = 'esm2'`,
      );
      const organizations = await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM organizations WHERE is_active ORDER BY name LIMIT 1`,
      );
      await ctx.db.execute(
        sql`INSERT INTO waybills (series_id, number, form_code, status, organization_id, vehicle_id,
                                  driver_person_id, issued_for_date, source_request_id,
                                  period_from, period_to, issued_by)
            VALUES (${series.rows[0]!.id}::uuid,
                    ${940_000_000 + Math.floor(Math.random() * 900_000)},
                    'esm2', 'issued', ${organizations.rows[0]!.id}::uuid, ${esm2VehicleId}::uuid,
                    ${ctx.personId}::uuid, ${esm2Day}::date, ${esm2Request}::uuid,
                    ${esm2Day}::date, ${esm2Day}::date, ${adminId}::uuid)`,
      );

      f = {
        routeObject: routeObject!,
        relocationObject: relocationObject!,
        specialObject: specialObject!,
        esm2Object: esm2Object!,
        compositionDay,
        relocationDay,
        passengerDay,
        departmentDay,
        idleDay,
        specialDay,
        esm2Day,
        passengerVehicleId,
        specialVehicleId,
        esm2VehicleId,
      };
    }, 120_000);

    it('водителя находит площадка его работы: состав рейса, основание перегона и заявка листа', async () => {
      expect(await driverRow(objectsQuery([f.routeObject]), f.compositionDay)).toBeDefined();
      expect(await driverRow(objectsQuery([f.relocationObject]), f.relocationDay)).toBeDefined();
      expect(await driverRow(objectsQuery([f.esm2Object]), f.esm2Day)).toBeDefined();

      // Чужая площадка того же дня не находит: отбор спрашивает площадку **этой** работы.
      expect(await driverRow(objectsQuery([f.esm2Object]), f.compositionDay)).toBeUndefined();
      // Набор объединяется по ИЛИ: одна из перечисленных площадок — уже ответ.
      expect(
        await driverRow(objectsQuery([f.esm2Object, f.routeObject]), f.compositionDay),
      ).toBeDefined();
    });

    it('заявка отдела площадкой не находится: площадки у неё нет вовсе', async () => {
      // Работа в этот день есть — рейс с заявкой отдела в составе.
      const row = await driverRow('', f.departmentDay);
      expect(row?.state).toBe('assigned');
      expect(busyKinds(row!.busy)).toEqual(['route']);

      expect(
        await driverRow(
          objectsQuery([f.routeObject, f.relocationObject, f.specialObject, f.esm2Object]),
          f.departmentDay,
        ),
      ).toBeUndefined();
    });

    it('водителя находит бланк работы дня: 4-П у грузового, № 3 у легкового, ЭСМ-2 у листа', async () => {
      expect(await driverRow(formsQuery(['4p']), f.compositionDay)).toBeDefined();
      expect(await driverRow(formsQuery(['leg3', 'esm2']), f.compositionDay)).toBeUndefined();

      expect(await driverRow(formsQuery(['leg3']), f.passengerDay)).toBeDefined();
      expect(await driverRow(formsQuery(['4p', 'esm2']), f.passengerDay)).toBeUndefined();

      expect(await driverRow(formsQuery(['esm2']), f.esm2Day)).toBeDefined();
      expect(await driverRow(formsQuery(['4p', 'leg3']), f.esm2Day)).toBeUndefined();
    });

    it('перегон ищется как 4-П независимо от типа машины', async () => {
      // Машина перегона легковая: по бланку её типа лист был бы формой № 3, а перегон идёт 4-П.
      expect(await driverRow(formsQuery(['4p']), f.relocationDay)).toBeDefined();
      expect(await driverRow(formsQuery(['leg3']), f.relocationDay)).toBeUndefined();
    });

    it('день с двумя работами разных бланков попадает в оба отбора и стоит в выдаче один раз', async () => {
      // День среза: рейс без состава (4-П) и недельный лист заказа (ЭСМ-2) — две работы сразу.
      const row = await driverRow();
      expect([...busyKinds(row!.busy)].sort()).toEqual(['esm2', 'route']);

      expect(await driverRow(formsQuery(['4p']))).toBeDefined();
      expect(await driverRow(formsQuery(['esm2']))).toBeDefined();

      const both = await driverList(formsQuery(['4p', 'esm2']));
      // Условием `EXISTS`, а не join'ом к работам дня: совпали оба бланка — строка всё равно одна.
      expect(both.items.filter((item) => item.personId === ctx.personId)).toHaveLength(1);
      expect(both.total).toBe(both.items.length);
    });

    it('свободный день выпадает при каждом из фильтров и остаётся без них', async () => {
      const free = await driverRow('', f.idleDay);
      expect(free?.state).toBe('free');
      expect(free?.busy).toEqual([]);

      expect(await driverRow(objectsQuery([f.routeObject]), f.idleDay)).toBeUndefined();
      expect(await driverRow(formsQuery(['4p', 'leg3', 'esm2']), f.idleDay)).toBeUndefined();
    });

    /**
     * Сводка сужается вместе с таблицей: площадка и бланк **определяют список**, а не являются
     * одной из его цифр (в отличие от состояния и комплекта документов).
     *
     * Числа сверяются со списком того же отбора, а не с константой: база у db-тестов общая, и на
     * отобранный день соседний тест мог завести своего водителя. Инвариантов два, и они не зависят
     * от чужих данных: счётчик сводки равен счётчику списка, а свободных в отборе не бывает вовсе —
     * у каждой отобранной строки работа в этот день есть по построению.
     */
    it('сводка водителей сужается теми же фильтрами, что таблица', async () => {
      const summaryOf = async (query: string, on: string) => {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/garage/drivers/summary?on=${on}${query}`,
          headers: ctx.auth,
        });
        expect(res.statusCode, res.body).toBe(200);
        return res.json() as { total: number; free: number; assigned: number };
      };

      const all = await summaryOf('', f.compositionDay);
      const byObject = await summaryOf(objectsQuery([f.routeObject]), f.compositionDay);
      const objectList = await driverList(objectsQuery([f.routeObject]), f.compositionDay);
      expect(byObject.total).toBe(objectList.total);
      expect(byObject.total).toBeLessThan(all.total);
      expect(byObject.free).toBe(0);
      expect(byObject.assigned).toBe(byObject.total);

      const byForm = await summaryOf(formsQuery(['leg3']), f.passengerDay);
      const formList = await driverList(formsQuery(['leg3']), f.passengerDay);
      expect(byForm.total).toBe(formList.total);
      expect(byForm.free).toBe(0);
    });

    it('технику находит площадка её работы: рейс, заказ спецтехники и недельный лист', async () => {
      // Рейс дня: площадку называет заявка его состава.
      expect(
        await vehicleRow(ctx.routeVehicle.id, objectsQuery([f.routeObject]), f.compositionDay),
      ).toBeDefined();
      expect(
        await vehicleRow(ctx.routeVehicle.id, objectsQuery([f.specialObject]), f.compositionDay),
      ).toBeUndefined();

      // Заказ спецтехники: занятость у машины ровно одна, листа на этот день нет — ветка отвечает
      // за себя, а не за соседнюю.
      const special = await vehicleRow(f.specialVehicleId, '', f.specialDay);
      expect(busyKinds(special!.busy)).toEqual(['special']);
      expect(
        await vehicleRow(f.specialVehicleId, objectsQuery([f.specialObject]), f.specialDay),
      ).toBeDefined();
      expect(
        await vehicleRow(f.specialVehicleId, objectsQuery([f.routeObject]), f.specialDay),
      ).toBeUndefined();

      // Недельный лист: назначения на этой машине нет вовсе, площадку называет заявка-основание.
      const esm2 = await vehicleRow(f.esm2VehicleId, '', f.esm2Day);
      expect(busyKinds(esm2!.busy)).toEqual(['esm2']);
      expect(
        await vehicleRow(f.esm2VehicleId, objectsQuery([f.esm2Object]), f.esm2Day),
      ).toBeDefined();
      expect(
        await vehicleRow(f.esm2VehicleId, objectsQuery([f.specialObject]), f.esm2Day),
      ).toBeUndefined();
    });

    /**
     * Ключ `forms` вкладке техники запрещён полем `z.never()`, и ловится здесь именно **код
     * ответа**: незаявленный ключ zod отбросил бы молча, и запрос вернул бы полный список под видом
     * отобранного — то есть беда выглядела бы как успех (Р20).
     */
    it('вкладка техники на присланный бланк отвечает 400, а не полным списком', async () => {
      for (const url of [
        `/api/v1/garage/vehicles?on=${ctx.today}&forms=esm2${ONLY_MINE}`,
        `/api/v1/garage/vehicles/summary?on=${ctx.today}&forms=esm2${ONLY_MINE}`,
      ]) {
        const res = await ctx.app.inject({ method: 'GET', url, headers: ctx.auth });
        expect(res.statusCode, res.body).toBe(400);
      }
      // Площадки той же вкладке, наоборот, разрешены: запрет точечный, а не строгость на всю схему.
      const objects = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/garage/vehicles?on=${f.compositionDay}${objectsQuery([f.routeObject])}${ONLY_MINE}`,
        headers: ctx.auth,
      });
      expect(objects.statusCode, objects.body).toBe(200);
    });

    /**
     * Паритет двух записей одного правила (Р5): набор бланков строки считают чистая функция
     * контрактов (`busyWaybillForms` по занятостям страницы) и выражение отбора
     * (`driverDayFormsSql`, по которому идёт фильтр до страницы). Второй записи не избежать — отбор
     * по загруженной странице врал бы и в счётчике, и в листании, — поэтому сверка одна и настоящая:
     * обе спрашиваются на общем наборе занятостей, включая день с двумя бланками и день без работы.
     */
    it('паритет: набор бланков дня одинаков у правила контрактов и у выражения отбора', async () => {
      const { driverDayFormsSql } = await import('../src/services/garage');
      const { persons } = await import('../src/db/schema');

      const answers = new Map<string, string[]>();
      for (const day of [
        ctx.today,
        f.compositionDay,
        f.relocationDay,
        f.passengerDay,
        f.departmentDay,
        f.idleDay,
        f.esm2Day,
      ]) {
        const row = await driverRow('', day);
        expect(row, `водитель обязан стоять в срезе за ${day}`).toBeDefined();

        const [computed] = await ctx.db
          .select({
            forms: sql<
              string[]
            >`ARRAY(SELECT DISTINCT ga_f.form FROM (${driverDayFormsSql(day)}) ga_f ORDER BY 1)`,
          })
          .from(persons)
          .where(sql`${persons.id} = ${ctx.personId}::uuid`);

        const bySql = [...computed!.forms].sort();
        expect(bySql, `бланки дня ${day}`).toEqual([...busyWaybillForms(row!.busy)].sort());
        answers.set(day, bySql);
      }

      // Сверка не должна быть пустой с обеих сторон: в наборе есть день с двумя бланками сразу и
      // день без работы вовсе.
      expect(answers.get(ctx.today)).toHaveLength(2);
      expect(answers.get(f.idleDay)).toHaveLength(0);
    });
  });
});
