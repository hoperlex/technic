import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, shiftDateKey, weekStartKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Лента раздела «Заказ автотехники» (`GET /vehicle-requests/feed`): заказы ТС и недельные заявки
 * одним списком (ADR 0085).
 *
 * Зачем база. Проверяется здесь ровно то, чего контрактный тест не увидит: страница ленты
 * выбирается объединением ключей двух выборок в SQL, а не двумя списками, склеенными после. Всё
 * ценное живёт в этом объединении — счёт, порядок, пагинация и то, какая сторона отваливается под
 * каким фильтром, — и разъедься оно с фильтрами хоть в одном месте, человек увидит не ошибку, а
 * правдоподобный список, в котором чего-то нет.
 *
 * Данные заводятся прямым SQL: лента их только читает, а полный путь заказа (виза, назначение,
 * перевод в работу) и сборка недели проверяются своими файлами — здесь он занял бы минуты на
 * каждый сценарий и ничего бы не добавил.
 *
 * Своя площадка на прогон — не аккуратность, а требование схемы: у недельных заявок частичный
 * `UNIQUE (object_id, week_start)`, и общая площадка столкнула бы прогоны между собой.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test -- vehicle-feed
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

// Недели считаются от «сегодня», а не задаются константами: захардкоженный понедельник протух бы
// на следующей неделе и увёл бы фильтр по неделе в пустоту.
const TODAY = moscowDateKeyOf(new Date());
const W1 = shiftDateKey(weekStartKey(TODAY), 7);
const W2 = shiftDateKey(weekStartKey(TODAY), 14);

interface TestUser {
  id: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: TestUser;
  /** Штаб чужой площадки: своей у него нет ни одной нашей — он и проверяет границу видимости. */
  foreignShtab: TestUser;
  objectId: string;
  vehicleTypeId: string;
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

/** Свой адрес на каждый вход: попытки ограничены по IP. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

interface FeedRow {
  kind: 'order' | 'weekly';
  order?: { id: string; displayNumber: string };
  weekly?: { id: string; displayNumber: string; weekStart: string };
}

interface FeedResponse {
  items: FeedRow[];
  total: number;
  weeklyPendingCount: number;
}

async function feed(query: string, user: TestUser = ctx.admin): Promise<FeedResponse> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/vehicle-requests/feed?pageSize=500&${query}`,
    headers: user.auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as FeedResponse;
}

/** Номера строк в порядке ленты — по ним и читается результат: «НЗ-12» и «ТС-341» вперемешку. */
function numbers(rows: FeedRow[]): string[] {
  return rows.map((r) => (r.kind === 'order' ? r.order!.displayNumber : r.weekly!.displayNumber));
}

/**
 * Заказ спецтехники строкой: лента читает шапку и деталь типа, а полный путь заказа — виза,
 * назначение, перевод в работу — проверяется своими файлами и на выдачу ленты не влияет.
 */
async function makeOrder(opts: {
  objectId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  approved?: boolean;
  comment?: string;
  deleted?: boolean;
}): Promise<{ id: string; num: number; displayNumber: string }> {
  const objectId = opts.objectId ?? ctx.objectId;
  const approver = opts.approved ? ctx.admin.id : null;
  const res = await ctx.db.execute<{ id: string; num: number }>(sql`
    INSERT INTO vehicle_requests
      (object_id, request_type, vehicle_type_id, status, comment, created_by,
       approved_by, approved_at, deleted_at, deleted_by)
    VALUES (${objectId}, 'special_equipment', ${ctx.vehicleTypeId}, ${opts.status ?? 'new'},
            ${opts.comment ?? ''}, ${ctx.admin.id},
            ${approver}, ${opts.approved ? sql`now()` : null},
            ${opts.deleted ? sql`now()` : null}, ${opts.deleted ? ctx.admin.id : null})
    RETURNING id, num`);
  const row = res.rows[0]!;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details
      (request_id, date_from, date_to, responsible_name, responsible_phone)
    VALUES (${row.id}, ${opts.dateFrom ?? TODAY}::date, ${opts.dateTo ?? null}::date,
            'Иванов И. И.', '9990000000')`);
  return { id: row.id, num: row.num, displayNumber: `ТС-${row.num}` };
}

/** Недельная заявка строкой: составом лента не отбирает, ей достаточно шапки. */
async function makeWeekly(opts: {
  objectId?: string;
  weekStart?: string;
  status?: string;
  comment?: string;
  approved?: boolean;
}): Promise<{ id: string; num: number; displayNumber: string }> {
  const applied = opts.status === 'applied';
  const res = await ctx.db.execute<{ id: string; num: number }>(sql`
    INSERT INTO weekly_vehicle_requests
      (object_id, week_start, status, comment, created_by, approved_by, approved_at, applied_at)
    VALUES (${opts.objectId ?? ctx.objectId}, ${opts.weekStart ?? W1}::date,
            ${opts.status ?? 'pending'}, ${opts.comment ?? ''}, ${ctx.admin.id},
            ${applied ? ctx.admin.id : null}, ${applied ? sql`now()` : null},
            ${applied ? sql`now()` : null})
    RETURNING id, num`);
  const row = res.rows[0]!;
  return { id: row.id, num: row.num, displayNumber: `НЗ-${row.num}` };
}

/**
 * Своя машина строкой: фильтр по назначенной технике спрашивают единицей парка («где ходил
 * ТС-341»), и проверить его нечем, кроме двух разных машин в справочнике.
 */
async function makeVehicle(label: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicles (ownership, vehicle_type_id, registration_number)
    VALUES ('own', ${ctx.vehicleTypeId}, ${`FEED${label}${RUN}`})
    RETURNING id`);
  return res.rows[0]!.id;
}

