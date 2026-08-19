import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moscowDateKeyOf, REQUEST_STATUSES, weekStartKey } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Отбор по позициям классификатора (ADR 0028) во всех выдачах сразу: набор `classifications` и
 * прежняя пара `vehicleTypeId` / `vehicleCategoryId`.
 *
 * Зачем база. Условие собирается одним хелпером (`src/lib/classification-filter.ts`), но
 * раскладывается на **две ветки SQL** — типы целиком и отдельные категории, объединённые по ИЛИ, —
 * и цена ошибки здесь не отказ, а правдоподобный список: категория, притянувшая соседнюю
 * категорию своего типа, выглядит как обычная выдача, просто с лишними строками. Проверить это
 * можно только настоящим запросом к настоящей схеме.
 *
 * Почему одна фикстура на шесть выдач. Фильтр стоит в пяти местах отбора (список и лента, журнал,
 * «На объекте», сводка заявок, перечень гаража) и обязан значить в них одно и то же: человек
 * считает это одним фильтром, потому что контрол один. Поэтому случаи описаны таблицей и
 * прогоняются по каждой выдаче, а не переписываются шесть раз — разойдись выдачи, разойдётся
 * ровно та строка таблицы, где они разошлись.
 *
 * Своя площадка на каждую выдачу — не аккуратность: статусы у выдач разные и несовместимые
 * (журнал показывает только закрытые, «На объекте» — только «В работе»), и на общей площадке одни
 * и те же четыре заявки не удовлетворили бы трём условиям сразу.
 *
 * Данные заводятся прямым SQL: проверяется здесь отбор, а не путь заявки, — виза, назначение и
 * перевод в работу проверяются своими файлами и на условие фильтра не влияют.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/classification-filter.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
const EMAIL = `db-classification-${RUN}@example.invalid`;

/** Метка машин прогона: ею же перечень гаража сужается до своих (`?search=`). */
const MARK = `CLF-${RUN}`;

const TODAY = moscowDateKeyOf(new Date());

/**
 * Четыре позиции фикстуры — весь смысл файла в том, какие из них попадают в выдачу:
 *
 * - `A1` и `A2` — две категории **одного** типа: соседки, которых категория не вправе притянуть;
 * - `B1` — категория другого типа: с её типом проверяется набор из двух типов, с ней самой —
 *   несовпадающая старая пара «тип A + категория B»;
 * - `C` — третий тип без категорий: он не назван ни в одном фильтре и не должен появляться нигде.
 */
type Slot = 'A1' | 'A2' | 'B1' | 'C';

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  userId: string;
  typeA: string;
  typeB: string;
  typeC: string;
  catA1: string;
  catA2: string;
  catB1: string;
  /** Площадка списка, ленты и сводки заявок: заявки «Новые». */
  listObject: string;
  /** Площадка журнала: заявки «Выполнена» — открытую заявку журнал не показывает вовсе. */
  historyObject: string;
  /** Площадка среза: заявки «В работе» со сроком, накрывающим сегодняшний день по Москве. */
  onSiteObject: string;
}

let ctx: Ctx;

/** Какая заявка какую позицию фикстуры занимает: ответ выдачи читается по этой карте. */
const requestSlots = new Map<string, Slot>();
/** То же для машин гаража: у перечня техники своя таблица, но фильтр тот же. */
const vehicleSlots = new Map<string, Slot>();

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

// ── Ключи набора ──
// Ключ самодостаточен (Р1): по нему видно, спросили весь тип или одну категорию, — пары
// «тип:категория» на проводе нет вовсе.

/** Весь тип со всеми его категориями. */
const wholeType = (id: string): string => `t${id}`;
/** Одна категория. */
const oneCategory = (id: string): string => `c${id}`;

// ── Фикстура ──

/**
 * Свой тип ТС на прогон: гасить или занимать общий из наполнения нельзя — на нём стоят соседние
 * db-тесты, и «третий тип, которого нет ни в одном фильтре» перестал бы быть третьим.
 */
