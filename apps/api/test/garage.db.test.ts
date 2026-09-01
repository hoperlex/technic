import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useReadModeDatabase } from './assignment-read-mode';
import {
  busyWaybillForms,
  type DriverOptionDto,
  type GarageBusyEntry,
  type GarageDriverDto,
  type GarageRouteBusy,
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

/*
 * ЭСМ2-РАЗРЕЗ. Файл заводит свою базу механикой двух режимов: режим чтения живёт в управляющей строке, одной на базу.
 */
const readMode = useReadModeDatabase('garage');
/*
 * ЗАКРЫТОЕ ПАДЕНИЕ (этап Э5 плана [test-gates-plan.md](../../../docs/test-gates-plan.md)). Случай
 * «сводка водителей сужается теми же фильтрами» требует, чтобы у отбора было **больше одного**
 * водителя, а сцена файла заводила ровно одного: второй приходил из данных, накопленных соседними
 * файлами общей `TEST_DATABASE_URL`. На чистой базе его не оказывалось, и случай падал сравнением
 * «1 меньше 1» — то есть файл молча зависел от чужих данных, а перевод на свою базу лишь сделал эту
 * зависимость видимой. Теперь второго водителя заводит сама сцена (`OTHER_DRIVER_*` и фикстуры
 * блока отбора), и сужение сверяется с ним, а не с фоном базы.
 */
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

/** Тестовый водитель гаража: свой СНИЛС, чтобы не пересечься с водителем соседнего db-теста. */
const DRIVER_SNILS = '22222222290';
/**
 * Второй водитель прогона — тот, с кем сверяется сужение сводки по площадке.
 *
 * Метка-комментарий постоянная, а не своя на прогон: уборка ищет заведённое по меткам и обязана
 * добирать хвосты упавших прогонов (см. `afterAll`), а машины она чистит ровно так же — по
 * приставке гаражного номера, взятой шире одного прогона.
 */
const OTHER_DRIVER_COMMENT = 'ТЕСТОВЫЕ ДАННЫЕ: срез гаража, второй водитель';
/** Его СНИЛС — свой, по той же причине, что и у первого: человек в базе опознаётся по нему. */
const OTHER_DRIVER_SNILS = '22222222291';
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
  /** Учётка файла значением: ею подписаны заявки и рейсы, заведённые прямой вставкой. */
  adminId: string;
  /** Спецтехника с категорией: на неё заводится заказ на объект. */
  special: { id: string; typeId: string; categoryId: string | null };
  /**
   * Своя активная машина под рейс — заведомо другая, иначе состояния наложились бы.
   *
   * Тип нужен значением: заявка в составе рейса называет заказанный тип, а состав теперь заводится
   * и в сценариях занятости — рейс без него был бы заготовкой (ADR 0131).
   */
  routeVehicle: { id: string; typeId: string };
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
 * Заявка сценария: заказчиком либо площадка, либо отдел (ADR 0040) — ровно одно из двух.
 *
 * Прямой вставкой, а не ручкой портала: заявка нужна фикстурам как **повод** для работы рейса, и
 * проводить её формами значило бы проверять формы. Убирает её общий `afterAll` — по автору.
 */
async function addRequest(input: {
  requestType: 'freight_transport' | 'special_equipment';
  vehicleTypeId: string;
  objectId?: string;
  departmentId?: string;
}): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(
    sql`INSERT INTO vehicle_requests (request_type, object_id, department_id,
                                      vehicle_type_id, status, created_by)
        VALUES (${input.requestType}::vehicle_request_type, ${input.objectId ?? null}::uuid,
                ${input.departmentId ?? null}::uuid, ${input.vehicleTypeId}::uuid,
                'confirmed', ${ctx.adminId}::uuid)
        RETURNING id`,
  );
  return rows.rows[0]!.id;
}

/**
 * Второй водитель сцены — свой, а не первый попавшийся из справочника.
 *
 * В перечень гаража человек попадает по действующей специализации водителя (`driverCondition`), а
 * трудовое отношение даёт ему табельный номер и должность — ту самую, которой выбирается вид
 * документа (ADR 0095). Ни того, ни другого «просто человек» не имеет, поэтому заводятся все три
 * строки сразу: без специализации его в срезе не было бы вовсе, и сверять сужение сводки было бы
 * снова не с кем.
 *
 * Удостоверения ему не заводится намеренно: комплект документов сводку **не сужает** (это одна из
 * её цифр, а не отбор), а сценарию нужен ровно факт занятости в дне — пробелы комплекта он не
 * спрашивает ни у кого, кроме первого водителя. Уборка забирает его по метке-комментарию, а
 * специализация с трудовым отношением уходят каскадом за человеком.
 */
