import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type GarageBusyEntry,
  type GarageDriverDto,
  type GarageVehicleDto,
  moscowDateKeyOf,
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
 * Строка гаража по машине — из отбора «только свои» (`ONLY_MINE`).
 *
 * Отбор здесь не для скорости: без него страница отвечала бы по всему парку, и строка теста
 * зависела бы от того, сколько машин завели соседние db-тесты, — а на парке крупнее страницы её и
 * вовсе не оказалось бы в ответе.
 */
async function vehicleRow(vehicleId: string, query = ''): Promise<GarageVehicleDto | undefined> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/garage/vehicles?on=${ctx.today}&pageSize=500${ONLY_MINE}${query}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().onDate).toBe(ctx.today);
  return (res.json().items as GarageVehicleDto[]).find((row) => row.id === vehicleId);
}

function busyKinds(entries: readonly GarageBusyEntry[]): string[] {
  return entries.map((entry) => entry.kind);
}

/** Строка гаража по водителю теста — с любым набором фильтров перечня. */
async function driverRow(query = ''): Promise<GarageDriverDto | undefined> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/garage/drivers?on=${ctx.today}&pageSize=500${query}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as GarageDriverDto[]).find((row) => row.personId === ctx.personId);
}

/** Должность действующего трудового отношения — ею тест и меняет вид требуемого документа. */
async function setJobTitle(jobTitle: string): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE person_employments SET job_title = ${jobTitle}
        WHERE person_id = ${ctx.personId} AND ended_on IS NULL`,
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

    /**
     * Своя машина прогона: собственная, активная и помеченная гаражным номером `MARK`.
     *
     * Заводится, а не выбирается из парка. Выбранная свободная машина держалась на трёх условиях
     * «на сегодня ничего не назначено», и всё равно оставалась чужой: параллельный db-тест мог
     * занять её между отбором и проверкой, а на большом парке она просто не попадала на страницу
     * ответа. Заведённая машина принадлежит тесту целиком — и уборка в `afterAll` знает, что за
     * собой убирать.
     */
    const makeVehicle = async (typeId: string, categoryId: string | null): Promise<string> => {
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
    };

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
});
