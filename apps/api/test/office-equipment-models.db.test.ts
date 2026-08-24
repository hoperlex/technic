import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficeEquipmentDto, OfficeEquipmentModelDto } from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Справочник моделей аппаратов оргтехники и перевод карточек на ссылку — выпуск A
 * (план `docs/office-equipment-consumables-plan.md`, Р1–Р4, Р11, Р12; миграция
 * [0171](../drizzle/0171_office_equipment_models.sql), маршруты `routes/office-equipment-models.ts`
 * и `routes/office-equipment.ts`).
 *
 * ЗАЧЕМ БАЗА. Почти всё, ради чего заводился справочник, живёт не в коде, а в схеме, и на моках
 * проверяются только моки:
 *
 * - правило написания — две `IMMUTABLE`-функции, уникальный индекс по выражению и `CHECK`
 *   «наименование хранится уже свёрнутым»: «Ricoh IM 350», «RICOH IM 350» и «Ricoh␣␣IM 350» обязаны
 *   быть одной моделью во всех пяти местах сразу (Р4);
 * - зеркало имени — state-машина `BEFORE`-триггера из шести случаев, три из которых существуют
 *   ровно ради окна выката (Р3), и `AFTER`-триггер переименования, раскладывающий имя по всем
 *   карточкам, включая архивные;
 * - порядок блокировок при переименовании — свойство **пары** транзакций, а не одной: файл,
 *   прочитанный сверху вниз, показывает `LOCK TABLE`, но не показывает, что без него встречный
 *   порядок со старой правкой карточки даёт `40P01`. Доказывается это встречей двух соединений и
 *   контрольным клинчем — тем же приёмом, что в `assignment-lock-order.db.test.ts`;
 * - область счётчика `equipmentCount` считается тем же предикатом `officeEquipmentScopeWhere`, что
 *   и список техники (Р12), — и тест берёт предикат из `lib/access.ts`, а не пишет свою версию
 *   правила: разойдясь, они молча разрешили бы роли одной площадки узнать масштаб чужого парка.
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ СТАРЫМ ПУТЁМ, А ЧТО НОВЫМ. Legacy-ветка резолва (правка одного `name` у
 * карточки с уже проставленной ссылкой) проверяется прямым `UPDATE` и старым видом `PATCH`
 * — `{ name }` без `modelId`. Заливкой файлом её не проверить вовсе: после волны В2 обмен
 * файлом всегда пишет `model_id` сам, и тест на нём «проверял» бы код, которого больше нет.
 *
 * ИЗОЛЯЦИЯ. База db-тестов общая и живёт между прогонами: в ней лежит копия боевого парка, на
 * которой этот файл заодно и сверяется (первый случай). Поэтому всё своё помечено суффиксом
 * прогона `RUN` — наименования моделей, инвентарные номера, коды площадок и отделов, адреса
 * учёток, — и `afterAll` уносит ровно его. Разбор парка, которому нужны карточки БЕЗ ссылки (такого
 * состояния после наката не бывает), собирается в транзакции с `ROLLBACK`: она гасит триггер
 * зеркала, кладёт карточки, зовёт разбор из самой миграции и откатывает всё целиком.
 *
 * ФАЙЛ БЕРЁТ ТАБЛИЧНУЮ БЛОКИРОВКУ. Случаи порядка блокировок на секунду-другую запирают запись в
 * `office_equipment` (`SHARE ROW EXCLUSIVE` — своей же ручкой переименования). Соседей по прогону
 * это не роняет, но заставляет ждать: если гонять файл вместе с другими `*.db.test.ts` по одной
 * `TEST_DATABASE_URL`, чужая правка оргтехники встанет в очередь.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_archive_test \
 *     pnpm --filter @technic/api test office-equipment-models
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';

/** Сколько соединение файла готово ждать чужую блокировку, прежде чем упасть текстом. */
const LOCK_TIMEOUT_MS = 8_000;
/** Сколько ждём, пока запрос встанет в очередь: барьер, а не пауза «на глазок». */
const QUEUE_TIMEOUT_MS = 15_000;

// ── Наименования моделей. Все с суффиксом прогона: справочник общий, и «Ricoh IM 350» в нём есть ──

const IM350 = `Ricoh IM 350 ${RUN}`;
const IM350_UPPER = `RICOH IM 350 ${RUN}`;
const IM350_WIDE = `Ricoh  IM 350 ${RUN}`;
/** Вторая модель того же типа: на неё карточка переезжает старой правкой имени. */
const IM550 = `Ricoh IM 550F ${RUN}`;
const KYOCERA = `Kyocera M2040 ${RUN}`;
const BROTHER = `Brother HL-1223 ${RUN}`;
const PANTUM = `Pantum M6500 ${RUN}`;
const XEROX = `Xerox B310 ${RUN}`;
const CANON = `Canon LBP223 ${RUN}`;
const SHARP = `Sharp AR-6020 ${RUN}`;
const FS1040 = `Kyocera FS-1040 ${RUN}`;
const HP = `HP LaserJet M15 ${RUN}`;
/** Модель, которую переименовывают под нагрузкой: во время правки в парк ломятся две вставки. */
const IM430 = `Ricoh IM 430 ${RUN}`;
const IM430_RENAMED = `Ricoh IM 430F ${RUN}`;

/**
 * Невидимые символы поимённо: в тексте теста они обязаны быть escape-последовательностями, а не
 * собой. Байт, который не видно на ревью, теряется при первом же копировании файла — и случай про
 * неразрывный пробел тихо превращается в случай про обычный.
 */
/** U+00A0 — его ставит Word автозаменой и Ctrl+Shift+Space, он же приезжает из выгрузок Excel. */
const NBSP = '\u00a0';
/** U+202F — узкий неразрывный: им свежие сборки Windows разделяют разряды числа. */
const NNBSP = '\u202f';
/** U+200B — нулевая ширина: НЕ пробел, а место возможного переноса внутри слова. */
const ZWSP = '\u200b';

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: ведёт справочник и видит парк целиком — область его роли пуста. */
  admin: TestUser;
  /** Роль объекта (`shtab`): в счётчике у неё только карточки своих площадок. */
  objectUser: TestUser;
  /** Роль отдела: свои отделы **и** неразмеченная техника. */
  deptUser: TestUser;
  /** Роль отдела без единого отдела: остаётся ровно неразмеченная техника. */
  deptEmptyUser: TestUser;
  /** Роль отдела со сквозной областью модуля (надстройка «Согласование ИТ»): весь парк. */
  wideUser: TestUser;
  objectId: string;
  foreignObjectId: string;
  departmentId: string;
  foreignDepartmentId: string;
  /** Тип «МФУ» — основной тип файла. */
  mfpTypeId: string;
  /** Тип «Принтер» — им проверяется, что одноимённая модель другого типа законна. */
  printerTypeId: string;
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

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