async function makeType(suffix: string, name: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicle_types (kind_id, code, name)
    SELECT id, ${`clf_${suffix}_${RUN}`}, ${name}
      FROM vehicle_kinds WHERE code = 'special_equipment'
    RETURNING id`);
  return res.rows[0]!.id;
}

/**
 * Категории типа. Категория в этой схеме не «строка с именем»: триггер
 * `vehicle_categories_consistency` требует, чтобы у типа была ТТХ, у категории — значение по
 * каждой, а сигнатура совпадала со значениями. Триггер отложен до конца транзакции, поэтому три
 * записи заводятся одной, а сигнатуру считает та же функция БД — руками её не сложить.
 *
 * Значения у категорий разные не для красоты: идентичность категории — набор значений ТТХ
 * (`UNIQUE (vehicle_type_id, spec_signature)`), и две категории одного типа с одним значением
 * попросту не завелись бы — а без двух соседок главный случай файла проверять нечем.
 */
async function makeCategories(typeId: string, names: string[]): Promise<string[]> {
  return ctx.db.transaction(async (tx) => {
    const spec = await tx.execute<{ id: string; code: string }>(
      sql`SELECT id, code FROM vehicle_specs ORDER BY code LIMIT 1`,
    );
    const { id: specId, code } = spec.rows[0]!;
    await tx.execute(
      sql`INSERT INTO vehicle_type_specs (vehicle_type_id, spec_id) VALUES (${typeId}, ${specId})`,
    );
    const ids: string[] = [];
    for (const [index, name] of names.entries()) {
      const value = 10 * (index + 1);
      const created = await tx.execute<{ id: string }>(sql`
        INSERT INTO vehicle_categories (vehicle_type_id, name, is_auto_name, spec_signature)
        VALUES (${typeId}, ${name}, false,
                vehicle_category_signature(jsonb_build_object(${code}::text, ${value}::numeric)))
        RETURNING id`);
      const categoryId = created.rows[0]!.id;
      await tx.execute(sql`
        INSERT INTO vehicle_category_spec_values (category_id, vehicle_type_id, spec_id, value_num)
        VALUES (${categoryId}, ${typeId}, ${specId}, ${value})`);
      ids.push(categoryId);
    }
    return ids;
  });
}

/** Позиция классификатора, стоящая за слотом фикстуры. */
function classificationOf(slot: Slot): { typeId: string; categoryId: string | null } {
  if (slot === 'A1') return { typeId: ctx.typeA, categoryId: ctx.catA1 };
  if (slot === 'A2') return { typeId: ctx.typeA, categoryId: ctx.catA2 };
  if (slot === 'B1') return { typeId: ctx.typeB, categoryId: ctx.catB1 };
  // Тип без категорий — законное состояние справочника («Ямобур»), а не пробел в данных.
  return { typeId: ctx.typeC, categoryId: null };
}

async function makeObject(suffix: string, name: string): Promise<string> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${`${MARK}-${suffix}`}, ${name}, 'г Москва, ул Тестовая, д 1')
    RETURNING id`);
  return res.rows[0]!.id;
}

/**
 * Заказ спецтехники строкой. Срок — сегодняшний день: им живёт «На объекте», а остальным выдачам
 * он безразличен. Статус задаётся снаружи: у каждой выдачи он свой и в отборе не участвует —
 * выдачу он определяет, а не сужает.
 */
async function makeRequest(
  objectId: string,
  slot: Slot,
  status: 'new' | 'confirmed' | 'done',
): Promise<void> {
  const { typeId, categoryId } = classificationOf(slot);
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicle_requests
      (object_id, request_type, vehicle_type_id, vehicle_category_id, status, comment, created_by)
    VALUES (${objectId}, 'special_equipment', ${typeId}, ${categoryId}, ${status},
            ${`Заявка ${slot} ${RUN}`}, ${ctx.userId})
    RETURNING id`);
  const id = res.rows[0]!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details
      (request_id, date_from, date_to, responsible_name, responsible_phone)
    VALUES (${id}, ${TODAY}::date, ${TODAY}::date, 'Иванов И. И.', '9990000000')`);
  requestSlots.set(id, slot);
}

/**
 * Своя машина парка на слот. Гараж отвечает про **весь** парк, поэтому строки прогона метятся
 * гаражным номером: без метки перечень считал бы вместе с машинами соседних db-тестов, и ответ
 * зависел бы от того, кто ещё сегодня прогонялся по этой базе.
 */