async function addOtherDriver(): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(
    sql`INSERT INTO persons (last_name, first_name, middle_name, snils, comment)
        VALUES ('Соседний', 'Водитель', 'Тестович', ${OTHER_DRIVER_SNILS},
                ${OTHER_DRIVER_COMMENT})
        RETURNING id`,
  );
  const personId = rows.rows[0]!.id;
  await ctx.db.execute(
    sql`INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
        SELECT ${personId}::uuid, id, true, '2024-01-15'
          FROM specializations WHERE code = 'driver'`,
  );
  await ctx.db.execute(
    sql`INSERT INTO person_employments (person_id, employment_type, personnel_no, job_title,
                                        started_on)
        VALUES (${personId}::uuid, 'staff', 'Г-200', 'Водитель', '2024-01-15')`,
  );
  return personId;
}

/**
 * Заявка в составе рейса — она же его работа: грузовой рейс без состава и без действующего листа
 * гараж считает заготовкой и в срез дня не берёт вовсе (ADR 0131).
 *
 * Поэтому состав заводится не только там, где сценарий спрашивает про площадку работы, но и там,
 * где он спрашивает про занятость: без строки состава машине с рейсом было бы некуда ехать, и
 * «в рейсе» о ней сказать было бы неправдой.
 */
async function addRouteRequest(routeId: string, requestId: string, position = 1): Promise<void> {
  await ctx.db.execute(
    sql`INSERT INTO vehicle_route_requests (route_id, request_id, position)
        VALUES (${routeId}::uuid, ${requestId}::uuid, ${position})`,
  );
}

/**
 * Мягкое удаление заявки — ручкой портала, а не `UPDATE`'ом: правило работы рейса (ADR 0131)
 * держится ровно на том, что делает продукт, и проверять его на самодельном удалении значило бы
 * проверять фикстуру.
 *
 * Ручка сама выбирает вид удаления по статусу: «Новую» она сносит целиком, и строка состава ушла
 * бы каскадом — рейс остался бы пустым, то есть заготовкой по совсем другой ветке правила. Поэтому
 * ответ проверяется значением: заявки фикстур заводятся сразу «Подтверждена», и удаление обязано
 * быть мягким — только `deleted_at`, а заявка остаётся стоять в рейсе.
 */
