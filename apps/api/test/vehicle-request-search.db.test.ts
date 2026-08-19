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
 * Поиск по списку заказа ТС знает обе оси заказчика (ADR 0040,
 * `docs/department-requests-plan.md`, Р10а). Природа та же, что у сортировки (крит К3): половина
 * ленты офиса после фичи — заявки отдела, и поиск, который находит их только по комментарию,
 * читается как поломка, а не как граница.
 *
 * Почему на базе, а не на правилах. Проверяется здесь ровно SQL: `searchCondition` перечисляет
 * колонки **присоединённых** справочников, и ошибка живёт не в теле запроса, а в том, что колонка
 * названа, а join'а под неё в какой-то из выдач нет, — такой запрос падает уже в PostgreSQL
 * («missing FROM-clause entry»), и никакой тест на правилах этого не увидит. Выдач две — список и
 * лента, — и условие у них общее (`listWhere`), но запросы разные: у ленты своя сборка ключей с
 * `UNION`, где join'ы перечислены заново.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test vehicle-request-search
 *
 * Без `TEST_DATABASE_URL` файл пропускается: обычный прогон тестов базы не требует и требовать
 * не должен — иначе `pnpm test` перестанет работать там, где PostgreSQL не поднят.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/*
 * Адрес свой у файла, а не общий `db-test@`: уборка опознаёт заведённое по автору, и общая учётка
 * означала бы, что файл сносит чужие, ещё живые заказы (та же беда, что и с общим СНИЛС,
 * см. `db-identity`).
 */
const MANAGER_EMAIL = 'db-request-search-manager@example.invalid';
const PASSWORD = 'db-test-password-123';

/** Метка справочных записей файла: по ней же он за собой и убирает. */
/*
 * Префикс сортируется **после** сидовых кодов (`dept_1`, `DIG-D-…`) намеренно: соседние db-тесты
 * берут заказчика первой строкой справочника (`ORDER BY code LIMIT 1`, `vehicle-request-retype`),
 * и фикстура, вставшая в начало, уезжала бы к ним в заявку — а этот файл её потом удаляет, и чужой
 * тест падал бы «Отдел не найден» через раз, в зависимости от порядка прогона.
 */
const FIXTURE_PREFIX = 'zz-search-test';

/*
 * Наименования и коды заказчиков — заведомо непохожие друг на друга: поиск ищет подстрокой
 * (`ILIKE %term%`) сразу по четырём колонкам, и общий кусок в названиях сделал бы «нашлось»
 * бессмысленным — совпадало бы всё и всегда. По той же причине коды различаются хвостом, а не
 * только префиксом файла.
 */
const DEPARTMENT_NAME = 'Отдел снабжения (поиск, тест)';
const DEPARTMENT_CODE = `${FIXTURE_PREFIX}-DEP-SUPPLY`;
const OBJECT_NAME = 'Площадка Северная (поиск, тест)';
const OBJECT_CODE = `${FIXTURE_PREFIX}-OBJ-NORTH`;

/** Слово, которого нет ни в одном заказчике и ни в одном комментарии файла. */
const NOBODY_TERM = 'Зарянка-которой-нет';

/** Комментарий заявок: намеренно без слов, по которым файл ищет, — иначе искали бы его, а не заказчика. */
const COMMENT = 'Плиты перекрытия';

/** Верифицированный адрес: у грузоперевозки оба конца маршрута обязаны быть выбраны, а не набраны. */
const RESOLVED_ADDRESS = {
  source: 'resolved',
  fiasId: '0c5b2444-70a0-4932-980c-b4dc0d3f02b5',
  fiasLevel: 8,
  geoLat: 55.75,
  geoLon: 37.61,
};

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  managerAuth: { authorization: string };
  /** Грузовая позиция классификатора: отдел заказывает только грузоперевозки (ADR 0040). */
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
  objectId: string;
  departmentId: string;
  today: string;
  /** Заявка отдела и заявка площадки — по одной, и ищутся они порознь. */
  departmentRequestId: string;
  objectRequestId: string;
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

