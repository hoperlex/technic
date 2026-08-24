import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AutoPartDetailDto,
  AutoPartDto,
  AutoPartStockResultDto,
  Permission,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Автозапчасти — склад гаража (план `docs/auto-parts-plan.md`, Р3, Р7, Р8, Р10—Р13, Р21; миграция
 * [0187](../drizzle/0187_auto_parts.sql), маршрут `routes/auto-parts.ts`).
 *
 * ЗАЧЕМ БАЗА. Главное обещание справочника — «остаток нельзя изменить мимо журнала, а журнал не
 * врёт» — живёт не в коде, а в схеме, и на моках проверяются только моки. Приём перенесён из
 * `office-equipment-consumables.db.test.ts` целиком, вместе с обоснованиями: предмет другой, а
 * двери, которые надо закрыть, ровно те же самые.
 *
 * - ЦЕПОЧКА (`BEFORE INSERT` на журнале) сверяет ОБА конца события. Проверка только «стало»
 *   пропустила бы строку «999 → 12» при остатке 12 — итог верен, а в журнале навсегда осталось бы
 *   выдуманное «было», по которому потом считают расход; проверка только «было» пропустила бы
 *   событие, не доехавшее до карточки. Отсюда же правило «первое событие обязано начинаться с
 *   нуля»: до него позиция заведена нулём;
 * - НЕИЗМЕНЯЕМОСТЬ (`BEFORE UPDATE OR DELETE`) запрещает подчистить прошлое построчно: `RESTRICT`
 *   со стороны позиции защищает историю целиком, а правку одной строки — нет;
 * - ПОКРЫТИЕ (отложенный constraint-триггер) ловит ОТСУТСТВИЕ события: `UPDATE … SET quantity = 7`
 *   скриптом проходит мимо первых двух насквозь, и без этой проверки обещание журнала осталось бы
 *   обещанием маршрута;
 * - ГОНКА ОСТАТКА — свойство ПАРЫ транзакций, а не одной: файл маршрута показывает
 *   `SELECT … FOR UPDATE`, но не показывает, что без него два механика прочитают 12, запишут
 *   «12 → 10» и «12 → 8» и цепочка станет враньём при верном итоге. Доказывается это встречей двух
 *   запросов на одной строке — приёмом с `pg_blocking_pids`.
 *
 * СВОЁ, ЧЕГО У РАСХОДНИКОВ НЕТ. Применимость стоит на ДВУХ осях (модель и тип техники, Р8), и
 * подбор под машину — не фильтр, а РАНГ (Р21): позиция, размеченная и моделью, и типом, обязана
 * прийти ОДИН раз с рангом 0, а порядок «модель → тип → остальное» обязан держаться на всех
 * страницах, а не внутри пришедшей. Оба свойства держатся на `EXISTS` вместо соединения, и оба
 * ломаются молча — без единой ошибки, законным запросом с неверным ответом.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Расхода по акту обслуживания (Р5, Р6, Р18, Р19, Р22—Р24): у него своя машинерия —
 * машины, показания, версии актов, — и живёт он в `vehicle-maintenance.db.test.ts`, куда этим же
 * выпуском добавлены случаи списания, возврата, аннулирования и права по эффекту.
 *
 * ИЗОЛЯЦИЯ. База db-тестов общая и живёт между прогонами. Всё своё помечено суффиксом прогона
 * `RUN` — наименования позиций, артикулы, имена моделей, коды типов, адреса учёток, — и `afterAll`
 * уносит ровно его. Порядок уборки задан схемой: строки журнала неудаляемы (триггер), поэтому их
 * сносит транзакция с временно погашенным триггером — и только после этого уходят позиции, за ними
 * машины, модели и типы техники.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_archive_test \
 *     npx vitest run apps/api/test/auto-parts.db.test.ts
 *
 * У ПУСТОЙ базы расширения ставятся до первого прогона — `0001_init.sql` их не создаёт нарочно:
 *
 *   psql … -c 'create extension if not exists citext' \
 *          -c 'create extension if not exists pg_trgm' \
 *          -c 'create extension if not exists pgcrypto'
 *
 * Без них накат падает на `type "citext" does not exist`, и падает он в `beforeAll`, то есть
 * выглядит поломкой теста, а не незаведённой базой.
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
/** Он же в написании артикула: артикул хранится нормализованным, то есть в верхнем регистре. */
const CODE_RUN = RUN.toUpperCase();

/**
 * Опознавательные знаки файла — УСТОЙЧИВЫЕ, то есть без суффикса прогона. По ним уборка находит
 * хвосты ЧУЖИХ прогонов этого же файла (см. `убрать`); суффикс прогона добавляется к ним сверху и
 * отделяет своё от брошенного.
 *
 * Отбор идёт по НАИМЕНОВАНИЮ, а не по артикулу: артикул у автозапчасти необязателен (Р12), и
 * половина случаев файла заводит позиции как раз без него — по артикулу они бы не убрались.
 */
const NAME_PREFIX = 'АЗЧ-ТЕСТ';
const CODE_PREFIX = 'AP';
const TYPE_CODE_PREFIX = 'zz_test_auto_parts';
const MODEL_PREFIX = 'AP МОДЕЛЬ';
const PASSWORD = 'db-test-password-123';

/** Сколько соединение файла готово ждать чужую блокировку, прежде чем упасть текстом. */
const LOCK_TIMEOUT_MS = 8_000;
/** Сколько ждём, пока запрос встанет в очередь: барьер, а не пауза «на глазок». */
const QUEUE_TIMEOUT_MS = 15_000;

/**
 * Невидимые символы поимённо: в тексте теста они обязаны быть escape-последовательностями, а не
 * собой. Байт, который не видно на ревью, теряется при первом же копировании файла — и случай про
 * неразрывный пробел тихо превращается в случай про обычный.
 */
/** U+00A0 — его ставит Word автозаменой, он же приезжает из выгрузок Excel и из письма. */
const NBSP = '\u00a0';

/**
 * Права — константами из словаря контрактов, а не строками на месте: `Permission` не даст опечатке
 * дожить до прогона, а снятое выкатом право сломает типизацию здесь, а не тихо превратит случай
 * про доступ в случай про «права нет ни у кого».
 */
const MANAGE: Permission = 'autoParts.manage';
const STOCK: Permission = 'autoParts.stock';

/** Тексты стражей маршрута: по ним видно, КАКОЙ из двух отказал, а не просто «403». */
const MANAGE_DENIED = 'Справочник автозапчастей ведут механики';
const STOCK_DENIED = 'Остаток автозапчасти правит тот, кому доверен склад';

/** Причина первого события: её составляет маршрут, а не человек (Р3). */
const FIRST_ENTRY_REASON = 'Заведение карточки: начальный остаток';

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
  /** Администратор: у его роли есть весь словарь прав целиком. */
  admin: TestUser;
  /** Только `autoParts.manage`: ведёт номенклатуру, остатка не касается. */
  manageUser: TestUser;
  /** Только `autoParts.stock`: правит остаток, номенклатуру не ведёт. */
  stockUser: TestUser;
  /** Роль с одним лишь `garage.read`: склад видит, но не трогает (Р10). */
  readUser: TestUser;
  /** Тип техники машины с моделью и тип машины без модели — две оси разметки (Р8). */
  typeWithModelId: string;
  typeNoModelId: string;
  modelId: string;
  /** Машина, у которой есть и модель, и тип: на ней проверяется ранг 0 против ранга 1. */
  vehicleWithModelId: string;
  /** Машина без модели: `vehicles.vehicle_model_id` необязателен, и ранг обязан считаться одним типом. */
  vehicleNoModelId: string;
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

/**
 * Артикул этого прогона. Верхний регистр не украшение — в базе артикул лежит уже нормализованным
 * (`auto_part_code_key`), и записанный строчными он вернулся бы из ответа не таким, каким его
 * набрали.
 */
let codeNo = 0;
function nextCode(): string {
  codeNo += 1;
  return `${CODE_PREFIX}${CODE_RUN}${String(codeNo).padStart(3, '0')}`;
}