async function softDeleteRequest(requestId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/vehicle-requests/${requestId}`,
    headers: ctx.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().mode).toBe('soft');
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

/**
 * Матрица заготовок (ADR 0131): свой день на каждый случай правила «есть куда ехать».
 *
 * Заводится лениво и ровно один раз, а не хуком своего блока: два из этих дней спрашивает и тест
 * паритета соседнего блока, объявленный раньше, — привяжи фикстуру к порядку хуков, и добавленный
 * день оказался бы то заведён, то нет, смотря откуда запустили прогон. Запоминается обещание, а не
 * результат: второй спросивший подхватывает первый, не дожидаясь его конца.
 *
 * Дни свои и далёкие (с 38-го), а машины — те же три: на дне среза и на днях отбора держатся
 * сценарии, ничего не знающие про заготовки, и чужой рейс в их дне менял бы им ответ, а лишняя
 * машина сдвинула бы сводку парка, которую они считают по метке прогона.
 */
interface DraftCtx {
  /** Грузовой рейс с водителем, без состава и без листа, — заготовка в чистом виде. */
  draftDay: string;
  /** Два рейса без водителя в один день: заготовка и рейс с составом. */
  summaryDay: string;
  /** Пустой рейс, по которому выписан лист: работу ему даёт бумага. */
  paperDay: string;
  /** Тот самый лист: его тест и аннулирует, возвращая рейс в заготовки. */
  paperWaybillId: string;
  /** Рейс, единственная заявка состава которого отменена. */
  cancelledRequestDay: string;
  /** Два рейса, у обоих единственная заявка состава мягко удалена: с водителем и без него. */
  deletedRequestDay: string;
  /** Рейс с двумя заявками в составе, одна из которых мягко удалена. */
  mixedRequestsDay: string;
  /** Та самая удалённая заявка: строку в составе рейса она переживает. */
  mixedDeletedRequestId: string;
  /** Перегон без состава: работа у него в паре «откуда — куда». */
  relocationDay: string;
  /** День линейного заказа: строка состава со своим днём (ADR 0100 §12). */
  linearDay: string;
}

let draftsPromise: Promise<DraftCtx> | undefined;

/** Фикстуры матрицы — по требованию и один раз на файл, кто бы ни спросил первым. */
function drafts(): Promise<DraftCtx> {
  draftsPromise ??= createDrafts();
  return draftsPromise;
}

/**
 * Рейс прямой вставкой — с водителем и без него.
 *
 * Свой помощник, а не тот, что у блока отбора: там водитель есть у каждого рейса, а половина
 * матрицы спрашивает как раз про рейс, которому водителя ещё не назначили (сводка считает именно
 * такие).
 */
async function addDayRoute(input: {
  vehicleId: string;
  on: string;
  purpose?: 'freight' | 'delivery' | 'pickup';
  driverPersonId?: string;
  sourceRequestId?: string;
}): Promise<string> {
  const purpose = input.purpose ?? 'freight';
  const relocation = purpose !== 'freight';
  const rows = await ctx.db.execute<{ id: string }>(
    sql`INSERT INTO vehicle_routes (vehicle_id, route_date, purpose, source_request_id,
                                    move_from, move_to, driver_person_id, created_by)
        VALUES (${input.vehicleId}::uuid, ${input.on}::date, ${purpose},
                ${input.sourceRequestId ?? null}::uuid,
                ${relocation ? 'База' : ''}, ${relocation ? 'Объект' : ''},
                ${input.driverPersonId ?? null}::uuid, ${ctx.adminId}::uuid)
        RETURNING id`,
  );
  return rows.rows[0]!.id;
}

/**
 * Лист 4-П по рейсу — прямой вставкой, как и недельный лист блока отбора: пустой бланк ручка
 * выписки отдаёт под подтверждение (ADR 0071), а фикстуре нужен результат, а не разговор с формой.
 *
 * Серия у 4-П основная (`main`, миграция 0061), номер — из заведомо свободной полосы: серия общая,
 * и в неё пишут соседние db-тесты.
 */
async function issueRouteWaybill(routeId: string, vehicleId: string, on: string): Promise<string> {
  const series = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM waybill_series WHERE code = 'main'`,
  );
  const organizations = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM organizations WHERE is_active ORDER BY name LIMIT 1`,
  );
  const rows = await ctx.db.execute<{ id: string }>(
    sql`INSERT INTO waybills (series_id, number, form_code, status, organization_id, vehicle_id,
                              driver_person_id, issued_for_date, route_id, issued_by)
        VALUES (${series.rows[0]!.id}::uuid,
                ${960_000_000 + Math.floor(Math.random() * 900_000)},
                '4p', 'issued', ${organizations.rows[0]!.id}::uuid, ${vehicleId}::uuid,
                ${ctx.personId}::uuid, ${on}::date, ${routeId}::uuid, ${ctx.adminId}::uuid)
        RETURNING id`,
  );
  return rows.rows[0]!.id;
}

/** Заведение матрицы: по дню на случай, каждый — своим поводом работы либо его отсутствием. */
async function createDrafts(): Promise<DraftCtx> {
  const draftDay = dayAfter(38);
  const summaryDay = dayAfter(39);
  const paperDay = dayAfter(40);
  const cancelledRequestDay = dayAfter(41);
  const relocationDay = dayAfter(42);
  const linearDay = dayAfter(43);

  // Заготовка с водителем: рейс заведён, состава нет, бумаги нет — ехать некуда.
  await addDayRoute({ vehicleId: ctx.routeVehicle.id, on: draftDay, driverPersonId: ctx.personId });

  // Один день, два рейса без водителя, разные машины: у одного состав есть, у другого нет.
  await addRouteRequest(
    await addDayRoute({ vehicleId: ctx.routeVehicle.id, on: summaryDay }),
    await addRequest({
      requestType: 'freight_transport',
      vehicleTypeId: ctx.routeVehicle.typeId,
      objectId: ctx.objectId,
    }),
  );
  await addDayRoute({ vehicleId: ctx.spare.id, on: summaryDay });

  // Пустой рейс с выписанным листом: состава нет, а бланк именной и уже у водителя.
  const paperRoute = await addDayRoute({
    vehicleId: ctx.routeVehicle.id,
    on: paperDay,
    driverPersonId: ctx.personId,
  });
  const paperWaybillId = await issueRouteWaybill(paperRoute, ctx.routeVehicle.id, paperDay);

  // Состав из отменённой заявки: строка в рейсе осталась, а заявка закрыта.
  const cancelledRequest = await addRequest({
    requestType: 'freight_transport',
    vehicleTypeId: ctx.routeVehicle.typeId,
    objectId: ctx.objectId,
  });
  await ctx.db.execute(
    sql`UPDATE vehicle_requests SET status = 'cancelled' WHERE id = ${cancelledRequest}::uuid`,
  );
  await addRouteRequest(
    await addDayRoute({
      vehicleId: ctx.routeVehicle.id,
      on: cancelledRequestDay,
      driverPersonId: ctx.personId,
    }),
    cancelledRequest,
  );

  // Мягко удалённая заявка: строку состава удаление не трогает вовсе — `DELETE
  // /vehicle-requests/:id` вне статуса «Новая» пишет только `deleted_at` и с рейса заявку не
  // снимает ни при каком статусе. Рейса в дне два, с водителем и без: второй нужен сводке, которая
  // считает рейсы без водителя своим запросом мимо выражений состояния.
  const deletedRequestDay = dayAfter(44);
  const deletedRequest = await addRequest({
    requestType: 'freight_transport',
    vehicleTypeId: ctx.routeVehicle.typeId,
    objectId: ctx.objectId,
  });
  await addRouteRequest(
    await addDayRoute({
      vehicleId: ctx.routeVehicle.id,
      on: deletedRequestDay,
      driverPersonId: ctx.personId,
    }),
    deletedRequest,
  );
  // Тип заказан грузовой, как и у соседней заявки: машину под заявку тест не подбирает, а вторая
  // машина дня — та же свободная из парка прогона.
  const deletedRequestNoDriver = await addRequest({
    requestType: 'freight_transport',
    vehicleTypeId: ctx.routeVehicle.typeId,
    objectId: ctx.objectId,
  });
  await addRouteRequest(
    await addDayRoute({ vehicleId: ctx.spare.id, on: deletedRequestDay }),
    deletedRequestNoDriver,
  );
  // Удаление — после того, как заявки поставлены в рейсы: этим же порядком это происходит и в
  // жизни, а строка состава удаление переживает.
  await softDeleteRequest(deletedRequest);
  await softDeleteRequest(deletedRequestNoDriver);

  // Две заявки в составе, живая и удалённая: правило спрашивает, есть ли в рейсе хоть одна живая.
  const mixedRequestsDay = dayAfter(45);
  const mixedRoute = await addDayRoute({
    vehicleId: ctx.routeVehicle.id,
    on: mixedRequestsDay,
    driverPersonId: ctx.personId,
  });
  await addRouteRequest(
    mixedRoute,
    await addRequest({
      requestType: 'freight_transport',
      vehicleTypeId: ctx.routeVehicle.typeId,
      objectId: ctx.objectId,
    }),
  );
  const mixedDeletedRequestId = await addRequest({
    requestType: 'freight_transport',
    vehicleTypeId: ctx.routeVehicle.typeId,
    objectId: ctx.objectId,
  });
  await addRouteRequest(mixedRoute, mixedDeletedRequestId, 2);
  await softDeleteRequest(mixedDeletedRequestId);

  // Перегон: состава у него нет по устройству (ADR 0082), задание — пара «откуда — куда».
  await addDayRoute({
    vehicleId: ctx.routeVehicle.id,
    on: relocationDay,
    purpose: 'delivery',
    driverPersonId: ctx.personId,
    sourceRequestId: await addRequest({
      requestType: 'special_equipment',
      vehicleTypeId: ctx.special.typeId,
      objectId: ctx.objectId,
    }),
  });

  // День линейного заказа: он материализован строкой состава со своим `work_date` (ADR 0100 §12).
  // Режим взят снимком (миграция 0137), а не линейным типом справочника: линейной позиции в
  // классификаторе может не быть вовсе, а заявка со снимком ведётся по дням независимо от него.
  // Сроков заказа фикстуре не нужно: занятости площадки линейная заявка не даёт (ADR 0100 §12),
  // день её машины говорит рейс — ровно то, что тест и спрашивает.
  const linearRequest = await addRequest({
    requestType: 'special_equipment',
    vehicleTypeId: ctx.special.typeId,
    objectId: ctx.objectId,
  });
  await ctx.db.execute(
    sql`UPDATE vehicle_requests SET is_linear_frozen = true, linear_frozen_at = now()
        WHERE id = ${linearRequest}::uuid`,
  );
  const linearRoute = await addDayRoute({
    vehicleId: ctx.special.id,
    on: linearDay,
    driverPersonId: ctx.personId,
  });
  await ctx.db.execute(
    sql`INSERT INTO vehicle_route_requests (route_id, request_id, position, work_date)
        VALUES (${linearRoute}::uuid, ${linearRequest}::uuid, 1, ${linearDay}::date)`,
  );

  return {
    draftDay,
    summaryDay,
    paperDay,
    paperWaybillId,
    cancelledRequestDay,
    deletedRequestDay,
    mixedRequestsDay,
    mixedDeletedRequestId,
    relocationDay,
    linearDay,
  };
}

