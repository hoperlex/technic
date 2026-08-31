import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatOfficeEquipmentPurchaseNumber,
  OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES,
  type OfficeEquipmentConsumableDto,
  type OfficeEquipmentPurchaseDetailDto,
  type OfficeEquipmentPurchaseItemInput,
  type OfficeEquipmentPurchasePrefillDto,
  type OfficeEquipmentPurchaseStatus,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Плановая закупка расходников (ADR 0146, план
 * `docs/office-equipment-consumables-and-purchase-plan.md`: Р10, Р13, Р15–Р18; миграции `0227` и
 * `0228`; маршруты `routes/office-equipment-purchases.ts` и правки
 * `routes/office-equipment-consumables.ts`).
 *
 * ЗАЧЕМ БАЗА, А НЕ МОКИ. Главное обещание закупки — «двое, открывшие форму на одном „к закупке 10“,
 * не закажут двадцать молча» — не живёт ни в одной строке маршрута по отдельности: его держат
 * `SELECT … FOR UPDATE` по строкам расходников, повторное чтение под блокировкой, условная запись
 * с `ROW_COUNT` и уникальное ограничение ключа идемпотентности. Всё это — свойства ПАРЫ
 * транзакций, и на моках проверяются только моки.
 *
 * ГЛАВНАЯ ЧАСТЬ ФАЙЛА — ВТОРАЯ («гонки и повторы»), и она написана так, чтобы гонка была
 * настоящей: соседнее соединение берёт строку `FOR UPDATE` и держит её, обе двери приходят в это
 * окно и обязаны встать в очередь НА СТРОКЕ, что проверяется через `pg_blocking_pids` и
 * `wait_event` (приём взят у `auto-parts.db.test.ts` и `office-equipment-consumables.db.test.ts`).
 * Гонка, проверенная последовательными вызовами, — это не гонка: второй запрос прочитал бы уже
 * новое состояние и получил бы тот же отказ, не постояв ни на одной блокировке, то есть зеленел бы
 * и на коде без блокировок вовсе.
 *
 * ПОРЯДОК ШАГОВ Р17 ПРОВЕРЯЕТСЯ ОТДЕЛЬНЫМ СЛУЧАЕМ, и это не педантизм: план дважды ошибся именно
 * на нём. Ключ идемпотентности спрашивается ДО сверки снимка — потому что при потерянном ответе
 * созданная закупка САМА подняла «уже заказано», и повтор, дойдя сперва до сверки, получил бы 409
 * ровно в том случае, ради которого ключ и заводится. Случай «повтор после того, как закупка
 * подняла alreadyOrdered» краснеет на перестановке этих двух шагов и ни на чём другом.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: по общей параллельно идут другие прогоны, а здесь
 * половина утверждений — про ТОЧНЫЕ числа («закупок в базе одна», «событие заведения ровно одно»,
 * «уже заказано равно четырём»), и чужая строка в тех же таблицах сделала бы их ложными. База
 * заводится, мигрируется с нуля и сносится в `afterAll`.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run apps/api/test/office-equipment-purchases.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_oe_purchases_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);
const CODE_RUN = RUN.toUpperCase();
const PASSWORD = 'db-purchase-password-123';

const PURCHASES = '/api/v1/office-equipment-purchases';
const CONSUMABLES = '/api/v1/office-equipment-consumables';

/** Сколько соединение файла готово ждать чужую блокировку, прежде чем упасть текстом. */
const LOCK_TIMEOUT_MS = 8_000;
/** Сколько ждём, пока запрос встанет в очередь: барьер, а не пауза «на глазок». */
const QUEUE_TIMEOUT_MS = 15_000;

/** Тексты стражей: по ним видно, КАКОЙ из двух отказал, а не просто «403». */
const PURCHASE_DENIED = 'Плановые закупки расходников ведёт ответственный за них';
const NOMENCLATURE_DENIED = 'Номенклатуру расходников ведёт ответственный за неё';

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
  /** Администратор: у его роли есть весь словарь прав целиком — им заводятся декорации. */
  admin: TestUser;
  /**
   * Держатель `officeEquipmentPurchases.manage` — системным набором «Оргтехника: ведение», как в
   * жизни. Номенклатуры и остатка он не ведёт: ими правит соседний набор, и именно это разводит
   * два права Р12 и Р13 порознь.
   */
  purchaser: TestUser;
  /**
   * Держатель `officeEquipmentConsumables.manage` и `.stock` — набором «Оргтехника: номенклатура».
   * Потребность правит он; закупку не заводит вовсе.
   */
  keeper: TestUser;
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
  process.env.MAIL_ENABLED ??= 'false';
}

/** Свой адрес на каждое обращение: общий ограничитель считает запросы с адреса (`app.ts`). */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

let codeNo = 0;
function nextCode(): string {
  codeNo += 1;
  return `ЗКП${CODE_RUN}${String(codeNo).padStart(3, '0')}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method,
    url,
    headers: { ...auth, ...headers },
    remoteAddress: nextAddress(),
    ...(payload === undefined ? {} : { payload }),
  });
}

// ── Ручки справочника расходников ──

interface ConsumableInput {
  quantity?: number;
  requiredQuantity?: number;
  isActive?: boolean;
  name?: string;
  auth?: Auth;
}

let consumableNo = 0;

/**
 * Позиция номенклатуры. Заводится администратором: разведение прав — предмет отдельных случаев, а
 * здесь позиция нужна декорацией, и отказ по праву в середине фикстуры читался бы как отказ по делу.
 */
async function createConsumable(
  input: ConsumableInput = {},
): Promise<OfficeEquipmentConsumableDto> {
  consumableNo += 1;
  const res = await inject('POST', CONSUMABLES, input.auth ?? ctx.admin.auth, {
    code: nextCode(),
    name: input.name ?? `Тонер закупочный ${RUN} №${consumableNo} (шт)`,
    quantity: input.quantity ?? 0,
    requiredQuantity: input.requiredQuantity ?? 0,
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentConsumableDto;
}

function patchConsumable(id: string, body: Record<string, unknown>, auth?: Auth) {
  return inject('PATCH', `${CONSUMABLES}/${id}`, auth ?? ctx.keeper.auth, body);
}

/** Правка остатка — своей ручкой со сверкой «того, что человек видел» (Р7 плана расходников). */
async function setStock(id: string, quantity: number, expected: number): Promise<void> {
  const res = await inject('POST', `${CONSUMABLES}/${id}/stock`, ctx.keeper.auth, {
    quantity,
    expectedQuantity: expected,
    reason: 'сверка склада перед закупкой',
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Строка перечня расходников — вторая дверь к тем же «уже заказано» и «дефицит» (Р15). */
async function consumableRow(id: string): Promise<OfficeEquipmentConsumableDto> {
  const res = await inject('GET', `${CONSUMABLES}/${id}`, ctx.admin.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OfficeEquipmentConsumableDto;
}

// ── Ручки закупки ──

async function prefill(auth?: Auth): Promise<OfficeEquipmentPurchasePrefillDto> {
  const res = await inject('GET', `${PURCHASES}/prefill`, auth ?? ctx.purchaser.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OfficeEquipmentPurchasePrefillDto;
}

interface PostOptions {
  key?: string;
  comment?: string;
  auth?: Auth;
}

/**
 * `POST` заведения. Ключ идемпотентности обязателен (Р17), и по умолчанию он свой на каждый вызов:
 * ключ описывает ПОПЫТКУ ОТПРАВКИ, и переиспользовать его молча значило бы проверять повтор там,
 * где его не задумывали.
 */
function postPurchase(items: OfficeEquipmentPurchaseItemInput[], options: PostOptions = {}) {
  return inject(
    'POST',
    PURCHASES,
    options.auth ?? ctx.purchaser.auth,
    { items, ...(options.comment === undefined ? {} : { comment: options.comment }) },
    { 'idempotency-key': options.key ?? randomUUID() },
  );
}

async function createPurchase(
  items: OfficeEquipmentPurchaseItemInput[],
  options: PostOptions = {},
): Promise<OfficeEquipmentPurchaseDetailDto> {
  const res = await postPurchase(items, options);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentPurchaseDetailDto;
}

function patchPurchase(
  id: string,
  body: { contentVersion: number; items: OfficeEquipmentPurchaseItemInput[]; comment?: string },
  auth?: Auth,
) {
  return inject('PATCH', `${PURCHASES}/${id}`, auth ?? ctx.purchaser.auth, body);
}

function submitPurchase(id: string, expectedVersion: number, auth?: Auth) {
  return inject('POST', `${PURCHASES}/${id}/submit`, auth ?? ctx.purchaser.auth, {
    expectedVersion,
  });
}

function closePurchase(id: string, auth?: Auth) {
  return inject('POST', `${PURCHASES}/${id}/close`, auth ?? ctx.purchaser.auth, {
    stockReceiptConfirmed: true,
  });
}

function cancelPurchase(id: string, reason = 'передумали закупать', auth?: Auth) {
  return inject('POST', `${PURCHASES}/${id}/cancel`, auth ?? ctx.purchaser.auth, { reason });
}

async function purchaseDetail(id: string): Promise<OfficeEquipmentPurchaseDetailDto> {
  const res = await inject('GET', `${PURCHASES}/${id}`, ctx.purchaser.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OfficeEquipmentPurchaseDetailDto;
}

/** Провести и закрыть — двумя законными ходами, а не `UPDATE` мимо маршрута. */
async function submitAndClose(purchase: OfficeEquipmentPurchaseDetailDto): Promise<void> {
  const submitted = await submitPurchase(purchase.id, purchase.contentVersion);
  expect(submitted.statusCode, submitted.body).toBe(200);
  const closed = await closePurchase(purchase.id);
  expect(closed.statusCode, closed.body).toBe(200);
}

// ── Состояние базы прямым SQL ──
//
// Прямым, а не выражениями drizzle: коррелированный подзапрос в односоставном запросе тихо
// переписывается в сравнение колонок собственной таблицы и всегда даёт «ничего нет» (разбор — в
// `office-equipment-sql-correlation.test.ts`). Проверка, написанная тем же приёмом, что и предмет
// проверки, зеленела бы на любом состоянии базы.

/** То, из чего складывается «к закупке» у позиции: три слагаемых Р15, спрошенные своим запросом. */
interface Snapshot {
  required: number;
  stock: number;
  alreadyOrdered: number;
}

async function stateOf(consumableId: string, exceptPurchaseId?: string): Promise<Snapshot> {
  const res = await ctx.db.execute<{ required: number; stock: number; ordered: number }>(sql`
    SELECT c.required_quantity AS required,
           c.quantity AS stock,
           coalesce((SELECT sum(i.quantity)
                       FROM office_equipment_purchase_items i
                       JOIN office_equipment_purchases p ON p.id = i.purchase_id
                      WHERE i.consumable_id = c.id
                        AND p.status IN ('new', 'in_work')
                        ${
                          exceptPurchaseId === undefined
                            ? sql.empty()
                            : sql`AND p.id <> ${exceptPurchaseId}`
                        }), 0)::int AS ordered
      FROM office_equipment_consumables c
     WHERE c.id = ${consumableId}`);
  const row = res.rows[0];
  if (!row) throw new Error(`позиции ${consumableId} нет в базе`);
  return { required: row.required, stock: row.stock, alreadyOrdered: Number(row.ordered) };
}

/**
 * Строка отправки со СВЕЖИМ снимком: три ожидаемых числа берутся из базы прямо сейчас.
 *
 * `exceptPurchaseId` — для правки черновика (Р18): собственный вклад правимой закупки из «уже
 * заказано» вычитается и сервером, и здесь, иначе первая же правка конфликтовала бы сама с собой.
 */
async function freshItem(
  consumableId: string,
  quantity: number,
  exceptPurchaseId?: string,
): Promise<OfficeEquipmentPurchaseItemInput> {
  const s = await stateOf(consumableId, exceptPurchaseId);
  return {
    consumableId,
    quantity,
    expectedRequired: s.required,
    expectedStock: s.stock,
    expectedAlreadyOrdered: s.alreadyOrdered,
  };
}

interface PurchaseRow {
  num: number;
  status: OfficeEquipmentPurchaseStatus;
  contentVersion: number;
  createdBy: string;
  submittedBy: string | null;
  closedBy: string | null;
  cancelledBy: string | null;
  cancelReason: string;
  idempotencyKey: string;
}

async function purchaseRow(id: string): Promise<PurchaseRow> {
  const res = await ctx.db.execute<{
    num: number;
    status: OfficeEquipmentPurchaseStatus;
    content_version: number;
    created_by: string;
    submitted_by: string | null;
    closed_by: string | null;
    cancelled_by: string | null;
    cancel_reason: string;
    idempotency_key: string;
  }>(sql`
    SELECT num, status, content_version, created_by, submitted_by, closed_by, cancelled_by,
           cancel_reason, idempotency_key
      FROM office_equipment_purchases WHERE id = ${id}`);
  const row = res.rows[0];
  if (!row) throw new Error(`закупки ${id} нет в базе`);
  return {
    num: row.num,
    status: row.status,
    contentVersion: row.content_version,
    createdBy: row.created_by,
    submittedBy: row.submitted_by,
    closedBy: row.closed_by,
    cancelledBy: row.cancelled_by,
    cancelReason: row.cancel_reason,
    idempotencyKey: row.idempotency_key,
  };
}

/** Сколько закупок завёл этот ключ: «повтор не размножает документ» — это про число строк. */
async function purchasesByKey(actorId: string, key: string): Promise<string[]> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    SELECT id FROM office_equipment_purchases
     WHERE created_by = ${actorId} AND idempotency_key = ${key}`);
  return res.rows.map((r) => r.id);
}