/**
 * Назначение машины на заказ (ADR 0027) строкой: полный путь — виза, подбор, перевод в работу —
 * проверяется своими файлами, а фильтру нужна только сама связь. Обе копии типа равны типу заказа:
 * машина заводится того же типа, и составные ключи назначения на этом и держатся.
 */
async function assign(requestId: string, vehicleId: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${vehicleId}, ${ctx.vehicleTypeId}, ${ctx.vehicleTypeId},
            ${ctx.admin.id})`);
}

/** Учётка нужной роли: заводится строкой, входит настоящим маршрутом — токен нужен живой. */
async function makeUser(role: string, objectIds: string[] = []): Promise<TestUser> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const schema = await import('../src/db/schema');
  const email = `db-feed-${role}-${RUN}@example.invalid`;
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: role,
      middleName: '',
      passwordHash: await hashPassword(PASSWORD),
      role: role as never,
      isActive: true,
    })
    .returning({ id: schema.users.id });
  const id = created!.id;
  for (const objectId of objectIds) {
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${id}, ${objectId})`);
  }
  const { buildApp } = await import('../src/app');
  const app = ctx?.app ?? (await buildApp());
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: nextAddress(),
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { id, auth: { authorization: `Bearer ${login.json().accessToken}` } };
}

describe.skipIf(!DB_URL)('лента «Заказ автотехники» (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { buildApp } = await import('../src/app');
    const app = await buildApp();

    const types = await db.execute<{ id: string }>(sql`SELECT id FROM vehicle_types LIMIT 1`);
    if (!types.rows[0]) {
      throw new Error('В базе нет типов ТС: миграции наполнения не применены');
    }

    // ctx заполняется по частям: `makeUser` входит через уже собранное приложение.
    ctx = {
      app,
      db,
      closeDb,
      admin: undefined as never,
      foreignShtab: undefined as never,
      objectId: undefined as never,
      vehicleTypeId: types.rows[0].id,
    };
    ctx.admin = await makeUser('admin');

    const code = `FEED-${RUN}`;
    const objects = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${code}, ${`Площадка ленты ${code}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`);
    ctx.objectId = objects.rows[0]!.id;

    const foreign = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-X-${RUN}`}, ${`Чужая площадка ${RUN}`}, 'г Москва, ул Чужая, д 2')
      RETURNING id`);
    ctx.foreignShtab = await makeUser('shtab', [foreign.rows[0]!.id]);
  }, 180_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Убирается файл за собой сам: база у db-тестов общая и живёт между прогонами, а лента
       * проверяется на своих строках — за прогон в базе оседало по десятку площадок, полтора
       * десятка заказов и столько же недельных заявок. Ленту это же и портит: соседние файлы
       * отбирают «первую страницу», и накопленные здесь строки будущей неделей занимали её.
       *
       * Метка — префиксы, а не список заведённого: прибирать надо и за упавшим прогоном. Взяты они
       * шире одного прогона (`FEED-%`, а не `FEED-%-<RUN>`), чтобы уборка добирала хвосты прежних
       * падений; префиксы этого файла в тестах больше никто не занимает.
       *
       * Порядок обратен ссылкам: заказы и недельные заявки держат площадку и учётку, назначения
       * держат машину. Назначения, состав и детали заказа уходят каскадом вместе с заказом,
       * привязки учёток к площадкам — вместе с любой из сторон.
       */
      const ourObjects = sql`SELECT id FROM construction_objects WHERE code LIKE 'FEED-%'`;
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE object_id IN (${ourObjects})`);
      await ctx.db.execute(
        sql`DELETE FROM weekly_vehicle_requests WHERE object_id IN (${ourObjects})`,
      );
      /*
       * Машина сносится, только если её никто не держит. Сам файл бумаги не выписывает — оговорка
       * нужна из-за прошлого: машины прежних прогонов оставались в справочнике живыми и своими, а
       * соседние db-тесты берут «первую попавшуюся свою активную» — на них успели выписать листы,
       * и один из них уже исправлен другим (`waybills.corrects_waybill_id`). Сносить чужую бумагу
       * ради своей машины уборка не вправе, поэтому такую машину она обходит.
       */
      await ctx.db.execute(sql`
        DELETE FROM vehicles
         WHERE registration_number LIKE 'FEED%'
           AND id NOT IN (SELECT vehicle_id FROM waybills)
           AND id NOT IN (SELECT vehicle_id FROM vehicle_routes)
           AND id NOT IN (SELECT vehicle_id FROM vehicle_request_assignments)`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code LIKE 'FEED-%'`);
      /*
       * Журнал — по автору и раньше сноса учёток: `actor_user_id` при удалении обнуляется, а не
       * удаляется, — и записи о входе оставались бы висеть без хозяина.
       */
      const ourUsers = sql`SELECT id FROM users WHERE email LIKE 'db-feed-%@example.invalid'`;
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
      await ctx.db.execute(sql`DELETE FROM users WHERE id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  it('отдаёт оба вида документа одним списком, а `total` считает по обоим', async () => {
    const object = ctx.objectId;
    const first = await makeOrder({});
    const second = await makeOrder({});
    const week = await makeWeekly({});

    const page = await feed(`objectId=${object}`);

    expect(page.total).toBe(3);
    expect(numbers(page.items).sort()).toEqual(
      [first.displayNumber, second.displayNumber, week.displayNumber].sort(),
    );
    // Строка размечена видом, а не угадывается по пустым полям: карточка каждой собрана своим
    // сборщиком, и общего плоского DTO у ленты нет.
    const weeklyRow = page.items.find((r) => r.kind === 'weekly')!;
    expect(weeklyRow.weekly!.weekStart).toBe(W1);
  });

  it('страница режет объединение, а не каждую выборку по отдельности', async () => {
    // Своя площадка на сценарий: пагинация проверяется на известном наборе, а не на всём, что
    // накопили соседние тесты.
    const objects = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-P-${RUN}`}, ${`Площадка пагинации ${RUN}`}, 'г Москва, ул Страничная, д 3')
      RETURNING id`);
    const object = objects.rows[0]!.id;
    await makeOrder({ objectId: object });
    await makeOrder({ objectId: object });
    await makeWeekly({ objectId: object, weekStart: W1 });
    await makeWeekly({ objectId: object, weekStart: W2 });

    const all = await feed(`objectId=${object}&sortBy=createdAt&sortOrder=asc`);
    expect(all.total).toBe(4);

    const first = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/feed?objectId=${object}&pageSize=50&page=1&sortBy=createdAt&sortOrder=asc`,
      headers: ctx.admin.auth,
    });
    // Страницы не пересекаются и вместе дают всю ленту: склей их клиент из двух списков — вторая
    // повторяла бы часть первой ровно там, где видов документа поровну.
    const pageOne = (first.json() as FeedResponse).items;
    expect(first.statusCode, first.body).toBe(200);
    expect(numbers(pageOne)).toEqual(numbers(all.items));

    const rest = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/feed?objectId=${object}&pageSize=50&page=2&sortBy=createdAt&sortOrder=asc`,
      headers: ctx.admin.auth,
    });
    expect((rest.json() as FeedResponse).items).toHaveLength(0);
    expect((rest.json() as FeedResponse).total).toBe(4);
  });

  it('фильтр без соответствия у недельного документа убирает недельные строки целиком', async () => {
    const objects = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-F-${RUN}`}, ${`Площадка фильтров ${RUN}`}, 'г Москва, ул Фильтровая, д 4')
      RETURNING id`);
    const object = objects.rows[0]!.id;
    const order = await makeOrder({ objectId: object, status: 'new' });
    const week = await makeWeekly({ objectId: object });

    // Статус заказа: у недельного документа своих четыре, и «Новая» среди них не значится.
    const byStatus = await feed(`objectId=${object}&status=new`);
    expect(numbers(byStatus.items)).toEqual([order.displayNumber]);
    expect(byStatus.total).toBe(1);

    // Тип заявки и заказанный тип ТС — то же самое: позиции классификатора у недели нет вовсе.
    const byType = await feed(`objectId=${object}&requestType=special_equipment`);
    expect(numbers(byType.items)).toEqual([order.displayNumber]);
    const byVehicleType = await feed(`objectId=${object}&vehicleTypeId=${ctx.vehicleTypeId}`);
    expect(numbers(byVehicleType.items)).toEqual([order.displayNumber]);

    // Обратное сужение: вид документа оставляет только недельные строки.
    const onlyWeekly = await feed(`objectId=${object}&kind=weekly`);
    expect(numbers(onlyWeekly.items)).toEqual([week.displayNumber]);
    expect(onlyWeekly.total).toBe(1);
    const onlyOrders = await feed(`objectId=${object}&kind=order`);
    expect(numbers(onlyOrders.items)).toEqual([order.displayNumber]);
  });

  it('фильтр по назначенной машине отбирает по единице парка, а не по позиции классификатора', async () => {
    const objects = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-M-${RUN}`}, ${`Площадка машины ${RUN}`}, 'г Москва, ул Гаражная, д 11')
      RETURNING id`);
    const object = objects.rows[0]!.id;
    const withVehicle = await makeOrder({ objectId: object });
    const withOther = await makeOrder({ objectId: object });
    // Заявка без назначения: заказанный тип у неё тот же самый, и попади она в выдачу — фильтр
    // отбирал бы по классификатору, как до ADR 0098, а не по машине.
    await makeOrder({ objectId: object });
    await makeWeekly({ objectId: object });
    const vehicle = await makeVehicle('A');
    await assign(withVehicle.id, vehicle);
    await assign(withOther.id, await makeVehicle('B'));

    // `total` считается тем же условием, что и страница: чужая машина, заявка без назначения и
    // недельная строка (назначения у неё не бывает вовсе) в цифру не идут.
    const byVehicle = await feed(`objectId=${object}&vehicleId=${vehicle}`);
    expect(numbers(byVehicle.items)).toEqual([withVehicle.displayNumber]);
    expect(byVehicle.total).toBe(1);

    // Тот же фильтр во вкладке: список и лента обязаны отвечать одно и то же — человек считает
    // их одним списком, потому что это и есть один список.
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests?pageSize=500&objectId=${object}&vehicleId=${vehicle}`,
      headers: ctx.admin.auth,
    });
    expect(res.statusCode, res.body).toBe(200);
    const list = res.json() as { items: { displayNumber: string }[]; total: number };
    expect(list.items.map((i) => i.displayNumber)).toEqual([withVehicle.displayNumber]);
    expect(list.total).toBe(1);

    // Сводка над таблицей — по тем же сужающим фильтрам: назначение присоединено первичным
    // ключом, поэтому счётчик статусов от join'а не завышается.
    const summaryRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/vehicle-requests/summary?objectId=${object}&vehicleId=${vehicle}`,
      headers: ctx.admin.auth,
    });
    expect(summaryRes.statusCode, summaryRes.body).toBe(200);
    expect((summaryRes.json() as Record<string, number>).new).toBe(1);
  });

  it('поиск по номеру разведён по видам: «НЗ-…» не ищет заказы, «ТС-…» не ищет недели', async () => {
    const order = await makeOrder({});
    const week = await makeWeekly({ weekStart: W2 });

    const byOrderNum = await feed(`num=${order.num}`);
    expect(numbers(byOrderNum.items)).toEqual([order.displayNumber]);

    // Пара «вид + номер»: без вида «12» означало бы и ТС-12, и НЗ-12 сразу.
    const byWeeklyNum = await feed(`kind=weekly&num=${week.num}`);
    expect(numbers(byWeeklyNum.items)).toEqual([week.displayNumber]);
  });

  it('неделя и диапазон дат отбирают недельные строки пересечением с неделей документа', async () => {
    const objects = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-W-${RUN}`}, ${`Площадка недель ${RUN}`}, 'г Москва, ул Недельная, д 5')
      RETURNING id`);
    const object = objects.rows[0]!.id;
    const first = await makeWeekly({ objectId: object, weekStart: W1 });
    await makeWeekly({ objectId: object, weekStart: W2 });

    const byWeek = await feed(`objectId=${object}&weekStart=${W1}`);
    expect(numbers(byWeek.items)).toEqual([first.displayNumber]);

    // Диапазон, накрывающий один день недели W1: документ занимает неделю целиком, и «что было в
    // среду» обязано отвечать заявкой, чья неделя началась в понедельник.
    const midWeek = shiftDateKey(W1, 3);
    const byRange = await feed(
      `objectId=${object}&kind=weekly&dateFrom=${midWeek}&dateTo=${midWeek}`,
    );
    expect(numbers(byRange.items)).toEqual([first.displayNumber]);

    // День до начала недели W1 в неё не попадает — и заявку не находит.
    const before = shiftDateKey(W1, -1);
    const outside = await feed(
      `objectId=${object}&kind=weekly&dateFrom=${before}&dateTo=${before}`,
    );
    expect(numbers(outside.items)).toEqual([]);
  });

  it('поиск по тексту ищет недельную заявку по шапке, а не по составу', async () => {
    // Своя площадка: частичный `UNIQUE (object_id, week_start)` держит по одной живой заявке на
    // пару, и вторая неделя на общей площадке столкнулась бы с заведённой соседним сценарием.
    const objects = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-T-${RUN}`}, ${`Площадка поиска ${RUN}`}, 'г Москва, ул Поисковая, д 10')
      RETURNING id`);
    const object = objects.rows[0]!.id;
    const marker = `метка-${RUN}`;
    const week = await makeWeekly({ objectId: object, comment: `комментарий ${marker}` });
    const order = await makeOrder({ objectId: object, comment: `заказ ${marker}` });

    const found = await feed(`search=${encodeURIComponent(marker)}`);
    expect(numbers(found.items).sort()).toEqual([order.displayNumber, week.displayNumber].sort());
  });

  it('виза отбирает оба вида документа: у недели это её собственная подпись', async () => {
    const objects = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-A-${RUN}`}, ${`Площадка визы ${RUN}`}, 'г Москва, ул Визовая, д 6')
      RETURNING id`);
    const object = objects.rows[0]!.id;
    const awaiting = await makeOrder({ objectId: object });
    const approvedOrder = await makeOrder({ objectId: object, approved: true });
    const pendingWeek = await makeWeekly({ objectId: object, weekStart: W1 });
    const appliedWeek = await makeWeekly({ objectId: object, weekStart: W2, status: 'applied' });

    const withVisa = await feed(`objectId=${object}&approved=true`);
    expect(numbers(withVisa.items).sort()).toEqual(
      [approvedOrder.displayNumber, appliedWeek.displayNumber].sort(),
    );

    const withoutVisa = await feed(`objectId=${object}&approved=false`);
    expect(numbers(withoutVisa.items).sort()).toEqual(
      [awaiting.displayNumber, pendingWeek.displayNumber].sort(),
    );
  });

  it('порядок ленты общий: срок сводит неделю и заказ на одну ось', async () => {
    const objects = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-S-${RUN}`}, ${`Площадка порядка ${RUN}`}, 'г Москва, ул Порядковая, д 7')
      RETURNING id`);
    const object = objects.rows[0]!.id;
    // Заказ раньше первой недели, вторая неделя позже обеих: по сроку они обязаны встать между.
    const early = await makeOrder({ objectId: object, dateFrom: shiftDateKey(W1, -3) });
    const late = await makeOrder({ objectId: object, dateFrom: shiftDateKey(W2, 3) });
    const week1 = await makeWeekly({ objectId: object, weekStart: W1 });
    const week2 = await makeWeekly({ objectId: object, weekStart: W2 });

    const byTerm = await feed(`objectId=${object}&sortBy=term&sortOrder=asc`);
    expect(numbers(byTerm.items)).toEqual([
      early.displayNumber,
      week1.displayNumber,
      week2.displayNumber,
      late.displayNumber,
    ]);

    // Столбец, которого у недели нет: заказы идут первыми, недельные строки уходят в конец
    // (`NULLS LAST`) — а не притворяются пустым значением в середине списка.
    const byVehicleType = await feed(`objectId=${object}&sortBy=vehicleTypeName&sortOrder=asc`);
    expect(numbers(byVehicleType.items).slice(2)).toEqual([
      week1.displayNumber,
      week2.displayNumber,
    ]);

    // По номеру лента сортирует парой «вид, номер»: «НЗ-12» и «ТС-12» не лежат на одной оси.
    const byNum = await feed(`objectId=${object}&sortBy=num&sortOrder=asc`);
    expect(numbers(byNum.items)).toEqual([
      early.displayNumber,
      late.displayNumber,
      week1.displayNumber,
      week2.displayNumber,
    ]);

    // Столбцы разных типов на двух сторонах объединения: статус заказа — перечисление, у недели на
    // его месте пусто. Проверяется, что объединение вообще собирается: расхождение типов здесь —
    // не «неверный порядок», а 500 на нажатии заголовка колонки.
    for (const field of ['status', 'comment', 'approval', 'objectName', 'createdAt']) {
      const sorted = await feed(`objectId=${object}&sortBy=${field}&sortOrder=asc`);
      expect(sorted.items, field).toHaveLength(4);
    }
  });

  it('архив недельных строк не показывает: недельная заявка не удаляется вовсе', async () => {
    const objects = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-R-${RUN}`}, ${`Площадка архива ${RUN}`}, 'г Москва, ул Архивная, д 8')
      RETURNING id`);
    const object = objects.rows[0]!.id;
    const archived = await makeOrder({ objectId: object, status: 'confirmed', deleted: true });
    const live = await makeOrder({ objectId: object });
    await makeWeekly({ objectId: object });

    const archive = await feed(`objectId=${object}&archive=only`);
    expect(numbers(archive.items)).toEqual([archived.displayNumber]);

    // Обычная лента архивную заявку не показывает, а недельную — показывает.
    const working = await feed(`objectId=${object}`);
    expect(numbers(working.items)).toContain(live.displayNumber);
    expect(numbers(working.items)).not.toContain(archived.displayNumber);
    expect(working.items.some((r) => r.kind === 'weekly')).toBe(true);
  });

  it('чужая площадка не отдаёт ни строк, ни очереди визы', async () => {
    const objects = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`FEED-V-${RUN}`}, ${`Площадка видимости ${RUN}`}, 'г Москва, ул Видимая, д 9')
      RETURNING id`);
    const object = objects.rows[0]!.id;
    await makeOrder({ objectId: object });
    await makeWeekly({ objectId: object });

    // Штаб соседней площадки видит ленту, но нашей площадки в ней нет — ни заказов, ни недель.
    const foreign = await feed(`objectId=${object}`, ctx.foreignShtab);
    expect(foreign.items).toHaveLength(0);
    expect(foreign.total).toBe(0);
    // Очередь визы считается по площадкам учётки, а не по фильтрам ленты: наша неделя в неё не
    // попадает, потому что площадка чужая.
    const own = await feed(`objectId=${object}`);
    expect(own.weeklyPendingCount).toBeGreaterThan(0);
    expect(await feed('', ctx.foreignShtab).then((r) => r.weeklyPendingCount)).toBe(0);
  });
});