/** Инвентарный номер: по нему `afterAll` и находит карточки этого прогона. */
let cardNo = 0;
function nextInventory(): string {
  cardNo += 1;
  return `OEM-${RUN}-${cardNo}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: auth,
    remoteAddress: nextAddress(),
    ...(payload ? { payload } : {}),
  });
}

// ── Ручки справочника моделей ──

async function createModel(input: {
  typeId: string;
  name: string;
  manufacturer?: string;
  isActive?: boolean;
}): Promise<OfficeEquipmentModelDto> {
  const res = await inject('POST', '/api/v1/office-equipment-models', ctx.admin.auth, {
    equipmentTypeId: input.typeId,
    name: input.name,
    ...(input.manufacturer === undefined ? {} : { manufacturer: input.manufacturer }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentModelDto;
}

/** Перечень моделей глазами субъекта: счётчик парка зависит от смотрящего (Р12). */
async function models(auth: Auth, search = RUN): Promise<OfficeEquipmentModelDto[]> {
  const res = await inject(
    'GET',
    `/api/v1/office-equipment-models?pageSize=100&search=${encodeURIComponent(search)}`,
    auth,
  );
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: OfficeEquipmentModelDto[] }).items;
}

/**
 * Строка перечня по наименованию. Тип спрашивается там, где одноимённые модели заведены в двух
 * типах: пара «тип + написание» — это и есть ключ справочника, и без типа вопрос неполон (Р1).
 */
async function modelRow(
  auth: Auth,
  name: string,
  typeId?: string,
): Promise<OfficeEquipmentModelDto> {
  const rows = (await models(auth)).filter(
    (m) => m.name === name && (typeId === undefined || m.type.id === typeId),
  );
  expect(rows, `в перечне нет ровно одной модели «${name}»`).toHaveLength(1);
  return rows[0]!;
}

// ── Ручки справочника техники ──

interface CardInput {
  typeId?: string;
  /** Старый путь: карточка называет модель именем, ссылку проставляет триггер (Р3). */
  name?: string;
  /** Новый путь: карточка называет модель ссылкой, имя приезжает зеркалом. */
  modelId?: string;
  objectId?: string;
  departmentId?: string | null;
  isActive?: boolean;
}

async function createCard(input: CardInput): Promise<OfficeEquipmentDto> {
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: input.typeId ?? ctx.mfpTypeId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    inventoryNumber: nextInventory(),
    objectId: input.objectId ?? ctx.objectId,
    departmentId: input.departmentId ?? null,
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentDto;
}

/**
 * Строка карточки сырыми колонками. Через SQL, а не через ручку, по двум причинам: архивную
 * карточку ручка не отдаёт вовсе (404 по правилу архива), а предмет проверок — именно `model_id` и
 * `name` в базе, то есть то, что оставил после себя триггер.
 */
async function cardRow(id: string): Promise<{
  name: string;
  modelId: string | null;
  typeId: string;
  updatedAt: string;
}> {
  const res = await ctx.db.execute<{
    name: string;
    model_id: string | null;
    equipment_type_id: string;
    updated_at: string;
  }>(sql`SELECT name, model_id, equipment_type_id, updated_at::text AS updated_at
           FROM office_equipment WHERE id = ${id}`);
  const row = res.rows[0];
  if (!row) throw new Error(`карточки ${id} нет в базе`);
  return {
    name: row.name,
    modelId: row.model_id,
    typeId: row.equipment_type_id,
    updatedAt: row.updated_at,
  };
}

/** Модель по паре «тип + ключ написания» — той же функцией, что стоит в уникальном индексе. */
async function modelByKey(typeId: string, name: string): Promise<{ id: string; name: string }[]> {
  const res = await ctx.db.execute<{ id: string; name: string }>(sql`
    SELECT id, name FROM office_equipment_models
     WHERE equipment_type_id = ${typeId}
       AND office_equipment_model_key(name) = office_equipment_model_key(${name})`);
  return res.rows;
}

// ── Соединения для гонок ──

/** Отдельное соединение с пределом ожидания: зависший прогон читается как «сломался тест». */
async function openClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  return client;
}

/** Соединение-наблюдатель: только опрос очередей, ни одной блокировки за собой. */
async function openProbe(): Promise<pg.Client> {
  const probe = new pg.Client({ connectionString: DB_URL });
  await probe.connect();
  return probe;
}

/**
 * Запрос, вставший в очередь за этим бэкендом: кто (`pid`), с чем (`query`) и НА ЧЁМ он ждёт
 * (`waitEvent`).
 *
 * Третье поле — не украшение, а половина проверки порядка блокировок. `relation` означает, что
 * дверь встала на табличной блокировке (шаг 1 Р3), `transactionid` — что она ждёт чужую строку,
 * то есть уже внутри триггера. Ответ «дождались» без этого различения одинаков для рабочего и
 * сломанного кода: очередь-то образуется в обоих случаях, только на разных замках.
 */
interface Waiter {
  pid: number;
  query: string;
  waitEvent: string | null;
}

async function waitersBehind(probe: pg.Client, pid: number): Promise<Waiter[]> {
  const { rows } = await probe.query<Waiter>(
    `SELECT pid, query, wait_event AS "waitEvent" FROM pg_stat_activity
      WHERE pid <> $1 AND $1 = ANY(pg_blocking_pids(pid))`,
    [pid],
  );
  return rows;
}

/**
 * Ждём появления очереди, а не спим наугад.
 *
 * Наблюдатель — ОТДЕЛЬНОЕ соединение и обязательно вне транзакции: снимок `pg_stat_activity`
 * кешируется на всю транзакцию читателя, и опрос изнутри держателя блокировки показывал бы текст,
 * снятый первым же чтением (подробнее — в `assignment-lock-order.db.test.ts`, откуда приём и взят).
 */
async function queuedBehind(
  probe: pg.Client,
  pid: number,
  what: string,
  expected?: RegExp,
  count = 1,
): Promise<Waiter[]> {
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;
  // Что вообще успело постоять в очереди — для текста отказа: «ожидаемого запроса не дождались, а
  // ждали вот эти» отвечает на вопрос «а что тогда пошло не так», тогда как «очереди нет» не
  // отвечает ни на что. `pg_blocking_pids` при этом всегда свеж (он читает менеджер блокировок), а
  // текст запроса приезжает из статистики и на миг отстаёт — отсюда и ожидание по образцу, а не
  // проверка первой попавшейся строки.
  const seen = new Set<string>();
  for (;;) {
    const rows = await waitersBehind(probe, pid);
    for (const row of rows) seen.add(`${row.query} [${row.waitEvent}]`);
    const hits = rows.filter((row) => !expected || expected.test(row.query));
    if (hits.length >= count) return hits;
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: в очереди за бэкендом ${pid} так и не появил${count > 1 ? 'ись' : 'ся'} ` +
          `ожидаемый запрос${expected ? ` (${String(expected)}, нужно ${count})` : ''}; ` +
          `видели: ${[...seen].join(' | ') || '—'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Один ждущий — обычный случай: сцена рассчитана ровно на одну дверь в очереди. */
async function oneQueuedBehind(
  probe: pg.Client,
  pid: number,
  what: string,
  expected?: RegExp,
): Promise<Waiter> {
  return (await queuedBehind(probe, pid, what, expected))[0]!;
}

async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]!.pid;
}

/**
 * Сцена гонки с удалением модели: соседняя транзакция уносит строку справочника ровно тогда, когда
 * дверь уже прошла свою проверку и дошла до триггера зеркала.
 *
 * Удаление идёт `FOR UPDATE` + `DELETE` и остаётся незакоммиченным: проверка маршрута строку ещё
 * видит, а `SELECT … FOR KEY SHARE` внутри триггера уже встаёт в очередь за чужой транзакцией.
 * Ожидание на `transactionid` — обязательная часть сцены, а не наблюдение: без него случай
 * одинаково зелен и там, где модель удалили заранее, то есть там, где гонки не было вовсе.
 */
async function whileModelDeleted(
  modelId: string,
  door: () => ReturnType<typeof inject>,
  what: string,
  expected: RegExp,
): Promise<Awaited<ReturnType<typeof inject>>> {
  const eraser = await openClient();
  const probe = await openProbe();
  let pending: ReturnType<typeof inject> | undefined;
  try {
    await eraser.query('BEGIN');
    await eraser.query('SELECT 1 FROM office_equipment_models WHERE id = $1 FOR UPDATE', [modelId]);
    await eraser.query('DELETE FROM office_equipment_models WHERE id = $1', [modelId]);

    pending = door();
    const waiter = await oneQueuedBehind(probe, await backendPid(eraser), what, expected);
    expect(waiter.waitEvent, `${what}: дверь проскочила мимо гонки, а не ждала в триггере`).toBe(
      'transactionid',
    );

    await eraser.query('COMMIT');
    const res = await pending;
    pending = undefined;
    return res;
  } finally {
    await eraser.query('ROLLBACK').catch(() => undefined);
    await pending?.catch(() => undefined);
    await eraser.end();
    await probe.end();
  }
}

/**
 * Отказ базы, разобранный так же, как его разбирает сервер: drizzle оборачивает ошибку драйвера в
 * свою, и код с именем ограничения лежат не на верхнем объекте, а в `cause` (`pgErrorOf`). Прямая
 * проверка `e.constraint` молча не сработала бы — и тест зеленел бы на любой другой ошибке.
 *
 * Текст собирается по всей цепочке причин: у обёртки он про запрос, а слова триггера — в самой
 * ошибке драйвера.
 */
async function dbRefusal(
  run: Promise<unknown>,
): Promise<{ code?: string; constraint?: string; message: string }> {
  const { pgErrorOf } = await import('../src/lib/pg-error');
  try {
    await run;
  } catch (e) {
    const info = pgErrorOf(e);
    let message = '';
    let current: unknown = e;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      const candidate = current as { message?: string; cause?: unknown };
      if (typeof candidate.message === 'string') message += `${candidate.message}\n`;
      current = candidate.cause;
    }
    return { code: info?.code, constraint: info?.constraint, message };
  }
  throw new Error('база приняла запись, которую обязана была отбить');
}

/**
 * Разбор парка — ЗАПРОСОМ ИЗ САМОЙ МИГРАЦИИ, а не его копией в тесте. Копия разошлась бы с
 * оригиналом на первой же правке правила и продолжала бы зеленеть: канон выбирался бы по-старому
 * там, где база выбирает его по-новому. Не нашлось — падаем словами, а не молча проверяем пустоту.
 */
function migrationParseSql(): string {
  const text = readFileSync(
    new URL('../drizzle/0171_office_equipment_models.sql', import.meta.url),
    'utf8',
  );
  const found = /WITH variants AS \([\s\S]*?ON CONFLICT DO NOTHING;/.exec(text);
  if (!found) {
    throw new Error(
      'в миграции 0171 не нашёлся разбор парка (`WITH variants … ON CONFLICT DO NOTHING;`) — ' +
        'тест обязан звать её запрос, а не свою копию правила',
    );
  }
  return found[0];
}

describe.skipIf(!DB_URL)('модели аппаратов оргтехники: справочник и зеркало имени', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);

    // Учётки, площадки и отделы заводятся SQL: форма учётки — предмет своих тестов, здесь они
    // декорации, без которых не разложить четыре области.
    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-oem-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const makeObject = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`OEM-${tag}-${RUN}`}, ${`Тестовая площадка моделей ${tag} ${RUN}`},
                'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const makeDepartment = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name)
        VALUES (${`OEM-${tag}-${RUN}`}, ${`Тестовый отдел моделей ${tag} ${RUN}`})
        RETURNING id`);
      return res.rows[0]!.id;
    };

    const objectId = await makeObject('O');
    const foreignObjectId = await makeObject('OF');
    const departmentId = await makeDepartment('D');
    const foreignDepartmentId = await makeDepartment('DF');

    const admin = await makeUser('admin', 'admin');
    const objectUser = await makeUser('obj', 'shtab');
    const deptUser = await makeUser('dept', 'department');
    const deptEmptyUser = await makeUser('deptx', 'department');
    // Сквозная область — от НАДСТРОЙКИ, а не от роли: отдел у него заведомо чужой, и весь парк он
    // видит только потому, что «Согласование ИТ» расширяет область модуля (ADR 0106, решение 2).
    const wideUser = await makeUser('wide', 'department');

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${objectUser.id}, ${objectId})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${deptUser.id}, ${departmentId}),
             (${wideUser.id}, ${foreignDepartmentId})`);
    // Надстройка выдаётся сервисом, а не прямой вставкой: с шага 1a перехода на назначаемые
    // полномочия она пишет две таблицы одной транзакцией, и половина фикстуры оставила бы учётку
    // без прав (тот же довод, что в `service-request-flow.db.test.ts`).
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, wideUser.id, ['office_equipment_it_approver'], admin.id);
    });

    const app = await buildApp();

    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }
    const withAuth = async (u: { id: string; email: string }): Promise<TestUser> => ({
      ...u,
      auth: await login(u.email),
    });

    const types = await db.execute<{ id: string; code: string }>(
      sql`SELECT id, code FROM office_equipment_types WHERE code IN ('mfp', 'printer')`,
    );
    const mfpTypeId = types.rows.find((r) => r.code === 'mfp')?.id;
    const printerTypeId = types.rows.find((r) => r.code === 'printer')?.id;
    if (!mfpTypeId || !printerTypeId) {
      throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');
    }

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(admin),
      objectUser: await withAuth(objectUser),
      deptUser: await withAuth(deptUser),
      deptEmptyUser: await withAuth(deptEmptyUser),
      wideUser: await withAuth(wideUser),
      objectId,
      foreignObjectId,
      departmentId,
      foreignDepartmentId,
      mfpTypeId,
      printerTypeId,
    };
  }, 180_000);

  /**
   * Уборка. База общая, и в ней лежит копия боевого парка — файл уносит ровно своё, опознавая его
   * по суффиксу прогона. Порядок задан внешними ключами: модель, на которую ссылается карточка, не
   * удаляется (`ON DELETE RESTRICT`, Р11) — значит карточки первыми.
   */
  afterAll(async () => {
    await ctx?.app.close();
    if (ctx?.db) {
      await ctx.db.execute(
        sql`DELETE FROM office_equipment WHERE inventory_number LIKE ${`OEM-${RUN}-%`}`,
      );
      // `ILIKE`, а не `LIKE`: часть случаев переименовывает модель в верхний регистр (правка
      // написания — законная операция справочника), и точное сравнение оставило бы такую строку в
      // общей базе навсегда.
      await ctx.db.execute(sql`DELETE FROM office_equipment_models WHERE name ILIKE ${`%${RUN}%`}`);
      const users = sql`SELECT id FROM users WHERE email LIKE ${`db-oem-%-${RUN}@example.invalid`}`;
      await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${users})`);
      await ctx.db.execute(
        sql`DELETE FROM users WHERE email LIKE ${`db-oem-%-${RUN}@example.invalid`}`,
      );
      await ctx.db.execute(sql`DELETE FROM departments WHERE code LIKE ${`OEM-%-${RUN}`}`);
      await ctx.db.execute(sql`DELETE FROM construction_objects WHERE code LIKE ${`OEM-%-${RUN}`}`);
    }
    await ctx?.closeDb();
  });

  // ── 1. Разбор парка и правило написания (Р4) ──

  it('накат не потерял ни одной карточки: у всех есть модель, имя — её копия', async () => {
    // Караул миграции проверял это в момент наката; здесь то же самое спрашивается у базы, в
    // которой с тех пор жили и тесты, и заливки. Инвариант «имя — копия модели» держит триггер, и
    // если он где-то не сработал, выпуск B (`SET NOT NULL`) не встанет вовсе.
    const orphans = await ctx.db.execute<{ c: number }>(
      sql`SELECT count(*)::int AS c FROM office_equipment WHERE model_id IS NULL`,
    );
    expect(orphans.rows[0]!.c, 'карточки без модели после наката 0171').toBe(0);

    const drifted = await ctx.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c
        FROM office_equipment e
        JOIN office_equipment_models m ON m.id = e.model_id
       WHERE e.name IS DISTINCT FROM m.name`);
    expect(drifted.rows[0]!.c, 'имя карточки разошлось с именем модели').toBe(0);
  });

  it('три написания одной модели дают одну строку справочника, а карточки — канон', async () => {
    // Старый путь записи (одно `name`, ссылки нет) — именно он и разводит написания: резолв
    // триггера ищет по паре «тип + ключ написания», а ключ у всех трёх один.
    const first = await createCard({ name: IM350 });
    const upper = await createCard({ name: IM350_UPPER });
    const wide = await createCard({ name: IM350_WIDE });

    expect(first.model?.id).toBeTruthy();
    expect(upper.model?.id).toBe(first.model!.id);
    expect(wide.model?.id).toBe(first.model!.id);

    // Имя карточки — копия модели, а не то, что прислал старый клиент: иначе в парке остались бы
    // три написания при одной модели, то есть ровно то разнописание, ради которого справочник и
    // заводился.
    expect(first.name).toBe(IM350);
    expect(upper.name).toBe(IM350);
    expect(wide.name).toBe(IM350);
    expect(await modelByKey(ctx.mfpTypeId, IM350_UPPER)).toHaveLength(1);
  });

  it('канон разбора — самое частое написание, и частота считается по свёрнутому', async () => {
    /*
     * Разбор парка — шаг миграции, и после наката такого состояния (карточки без ссылки, написания
     * вразнобой) в базе не бывает. Поэтому оно собирается заново в транзакции с `ROLLBACK`: на
     * время транзакции гасится триггер зеркала — иначе он проставит ссылку и выровняет написание
     * раньше, чем разбор увидит хоть один вариант, — кладутся карточки, зовётся запрос **из самой
     * миграции**, и всё откатывается целиком. Гашение триггера тоже откатывается: `ALTER TABLE` в
     * Postgres транзакционен.
     *
     * Пока транзакция идёт, она держит на `office_equipment` сильную блокировку — чужая запись в
     * парк подождёт. Случай короткий, и это осознанная плата за проверку правила, которое иначе не
     * проверяется вовсе.
     */
    const c = await openClient();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE office_equipment DISABLE TRIGGER office_equipment_model_mirror');

      const seed = async (name: string, times: number): Promise<void> => {
        for (let i = 0; i < times; i += 1) {
          await c.query(
            `INSERT INTO office_equipment (equipment_type_id, name, object_id, inventory_number)
             VALUES ($1, $2, $3, $4)`,
            [ctx.mfpTypeId, name, ctx.objectId, nextInventory()],
          );
        }
      };
      // Группа 1: три «RICOH IM 550F» против двух «Ricoh IM 550F» — побеждает частое написание.
      await seed(IM550.toUpperCase(), 3);
      await seed(IM550, 2);
      // Группа 2: три карточки с двойным внутренним пробелом и две без него. Это ПЯТЬ карточек
      // одного написания, а не два варианта: частота считается по свёрнутому. Иначе лишний пробел
      // не только делил бы группу, но и выигрывал бы ничью — и уехал бы в справочник.
      await seed(`Ricoh  IM 660 ${RUN}`, 3);
      await seed(`Ricoh IM 660 ${RUN}`, 2);

      const before = await c.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM office_equipment_models',
      );
      await c.query(migrationParseSql());
      const after = await c.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM office_equipment_models',
      );
      // Ровно две новые строки: разбор идемпотентен (на этом стоит выпуск B, повторяющий его по
      // наполненному справочнику), и по уже разобранному парку он не заводит ничего.
      expect(after.rows[0]!.c - before.rows[0]!.c).toBe(2);

      const canon = async (name: string): Promise<string[]> => {
        const { rows } = await c.query<{ name: string }>(
          `SELECT name FROM office_equipment_models
            WHERE equipment_type_id = $1
              AND office_equipment_model_key(name) = office_equipment_model_key($2)`,
          [ctx.mfpTypeId, name],
        );
        return rows.map((r) => r.name);
      };
      expect(await canon(IM550)).toEqual([IM550.toUpperCase()]);
      expect(await canon(`Ricoh IM 660 ${RUN}`)).toEqual([`Ricoh IM 660 ${RUN}`]);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }, 60_000);

  it('одно наименование в двух типах — две законные модели, в одном — 409', async () => {
    // Пара «тип + написание» разводит одинаково названные принтер и МФУ (Р1): картридж подходит
    // модели вместе с её типом, и слить их значило бы предложить тонер МФУ для принтера.
    const printerTwin = await createModel({ typeId: ctx.printerTypeId, name: IM350 });
    expect(printerTwin.name).toBe(IM350);
    expect(printerTwin.type.id).toBe(ctx.printerTypeId);

    // В своём типе занято — и занято по ключу, а не по строке: разный регистр и лишние пробелы
    // это одна и та же модель.
    const dup = await inject('POST', '/api/v1/office-equipment-models', ctx.admin.auth, {
      equipmentTypeId: ctx.mfpTypeId,
      name: IM350_WIDE,
    });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().message).toContain('уже заведена');
  });

  it('маршрут сворачивает написание сам: в справочник двойной пробел не попадает', async () => {
    // Свернуть обязан маршрут — функцией базы. Не свернул бы: `CHECK` таблицы отбил бы запись
    // пятисоткой про ограничение, о котором человек не спрашивал (Р4).
    const created = await createModel({ typeId: ctx.mfpTypeId, name: `  Sharp   MX  ${RUN}  ` });
    expect(created.name).toBe(`Sharp MX ${RUN}`);
  });

  it('неразрывный пробел схлопывается наравне с обычным: одна модель, а не двойник', async () => {
    /*
     * `\s` в Postgres опирается на ctype локали и НЕРАЗРЫВНЫЕ пробелы пробелами не считает — ни
     * U+00A0, ни узкий U+202F. А приезжают они постоянно: Word ставит первый автозаменой, свежие
     * сборки Windows разделяют вторым разряды числа, обмен файлом (ADR 0073) кормит справочник
     * ровно из этих документов. Без расширенного класса «Ricoh<NBSP>IM 350» и «Ricoh IM 350» дают
     * разные ключи, уникальный индекс пропускает обе строки, и человек видит в списке два
     * одинаковых наименования, не понимая, какое настоящее. Невидимый двойник хуже отказа.
     */
    const plain = `Ricoh IM 850 ${RUN}`;
    const withNbsp = await createCard({ name: `Ricoh${NBSP}IM 850 ${RUN}` });
    const withNarrow = await createCard({ name: `Ricoh${NNBSP}IM${NNBSP}850 ${RUN}` });
    const withPlain = await createCard({ name: plain });

    expect(withNarrow.model?.id).toBe(withNbsp.model?.id);
    expect(withPlain.model?.id).toBe(withNbsp.model?.id);
    // В справочник и в карточки уезжает обычный пробел: невидимый символ не должен жить в
    // наименовании, по которому потом ищут глазами.
    expect(withNbsp.name).toBe(plain);
    expect(withNarrow.name).toBe(plain);
    expect(await modelByKey(ctx.mfpTypeId, plain)).toHaveLength(1);
  });

  it('правило идемпотентно: f(f(x)) = f(x) на краях, табах и неразрывных пробелах', async () => {
    /*
     * Идемпотентность — не изящество, а условие работоспособности: на таблице стоит
     * `CHECK (name = office_equipment_model_name_normalize(name))`, и функция, чей результат не
     * проходит собственную проверку, означала бы отказ маршруту, нормализовавшему ввод ровно как
     * велено. Ломается это порядком внутри функции: `btrim` без второго аргумента снимает ТОЛЬКО
     * пробелы, и краевой таб он не трогает — схлопывание после него делает из таба краевой пробел,
     * убирать который уже некому.
     *
     * Проверяется набором входов, а не одним: краевые табы, переводы строки и неразрывные пробелы —
     * это разные ветки одного правила, и «работает на одном» здесь ничего не значит.
     */
    const inputs = [
      '  Ricoh IM 350  ',
      `\tRicoh\tIM 350\n`,
      `Ricoh${NBSP}${NBSP}IM 350`,
      `${NBSP}Ricoh IM 350${NBSP}`,
      `${NNBSP}\tRicoh${NNBSP} IM${NBSP}350 \n`,
      'Ricoh   IM 350',
    ];
    const c = await openClient();
    try {
      const { rows } = await c.query<{ notIdempotent: number; notTrimmed: number; result: string }>(
        `SELECT count(*) FILTER (
                  WHERE office_equipment_model_name_normalize(office_equipment_model_name_normalize(t))
                     IS DISTINCT FROM office_equipment_model_name_normalize(t))::int AS "notIdempotent",
                count(*) FILTER (
                  WHERE office_equipment_model_name_normalize(t) <> 'Ricoh IM 350')::int AS "notTrimmed",
                min(office_equipment_model_name_normalize(t)) AS result
           FROM unnest($1::text[]) AS t`,
        [inputs],
      );
      expect(rows[0]!.notIdempotent, 'f(f(x)) разошлось с f(x)').toBe(0);
      // Все шесть входов — это одно и то же наименование: правило снимает края и схлопывает
      // середину независимо от того, каким именно пробельным символом их набрали.
      expect(rows[0]!.notTrimmed).toBe(0);
      expect(rows[0]!.result).toBe('Ricoh IM 350');
    } finally {
      await c.end();
    }
  });

  it('имя из одних неразрывных пробелов отбивается словами про модель, а не чужим ограничением', async () => {
    // `office_equipment_name_not_blank_check` здесь бы не сработал вовсе: `btrim` неразрывные
    // пробелы не снимает, и такое имя прошло бы его насквозь. Ловит его резолв — до того, как
    // пойдёт заводить модель с пустым наименованием: человек обязан прочитать про модель, а не про
    // ограничение справочника, которого он не касался.
    const refusal = await dbRefusal(
      ctx.db.execute(sql`
        INSERT INTO office_equipment (equipment_type_id, name, object_id, inventory_number)
        VALUES (${ctx.mfpTypeId}, ${`${NBSP}${NNBSP}${NBSP}`}, ${ctx.objectId}, ${nextInventory()})`),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('Наименование модели пусто');
    // Имени ограничения нет — значит бросил триггер, а не `CHECK`: разбор ошибки в маршрутах
    // держится ровно на этом различии.
    expect(refusal.constraint).toBeUndefined();
  });

  it('нулевая ширина пробелом не считается и даёт свою модель — так и задумано', async () => {
    // U+200B и мягкий перенос U+00AD отмечают место переноса ВНУТРИ слова. Схлопни их в пробел — и
    // «Ricoh<U+00AD>IM» превратится в «Ricoh IM», то есть правило само испортит наименование.
    // Лишняя строка справочника честнее тихо изменённого имени; случай стоит здесь затем, чтобы
    // следующий читатель нашёл объяснение, а не «дефект».
    const plain = await createCard({ name: `Ricoh IM 870 ${RUN}` });
    const zeroWidth = await createCard({ name: `Ricoh${ZWSP}IM 870 ${RUN}` });
    expect(zeroWidth.model?.id).not.toBe(plain.model?.id);
    expect(zeroWidth.name).toBe(`Ricoh${ZWSP}IM 870 ${RUN}`);
  });

  // ── 2. State-машина зеркала: все шесть случаев (Р3) ──

  it('INSERT со ссылкой: имя приезжает из модели, присланное — не в счёт', async () => {
    const model = await createModel({ typeId: ctx.mfpTypeId, name: KYOCERA });
    // Имя присылается заведомо чужое: у запроса, назвавшего модель ссылкой, оно ничего не решает.
    const card = await createCard({ modelId: model.id, name: 'Придуманное имя из старой формы' });
    expect(card.model?.id).toBe(model.id);
    expect(card.name).toBe(KYOCERA);
  });

  it('INSERT без ссылки: недостающая модель заводится сама и попадает в справочник', async () => {
    const card = await createCard({ name: BROTHER });
    expect(card.model?.name).toBe(BROTHER);

    const row = await modelRow(ctx.admin.auth, BROTHER);
    expect(row.type.id).toBe(ctx.mfpTypeId);
    // Производителя разбор не выдумывает: его проставит ИТ-служба руками.
    expect(row.manufacturer).toBe('');
    expect(row.isUsed).toBe(true);
  });

  it('UPDATE со сменой ссылки: имя приезжает из новой модели', async () => {
    const card = await createCard({ name: IM350 });
    const target = await modelRow(ctx.admin.auth, KYOCERA);

    const res = await inject('PATCH', `/api/v1/office-equipment/${card.id}`, ctx.admin.auth, {
      modelId: target.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as OfficeEquipmentDto;
    expect(dto.model?.id).toBe(target.id);
    expect(dto.name).toBe(KYOCERA);
  });

  it('старый PATCH одним `name` переставляет карточку на другую модель', async () => {
    /*
     * Legacy-ветка выпуска A и главный довод Р3: у существующей карточки ссылка уже стоит, и
     * наивное зеркало вернуло бы имя ТЕКУЩЕЙ модели — то есть старая правка молча не сработала бы.
     * Человек правит модель так, как умеет сегодня, — текстом, — и карточка обязана переехать
     * по-настоящему.
     *
     * Проверяется это старым видом запроса (`{ name }` без `modelId`), а не заливкой файлом: после
     * волны В2 файл всегда пишет ссылку сам и в эту ветку не заходит вовсе.
     */
    const card = await createCard({ name: IM350 });
    const from = card.model!.id;

    const res = await inject('PATCH', `/api/v1/office-equipment/${card.id}`, ctx.admin.auth, {
      name: IM550,
    });
    expect(res.statusCode, res.body).toBe(200);
    const dto = res.json() as OfficeEquipmentDto;
    expect(dto.model?.id).not.toBe(from);
    expect(dto.model?.name).toBe(IM550);
    expect(dto.name).toBe(IM550);

    // Вторая правка — написанием, отличающимся регистром: карточка обязана вернуться на ПЕРВУЮ
    // модель (ключ тот же), а не завести третью, и приехать с её каноном.
    const back = await inject('PATCH', `/api/v1/office-equipment/${card.id}`, ctx.admin.auth, {
      name: IM350_UPPER,
    });
    expect(back.statusCode, back.body).toBe(200);
    const dtoBack = back.json() as OfficeEquipmentDto;
    expect(dtoBack.model?.id).toBe(from);
    expect(dtoBack.name).toBe(IM350);
  });

  it('прямой UPDATE имени в обход маршрута переставляет карточку так же', async () => {
    // Путей записи четыре — маршрут, заливка файлом, миграции, скрипты, — и договориться с каждым
    // порознь не выйдет: разбирает правку триггер, поэтому она работает и мимо HTTP.
    const card = await createCard({ name: IM350 });
    await ctx.db.execute(sql`UPDATE office_equipment SET name = ${IM550} WHERE id = ${card.id}`);

    const row = await cardRow(card.id);
    const target = await modelByKey(ctx.mfpTypeId, IM550);
    expect(target).toHaveLength(1);
    expect(row.modelId).toBe(target[0]!.id);
    expect(row.name).toBe(IM550);
  });

  it('обнуление ссылки не оставляет карточку без модели: резолв по её же имени', async () => {
    // Ссылку обнулили правкой — пустой она не остаётся: выпуск B ставит `NOT NULL`, и ронять на нём
    // запись, которая до сих пор проходила, нельзя.
    const card = await createCard({ name: BROTHER });
    const was = card.model!.id;
    await ctx.db.execute(sql`UPDATE office_equipment SET model_id = NULL WHERE id = ${card.id}`);

    const row = await cardRow(card.id);
    expect(row.modelId).toBe(was);
    expect(row.name).toBe(BROTHER);
  });

  it('правка постороннего поля чинит имя, испорченное в обход зеркала', async () => {
    /*
     * Шестой случай state-машины — страховка. Чтобы её увидеть, карточку сперва надо испортить так,
     * как это сделал бы скрипт мимо всех правил: с погашенным триггером. Всё вместе идёт в одной
     * транзакции с `ROLLBACK` — испорченного состояния в базе не остаётся.
     */
    const card = await createCard({ name: BROTHER });
    const c = await openClient();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE office_equipment DISABLE TRIGGER office_equipment_model_mirror');
      await c.query('UPDATE office_equipment SET name = $1 WHERE id = $2', [
        'ИСПОРЧЕННОЕ ИМЯ',
        card.id,
      ]);
      await c.query(
        'ALTER TABLE office_equipment ENABLE ALWAYS TRIGGER office_equipment_model_mirror',
      );

      const spoiled = await c.query<{ name: string }>(
        'SELECT name FROM office_equipment WHERE id = $1',
        [card.id],
      );
      expect(spoiled.rows[0]!.name).toBe('ИСПОРЧЕННОЕ ИМЯ');

      // Правка, не трогающая ни имя, ни тип, ни ссылку: зеркало возвращает имя модели.
      await c.query(`UPDATE office_equipment SET location = 'кабинет 7' WHERE id = $1`, [card.id]);
      const fixed = await c.query<{ name: string }>(
        'SELECT name FROM office_equipment WHERE id = $1',
        [card.id],
      );
      expect(fixed.rows[0]!.name).toBe(BROTHER);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }, 60_000);

  // ── 3. Переименование модели (Р3) ──

  it('переименование доезжает до всех карточек, включая архивные, и не «трогает» их', async () => {
    const model = await createModel({ typeId: ctx.mfpTypeId, name: PANTUM });
    const live = await createCard({ modelId: model.id });
    const archived = await createCard({ modelId: model.id });
    const removed = await inject(
      'DELETE',
      `/api/v1/office-equipment/${archived.id}`,
      ctx.admin.auth,
    );
    expect(removed.statusCode, removed.body).toBe(200);

    const touchedBefore = await cardRow(live.id);
    const renamed = `Pantum M6500NW ${RUN}`;
    const res = await inject(
      'PATCH',
      `/api/v1/office-equipment-models/${model.id}`,
      ctx.admin.auth,
      { name: renamed },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as OfficeEquipmentModelDto).name).toBe(renamed);

    expect((await cardRow(live.id)).name).toBe(renamed);
    // Архивная — тоже: `deleted_at` в раскладке не фильтруется, иначе карточка вернулась бы из
    // архива с именем, которое было в день списания.
    expect((await cardRow(archived.id)).name).toBe(renamed);
    // Правка написания в справочнике — не редактирование карточки: после переименования самой
    // ходовой модели весь парк не должен выглядеть только что отредактированным.
    expect((await cardRow(live.id)).updatedAt).toBe(touchedBefore.updatedAt);

    // И карточка, вернувшаяся из архива, приезжает с текущим именем, а не с прежним.
    const restored = await inject(
      'POST',
      `/api/v1/office-equipment/${archived.id}/restore`,
      ctx.admin.auth,
    );
    expect(restored.statusCode, restored.body).toBe(200);
    expect((restored.json() as OfficeEquipmentDto).name).toBe(renamed);

    // Правка написания самой модели («PANTUM …» → «Pantum …») — не двойник: занятость считается
    // с исключением себя.
    const respell = await inject(
      'PATCH',
      `/api/v1/office-equipment-models/${model.id}`,
      ctx.admin.auth,
      { name: renamed.toUpperCase() },
    );
    expect(respell.statusCode, respell.body).toBe(200);
    expect((await cardRow(live.id)).name).toBe(renamed.toUpperCase());
  }, 60_000);

  // ── 4. Гонки (Р3) ──

  it('два одновременных заведения одной модели: 201 и 409, ни одной 500', async () => {
    // Проверка до вставки чужую незакоммиченную строку не видит, обе транзакции её проходят, и
    // вторая доходит до уникального индекса. Без разбора `23505` это была бы «внутренняя ошибка»
    // там, где человеку нужно то же слово, что и при обычном дубле.
    const body = { equipmentTypeId: ctx.mfpTypeId, name: CANON };
    const [a, b] = await Promise.all([
      inject('POST', '/api/v1/office-equipment-models', ctx.admin.auth, body),
      inject('POST', '/api/v1/office-equipment-models', ctx.admin.auth, body),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes, `${a.body} | ${b.body}`).toEqual([201, 409]);
    expect(await modelByKey(ctx.mfpTypeId, CANON)).toHaveLength(1);
  }, 30_000);

  it('две карточки заводят одну модель одновременно: обе доходят, модель одна', async () => {
    /*
     * Гонка внутри триггера, а не в маршруте: `INSERT … ON CONFLICT DO UPDATE SET name = самой
     * себе RETURNING`. Именно `DO UPDATE`, а не `DO NOTHING`: `DO NOTHING` конфликтующую строку в
     * `RETURNING` не отдаёт вовсе, и проигравшей гонку транзакции нечего было бы подставить в
     * `model_id` — карточка упала бы на `NOT NULL` наименования.
     *
     * Соединения именно два и с настоящей очередью: последовательные запросы этой ветки не
     * касаются — второй увидел бы уже закоммиченную модель и нашёл бы её обычным `SELECT`.
     */
    const a = await openClient();
    const b = await openClient();
    const probe = await openProbe();
    const invA = nextInventory();
    const invB = nextInventory();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const insert = `INSERT INTO office_equipment (equipment_type_id, name, object_id, inventory_number)
                      VALUES ($1, $2, $3, $4) RETURNING model_id`;
      const first = await a.query<{ model_id: string }>(insert, [
        ctx.mfpTypeId,
        SHARP,
        ctx.objectId,
        invA,
      ]);

      // Вторую вставку не ждём: она обязана встать в очередь на уникальном индексе справочника —
      // очередь и есть предмет проверки.
      const pending = b.query<{ model_id: string }>(insert, [
        ctx.mfpTypeId,
        SHARP.toUpperCase(),
        ctx.objectId,
        invB,
      ]);
      await oneQueuedBehind(
        probe,
        await backendPid(a),
        'вторая вставка карточки',
        /INSERT INTO office_equipment/i,
      );

      await a.query('COMMIT');
      const second = await pending;
      await b.query('COMMIT');

      // Обе доехали, и обе на одной модели — в написании победителя.
      expect(second.rows[0]!.model_id).toBe(first.rows[0]!.model_id);
      expect(await modelByKey(ctx.mfpTypeId, SHARP)).toHaveLength(1);
      const names = await ctx.db.execute<{ name: string }>(sql`
        SELECT name FROM office_equipment WHERE inventory_number IN (${invA}, ${invB})`);
      expect(names.rows.map((r) => r.name)).toEqual([SHARP, SHARP]);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      await a.end();
      await b.end();
      await probe.end();
    }
  }, 60_000);

  it('переименование ждёт старую правку карточки ничего не держа — и доводит работу до конца', async () => {
    /*
     * ГЛАВНЫЙ СЛУЧАЙ ФАЙЛА (Р3). Порядок захвата — свойство пары транзакций: из кода маршрута
     * видно, что он берёт `LOCK TABLE office_equipment IN SHARE ROW EXCLUSIVE` первой строкой, но
     * не видно, что без этого встречный порядок со старой правкой карточки даёт `40P01`. Здесь
     * проверяется первая половина (клинча нет), следующим случаем — вторая (клинч достижим).
     *
     * Сцена: старая правка держит открытой транзакцию, в которой она уже взяла строку карточки и
     * прочитала модель `FOR KEY SHARE`. Переименование приходит вторым и обязано встать в очередь
     * ИМЕННО НА ТАБЛИЧНОЙ БЛОКИРОВКЕ — то есть не держа ни модели, ни карточек. Текст ждущего
     * запроса это и доказывает: возьми маршрут сперва `FOR UPDATE` модели, в очереди стоял бы
     * `SELECT … FOR UPDATE`, и цикл замкнулся бы.
     *
     * Об ожидании после правки — аккуратно. Старая правка присылает ДРУГОЕ НАПИСАНИЕ ТОГО ЖЕ
     * имени, и legacy-резолв честно оставляет карточку на той же модели (ключ совпал). Пришли она
     * старое имя уже переименованной модели — карточка так же честно уехала бы на модель со старым
     * именем, и это не дефект, а смысл ветки; просто ожидание тогда формулируется про другое.
     */
    const model = await createModel({ typeId: ctx.mfpTypeId, name: FS1040 });
    const one = await createCard({ modelId: model.id });
    const two = await createCard({ modelId: model.id });

    const oldPath = await openClient();
    const probe = await openProbe();
    const renamed = `Kyocera FS-1040MFP ${RUN}`;
    let inFlight: ReturnType<typeof inject> | undefined;
    try {
      await oldPath.query('BEGIN');
      // Правка карточки старым путём: строку карточки Postgres блокирует ДО её `BEFORE`-триггера,
      // а внутри триггера резолв идёт за моделью `FOR KEY SHARE`. Транзакция остаётся открытой —
      // очередь за ней и есть предмет случая.
      await oldPath.query('UPDATE office_equipment SET name = $1 WHERE id = $2', [
        FS1040.toUpperCase(),
        one.id,
      ]);

      inFlight = inject('PATCH', `/api/v1/office-equipment-models/${model.id}`, ctx.admin.auth, {
        name: renamed,
      });
      const waiting = await oneQueuedBehind(
        probe,
        await backendPid(oldPath),
        'переименование модели',
        /LOCK TABLE/i,
      );
      expect(waiting.query).toMatch(/office_equipment/i);
      expect(waiting.query).toMatch(/SHARE ROW EXCLUSIVE/i);
      // И ждёт оно ИМЕННО таблицу: `relation` означает, что дальше первого шага порядка Р3 дверь не
      // ушла и ничего чужого не держит. `transactionid` на этом месте читался бы как «уже внутри,
      // на чужой строке» — то самое состояние, из которого и получается клинч случая ниже.
      expect(waiting.waitEvent).toBe('relation');

      // Пока переименование ждёт, старая правка свободно берёт всё, что ей нужно: она никого не
      // ждёт в ответ. Держи переименование хоть строку модели, эта правка встала бы в очередь — и
      // кольцо замкнулось бы.
      await oldPath.query('UPDATE office_equipment SET name = $1 WHERE id = $2', [
        FS1040.toLowerCase(),
        two.id,
      ]);
      await oldPath.query('COMMIT');

      const res = await inFlight;
      inFlight = undefined;
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as OfficeEquipmentModelDto).name).toBe(renamed);
      // Обе карточки остались на своей модели (написание отличалось только регистром) и приехали
      // с новым именем — раскладку сделал `AFTER`-триггер уже после чужого коммита.
      expect((await cardRow(one.id)).modelId).toBe(model.id);
      expect((await cardRow(two.id)).modelId).toBe(model.id);
      expect((await cardRow(one.id)).name).toBe(renamed);
      expect((await cardRow(two.id)).name).toBe(renamed);
    } finally {
      await oldPath.query('ROLLBACK').catch(() => undefined);
      await inFlight?.catch(() => undefined);
      await oldPath.end();
      await probe.end();
    }
  }, 60_000);

  it('встречный порядок «модель → карточка» даёт клинч — тем и доказан предыдущий случай', async () => {
    /*
     * Контрольный клинч: прежний порядок, изображённый сырым SQL (`FOR UPDATE` модели без
     * табличной блокировки). Без него предыдущий случай ничего не стоит — тест, в котором клинч
     * невозможен в принципе, зелен и на сломанном коде.
     */
    const model = await createModel({ typeId: ctx.mfpTypeId, name: HP });
    const card = await createCard({ modelId: model.id });

    const rename = await openClient();
    const oldPath = await openClient();
    const probe = await openProbe();
    try {
      await rename.query('BEGIN');
      await oldPath.query('BEGIN');
      // Прежний порядок: сперва модель.
      await rename.query('SELECT 1 FROM office_equipment_models WHERE id = $1 FOR UPDATE', [
        model.id,
      ]);
      // Старая правка: сперва карточка, затем — внутри триггера — модель `FOR KEY SHARE`.
      const oldWaits = oldPath.query('UPDATE office_equipment SET name = $1 WHERE id = $2', [
        HP.toUpperCase(),
        card.id,
      ]);
      await oneQueuedBehind(
        probe,
        await backendPid(rename),
        'старая правка карточки',
        /UPDATE office_equipment/i,
      );

      // Переименование идёт за карточками своей модели — кольцо замкнулось.
      const renameWaits = rename.query(
        'UPDATE office_equipment_models SET name = $1 WHERE id = $2',
        [`HP LaserJet M15w ${RUN}`, model.id],
      );

      const outcome = await Promise.allSettled([oldWaits, renameWaits]);
      const codes = outcome
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason as { code?: string }).code);
      expect(codes).toContain('40P01');
    } finally {
      await rename.query('ROLLBACK').catch(() => undefined);
      await oldPath.query('ROLLBACK').catch(() => undefined);
      await rename.end();
      await oldPath.end();
      await probe.end();
    }
  }, 60_000);

  it('пока переименование держит парк, вставка со ссылкой ждёт таблицу и получает новое имя', async () => {
    /*
     * ВТОРАЯ ПОЛОВИНА `LOCK TABLE`, и ради неё он в Р3 и появился. Случаи выше доказывают, что
     * переименование и старая правка не убивают друг друга `40P01`; здесь проверяется то, ради чего
     * блокировка вообще нужна: НЕ ДАТЬ КАРТОЧКЕ ВПИСАТЬСЯ СО СТАРЫМ ИМЕНЕМ. `AFTER`-триггер
     * раскладывает новое имя по тем карточкам, которые видит, — и вставка, проскочившая следом за
     * ним, осталась бы в парке с именем, которого в справочнике больше нет.
     *
     * КАК УСТРОЕНА СЦЕНА. Переименование надо застать посреди его транзакции, а ручку изнутри не
     * притормозить. Поэтому третье соединение держит строку модели `FOR UPDATE`, не трогая парк:
     * переименование берёт табличную блокировку (шаг 1), упирается в строку модели (шаг 2) — и
     * стоит, ДЕРЖА ПАРК ЗАПЕРТЫМ. Ровно в это окно и приходят обе вставки.
     *
     * ЧТО ИМЕННО ДОКАЗЫВАЕТ ЗЕЛЁНЫЙ. Обе вставки ждут на `relation` — то есть на таблице, а не на
     * строке модели. Убери из маршрута `LOCK TABLE`, и держатель строки перестанет запирать парк:
     * вставки либо пройдут насквозь, либо встанут на `transactionid` чужой строки, и очереди за
     * бэкендом переименования не окажется вовсе. Случай краснеет — проверено прямой поломкой.
     */
    const model = await createModel({ typeId: ctx.mfpTypeId, name: IM430 });

    const holder = await openClient();
    const probe = await openProbe();
    let rename: ReturnType<typeof inject> | undefined;
    let byRef: ReturnType<typeof inject> | undefined;
    let byName: ReturnType<typeof inject> | undefined;
    try {
      await holder.query('BEGIN');
      // Строка модели — и только она: парк этот держатель не трогает, поэтому запереть запись в
      // него может лишь само переименование.
      await holder.query('SELECT 1 FROM office_equipment_models WHERE id = $1 FOR UPDATE', [
        model.id,
      ]);

      rename = inject('PATCH', `/api/v1/office-equipment-models/${model.id}`, ctx.admin.auth, {
        name: IM430_RENAMED,
      });
      const renamer = await oneQueuedBehind(
        probe,
        await backendPid(holder),
        'переименование модели',
        /office_equipment_models/i,
      );

      const refInventory = nextInventory();
      const nameInventory = nextInventory();
      const card = (payload: Record<string, unknown>) =>
        inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
          equipmentTypeId: ctx.mfpTypeId,
          objectId: ctx.objectId,
          location: 'кабинет 214',
          ...payload,
        });
      // Новая форма — ссылкой; старый клиент — прежним именем, тем самым, которое прямо сейчас
      // переименовывают.
      byRef = card({ modelId: model.id, inventoryNumber: refInventory });
      byName = card({ name: IM430, inventoryNumber: nameInventory });

      const queued = await queuedBehind(
        probe,
        renamer.pid,
        'вставки карточек во время переименования',
        /insert into "office_equipment"/i,
        2,
      );
      expect(queued).toHaveLength(2);
      for (const waiter of queued) {
        expect(waiter.waitEvent, 'вставка ждёт не таблицу — значит парк не заперт').toBe(
          'relation',
        );
      }

      await holder.query('ROLLBACK');

      const renamed = await rename;
      rename = undefined;
      expect(renamed.statusCode, renamed.body).toBe(200);

      const refDone = await byRef;
      byRef = undefined;
      expect(refDone.statusCode, refDone.body).toBe(201);
      const refCard = refDone.json() as OfficeEquipmentDto;
      // Со ссылкой — то, ради чего блокировка и стоит: карточка приезжает с НОВЫМ именем и на своей
      // модели. Старое имя здесь означало бы карточку, которой в справочнике не соответствует
      // ничего.
      expect(refCard.model?.id).toBe(model.id);
      expect(refCard.name).toBe(IM430_RENAMED);

      const nameDone = await byName;
      byName = undefined;
      expect(nameDone.statusCode, nameDone.body).toBe(201);
      const nameCard = nameDone.json() as OfficeEquipmentDto;
      /*
       * А вот вставка ПО ИМЕНИ приезжает со старым именем — и это не промах блокировки, а смысл
       * legacy-ветки. Старый клиент назвал модель текстом; текст этот после переименования не
       * принадлежит никому, и резолв честно заводит по нему новую модель. Требовать здесь нового
       * имени значило бы требовать от клиента, который о моделях не знает вовсе, угадать чужую
       * правку. Дверь эта закрывается не блокировкой, а выпуском C — вместе со всей веткой.
       */
      expect(nameCard.name).toBe(IM430);
      expect(nameCard.model?.id).not.toBe(model.id);
      expect(await modelByKey(ctx.mfpTypeId, IM430)).toHaveLength(1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await rename?.catch(() => undefined);
      await byRef?.catch(() => undefined);
      await byName?.catch(() => undefined);
      await holder.end();
      await probe.end();
    }
  }, 60_000);

  it('переименование в имя, занятое незакоммиченной вставкой, — 409 с пометкой поля, не 500', async () => {
    /*
     * Третья дверь того же отказа. Табличная блокировка здесь не помощник вовсе: сосед, заводящий
     * модель, парк не трогает и на `LOCK TABLE` не задерживается — значит его незакоммиченную
     * строку не видит ни `renameOf`, ни проверка занятости, и `UPDATE` встаёт в очередь на самом
     * уникальном индексе. Без разбора `23505` человек получил бы 500 «внутренняя ошибка» там, где
     * ему нужно то же слово, что и при обычном дубле, и та же подсветка поля.
     */
    const model = await createModel({ typeId: ctx.mfpTypeId, name: `Ricoh IM 700 ${RUN}` });
    const taken = `Ricoh IM 700F ${RUN}`;

    const other = await openClient();
    const probe = await openProbe();
    let pending: ReturnType<typeof inject> | undefined;
    try {
      await other.query('BEGIN');
      await other.query(
        'INSERT INTO office_equipment_models (equipment_type_id, name) VALUES ($1, $2)',
        [ctx.mfpTypeId, taken],
      );

      pending = inject('PATCH', `/api/v1/office-equipment-models/${model.id}`, ctx.admin.auth, {
        name: taken,
      });
      const waiter = await oneQueuedBehind(
        probe,
        await backendPid(other),
        'переименование в занятое имя',
        /update "office_equipment_models"/i,
      );
      // Ждёт чужую транзакцию на индексе — то есть проверки занятости эту строку не видели и
      // видеть не могли. Именно эту щель разбор `23505` и закрывает.
      expect(waiter.waitEvent).toBe('transactionid');

      await other.query('COMMIT');
      const res = await pending;
      pending = undefined;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toContain('уже заведена');
      // Пометка поля обязательна: без пути поля портал показывает 409 тостом поверх формы, то есть
      // мимо того единственного поля, которое человеку и надо исправить.
      expect(res.json().fields?.name).toBeTruthy();
      // Имя модели при этом не изменилось: отказ откатил транзакцию целиком.
      expect((await modelByKey(ctx.mfpTypeId, `Ricoh IM 700 ${RUN}`))[0]?.name).toBe(
        `Ricoh IM 700 ${RUN}`,
      );
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      await pending?.catch(() => undefined);
      await other.end();
      await probe.end();
    }
  }, 60_000);

  it('модель, удалённая соседом на ходу, — 400 словами и на заведении, и на правке', async () => {
    /*
     * Щель, которую проверка маршрута закрыть не может в принципе: она отвечает по состоянию,
     * которое видит её транзакция, а соседнее удаление ещё не закоммичено. Модель видна проверке —
     * и уже нет её к моменту, когда `BEFORE`-триггер зеркала перечитывает строку после чужого
     * коммита. Триггер бросает `23503` без имени ограничения, и без разбора это 500 с текстом
     * SQL-запроса в теле — на тот самый вопрос, на который проверка отвечает 400 словами.
     *
     * ПОЧЕМУ ЗДЕСЬ ПРОВЕРЯЕТСЯ `waitEvent`. Без гонки этот же ответ приходит от обычной проверки —
     * удали модель заранее, и 400 придёт, не доехав до триггера. Такой «зелёный» не отличает
     * рабочий код от сломанного вовсе. Ожидание на `transactionid` доказывает, что дверь и вправду
     * стояла в очереди за чужим удалением, то есть ответ пришёл из разбора ошибки триггера.
     */
    const forCreate = await createModel({ typeId: ctx.mfpTypeId, name: `Sharp MX-3061 ${RUN}` });
    const forUpdate = await createModel({ typeId: ctx.mfpTypeId, name: `Sharp MX-3071 ${RUN}` });
    const card = await createCard({ name: `Sharp MX-3081 ${RUN}` });

    const created = await whileModelDeleted(
      forCreate.id,
      () =>
        inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
          equipmentTypeId: ctx.mfpTypeId,
          modelId: forCreate.id,
          objectId: ctx.objectId,
          inventoryNumber: nextInventory(),
          location: 'кабинет 214',
        }),
      'заведение карточки на удаляемой модели',
      /insert into "office_equipment"/i,
    );
    expect(created.statusCode, created.body).toBe(400);
    expect(created.json().message).toBe('Модель аппарата не найдена');
    expect(created.json().fields?.modelId).toBe('Не найдена');

    const patched = await whileModelDeleted(
      forUpdate.id,
      () =>
        inject('PATCH', `/api/v1/office-equipment/${card.id}`, ctx.admin.auth, {
          modelId: forUpdate.id,
        }),
      'правка карточки на удаляемую модель',
      /update "office_equipment"/i,
    );
    expect(patched.statusCode, patched.body).toBe(400);
    expect(patched.json().message).toBe('Модель аппарата не найдена');
    expect(patched.json().fields?.modelId).toBe('Не найдена');

    // Карточка осталась на прежней модели: отказ откатил правку целиком.
    expect((await cardRow(card.id)).modelId).toBe(card.model?.id);
  }, 60_000);

  // ── 5. Область счётчика «в парке» (Р12) ──

  describe('счётчик «в парке» считается в области смотрящего', () => {
    /**
     * Парк одной модели, разложенный по обеим осям области сразу. Числа у четырёх ролей разные
     * намеренно: совпади они, случай перестал бы различать правила.
     */
    let modelId: string;

    beforeAll(async () => {
      const model = await createModel({ typeId: ctx.mfpTypeId, name: XEROX });
      modelId = model.id;
      const at = (objectId: string, departmentId: string | null): Promise<OfficeEquipmentDto> =>
        createCard({ modelId, objectId, departmentId });

      await at(ctx.objectId, null); // 1: своя площадка, не размечена
      await at(ctx.objectId, ctx.departmentId); // 2: своя площадка, свой отдел
      await at(ctx.foreignObjectId, ctx.departmentId); // 3: чужая площадка, свой отдел
      await at(ctx.foreignObjectId, ctx.foreignDepartmentId); // 4: чужая и чужой
      await at(ctx.objectId, ctx.foreignDepartmentId); // 5: своя площадка, чужой отдел
      await at(ctx.foreignObjectId, null); // 6: чужая площадка, не размечена

      // Архивная и неактивная — в счётчик не входят ни у кого: он отвечает на вопрос «сколько
      // аппаратов надо кормить», а архив и выведенная из эксплуатации техника картриджей не просят.
      const archived = await at(ctx.objectId, null);
      const gone = await inject(
        'DELETE',
        `/api/v1/office-equipment/${archived.id}`,
        ctx.admin.auth,
      );
      expect(gone.statusCode, gone.body).toBe(200);
      await createCard({ modelId, objectId: ctx.objectId, isActive: false });
    }, 120_000);

    /**
     * То же число, посчитанное **тем же предикатом**, что стоит в маршруте. Тест повторяет
     * `officeEquipmentScopeWhere`, а не своё представление о правиле: разойдясь, они разрешили бы
     * роли одной площадки узнать масштаб чужого парка — и оба остались бы зелёными.
     */
    async function scopedCount(userId: string): Promise<number> {
      const { loadPrincipal } = await import('../src/auth/principal');
      const { officeEquipmentScopeWhere } = await import('../src/lib/access');
      const schema = await import('../src/db/schema');
      const principal = await loadPrincipal(userId);
      expect(principal, 'учётка пропала из базы').not.toBeNull();
      const scope = officeEquipmentScopeWhere(
        principal!,
        schema.officeEquipment.objectId,
        schema.officeEquipment.ownerDepartmentId,
      );
      const [row] = await ctx.db
        .select({ c: count() })
        .from(schema.officeEquipment)
        .where(
          and(
            eq(schema.officeEquipment.modelId, modelId),
            isNull(schema.officeEquipment.deletedAt),
            eq(schema.officeEquipment.isActive, true),
            scope,
          ),
        );
      return Number(row!.c);
    }

    it('роль объекта видит только карточки своих площадок', async () => {
      // Карточки 1, 2 и 5 стоят на её площадке — чужой отдел ей при этом не помеха: ось у роли
      // объекта одна.
      expect((await modelRow(ctx.objectUser.auth, XEROX)).equipmentCount).toBe(3);
      expect(await scopedCount(ctx.objectUser.id)).toBe(3);
    });

    it('роль отдела видит свои отделы и всю неразмеченную технику', async () => {
      // Карточки 2 и 3 — её отдела, 1 и 6 — ничьи. Неразмеченная попала в область намеренно: пока
      // за техникой не закреплён отдел, спрятать её от всех значило бы сделать невидимой ровно ту
      // часть парка, которую и надо разметить.
      expect((await modelRow(ctx.deptUser.auth, XEROX)).equipmentCount).toBe(4);
      expect(await scopedCount(ctx.deptUser.id)).toBe(4);
    });

    it('роль отдела с пустым списком отделов видит ровно неразмеченную технику', async () => {
      // Пустой набор означает «своих отделов ноль», а не «видит всё»: карточки 1 и 6.
      expect((await modelRow(ctx.deptEmptyUser.auth, XEROX)).equipmentCount).toBe(2);
      expect(await scopedCount(ctx.deptEmptyUser.id)).toBe(2);
    });

    it('сквозная область модуля показывает весь парк модели', async () => {
      // Шесть живых и активных карточек — обе оси, обе площадки. У администратора то же число, но
      // по другой причине: у его роли области нет вовсе.
      expect((await modelRow(ctx.wideUser.auth, XEROX)).equipmentCount).toBe(6);
      expect(await scopedCount(ctx.wideUser.id)).toBe(6);
      expect((await modelRow(ctx.admin.auth, XEROX)).equipmentCount).toBe(6);
    });

    it('«у вас таких нет» — это не «модель свободна»: 0 в области, но удаления нет', async () => {
      /*
       * `isUsed` и `equipmentCount` отвечают на разные вопросы, и подменять один другим нельзя:
       * «можно ли удалить» считается по всему парку — включая архивные, неактивные и чужие
       * карточки, — а «сколько таких у нас» в области смотрящего.
       */
      const foreignOnly = await createModel({ typeId: ctx.mfpTypeId, name: CANON + ' MF' });
      await createCard({
        modelId: foreignOnly.id,
        objectId: ctx.foreignObjectId,
        departmentId: ctx.foreignDepartmentId,
      });

      const seenByObjectRole = await modelRow(ctx.objectUser.auth, foreignOnly.name);
      expect(seenByObjectRole.equipmentCount).toBe(0);
      expect(seenByObjectRole.isUsed).toBe(true);

      const seenByAdmin = await modelRow(ctx.admin.auth, foreignOnly.name);
      expect(seenByAdmin.equipmentCount).toBe(1);

      const res = await inject(
        'DELETE',
        `/api/v1/office-equipment-models/${foreignOnly.id}`,
        ctx.admin.auth,
      );
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().message).toContain('ссылается техника');
    }, 60_000);
  });

  // ── 6. Смена типа у карточки (Р3) ──

  it('смена типа без модели — 422 маршрута, со ссылкой — проходит', async () => {
    const card = await createCard({ name: IM350 });
    const refused = await inject('PATCH', `/api/v1/office-equipment/${card.id}`, ctx.admin.auth, {
      equipmentTypeId: ctx.printerTypeId,
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().fields?.modelId).toBeTruthy();

    // С моделью нужного типа — обычная правка: тип у модели неизменяем, поэтому «переехать» можно
    // только на другую модель. Одноимённая модель типа «Принтер» заведена выше — и это разные
    // строки справочника, хоть и с одним написанием.
    const mfpModel = await modelRow(ctx.admin.auth, IM350, ctx.mfpTypeId);
    const printerTwin = await modelRow(ctx.admin.auth, IM350, ctx.printerTypeId);
    expect(mfpModel.id).not.toBe(printerTwin.id);

    const ok = await inject('PATCH', `/api/v1/office-equipment/${card.id}`, ctx.admin.auth, {
      equipmentTypeId: ctx.printerTypeId,
      modelId: printerTwin.id,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const dto = ok.json() as OfficeEquipmentDto;
    expect(dto.type.id).toBe(ctx.printerTypeId);
    expect(dto.model?.id).toBe(printerTwin.id);
  });

  it('тот же тип, смененный прямым UPDATE, заводит модель нового типа — штатно для триггера', async () => {
    /*
     * ИЗВЕСТНОЕ ПОВЕДЕНИЕ, ЗАКРЫТОЕ МАРШРУТОМ, А НЕ СХЕМОЙ. Правка одного типа уходит в
     * legacy-ветку (изменился тип — значит резолвим по имени), и справочник пополняется моделью
     * нового типа с тем же именем. Для базы это штатный случай state-машины: триггер обязан
     * оставаться терпимым — через него в окне выпуска A идёт старый код, не знающий о моделях
     * вовсе. Требовать явного выбора вправе маршрут, который видит, кто к нему пришёл (случай
     * выше, 422), — и этот запрет уходит вместе с legacy-веткой в выпуске C.
     *
     * Случай стоит здесь именно затем, чтобы поведение было зафиксировано: наткнувшись на лишнюю
     * строку в справочнике, следующий читатель найдёт объяснение, а не «дефект».
     */
    const name = `Ricoh SP 330 ${RUN}`;
    const card = await createCard({ name });
    const before = await cardRow(card.id);
    expect(await modelByKey(ctx.printerTypeId, name)).toHaveLength(0);

    await ctx.db.execute(sql`
      UPDATE office_equipment SET equipment_type_id = ${ctx.printerTypeId} WHERE id = ${card.id}`);

    const after = await cardRow(card.id);
    const printerModels = await modelByKey(ctx.printerTypeId, name);
    expect(printerModels).toHaveLength(1);
    expect(after.modelId).toBe(printerModels[0]!.id);
    expect(after.modelId).not.toBe(before.modelId);
    expect(after.name).toBe(name);
  });

  it('модель чужого типа — 422, погашенная — 400, и на заведении, и на правке', async () => {
    /*
     * Обе ветки `assertModelUsable`, и обе — на двух дверях сразу. Проверка стоит до записи, хотя
     * пару «модель — тип» держит и составной ключ: без неё человек прочитал бы имя ограничения
     * вместо «это модель принтера». Сломай сравнение типов — и наружу пойдёт 500 от
     * `office_equipment_model_type_fk`, а до выпуска B ещё и legacy-ветка триггера успела бы увести
     * карточку на модель, найденную по имени, то есть не на ту, которую назвали ссылкой.
     *
     * Коды разные намеренно: ненайденная и погашенная модель — 400 полем `modelId` (ссылка либо
     * ведёт куда надо, либо нет), чужой тип — 422 (запрос понятен, обе ссылки живые, недопустима их
     * пара). Поэтому случай проверяет и код, и пометку поля: одинаковый статус на разные причины
     * стёр бы разницу, ради которой их и развели.
     */
    const printerModel = await createModel({
      typeId: ctx.printerTypeId,
      name: `Kyocera P2040 ${RUN}`,
    });
    const dimmed = await createModel({
      typeId: ctx.mfpTypeId,
      name: `Ricoh IM 600 ${RUN}`,
      isActive: false,
    });
    const own = await createModel({ typeId: ctx.mfpTypeId, name: `Ricoh IM 610 ${RUN}` });

    const post = (modelId: string) =>
      inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
        equipmentTypeId: ctx.mfpTypeId,
        modelId,
        objectId: ctx.objectId,
        inventoryNumber: nextInventory(),
        location: 'кабинет 214',
      });

    const foreignOnCreate = await post(printerModel.id);
    expect(foreignOnCreate.statusCode, foreignOnCreate.body).toBe(422);
    expect(foreignOnCreate.json().fields?.modelId).toBe('Модель другого типа');
    // Текст называет и модель, и её тип: «выберите другую» без имён отвечало бы не на тот вопрос.
    expect(foreignOnCreate.json().message).toContain(`Kyocera P2040 ${RUN}`);
    expect(foreignOnCreate.json().message).toContain('Принтер');

    const dimmedOnCreate = await post(dimmed.id);
    expect(dimmedOnCreate.statusCode, dimmedOnCreate.body).toBe(400);
    expect(dimmedOnCreate.json().fields?.modelId).toBe('Модель погашена');
    expect(dimmedOnCreate.json().message).toContain('погашена');

    // Правка ходит той же проверкой: карточка заводится на живой модели своего типа, а дальше её
    // пробуют увести на чужую и на погашенную.
    const card = await createCard({ modelId: own.id });
    const patch = (modelId: string) =>
      inject('PATCH', `/api/v1/office-equipment/${card.id}`, ctx.admin.auth, { modelId });

    const foreignOnUpdate = await patch(printerModel.id);
    expect(foreignOnUpdate.statusCode, foreignOnUpdate.body).toBe(422);
    expect(foreignOnUpdate.json().fields?.modelId).toBe('Модель другого типа');

    const dimmedOnUpdate = await patch(dimmed.id);
    expect(dimmedOnUpdate.statusCode, dimmedOnUpdate.body).toBe(400);
    expect(dimmedOnUpdate.json().fields?.modelId).toBe('Модель погашена');

    // Ни один отказ карточку не тронул: она осталась на своей модели и со своим именем.
    const after = await cardRow(card.id);
    expect(after.modelId).toBe(own.id);
    expect(after.name).toBe(`Ricoh IM 610 ${RUN}`);

    // А погашенная модель у УЖЕ заведённой карточки остаётся (Р11): гашение означает «больше не
    // предлагать», а не «переписать парк». Поэтому правка, ссылку не трогающая, в эту проверку не
    // заходит вовсе — иначе гашение модели запрещало бы сменить кабинет всем её аппаратам.
    const dimming = await inject(
      'PATCH',
      `/api/v1/office-equipment-models/${own.id}`,
      ctx.admin.auth,
      { isActive: false },
    );
    expect(dimming.statusCode, dimming.body).toBe(200);
    const moved = await inject('PATCH', `/api/v1/office-equipment/${card.id}`, ctx.admin.auth, {
      location: 'кабинет 7',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((moved.json() as OfficeEquipmentDto).model?.id).toBe(own.id);
  }, 60_000);

  // ── 7. Схема против прямого SQL ──

  it('двойной пробел в наименовании не проходит в справочник даже прямым INSERT', async () => {
    // Без этой проверки правило жило бы только в ключе, и «Ricoh␣␣IM 350» уехало бы зеркалом во
    // все карточки модели — тот же дефект, ради которого правило и заводили, вошедший другой
    // дверью.
    const refusal = await dbRefusal(
      ctx.db.execute(sql`
        INSERT INTO office_equipment_models (equipment_type_id, name)
        VALUES (${ctx.mfpTypeId}, ${`Ricoh  IM 900 ${RUN}`})`),
    );
    expect(refusal.constraint).toBe('office_equipment_models_name_normalized_check');
  });

  it('модель, на которую ссылается карточка, не удаляется прямым DELETE', async () => {
    // Правило Р11 держит схема, а не вежливость маршрута: `ON DELETE RESTRICT` на составном ключе.
    const model = await createModel({ typeId: ctx.mfpTypeId, name: `Epson L3150 ${RUN}` });
    const card = await createCard({ modelId: model.id });
    const refusal = await dbRefusal(
      ctx.db.execute(sql`DELETE FROM office_equipment_models WHERE id = ${model.id}`),
    );
    expect(refusal.code).toBe('23503');
    expect(refusal.constraint).toBe('office_equipment_model_type_fk');

    // Архивная карточка держит модель так же: она возвращается `restore` и обязана вернуться к
    // своей модели.
    const gone = await inject('DELETE', `/api/v1/office-equipment/${card.id}`, ctx.admin.auth);
    expect(gone.statusCode, gone.body).toBe(200);
    const refused = await inject(
      'DELETE',
      `/api/v1/office-equipment-models/${model.id}`,
      ctx.admin.auth,
    );
    expect(refused.statusCode, refused.body).toBe(409);
  });

  it('карточка без имени и без ссылки отбивается словами про модель, а не про CHECK', async () => {
    // Пустое имя ловит сам резолв: без этой строки он пошёл бы заводить модель с пустым
    // наименованием, и человек получил бы отказ про справочник, которого не касался.
    const refusal = await dbRefusal(
      ctx.db.execute(sql`
        INSERT INTO office_equipment (equipment_type_id, name, object_id, inventory_number)
        VALUES (${ctx.mfpTypeId}, '   ', ${ctx.objectId}, ${nextInventory()})`),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('Наименование модели пусто');
  });

  it('свободная модель удаляется совсем — справочник ведут руками', async () => {
    const model = await createModel({ typeId: ctx.mfpTypeId, name: `Xerox Phaser 3250 ${RUN}` });
    const res = await inject(
      'DELETE',
      `/api/v1/office-equipment-models/${model.id}`,
      ctx.admin.auth,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await modelByKey(ctx.mfpTypeId, `Xerox Phaser 3250 ${RUN}`)).toHaveLength(0);
  });
});