/** Учётка файла одна: заявку от лица отдела и от лица площадки заводит офис, визы здесь не нужны. */
async function seedUser(): Promise<void> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`${schema.users.email} = ${MANAGER_EMAIL}`);
  if (existing) return;
  await db.insert(schema.users).values({
    email: MANAGER_EMAIL,
    lastName: 'Тестовый',
    firstName: 'Менеджер',
    middleName: '',
    passwordHash: await hashPassword(PASSWORD),
    role: 'manager',
    isActive: true,
  });
}

/**
 * Справочные записи файла — заново на каждый прогон: их наименования и коды и есть то, что ищется,
 * и остаток упавшего прогона нашёлся бы вторым таким же. Заявки убираются первыми — их ключи на
 * площадку и отдел стоят `restrict`.
 */
async function resetFixtures(): Promise<void> {
  const { db } = await import('../src/db/client');
  const ourUsers = sql`SELECT id FROM users WHERE email = ${MANAGER_EMAIL}`;
  await db.execute(sql`DELETE FROM vehicle_requests WHERE created_by IN (${ourUsers})`);
  await db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
  await db.execute(sql`DELETE FROM departments WHERE code LIKE ${`${FIXTURE_PREFIX}-%`}`);
  await db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`${FIXTURE_PREFIX}-%`}`);
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

/** Тело грузоперевозки: заказчик — объект либо отдел, остальное заведомо годное. */
function freightPayload(customer: {
  objectId?: string;
  departmentId?: string;
}): Record<string, unknown> {
  return {
    requestType: 'freight_transport',
    ...customer,
    vehicleTypeId: ctx.vehicleTypeId,
    vehicleCategoryId: ctx.vehicleCategoryId,
    scheduledAt: `${ctx.today}T09:00:00+03:00`,
    trips: [
      {
        fromLocation: 'г Москва, ул Тверская, д 1',
        toLocation: 'г Москва, ул Арбат, д 2',
        fromAddress: RESOLVED_ADDRESS,
        toAddress: RESOLVED_ADDRESS,
        volumeM3: 12,
        fromResponsibleName: 'Сидоров Сидор Сидорович',
        fromResponsiblePhone: '+79990000002',
        toResponsibleName: 'Кузнецов Кузьма Кузьмич',
        toResponsiblePhone: '+79990000003',
      },
    ],
    comment: COMMENT,
  };
}

async function createRequest(payload: Record<string, unknown>): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-requests',
    headers: ctx.managerAuth,
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** Идентификаторы найденного списком — в порядке выдачи он здесь не важен, важен состав. */
async function searchList(term: string): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests?search=${encodeURIComponent(term)}`,
    headers: ctx.managerAuth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { id: string }[]).map((r) => r.id);
}