/** Наименование этого прогона: по нему идёт и отбор уборки, и поиск в списках. */
let nameNo = 0;
function nextName(tail = ''): string {
  nameNo += 1;
  return `${NAME_PREFIX} ${RUN} №${nameNo}${tail ? ` ${tail}` : ''}`;
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

// ── Ручки справочника автозапчастей ──

interface PartInput {
  code?: string | null;
  name?: string;
  unit?: string;
  quantity?: number;
  comment?: string;
  isActive?: boolean;
  applicability?: Array<{ vehicleModelId?: string; vehicleTypeId?: string }>;
  auth?: Auth;
}

function partBody(input: PartInput): Record<string, unknown> {
  return {
    ...(input.code === undefined ? {} : { code: input.code }),
    name: input.name ?? nextName(),
    ...(input.unit === undefined ? {} : { unit: input.unit }),
    ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    ...(input.applicability === undefined ? {} : { applicability: input.applicability }),
  };
}

function postPart(input: PartInput = {}) {
  return inject('POST', '/api/v1/auto-parts', input.auth ?? ctx.admin.auth, partBody(input));
}

async function createPart(input: PartInput = {}): Promise<AutoPartDto> {
  const res = await postPart(input);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as AutoPartDto;
}

async function detailOf(id: string, auth?: Auth): Promise<AutoPartDetailDto> {
  const res = await inject('GET', `/api/v1/auto-parts/${id}`, auth ?? ctx.admin.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AutoPartDetailDto;
}

interface Page {
  items: AutoPartDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Страница перечня одним запросом: те же параметры, что у окна вкладки (Р13, Р21). */
async function listPage(query: Record<string, string>, auth?: Auth): Promise<Page> {
  const qs = new URLSearchParams({ pageSize: '100', ...query }).toString();
  const res = await inject('GET', `/api/v1/auto-parts?${qs}`, auth ?? ctx.admin.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Page;
}

async function listParts(query: Record<string, string>, auth?: Auth): Promise<AutoPartDto[]> {
  return (await listPage(query, auth)).items;
}

function patchPart(id: string, body: Record<string, unknown>, auth?: Auth) {
  return inject('PATCH', `/api/v1/auto-parts/${id}`, auth ?? ctx.admin.auth, body);
}

function postStock(
  id: string,
  body: { quantity: number; expectedQuantity: number; reason: string },
  auth?: Auth,
) {
  return inject('POST', `/api/v1/auto-parts/${id}/stock`, auth ?? ctx.admin.auth, body);
}

/** Успешная правка остатка: предмет проверки — записанное событие, а не код ответа. */
async function stockOk(
  id: string,
  body: { quantity: number; expectedQuantity: number; reason: string },
  auth?: Auth,
): Promise<AutoPartStockResultDto> {
  const res = await postStock(id, body, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AutoPartStockResultDto;
}

// ── Состояние базы прямым SQL ──
//
// Прямым, а не выражениями drizzle: коррелированный подзапрос в односоставном запросе тихо
// переписывается в сравнение колонок собственной таблицы и всегда даёт «ничего нет». Проверка,
// написанная этим приёмом, зеленела бы на любом состоянии базы.

interface StockEntryRow {
  id: string;
  seq: number;
  before: number;
  after: number;
  reason: string;
  kind: string;
  maintenanceId: string | null;
}

/** Журнал позиции снизу вверх — в том порядке, в котором строилась цепочка. */
async function journalOf(id: string): Promise<StockEntryRow[]> {
  const res = await ctx.db.execute<{
    id: string;
    seq: number;
    quantity_before: number;
    quantity_after: number;
    reason: string;
    entry_kind: string;
    maintenance_id: string | null;
  }>(sql`
    SELECT id, seq::int AS seq, quantity_before, quantity_after, reason, entry_kind, maintenance_id
      FROM auto_part_stock_entries
     WHERE auto_part_id = ${id}
     ORDER BY seq`);
  return res.rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    before: r.quantity_before,
    after: r.quantity_after,
    reason: r.reason,
    kind: r.entry_kind,
    maintenanceId: r.maintenance_id,
  }));
}

async function quantityOf(id: string): Promise<number> {
  const res = await ctx.db.execute<{ quantity: number }>(
    sql`SELECT quantity FROM auto_parts WHERE id = ${id}`,
  );
  const row = res.rows[0];
  if (!row) throw new Error(`автозапчасти ${id} нет в базе`);
  return row.quantity;
}

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const res = await ctx.db.execute<{ c: number }>(query);
  return Number(res.rows[0]!.c);
}

/**
 * Цепочка непрерывна: первое событие начинается с нуля (до него позиция заведена нулём), каждое
 * следующее — со «стало» предыдущего, а остаток карточки равен «стало» последнего. Пустой журнал
 * при этом допустим ровно при нуле — то же правило, что у отложенной проверки покрытия.
 */
function expectChain(entries: StockEntryRow[], quantity: number): void {
  let previous = 0;
  for (const e of entries) {
    expect(e.before, `событие seq=${e.seq} началось не там, где кончилось предыдущее`).toBe(
      previous,
    );
    previous = e.after;
  }
  expect(quantity, 'остаток карточки разошёлся с последним событием журнала').toBe(previous);
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
 * Третье поле — не украшение, а половина проверки: `transactionid` означает, что запрос ждёт чужую
 * СТРОКУ, то есть дошёл до `SELECT … FOR UPDATE` и встал на ней. Ответ «дождались» без этого
 * различения одинаков для рабочего и сломанного кода — очередь-то образуется в обоих случаях,
 * только на разных замках.
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
 * снятый первым же чтением.
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
  // ждали вот эти» отвечает на вопрос «что тогда пошло не так», тогда как «очереди нет» не
  // отвечает ни на что.
  const seen = new Set<string>();
  for (;;) {
    const rows = await waitersBehind(probe, pid);
    for (const row of rows) seen.add(`${row.query} [${row.waitEvent}]`);
    const hits = rows.filter((row) => !expected || expected.test(row.query));
    if (hits.length >= count) return hits;
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: в очереди за бэкендом ${pid} так и не появился ожидаемый запрос` +
          `${expected ? ` (${String(expected)}, нужно ${count})` : ''}; ` +
          `видели: ${[...seen].join(' | ') || '—'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Один ждущий — обычный случай: за строкой очередь выстраивается цепочкой, по одному на звено. */
async function oneQueuedBehind(
  probe: pg.Client,
  pid: number,
  what: string,
  expected?: RegExp,
): Promise<Waiter> {
  return (await queuedBehind(probe, pid, what, expected))[0]!;
}

/**
 * Имя таблицы в маске ожидания — С КАВЫЧКАМИ ИЛИ БЕЗ, и это не перестраховка: drizzle кавычит имена
 * всегда, а сырой SQL пробы — так, как набран в тесте. Маска, собранная под один вид, под другой не
 * подойдёт никогда, и случай краснеет не там, где ошибка.
 */
function таблица(имя: string): string {
  return `"?${имя}"?`;
}

async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]!.pid;
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
  // Обработчик вешается ПЕРВЫМ ЖЕ действием, до всякого `await import`: обещание сюда приходит уже
  // запущенным, и отложи мы `await` хоть на такт — отказ успел бы стать unhandled rejection, а
  // vitest считает такую ошибку падением прогона. Разбор идёт после, когда ошибка уже поймана.
  let caught: unknown;
  let принято = false;
  try {
    await run;
    принято = true;
  } catch (e) {
    caught = e;
  }
  if (принято) throw new Error('база приняла запись, которую обязана была отбить');
  const { pgErrorOf } = await import('../src/lib/pg-error');
  const info = pgErrorOf(caught);
  let message = '';
  let current: unknown = caught;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { message?: string; cause?: unknown };
    if (typeof candidate.message === 'string') message += `${candidate.message}\n`;
    current = candidate.cause;
  }
  return { code: info?.code, constraint: info?.constraint, message };
}

/** Событие журнала прямым SQL — тем путём, которым в базу ходят скрипты и миграции. */
function insertEntry(
  autoPartId: string,
  before: number,
  after: number,
  reason = 'сверка склада',
): ReturnType<typeof sql> {
  return sql`
    INSERT INTO auto_part_stock_entries
      (auto_part_id, quantity_before, quantity_after, reason, changed_by)
    VALUES (${autoPartId}, ${before}, ${after}, ${reason}, ${ctx.admin.id})`;
}

/** Чем опознаётся своё в каждой таблице: по одному условию на таблицу. */
interface Отбор {
  позиции: ReturnType<typeof sql>;
  машины: ReturnType<typeof sql>;
  модели: ReturnType<typeof sql>;
  типы: ReturnType<typeof sql>;
  учётки: ReturnType<typeof sql>;
  наборы: ReturnType<typeof sql>;
}

/** Своё в этом прогоне — точным суффиксом. */
function своё(): Отбор {
  return {
    позиции: sql`name LIKE ${`${NAME_PREFIX} ${RUN}%`}`,
    машины: sql`note = ${`${NAME_PREFIX} ${RUN}`}`,
    модели: sql`name LIKE ${`${MODEL_PREFIX} ${RUN}%`}`,
    типы: sql`code LIKE ${`${TYPE_CODE_PREFIX}_${RUN}%`}`,
    учётки: sql`email LIKE ${`db-ap-%-${RUN}@example.invalid`}`,
    наборы: sql`code LIKE ${`AP-${RUN}-%`}`,
  };
}

/**
 * Хвосты БРОШЕННЫХ прогонов этого же файла: устойчивый префикс плюс возраст.
 *
 * ВОЗРАСТ — ЕДИНСТВЕННОЕ, ЧТО ОТДЕЛЯЕТ БРОШЕННОЕ ОТ ЖИВОГО. Файл целиком проходит за десяток
 * секунд, а прогон, упёршийся в чужую пробку, умирает по таймауту хука на 180-й секунде — то есть
 * фикстуры живого соседа не бывают старше трёх минут. Десять минут дают трёхкратный зазор и при
 * этом чистят брошенное уже на следующем запуске, а не через месяц.
 *
 * Сама уборка идёт ТОЛЬКО в `beforeAll`, до заведения своего, — значит навредить себе она не может
 * в принципе: на момент её работы своих строк ещё нет.
 */
function брошенное(): Отбор {
  const давно = sql`created_at < now() - interval '10 minutes'`;
  return {
    позиции: sql`name LIKE ${`${NAME_PREFIX} %`} AND ${давно}`,
    машины: sql`note LIKE ${`${NAME_PREFIX} %`} AND ${давно}`,
    модели: sql`name LIKE ${`${MODEL_PREFIX} %`} AND ${давно}`,
    типы: sql`code LIKE ${`${TYPE_CODE_PREFIX}_%`} AND ${давно}`,
    учётки: sql`email LIKE 'db-ap-%@example.invalid' AND ${давно}`,
    наборы: sql`code LIKE 'AP-%' AND ${давно}`,
  };
}

/**
 * Уборка. База общая, и порядок здесь задан не вкусом, а схемой:
 *
 *   1. СТРОКИ ЖУРНАЛА НЕУДАЛЯЕМЫ, И ОБОЙТИ ЭТО НЕЧЕМ. Круг замкнут с обеих сторон: позиция с
 *      движением не удаляется (`ON DELETE RESTRICT`), а сами строки журнала не удаляются триггером
 *      неизменяемости — и это не оплошность, а Р3 целиком. Каскада сюда не ведёт ни одного,
 *      `session_replication_role` триггеру не указ (он `ENABLE ALWAYS`), а `TRUNCATE` унёс бы
 *      вместе со своим и чужое. Значит db-тест, записавший хоть одно событие, либо оставляет свои
 *      строки в общей базе НАВСЕГДА, либо гасит триггер на время уборки. Выбрано второе — и
 *      обставлено так, чтобы цена была наименьшей: одной транзакцией (`ALTER TABLE` в Postgres
 *      транзакционен, поэтому оборванный прогон откатывает и гашение), с возвратом `ENABLE ALWAYS`
 *      (простое `ENABLE` оставило бы триггер неработающим на реплике-приёмнике) и с коротким
 *      `lock_timeout` (`DISABLE TRIGGER` берёт `ACCESS EXCLUSIVE`, и запирать соседний прогон
 *      уборка не вправе);
 *   2. строки актов обслуживания — ПОСЛЕ журнала и ДО позиций: `vehicle_maintenance_parts`
 *      ссылается на позицию под `RESTRICT`, а её собственный отложенный инвариант сходится ровно
 *      потому, что движений к этому моменту уже нет (обе стороны по нулю);
 *   3. позиции — после журнала; разметка применимости уходит каскадом сама;
 *   4. машины — раньше моделей и типов, на которые они ссылаются (`RESTRICT` с обеих сторон);
 *   5. модели — после машин и после позиций (разметка держит модель под `RESTRICT`);
 *   6. типы — последними из справочника техники;
 *   7. учётки — после журнала (`changed_by` тоже стоит под `RESTRICT`), наборы — после учёток.
 *
 * Зовётся дважды: в `afterAll` за своим и в `beforeAll` за брошенным.
 */
async function убрать(отбор: Отбор): Promise<void> {
  const мои = sql`SELECT id FROM auto_parts WHERE ${отбор.позиции}`;
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`
      ALTER TABLE auto_part_stock_entries DISABLE TRIGGER auto_part_stock_immutable`);
    await tx.execute(sql`DELETE FROM auto_part_stock_entries WHERE auto_part_id IN (${мои})`);
    await tx.execute(sql`
      ALTER TABLE auto_part_stock_entries ENABLE ALWAYS TRIGGER auto_part_stock_immutable`);
    await tx.execute(sql`DELETE FROM vehicle_maintenance_parts WHERE auto_part_id IN (${мои})`);
    await tx.execute(sql`DELETE FROM auto_parts WHERE ${отбор.позиции}`);
  });
  await ctx.db.execute(sql`DELETE FROM vehicles WHERE ${отбор.машины}`);
  await ctx.db.execute(sql`DELETE FROM vehicle_models WHERE ${отбор.модели}`);
  await ctx.db.execute(sql`DELETE FROM vehicle_types WHERE ${отбор.типы}`);
  const учётки = sql`SELECT id FROM users WHERE ${отбор.учётки}`;
  await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${учётки})`);
  await ctx.db.execute(sql`DELETE FROM users WHERE ${отбор.учётки}`);
  await ctx.db.execute(sql`DELETE FROM grants WHERE ${отбор.наборы}`);
}

describe.skipIf(!DB_URL)('автозапчасти: журнал остатка, применимость и подбор', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    // Хвосты брошенных прогонов — ДО заведения своего: база общая и живёт между запусками, а
    // `afterAll` отрабатывает не всегда. Своих строк на этот момент ещё нет, поэтому навредить себе
    // уборка не может; чужому живому прогону — тоже: его фикстуры моложе порога.
    ctx = { db } as Ctx;
    await убрать(брошенное());

    const passwordHash = await hashPassword(PASSWORD);

    // Учётки заводятся SQL: форма учётки — предмет своих тестов, здесь они декорации, без которых
    // не разложить четыре набора прав.
    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-ap-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Механик', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const admin = await makeUser('admin', 'admin');
    /*
     * Роль всех троих — `dispatcher`: у неё есть `garage.read` (склад виден всем, кому виден гараж,
     * Р10) и НЕТ ни одного права автозапчастей (Р19 — ровно поэтому склад и разведён с актом).
     * Значит разницу в ответах даёт ровно выданный набор, а не роль.
     */
    const manageUser = await makeUser('manage', 'dispatcher');
    const stockUser = await makeUser('stock', 'dispatcher');
    const readUser = await makeUser('read', 'dispatcher');

    /**
     * Набор с одним правом. Строка `grant_roles` обязательна: право считается соединением с ролью
     * держателя (`grantPermissionsExpr`), и без совпадения роли набор не действует вовсе.
     */
    async function grantOnly(tag: string, permission: Permission, role: string): Promise<string> {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, is_system)
        VALUES (${`AP-${RUN}-${tag}`}, ${`Автозапчасти: ${tag} ${RUN}`}, false)
        RETURNING id`);
      const grantId = res.rows[0]!.id;
      await db.execute(
        sql`INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, ${sql.raw(`'${role}'::role`)})`,
      );
      await db.execute(
        sql`INSERT INTO grant_permissions (grant_id, permission) VALUES (${grantId}, ${permission})`,
      );
      return grantId;
    }

    const manageGrant = await grantOnly('manage', MANAGE, 'dispatcher');
    const stockGrant = await grantOnly('stock', STOCK, 'dispatcher');
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
      VALUES (${manageUser.id}, ${manageGrant}, ${admin.id}, 'manual'),
             (${stockUser.id}, ${stockGrant}, ${admin.id}, 'manual')`);

    // Свои типы техники, своя модель и свои машины: разметка применимости стоит под `RESTRICT`, и
    // чужую строку справочника трогать нельзя — она видна всей базе, в том числе соседним прогонам.
    const kinds = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicle_kinds WHERE code = 'freight_transport' LIMIT 1`,
    );
    const kindId = kinds.rows[0]?.id;
    if (!kindId) throw new Error('в базе нет видов техники: миграция 0009 не применена');

    const makeType = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO vehicle_types (kind_id, code, name, is_active)
        VALUES (${kindId}, ${`${TYPE_CODE_PREFIX}_${RUN}_${tag}`},
                ${`ТЕСТ: тип автозапчастей ${tag} ${RUN}`}, false)
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const typeWithModelId = await makeType('m');
    const typeNoModelId = await makeType('n');

    const models = await db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_models (vehicle_type_id, name)
      VALUES (${typeWithModelId}, ${`${MODEL_PREFIX} ${RUN} 65115`})
      RETURNING id`);
    const modelId = models.rows[0]!.id;

    const makeVehicle = async (typeId: string, model: string | null): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO vehicles (ownership, vehicle_type_id, vehicle_model_id, status, note)
        VALUES ('own', ${typeId}, ${model}, 'active', ${`${NAME_PREFIX} ${RUN}`})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const vehicleWithModelId = await makeVehicle(typeWithModelId, modelId);
    const vehicleNoModelId = await makeVehicle(typeNoModelId, null);

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

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(admin),
      manageUser: await withAuth(manageUser),
      stockUser: await withAuth(stockUser),
      readUser: await withAuth(readUser),
      typeWithModelId,
      typeNoModelId,
      modelId,
      vehicleWithModelId,
      vehicleNoModelId,
    };
  }, 180_000);

  /** Своё этого прогона — точным суффиксом. Все семь шагов и их порядок объяснены у `убрать`. */
  afterAll(async () => {
    // Через `?.` каждое звено: `beforeAll` кладёт в `ctx` сперва одну лишь связь с базой (уборка
    // брошенного нужна раньше всего остального), и оборвись он посередине — здесь оказался бы
    // недособранный объект. Уборка своего при этом обязана состояться всё равно.
    await ctx?.app?.close();
    if (ctx?.db) await убрать(своё());
    await ctx?.closeDb?.();
  });

  // ── 1. Заведение и первое событие журнала (Р3) ──

  it('заведение с остатком пишет первое событие «0 → N», с нулём — не пишет ничего', async () => {
    // Начальный остаток — не поле карточки, а ПЕРВОЕ СОБЫТИЕ: цепочка считает, что до него позиции
    // не было ничего, поэтому строка выходит «0 → 12». Заведение с нулём событий не пишет вовсе —
    // «0 → 0» это не событие, а его отсутствие, и `CHECK` такую строку не пропустит.
    const withStock = await createPart({ quantity: 12 });
    expect(withStock.quantity).toBe(12);
    // Обязательные поля DTO — явными `expect`: компилятор в `test/` не заходит (см. `tsconfig`),
    // и опечатка в имени поля дожила бы до прогона молча.
    expect(withStock.unit).toBe('шт');
    expect(withStock.isActive).toBe(true);
    expect(withStock.applicability).toEqual([]);
    expect(withStock.hasStockHistory).toBe(true);
    // Ранга нет вовсе, когда о машине не спрашивали (Р21): ноль означал бы «подходит по модели».
    expect(withStock.applicabilityRank).toBeUndefined();

    const journal = await journalOf(withStock.id);
    expect(journal).toHaveLength(1);
    expect(journal[0]!.before).toBe(0);
    expect(journal[0]!.after).toBe(12);
    expect(journal[0]!.reason).toBe(FIRST_ENTRY_REASON);
    // Вид события проставляет сервер, а не клиент, и ссылки на акт у ручной правки нет.
    expect(journal[0]!.kind).toBe('manual');
    expect(journal[0]!.maintenanceId).toBeNull();

    const empty = await createPart({ quantity: 0 });
    expect(await journalOf(empty.id)).toHaveLength(0);
    expect(empty.hasStockHistory).toBe(false);
  });

  it('первым событием может быть только «0 → N»: «12 → 10» на пустом журнале отбито', async () => {
    /*
     * Правило строже, чем читается в Р3: завести позицию сразу с двенадцатью и первой строкой
     * «12 → 10» нельзя — до неё в журнале пусто, а пустой журнал означает ноль. Порядок «карточка →
     * событие» здесь соблюдён, и остаток карточки совпадает со «стало»: отбивает именно первый
     * конец проверки, а не второй.
     */
    const part = await createPart({ quantity: 0 });
    const refusal = await dbRefusal(
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE auto_parts SET quantity = 10 WHERE id = ${part.id}`);
        await tx.execute(insertEntry(part.id, 12, 10, 'перенос остатка из тетради'));
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('предыдущее событие оставило 0');
    // Имени ограничения нет — значит бросил триггер, а не `CHECK`: разбор ошибок в маршрутах
    // держится ровно на этом различии.
    expect(refusal.constraint).toBeUndefined();

    // Отказ откатил транзакцию целиком: карточка осталась нулём, журнал — пустым.
    expect(await quantityOf(part.id)).toBe(0);
    expect(await journalOf(part.id)).toHaveLength(0);
  });

  // ── 2. Цепочка сверяется ОБОИМИ концами (Р3) ──

  it('«999 → 12» при остатке 12 не вставляется: сверки одного конца было бы мало', async () => {
    /*
     * ГЛАВНЫЙ СЛУЧАЙ ЦЕПОЧКИ. «Стало» здесь верно — 12 и в событии, и в карточке, — поэтому
     * проверка, сверяющая только последний конец, пропустила бы строку насквозь. А в журнале
     * навсегда осталось бы выдуманное «было», по которому потом считают расход: «999 → 12» читается
     * как «списали 987 фильтров».
     */
    const part = await createPart({ quantity: 12 });
    const refusal = await dbRefusal(ctx.db.execute(insertEntry(part.id, 999, 12, 'подгон')));
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('предыдущее событие оставило 12');
    expect(refusal.constraint).toBeUndefined();
    expect(await journalOf(part.id)).toHaveLength(1);
  });

  it('«стало», не равное остатку карточки, не вставляется: событие обязано доехать до неё', async () => {
    // Второй конец той же проверки, и он же — запрет события БЕЗ правки карточки: «было» равно
    // остатку (иначе цепочка уже порвана), «стало» обязано равняться ему же, а `CHECK` требует их
    // различия. Порядок «сначала карточка, потом событие» держится именно этим.
    const part = await createPart({ quantity: 12 });
    const refusal = await dbRefusal(
      ctx.db.execute(insertEntry(part.id, 12, 5, 'событие без правки карточки')),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('а в карточке 12');
    expect(refusal.constraint).toBeUndefined();
    expect(await quantityOf(part.id)).toBe(12);
    expect(await journalOf(part.id)).toHaveLength(1);
  });

  // ── 3. Журнал неизменяем (Р3) ──

  it('строку журнала нельзя ни поправить, ни удалить прямым запросом', async () => {
    // `RESTRICT` со стороны позиции защищает историю ЦЕЛИКОМ, но не построчно, а «журнал, который
    // нельзя подчистить» обязан означать именно это. Ошибку исправляют следующим событием — так
    // исправление остаётся видимым, а не заменяет собой то, что было.
    const part = await createPart({ quantity: 7 });
    const [entry] = await journalOf(part.id);

    const edited = await dbRefusal(
      ctx.db.execute(sql`
        UPDATE auto_part_stock_entries SET reason = 'подчистили задним числом'
         WHERE id = ${entry!.id}`),
    );
    expect(edited.code).toBe('23514');
    expect(edited.message).toContain('неизменяем');

    const removed = await dbRefusal(
      ctx.db.execute(sql`DELETE FROM auto_part_stock_entries WHERE id = ${entry!.id}`),
    );
    expect(removed.code).toBe('23514');
    expect(removed.message).toContain('неизменяем');

    // Строка на месте и в прежнем виде: оба отказа откатили свою транзакцию целиком.
    const after = await journalOf(part.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.reason).toBe(FIRST_ENTRY_REASON);
  });

  it('номер события назначить вставкой можно, а порвать хвост журнала — нельзя', async () => {
    /*
     * `GENERATED ALWAYS` номер сам по себе не запрещает: `OVERRIDING SYSTEM VALUE` его назначает, и
     * первая половина случая это показывает. Вреда от этого нет, но держится порядок не запретом, а
     * другим: отложенная проверка покрытия читает ХВОСТ по `max(seq)`, и событие, вставленное ПЕРЕД
     * хвостом, оставляет карточку разошедшейся с ним — и отменяется на коммите.
     *
     * Случай написан на том, что верно, а не на том, что обещано: он краснеет, если проверка
     * покрытия начнёт искать «последнее событие» по времени вместо `seq`, — а именно эту подмену
     * `seq` и предотвращает («две правки одной секунды по `created_at` неразличимы»).
     */
    const part = await createPart({ quantity: 12 });
    const [первое] = await journalOf(part.id);
    const вперёд = первое!.seq + 1_000_000;

    // 1. Номер назначается — и цепочке это безразлично: она смотрит на «было» и «стало», а не на
    //    номер. Событие с назначенным номером проходит целиком.
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE auto_parts SET quantity = 10 WHERE id = ${part.id}`);
      await tx.execute(sql`
        INSERT INTO auto_part_stock_entries
          (seq, auto_part_id, quantity_before, quantity_after, reason, changed_by)
        OVERRIDING SYSTEM VALUE
        VALUES (${вперёд}, ${part.id}, 12, 10, 'событие с назначенным номером', ${ctx.admin.id})`);
    });
    const журнал = await journalOf(part.id);
    expect(журнал.at(-1)!.seq, 'номер не назначился').toBe(вперёд);
    expectChain(журнал, await quantityOf(part.id));

    // 2. А событие ПЕРЕД хвостом отменяется на коммите: цепочку оно проходит (сверяется с хвостом),
    //    но хвостом не становится — и карточка расходится с ним. Ровно это и защищает историю от
    //    переписывания задним номером.
    const refusal = await dbRefusal(
      ctx.db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE auto_parts SET quantity = 8 WHERE id = ${part.id}`);
        await tx.execute(sql`
          INSERT INTO auto_part_stock_entries
            (seq, auto_part_id, quantity_before, quantity_after, reason, changed_by)
          OVERRIDING SYSTEM VALUE
          VALUES (${первое!.seq - 1}, ${part.id}, 10, 8, 'подложено под хвост', ${ctx.admin.id})`);
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('последнее событие журнала оставило 10');
    expect(refusal.constraint).toBeUndefined();

    // Журнал и карточка остались как были: отказ откатил транзакцию целиком.
    expect(await journalOf(part.id)).toHaveLength(2);
    expect(await quantityOf(part.id)).toBe(10);
  }, 60_000);

  // ── 4. Остаток без события невозможен: отложенная проверка (Р3) ──

  it('прямой UPDATE остатка проходит, но падает НА КОММИТЕ отложенным триггером', async () => {
    /*
     * Цепочка ловит неверное событие, но молчит там, где события нет вовсе: `UPDATE … SET quantity
     * = 7` скриптом прошёл бы мимо неё насквозь. Ловит его отложенный constraint-триггер — и ловит
     * ИМЕННО НА КОММИТЕ: немедленная проверка отбивала бы саму правку остатка на первом же шаге, то
     * есть запрещала бы единственный правильный путь «карточка → событие».
     *
     * Поэтому случай идёт сырым соединением, а не транзакцией drizzle: предмет проверки — то, что
     * `UPDATE` ПРОХОДИТ, а `COMMIT` отказывает, и в одном обёрнутом вызове это различие не видно.
     *
     * Обе ветки проверки сразу: пустой журнал («остаток взялся ниоткуда») и разошедшийся с журналом
     * остаток — сообщения у них разные, потому что и делать человеку в этих случаях разное.
     */
    const fresh = await createPart({ quantity: 0 });
    const moved = await createPart({ quantity: 12 });
    const c = await openClient();
    try {
      await c.query('BEGIN');
      const upd = await c.query('UPDATE auto_parts SET quantity = 7 WHERE id = $1', [fresh.id]);
      expect(upd.rowCount, 'сама правка обязана пройти: проверка отложена до коммита').toBe(1);
      const refusal = await dbRefusal(c.query('COMMIT'));
      expect(refusal.code).toBe('23514');
      expect(refusal.message).toContain('в журнале нет ни одного события');
      expect(refusal.constraint).toBeUndefined();

      await c.query('BEGIN');
      await c.query('UPDATE auto_parts SET quantity = 7 WHERE id = $1', [moved.id]);
      const drifted = await dbRefusal(c.query('COMMIT'));
      expect(drifted.code).toBe('23514');
      expect(drifted.message).toContain('последнее событие журнала оставило 12');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }

    // Отказ на коммите откатывает транзакцию целиком — обе карточки остались как были.
    expect(await quantityOf(fresh.id)).toBe(0);
    expect(await quantityOf(moved.id)).toBe(12);
  }, 60_000);

  it('тот же UPDATE вместе с корректным событием проходит', async () => {
    // Обратная сторона случая выше: отложенная проверка запрещает не правку остатка мимо маршрута,
    // а правку БЕЗ СОБЫТИЯ. Скрипт, пишущий обе строки в правильном порядке, законен — и это не
    // послабление, а условие: тем же путём ходят миграции и разовые сверки склада.
    const part = await createPart({ quantity: 12 });
    const client = await openClient();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE auto_parts SET quantity = 7 WHERE id = $1', [part.id]);
      await client.query(
        `INSERT INTO auto_part_stock_entries
           (auto_part_id, quantity_before, quantity_after, reason, changed_by)
         VALUES ($1, 12, 7, 'сверка склада: пять поставили без акта', $2)`,
        [part.id, ctx.admin.id],
      );
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
    expectChain(await journalOf(part.id), await quantityOf(part.id));
    expect(await quantityOf(part.id)).toBe(7);
  }, 60_000);

  it('две правки остатка в одной транзакции (12 → 10 → 8) проходят целиком', async () => {
    /*
     * Отложенные триггеры срабатывают на коммите ОБА, и первый из них, сравнивая свой снимок «стало
     * 10» с журналом, где уже 8, дал бы отказ на ровном месте. Не даёт потому, что проверка
     * принимает идентификатор и ПЕРЕЧИТЫВАЕТ по нему состояние: у обоих срабатываний оно одно и то
     * же — и оно верное. Случай и сторожит это свойство: перепиши функцию на `NEW.quantity`, и он
     * покраснеет, а все остальные останутся зелёными.
     *
     * Свойство это не теоретическое: правка строк акта пишет движения ПАЧКОЙ, в одной транзакции
     * (Р5), и без перечитывания диффер расхода не работал бы вовсе.
     */
    const part = await createPart({ quantity: 12 });
    const client = await openClient();
    try {
      await client.query('BEGIN');
      const step = async (before: number, after: number, reason: string): Promise<void> => {
        await client.query('UPDATE auto_parts SET quantity = $1 WHERE id = $2', [after, part.id]);
        await client.query(
          `INSERT INTO auto_part_stock_entries
             (auto_part_id, quantity_before, quantity_after, reason, changed_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [part.id, before, after, reason, ctx.admin.id],
        );
      };
      await step(12, 10, 'поставили два на самосвал');
      await step(10, 8, 'поставили ещё два на погрузчик');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }

    const journal = await journalOf(part.id);
    expect(journal.map((e) => [e.before, e.after])).toEqual([
      [0, 12],
      [12, 10],
      [10, 8],
    ]);
    expectChain(journal, await quantityOf(part.id));
    expect(await quantityOf(part.id)).toBe(8);
  }, 60_000);

  // ── 5. Гонка остатка через маршрут (Р3) ──

  it('два одновременных POST /:id/stock от 12: один проходит, второй — 409 с текущим числом', async () => {
    /*
     * ГОНКА — СВОЙСТВО ПАРЫ ЗАПРОСОВ, и без настоящей встречи случай ничего не стоит: последовательные
     * запросы этой ветки не касаются вовсе — второй прочитал бы уже новое число и получил бы тот же
     * 409 от простой сверки, не постояв ни на одной блокировке.
     *
     * Поэтому сцена собирается держателем: соседнее соединение берёт строку позиции `FOR UPDATE` и
     * не отпускает, обе двери приходят в это окно и обязаны встать в очередь на СТРОКЕ — то есть на
     * первом шаге своей транзакции, до всякой сверки. Убери из маршрута `SELECT … FOR UPDATE`, и
     * очереди на строке не окажется вовсе: обе двери прочитают 12, обе пройдут сверку, и вторая
     * доедет до триггера цепочки с «было 12» при журнале, где уже 10, — то есть вместо 409 человек
     * получит 500.
     *
     * ОЧЕРЕДЬ ЗА СТРОКОЙ — ЦЕПОЧКА, А НЕ ВЕЕР: первый ждущий забирает временную блокировку самого
     * кортежа и встаёт на `transactionid` держателя, а второй упирается уже в НЕГО и ждёт на
     * `tuple`. Поэтому `pg_blocking_pids` называет держателя только у первого.
     *
     * Кто из двоих придёт первым, сцена не задаёт: порядок выбирает менеджер блокировок. Поэтому
     * ожидания написаны от ответа, а не от порядка вызовов.
     */
    const part = await createPart({ quantity: 12 });
    const holder = await openClient();
    const probe = await openProbe();
    let first: ReturnType<typeof postStock> | undefined;
    let second: ReturnType<typeof postStock> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM auto_parts WHERE id = $1 FOR UPDATE', [part.id]);

      first = postStock(part.id, {
        quantity: 10,
        expectedQuantity: 12,
        reason: 'поставили два на самосвал',
      });
      second = postStock(part.id, {
        quantity: 8,
        expectedQuantity: 12,
        reason: 'поставили четыре на погрузчик',
      });

      const forUpdate = new RegExp(`${таблица('auto_parts')}.+for update`, 'is');
      const ahead = await oneQueuedBehind(
        probe,
        await backendPid(holder),
        'первая правка остатка',
        forUpdate,
      );
      // Первая ждёт ЧУЖУЮ ТРАНЗАКЦИЮ — значит дошла до `SELECT … FOR UPDATE` и встала на строке, а
      // не проскочила мимо блокировки к сверке.
      expect(
        ahead.waitEvent,
        'первая правка не встала на строке позиции — блокировки в маршруте нет',
      ).toBe('transactionid');
      // Вторая ждёт ПЕРВУЮ, на том же запросе: очередь за строкой выстроилась, а не разошлась по
      // двум независимым чтениям.
      const behind = await oneQueuedBehind(probe, ahead.pid, 'вторая правка остатка', forUpdate);
      expect(behind.pid).not.toBe(ahead.pid);
      expect(behind.waitEvent, 'вторая правка ждёт не блокировку').toBe('tuple');

      await holder.query('ROLLBACK');
      const [a, b] = await Promise.all([first, second]);
      first = undefined;
      second = undefined;

      expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([200, 409]);
      const winner = a.statusCode === 200 ? a : b;
      const loser = a.statusCode === 200 ? b : a;
      const written = winner.json() as AutoPartStockResultDto;
      expect(written.entry).not.toBeNull();

      // Проигравшему называется ТЕКУЩЕЕ число прямо в тексте: без него окно правки предложит
      // переспросить ровно то же самое.
      expect(loser.json().message).toContain(`сейчас ${written.part.quantity}`);

      // Журнал остался непрерывной цепочкой, а итог совпал с последней строкой — то есть гонка
      // разошлась отказом, а не второй записью поверх первой.
      const journal = await journalOf(part.id);
      expect(journal).toHaveLength(2);
      expectChain(journal, await quantityOf(part.id));
      expect(journal.at(-1)!.after).toBe(written.part.quantity);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await first?.catch(() => undefined);
      await second?.catch(() => undefined);
      await holder.end();
      await probe.end();
    }
  }, 60_000);

  it('повторное нажатие тем же числом события не заводит и карточку не трогает', async () => {
    // Это не ошибка ввода, а второе нажатие кнопки: журнал не должен пухнуть от таких событий, и
    // `updated_at` карточки не должен сдвигаться — правки не было.
    const part = await createPart({ quantity: 5 });
    const before = await detailOf(part.id);

    const same = await stockOk(part.id, {
      quantity: 5,
      expectedQuantity: 5,
      reason: 'пересчитали коробки, всё сходится',
    });
    expect(same.entry).toBeNull();
    expect(same.part.quantity).toBe(5);

    const after = await detailOf(part.id);
    expect(after.stockEntries).toHaveLength(before.stockEntries.length);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  // ── 6. Идентичность позиции: артикул и пара «наименование + артикул» (Р12) ──

  it('дубль артикула в другом регистре и с неразрывным пробелом — 409 маршрута, а не вторая строка', async () => {
    /*
     * Правило написания артикула живёт функцией базы и стоит сразу в трёх местах — уникальном
     * индексе, `CHECK` и проверке занятости в маршруте; разойдись они хоть на символ, маршрут
     * перестал бы находить то, что отвергает индекс, и человек получил бы 500 с именем индекса
     * вместо слов. Неразрывный пробел здесь не экзотика: его ставит Word автозаменой, и в артикуле
     * из письма он приезжает регулярно.
     */
    const code = nextCode();
    const first = await createPart({ code });
    // В справочник артикул лёг уже нормализованным — маршрут прогнал ввод через функцию базы.
    expect(first.code).toBe(code);

    const disguised = `${code.slice(0, 5).toLowerCase()}${NBSP}${code.slice(5).toLowerCase()}`;
    const dup = await postPart({ code: disguised });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().message).toContain('артикулом уже заведена');
    expect(dup.json().fields).toMatchObject({ code: expect.stringContaining('артикул') });

    // Второй строки не появилось: отбил маршрут, а не индекс — и отбил до вставки.
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM auto_parts
         WHERE auto_part_code_key(code) = auto_part_code_key(${code})`),
    ).toBe(1);

    // Тот же артикул с пробелом внутри прямой вставкой не пройдёт и `CHECK`: в базе он хранится
    // ключом, а не тем, что набрали.
    const raw = await dbRefusal(
      ctx.db.execute(sql`
        INSERT INTO auto_parts (code, name) VALUES (${`${code.slice(0, 4)} ${code.slice(4)}`},
        ${nextName('прямая вставка')})`),
    );
    expect(raw.code).toBe('23514');
    expect(raw.constraint).toBe('auto_parts_code_normalized_check');
  });

  it('одинаковые наименования с разными артикулами законны, без артикула — второй отбит', async () => {
    /*
     * Уникальна ПАРА (Р12), а не одно имя: «Фильтр масляный» разных производителей с разными
     * артикулами — законные разные позиции, и запрет по имени заставил бы механика выдумывать
     * названия. Не один артикул: у позиций без него артикула нет вовсе, и одинаковые имена без
     * артикула — это как раз двойник, которого надо отбить.
     */
    const name = nextName('Фильтр масляный');
    const a = await createPart({ name, code: nextCode() });
    const b = await createPart({ name, code: nextCode() });
    expect(a.name).toBe(name);
    expect(b.name).toBe(name);
    expect(a.id).not.toBe(b.id);

    const noCodeName = nextName('Ремень генератора');
    const first = await createPart({ name: noCodeName });
    // Артикула нет — это `null`, а не пустая строка: пустой строке в базу хода нет вовсе.
    expect(first.code).toBeNull();

    const dup = await postPart({ name: `  ${noCodeName.toLowerCase()}  ` });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().message).toContain('наименованием уже заведена');

    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM auto_parts
         WHERE auto_part_name_key(name) = auto_part_name_key(${noCodeName})`),
    ).toBe(1);
  });

  // ── 7. Удаление и гашение (Р11) ──

  it('пока журнал пуст, позиция удаляется совсем, а разметка уходит каскадом', async () => {
    // Так убирают опечатку первого дня. Разметка применимости — свойство ЖИВОЙ позиции, а не
    // история, и уходит она каскадом: удалять её отдельной ручкой было бы нечего.
    const part = await createPart({
      quantity: 0,
      applicability: [{ vehicleModelId: ctx.modelId }, { vehicleTypeId: ctx.typeNoModelId }],
    });
    expect(part.applicability).toHaveLength(2);
    expect(
      await countRows(
        sql`SELECT count(*)::int AS c FROM auto_part_applicability WHERE auto_part_id = ${part.id}`,
      ),
    ).toBe(2);

    const res = await inject('DELETE', `/api/v1/auto-parts/${part.id}`, ctx.admin.auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(
      await countRows(sql`SELECT count(*)::int AS c FROM auto_parts WHERE id = ${part.id}`),
    ).toBe(0);
    expect(
      await countRows(
        sql`SELECT count(*)::int AS c FROM auto_part_applicability WHERE auto_part_id = ${part.id}`,
      ),
      'разметка осталась сиротой — каскада нет',
    ).toBe(0);
  });

  it('с движением — 409 словами от маршрута и RESTRICT от схемы при прямом DELETE', async () => {
    // Правило держит `ON DELETE RESTRICT` журнала, а не маршрут; маршрут лишь переводит имя
    // ограничения в понятную фразу — «снимите „Активна“».
    const part = await createPart({ quantity: 3 });
    const res = await inject('DELETE', `/api/v1/auto-parts/${part.id}`, ctx.admin.auth);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain('снимите');

    const refusal = await dbRefusal(
      ctx.db.execute(sql`DELETE FROM auto_parts WHERE id = ${part.id}`),
    );
    expect(refusal.code).toBe('23503');
    expect(refusal.constraint).toBe('auto_part_stock_entries_auto_part_id_fkey');

    // Гашение работает и с движением: это и есть выход, который называет отказ.
    const patched = await patchPart(part.id, { isActive: false });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((patched.json() as AutoPartDto).isActive).toBe(false);
  });

  // ── 8. Применимость: две оси одной разметкой (Р8) ──

  it('CHECK «ровно одна ссылка»: и обе сразу, и ни одной — отказ схемы', async () => {
    // Схема тела отбивает то же самое словами (это предмет контрактного теста), но правило живёт в
    // базе: строка разметки, привязанная к двум предметам сразу или ни к одному, — не «пустая
    // применимость» (та выражается отсутствием строк), а мусор.
    const part = await createPart({ quantity: 0 });

    const обе = await dbRefusal(
      ctx.db.execute(sql`
        INSERT INTO auto_part_applicability (auto_part_id, vehicle_model_id, vehicle_type_id)
        VALUES (${part.id}, ${ctx.modelId}, ${ctx.typeNoModelId})`),
    );
    expect(обе.code).toBe('23514');
    expect(обе.constraint).toBe('auto_part_applicability_target_check');

    const ни = await dbRefusal(
      ctx.db.execute(sql`
        INSERT INTO auto_part_applicability (auto_part_id, vehicle_model_id, vehicle_type_id)
        VALUES (${part.id}, NULL, NULL)`),
    );
    expect(ни.code).toBe('23514');
    expect(ни.constraint).toBe('auto_part_applicability_target_check');
  });

  it('фильтры по модели и по типу отдают ровно размеченные позиции', async () => {
    // «Что размечено этой моделью» — вопрос со стороны справочника, а не подбор: он отрезает.
    const tag = `фильтр-${randomUUID().slice(0, 6)}`;
    const byModel = await createPart({
      name: nextName(tag),
      applicability: [{ vehicleModelId: ctx.modelId }],
    });
    const byType = await createPart({
      name: nextName(tag),
      applicability: [{ vehicleTypeId: ctx.typeNoModelId }],
    });
    const plain = await createPart({ name: nextName(tag) });

    const модель = await listParts({ search: tag, vehicleModelId: ctx.modelId });
    expect(модель.map((p) => p.id)).toEqual([byModel.id]);
    // Тег в ответе раскрыт: имя модели без имени её типа не отвечает, чей это самосвал.
    expect(модель[0]!.applicability[0]!.vehicleModel).toMatchObject({
      id: ctx.modelId,
      vehicleTypeId: ctx.typeWithModelId,
    });

    const тип = await listParts({ search: tag, vehicleTypeId: ctx.typeNoModelId });
    expect(тип.map((p) => p.id)).toEqual([byType.id]);
    expect(тип[0]!.applicability[0]!.vehicleType).toMatchObject({ id: ctx.typeNoModelId });

    // Без фильтров видны все три, включая неразмеченную: разметка неполна по построению.
    const все = await listParts({ search: tag });
    expect(все.map((p) => p.id).sort()).toEqual([byModel.id, byType.id, plain.id].sort());
  });

  it('модель и тип под разметкой не удаляются: RESTRICT с обеих сторон', async () => {
    /*
     * Иначе деталь молча потеряла бы половину ответа «к чему подходит» (Р11).
     *
     * ТИПОВ ЗАВОДИТСЯ ДВА, И ЭТО НЕ ИЗБЫТОК. Своя модель сама ссылается на свой тип под `RESTRICT`
     * (`vehicle_models_vehicle_type_id_fkey`), и попытка удалить тип, под которым стоит модель,
     * отбилась бы ЕЮ — то есть случай зеленел бы, доказав чужое ограничение вместо своего. Поэтому
     * разметку по типу держит отдельный тип, под которым моделей нет вовсе. Машинами оба типа тоже
     * не заняты — по той же причине.
     */
    const kinds = await ctx.db.execute<{ id: string }>(
      sql`SELECT id FROM vehicle_kinds WHERE code = 'freight_transport' LIMIT 1`,
    );
    const kindId = kinds.rows[0]!.id;
    const makeType = async (tag: string): Promise<string> => {
      const res = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO vehicle_types (kind_id, code, name, is_active)
        VALUES (${kindId}, ${`${TYPE_CODE_PREFIX}_${RUN}_${tag}`},
                ${`ТЕСТ: тип под разметкой ${tag} ${RUN}`}, false)
        RETURNING id`);
      return res.rows[0]!.id;
    };
    // Тип-хозяин модели: сам под разметкой не стоит и в проверке не участвует.
    const hostTypeId = await makeType('host');
    // Тип, стоящий под разметкой напрямую: моделей под ним нет, машин тоже.
    const soloTypeId = await makeType('solo');
    const models = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_models (vehicle_type_id, name)
      VALUES (${hostTypeId}, ${`${MODEL_PREFIX} ${RUN} под разметкой`})
      RETURNING id`);
    const modelId = models.rows[0]!.id;

    const part = await createPart({
      quantity: 0,
      applicability: [{ vehicleModelId: modelId }, { vehicleTypeId: soloTypeId }],
    });

    const модель = await dbRefusal(
      ctx.db.execute(sql`DELETE FROM vehicle_models WHERE id = ${modelId}`),
    );
    expect(модель.code).toBe('23503');
    expect(модель.constraint).toBe('auto_part_applicability_vehicle_model_id_fkey');

    const тип = await dbRefusal(
      ctx.db.execute(sql`DELETE FROM vehicle_types WHERE id = ${soloTypeId}`),
    );
    expect(тип.code).toBe('23503');
    expect(тип.constraint).toBe('auto_part_applicability_vehicle_type_id_fkey');

    // Снятая разметка держать перестаёт: она и правда свойство живой позиции, а не история.
    const cleared = await patchPart(part.id, { applicability: [] });
    expect(cleared.statusCode, cleared.body).toBe(200);
    await ctx.db.execute(sql`DELETE FROM vehicle_models WHERE id = ${modelId}`);
    await ctx.db.execute(sql`DELETE FROM vehicle_types WHERE id IN (${soloTypeId}, ${hostTypeId})`);
  });

  // ── 9. Подбор под машину — ранг, а не фильтр (Р21) ──

  it('позиция, размеченная И моделью, И типом, приходит ОДИН раз с рангом 0', async () => {
    /*
     * ГЛАВНЫЙ СЛУЧАЙ РАНГА, и ломается он молча. Соединение с разметкой вместо `EXISTS` отдало бы
     * такую позицию ДВУМЯ строками: `total` перестал бы быть числом карточек, а страница показала
     * бы двойника — без единой ошибки и без единого отказа.
     */
    const tag = `оба-${randomUUID().slice(0, 6)}`;
    const both = await createPart({
      name: nextName(tag),
      applicability: [{ vehicleModelId: ctx.modelId }, { vehicleTypeId: ctx.typeWithModelId }],
    });

    const page = await listPage({ search: tag, vehicleId: ctx.vehicleWithModelId });
    expect(page.items.map((p) => p.id)).toEqual([both.id]);
    expect(page.total, 'позиция размножилась соединением с разметкой').toBe(1);
    // Ранг 0, а не 1: модель точнее типа, и `CASE` обязан отвечать первой подходящей веткой.
    expect(page.items[0]!.applicabilityRank).toBe(0);
    expect(page.items[0]!.applicability).toHaveLength(2);
  });

  it('порядок «модель → тип → остальное» держится на ВСЕХ страницах, а не внутри пришедшей', async () => {
    /*
     * Ранг считает сервер именно потому, что список разбит на страницы: досортировать пришедшую
     * страницу значит переставить двадцать строк из полутора тысяч, а подходящая деталь так и
     * останется на седьмой странице.
     *
     * Наименования подобраны ПРОТИВ ранга: по алфавиту вышло бы ровно наоборот («А-ничей» первым,
     * «Я-модель» последним). Значит зелёный ответ означает, что ранг стоит ПЕРВЫМ ключом сортировки,
     * а не что позициям повезло с именами.
     */
    const tag = `ранг${randomUUID().slice(0, 6)}`;

    /*
     * ШЕСТЬДЕСЯТ КАРТОЧЕК — ВЫНУЖДЕННОЕ ЧИСЛО, а не размах: наименьшая страница перечня равна
     * пятидесяти (`PAGE_SIZES` контракта), и на меньшем наборе «все страницы» неотличимы от одной.
     * Заводятся они прямым SQL, а не ручкой: предмет случая — ПОРЯДОК, заведение проверено выше, а
     * шестьдесят обращений к маршруту стоили бы секунд ради того, что уже доказано. Остаток у всех
     * нулевой — значит журнала нет, и уборке эти строки ничего не стоят.
     *
     * Раскладка подобрана ПРОТИВ алфавита: по имени первая страница набралась бы сорока «А-ничей» и
     * десятью «М-тип», а все десять «Я-модель» — те самые, ради которых подбор и заведён, — уехали
     * бы на вторую. Значит зелёный ответ означает, что ранг стоит ПЕРВЫМ ключом сортировки, а не
     * что позициям повезло с именами.
     */
    const пачка = async (
      суффикс: string,
      сколько: number,
      разметка: 'model' | 'type' | null,
    ): Promise<void> => {
      const начало = `${NAME_PREFIX} ${RUN} ${tag} ${суффикс}-`;
      await ctx.db.execute(sql`
        INSERT INTO auto_parts (name)
        SELECT ${начало} || to_char(g, 'FM000') FROM generate_series(1, ${сколько}) AS g`);
      if (разметка === null) return;
      const колонка = разметка === 'model' ? sql`vehicle_model_id` : sql`vehicle_type_id`;
      const цель = разметка === 'model' ? ctx.modelId : ctx.typeWithModelId;
      // Отбор по имени, а не по `RETURNING`: массив идентификаторов drizzle разворачивает в кортеж
      // параметров, и `unnest(…)::uuid[]` над ним не строится вовсе.
      await ctx.db.execute(sql`
        INSERT INTO auto_part_applicability (auto_part_id, ${колонка})
        SELECT id, ${цель} FROM auto_parts WHERE name LIKE ${`${начало}%`}`);
    };
    await пачка('Я-модель', 10, 'model');
    await пачка('М-тип', 10, 'type');
    await пачка('А-ничей', 40, null);

    const первая = await listPage({
      search: tag,
      vehicleId: ctx.vehicleWithModelId,
      pageSize: '50',
    });
    expect(первая.total, 'всего позиций подбора').toBe(60);
    expect(первая.items).toHaveLength(50);
    // Ранги идут ступенькой, без чересполосицы: 10 по модели, 10 по типу, остальное — хвостом.
    expect(первая.items.map((p) => p.applicabilityRank)).toEqual([
      ...Array<number>(10).fill(0),
      ...Array<number>(10).fill(1),
      ...Array<number>(30).fill(2),
    ]);
    // Внутри ранга — алфавит: второй ключ сортировки ранг не отменяет, а дополняет.
    expect(первая.items[0]!.name).toContain('Я-модель-001');
    expect(первая.items[10]!.name).toContain('М-тип-001');

    const вторая = await listPage({
      search: tag,
      vehicleId: ctx.vehicleWithModelId,
      page: '2',
      pageSize: '50',
    });
    expect(вторая.items).toHaveLength(10);
    expect(вторая.items.map((p) => p.applicabilityRank)).toEqual(Array<number>(10).fill(2));
    expect(вторая.items[0]!.name).toContain('А-ничей-031');

    // Без `vehicleId` ранга нет вовсе, и первая страница набирается алфавитом — обратным рангу.
    const алфавит = await listPage({ search: tag, pageSize: '50' });
    expect(алфавит.items[0]!.name).toContain('А-ничей-001');
    expect(алфавит.items[0]!.applicabilityRank).toBeUndefined();
    expect(алфавит.items.at(-1)!.name).toContain('М-тип-010');
  }, 60_000);

  it('машина без модели не ломает запрос: ранг считается одним типом', async () => {
    // `vehicles.vehicle_model_id` необязателен — в источнике есть машины без марки, и ветка модели
    // у такой машины в запрос не пишется вовсе. Отсюда же Р8: одной привязкой к моделям обойтись
    // нельзя, и вторая ось разметки заведена именно ради этого случая.
    const tag = `безмодели-${randomUUID().slice(0, 6)}`;
    const поТипу = await createPart({
      name: nextName(tag),
      applicability: [{ vehicleTypeId: ctx.typeNoModelId }],
    });
    // Размечена моделью ЧУЖОГО типа: ранга 0 у неё быть не может ни при каком прочтении запроса.
    const поЧужойМодели = await createPart({
      name: nextName(tag),
      applicability: [{ vehicleModelId: ctx.modelId }],
    });

    const page = await listPage({ search: tag, vehicleId: ctx.vehicleNoModelId });
    expect(page.items.map((p) => [p.id, p.applicabilityRank])).toEqual([
      [поТипу.id, 1],
      [поЧужойМодели.id, 2],
    ]);

    // Несуществующая машина — 400 словами, а не пятисоткой из пустого ранга.
    const res = await inject('GET', `/api/v1/auto-parts?vehicleId=${randomUUID()}`, ctx.admin.auth);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toContain('Машина не найдена');
  });

  // ── 10. Права: номенклатура и склад разведены (Р10) ──

  it('`manage` без `stock` не правит остаток и не заводит с ненулевым; `stock` без `manage` не ведёт номенклатуру', async () => {
    /*
     * Права два и они РАЗНЫЕ. Граница у заведения проведена по НУЛЮ, а не по «полю в теле»:
     * `quantity` приезжает умолчанием схемы и в теле есть всегда, а ноль — это отсутствие
     * утверждения о складе. Довод сильнее, чем кажется: ошибившись числом, держатель одного
     * `manage` свою ошибку НЕ ИСПРАВИТ — у карточки уже есть строка журнала, `DELETE` отобьёт
     * `RESTRICT`, а правка остатка потребует того самого права, которого у него нет.
     */
    const withZero = await createPart({ quantity: 0, auth: ctx.manageUser.auth });
    expect(withZero.quantity).toBe(0);

    const withStock = await postPart({ quantity: 4, auth: ctx.manageUser.auth });
    expect(withStock.statusCode, withStock.body).toBe(403);
    expect(withStock.json().message).toContain('нулевым остатком');

    const stockByManage = await postStock(
      withZero.id,
      { quantity: 4, expectedQuantity: 0, reason: 'привезли четыре' },
      ctx.manageUser.auth,
    );
    expect(stockByManage.statusCode, stockByManage.body).toBe(403);
    expect(stockByManage.json().message).toBe(STOCK_DENIED);

    // У кого только `stock`: остаток правит, номенклатуру не ведёт.
    const moved = await stockOk(
      withZero.id,
      { quantity: 4, expectedQuantity: 0, reason: 'привезли четыре' },
      ctx.stockUser.auth,
    );
    expect(moved.entry).not.toBeNull();
    expect(moved.entry!.quantityAfter).toBe(4);
    expect(moved.entry!.changedByName).not.toBe('');

    const nomenclature = await postPart({ auth: ctx.stockUser.auth });
    expect(nomenclature.statusCode, nomenclature.body).toBe(403);
    expect(nomenclature.json().message).toBe(MANAGE_DENIED);

    const patched = await patchPart(withZero.id, { comment: 'правка' }, ctx.stockUser.auth);
    expect(patched.statusCode, patched.body).toBe(403);
    expect(patched.json().message).toBe(MANAGE_DENIED);

    // `garage.read` только читает: склад виден всем, кому виден гараж (Р10), но не трогается никем.
    const seen = await detailOf(withZero.id, ctx.readUser.auth);
    expect(seen.quantity).toBe(4);
    expect(seen.stockEntries).toHaveLength(1);
    const denied = await postPart({ auth: ctx.readUser.auth });
    expect(denied.statusCode, denied.body).toBe(403);
    const deniedStock = await postStock(
      withZero.id,
      { quantity: 5, expectedQuantity: 4, reason: 'ещё один' },
      ctx.readUser.auth,
    );
    expect(deniedStock.statusCode, deniedStock.body).toBe(403);
  });
});