async function makeVehicle(slot: Slot): Promise<void> {
  const { typeId, categoryId } = classificationOf(slot);
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO vehicles
      (ownership, vehicle_type_id, vehicle_category_id, registration_number, garage_number)
    VALUES ('own', ${typeId}, ${categoryId}, ${`${MARK}${slot}`}, ${`${MARK}-${slot}`})
    RETURNING id`);
  vehicleSlots.set(res.rows[0]!.id, slot);
}

// ── Чтение выдач ──

/** Что тест читает из ответа списка: строку он узнаёт по идентификатору, остальное ему безразлично. */
interface ListJson {
  items: { id?: string; kind?: 'order' | 'weekly'; order?: { id: string } }[];
}

/** Цифра над таблицей: у журнала, среза и гаража она называется `total`, у заявок — по статусам. */
interface SummaryJson {
  total?: number;
  [key: string]: unknown;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await ctx.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: ctx.auth });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as T;
}

/** Слот фикстуры по идентификатору строки: чужая строка здесь означала бы дырявый отбор. */
function slotOf(map: Map<string, Slot>, id: string): Slot {
  const slot = map.get(id);
  if (slot === undefined) throw new Error(`В выдаче строка не из фикстуры: ${id}`);
  return slot;
}

/** Порядок выдач разный и в этом файле не проверяется: сравниваются составы. */
function sorted(slots: Slot[]): Slot[] {
  return [...slots].sort();
}

// ── Выдачи ──

interface Surface {
  name: string;
  /** Адрес списка с дописанным условием отбора. */
  listUrl: (filter: string) => string;
  /** Адрес сводки над тем же списком — с тем же условием. */
  summaryUrl: (filter: string) => string;
  readRows: (json: ListJson) => Slot[];
  readTotal: (json: SummaryJson) => number;
}

/** Строки списка обычной выдачи заявок: `items` — сами заявки. */
function requestRows(json: ListJson): Slot[] {
  return json.items.map((item) => slotOf(requestSlots, item.id!));
}

/** Строка ленты размечена видом документа; недельные строки к классификатору отношения не имеют. */
function feedRows(json: ListJson): Slot[] {
  return json.items
    .filter((item) => item.kind === 'order')
    .map((item) => slotOf(requestSlots, item.order!.id));
}

function totalField(json: SummaryJson): number {
  return Number(json.total);
}

/**
 * Сводка списка заявок отвечает не одной цифрой, а раскладкой по статусам, — «всего» у неё это
 * сумма: виджет над таблицей и складывает их в одну строку.
 */
function statusesTotal(json: SummaryJson): number {
  return REQUEST_STATUSES.reduce((sum, status) => sum + Number(json[status] ?? 0), 0);
}

const surfaces: Surface[] = [
  {
    name: 'список заявок (GET /vehicle-requests)',
    listUrl: (f) => `/vehicle-requests?pageSize=500&objectId=${ctx.listObject}&${f}`,
    summaryUrl: (f) => `/vehicle-requests/summary?objectId=${ctx.listObject}&${f}`,
    readRows: requestRows,
    readTotal: statusesTotal,
  },
  {
    // У ленты своя выборка (объединение с недельными заявками), а сводка над ней — та же, что у
    // списка: вкладка одна, и цифры в ней относятся к строкам, которые человек видит (Р4).
    name: 'лента раздела (GET /vehicle-requests/feed)',
    listUrl: (f) => `/vehicle-requests/feed?pageSize=500&objectId=${ctx.listObject}&${f}`,
    summaryUrl: (f) => `/vehicle-requests/summary?objectId=${ctx.listObject}&${f}`,
    readRows: feedRows,
    readTotal: statusesTotal,
  },
  {
    name: 'журнал закрытых (GET /vehicle-requests/history)',
    listUrl: (f) => `/vehicle-requests/history?pageSize=500&objectId=${ctx.historyObject}&${f}`,
    summaryUrl: (f) => `/vehicle-requests/history/summary?objectId=${ctx.historyObject}&${f}`,
    readRows: requestRows,
    readTotal: totalField,
  },
  {
    name: '«На объекте» (GET /vehicle-requests/on-site)',
    listUrl: (f) => `/vehicle-requests/on-site?pageSize=500&objectId=${ctx.onSiteObject}&${f}`,
    summaryUrl: (f) => `/vehicle-requests/on-site/summary?objectId=${ctx.onSiteObject}&${f}`,
    readRows: requestRows,
    readTotal: totalField,
  },
  {
    // Шестая выдача — по другой таблице (`vehicles`), и колонки классификатора там свои; фильтр
    // при этом тот же самый, и отвечать он обязан так же, как в заявках.
    name: 'перечень гаража (GET /garage/vehicles)',
    listUrl: (f) => `/garage/vehicles?pageSize=500&search=${MARK}&${f}`,
    summaryUrl: (f) => `/garage/vehicles/summary?search=${MARK}&${f}`,
    readRows: (json) => json.items.map((item) => slotOf(vehicleSlots, item.id!)),
    readTotal: totalField,
  },
];

async function rowsOf(surface: Surface, filter: string): Promise<Slot[]> {
  return surface.readRows(await getJson<ListJson>(surface.listUrl(filter)));
}

async function totalOf(surface: Surface, filter: string): Promise<number> {
  return surface.readTotal(await getJson<SummaryJson>(surface.summaryUrl(filter)));
}

// ── Случаи отбора ──

interface FilterCase {
  name: string;
  /** Условие лениво: идентификаторы фикстуры появляются только в `beforeAll`. */
  filter: () => string;
  /** Какие позиции фикстуры выдача обязана отдать — и никаких других. */
  rows: Slot[];
}

const CASES: FilterCase[] = [
  {
    name: 'набор из двух типов отдаёт строки обоих и не отдаёт третий',
    filter: () => `classifications=${wholeType(ctx.typeA)},${wholeType(ctx.typeB)}`,
    rows: ['A1', 'A2', 'B1'],
  },
  {
    // Две ветки условия сразу: `type IN (…) OR category IN (…)`. Пересечением они не считаются
    // никогда — «покажи весь тип B и вот эту категорию типа A» отвечает одним списком, а не пустым
    // множеством, которым обернулось бы «И».
    name: '«весь тип» и категория чужого типа — обе ветки в одной выдаче',
    filter: () => `classifications=${wholeType(ctx.typeB)},${oneCategory(ctx.catA1)}`,
    rows: ['B1', 'A1'],
  },
  {
    /*
     * Главный риск раскладки на две ветки. Спрошена одна категория — и попади в ответ соседняя
     * категория того же типа, выдача выглядела бы совершенно обычно: те же заявки, тот же тип,
     * просто строк больше, чем спрашивали. Такую ошибку не видно ни по коду ответа, ни глазами —
     * ловит её только фикстура с двумя категориями одного типа.
     */
    name: 'категория не тянет соседнюю категорию своего типа',
    filter: () => `classifications=${oneCategory(ctx.catA1)}`,
    rows: ['A1'],
  },
  {
    name: 'набор из одного типа отвечает всем типом',
    filter: () => `classifications=${wholeType(ctx.typeA)}`,
    rows: ['A1', 'A2'],
  },
  {
    name: 'старая пара «только тип» отвечает как прежде',
    filter: () => `vehicleTypeId=${ctx.typeA}`,
    rows: ['A1', 'A2'],
  },
  {
    name: 'старая пара «только категория» отвечает как прежде',
    filter: () => `vehicleCategoryId=${ctx.catA1}`,
    rows: ['A1'],
  },
  {
    /*
     * Прежнее «И» старой пары сохранено буквой. Сочетания «тип A + категория типа B» в базе не
     * бывает вовсе (составные ключи `vehicle_requests_category_type_fk` и
     * `vehicles_category_type_fk`), и сегодня такой запрос отвечает пустым списком. Приведи пару к
     * набору — ИЛИ вернуло бы весь тип A плюс всю категорию B: открытая со вчера вкладка получила
     * бы новый ответ на прежний вопрос, ровно то, чего расширение сервера обещает не делать.
     */
    name: 'несовпадающая старая пара (тип A + категория типа B) отвечает пусто',
    filter: () => `vehicleTypeId=${ctx.typeA}&vehicleCategoryId=${ctx.catB1}`,
    rows: [],
  },
  {
    // Р6: «весь тип» вместе с его же категорией не сворачивается и не удваивает строку — по ИЛИ
    // тип категорию поглощает сам. Дубль здесь означал бы, что ветки не объединены, а склеены.
    name: 'тип вместе со своей же категорией поглощает её и не удваивает строк',
    filter: () => `classifications=${wholeType(ctx.typeA)},${oneCategory(ctx.catA1)}`,
    rows: ['A1', 'A2'],
  },
];

describe.skipIf(!DB_URL)('отбор по позициям классификатора (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');
    const schema = await import('../src/db/schema');
    const app = await buildApp();

    const [created] = await db
      .insert(schema.users)
      .values({
        email: EMAIL,
        lastName: 'Тестовый',
        firstName: 'Администратор',
        middleName: 'Классификаторный',
        passwordHash: await hashPassword(PASSWORD),
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '10.77.0.1',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

    ctx = {
      app,
      db,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      userId: created!.id,
      typeA: undefined as never,
      typeB: undefined as never,
      typeC: undefined as never,
      catA1: undefined as never,
      catA2: undefined as never,
      catB1: undefined as never,
      listObject: undefined as never,
      historyObject: undefined as never,
      onSiteObject: undefined as never,
    };

    ctx.typeA = await makeType('a', `Тип A ${RUN}`);
    ctx.typeB = await makeType('b', `Тип B ${RUN}`);
    ctx.typeC = await makeType('c', `Тип C ${RUN}`);
    const [a1, a2] = await makeCategories(ctx.typeA, [`A1 ${RUN}`, `A2 ${RUN}`]);
    const [b1] = await makeCategories(ctx.typeB, [`B1 ${RUN}`]);
    ctx.catA1 = a1!;
    ctx.catA2 = a2!;
    ctx.catB1 = b1!;

    ctx.listObject = await makeObject('L', `Площадка списка ${RUN}`);
    ctx.historyObject = await makeObject('H', `Площадка журнала ${RUN}`);
    ctx.onSiteObject = await makeObject('S', `Площадка среза ${RUN}`);

    const slots: Slot[] = ['A1', 'A2', 'B1', 'C'];
    for (const slot of slots) {
      await makeRequest(ctx.listObject, slot, 'new');
      // Журнал показывает только закрытые заявки, срез — только взятые в работу: те же четыре
      // позиции заводятся под каждую выдачу своим статусом, иначе выдача пуста независимо от
      // фильтра, и проверять в ней нечего.
      await makeRequest(ctx.historyObject, slot, 'done');
      await makeRequest(ctx.onSiteObject, slot, 'confirmed');
      await makeVehicle(slot);
    }

    // Недельная заявка на площадке ленты: у неё позиции классификатора нет вовсе, и заданный
    // фильтр обязан убирать её строки целиком (Р5) — проверяется отдельным сценарием ниже.
    await ctx.db.execute(sql`
      INSERT INTO weekly_vehicle_requests (object_id, week_start, status, comment, created_by)
      VALUES (${ctx.listObject}, ${weekStartKey(TODAY)}::date, 'pending',
              ${`Неделя ${RUN}`}, ${ctx.userId})`);
  }, 180_000);

  afterAll(async () => {
    if (ctx?.db) {
      /*
       * Уборка за собой: база у db-тестов общая и живёт между прогонами, а этот файл заводит
       * собственный справочник — три типа и три категории. Оставленный тип попал бы в фильтры
       * соседних тестов и в справочник портала, а оставленная машина — в перечень гаража.
       *
       * Метка — префиксы, а не список заведённого: прибирать надо и за упавшим прогоном. Взяты они
       * шире одного прогона (`CLF-%`, а не `CLF-<RUN>-%`), чтобы уборка добирала хвосты прежних
       * падений; эти префиксы в тестах больше никто не занимает.
       *
       * Порядок обратен ссылкам: справочник держат заявки и машины (`RESTRICT` на типе и
       * категории), заявки и недели держат площадку и учётку. Детали заявки и значения ТТХ
       * категории уходят каскадом вместе со своими владельцами.
       */
      const ourObjects = sql`SELECT id FROM construction_objects WHERE code LIKE 'CLF-%'`;
      const ourTypes = sql`SELECT id FROM vehicle_types WHERE code LIKE 'clf%'`;
      await ctx.db.execute(sql`DELETE FROM vehicle_requests WHERE object_id IN (${ourObjects})`);
      await ctx.db.execute(
        sql`DELETE FROM weekly_vehicle_requests WHERE object_id IN (${ourObjects})`,
      );
      await ctx.db.execute(sql`DELETE FROM vehicles WHERE garage_number LIKE 'CLF-%'`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code LIKE 'CLF-%'`);
      await ctx.db.execute(
        sql`DELETE FROM vehicle_categories WHERE vehicle_type_id IN (${ourTypes})`,
      );
      await ctx.db.execute(
        sql`DELETE FROM vehicle_type_specs WHERE vehicle_type_id IN (${ourTypes})`,
      );
      await ctx.db.execute(sql`DELETE FROM vehicle_types WHERE code LIKE 'clf%'`);
      /*
       * Журнал — по автору и раньше сноса учётки: `actor_user_id` при удалении обнуляется, а не
       * удаляется, — и записи о входе оставались бы висеть без хозяина.
       */
      const ourUsers = sql`SELECT id FROM users WHERE email LIKE 'db-classification-%@example.invalid'`;
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${ourUsers})`);
      await ctx.db.execute(sql`DELETE FROM users WHERE id IN (${ourUsers})`);
    }
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  for (const surface of surfaces) {
    describe(surface.name, () => {
      for (const filterCase of CASES) {
        it(filterCase.name, async () => {
          const filter = filterCase.filter();
          expect(sorted(await rowsOf(surface, filter))).toEqual(sorted(filterCase.rows));
          // Цифра над таблицей относится к её строкам (Р4): считается сводка тем же условием,
          // что и список, — разойдись они, человек увидел бы число, которого в таблице нет.
          expect(await totalOf(surface, filter)).toBe(filterCase.rows.length);
        });
      }

      it('набор из одного элемента отвечает тем же, что старая одиночная пара', async () => {
        // Переход со старой пары обещает, что до перехода портала на набор ничего не изменится
        // (Р2, релиз A): один и тот же вопрос, заданный двумя формами, обязан дать один ответ.
        const byTypeSet = await rowsOf(surface, `classifications=${wholeType(ctx.typeA)}`);
        const byTypePair = await rowsOf(surface, `vehicleTypeId=${ctx.typeA}`);
        expect(sorted(byTypeSet)).toEqual(sorted(byTypePair));

        const byCategorySet = await rowsOf(surface, `classifications=${oneCategory(ctx.catA1)}`);
        const byCategoryPair = await rowsOf(surface, `vehicleCategoryId=${ctx.catA1}`);
        expect(sorted(byCategorySet)).toEqual(sorted(byCategoryPair));

        // И сводки тоже: у них своя схема запроса, и добавить набор в неё можно было забыть.
        expect(await totalOf(surface, `classifications=${wholeType(ctx.typeA)}`)).toBe(
          await totalOf(surface, `vehicleTypeId=${ctx.typeA}`),
        );
      });

      it('обе формы сразу отвергаются и списком, и сводкой', async () => {
        // Проверка «форма одна» стоит на **итоговых** схемах, и производных схем у списочной
        // четыре: журнал, лента, срез и гараж. Забудь её любая из них — выигравшая молча форма
        // и была бы тем дефектом, ради которого набор заводился.
        const both = `classifications=${wholeType(ctx.typeA)}&vehicleTypeId=${ctx.typeA}`;
        for (const url of [surface.listUrl(both), surface.summaryUrl(both)]) {
          const res = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1${url}`,
            headers: ctx.auth,
          });
          expect(res.statusCode, url).toBe(400);
        }
      });
    });
  }

  it('лента: непустой набор убирает недельные строки целиком (Р5)', async () => {
    // Недельная заявка — документ без позиции классификатора вовсе, и фильтр, которому у неё нет
    // соответствия, исключает её строки, а не проходит мимо: иначе «покажи автокраны» отвечало бы
    // вперемешку документами, у которых типа ТС не бывает.
    const all = await getJson<ListJson>(
      `/vehicle-requests/feed?pageSize=500&objectId=${ctx.listObject}`,
    );
    expect(all.items.some((item) => item.kind === 'weekly')).toBe(true);

    for (const filter of [
      `classifications=${wholeType(ctx.typeA)},${wholeType(ctx.typeB)}`,
      // Старая пара исключает их ровно так же — правило про заданный фильтр, а не про его форму.
      `vehicleTypeId=${ctx.typeA}`,
    ]) {
      const filtered = await getJson<ListJson>(
        `/vehicle-requests/feed?pageSize=500&objectId=${ctx.listObject}&${filter}`,
      );
      expect(
        filtered.items.some((item) => item.kind === 'weekly'),
        filter,
      ).toBe(false);
    }
  });
});