/** Сколько закупок вообще есть по этой позиции — независимо от состояния. */
async function purchasesTouching(consumableId: string): Promise<string[]> {
  const res = await ctx.db.execute<{ id: string }>(sql`
    SELECT DISTINCT purchase_id AS id FROM office_equipment_purchase_items
     WHERE consumable_id = ${consumableId}`);
  return res.rows.map((r) => r.id);
}

async function auditCount(action: string, entityId: string): Promise<number> {
  const res = await ctx.db.execute<{ c: number }>(sql`
    SELECT count(*)::int AS c FROM audit_log
     WHERE action = ${action} AND entity_id = ${entityId}`);
  return res.rows[0]!.c;
}

async function lastAudit(
  action: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  const res = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
    SELECT metadata FROM audit_log
     WHERE action = ${action} AND entity_id = ${entityId}
     ORDER BY created_at DESC LIMIT 1`);
  return res.rows[0]?.metadata ?? null;
}

/**
 * Отказ базы, разобранный так же, как его разбирает сервер: drizzle оборачивает ошибку драйвера в
 * свою, и код с именем ограничения лежат не на верхнем объекте, а в `cause` (`pgErrorOf`). Прямая
 * проверка `e.constraint` молча не сработала бы — и тест зеленел бы на любой другой ошибке.
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

// ── Соединения для гонок ──

/** Отдельное соединение с пределом ожидания: зависший прогон читается как «сломался тест». */
async function openClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: OWN_DB });
  await client.connect();
  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  return client;
}

/** Соединение-наблюдатель: только опрос очередей, ни одной блокировки за собой. */
async function openProbe(): Promise<pg.Client> {
  const probe = new pg.Client({ connectionString: OWN_DB });
  await probe.connect();
  return probe;
}

/**
 * Запрос, вставший в очередь за этим бэкендом: кто (`pid`), с чем (`query`) и НА ЧЁМ он ждёт
 * (`waitEvent`).
 *
 * Третье поле — половина проверки: `transactionid` означает, что запрос ждёт чужую СТРОКУ, то есть
 * дошёл до блокировки и встал на ней. Ответ «дождались» без этого различения одинаков для рабочего
 * и сломанного кода — очередь-то образуется в обоих случаях, только на разных замках.
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

async function oneQueuedBehind(
  probe: pg.Client,
  pid: number,
  what: string,
  expected?: RegExp,
): Promise<Waiter> {
  return (await queuedBehind(probe, pid, what, expected))[0]!;
}

/**
 * Имя таблицы в маске ожидания — С КАВЫЧКАМИ ИЛИ БЕЗ: drizzle кавычит имена всегда, сырой SQL
 * пробы — так, как набран в тесте. Маска, собранная под один вид, под другой не подойдёт никогда, и
 * случай краснеет не там, где ошибка.
 */
function таблица(имя: string): string {
  return `"?${имя}"?`;
}

/** Блокирующее чтение расходников — шаг 3 протокола Р17, тот самый, на котором строится очередь. */
const LOCK_CONSUMABLES = new RegExp(`${таблица('office_equipment_consumables')}.+for update`, 'is');
/** Условная запись перехода — шаги «Закрыть» и «Отменить» (Р10). */
const UPDATE_PURCHASE = new RegExp(`update ${таблица('office_equipment_purchases')}`, 'is');
/** Вставка шапки: на ней встречаются два запроса с одним ключом и разными позициями (Р17, шаг 8). */
const INSERT_PURCHASE = new RegExp(`insert into ${таблица('office_equipment_purchases')}`, 'is');

async function backendPid(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]!.pid;
}

describe.skipIf(!DB_URL)(
  'плановая закупка расходников: цикл, потребность и протокол сохранения',
  () => {
    beforeAll(async () => {
      /*
       * СВОЯ БАЗА С НУЛЯ. Первые миграции требуют расширений, которых в свежей базе нет вовсе
       * (`pgcrypto` для `gen_random_uuid`, `citext` для адреса учётки, `pg_trgm` для поиска), — их
       * ставим до журнала миграций, а не надеемся на образ.
       */
      const admin = new pg.Client({ connectionString: ADMIN_DB });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
        await admin.query(`CREATE DATABASE ${OWN_DB_NAME}`);
      } finally {
        await admin.end();
      }
      const client = new pg.Client({ connectionString: OWN_DB });
      await client.connect();
      try {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query('CREATE EXTENSION IF NOT EXISTS citext');
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        await applyMigrations(client);
      } finally {
        await client.end();
      }

      prepareEnv(OWN_DB!);
      const { db, closeDb } = await import('../src/db/client');
      const { hashPassword } = await import('../src/auth/password');
      const { buildApp } = await import('../src/app');
      const passwordHash = await hashPassword(PASSWORD);

      async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
        const email = `db-oep-${tag}-${RUN}@example.invalid`;
        const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
        return { id: res.rows[0]!.id, email };
      }

      const adminUser = await makeUser('admin', 'admin');
      /*
       * Оба носителя прав — роли `shtab`: у неё есть `officeEquipment.read` (справочник открыт
       * широким правом) и нет ни ведения модуля, ни номенклатуры. Значит разницу в ответах даёт
       * ровно выданный НАБОР, а не роль, — и «403 без права» не превращается в «403 из-за роли».
       */
      const purchaser = await makeUser('purchaser', 'shtab');
      const keeper = await makeUser('keeper', 'shtab');

      /*
       * Наборы — СИСТЕМНЫЕ, те самые, что раздаёт администратор (`0228` и план расходников), а не
       * собранные тестом из одного права. Собранный набор проверял бы страж маршрута, но не
       * проверял бы состав системного набора: уедь `officeEquipmentPurchases.manage` из «Оргтехники:
       * ведение» — и портал остался бы без единого держателя, а файл этого бы не заметил.
       */
      async function grantByCode(userId: string, code: string): Promise<void> {
        const res = await db.execute<{ id: string }>(
          sql`SELECT id FROM grants WHERE code = ${code} AND deleted_at IS NULL`,
        );
        const grantId = res.rows[0]?.id;
        if (!grantId) throw new Error(`в базе нет системного набора «${code}»`);
        await db.execute(sql`
        INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
        VALUES (${userId}, ${grantId}, ${adminUser.id}, 'manual')`);
      }
      await grantByCode(purchaser.id, 'office_equipment_operator');
      await grantByCode(keeper.id, 'office_equipment_consumables');

      const app = await buildApp();
      await app.ready();

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
        admin: await withAuth(adminUser),
        purchaser: await withAuth(purchaser),
        keeper: await withAuth(keeper),
      };
    }, 180_000);

    afterAll(async () => {
      // База своя — уносим её целиком, а не выковыриваем фикстуры по суффиксу: чужих строк в ней нет
      // по построению, и оставленная база помешала бы следующему прогону завести её заново.
      await ctx?.app?.close();
      await ctx?.closeDb?.();
      if (!ADMIN_DB) return;
      const admin = new pg.Client({ connectionString: ADMIN_DB });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${OWN_DB_NAME}`);
      } finally {
        await admin.end();
      }
    }, 60_000);

    // ── 1. Потребность (Р13) ──

    describe('потребность позиции', () => {
      it('право обязательно: держатель закупок правит закупки, а не номенклатуру', async () => {
        const c = await createConsumable({ requiredQuantity: 5 });
        // У держателя «Оргтехники: ведение» есть закупка и нет номенклатуры — ровно то разделение,
        // ради которого Р13 отдал потребность набору номенклатуры, а не тому, кто заказывает.
        const denied = await patchConsumable(c.id, { requiredQuantity: 9 }, ctx.purchaser.auth);
        expect(denied.statusCode, denied.body).toBe(403);
        expect(denied.json().message).toBe(NOMENCLATURE_DENIED);
        expect((await consumableRow(c.id)).requiredQuantity).toBe(5);

        const ok = await patchConsumable(c.id, { requiredQuantity: 9 });
        expect(ok.statusCode, ok.body).toBe(200);
        expect((await consumableRow(c.id)).requiredQuantity).toBe(9);
      });

      it('отрицательная потребность отбита схемой, а не записана нулём', async () => {
        const c = await createConsumable({ requiredQuantity: 4 });
        const res = await patchConsumable(c.id, { requiredQuantity: -2 });
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().fields.requiredQuantity).toContain('не бывает отрицательной');
        expect((await consumableRow(c.id)).requiredQuantity).toBe(4);

        // И то же правило держит база — на случай скрипта мимо маршрута: своего журнала у
        // потребности нет (Р13), значит единственная защита числа здесь — `CHECK`.
        const refusal = await dbRefusal(
          ctx.db.execute(
            sql`UPDATE office_equipment_consumables SET required_quantity = -1 WHERE id = ${c.id}`,
          ),
        );
        expect(refusal.code).toBe('23514');
        expect(refusal.constraint).toBe('office_equipment_consumables_required_check');
      });

      it('правка потребности попадает в аудит карточки — своего журнала у неё нет', async () => {
        const c = await createConsumable({ requiredQuantity: 0 });
        const res = await patchConsumable(c.id, { requiredQuantity: 17 });
        expect(res.statusCode, res.body).toBe(200);

        const metadata = await lastAudit('officeEquipmentConsumable.update', c.id);
        expect(metadata, 'правка потребности не попала в журнал').not.toBeNull();
        expect(metadata!.requiredQuantity).toBe(17);
      });
    });

    // ── 2. Предзаполнение формы (Р13, Р15, Р16) ──

    describe('предзаполнение', () => {
      it('позиции с нулевой потребностью, погашенные и без дефицита в форму не попадают', async () => {
        const нужная = await createConsumable({ requiredQuantity: 10, quantity: 2 });
        const неследим = await createConsumable({ requiredQuantity: 0, quantity: 0 });
        const погашенная = await createConsumable({
          requiredQuantity: 7,
          quantity: 0,
          isActive: false,
        });
        const хватает = await createConsumable({ requiredQuantity: 5, quantity: 9 });

        const rows = (await prefill()).rows;
        const byId = new Map(rows.map((r) => [r.consumableId, r]));

        const строка = byId.get(нужная.id);
        expect(строка, 'позиция с дефицитом не предложена').toBeDefined();
        expect(строка!.required).toBe(10);
        expect(строка!.stock).toBe(2);
        expect(строка!.alreadyOrdered).toBe(0);
        expect(строка!.suggested).toBe(8);

        // Ноль потребности означает «не следим»: предложи форма такую позицию, она звала бы заказать
        // всё, чего нет на складе, включая то, что сознательно не держат.
        expect(byId.has(неследим.id), 'позиция с нулевой потребностью попала в форму').toBe(false);
        // Гашение означает «больше не покупаем», и закупка погашенного — забытая галочка, а не заказ.
        expect(byId.has(погашенная.id), 'погашенная позиция попала в форму').toBe(false);
        // Заказывать нечего: строка с нулём читалась бы как «закажите ноль».
        expect(byId.has(хватает.id), 'позиция без дефицита попала в форму').toBe(false);
      });

      it('«уже заказано» вычитается из дефицита, а закрытая закупка перестаёт вычитаться', async () => {
        const c = await createConsumable({ requiredQuantity: 10, quantity: 0 });
        const строкой = async () => (await prefill()).rows.find((r) => r.consumableId === c.id);

        expect((await строкой())!.suggested).toBe(10);

        const purchase = await createPurchase([await freshItem(c.id, 4)]);
        const сЗаказом = (await строкой())!;
        expect(сЗаказом.alreadyOrdered, 'открытая закупка не вычлась из дефицита').toBe(4);
        expect(сЗаказом.suggested).toBe(6);
        // Одного вычитания мало: вторая открытая закупка законна, и человек обязан ВИДЕТЬ, что заказ
        // уже идёт, — со ссылкой на ту самую бумагу.
        expect(сЗаказом.openPurchases).toHaveLength(1);
        expect(сЗаказом.openPurchases[0]!.displayNumber).toBe(purchase.displayNumber);
        expect(сЗаказом.openPurchases[0]!.quantity).toBe(4);

        // Вторая дверь к тем же числам — перечень расходников. Считает их один вычислитель (Р15), и
        // это проверяется тем, что обе двери отвечают одно и то же.
        const карточка = await consumableRow(c.id);
        expect(карточка.alreadyOrdered).toBe(4);
        expect(карточка.deficit).toBe(6);

        // «В работе» — всё ещё открытая: бумага у снабжения, и второй заказ на то же считался бы
        // поверх первого.
        const submitted = await submitPurchase(purchase.id, purchase.contentVersion);
        expect(submitted.statusCode, submitted.body).toBe(200);
        expect((await строкой())!.alreadyOrdered).toBe(4);

        // Закрытая перестаёт вычитаться — и потому Р11 требует заносить приход ДО закрытия: остаток
        // тест не двигал, и дефицит честно вернулся к десяти.
        const closed = await closePurchase(purchase.id);
        expect(closed.statusCode, closed.body).toBe(200);
        const послеЗакрытия = (await строкой())!;
        expect(послеЗакрытия.alreadyOrdered).toBe(0);
        expect(послеЗакрытия.suggested).toBe(10);
        expect(послеЗакрытия.openPurchases).toHaveLength(0);
      });

      it('отменённая закупка тоже перестаёт вычитаться', async () => {
        const c = await createConsumable({ requiredQuantity: 6, quantity: 0 });
        const purchase = await createPurchase([await freshItem(c.id, 6)]);
        expect((await stateOf(c.id)).alreadyOrdered).toBe(6);

        const cancelled = await cancelPurchase(purchase.id, 'позицию сняли с закупки');
        expect(cancelled.statusCode, cancelled.body).toBe(200);
        const row = (await prefill()).rows.find((r) => r.consumableId === c.id);
        expect(row!.alreadyOrdered).toBe(0);
        expect(row!.suggested).toBe(6);
      });
    });

    // ── 3. Заведение и коридор состояний (Р10, Р12, Р16) ──

    describe('заведение', () => {
      it('заводит держатель права; у ведущего номенклатуру закупок нет вовсе', async () => {
        const c = await createConsumable({ requiredQuantity: 8, quantity: 1 });
        const item = await freshItem(c.id, 7);

        // У «Оргтехники: номенклатуры» есть и справочник, и остаток, и потребность — и ни одной
        // двери к закупке: видимость документа по праву, а не по области (Р12).
        const denied = await postPurchase([item], { auth: ctx.keeper.auth });
        expect(denied.statusCode, denied.body).toBe(403);
        expect(denied.json().message).toBe(PURCHASE_DENIED);
        for (const url of [PURCHASES, `${PURCHASES}/prefill`]) {
          const res = await inject('GET', url, ctx.keeper.auth);
          expect(res.statusCode, `${url}: ${res.body}`).toBe(403);
        }
        expect(await purchasesTouching(c.id)).toHaveLength(0);

        const purchase = await createPurchase([item], { comment: 'на третий квартал' });
        expect(purchase.status).toBe('new');
        expect(purchase.contentVersion).toBe(1);
        expect(purchase.comment).toBe('на третий квартал');
        expect(purchase.displayNumber).toBe(formatOfficeEquipmentPurchaseNumber(purchase.num));
        expect(purchase.items).toHaveLength(1);
        // Строка хранит СНИМОК расчёта, а не только количество: без него через месяц на вопрос
        // «почему заказали семь» ответить нечем — потребность плавающая (Р13).
        expect(purchase.items[0]!.requiredSnapshot).toBe(8);
        expect(purchase.items[0]!.stockSnapshot).toBe(1);
        expect(purchase.items[0]!.alreadyOrderedSnapshot).toBe(0);
        expect(purchase.items[0]!.suggestedQuantity).toBe(7);
        expect(purchase.items[0]!.quantity).toBe(7);
        expect((await purchaseRow(purchase.id)).createdBy).toBe(ctx.purchaser.id);
      });

      it('пустая закупка не заводится, и ключ отправки обязателен', async () => {
        const empty = await postPurchase([]);
        expect(empty.statusCode, empty.body).toBe(400);
        expect(JSON.stringify(empty.json().fields)).toContain('пустая закупка не заводится');

        // Ключ обязателен, а не «если прислали»: ручка новая, legacy-клиентов у неё нет, и
        // необязательный ключ означал бы, что защита работает у тех, кто её попросил (Р17).
        const c = await createConsumable({ requiredQuantity: 3, quantity: 0 });
        const noKey = await inject('POST', PURCHASES, ctx.purchaser.auth, {
          items: [await freshItem(c.id, 3)],
        });
        expect(noKey.statusCode, noKey.body).toBe(400);
        expect(noKey.json().message).toContain('Idempotency-Key');
        expect(await purchasesTouching(c.id)).toHaveLength(0);
      });

      it('погашенную позицию не добавить в закупку даже руками', async () => {
        const c = await createConsumable({ requiredQuantity: 5, quantity: 0, isActive: false });
        const res = await postPurchase([await freshItem(c.id, 5)]);
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().message).toContain('погашена');
        expect(await purchasesTouching(c.id)).toHaveLength(0);
      });
    });

    describe('коридор состояний', () => {
      it('new → in_work → closed, а из «Закрытой» отмены нет', async () => {
        const c = await createConsumable({ requiredQuantity: 12, quantity: 0 });
        const purchase = await createPurchase([await freshItem(c.id, 12)]);

        // Закрыть «Новую» нельзя: закрытие — это подтверждение прихода по бумаге, которой у
        // снабжения ещё нет.
        const рано = await closePurchase(purchase.id);
        expect(рано.statusCode, рано.body).toBe(409);
        expect(рано.json().code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.status);
        expect(рано.json().details.status).toBe('new');

        const submitted = await submitPurchase(purchase.id, purchase.contentVersion);
        expect(submitted.statusCode, submitted.body).toBe(200);
        const вРаботе = submitted.json() as OfficeEquipmentPurchaseDetailDto;
        expect(вРаботе.status).toBe('in_work');
        expect(вРаботе.submittedAt).not.toBeNull();
        expect(вРаботе.submittedByName).not.toBeNull();

        const closed = await closePurchase(purchase.id);
        expect(closed.statusCode, closed.body).toBe(200);
        const закрытая = closed.json() as OfficeEquipmentPurchaseDetailDto;
        expect(закрытая.status).toBe('closed');
        expect(закрытая.closedAt).not.toBeNull();
        expect((await purchaseRow(purchase.id)).closedBy).toBe(ctx.purchaser.id);

        // Закрытая и отменённая — конечные: ошибку исправляют НОВОЙ закупкой, а не переписыванием
        // прошлой, и административного отката на альфе нет вовсе.
        const поздно = await cancelPurchase(purchase.id, 'закрыли по ошибке');
        expect(поздно.statusCode, поздно.body).toBe(409);
        expect(поздно.json().code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.status);
        expect(поздно.json().details.status).toBe('closed');
        expect((await purchaseRow(purchase.id)).status).toBe('closed');
        expect((await purchaseRow(purchase.id)).cancelReason).toBe('');
      });

      it('отмена возможна из «Новой» и из «В работе», причина обязательна', async () => {
        const c = await createConsumable({ requiredQuantity: 20, quantity: 0 });

        const короткая = await cancelPurchase(
          (await createPurchase([await freshItem(c.id, 5)])).id,
          'ой',
        );
        expect(короткая.statusCode, короткая.body).toBe(400);
        expect(JSON.stringify(короткая.json().fields)).toContain('причину отмены');

        const изНовой = await createPurchase([await freshItem(c.id, 3)]);
        const первая = await cancelPurchase(изНовой.id, 'позиция нашлась на складе');
        expect(первая.statusCode, первая.body).toBe(200);
        const отменённая = первая.json() as OfficeEquipmentPurchaseDetailDto;
        expect(отменённая.status).toBe('cancelled');
        expect(отменённая.cancelReason).toBe('позиция нашлась на складе');
        // Отменённая ИЗ «Новой» проведения не проходила — пара проведения обязана остаться пустой.
        expect(отменённая.submittedAt).toBeNull();

        const изРаботы = await createPurchase([await freshItem(c.id, 3)]);
        const проведена = await submitPurchase(изРаботы.id, изРаботы.contentVersion);
        expect(проведена.statusCode, проведена.body).toBe(200);
        const вторая = await cancelPurchase(изРаботы.id, 'снабжение вернуло бумагу');
        expect(вторая.statusCode, вторая.body).toBe(200);
        // А отменённая ИЗ «В работе» проведение проходила, и `CHECK` пары проведения у отменённой
        // ослаблен именно ради этих двух законных случаев сразу.
        expect((вторая.json() as OfficeEquipmentPurchaseDetailDto).submittedAt).not.toBeNull();

        const повторно = await submitPurchase(изРаботы.id, изРаботы.contentVersion);
        expect(повторно.statusCode, повторно.body).toBe(409);
        expect(повторно.json().details.status).toBe('cancelled');
      });
    });

    // ── 4. Границы позиции: удаление и гашение (Р18) ──

    describe('позиция, попавшая в закупку', () => {
      it('RESTRICT не даёт удалить позицию со строкой закупки', async () => {
        // Остаток нулевой и журнала у позиции нет: иначе удаление отбил бы собственный отказ
        // маршрута («по расходнику есть движение»), и случай проверял бы не ту защиту.
        const c = await createConsumable({ requiredQuantity: 4, quantity: 0 });
        const purchase = await createPurchase([await freshItem(c.id, 4)]);

        const refusal = await dbRefusal(
          ctx.db.execute(sql`DELETE FROM office_equipment_consumables WHERE id = ${c.id}`),
        );
        expect(refusal.code).toBe('23503');
        expect(refusal.constraint).toBe('office_equipment_purchase_items_consumable_id_fkey');

        // И та же ссылка запирает удаление из портала — но человеку об этом говорит МАРШРУТ, а не
        // база: до правки этого выпуска наружу летела пятисотка от нарушения ключа, то есть человек
        // видел аварию там, где соседнее гашение той же позиции честно называет номер. Дефект был
        // тихий — учёт он не ломал, ломал объяснение, — и нашли его эти тесты, а не работа портала.
        const res = await inject('DELETE', `${CONSUMABLES}/${c.id}`, ctx.keeper.auth);
        expect(res.statusCode, res.body).toBe(409);
        // Номер в тексте по той же причине, что и у гашения: человеку нужен документ, в который
        // идти смотреть, а не сообщение «позиция участвует в закупке».
        expect(res.json().message).toContain(purchase.displayNumber);
        expect((await consumableRow(c.id)).id).toBe(c.id);
        expect((await purchaseDetail(purchase.id)).items).toHaveLength(1);

        // Статус закупки проверке не важен: `RESTRICT` не знает статусов, и закрытая держит позицию
        // так же крепко, как открытая, — в отличие от гашения, которое спорит только с открытой.
        await submitAndClose(purchase);
        const послеЗакрытия = await inject('DELETE', `${CONSUMABLES}/${c.id}`, ctx.keeper.auth);
        expect(послеЗакрытия.statusCode, послеЗакрытия.body).toBe(409);
        expect(послеЗакрытия.json().message).toContain(purchase.displayNumber);
      });

      it('гашение позиции с открытой закупкой отбито — с номером «ЗК-N» в тексте', async () => {
        const c = await createConsumable({ requiredQuantity: 9, quantity: 0 });
        const purchase = await createPurchase([await freshItem(c.id, 9)]);

        const denied = await patchConsumable(c.id, { isActive: false });
        expect(denied.statusCode, denied.body).toBe(409);
        // НОМЕР В ТЕКСТЕ И ЕСТЬ ОТВЕТ: «позиция участвует в закупке» человеку делать нечего — ему
        // надо открыть именно эту бумагу и решить, закрыть её или отменить.
        expect(denied.json().message).toContain(purchase.displayNumber);
        expect(denied.json().fields.isActive).toContain(purchase.displayNumber);
        expect((await consumableRow(c.id)).isActive).toBe(true);

        // Правка соседних полей при этом не запрещена: отбивается ПЕРЕХОД в погашенное, а не всякое
        // обращение к карточке с открытой закупкой.
        const комментарий = await patchConsumable(c.id, { comment: 'закупаем раз в полгода' });
        expect(комментарий.statusCode, комментарий.body).toBe(200);

        await submitAndClose(purchase);
        const ok = await patchConsumable(c.id, { isActive: false });
        expect(ok.statusCode, ok.body).toBe(200);
        expect((await consumableRow(c.id)).isActive).toBe(false);
      });
    });

    // ── 5. Инварианты шапки держит база, а не порядок вызовов (Р10) ──

    describe('инварианты шапки прямым UPDATE мимо маршрута', () => {
      it('закрытая без closed_by, отменённая без причины и «Новая» с проведением отбиты', async () => {
        const c = await createConsumable({ requiredQuantity: 15, quantity: 0 });
        const новая = await createPurchase([await freshItem(c.id, 5)]);
        const вРаботе = await createPurchase([await freshItem(c.id, 5)]);
        const проведена = await submitPurchase(вРаботе.id, вРаботе.contentVersion);
        expect(проведена.statusCode, проведена.body).toBe(200);

        /*
         * КАЖДЫЙ `UPDATE` НАРУШАЕТ РОВНО ОДНО ПРАВИЛО, и это условие осмысленности случая: сломай
         * запись сразу два, имя сработавшего ограничения выбирал бы Postgres, а не мы, — и проверка
         * «отбито тем самым правилом» превратилась бы в «чем-нибудь отбито».
         */

        // Закрытая без автора закрытия. Берётся именно «В работе»: у неё пара проведения заполнена,
        // значит правило проведения этой записью не задето вовсе.
        const без_автора = await dbRefusal(
          ctx.db.execute(
            sql`UPDATE office_equipment_purchases SET status = 'closed' WHERE id = ${вРаботе.id}`,
          ),
        );
        expect(без_автора.code).toBe('23514');
        expect(без_автора.constraint).toBe('office_equipment_purchases_closed_check');

        // Отменённая без причины: тройка «кто, когда, почему» заполнена РОВНО у отменённой, и пустая
        // строка означает «отмены не было».
        const без_причины = await dbRefusal(
          ctx.db.execute(sql`
          UPDATE office_equipment_purchases
             SET status = 'cancelled', cancelled_by = ${ctx.purchaser.id}, cancelled_at = now()
           WHERE id = ${новая.id}`),
        );
        expect(без_причины.code).toBe('23514');
        expect(без_причины.constraint).toBe('office_equipment_purchases_cancelled_check');

        // Причина из одних пробелов — это отсутствие причины, набранное иначе: `btrim` в `CHECK`
        // стоит ровно за этим.
        const пробелы = await dbRefusal(
          ctx.db.execute(sql`
          UPDATE office_equipment_purchases
             SET status = 'cancelled', cancelled_by = ${ctx.purchaser.id}, cancelled_at = now(),
                 cancel_reason = '   '
           WHERE id = ${новая.id}`),
        );
        expect(пробелы.constraint).toBe('office_equipment_purchases_cancelled_check');

        // «Новая» с проведением: пара проведения пуста ровно у той, что через проведение не прошла.
        const рано_провели = await dbRefusal(
          ctx.db.execute(sql`
          UPDATE office_equipment_purchases
             SET submitted_by = ${ctx.purchaser.id}, submitted_at = now()
           WHERE id = ${новая.id}`),
        );
        expect(рано_провели.code).toBe('23514');
        expect(рано_провели.constraint).toBe('office_equipment_purchases_submitted_check');

        // И то, ради чего условная запись перехода вообще заведена (Р10): закрытой с причиной
        // отмены в базе не бывает — даже если её попробует записать скрипт, а не гонка.
        const закрыта = await closePurchase(вРаботе.id);
        expect(закрыта.statusCode, закрыта.body).toBe(200);
        const закрытая_с_причиной = await dbRefusal(
          ctx.db.execute(sql`
          UPDATE office_equipment_purchases SET cancel_reason = 'отменили после закрытия'
           WHERE id = ${вРаботе.id}`),
        );
        expect(закрытая_с_причиной.code).toBe('23514');
        expect(закрытая_с_причиной.constraint).toBe('office_equipment_purchases_cancelled_check');

        // Состояния обеих закупок не сдвинулись ни на шаг: все пять записей отбиты целиком.
        expect((await purchaseRow(новая.id)).status).toBe('new');
        expect((await purchaseRow(новая.id)).submittedBy).toBeNull();
        expect((await purchaseRow(вРаботе.id)).status).toBe('closed');
        expect((await purchaseRow(вРаботе.id)).cancelReason).toBe('');
      });
    });

    // ── 6. Гонки и повторы (Р17, Р18) ──
    //
    // ЗАЧЕМ ОТДЕЛЬНЫЙ БЛОК. Happy path этих случаев не ловит вовсе: протокол Р17 целиком написан про
    // ВСТРЕЧУ двух запросов, и последовательная проверка зеленела бы на коде без блокировок, без
    // повторного чтения ключа и без условной записи. Поэтому каждая гонка здесь собирается сценой:
    // соседнее соединение держит строку, обе двери приходят в это окно и обязаны встать в очередь
    // ИМЕННО НА НЕЙ — что и проверяется через `pg_blocking_pids` и `wait_event`, а не «успели за
    // 200 мс».

    describe('гонки и повторы', () => {
      /**
       * Две двери, вставшие в очередь за одной строкой. Очередь за строкой — ЦЕПОЧКА, а не веер:
       * первый ждущий забирает временную блокировку самого кортежа и встаёт на `transactionid`
       * держателя, а второй упирается уже в него и ждёт на `tuple`. Поэтому второго ищем и за
       * держателем, и за первым: `pg_blocking_pids` называет держателя не всегда обоим.
       */
      async function двоеВОчереди(
        probe: pg.Client,
        holderPid: number,
        what: string,
        expected: RegExp,
      ): Promise<[Waiter, Waiter]> {
        const deadline = Date.now() + QUEUE_TIMEOUT_MS;
        const seen = new Set<string>();
        for (;;) {
          const rows = (await waitersBehind(probe, holderPid)).filter((r) =>
            expected.test(r.query),
          );
          for (const row of rows) seen.add(`${row.query} [${row.waitEvent}]`);
          const первый = rows.find((r) => r.waitEvent === 'transactionid');
          if (первый) {
            const заПервым = (await waitersBehind(probe, первый.pid)).filter((r) =>
              expected.test(r.query),
            );
            const второй =
              rows.find((r) => r.pid !== первый.pid) ?? заПервым.find((r) => r.pid !== первый.pid);
            if (второй) return [первый, второй];
          }
          if (Date.now() > deadline) {
            throw new Error(
              `${what}: две двери так и не встали в очередь за бэкендом ${holderPid} ` +
                `(${String(expected)}); видели: ${[...seen].join(' | ') || '—'}`,
            );
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      it('два заведения из одного снимка: закупка одна, второму — 409 с новыми числами', async () => {
        /*
         * Картинка плана дословно: двое открыли форму на «к закупке 10» и сохранят двадцать, причём
         * НИ ОДНО ограничение базы при этом не нарушится — вторая открытая закупка законна. Значит
         * защита обязана быть протоколом сохранения, а не ограничением, и проверяется она только
         * встречей: убери из маршрута `FOR UPDATE` — очереди на строке не окажется вовсе, оба
         * посчитают «уже заказано» нулём, и в базе будет две закупки на двадцать штук.
         */
        const c = await createConsumable({ requiredQuantity: 10, quantity: 0 });
        const item = await freshItem(c.id, 10);
        const holder = await openClient();
        const probe = await openProbe();
        let first: ReturnType<typeof postPurchase> | undefined;
        let second: ReturnType<typeof postPurchase> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE',
            [c.id],
          );

          first = postPurchase([item]);
          second = postPurchase([item]);
          const [ahead, behind] = await двоеВОчереди(
            probe,
            await backendPid(holder),
            'два заведения',
            LOCK_CONSUMABLES,
          );
          // Первое ждёт ЧУЖУЮ ТРАНЗАКЦИЮ — значит дошло до шага 3 и встало на строке расходника, а
          // не проскочило мимо блокировки к сверке снимка.
          expect(ahead.waitEvent, 'заведение не встало на строке расходника').toBe('transactionid');
          expect(behind.pid).not.toBe(ahead.pid);

          await holder.query('ROLLBACK');
          const [a, b] = await Promise.all([first, second]);
          first = undefined;
          second = undefined;

          expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([201, 409]);
          const winner = a.statusCode === 201 ? a : b;
          const loser = a.statusCode === 201 ? b : a;
          const created = winner.json() as OfficeEquipmentPurchaseDetailDto;

          // Проигравшему называются НОВЫЕ ЧИСЛА по изменившейся строке: это не отказ по полю —
          // человек ничего не написал неверно, его данные устарели, и без новых чисел окно
          // предложило бы переспросить ровно то же самое.
          const тело = loser.json();
          expect(тело.code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.snapshot);
          expect(тело.details.kind).toBe('snapshot');
          expect(тело.details.rows).toHaveLength(1);
          expect(тело.details.rows[0].consumableId).toBe(c.id);
          expect(тело.details.rows[0].expectedAlreadyOrdered).toBe(0);
          expect(тело.details.rows[0].actualAlreadyOrdered).toBe(10);
          expect(тело.details.rows[0].actualSuggested).toBe(0);

          // Главное: закупка одна. Двадцати штук по позиции с дефицитом в десять не заказано.
          expect(await purchasesTouching(c.id)).toEqual([created.id]);
          expect((await stateOf(c.id)).alreadyOrdered).toBe(10);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await first?.catch(() => undefined);
          await second?.catch(() => undefined);
          await holder.end();
          await probe.end();
        }
      }, 60_000);

      it('повтор с тем же ключом ПОСЛЕ того, как закупка сама подняла «уже заказано»', async () => {
        /*
         * ЭТО ПРЯМАЯ ПРОВЕРКА ПОРЯДКА ШАГОВ Р17, и она обязана существовать именно потому, что на
         * этом месте план уже спотыкался (редакция 4 поставила ключ седьмым шагом, после сверки
         * снимка).
         *
         * Сцена — потерянный ответ: закупка создана, портал ответа не увидел и шлёт ТО ЖЕ ТЕЛО с ТЕМ
         * ЖЕ ключом. К этому моменту созданная закупка САМА подняла «уже заказано», и сверка снимка
         * на этом теле обязана была бы дать 409 — что и показывает третья отправка ниже. Значит
         * ответ «та же закупка» доказывает ровно одно: ключ спросили ДО сверки.
         */
        const c = await createConsumable({ requiredQuantity: 10, quantity: 0 });
        const item = await freshItem(c.id, 10);
        const key = randomUUID();

        const первый = await postPurchase([item], { key });
        expect(первый.statusCode, первый.body).toBe(201);
        const created = первый.json() as OfficeEquipmentPurchaseDetailDto;
        expect((await stateOf(c.id)).alreadyOrdered).toBe(10);

        const повтор = await postPurchase([item], { key });
        // 200, а не 201: ресурс ЭТИМ запросом не создавался, и сказать «создано» значило бы соврать
        // клиенту, который как раз и пытается понять, создавал он что-нибудь или нет.
        expect(повтор.statusCode, повтор.body).toBe(200);
        expect((повтор.json() as OfficeEquipmentPurchaseDetailDto).id).toBe(created.id);
        expect(await purchasesTouching(c.id)).toEqual([created.id]);

        // Контрольная отправка: то же тело, но СВОЙ ключ — то есть другая попытка, а не повтор. Она
        // упирается в сверку снимка, и это доказывает, что 200 выше пришёл именно от ключа.
        const чужая = await postPurchase([item]);
        expect(чужая.statusCode, чужая.body).toBe(409);
        expect(чужая.json().code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.snapshot);
        expect(await purchasesTouching(c.id)).toEqual([created.id]);
      });

      it('тот же ключ с другим телом — 409 «ключ занят», а не вторая закупка', async () => {
        const c = await createConsumable({ requiredQuantity: 30, quantity: 0 });
        const key = randomUUID();
        const created = await createPurchase([await freshItem(c.id, 5)], { key });

        // Другая команда под старым ключом. Молча подтверждать её нельзя: повторять тут нечего —
        // надо взять новый ключ, и отдельный код отказа говорит порталу именно это.
        const другое = await postPurchase([await freshItem(c.id, 6)], { key });
        expect(другое.statusCode, другое.body).toBe(409);
        expect(другое.json().code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.idempotency);
        expect(await purchasesByKey(ctx.purchaser.id, key)).toEqual([created.id]);
      });

      it('три повтора не размножают ни закупку, ни событие в журнале', async () => {
        const c = await createConsumable({ requiredQuantity: 9, quantity: 0 });
        const item = await freshItem(c.id, 9);
        const key = randomUUID();
        const created = await createPurchase([item], { key });

        for (const попытка of [1, 2, 3]) {
          const res = await postPurchase([item], { key });
          expect(res.statusCode, `повтор ${попытка}: ${res.body}`).toBe(200);
          expect((res.json() as OfficeEquipmentPurchaseDetailDto).id).toBe(created.id);
        }

        // Повтор заканчивается на шаге 2 и НИЧЕГО БОЛЬШЕ НЕ ДЕЛАЕТ — в том числе не пишет второго
        // события аудита. Аудит закупки строгий (`writeAuditTx`), и четыре записи о заведении одного
        // документа объясняли бы расхождение со снабжением хуже, чем их отсутствие.
        expect(await auditCount('officeEquipmentPurchase.create', created.id)).toBe(1);
        expect(await purchasesTouching(c.id)).toEqual([created.id]);
      });

      it('отложенный повтор: закупку закрыли, «уже заказано» вернулось — ключ всё равно держит', async () => {
        /*
         * ТОТ САМЫЙ СЛУЧАЙ, НА КОТОРОМ СЛОМАЛСЯ ДОВОД РЕДАКЦИИ 3 («повтор устареет и получит 409,
         * значит ключ не нужен»). Довод верен ровно в одном сценарии — немедленный повтор, пока
         * созданная закупка открыта. Стоит её закрыть, и «уже заказано» возвращается к прежнему: тот
         * же запрос прошёл бы второй раз, заводя дубль через час.
         */
        const c = await createConsumable({ requiredQuantity: 11, quantity: 0 });
        const item = await freshItem(c.id, 11);
        const key = randomUUID();
        const created = await createPurchase([item], { key });
        await submitAndClose(created);

        // Числа вернулись ровно к тем, что в снимке: сверка снимка эту отправку пропустила бы.
        expect(await stateOf(c.id)).toEqual({ required: 11, stock: 0, alreadyOrdered: 0 });

        const повтор = await postPurchase([item], { key });
        expect(повтор.statusCode, повтор.body).toBe(200);
        expect((повтор.json() as OfficeEquipmentPurchaseDetailDto).id).toBe(created.id);
        expect((повтор.json() as OfficeEquipmentPurchaseDetailDto).status).toBe('closed');
        expect(await purchasesTouching(c.id)).toEqual([created.id]);
        expect(await auditCount('officeEquipmentPurchase.create', created.id)).toBe(1);
      });

      it('два одновременных POST с одним ключом: закупка одна, второй получает её же', async () => {
        const c = await createConsumable({ requiredQuantity: 14, quantity: 0 });
        const item = await freshItem(c.id, 14);
        const key = randomUUID();
        const holder = await openClient();
        const probe = await openProbe();
        let first: ReturnType<typeof postPurchase> | undefined;
        let second: ReturnType<typeof postPurchase> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE',
            [c.id],
          );

          // Оба запроса уходят ДО того, как ключ кем-либо занят: на шаге 2 его не видит ни один, и
          // разводит их только повторное чтение под блокировкой (шаг 4) либо уникальное ограничение
          // (шаг 8). Последовательная пара этой ветки не касается вовсе — второй увидел бы ключ ещё
          // на шаге 2.
          first = postPurchase([item], { key });
          second = postPurchase([item], { key });
          const [ahead, behind] = await двоеВОчереди(
            probe,
            await backendPid(holder),
            'два заведения с одним ключом',
            LOCK_CONSUMABLES,
          );
          expect(ahead.waitEvent).toBe('transactionid');
          expect(behind.pid).not.toBe(ahead.pid);

          await holder.query('ROLLBACK');
          const [a, b] = await Promise.all([first, second]);
          first = undefined;
          second = undefined;

          expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([200, 201]);
          const созданная = (a.json() as OfficeEquipmentPurchaseDetailDto).id;
          expect((b.json() as OfficeEquipmentPurchaseDetailDto).id).toBe(созданная);
          expect(await purchasesByKey(ctx.purchaser.id, key)).toEqual([созданная]);
          expect(await auditCount('officeEquipmentPurchase.create', созданная)).toBe(1);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await first?.catch(() => undefined);
          await second?.catch(() => undefined);
          await holder.end();
          await probe.end();
        }
      }, 60_000);

      it('один ключ с непересекающимися позициями разводит только уникальное ограничение', async () => {
        /*
         * ШАГ 8 ЦЕЛИКОМ, И НИКАКОЙ ДРУГОЙ ШАГ ЭТУ ПАРУ НЕ РАЗВОДИТ. Позиции у запросов разные, значит
         * на блокировках расходников (шаги 3 и 4) они не встречаются ВОВСЕ: каждый запирает своё,
         * ключа под блокировкой не видит и идёт вставлять. Остаётся уникальность пары «автор + ключ»,
         * и ловится она СНАРУЖИ уже прерванной транзакции.
         *
         * Сцена собирается так, чтобы обе вставки заведомо оказались в воздухе одновременно: соседнее
         * соединение держит `FOR UPDATE` на строке УЧЁТКИ автора, а вставка шапки проверяет по ней
         * внешний ключ `created_by`. Первый запрос успевает записать строку (и занять индекс ключа)
         * и застревает на этой проверке; второй встаёт уже за ним — на самом уникальном индексе.
         */
        const x = await createConsumable({ requiredQuantity: 6, quantity: 0 });
        const y = await createConsumable({ requiredQuantity: 6, quantity: 0 });
        const key = randomUUID();
        const holder = await openClient();
        const probe = await openProbe();
        let first: ReturnType<typeof postPurchase> | undefined;
        let second: ReturnType<typeof postPurchase> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [ctx.purchaser.id]);

          first = postPurchase([await freshItem(x.id, 6)], { key });
          const ahead = await oneQueuedBehind(
            probe,
            await backendPid(holder),
            'первое заведение',
            INSERT_PURCHASE,
          );
          expect(ahead.waitEvent).toBe('transactionid');

          second = postPurchase([await freshItem(y.id, 6)], { key });
          const behind = await oneQueuedBehind(
            probe,
            ahead.pid,
            'второе заведение',
            INSERT_PURCHASE,
          );
          // Второй ждёт ПЕРВОГО на вставке шапки — то есть на уникальном индексе ключа, а не на
          // строке расходника: на расходниках они и не встретились.
          expect(behind.pid).not.toBe(ahead.pid);
          expect(behind.waitEvent).toBe('transactionid');

          await holder.query('ROLLBACK');
          const [a, b] = await Promise.all([first, second]);
          first = undefined;
          second = undefined;

          expect(a.statusCode, a.body).toBe(201);
          // Отпечатки разные (позиции разные), значит это не повтор, а другая команда под тем же
          // ключом — и ответ обязан быть отказом, а не второй закупкой и не чужой закупкой.
          expect(b.statusCode, b.body).toBe(409);
          expect(b.json().code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.idempotency);

          const созданная = (a.json() as OfficeEquipmentPurchaseDetailDto).id;
          expect(await purchasesByKey(ctx.purchaser.id, key)).toEqual([созданная]);
          expect(await purchasesTouching(x.id)).toEqual([созданная]);
          expect(await purchasesTouching(y.id)).toHaveLength(0);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await first?.catch(() => undefined);
          await second?.catch(() => undefined);
          await holder.end();
          await probe.end();
        }
      }, 60_000);

      it('23505 от ЧУЖОГО ограничения не превращается в «повторный запрос»', async () => {
        /*
         * ЗАЩИТА ОТ ТОГО, ЧТО НАСТОЯЩИЙ ДЕФЕКТ БАЗЫ ВЕРНЁТСЯ КЛИЕНТУ КАК УСПЕШНЫЙ ПОВТОР. `23505` в
         * этой транзакции способны дать и уникальность номера закупки, и пара «закупка + позиция» в
         * строках, и ограничения строгого аудита. Перехвати маршрут код целиком — наружу поехала бы
         * чужая закупка либо выдуманный ответ вместо ошибки.
         *
         * Нарушение подстраивается тем, до чего у ручки нет своей двери: счётчик номеров отматывается
         * назад, и вставка шапки упирается в `office_equipment_purchases_num_unique`. Имя не то —
         * исходная ошибка обязана лететь дальше нетронутой, то есть пятисоткой.
         */
        const c = await createConsumable({ requiredQuantity: 40, quantity: 0 });
        const занятый = await createPurchase([await freshItem(c.id, 2)]);
        const занятыйНомер = (await purchaseRow(занятый.id)).num;
        const было = await ctx.db.execute<{ max: number }>(
          sql`SELECT max(num) AS max FROM office_equipment_purchases`,
        );
        const следующий = Number(было.rows[0]!.max) + 1;

        const key = randomUUID();
        try {
          await ctx.db.execute(
            sql.raw(
              `ALTER TABLE office_equipment_purchases ALTER COLUMN num RESTART WITH ${занятыйНомер}`,
            ),
          );
          const res = await postPurchase([await freshItem(c.id, 3)], { key });
          expect(res.statusCode, res.body).toBe(500);
          // Пятисотка, а не 409 «ключ занят» и не чужая закупка: разбор шага 8 обязан пропустить
          // ошибку мимо себя, увидев ЧУЖОЕ имя ограничения. Само имя в тело не попадает — оно
          // остаётся в причине ошибки и в логе сервера, — поэтому проверяется исход, а не текст.
          expect(res.json().code).toBe('internal_error');
          // Ни закупки, ни «повтора»: наружу поехала ошибка, а не чужой документ.
          expect(res.json().id).toBeUndefined();
          expect(await purchasesByKey(ctx.purchaser.id, key)).toHaveLength(0);
          expect(await purchasesTouching(c.id)).toEqual([занятый.id]);
        } finally {
          await ctx.db.execute(
            sql.raw(
              `ALTER TABLE office_equipment_purchases ALTER COLUMN num RESTART WITH ${следующий}`,
            ),
          );
        }

        // Счётчик вернули — ручка снова работает: иначе следующий случай упал бы «из-за соседа», и
        // разбирать пришлось бы не тот отказ.
        const снова = await createPurchase([await freshItem(c.id, 3)]);
        expect(снова.num).toBeGreaterThanOrEqual(следующий);
      });

      it('правка остатка между открытием формы и сохранением: 409, свежий снимок проходит', async () => {
        const c = await createConsumable({ requiredQuantity: 10, quantity: 0 });
        // Снимок, с которым человек сидит в форме.
        const вФорме = await freshItem(c.id, 10);
        // …а склад тем временем пополнили.
        await setStock(c.id, 3, 0);

        const res = await postPurchase([вФорме]);
        expect(res.statusCode, res.body).toBe(409);
        const тело = res.json();
        expect(тело.code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.snapshot);
        expect(тело.details.rows[0].expectedStock).toBe(0);
        expect(тело.details.rows[0].actualStock).toBe(3);
        expect(тело.details.rows[0].actualSuggested).toBe(7);
        expect(await purchasesTouching(c.id)).toHaveLength(0);

        /*
         * Повторная отправка со свежим снимком проходит — И С ПРЕВЫШЕНИЕМ ТОЖЕ. Отдельного флага «я
         * подтверждаю» нет намеренно: пересланный свежий снимок и есть подтверждение, а осознанное
         * превышение — законный случай (снабжение берёт запас).
         */
        const свежий = await freshItem(c.id, 20);
        const ok = await createPurchase([свежий]);
        expect(ok.items[0]!.quantity).toBe(20);
        expect(ok.items[0]!.suggestedQuantity).toBe(7);
        expect(ok.items[0]!.stockSnapshot).toBe(3);
      });

      it('правка потребности между открытием формы и сохранением тоже даёт 409', async () => {
        // Сверяются ТРИ СЛАГАЕМЫХ, а не итог: потребность 20 при остатке 5 и потребность 25 при
        // остатке 10 дают одно и то же «к закупке 15», и сойдись у нас только итог, человек,
        // решавший по первой паре, молча подтвердил бы вторую.
        const c = await createConsumable({ requiredQuantity: 20, quantity: 5 });
        const вФорме = await freshItem(c.id, 15);
        const patched = await patchConsumable(c.id, { requiredQuantity: 25 });
        expect(patched.statusCode, patched.body).toBe(200);
        await setStock(c.id, 10, 5);

        const res = await postPurchase([вФорме]);
        expect(res.statusCode, res.body).toBe(409);
        const строка = res.json().details.rows[0];
        expect(строка.expectedRequired).toBe(20);
        expect(строка.actualRequired).toBe(25);
        expect(строка.actualStock).toBe(10);
        // Итог у обоих снимков одинаков — и именно поэтому сверять его одного было бы нельзя.
        expect(строка.actualSuggested).toBe(15);
        expect(await purchasesTouching(c.id)).toHaveLength(0);
      });

      it('две правки одного черновика: второй — 409 с новой версией и свежим составом', async () => {
        /*
         * Тот самый сценарий, ради которого у шапки завелась `content_version`: двое открыли
         * черновик на 10, первый поставил 12, второй ставит 8. СНИМОК Р17 У ВТОРОГО СХОДИТСЯ —
         * внешнее состояние не менялось, а собственный вклад закупки из «уже заказано» и так
         * вычитается, — и без версии «8» молча перетёрло бы «12».
         */
        const c = await createConsumable({ requiredQuantity: 10, quantity: 0 });
        const purchase = await createPurchase([await freshItem(c.id, 10)]);
        const двенадцать = await freshItem(c.id, 12, purchase.id);
        const восемь = await freshItem(c.id, 8, purchase.id);
        // Оба снимка одинаковы и оба верны: разойтись двум правкам нечем, кроме версии.
        expect(двенадцать.expectedAlreadyOrdered).toBe(0);
        expect(восемь.expectedAlreadyOrdered).toBe(0);

        const holder = await openClient();
        const probe = await openProbe();
        let first: ReturnType<typeof patchPurchase> | undefined;
        let second: ReturnType<typeof patchPurchase> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE',
            [c.id],
          );

          first = patchPurchase(purchase.id, { contentVersion: 1, items: [двенадцать] });
          second = patchPurchase(purchase.id, { contentVersion: 1, items: [восемь] });
          const [ahead, behind] = await двоеВОчереди(
            probe,
            await backendPid(holder),
            'две правки черновика',
            LOCK_CONSUMABLES,
          );
          expect(ahead.waitEvent).toBe('transactionid');
          expect(behind.pid).not.toBe(ahead.pid);

          await holder.query('ROLLBACK');
          const [a, b] = await Promise.all([first, second]);
          first = undefined;
          second = undefined;

          expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([200, 409]);
          const winner = (a.statusCode === 200 ? a : b).json() as OfficeEquipmentPurchaseDetailDto;
          const loser = (a.statusCode === 200 ? b : a).json();

          expect(winner.contentVersion).toBe(2);
          expect(loser.code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.version);
          // Отказ несёт СВЕЖЕЕ СОДЕРЖИМОЕ целиком, а не один номер версии: окну надо показать, ЧТО
          // именно поменял сосед, — иначе «версия 3, а у вас 2» человек прочитает как отказ портала
          // и нажмёт ту же кнопку ещё раз.
          expect(loser.details.kind).toBe('version');
          expect(loser.details.purchase.contentVersion).toBe(2);
          expect(loser.details.purchase.items).toHaveLength(1);
          expect(loser.details.purchase.items[0].quantity).toBe(winner.items[0]!.quantity);

          // В базе — состав победителя, а не молчаливое затирание.
          const итог = await purchaseDetail(purchase.id);
          expect(итог.contentVersion).toBe(2);
          expect(итог.items[0]!.quantity).toBe(winner.items[0]!.quantity);
          expect(await auditCount('officeEquipmentPurchase.update', purchase.id)).toBe(1);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await first?.catch(() => undefined);
          await second?.catch(() => undefined);
          await holder.end();
          await probe.end();
        }
      }, 60_000);

      it('правка против «Провести»: правка, начатая до проведения, получает 409 со статусом', async () => {
        /*
         * ЩЕЛЬ МЕЖДУ ЧТЕНИЕМ И ЗАПИСЬЮ — ровно то, ради чего запись условная. Правка успевает
         * прочитать «Новая» и встаёт на блокировке расходников; в это окно приходит «Провести» —
         * оно строк расходников не трогает вовсе и проходит насквозь. Ранний отказ по статусу здесь
         * уже не спасает: он остался позади, и отбить правку обязано условие `status = 'new'` в
         * самой записи.
         */
        const c = await createConsumable({ requiredQuantity: 10, quantity: 0 });
        const purchase = await createPurchase([await freshItem(c.id, 10)]);
        const двенадцать = await freshItem(c.id, 12, purchase.id);

        const holder = await openClient();
        const probe = await openProbe();
        let правка: ReturnType<typeof patchPurchase> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE',
            [c.id],
          );

          правка = patchPurchase(purchase.id, { contentVersion: 1, items: [двенадцать] });
          const ждёт = await oneQueuedBehind(
            probe,
            await backendPid(holder),
            'правка черновика',
            LOCK_CONSUMABLES,
          );
          expect(ждёт.waitEvent).toBe('transactionid');

          const проведена = await submitPurchase(purchase.id, purchase.contentVersion);
          expect(проведена.statusCode, проведена.body).toBe(200);

          await holder.query('ROLLBACK');
          const res = await правка;
          правка = undefined;

          expect(res.statusCode, res.body).toBe(409);
          expect(res.json().code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.status);
          // Ответ различает два случая нуля строк: «уже провели» — это статус, а не чужая правка.
          expect(res.json().details.kind).toBe('status');
          expect(res.json().details.status).toBe('in_work');

          const итог = await purchaseDetail(purchase.id);
          expect(итог.status).toBe('in_work');
          expect(итог.contentVersion).toBe(1);
          expect(итог.items[0]!.quantity, 'состав проведённой закупки переписали').toBe(10);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await правка?.catch(() => undefined);
          await holder.end();
          await probe.end();
        }
      }, 60_000);

      it('«Провести» с устаревшей версией — 409 с новой, а не бумага не того состава', async () => {
        // В снабжение уезжает СОСТАВ, и провести надо ровно тот, который человек видел на экране:
        // правка соседа, приехавшая между открытием карточки и нажатием кнопки, меняет именно его.
        const c = await createConsumable({ requiredQuantity: 10, quantity: 0 });
        const purchase = await createPurchase([await freshItem(c.id, 10)]);
        const правка = await patchPurchase(purchase.id, {
          contentVersion: 1,
          items: [await freshItem(c.id, 12, purchase.id)],
        });
        expect(правка.statusCode, правка.body).toBe(200);

        const устаревшее = await submitPurchase(purchase.id, 1);
        expect(устаревшее.statusCode, устаревшее.body).toBe(409);
        expect(устаревшее.json().code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.version);
        expect(устаревшее.json().details.purchase.contentVersion).toBe(2);
        expect(устаревшее.json().details.purchase.items[0].quantity).toBe(12);
        expect((await purchaseRow(purchase.id)).status).toBe('new');

        const свежее = await submitPurchase(purchase.id, 2);
        expect(свежее.statusCode, свежее.body).toBe(200);
        expect((await purchaseRow(purchase.id)).status).toBe('in_work');

        // А после проведения состав не правится вовсе — ошибку исправляют отменой и новой закупкой.
        const поздняя = await patchPurchase(purchase.id, {
          contentVersion: 2,
          items: [await freshItem(c.id, 3, purchase.id)],
        });
        expect(поздняя.statusCode, поздняя.body).toBe(409);
        expect(поздняя.json().details.status).toBe('in_work');
        expect((await purchaseDetail(purchase.id)).items[0]!.quantity).toBe(12);
      });

      /**
       * Сцена «два хода на одном документе»: очередь выстраивается ЗАДАННЫМ порядком, а не тем,
       * который выберет менеджер блокировок.
       *
       * Порядок задан нарочно, и это не подгонка под ответ. Гонка проверяется в ОБЕ стороны двумя
       * вызовами (закрытие раньше отмены и наоборот) — и только так проверка становится
       * симметричной: отдай мы выбор победителя случаю, половина сценария не исполнялась бы никогда,
       * а какая именно — менялось бы от запуска к запуску. Первым в очередь встаёт тот, кого послали
       * первым: за строкой очередь выстраивается цепочкой, и временную блокировку кортежа забирает
       * тот, кто пришёл раньше.
       */
      async function ходПротивХода(
        первыйХод: (id: string) => ReturnType<typeof closePurchase>,
        второйХод: (id: string) => ReturnType<typeof closePurchase>,
        ожидаемыйСтатус: OfficeEquipmentPurchaseStatus,
      ): Promise<void> {
        const c = await createConsumable({ requiredQuantity: 10, quantity: 0 });
        const purchase = await createPurchase([await freshItem(c.id, 10)]);
        const проведена = await submitPurchase(purchase.id, purchase.contentVersion);
        expect(проведена.statusCode, проведена.body).toBe(200);

        const holder = await openClient();
        const probe = await openProbe();
        let первый: ReturnType<typeof closePurchase> | undefined;
        let второй: ReturnType<typeof closePurchase> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query('SELECT 1 FROM office_equipment_purchases WHERE id = $1 FOR UPDATE', [
            purchase.id,
          ]);

          первый = первыйХод(purchase.id);
          const ahead = await oneQueuedBehind(
            probe,
            await backendPid(holder),
            'первый ход',
            UPDATE_PURCHASE,
          );
          expect(ahead.waitEvent, 'первый ход не встал на строке закупки').toBe('transactionid');

          второй = второйХод(purchase.id);
          const behind = await oneQueuedBehind(probe, ahead.pid, 'второй ход', UPDATE_PURCHASE);
          expect(behind.pid).not.toBe(ahead.pid);

          await holder.query('ROLLBACK');
          const [a, b] = await Promise.all([первый, второй]);
          первый = undefined;
          второй = undefined;

          expect(a.statusCode, `первый ход: ${a.body}`).toBe(200);
          expect(b.statusCode, `второй ход: ${b.body}`).toBe(409);
          expect(b.json().code).toBe(OFFICE_EQUIPMENT_PURCHASE_CONFLICT_CODES.status);
          // Проигравшему называется ТЕКУЩИЙ статус — тот, в который документ увёл сосед: человеку
          // надо знать, что ход уже сделан, а не жать кнопку второй раз.
          expect(b.json().details.status).toBe(ожидаемыйСтатус);

          const итог = await purchaseRow(purchase.id);
          expect(итог.status).toBe(ожидаемыйСтатус);
          if (итог.status === 'closed') {
            expect(итог.cancelReason).toBe('');
            expect(итог.cancelledBy).toBeNull();
          } else {
            expect(итог.closedBy).toBeNull();
            expect(итог.cancelReason).not.toBe('');
          }

          // И то же самое запросом по всей таблице: закрытой закупки с причиной отмены в базе нет
          // ни одной — ни у этой пары, ни у соседних случаев файла.
          const дичь = await ctx.db.execute<{ c: number }>(sql`
          SELECT count(*)::int AS c FROM office_equipment_purchases
           WHERE (status = 'closed' AND btrim(cancel_reason) <> '')
              OR (status = 'cancelled' AND closed_by IS NOT NULL)`);
          expect(дичь.rows[0]!.c).toBe(0);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await первый?.catch(() => undefined);
          await второй?.catch(() => undefined);
          await holder.end();
          await probe.end();
        }
      }

      /*
       * Ровно тот случай, ради которого переход пишется условной записью, а не чтением с последующим
       * `UPDATE`: без условия по статусу второй ход перетёр бы первый, и в базе оказалась бы ЗАКРЫТАЯ
       * ЗАКУПКА С ПРИЧИНОЙ ОТМЕНЫ — состояние, которого не бывает.
       */
      it('«Закрыть» против «Отменить»: закрытие первым — отмене 409 с «Закрыта»', async () => {
        await ходПротивХода(
          (id) => closePurchase(id),
          (id) => cancelPurchase(id, 'снабжение отказалось везти'),
          'closed',
        );
      }, 60_000);

      it('«Отменить» против «Закрыть»: отмена первой — закрытию 409 с «Отменена»', async () => {
        await ходПротивХода(
          (id) => cancelPurchase(id, 'снабжение отказалось везти'),
          (id) => closePurchase(id),
          'cancelled',
        );
      }, 60_000);

      it('заведение против закрытия соседней закупки: «уже заказано» пересчитано под блокировкой', async () => {
        /*
         * Закрытие соседней закупки строк расходников не трогает вовсе — значит от заведения его не
         * отделяет ни одна общая блокировка, и разойтись они могут только на пересчёте под своей.
         * Проверяется здесь именно то, что пересчёт идёт ПОСЛЕ захвата блокировок, а не по числам,
         * прочитанным до них: снимок формы устарел ровно на закрытую соседку.
         */
        const c = await createConsumable({ requiredQuantity: 10, quantity: 0 });
        const соседка = await createPurchase([await freshItem(c.id, 4)]);
        const проведена = await submitPurchase(соседка.id, соседка.contentVersion);
        expect(проведена.statusCode, проведена.body).toBe(200);
        // Снимок формы: «уже заказано 4», значит к закупке шесть.
        const вФорме = await freshItem(c.id, 6);
        expect(вФорме.expectedAlreadyOrdered).toBe(4);

        const holder = await openClient();
        const probe = await openProbe();
        let заведение: ReturnType<typeof postPurchase> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE',
            [c.id],
          );

          заведение = postPurchase([вФорме]);
          const ждёт = await oneQueuedBehind(
            probe,
            await backendPid(holder),
            'заведение',
            LOCK_CONSUMABLES,
          );
          expect(ждёт.waitEvent).toBe('transactionid');

          const закрыта = await closePurchase(соседка.id);
          expect(закрыта.statusCode, закрыта.body).toBe(200);

          await holder.query('ROLLBACK');
          const res = await заведение;
          заведение = undefined;

          expect(res.statusCode, res.body).toBe(409);
          const строка = res.json().details.rows[0];
          expect(строка.expectedAlreadyOrdered).toBe(4);
          expect(строка.actualAlreadyOrdered).toBe(0);
          // Число в отказе совпадает с тем, что видно в табличке после обеих операций, — иначе окно
          // предложило бы переспросить у сервера то, что он уже сказал.
          expect((await consumableRow(c.id)).alreadyOrdered).toBe(строка.actualAlreadyOrdered);
          expect((await consumableRow(c.id)).deficit).toBe(строка.actualSuggested);
          expect(await purchasesTouching(c.id)).toEqual([соседка.id]);
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await заведение?.catch(() => undefined);
          await holder.end();
          await probe.end();
        }
      }, 60_000);
    });
  },
);