describe.skipIf(!DB_URL)('гараж: срез дня на живой схеме', () => {
  beforeAll(async () => {
    // Окружение и своя база готовы хуком механики (`useReadModeDatabase`).

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

    // Учётка файла нужна и значением, а не только заголовком: прямые вставки фикстур подписываются
    // автором, и по нему же уборка узнаёт заведённое.
    const admin = await db.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`,
    );

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      adminId: admin.rows[0]!.id,
      special: {
        id: specialVehicleId,
        typeId: specialType.type_id,
        categoryId: specialType.category_id,
      },
      routeVehicle: { id: routeVehicleId, typeId: freightType.id },
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
   * только потом машины — а за ними и второй водитель сцены, на которого ссылался его рейс
   * (специализация и трудовое отношение уходят каскадом за человеком).
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
      // Второй водитель — по своей метке-комментарию и только он: первого сцена заводит один раз и
      // подхватывает по СНИЛСу на следующем прогоне (`seed`), а этот заводится заново каждый раз, и
      // оставленный он копился бы в базе так же, как копились машины до уборки. Строкой позже
      // машин: его рейс уже снесён вместе с ними, и ссылаться на человека больше нечему.
      await ctx.db.execute(sql`DELETE FROM persons WHERE comment = ${OTHER_DRIVER_COMMENT}`);
      // Журнал — по автору: писала в него только здешняя учётка, а видов записей у неё несколько.
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  /*
   * ЭСМ2-РАЗРЕЗ. Файл **не** обёрнут двумя прогонами, и это решение, а не пропуск. Сцена здесь
   * накопительная: случаи заводят заказы и рейсы, а соседние проверки фильтров считают их число.
   * Два прогона одного случая завели бы данные дважды — и роняли бы соседей избытком, а не
   * расхождением режимов. Проверено: «день с двумя работами разных бланков» ловил три источника
   * вместо двух.
   *
   * Занятость сегодня считается по назначению и срокам, режим чтения на неё не влияет. Перевод её
   * на историю — работа этапа 5 (Ф3): тогда «машина на объекте» на прошедшую дату станет отвечать
   * по свёртке, и файл переписывается целиком, а не половинами.
   */
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

    // Составом рейсу дано, куда ехать: пустой грузовой рейс без листа — заготовка, и в срезе дня
    // её нет вовсе (ADR 0131). Работой выбрана заявка, а не выписанный лист, — иначе занятость
    // держалась бы бумагой, а следующие сценарии проверяют как раз рейс **без** бланка.
    await addRouteRequest(
      created.routeId!,
      await addRequest({
        requestType: 'freight_transport',
        vehicleTypeId: ctx.routeVehicle.typeId,
        objectId: ctx.objectId,
      }),
    );

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
   * Рейс этого теста заведён **без путевого листа** — так его и создаёт первый сценарий, и это
   * ровно тот случай, ради которого гараж приводили к общему правилу. Работу ему даёт состав
   * (ADR 0131): ехать по рейсу есть куда, а бумаги на это нет. Раньше колонка красила такую
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
      /**
       * Второй водитель, занятый в `compositionDay` **не** на `routeObject`: с ним и сверяется
       * сужение сводки по площадке — не с тем, кого случайно занесло в базу соседним прогоном.
       */
      otherDriverPersonId: string;
    }
    let f: FilterCtx;

    beforeAll(async () => {
      // Автор прямых вставок — та же учётка файла, что подписывает заявки составов: уборка ищет
      // заведённое по ней, и второго автора у фикстур быть не должно.
      const adminId = ctx.adminId;

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

      const addRoute = async (input: {
        vehicleId: string;
        on: string;
        purpose: 'freight' | 'delivery' | 'pickup';
        sourceRequestId?: string;
        /** Водитель рейса; по умолчанию — водитель файла, которого и ищут все сценарии отбора. */
        driverPersonId?: string;
      }): Promise<string> => {
        const relocation = input.purpose !== 'freight';
        const rows = await ctx.db.execute<{ id: string }>(
          sql`INSERT INTO vehicle_routes (vehicle_id, route_date, purpose, source_request_id,
                                          move_from, move_to, driver_person_id, created_by)
              VALUES (${input.vehicleId}::uuid, ${input.on}::date, ${input.purpose},
                      ${input.sourceRequestId ?? null}::uuid,
                      ${relocation ? 'База' : ''}, ${relocation ? 'Объект' : ''},
                      ${input.driverPersonId ?? ctx.personId}::uuid, ${adminId}::uuid)
              RETURNING id`,
        );
        return rows.rows[0]!.id;
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

      /*
       * Второй занятый водитель того же дня — на площадке первого сценария (`ctx.objectId`), а не
       * на `routeObject`: четыре площадки блока отобраны условием `id <> ctx.objectId`, так что
       * «другая» здесь гарантирована отбором, а не совпадением справочника.
       *
       * Он и есть предмет проверки «сводка сузилась»: без него в срезе дня стоит ровно один
       * водитель, суженный и несуженный счётчики равны единице, и утверждение держится на том,
       * занял ли кто-нибудь посторонний этот день в общей базе. Своими руками — рейс с составом,
       * своя машина и своя заявка: только так «сузилась» означает работу отбора, а не везение.
       */
      const otherDriverPersonId = await addOtherDriver();
      const otherDriverRequest = await addRequest({
        requestType: 'freight_transport',
        vehicleTypeId: freightType.id,
        objectId: ctx.objectId,
      });
      await addRouteRequest(
        await addRoute({
          vehicleId: await addVehicle(ctx.db, freightType.id, null),
          on: compositionDay,
          purpose: 'freight',
          driverPersonId: otherDriverPersonId,
        }),
        otherDriverRequest,
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

      // Грузовой рейс той же легковой машиной: здесь бланк типа и решает — форма № 3. Состав ему
      // нужен, чтобы рейс не остался заготовкой (ADR 0131), а заказчиком взят отдел: про площадку
      // этот день не спрашивают, и своя добавила бы ему отбор, которого сценарий не проверяет.
      const passengerRequest = await addRequest({
        requestType: 'freight_transport',
        vehicleTypeId: passengerType,
        departmentId,
      });
      await addRouteRequest(
        await addRoute({ vehicleId: passengerVehicleId, on: passengerDay, purpose: 'freight' }),
        passengerRequest,
      );

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
        otherDriverPersonId,
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
      // День среза: рейс с составом (4-П) и недельный лист заказа (ЭСМ-2) — две работы сразу.
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
     * отобранный день соседний тест мог завести своего водителя. Инварианты от чужих данных не
     * зависят: счётчик сводки равен счётчику списка, свободных в отборе не бывает вовсе (у каждой
     * отобранной строки работа в этот день есть по построению), а само сужение показано **двумя
     * своими** водителями — оба заняты в этот день, и площадки у их работ разные.
     *
     * Именно на последнем случай и падал: раньше «сузилась» проверялось одним лишь `total` суженной
     * сводки против несуженной, и второго водителя в дне приносила общая засорённая база. На чистой
     * его не оказывалось, обе цифры сходились в единицу, и красным становился день, а не портал
     * (§2.4 плана [test-gates-plan.md](../../../docs/test-gates-plan.md)). Поэтому сверка идёт не с
     * цифрой фона, а с человеком, которого сцена завела сама: он обязан стоять в несуженном
     * перечне и обязан выпасть из суженного.
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
      const allList = await driverList('', f.compositionDay);
      expect(byObject.total).toBe(objectList.total);

      // Оба своих водителя заняты в этот день, поэтому несуженный перечень держит обоих.
      const everyone = allList.items.map((row) => row.personId);
      expect(everyone).toContain(ctx.personId);
      expect(everyone).toContain(f.otherDriverPersonId);
      // А отбор по площадке рейса оставляет ровно того, чья работа на ней и стоит: второй занят на
      // площадке первого сценария, и в суженном перечне ему делать нечего.
      const onObject = objectList.items.map((row) => row.personId);
      expect(onObject).toContain(ctx.personId);
      expect(onObject).not.toContain(f.otherDriverPersonId);

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
      // Два дня матрицы заготовок (ADR 0131) в общем наборе: именно на них две записи правила и
      // разъезжаются, если работу рейса забыть в выражении отбора. У голой заготовки набор обязан
      // быть пуст с обеих сторон, у пустого рейса с выписанным листом — непуст.
      const drafted = await drafts();

      const answers = new Map<string, string[]>();
      for (const day of [
        ctx.today,
        f.compositionDay,
        f.relocationDay,
        f.passengerDay,
        f.departmentDay,
        f.idleDay,
        f.esm2Day,
        drafted.draftDay,
        drafted.paperDay,
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
      // И работу рейса обе стороны считают одинаково: заготовка бланка дня не даёт, а пустой рейс
      // с листом даёт бланк своей машины.
      expect(answers.get(drafted.draftDay)).toHaveLength(0);
      expect(answers.get(drafted.paperDay)).toEqual(['4p']);
    });
  });

  /**
   * Заготовки рейсов (ADR 0131): рейс попадает в срез дня, только если по нему есть куда ехать.
   *
   * Матрицей, а не одним случаем, и это не педантизм: правило записано одним куском
   * (`routeHasWork`), но применено в пяти местах — занятость машины, занятость водителя, набор
   * занятостей страницы, бланк работы дня и счёт рейсов без водителя в сводке. Забытое в любом из
   * них, оно расходится молча: строка называет машину свободной, а сводка рядом зовёт искать
   * водителя рейсу, которого в срезе не видно.
   *
   * Половина случаев здесь — про то, что правило **не** задело соседей: перегон и день линейного
   * заказа работой были и остались. Написано это правило узко, и сузить его дальше легче всего
   * случайно.
   */
  describe('заготовки рейсов', () => {
    let d: DraftCtx;

    beforeAll(async () => {
      d = await drafts();
    }, 120_000);

    it('заготовка не занимает никого: ни машину, ни поставленного на неё водителя', async () => {
      const vehicle = await vehicleRow(ctx.routeVehicle.id, '', d.draftDay);
      // Машина свободна — и это именно «свободна», а не «строки нет»: в срезе она стоит, работы в
      // ней нет.
      expect(vehicle?.state).toBe('free');
      expect(vehicle?.busy).toEqual([]);

      const driver = await driverRow('', d.draftDay);
      // Водитель в рейсе назван, но ехать ему некуда: тег «назначен» прятал бы за собой настоящую
      // работу дня — которой у человека в этот день нет.
      expect(driver?.state).toBe('free');
      expect(driver?.busy).toEqual([]);
    });

    /**
     * Сводка зовёт искать водителя тем рейсам, которым есть куда ехать. Цифра считается по самим
     * рейсам, отдельным запросом мимо выражений состояния, — это единственное применение правила
     * вне их, и потому самое лёгкое к пропуску: без него сводка звала бы искать человека рейсу,
     * которого в срезе не видно, рядом с машиной, показанной свободной.
     */
    it('в рейсах без водителя сводка считает работу, а не запись', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/garage/vehicles/summary?on=${d.summaryDay}${ONLY_MINE}`,
        headers: ctx.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      // Рейсов без водителя в этот день два, работа есть у одного — цифра называет один.
      expect(res.json().routesWithoutDriver).toBe(1);

      // Какой из двух посчитан, видно по машинам: сводка и состояния отвечают про один день.
      expect((await vehicleRow(ctx.routeVehicle.id, '', d.summaryDay))?.state).toBe('on_route');
      expect((await vehicleRow(ctx.spare.id, '', d.summaryDay))?.state).toBe('free');
    });

    it('пустой рейс с выданным листом — работа: бланк израсходован и лежит у водителя', async () => {
      const vehicle = await vehicleRow(ctx.routeVehicle.id, '', d.paperDay);
      expect(vehicle?.state).toBe('on_route');
      expect(busyKinds(vehicle!.busy)).toEqual(['route']);
      // Работу рейсу даёт именно бумага: состава у него нет вовсе.
      const route = vehicle!.busy[0] as GarageRouteBusy;
      expect(route.requests).toEqual([]);
      expect(route.waybill?.waybillId).toBe(d.paperWaybillId);

      const driver = await driverRow('', d.paperDay);
      expect(driver?.state).toBe('assigned');
      expect(busyKinds(driver!.busy)).toEqual(['route']);

      // И бланк работы дня у водителя есть — 4-П по типу машины рейса: отбор по бланку спрашивает
      // ту же работу, что показывает строка.
      expect(await driverRow(formsQuery(['4p']), d.paperDay)).toBeDefined();
      expect(await driverRow(formsQuery(['leg3', 'esm2']), d.paperDay)).toBeUndefined();
    });

    /**
     * Аннулированный лист для дня машины — то же самое, что лист не выписывали: номер списан, и
     * работы у пустого рейса не остаётся вовсе.
     *
     * Лист возвращается на место в `finally`: этот же день спрашивает тест паритета, и порядок, в
     * котором vitest дойдёт до них двоих, тесту не принадлежит.
     */
    it('аннулировали единственный лист — рейс снова заготовка', async () => {
      await ctx.db.execute(
        sql`UPDATE waybills SET status = 'cancelled', cancelled_at = now(),
                                cancelled_by = ${ctx.adminId}::uuid,
                                cancel_reason = 'ТЕСТОВЫЕ ДАННЫЕ: срез гаража'
            WHERE id = ${d.paperWaybillId}::uuid`,
      );
      try {
        const vehicle = await vehicleRow(ctx.routeVehicle.id, '', d.paperDay);
        expect(vehicle?.state).toBe('free');
        expect(vehicle?.busy).toEqual([]);

        const driver = await driverRow('', d.paperDay);
        expect(driver?.state).toBe('free');
        expect(driver?.busy).toEqual([]);
        expect(await driverRow(formsQuery(['4p']), d.paperDay)).toBeUndefined();
      } finally {
        await ctx.db.execute(
          sql`UPDATE waybills SET status = 'issued', cancelled_at = NULL, cancelled_by = NULL,
                                  cancel_reason = ''
              WHERE id = ${d.paperWaybillId}::uuid`,
        );
      }

      expect((await vehicleRow(ctx.routeVehicle.id, '', d.paperDay))?.state).toBe('on_route');
    });

    /**
     * Граница правила, а не желаемое поведение: работой считается сама строка состава, и отменённая
     * заявка в ней рейс из среза не уводит.
     *
     * В жизни такое сочетание почти недостижимо — отмена заявки сама снимает её из рейса
     * (`detachOnStatus`), и строка переживает отмену только там, где состав заморожен выписанным
     * листом, то есть у рейса, у которого работа есть и без неё. Спрашивать же у гаража статусы
     * заявок состава значило бы завести второе правило «что такое работа» рядом с тем, которое
     * держат маршруты: день машины стал бы зависеть от того, чем кончилась чужая заявка, и
     * разошёлся бы с составом, который рисует сам рейс. Тест закрепляет выбор, чтобы следующая
     * правка делала его осознанно.
     */
    it('отменённая заявка состава рейс из среза не уводит', async () => {
      const vehicle = await vehicleRow(ctx.routeVehicle.id, '', d.cancelledRequestDay);
      expect(vehicle?.state).toBe('on_route');
      const route = vehicle!.busy[0] as GarageRouteBusy;
      expect(route.requests.map((request) => request.status)).toEqual(['cancelled']);
      expect((await driverRow('', d.cancelledRequestDay))?.state).toBe('assigned');
    });

    /**
     * Вторая половина той же ветки: строка состава работой считается, пока её заявка **жива**.
     *
     * Удаление заявки строку состава не трогает вовсе — `DELETE /vehicle-requests/:id` вне статуса
     * «Новая» пишет только `deleted_at` и не снимает заявку с рейса ни при каком статусе. Без
     * условия «живой заявки» такой рейс держал бы машину «в рейсе», а её водителя «назначенным»
     * вечно — тогда как кабинет водителя, письмо с заданием и статистика показаний этот рейс уже
     * не видят: срез гаража один остался бы показывать работу, которой нет.
     */
    it('единственная заявка состава удалена — рейс уходит из среза', async () => {
      const vehicle = await vehicleRow(ctx.routeVehicle.id, '', d.deletedRequestDay);
      expect(vehicle?.state).toBe('free');
      expect(vehicle?.busy).toEqual([]);

      const driver = await driverRow('', d.deletedRequestDay);
      expect(driver?.state).toBe('free');
      expect(driver?.busy).toEqual([]);
      // Бланка дня у водителя тоже нет: отбор по бланку спрашивает ту же работу, что и строка.
      expect(await driverRow(formsQuery(['4p']), d.deletedRequestDay)).toBeUndefined();

      // И сводка не зовёт искать водителя второму рейсу дня, у которого состав из такой же
      // архивной заявки: цифра считается своим запросом мимо выражений состояния.
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/garage/vehicles/summary?on=${d.deletedRequestDay}${ONLY_MINE}`,
        headers: ctx.auth,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().routesWithoutDriver).toBe(0);
      expect((await vehicleRow(ctx.spare.id, '', d.deletedRequestDay))?.state).toBe('free');
    });

    /**
     * Живая заявка рядом с удалённой рейс держит: правило спрашивает, есть ли в составе хоть одна
     * живая, а не все ли живы, — иначе одно удаление из семи строк задания уводило бы из среза
     * машину, которой ехать по остальным шести.
     *
     * Состав при этом приезжает целиком, вместе с удалённой строкой: добор (`loadRouteRequests`)
     * ни статуса, ни удаления не фильтрует. Записано ожиданием, а не обойдено, — занятость
     * показывает то же задание, которое диспетчер видит в самом рейсе, и решение показывать иначе
     * должно быть отдельным и заметным.
     */
    it('живая заявка рядом с удалённой держит рейс в срезе', async () => {
      const vehicle = await vehicleRow(ctx.routeVehicle.id, '', d.mixedRequestsDay);
      expect(vehicle?.state).toBe('on_route');
      expect(busyKinds(vehicle!.busy)).toEqual(['route']);
      const route = vehicle!.busy[0] as GarageRouteBusy;
      expect(route.requests.map((request) => request.requestId)).toContain(d.mixedDeletedRequestId);
      expect(route.requests).toHaveLength(2);
      expect((await driverRow('', d.mixedRequestsDay))?.state).toBe('assigned');
    });

    it('перегон работой был и остался: состава у него нет по устройству', async () => {
      const vehicle = await vehicleRow(ctx.routeVehicle.id, '', d.relocationDay);
      expect(vehicle?.state).toBe('on_route');
      const route = vehicle!.busy[0] as GarageRouteBusy;
      // Ни состава, ни бумаги — и всё же работа: задание перегону даёт пара «откуда — куда».
      expect(route.requests).toEqual([]);
      expect(route.waybill).toBeNull();
      expect(route.moveFrom).not.toBe('');
      expect((await driverRow('', d.relocationDay))?.state).toBe('assigned');
    });

    it('день линейного заказа работой был и остался: он и есть строка состава', async () => {
      const vehicle = await vehicleRow(ctx.special.id, '', d.linearDay);
      // «В рейсе», а не «на объекте»: занятости площадки линейный заказ не даёт вовсе, и день его
      // машины говорит рейс (ADR 0100 §12) — тот самый, который правило обязано пропустить.
      expect(vehicle?.state).toBe('on_route');
      const route = vehicle!.busy[0] as GarageRouteBusy;
      expect(route.requests.map((request) => request.workDate)).toEqual([d.linearDay]);
      expect((await driverRow('', d.linearDay))?.state).toBe('assigned');
    });
  });
});