/** То же по ленте: у неё своя сборка запроса, и молча разойтись со списком она может только там. */
async function searchFeed(term: string): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/feed?search=${encodeURIComponent(term)}`,
    headers: ctx.managerAuth,
  });
  expect(res.statusCode, res.body).toBe(200);
  const rows = res.json().items as { kind: string; order?: { id: string } }[];
  return rows.filter((row) => row.kind === 'order').map((row) => row.order!.id);
}

describe.skipIf(!DB_URL)('поиск заявок на технику: отдел наравне с площадкой (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);
    await seedUser();
    await resetFixtures();

    const { buildApp } = await import('../src/app');
    const { db, closeDb } = await import('../src/db/client');
    const app = await buildApp();

    // Позиция классификатора берётся из справочника, а не пишется руками: состав наполняют
    // миграции, и зафиксированный здесь идентификатор разошёлся бы с ними при первой правке.
    const types = await db.execute<{ type_id: string; category_id: string | null }>(sql`
      SELECT vt.id AS type_id,
             (SELECT c.id FROM vehicle_categories c
               WHERE c.vehicle_type_id = vt.id AND c.is_active
               ORDER BY c.sort_order LIMIT 1) AS category_id
      FROM vehicle_types vt
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE vk.code = 'freight_transport' AND vt.is_active AND vk.is_active
      ORDER BY vt.sort_order
      LIMIT 1`);
    const type = types.rows[0];
    if (!type)
      throw new Error('В справочнике нет активного грузового типа ТС: миграции не применены');

    const departments = await db.execute<{ id: string }>(sql`
      INSERT INTO departments (code, name) VALUES (${DEPARTMENT_CODE}, ${DEPARTMENT_NAME})
      RETURNING id`);
    const objects = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${OBJECT_CODE}, ${OBJECT_NAME}, ${'г Москва, ул Тестовая, д 1'})
      RETURNING id`);

    ctx = {
      app,
      db,
      closeDb,
      managerAuth: { authorization: '' },
      vehicleTypeId: type.type_id,
      vehicleCategoryId: type.category_id,
      objectId: objects.rows[0]!.id,
      departmentId: departments.rows[0]!.id,
      // Заявку заводят не раньше чем на сегодня (`minVehicleRequestDateKey`) — от этого дня и пляшем.
      today: moscowDateKeyOf(new Date()),
      departmentRequestId: '',
      objectRequestId: '',
    };
    ctx.managerAuth = await login(MANAGER_EMAIL);
    ctx.departmentRequestId = await createRequest(
      freightPayload({ departmentId: ctx.departmentId }),
    );
    ctx.objectRequestId = await createRequest(freightPayload({ objectId: ctx.objectId }));
  }, 120_000);

  afterAll(async () => {
    // Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а заказчики
    // этого файла лезут в чужие подборы и в чужой поиск.
    if (ctx?.db) await resetFixtures();
    await ctx?.app.close();
    await ctx?.closeDb();
  }, 60_000);

  it('заявка отдела находится по названию отдела', async () => {
    // «снабжения» есть только в наименовании отдела: ни в площадке, ни в комментарии его нет,
    // поэтому найденная строка отвечает именно про колонку справочника отделов.
    expect(await searchList('снабжения')).toEqual([ctx.departmentRequestId]);
  });

  it('заявка отдела находится по коду отдела', async () => {
    // Код спрашивают наравне с названием — им заказчика и называют в переписке; хвост кода у
    // отдела и у площадки разный, иначе совпало бы обеими строками сразу.
    expect(await searchList(DEPARTMENT_CODE)).toEqual([ctx.departmentRequestId]);
  });

  it('заявка площадки по-прежнему находится по названию и коду объекта', async () => {
    // Половина, которая работала и до Р10а: расширение перечня колонок не должно её сузить —
    // `searchCondition` собирает их через `OR`, и ошибка здесь читалась бы как «поиск сломали».
    expect(await searchList('Северная')).toEqual([ctx.objectRequestId]);
    expect(await searchList(OBJECT_CODE)).toEqual([ctx.objectRequestId]);
  });

  it('поиск по чужому названию не находит ни одной заявки', async () => {
    // Без этого случая три предыдущих доказывали бы только то, что список вообще что-то отдаёт:
    // условие, которое не сужает, тоже «находит» заявку отдела по названию отдела.
    expect(await searchList(NOBODY_TERM)).toEqual([]);
  });

  it('лента раздела ищет по отделу тем же словом, что и список', async () => {
    // У ленты свой запрос: ключи строк собираются `UNION`'ом двух выборок, и join'ы под условия
    // списка перечислены в нём заново. Разойдись они — поиск отвечал бы во вкладке и в ленте
    // по-разному, а человек считает их одним списком.
    expect(await searchFeed('снабжения')).toEqual([ctx.departmentRequestId]);
    expect(await searchFeed(DEPARTMENT_CODE)).toEqual([ctx.departmentRequestId]);
    expect(await searchFeed('Северная')).toEqual([ctx.objectRequestId]);
    expect(await searchFeed(NOBODY_TERM)).toEqual([]);
  });
});
