import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  OfficeEquipmentConsumableDetailDto,
  OfficeEquipmentConsumableDto,
  OfficeEquipmentConsumableStockResultDto,
  OfficeEquipmentDto,
  OfficeEquipmentModelDto,
  Permission,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Расходники оргтехники — картриджи и тонеры (план `docs/office-equipment-consumables-plan.md`,
 * Р5–Р7, Р9–Р11; миграция [0172](../drizzle/0172_office_equipment_consumables.sql), маршрут
 * `routes/office-equipment-consumables.ts`).
 *
 * ЗАЧЕМ БАЗА. Главное обещание справочника — «остаток нельзя изменить мимо журнала, а журнал не
 * врёт» — живёт не в коде, а в схеме, и на моках проверяются только моки:
 *
 * - ЦЕПОЧКА (`BEFORE INSERT` на журнале) сверяет ОБА конца события. Проверка только «стало»
 *   пропустила бы строку «999 → 12» при остатке 12 — итог верен, а в журнале навсегда осталось бы
 *   выдуманное «было», по которому потом считают расход; проверка только «было» пропустила бы
 *   событие, не доехавшее до карточки. Отсюда же и правило, которое выяснила реализация: первое
 *   событие обязано начинаться с нуля — до него расходник заведён нулём;
 * - НЕИЗМЕНЯЕМОСТЬ (`BEFORE UPDATE OR DELETE`) запрещает подчистить прошлое построчно: `RESTRICT`
 *   со стороны расходника защищает историю целиком, а правку одной строки — нет;
 * - ПОКРЫТИЕ (отложенный constraint-триггер) ловит ОТСУТСТВИЕ события: `UPDATE … SET quantity = 7`
 *   скриптом проходит мимо первых двух насквозь, и без этой проверки обещание журнала осталось бы
 *   обещанием маршрута;
 * - ГОНКА ОСТАТКА — свойство ПАРЫ транзакций, а не одной: файл маршрута показывает
 *   `SELECT … FOR UPDATE`, но не показывает, что без него два кладовщика прочитают 12, запишут
 *   «12 → 10» и «12 → 8» и цепочка станет враньём при верном итоге. Доказывается это встречей двух
 *   запросов на одной строке — тем же приёмом с `pg_blocking_pids`, что в
 *   `office-equipment-models.db.test.ts`, откуда взято и устройство фикстур.
 *
 * ПРО ПРАВА. Их два и они РАЗНЫЕ (Р10 в редакции от 21.08): `officeEquipmentConsumables.manage`
 * ведёт номенклатуру, `officeEquipmentConsumables.stock` правит остаток. Тест проверяет обе стороны
 * — у кого только `stock`, и у кого только `manage`, — и отдельно то, что `officeEquipment.write`
 * не открывает ни одного из этих действий: то право открывает весь парк.
 *
 * ПРО КОРРЕЛИРОВАННЫЕ ПОДЗАПРОСЫ. Признак «есть ли движение» и счётчик парка собраны подзапросами
 * со ссылкой наружу, а такие ссылки в drizzle ломаются МОЛЧА — без единой ошибки, потому что
 * получившийся запрос совершенно законен. Правило, ЗАМЕРЕННОЕ на этой сборке (drizzle 0.45.2,
 * `toSQL()` на тех же выражениях), уже́ и точнее фольклорного «в односоставном запросе колонки
 * переписываются»:
 *
 *   · переписывается только ВЕРХНИЙ УРОВЕНЬ выражения в списке столбцов: колонка, вписанная прямо
 *     в выражение, теряет квалификацию, а та же колонка, завёрнутая в отдельный `sql`-объект, —
 *     нет. Чья это колонка — своей таблицы запроса или чужой — не имеет значения вовсе;
 *   · и только там: `WHERE` и запрос с соединением целы даже с колонкой, вписанной на месте.
 *
 * Отсюда и то, какая потеря квалификации ВРЕДНА, а какая безобидна: беда не в самом голом имени, а
 * в том, разрешается ли оно в чужой `FROM`. Ссылка на внешнюю строку (`consumable_id = "id"`)
 * уезжает в таблицу подзапроса и становится ложью; голое `"model_id"` в `WHERE` подзапроса, чей
 * собственный `FROM` — таблица техники, разрешается в неё же и остаётся верным.
 *
 * Отсюда две вещи, обе проверенные поломкой. Первая: `consumableIdRef` и `equipmentModelIdRef` в
 * маршруте безопасны и как чанк таблицы, и как вынесенная колонка — подменой одного на другое ни
 * один случай файла не покраснеет, потому что собранный SQL от этого не меняется. Вторая: ломается
 * ровно та форма, к которой ведёт «зачем эта константа, впишу колонку на месте», — и на ней
 * краснеют все семь случаев обеих ловушек сразу.
 *
 * Форму записи поведением не удержать вовсе, поэтому рядом стоит вторая страховка —
 * `office-equipment-sql-correlation.test.ts`: она смотрит на собранный `toSQL()` и работает БЕЗ
 * базы, то есть ловит ту же ошибку в обычном прогоне, где этот файл пропускается.
 *
 * Поэтому свои проверки файл пишет прямым SQL, а оба выражения маршрута спрашивает у ОБЕИХ дверей
 * сразу — в списке и в карточке по `id`.
 *
 * ИЗОЛЯЦИЯ. База db-тестов общая и живёт между прогонами: в ней лежит копия боевого парка. Всё своё
 * помечено суффиксом прогона `RUN` — коды расходников, наименования моделей, коды наборов, адреса
 * учёток, — и `afterAll` уносит ровно его. Порядок уборки задан схемой: строки журнала неудаляемы
 * (триггер), поэтому их сносит транзакция с временно погашенным триггером — и только после этого
 * уходят сами расходники, а за ними модели.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/technic_archive_test \
 *     pnpm --filter @technic/api test office-equipment-consumables
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
/** Он же в написании кода: код хранится нормализованным, то есть в верхнем регистре. */
const CODE_RUN = RUN.toUpperCase();

/**
 * Опознавательные знаки файла — УСТОЙЧИВЫЕ, то есть без суффикса прогона. По ним уборка находит
 * хвосты ЧУЖИХ прогонов этого же файла (см. `убрать` ниже); суффикс прогона добавляется к ним
 * сверху и отделяет своё от брошенного.
 *
 * Код начинается с буквы серии, как в учётной системе, и уезжает в базу нормализованным — то есть
 * в верхнем регистре и без пробелов, поэтому и здесь он записан сразу так.
 */
const CODE_PREFIX = 'ДOEC';
const MODEL_PREFIX = 'OEC ';
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
 * Права — константами из словаря контрактов, а не строками на месте: `Permission` не даст
 * опечатке дожить до прогона, а снятое выкатом право сломает типизацию здесь, а не тихо превратит
 * случай про доступ в случай про «права нет ни у кого».
 */
const MANAGE: Permission = 'officeEquipmentConsumables.manage';
const STOCK: Permission = 'officeEquipmentConsumables.stock';

/** Тексты стражей маршрута: по ним видно, КАКОЙ из двух отказал, а не просто «403». */
const MANAGE_DENIED = 'Номенклатуру расходников ведёт ответственный за неё';
const STOCK_DENIED = 'Остаток расходника правит ответственный за склад';

/** Причина первого события: её составляет маршрут, а не человек (Р7). */
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
  /** Только `officeEquipmentConsumables.manage`: ведёт номенклатуру, остатка не касается. */
  manageUser: TestUser;
  /** Только `officeEquipmentConsumables.stock`: правит остаток, номенклатуру не ведёт. */
  stockUser: TestUser;
  /** Роль с `officeEquipment.write`: весь парк — её, расходники — нет (Р10). */
  parkUser: TestUser;
  /** Роль объекта (`shtab`): в счётчике у неё только карточки своих площадок (Р12). */
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
  /** Тип «МФУ»: под ним заводятся модели, к которым привязываются расходники. */
  mfpTypeId: string;
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
 * Код номенклатуры этого прогона. Буква серии и «цифры» — как у учётной системы («Д0000337741»);
 * суффикс прогона внутри кода нужен уборке: справочник общий, и `afterAll` находит своё именно по
 * началу кода. Верхний регистр не украшение — в базе код лежит уже нормализованным.
 */
let codeNo = 0;
function nextCode(): string {
  codeNo += 1;
  return `${CODE_PREFIX}${CODE_RUN}${String(codeNo).padStart(3, '0')}`;
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

// ── Ручки справочника расходников ──

interface ConsumableInput {
  code?: string;
  name?: string;
  quantity?: number;
  color?: string | null;
  comment?: string;
  isActive?: boolean;
  modelIds?: string[];
  auth?: Auth;
}

let consumableNo = 0;

function consumableBody(input: ConsumableInput): Record<string, unknown> {
  consumableNo += 1;
  return {
    code: input.code ?? nextCode(),
    name: input.name ?? `Тонер тестовый ${RUN} №${consumableNo} (шт)`,
    ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
    ...(input.color === undefined ? {} : { color: input.color }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    ...(input.modelIds === undefined ? {} : { modelIds: input.modelIds }),
  };
}

async function createConsumable(
  input: ConsumableInput = {},
): Promise<OfficeEquipmentConsumableDto> {
  const res = await inject(
    'POST',
    '/api/v1/office-equipment-consumables',
    input.auth ?? ctx.admin.auth,
    consumableBody(input),
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentConsumableDto;
}

async function detailOf(id: string, auth?: Auth): Promise<OfficeEquipmentConsumableDetailDto> {
  const res = await inject(
    'GET',
    `/api/v1/office-equipment-consumables/${id}`,
    auth ?? ctx.admin.auth,
  );
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OfficeEquipmentConsumableDetailDto;
}

/** Перечень одной строкой запроса: `search`, `modelId`, `stock` — те же параметры, что у окна (Р9). */
async function listConsumables(
  query: Record<string, string>,
  auth?: Auth,
): Promise<OfficeEquipmentConsumableDto[]> {
  const qs = new URLSearchParams({ pageSize: '100', ...query }).toString();
  const res = await inject(
    'GET',
    `/api/v1/office-equipment-consumables?${qs}`,
    auth ?? ctx.admin.auth,
  );
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: OfficeEquipmentConsumableDto[] }).items;
}

function patchConsumable(id: string, body: Record<string, unknown>, auth?: Auth) {
  return inject(
    'PATCH',
    `/api/v1/office-equipment-consumables/${id}`,
    auth ?? ctx.admin.auth,
    body,
  );
}

function postStock(
  id: string,
  body: { quantity: number; expectedQuantity: number; reason: string },
  auth?: Auth,
) {
  return inject(
    'POST',
    `/api/v1/office-equipment-consumables/${id}/stock`,
    auth ?? ctx.admin.auth,
    body,
  );
}

/** Успешная правка остатка: предмет проверки — записанное событие, а не код ответа. */
async function stockOk(
  id: string,
  body: { quantity: number; expectedQuantity: number; reason: string },
  auth?: Auth,
): Promise<OfficeEquipmentConsumableStockResultDto> {
  const res = await postStock(id, body, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as OfficeEquipmentConsumableStockResultDto;
}

// ── Модели аппаратов: декорации для совместимости (Р6) ──

let modelNo = 0;
async function createModel(name?: string): Promise<OfficeEquipmentModelDto> {
  modelNo += 1;
  const res = await inject('POST', '/api/v1/office-equipment-models', ctx.admin.auth, {
    equipmentTypeId: ctx.mfpTypeId,
    name: `${MODEL_PREFIX}${name ?? `Pantum M${6500 + modelNo}`} ${RUN}`,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentModelDto;
}

/**
 * Строка модели из её перечня. Нужна ради стыка двух справочников: занятость модели (`isUsed`)
 * считается ОБЕИМИ половинами — карточками техники и привязанными расходниками, — и вторая
 * половина проверяется только отсюда, из файла расходников: в файле моделей расходников нет вовсе.
 */
async function modelRow(name: string): Promise<OfficeEquipmentModelDto> {
  const res = await inject(
    'GET',
    `/api/v1/office-equipment-models?pageSize=100&search=${encodeURIComponent(name)}`,
    ctx.admin.auth,
  );
  expect(res.statusCode, res.body).toBe(200);
  const rows = (res.json() as { items: OfficeEquipmentModelDto[] }).items.filter(
    (m) => m.name === name,
  );
  expect(rows, `в перечне нет ровно одной модели «${name}»`).toHaveLength(1);
  return rows[0]!;
}

// ── Карточки техники: парк, по которому считается счётчик «в парке» (Р12) ──

/** Инвентарный номер: по нему `afterAll` и находит карточки этого прогона. */
let cardNo = 0;
function nextInventory(): string {
  cardNo += 1;
  return `OEC-${RUN}-${cardNo}`;
}

async function createCard(input: {
  modelId: string;
  objectId?: string;
  departmentId?: string | null;
  isActive?: boolean;
}): Promise<OfficeEquipmentDto> {
  const res = await inject('POST', '/api/v1/office-equipment', ctx.admin.auth, {
    equipmentTypeId: ctx.mfpTypeId,
    modelId: input.modelId,
    inventoryNumber: nextInventory(),
    objectId: input.objectId ?? ctx.objectId,
    departmentId: input.departmentId ?? null,
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    location: 'кабинет 214',
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as OfficeEquipmentDto;
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
  serviceRequestId: string | null;
}

/** Журнал расходника снизу вверх — в том порядке, в котором строилась цепочка. */
async function journalOf(id: string): Promise<StockEntryRow[]> {
  const res = await ctx.db.execute<{
    id: string;
    seq: number;
    quantity_before: number;
    quantity_after: number;
    reason: string;
    entry_kind: string;
    service_request_id: string | null;
  }>(sql`
    SELECT id, seq::int AS seq, quantity_before, quantity_after, reason, entry_kind,
           service_request_id
      FROM office_equipment_consumable_stock_entries
     WHERE consumable_id = ${id}
     ORDER BY seq`);
  return res.rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    before: r.quantity_before,
    after: r.quantity_after,
    reason: r.reason,
    kind: r.entry_kind,
    serviceRequestId: r.service_request_id,
  }));
}

async function quantityOf(id: string): Promise<number> {
  const res = await ctx.db.execute<{ quantity: number }>(
    sql`SELECT quantity FROM office_equipment_consumables WHERE id = ${id}`,
  );
  const row = res.rows[0];
  if (!row) throw new Error(`расходника ${id} нет в базе`);
  return row.quantity;
}

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const res = await ctx.db.execute<{ c: number }>(query);
  return res.rows[0]!.c;
}

/**
 * Цепочка непрерывна: первое событие начинается с нуля (до него расходник заведён нулём), каждое
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
 * снятый первым же чтением (приём взят из `office-equipment-models.db.test.ts`).
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
        `${what}: в очереди за бэкендом ${pid} так и не появил${count > 1 ? 'ись' : 'ся'} ` +
          `ожидаемый запрос${expected ? ` (${String(expected)}, нужно ${count})` : ''}; ` +
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
 * Имя таблицы в маске ожидания — С КАВЫЧКАМИ ИЛИ БЕЗ, и это не перестраховка.
 *
 * Источников у текста запроса в очереди два, и пишут они по-разному: drizzle кавычит имена ВСЕГДА
 * (`update "office_equipment_consumables" …`), а сырой SQL пробы — так, как набран в тесте. Маска,
 * собранная под один вид, под другой не подойдёт НИКОГДА, и случай краснеет не там, где ошибка:
 * ждущий на месте и стоит правильно, не совпала только строка. Такой отказ стоит дорого — на него
 * уже потратили время два человека, — поэтому терпимость к кавычкам вынесена сюда раз и навсегда.
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

/** Событие журнала прямым SQL — тем путём, которым в базу ходят скрипты и миграции. */
function insertEntry(
  consumableId: string,
  before: number,
  after: number,
  reason = 'сверка склада',
): ReturnType<typeof sql> {
  return sql`
    INSERT INTO office_equipment_consumable_stock_entries
      (consumable_id, quantity_before, quantity_after, reason, changed_by)
    VALUES (${consumableId}, ${before}, ${after}, ${reason}, ${ctx.admin.id})`;
}

/** Чем опознаётся своё в каждой таблице: по одному условию на таблицу. */
interface Отбор {
  расходники: ReturnType<typeof sql>;
  карточки: ReturnType<typeof sql>;
  модели: ReturnType<typeof sql>;
  учётки: ReturnType<typeof sql>;
  наборы: ReturnType<typeof sql>;
  места: ReturnType<typeof sql>;
}

/** Своё в этом прогоне — точным суффиксом. */
function своё(): Отбор {
  return {
    расходники: sql`code LIKE ${`${CODE_PREFIX}${CODE_RUN}%`}`,
    карточки: sql`inventory_number LIKE ${`OEC-${RUN}-%`}`,
    модели: sql`name LIKE ${`${MODEL_PREFIX}%${RUN}`}`,
    учётки: sql`email LIKE ${`db-oec-%-${RUN}@example.invalid`}`,
    наборы: sql`code LIKE ${`OEC-${RUN}-%`}`,
    места: sql`code LIKE ${`OEC-%-${RUN}`}`,
  };
}

/**
 * Хвосты БРОШЕННЫХ прогонов этого же файла: устойчивый префикс плюс возраст.
 *
 * ВОЗРАСТ — ЕДИНСТВЕННОЕ, ЧТО ОТДЕЛЯЕТ БРОШЕННОЕ ОТ ЖИВОГО, и порог выбран с запасом. Файл целиком
 * проходит за семь секунд, а прогон, упёршийся в чужую пробку, умирает по таймауту хука на 180-й
 * секунде — то есть фикстуры живого соседа не бывают старше трёх минут. Десять минут дают
 * трёхкратный зазор и при этом чистят брошенное уже на следующем запуске, а не через месяц.
 *
 * Сама уборка идёт ТОЛЬКО в `beforeAll`, до заведения своего, — значит навредить себе она не может
 * в принципе: на момент её работы своих строк ещё нет.
 */
function брошенное(): Отбор {
  const давно = sql`created_at < now() - interval '10 minutes'`;
  return {
    расходники: sql`code LIKE ${`${CODE_PREFIX}%`} AND ${давно}`,
    карточки: sql`inventory_number LIKE 'OEC-%' AND ${давно}`,
    модели: sql`name LIKE ${`${MODEL_PREFIX}%`} AND ${давно}`,
    учётки: sql`email LIKE 'db-oec-%@example.invalid' AND ${давно}`,
    наборы: sql`code LIKE 'OEC-%' AND ${давно}`,
    места: sql`code LIKE 'OEC-%' AND ${давно}`,
  };
}

/**
 * Уборка. База общая, и порядок здесь задан не вкусом, а схемой:
 *
 *   1. СТРОКИ ЖУРНАЛА НЕУДАЛЯЕМЫ, И ОБОЙТИ ЭТО НЕЧЕМ. Круг замкнут с обеих сторон: расходник с
 *      движением не удаляется (`ON DELETE RESTRICT`), а сами строки журнала не удаляются триггером
 *      неизменяемости — и это не оплошность, а Р11 целиком. Каскада сюда не ведёт ни одного,
 *      `session_replication_role` триггеру не указ (он `ENABLE ALWAYS`), а `TRUNCATE` унёс бы
 *      вместе со своим и чужое. Значит db-тест, записавший хоть одно событие, либо оставляет свои
 *      строки в общей базе НАВСЕГДА, либо гасит триггер на время уборки. Выбрано второе — и
 *      обставлено так, чтобы цена была наименьшей:
 *
 *      · одной транзакцией: `ALTER TABLE` в Postgres транзакционен, поэтому оборванный прогон
 *        откатывает и гашение — базы с выключенной защитой не остаётся ни при каком исходе;
 *      · включается обратно `ENABLE ALWAYS`, а не `ENABLE`: простое `ENABLE` оставило бы триггер
 *        неработающим на реплике-приёмнике, то есть уборка тихо ослабила бы схему;
 *      · `lock_timeout` короткий: `DISABLE TRIGGER` берёт `ACCESS EXCLUSIVE` на таблицу журнала,
 *        и если её прямо сейчас держит соседний прогон, уборка обязана упасть словами за десять
 *        секунд, а не запереть чужую работу.
 *
 *      Первое, чего это стоит назвать вслух: §9 плана обещает db-тесты, которые «убирают за
 *      собой», но Р11 такой возможности не оставляет — противоречие плана, а не теста;
 *   2. карточки техники — раньше моделей: модель, на которую ссылается карточка, не удаляется;
 *   3. расходники — только после журнала, привязки к моделям уходят каскадом сами;
 *   4. модели — после расходников и карточек (`RESTRICT` с обеих сторон);
 *   5. учётки — после журнала: `changed_by` тоже стоит под `RESTRICT`;
 *   6. наборы — после учёток (`user_grants.grant_id` под `RESTRICT`), площадки и отделы — тоже.
 *
 * Зовётся дважды: в `afterAll` за своим и в `beforeAll` за брошенным. Своё уносится точным
 * суффиксом прогона, брошенное — устойчивым префиксом с оглядкой на возраст, и оба раза это одни и
 * те же шесть шагов в одном и том же порядке: разойдись они, вторая копия сломалась бы первой.
 */
async function убрать(отбор: Отбор): Promise<void> {
  const мои = sql`SELECT id FROM office_equipment_consumables WHERE ${отбор.расходники}`;
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    await tx.execute(sql`
      ALTER TABLE office_equipment_consumable_stock_entries
        DISABLE TRIGGER office_equipment_consumable_stock_immutable`);
    await tx.execute(sql`
      DELETE FROM office_equipment_consumable_stock_entries WHERE consumable_id IN (${мои})`);
    await tx.execute(sql`
      ALTER TABLE office_equipment_consumable_stock_entries
        ENABLE ALWAYS TRIGGER office_equipment_consumable_stock_immutable`);
    await tx.execute(sql`DELETE FROM office_equipment_consumables WHERE ${отбор.расходники}`);
  });
  await ctx.db.execute(sql`DELETE FROM office_equipment WHERE ${отбор.карточки}`);
  await ctx.db.execute(sql`DELETE FROM office_equipment_models WHERE ${отбор.модели}`);
  const учётки = sql`SELECT id FROM users WHERE ${отбор.учётки}`;
  await ctx.db.execute(sql`DELETE FROM audit_log WHERE actor_user_id IN (${учётки})`);
  await ctx.db.execute(sql`DELETE FROM users WHERE ${отбор.учётки}`);
  await ctx.db.execute(sql`DELETE FROM grants WHERE ${отбор.наборы}`);
  await ctx.db.execute(sql`DELETE FROM departments WHERE ${отбор.места}`);
  await ctx.db.execute(sql`DELETE FROM construction_objects WHERE ${отбор.места}`);
}

describe.skipIf(!DB_URL)('расходники оргтехники: журнал остатка, права и совместимость', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    /*
     * Хвосты брошенных прогонов — ДО заведения своего. База общая и живёт между запусками, а
     * `afterAll` отрабатывает не всегда: сегодня она дважды вставала колом (чужие сессии `idle in
     * transaction` с незакрытым `COPY`, за ними очередь и упор в `max_connections`), и от пяти
     * убитых прогонов осталось полсотни учёток и два десятка расходников. Ручная уборка такое
     * лечит, но лечит только после того, как кто-то заметит; здесь она чинится сама — следующим
     * же запуском.
     *
     * Своих строк на этот момент ещё нет, поэтому навредить себе уборка не может; чужому живому
     * прогону — тоже: его фикстуры моложе порога (см. `брошенное`).
     */
    ctx = { db } as Ctx;
    await убрать(брошенное());

    const passwordHash = await hashPassword(PASSWORD);

    // Учётки заводятся SQL: форма учётки — предмет своих тестов, здесь они декорации, без которых
    // не разложить четыре набора прав.
    async function makeUser(tag: string, role: string): Promise<{ id: string; email: string }> {
      const email = `db-oec-${tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${tag}, ${passwordHash},
                ${sql.raw(`'${role}'::role`)}, true, now())
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    const admin = await makeUser('admin', 'admin');
    // Роль обоих носителей — `shtab`: у неё есть `officeEquipment.read` (список и карточка
    // расходника открыты широким правом, Р10) и нет ни ведения парка, ни расходников. Значит
    // разницу в ответах даёт ровно выданный набор, а не роль.
    const manageUser = await makeUser('manage', 'shtab');
    const stockUser = await makeUser('stock', 'shtab');
    // Роль с `officeEquipment.write`: ею проверяется, что ведение парка расходников не открывает.
    const parkUser = await makeUser('park', 'manager');

    // Четыре области счётчика «в парке» (Р12). Числа у них разные намеренно: совпади они, случай
    // перестал бы различать правила.
    const objectUser = await makeUser('obj', 'shtab');
    const deptUser = await makeUser('dept', 'department');
    const deptEmptyUser = await makeUser('deptx', 'department');
    // Сквозная область — от НАДСТРОЙКИ, а не от роли: отдел у него заведомо чужой, и весь парк он
    // видит только потому, что «Согласование ИТ» расширяет область модуля (ADR 0106, решение 2).
    const wideUser = await makeUser('wide', 'department');

    const makeObject = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO construction_objects (code, name, address)
        VALUES (${`OEC-${tag}-${RUN}`}, ${`Тестовая площадка расходников ${tag} ${RUN}`},
                'г Москва, ул Тестовая, д 1')
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const makeDepartment = async (tag: string): Promise<string> => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO departments (code, name)
        VALUES (${`OEC-${tag}-${RUN}`}, ${`Тестовый отдел расходников ${tag} ${RUN}`})
        RETURNING id`);
      return res.rows[0]!.id;
    };

    const objectId = await makeObject('O');
    const foreignObjectId = await makeObject('OF');
    const departmentId = await makeDepartment('D');
    const foreignDepartmentId = await makeDepartment('DF');

    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${objectUser.id}, ${objectId})`);
    await db.execute(sql`
      INSERT INTO user_departments (user_id, department_id)
      VALUES (${deptUser.id}, ${departmentId}),
             (${wideUser.id}, ${foreignDepartmentId})`);
    // Надстройка выдаётся сервисом, а не прямой вставкой: с шага 1a перехода на назначаемые
    // полномочия она пишет две таблицы одной транзакцией, и половина фикстуры оставила бы учётку
    // без прав (тот же довод, что в `office-equipment-models.db.test.ts`).
    const { replaceUserAddons } = await import('../src/services/user-scopes');
    await db.transaction(async (tx) => {
      await replaceUserAddons(tx, wideUser.id, ['office_equipment_it_approver'], admin.id);
    });

    /**
     * Набор с одним правом — собранный, а не системный: системный «Оргтехника: номенклатура»
     * заводит M6 плана переработки заявок и держит в себе ОБА права сразу, а разводить их порознь
     * нужно как раз здесь. Строка `grant_roles` обязательна: право считается соединением с ролью
     * держателя (`grantPermissionsExpr`), и без совпадения роли набор не действует вовсе.
     */
    async function grantOnly(tag: string, permission: Permission, role: string): Promise<string> {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO grants (code, name, is_system)
        VALUES (${`OEC-${RUN}-${tag}`}, ${`Расходники: ${tag} ${RUN}`}, false)
        RETURNING id`);
      const grantId = res.rows[0]!.id;
      await db.execute(sql`
        INSERT INTO grant_roles (grant_id, role) VALUES (${grantId}, ${sql.raw(`'${role}'::role`)})`);
      await db.execute(sql`
        INSERT INTO grant_permissions (grant_id, permission) VALUES (${grantId}, ${permission})`);
      return grantId;
    }

    const manageGrant = await grantOnly('manage', MANAGE, 'shtab');
    const stockGrant = await grantOnly('stock', STOCK, 'shtab');
    await db.execute(sql`
      INSERT INTO user_grants (user_id, grant_id, granted_by, origin)
      VALUES (${manageUser.id}, ${manageGrant}, ${admin.id}, 'manual'),
             (${stockUser.id}, ${stockGrant}, ${admin.id}, 'manual')`);

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

    const types = await db.execute<{ id: string }>(
      sql`SELECT id FROM office_equipment_types WHERE code = 'mfp'`,
    );
    const mfpTypeId = types.rows[0]?.id;
    if (!mfpTypeId) throw new Error('в базе нет типов оргтехники: миграция 0104 не применена');

    ctx = {
      app,
      db,
      closeDb,
      admin: await withAuth(admin),
      manageUser: await withAuth(manageUser),
      stockUser: await withAuth(stockUser),
      parkUser: await withAuth(parkUser),
      objectUser: await withAuth(objectUser),
      deptUser: await withAuth(deptUser),
      deptEmptyUser: await withAuth(deptEmptyUser),
      wideUser: await withAuth(wideUser),
      objectId,
      foreignObjectId,
      departmentId,
      foreignDepartmentId,
      mfpTypeId,
    };
  }, 180_000);

  /** Своё этого прогона — точным суффиксом. Все шесть шагов и их порядок объяснены у `убрать`. */
  afterAll(async () => {
    // Через `?.` каждое звено: `beforeAll` кладёт в `ctx` сперва одну лишь связь с базой (уборка
    // брошенного нужна раньше всего остального), и оборвись он посередине — здесь оказался бы
    // недособранный объект. Уборка своего при этом обязана состояться всё равно.
    await ctx?.app?.close();
    if (ctx?.db) await убрать(своё());
    await ctx?.closeDb?.();
  });

  // ── 1. Заведение и первое событие журнала (Р7) ──

  it('заведение с остатком пишет первое событие «0 → N», с нулём — не пишет ничего', async () => {
    // Начальный остаток — не поле карточки, а ПЕРВОЕ СОБЫТИЕ: цепочка считает, что до него
    // расходник был нулём, поэтому строка выходит «0 → 12». Заведение с нулём событий не пишет
    // вовсе — «0 → 0» это не событие, а его отсутствие, и `CHECK` такую строку не пропустит.
    const withStock = await createConsumable({ quantity: 12 });
    expect(withStock.quantity).toBe(12);
    const journal = await journalOf(withStock.id);
    expect(journal).toHaveLength(1);
    expect(journal[0]!.before).toBe(0);
    expect(journal[0]!.after).toBe(12);
    expect(journal[0]!.reason).toBe(FIRST_ENTRY_REASON);
    // Вид события проставляет сервер, а не клиент, и ссылок на заявку у ручной правки нет.
    expect(journal[0]!.kind).toBe('manual');
    expect(journal[0]!.serviceRequestId).toBeNull();

    const empty = await createConsumable({ quantity: 0 });
    expect(await journalOf(empty.id)).toHaveLength(0);
    expect(empty.hasStockHistory).toBe(false);
  });

  it('первым событием может быть только «0 → N»: «12 → 10» на пустом журнале отбито', async () => {
    /*
     * Это правило выяснила реализация миграции, и оно строже, чем читается в Р7: завести карточку
     * сразу с двенадцатью и первой строкой «12 → 10» нельзя — до неё в журнале пусто, а пустой
     * журнал означает ноль. Порядок «карточка → событие» здесь соблюдён, и остаток карточки
     * совпадает со «стало»: отбивает именно первый конец проверки, а не второй.
     */
    const c = await createConsumable({ quantity: 0 });
    const refusal = await dbRefusal(
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE office_equipment_consumables SET quantity = 10 WHERE id = ${c.id}`,
        );
        await tx.execute(insertEntry(c.id, 12, 10, 'перенос остатка из таблицы'));
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('предыдущее событие оставило 0');
    // Имени ограничения нет — значит бросил триггер, а не `CHECK`: разбор ошибок в маршрутах
    // держится ровно на этом различии.
    expect(refusal.constraint).toBeUndefined();

    // Отказ откатил транзакцию целиком: карточка осталась нулём, журнал — пустым.
    expect(await quantityOf(c.id)).toBe(0);
    expect(await journalOf(c.id)).toHaveLength(0);
  });

  // ── 2. Цепочка сверяется ОБОИМИ концами (Р7) ──

  it('«999 → 12» при остатке 12 не вставляется: сверки одного конца было бы мало', async () => {
    /*
     * ГЛАВНЫЙ СЛУЧАЙ ЦЕПОЧКИ. «Стало» здесь верно — 12 и в событии, и в карточке, — поэтому
     * проверка, сверяющая только последний конец, пропустила бы строку насквозь. А в журнале
     * навсегда осталось бы выдуманное «было», по которому потом считают расход: «999 → 12» читается
     * как «списали 987 картриджей».
     */
    const c = await createConsumable({ quantity: 12 });
    const refusal = await dbRefusal(
      ctx.db.execute(insertEntry(c.id, 999, 12, 'подгон под остаток')),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('предыдущее событие оставило 12');
    expect(refusal.constraint).toBeUndefined();
    expect(await journalOf(c.id)).toHaveLength(1);
  });

  it('«стало», не равное остатку карточки, не вставляется: событие обязано доехать до неё', async () => {
    // Второй конец той же проверки, и он же — запрет события БЕЗ правки карточки: «было» равно
    // остатку (иначе цепочка уже порвана), «стало» обязано равняться ему же, а `CHECK` требует их
    // различия. Порядок «сначала карточка, потом событие» держится именно этим.
    const c = await createConsumable({ quantity: 12 });
    const refusal = await dbRefusal(
      ctx.db.execute(insertEntry(c.id, 12, 5, 'событие без правки карточки')),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('а в карточке 12');
    expect(refusal.constraint).toBeUndefined();
    expect(await quantityOf(c.id)).toBe(12);
    expect(await journalOf(c.id)).toHaveLength(1);
  });

  it('вид события, ссылки на заявку и направление — три разных ограничения', async () => {
    /*
     * «Ручная правка» и «списано по заявке СО-1234» не бывают наполовину: у `manual` обе ссылки
     * пусты, у `issue` и `return` заполнены обе. Иначе в журнале появилась бы выдача, не знающая
     * своей заявки, или ручная правка, притворяющаяся выдачей, — а по этим двум полям потом строят
     * и отчёт по расходу, и адресное сторно. Проверяются ОБА перекоса каждой пары, а не по одному:
     * «заполнено лишнее» и «недостаёт одной» — разные ошибки ввода, и ограничение обязано ловить
     * обе.
     *
     * Направление задаёт ВИД, а не знак разницы, и проверяется тоже с двух сторон: `issue` с ростом
     * и `return` со снижением. Одной стороны мало — она оставила бы половину ограничения без
     * караула, и «возврат», уменьшающий остаток, прошёл бы в журнал, сделав отчёт по расходу
     * неверным при совершенно верной цепочке (сумма считается по видам, а не по знаку).
     *
     * Каждая попытка идёт целой транзакцией в правильном порядке «карточка → событие»: событие,
     * вставленное само по себе, отбила бы цепочка — то есть не то ограничение, о котором случай.
     */
    const c = await createConsumable({ quantity: 12 });

    const попытка = (
      вид: string,
      заявка: string | null,
      строка: string | null,
      стало = 10,
    ): Promise<unknown> =>
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE office_equipment_consumables SET quantity = ${стало} WHERE id = ${c.id}`,
        );
        await tx.execute(sql`
          INSERT INTO office_equipment_consumable_stock_entries
            (consumable_id, entry_kind, service_request_id, service_request_consumable_id,
             quantity_before, quantity_after, reason, changed_by)
          VALUES (${c.id}, ${вид}, ${заявка}, ${строка}, 12, ${стало}, 'проверка семантики',
                  ${ctx.admin.id})`);
      });

    const СВЯЗКИ = 'office_equipment_consumable_stock_request_links_check';
    const НАПРАВЛЕНИЕ = 'office_equipment_consumable_stock_direction_check';

    // Ручная правка со ссылками — в любом наборе: и с обеими, и с одной. Вторая половина важна не
    // меньше первой: «ручная правка, но заявка почему-то есть» это и есть выдача, потерявшая свой
    // вид.
    expect((await dbRefusal(попытка('manual', randomUUID(), randomUUID()))).constraint).toBe(
      СВЯЗКИ,
    );
    expect((await dbRefusal(попытка('manual', randomUUID(), null))).constraint).toBe(СВЯЗКИ);
    expect((await dbRefusal(попытка('manual', null, randomUUID()))).constraint).toBe(СВЯЗКИ);

    // Выдача без ссылок — и без любой одной из двух: событие по заявке обязано знать и заявку, и
    // строку, иначе сторно не к чему привязать.
    expect((await dbRefusal(попытка('issue', null, null))).constraint).toBe(СВЯЗКИ);
    expect((await dbRefusal(попытка('issue', randomUUID(), null))).constraint).toBe(СВЯЗКИ);
    expect((await dbRefusal(попытка('issue', null, randomUUID()))).constraint).toBe(СВЯЗКИ);

    // Направление — обе стороны: выдача не увеличивает остаток, возврат не уменьшает.
    expect((await dbRefusal(попытка('issue', randomUUID(), randomUUID(), 15))).constraint).toBe(
      НАПРАВЛЕНИЕ,
    );
    expect((await dbRefusal(попытка('return', randomUUID(), randomUUID()))).constraint).toBe(
      НАПРАВЛЕНИЕ,
    );

    // Ни одна попытка следа не оставила: каждая откатилась целиком.
    expect(await quantityOf(c.id)).toBe(12);
    expect(await journalOf(c.id)).toHaveLength(1);
  }, 60_000);

  it('несуществующая заявка отбивается внешним ключом — до него доходит только цельное событие', async () => {
    /*
     * Внешний ключ `service_request_id → service_requests` караулит последним и потому проверяется
     * отдельно: `CHECK` считаются РАНЬШЕ ключей, и почти всякая порченая строка до ключа не
     * доезжает вовсе — её отбивает связка или направление. Чтобы дойти до ключа, событие обязано
     * быть безупречным во всём остальном: `issue`, обе ссылки заполнены, остаток снижается, цепочка
     * сходится. Тогда и только тогда становится видно, что заявки с таким номером нет.
     *
     * Пока ключ один: на строку заявки (`service_request_consumable_id`) его нет — таблицы строк
     * ещё не существует, её создаёт M12 плана переработки заявок и той же миграцией достраивает
     * СОСТАВНОЙ ключ. Поэтому выдуманная строка заявки здесь проходит молча, и это не дефект, а
     * зафиксированная граница выпуска.
     */
    const c = await createConsumable({ quantity: 12 });
    const выдуманнаяЗаявка = randomUUID();
    const refusal = await dbRefusal(
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE office_equipment_consumables SET quantity = 10 WHERE id = ${c.id}`,
        );
        await tx.execute(sql`
          INSERT INTO office_equipment_consumable_stock_entries
            (consumable_id, entry_kind, service_request_id, service_request_consumable_id,
             quantity_before, quantity_after, reason, changed_by)
          VALUES (${c.id}, 'issue', ${выдуманнаяЗаявка}, ${randomUUID()}, 12, 10,
                  'выдано по заявке, которой нет', ${ctx.admin.id})`);
      }),
    );
    expect(refusal.code).toBe('23503');
    // Имя ключа Postgres собирает сам и обрезает до 63 символов — отсюда усечённое «entri».
    expect(refusal.constraint).toBe(
      'office_equipment_consumable_stock_entri_service_request_id_fkey',
    );
    expect(await quantityOf(c.id)).toBe(12);
    expect(await journalOf(c.id)).toHaveLength(1);
  }, 60_000);

  // ── 3. Журнал неизменяем (Р11) ──

  it('строку журнала нельзя ни поправить, ни удалить прямым запросом', async () => {
    // `RESTRICT` со стороны расходника защищает историю ЦЕЛИКОМ, но не построчно, а «журнал,
    // который нельзя подчистить» обязан означать именно это. Ошибку исправляют следующим событием
    // — так исправление остаётся видимым, а не заменяет собой то, что было.
    const c = await createConsumable({ quantity: 7 });
    const [entry] = await journalOf(c.id);

    const edited = await dbRefusal(
      ctx.db.execute(sql`
        UPDATE office_equipment_consumable_stock_entries
           SET reason = 'подчистили задним числом' WHERE id = ${entry!.id}`),
    );
    expect(edited.code).toBe('23514');
    expect(edited.message).toContain('неизменяем');

    const removed = await dbRefusal(
      ctx.db.execute(
        sql`DELETE FROM office_equipment_consumable_stock_entries WHERE id = ${entry!.id}`,
      ),
    );
    expect(removed.code).toBe('23514');
    expect(removed.message).toContain('неизменяем');

    // Строка на месте и в прежнем виде: оба отказа откатили свою транзакцию целиком.
    const after = await journalOf(c.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.reason).toBe(FIRST_ENTRY_REASON);
  });

  it('номер события назначить вставкой можно, а порвать хвост журнала — нельзя', async () => {
    /*
     * ПОПРАВКА К КОММЕНТАРИЮ МИГРАЦИИ. `0172` объясняет `GENERATED ALWAYS` тем, что номер «нельзя
     * назначить вставкой»: цепочку, номера в которой раздаёт клиент, можно переписать. Обещание
     * неточно — `OVERRIDING SYSTEM VALUE` номер назначает, и первая половина случая это
     * показывает. Вреда от этого нет, но держится порядок не запретом, а другим: отложенная
     * проверка покрытия читает ХВОСТ по `max(seq)`, и событие, вставленное ПЕРЕД хвостом, оставляет
     * карточку разошедшейся с ним — и отменяется на коммите.
     *
     * Случай написан на том, что верно, а не на том, что обещано: он краснеет, если проверка
     * покрытия начнёт искать «последнее событие» по времени вместо `seq`, — а именно эту подмену
     * `seq` и предотвращает («две правки одной секунды по `created_at` неразличимы»).
     */
    const c = await createConsumable({ quantity: 12 });
    const [первое] = await journalOf(c.id);
    const вперёд = первое!.seq + 1_000_000;

    // 1. Номер назначается — и цепочке это безразлично: она смотрит на «было» и «стало», а не на
    //    номер. Событие с назначенным номером проходит целиком.
    await ctx.db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE office_equipment_consumables SET quantity = 10 WHERE id = ${c.id}`,
      );
      await tx.execute(sql`
        INSERT INTO office_equipment_consumable_stock_entries
          (seq, consumable_id, quantity_before, quantity_after, reason, changed_by)
        OVERRIDING SYSTEM VALUE
        VALUES (${вперёд}, ${c.id}, 12, 10, 'событие с назначенным номером', ${ctx.admin.id})`);
    });
    const журнал = await journalOf(c.id);
    expect(журнал.at(-1)!.seq, 'номер не назначился — обещание миграции вдруг стало верным').toBe(
      вперёд,
    );
    expectChain(журнал, await quantityOf(c.id));

    // 2. А событие ПЕРЕД хвостом отменяется на коммите: цепочку оно проходит (сверяется с хвостом),
    //    но хвостом не становится — и карточка расходится с ним. Ровно это и защищает историю от
    //    переписывания задним номером.
    const refusal = await dbRefusal(
      ctx.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE office_equipment_consumables SET quantity = 8 WHERE id = ${c.id}`,
        );
        await tx.execute(sql`
          INSERT INTO office_equipment_consumable_stock_entries
            (seq, consumable_id, quantity_before, quantity_after, reason, changed_by)
          OVERRIDING SYSTEM VALUE
          VALUES (${первое!.seq - 1}, ${c.id}, 10, 8, 'подложено под хвост', ${ctx.admin.id})`);
      }),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.message).toContain('последнее событие журнала оставило 10');
    expect(refusal.constraint).toBeUndefined();

    // Журнал и карточка остались как были: отказ откатил транзакцию целиком.
    expect(await journalOf(c.id)).toHaveLength(2);
    expect(await quantityOf(c.id)).toBe(10);
  }, 60_000);

  // ── 4. Остаток без события невозможен: отложенная проверка (Р7) ──

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
    const fresh = await createConsumable({ quantity: 0 });
    const moved = await createConsumable({ quantity: 12 });
    const c = await openClient();
    try {
      await c.query('BEGIN');
      const upd = await c.query(
        'UPDATE office_equipment_consumables SET quantity = 7 WHERE id = $1',
        [fresh.id],
      );
      expect(upd.rowCount, 'сама правка обязана пройти: проверка отложена до коммита').toBe(1);
      const refusal = await dbRefusal(c.query('COMMIT'));
      expect(refusal.code).toBe('23514');
      expect(refusal.message).toContain('в журнале нет ни одного события');
      expect(refusal.constraint).toBeUndefined();

      await c.query('BEGIN');
      await c.query('UPDATE office_equipment_consumables SET quantity = 7 WHERE id = $1', [
        moved.id,
      ]);
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
    const c = await createConsumable({ quantity: 12 });
    const client = await openClient();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE office_equipment_consumables SET quantity = 7 WHERE id = $1', [
        c.id,
      ]);
      await client.query(
        `INSERT INTO office_equipment_consumable_stock_entries
           (consumable_id, quantity_before, quantity_after, reason, changed_by)
         VALUES ($1, 12, 7, 'сверка склада: пять выдали без заявки', $2)`,
        [c.id, ctx.admin.id],
      );
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
    expectChain(await journalOf(c.id), await quantityOf(c.id));
    expect(await quantityOf(c.id)).toBe(7);
  }, 60_000);

  it('две правки остатка в одной транзакции (12 → 10 → 8) проходят целиком', async () => {
    /*
     * Отложенные триггеры срабатывают на коммите ОБА, и первый из них, сравнивая свой снимок «стало
     * 10» с журналом, где уже 8, дал бы отказ на ровном месте. Не даёт потому, что проверка
     * принимает идентификатор и ПЕРЕЧИТЫВАЕТ по нему состояние: у обоих срабатываний оно одно и то
     * же — и оно верное. Случай и сторожит это свойство: перепиши функцию на `NEW.quantity`, и он
     * покраснеет, а все остальные останутся зелёными.
     */
    const c = await createConsumable({ quantity: 12 });
    const client = await openClient();
    try {
      await client.query('BEGIN');
      const step = async (before: number, after: number, reason: string): Promise<void> => {
        await client.query('UPDATE office_equipment_consumables SET quantity = $1 WHERE id = $2', [
          after,
          c.id,
        ]);
        await client.query(
          `INSERT INTO office_equipment_consumable_stock_entries
             (consumable_id, quantity_before, quantity_after, reason, changed_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [c.id, before, after, reason, ctx.admin.id],
        );
      };
      await step(12, 10, 'выдали два в бухгалтерию');
      await step(10, 8, 'выдали ещё два в приёмную');
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }

    const journal = await journalOf(c.id);
    expect(journal.map((e) => [e.before, e.after])).toEqual([
      [0, 12],
      [12, 10],
      [10, 8],
    ]);
    expectChain(journal, await quantityOf(c.id));
    expect(await quantityOf(c.id)).toBe(8);
  }, 60_000);

  // ── 5. Гонка остатка через маршрут (Р7) ──

  it('два одновременных POST /:id/stock от 12: один проходит, второй — 409 с текущим числом', async () => {
    /*
     * ГОНКА — СВОЙСТВО ПАРЫ ЗАПРОСОВ, и без настоящей встречи случай ничего не стоит: последовательные
     * запросы этой ветки не касаются вовсе — второй прочитал бы уже новое число и получил бы тот же
     * 409 от простой сверки, не постояв ни на одной блокировке.
     *
     * Поэтому сцена собирается держателем: соседнее соединение берёт строку расходника `FOR UPDATE`
     * и не отпускает, обе двери приходят в это окно и обязаны встать в очередь на СТРОКЕ — то есть
     * на первом шаге своей транзакции, до всякой сверки. Убери из маршрута `SELECT … FOR UPDATE`, и
     * очереди на строке не окажется вовсе: обе двери прочитают 12, обе пройдут сверку, и вторая
     * доедет до триггера цепочки с «было 12» при журнале, где уже 10, — то есть вместо 409 человек
     * получит 500.
     *
     * ОЧЕРЕДЬ ЗА СТРОКОЙ — ЦЕПОЧКА, А НЕ ВЕЕР, и спрашивать её надо именно так. За чужой строкой
     * ждут не «оба за держателем»: первый ждущий забирает временную блокировку самого кортежа и
     * встаёт на `transactionid` держателя, а второй упирается уже в НЕГО и ждёт на `tuple`. Поэтому
     * `pg_blocking_pids` называет держателя только у первого — спроси «двое за держателем», и
     * рабочий код не дождётся второго никогда.
     *
     * Кто из двоих придёт первым, сцена не задаёт: порядок выбирает менеджер блокировок. Поэтому
     * ожидания написаны от ответа, а не от порядка вызовов.
     */
    const c = await createConsumable({ quantity: 12 });
    const holder = await openClient();
    const probe = await openProbe();
    let first: ReturnType<typeof postStock> | undefined;
    let second: ReturnType<typeof postStock> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM office_equipment_consumables WHERE id = $1 FOR UPDATE', [
        c.id,
      ]);

      first = postStock(c.id, {
        quantity: 10,
        expectedQuantity: 12,
        reason: 'выдали два картриджа в бухгалтерию',
      });
      second = postStock(c.id, {
        quantity: 8,
        expectedQuantity: 12,
        reason: 'выдали четыре картриджа в приёмную',
      });

      const forUpdate = new RegExp(`${таблица('office_equipment_consumables')}.+for update`, 'is');
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
        'первая правка не встала на строке расходника — блокировки в маршруте нет',
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
      const written = winner.json() as OfficeEquipmentConsumableStockResultDto;
      expect(written.entry).not.toBeNull();

      // Проигравшему называется ТЕКУЩЕЕ число прямо в тексте: без него окно правки предложит
      // переспросить ровно то же самое.
      expect(loser.json().message).toContain(`сейчас ${written.consumable.quantity}`);

      // Журнал остался непрерывной цепочкой, а итог совпал с последней строкой — то есть гонка
      // разошлась отказом, а не второй записью поверх первой.
      const journal = await journalOf(c.id);
      expect(journal).toHaveLength(2);
      expectChain(journal, await quantityOf(c.id));
      expect(journal.at(-1)!.after).toBe(written.consumable.quantity);
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
    const c = await createConsumable({ quantity: 5 });
    const before = await detailOf(c.id);

    const same = await stockOk(c.id, {
      quantity: 5,
      expectedQuantity: 5,
      reason: 'пересчитали коробки, всё сходится',
    });
    expect(same.entry).toBeNull();
    expect(same.consumable.quantity).toBe(5);

    const after = await detailOf(c.id);
    expect(after.stockEntries).toHaveLength(before.stockEntries.length);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('два соединения правят остаток прямым SQL: двух строк с одним «было» не выходит', async () => {
    /*
     * §9 плана обещает этот случай под именем «прямая вставка мимо маршрута берёт блокировку сама».
     * Написать его как обещано НЕЛЬЗЯ, и это стоит записать здесь, чтобы следующий читатель не
     * пытался: корректная прямая вставка обязана идти ПОСЛЕ правки карточки (цепочка сверяет
     * «стало» с фактическим остатком), а `UPDATE` уже берёт строчную блокировку — сериализует он.
     * `SELECT … FOR UPDATE` внутри триггера к этому моменту берёт замок, который транзакция и так
     * держит.
     *
     * ЗАМЕРЕНО, А НЕ ВЫВЕДЕНО: снятие `FOR UPDATE` из функции цепочки не красит ни одного случая
     * файла — все 31 остаются зелёными. Причина в том, что события БЕЗ предшествующей правки
     * карточки не бывает вовсе: «стало» обязано равняться остатку, «было» — хвосту журнала, а в
     * согласованной базе это одно и то же число, и `CHECK «было ≠ стало»` такую строку не пустит.
     * Значит запереть карточку первой всегда успевает сам `UPDATE`.
     *
     * Что случай проверяет на самом деле — то, ради чего §9 его и просил: гонка двух кладовщиков
     * мимо маршрута не оставляет в журнале двух строк с одним «было». Держит это сверка «было» с
     * хвостом, и на её снятии случай краснеет.
     */
    const c = await createConsumable({ quantity: 12 });
    const первый = await openClient();
    const второй = await openClient();
    const probe = await openProbe();
    let ждущая: Promise<unknown> | undefined;
    try {
      await первый.query('BEGIN');
      await второй.query('BEGIN');
      await первый.query('UPDATE office_equipment_consumables SET quantity = 10 WHERE id = $1', [
        c.id,
      ]);

      // Второй кладовщик читал те же 12 и правит от них же. Его `UPDATE` встаёт в очередь за
      // первым — на СТРОКЕ (`transactionid`), то есть до всякого триггера.
      ждущая = второй.query('UPDATE office_equipment_consumables SET quantity = 8 WHERE id = $1', [
        c.id,
      ]);
      const ждёт = await oneQueuedBehind(
        probe,
        await backendPid(первый),
        'правка остатка вторым соединением',
        new RegExp(`update .*${таблица('office_equipment_consumables')}`, 'i'),
      );
      expect(ждёт.waitEvent, 'вторая правка не встала на строке — сцены гонки не вышло').toBe(
        'transactionid',
      );

      await первый.query(
        `INSERT INTO office_equipment_consumable_stock_entries
           (consumable_id, quantity_before, quantity_after, reason, changed_by)
         VALUES ($1, 12, 10, 'выдали два', $2)`,
        [c.id, ctx.admin.id],
      );
      await первый.query('COMMIT');

      // Очередь разошлась: правка второго применилась поверх уже закоммиченных 10.
      await ждущая;
      ждущая = undefined;

      // А вот его событие «было 12» в журнал не проходит: хвост оставил 10.
      const refusal = await dbRefusal(
        второй.query(
          `INSERT INTO office_equipment_consumable_stock_entries
             (consumable_id, quantity_before, quantity_after, reason, changed_by)
           VALUES ($1, 12, 8, 'выдали ещё четыре', $2)`,
          [c.id, ctx.admin.id],
        ),
      );
      expect(refusal.code).toBe('23514');
      expect(refusal.message).toContain('предыдущее событие оставило 10');
      await второй.query('ROLLBACK');
    } finally {
      await ждущая?.catch(() => undefined);
      await первый.query('ROLLBACK').catch(() => undefined);
      await второй.query('ROLLBACK').catch(() => undefined);
      await первый.end();
      await второй.end();
      await probe.end();
    }

    // В журнале ровно одна правка сверх заведения, и цепочка цела.
    const journal = await journalOf(c.id);
    expect(journal.map((e) => [e.before, e.after])).toEqual([
      [0, 12],
      [12, 10],
    ]);
    expectChain(journal, await quantityOf(c.id));
  }, 60_000);

  // ── 6. Написание кода (Р5) ──

  it('дубль в другом регистре и с неразрывным пробелом — 409 маршрута, а не вторая строка', async () => {
    /*
     * Правило кода СВОЁ, не такое, как у имени модели: пробельные символы удаляются, а не
     * схлопываются (в коде учётной системы их не бывает вовсе, а неразрывный из Word приезжает
     * регулярно), регистр поднимается. Живёт оно функцией базы и стоит сразу в трёх местах —
     * уникальном индексе, `CHECK` и проверке занятости в маршруте; разойдись они хоть на символ,
     * маршрут перестал бы находить то, что отвергает индекс, и человек получил бы 500 с именем
     * индекса вместо слов.
     */
    const code = nextCode();
    const first = await createConsumable({ code });
    // В справочник код лёг уже нормализованным — маршрут прогнал ввод через функцию базы.
    expect(first.code).toBe(code);

    const disguised = `${code.slice(0, 5).toLowerCase()}${NBSP}${code.slice(5).toLowerCase()}`;
    const dup = await inject(
      'POST',
      '/api/v1/office-equipment-consumables',
      ctx.admin.auth,
      consumableBody({ code: disguised }),
    );
    expect(dup.statusCode, dup.body).toBe(409);
    expect(dup.json().message).toContain('уже заведён');
    // Пометка поля обязательна: без пути поля портал показывает 409 тостом поверх формы, то есть
    // мимо того единственного поля, которое человеку и надо исправить.
    expect(dup.json().fields?.code).toBeTruthy();

    // И в справочнике по-прежнему одна строка с этим ключом, а не две.
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM office_equipment_consumables
         WHERE office_equipment_consumable_code_key(code)
             = office_equipment_consumable_code_key(${code})`),
    ).toBe(1);
  });

  it('код с пробелом внутри не проходит CHECK при прямом INSERT', async () => {
    // Без этой проверки правило держал бы только индекс, то есть ключ, — а в самой карточке остался
    // бы «Д000 0093569» с внутренним пробелом: уникальность соблюдена, дефект тихий, и ломает он
    // ровно ту сверку глазами со счётом, ради которой наименование хранится дословно.
    const refusal = await dbRefusal(
      ctx.db.execute(sql`
        INSERT INTO office_equipment_consumables (code, name)
        VALUES (${`Д${CODE_RUN} 900`}, ${`Тонер с мусором переноса ${RUN} (шт)`})`),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.constraint).toBe('office_equipment_consumables_code_normalized_check');
  });

  it('ищут обеими половинами карточки: и по коду, и по наименованию (Р9)', async () => {
    // «Pantum» помнят на слух, «Д0000337733» спрашивают у счёта — и обе половины обязаны находить
    // одну и ту же строку.
    const code = nextCode();
    const name = `Картридж PC-211EV ${RUN} (шт)`;
    const c = await createConsumable({ code, name });

    expect((await listConsumables({ search: code.toLowerCase() })).map((r) => r.id)).toEqual([
      c.id,
    ]);
    expect((await listConsumables({ search: `PC-211EV ${RUN}` })).map((r) => r.id)).toEqual([c.id]);
  });

  // ── 6б. Цвет позиции (Р5) ──

  it('цвет: у позиции он свой, «нет цвета» — это `null`, а пустой строке в базу хода нет', async () => {
    /*
     * Цвет — свойство КАРТОЧКИ, а не строки заявки: складскую позицию определяет код, и если
     * учётная система ведёт чёрный, голубой и комплект отдельными кодами, это три позиции с тремя
     * НЕЗАВИСИМЫМИ остатками. Позиция «комплект» на четыре тубы не раскладывается: разложить её
     * значило бы выдумать четыре остатка, которых в учёте нет.
     */
    const black = await createConsumable({ color: 'чёрный', quantity: 3 });
    const cyan = await createConsumable({ color: 'голубой', quantity: 5 });
    const kit = await createConsumable({ color: 'комплект', quantity: 1 });
    expect([black.color, cyan.color, kit.color]).toEqual(['чёрный', 'голубой', 'комплект']);
    expect([black.quantity, cyan.quantity, kit.quantity]).toEqual([3, 5, 1]);

    // Правка остатка одной позиции соседних не касается — это разные складские строки.
    await stockOk(cyan.id, { quantity: 2, expectedQuantity: 5, reason: 'выдали три голубых' });
    expect(await quantityOf(black.id)).toBe(3);
    expect(await quantityOf(kit.id)).toBe(1);

    // «Нет цвета» пишется `null` и только им: у чёрно-белой техники цвета нет, и пустая строка
    // означала бы то же самое вторым способом — а два представления одного состояния расходятся
    // на первом же отборе «позиции без цвета».
    const plain = await createConsumable();
    expect(plain.color).toBeNull();
    const blanked = await patchConsumable(black.id, { color: '' });
    expect(blanked.statusCode, blanked.body).toBe(200);
    expect((blanked.json() as OfficeEquipmentConsumableDto).color).toBeNull();

    // Второй двери у пустой строки тоже нет: приведение к `null` делает контракт, а `CHECK`
    // держит то же правило для скриптов и заливок.
    const refusal = await dbRefusal(
      ctx.db.execute(sql`
        INSERT INTO office_equipment_consumables (code, name, color)
        VALUES (${nextCode()}, ${`Тонер без цвета ${RUN} (шт)`}, '')`),
    );
    expect(refusal.code).toBe('23514');
    expect(refusal.constraint).toBe('office_equipment_consumables_color_not_blank_check');
  });

  // ── 7. Признак движения: одинаков в списке и в карточке ──

  it('«есть движение» одинаков в списке и в карточке — и истинен при непустом журнале', async () => {
    /*
     * ЛОВУШКА, РАДИ КОТОРОЙ СЛУЧАЙ И СТОИТ. Признак собран коррелированным `EXISTS`, а собирая
     * список столбцов, drizzle помечает односоставный `FROM` и переписывает колонки ЭТОЙ ЖЕ
     * таблицы в голые идентификаторы: `"office_equipment_consumables"."id"` становится `"id"` и
     * разрешается уже в таблицу самого подзапроса — то есть «событие моего расходника»
     * превращается в «`consumable_id` = собственный `id` события». Отказа при этом не бывает: обе
     * колонки существуют, запрос законен, Postgres молча отвечает «ничего нет».
     *
     * Наружу это выходит признаком «движения нет» у карточки с непустым журналом — портал предложит
     * удаление, а `RESTRICT` ответит на него 500 вместо слов.
     *
     * Спрашивается признак у ОБЕИХ дверей: и список, и карточка по `id` — запросы односоставные
     * оба, и сломанное выражение одинаково промолчало бы в каждом. Замер (см. преамбулу) уточняет,
     * КАКАЯ форма ломается: колонка, вписанная в выражение столбца на месте. Через отдельный
     * `sql`-объект — как сегодня в маршруте — квалификация сохраняется даже у колоночного чанка,
     * поэтому подмена самой константы этот случай не красит, а вписывание колонки на место — красит.
     */
    const moved = await createConsumable({ quantity: 4 });
    const untouched = await createConsumable({ quantity: 0 });
    expect(await journalOf(moved.id)).toHaveLength(1);

    const movedDetail = await detailOf(moved.id);
    const untouchedDetail = await detailOf(untouched.id);
    expect(movedDetail.hasStockHistory).toBe(true);
    expect(movedDetail.stockEntries).toHaveLength(1);
    expect(untouchedDetail.hasStockHistory).toBe(false);
    expect(untouchedDetail.stockEntries).toHaveLength(0);

    const [movedRow] = await listConsumables({ search: moved.code });
    const [untouchedRow] = await listConsumables({ search: untouched.code });
    expect(movedRow!.hasStockHistory).toBe(movedDetail.hasStockHistory);
    expect(untouchedRow!.hasStockHistory).toBe(untouchedDetail.hasStockHistory);
  });

  // ── 8. Удаление и гашение (Р11) ──

  it('пока журнал пуст, расходник удаляется совсем, а привязки уходят каскадом', async () => {
    // Так убирают опечатку первого дня. Привязка к модели удалению не мешает: это разметка
    // совместимости, а не история (Р6).
    const model = await createModel();
    const c = await createConsumable({ quantity: 0, modelIds: [model.id] });
    expect(c.models).toHaveLength(1);

    const res = await inject(
      'DELETE',
      `/api/v1/office-equipment-consumables/${c.id}`,
      ctx.admin.auth,
    );
    expect(res.statusCode, res.body).toBe(200);

    expect(
      await countRows(
        sql`SELECT count(*)::int AS c FROM office_equipment_consumables WHERE id = ${c.id}`,
      ),
    ).toBe(0);
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM office_equipment_consumable_models
         WHERE consumable_id = ${c.id}`),
    ).toBe(0);
  });

  it('с движением — 409 словами от маршрута и RESTRICT от схемы при прямом DELETE', async () => {
    // Правило держит СХЕМА, а не вежливость маршрута: `ON DELETE RESTRICT` журнала. Проверка в
    // маршруте стоит лишь затем, чтобы человек прочитал слова, а не имя ограничения.
    const c = await createConsumable({ quantity: 3 });
    const res = await inject(
      'DELETE',
      `/api/v1/office-equipment-consumables/${c.id}`,
      ctx.admin.auth,
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().message).toContain('есть движение');

    const refusal = await dbRefusal(
      ctx.db.execute(sql`DELETE FROM office_equipment_consumables WHERE id = ${c.id}`),
    );
    expect(refusal.code).toBe('23503');
    expect(refusal.constraint).toBe('office_equipment_consumable_stock_entries_consumable_id_fkey');

    // Карточка на месте: гасят такую флагом, а не удаляют.
    const dimmed = await patchConsumable(c.id, { isActive: false });
    expect(dimmed.statusCode, dimmed.body).toBe(200);
    expect((dimmed.json() as OfficeEquipmentConsumableDto).isActive).toBe(false);
  });

  // ── 9. Права: ведение номенклатуры и правка остатка разведены (Р10) ──

  it('у кого только `stock`: остаток правит, номенклатуру не ведёт', async () => {
    const c = await createConsumable({ quantity: 12 });

    // Читать он вправе широким `officeEquipment.read` — подобрать позицию при заведении заявки
    // должен каждый, кому видна оргтехника.
    const seen = await detailOf(c.id, ctx.stockUser.auth);
    expect(seen.quantity).toBe(12);

    const written = await stockOk(
      c.id,
      { quantity: 9, expectedQuantity: 12, reason: 'выдали три картриджа' },
      ctx.stockUser.auth,
    );
    expect(written.entry?.quantityAfter).toBe(9);

    const created = await inject(
      'POST',
      '/api/v1/office-equipment-consumables',
      ctx.stockUser.auth,
      consumableBody({}),
    );
    expect(created.statusCode, created.body).toBe(403);
    expect(created.json().message).toBe(MANAGE_DENIED);

    const patched = await patchConsumable(
      c.id,
      { comment: 'лежит на второй полке' },
      ctx.stockUser.auth,
    );
    expect(patched.statusCode, patched.body).toBe(403);
    expect(patched.json().message).toBe(MANAGE_DENIED);

    const removed = await inject(
      'DELETE',
      `/api/v1/office-equipment-consumables/${c.id}`,
      ctx.stockUser.auth,
    );
    expect(removed.statusCode, removed.body).toBe(403);
    expect(removed.json().message).toBe(MANAGE_DENIED);
  });

  it('у кого только `manage`: ведёт номенклатуру, но остатка не касается', async () => {
    // Обратная сторона того же решения: завести позицию в справочнике и пересчитать коробки на
    // полке — разные работы, и делают их не обязательно одни руки.
    const c = await createConsumable({ quantity: 0, auth: ctx.manageUser.auth });

    const patched = await patchConsumable(
      c.id,
      { name: `Тонер Ricoh 201 ${RUN} (шт)` },
      ctx.manageUser.auth,
    );
    expect(patched.statusCode, patched.body).toBe(200);

    const stock = await postStock(
      c.id,
      { quantity: 4, expectedQuantity: 0, reason: 'привезли четыре' },
      ctx.manageUser.auth,
    );
    expect(stock.statusCode, stock.body).toBe(403);
    expect(stock.json().message).toBe(STOCK_DENIED);
    // Отказ стража — до всякой записи: ни карточка, ни журнал не тронуты.
    expect(await quantityOf(c.id)).toBe(0);
    expect(await journalOf(c.id)).toHaveLength(0);

    const removed = await inject(
      'DELETE',
      `/api/v1/office-equipment-consumables/${c.id}`,
      ctx.manageUser.auth,
    );
    expect(removed.statusCode, removed.body).toBe(200);
  });

  it('`officeEquipment.write` расходников не открывает вовсе', async () => {
    // То право открывает ВЕСЬ ПАРК — карточки техники, модели, перемещения, — а номенклатуру ведёт
    // один человек, которому парк править незачем. Слей их в одно, и обратное тоже стало бы правдой.
    const c = await createConsumable({ quantity: 6 });

    const seen = await listConsumables({ search: c.code }, ctx.parkUser.auth);
    expect(seen.map((r) => r.id)).toEqual([c.id]);

    const created = await inject(
      'POST',
      '/api/v1/office-equipment-consumables',
      ctx.parkUser.auth,
      consumableBody({}),
    );
    expect(created.statusCode, created.body).toBe(403);
    expect(created.json().message).toBe(MANAGE_DENIED);

    const stock = await postStock(
      c.id,
      { quantity: 5, expectedQuantity: 6, reason: 'один забрали' },
      ctx.parkUser.auth,
    );
    expect(stock.statusCode, stock.body).toBe(403);
    expect(stock.json().message).toBe(STOCK_DENIED);
  });

  // ── 10. Совместимость с моделями (Р6, Р11) ──

  it('привязка набором: повтор внутри набора сводится, снятие — свободно', async () => {
    /*
     * Набор приходит ПОЛНЫМ, поэтому повтор внутри него — не просьба завести две одинаковые
     * привязки, а мусор формы или файла: свести его надо ДО записи, иначе второй такой же элемент
     * дал бы `23505` по чужому ограничению — то есть 500 там, где человек ничего дурного не просил.
     */
    const first = await createModel('Ricoh IM 350');
    const second = await createModel('Ricoh IM 550');
    const c = await createConsumable({ modelIds: [second.id, first.id] });
    // Порядок — по имени модели: набор показывается перечислением, и порядок вставки читался бы
    // как случайный.
    expect(c.models.map((m) => m.name)).toEqual([first.name, second.name]);

    const withDuplicate = await patchConsumable(c.id, {
      modelIds: [second.id, second.id, first.id],
    });
    expect(withDuplicate.statusCode, withDuplicate.body).toBe(200);
    expect((withDuplicate.json() as OfficeEquipmentConsumableDto).models).toHaveLength(2);
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM office_equipment_consumable_models
         WHERE consumable_id = ${c.id}`),
    ).toBe(2);

    // Пустой набор — это «снять все», а отсутствие поля — «связи не трогать»: разные просьбы.
    const cleared = await patchConsumable(c.id, { modelIds: [] });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((cleared.json() as OfficeEquipmentConsumableDto).models).toEqual([]);

    const untouched = await patchConsumable(c.id, { comment: 'связи не трогаем' });
    expect((untouched.json() as OfficeEquipmentConsumableDto).models).toEqual([]);
  });

  it('несуществующая модель — 400 словами, а не нарушением ключа', async () => {
    // Проверка стоит до записи: без неё выдуманный идентификатор превратился бы в 500 с именем
    // внешнего ключа вместо ответа про поле.
    const c = await createConsumable();
    const res = await patchConsumable(c.id, { modelIds: [randomUUID()] });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toBe('Модель аппарата не найдена');
    expect(res.json().fields?.modelIds).toBeTruthy();
    // Отказ откатил транзакцию целиком: прежних привязок он не тронул.
    expect((await detailOf(c.id)).models).toEqual([]);
  });

  it('фильтр по модели отдаёт ровно привязанные расходники', async () => {
    // «Что подходит к Ricoh IM 350» — вопрос из окна моделей и из карточки аппарата. Отбор идёт
    // `EXISTS`, а не соединением: соединение по связи много-ко-многим размножило бы строку по числу
    // её моделей, и `total` перестал бы быть числом карточек.
    const model = await createModel('Kyocera M2040');
    const fits = await createConsumable({ modelIds: [model.id] });
    const alsoFits = await createConsumable({ modelIds: [model.id] });
    await createConsumable();

    const rows = await listConsumables({ modelId: model.id, search: RUN });
    expect(rows.map((r) => r.id).sort()).toEqual([fits.id, alsoFits.id].sort());
  });

  it('модель занята ОДНИМ расходником: isUsed истинен, удаление отбито словами про расходник', async () => {
    /*
     * СТЫК ДВУХ СПРАВОЧНИКОВ, и вторая половина занятости проверяется только отсюда: в файле
     * моделей расходников нет вовсе, а `isUsed` давно считается ОБЕИМИ половинами — карточками
     * техники и привязанными расходниками.
     *
     * Сцена нарочно оставляет модель БЕЗ единой карточки техники: тогда первая половина заведомо
     * ложна, и весь ответ держится на второй. Это же делает случай страховкой от потери корреляции
     * в подзапросе — причём страховкой ПОВЕДЕНИЕМ, не зависящей от формы записи: обломись ссылка
     * наружу любым способом, `isUsed` станет ложным, а удаление пройдёт вместо отказа.
     *
     * Слова отказа проверяются отдельно, потому что маршрут различает два случая намеренно: технику
     * («снимите „Активна“» — ссылку она не отпустит никогда) и расходник («снимите совместимость» —
     * отвязывается свободно). Сказать про картридж словами про технику значило бы отправить
     * человека делать не то.
     */
    const model = await createModel('Brother HL-1223');

    // До привязки модель свободна: ни карточек, ни расходников.
    const свободна = await modelRow(model.name);
    expect(свободна.isUsed, 'новая модель уже кем-то занята — сцена не та').toBe(false);
    expect(свободна.equipmentCount).toBe(0);

    const c = await createConsumable({ modelIds: [model.id] });

    const занята = await modelRow(model.name);
    expect(
      занята.isUsed,
      'расходник не сделал модель занятой — вторая половина isUsed молчит',
    ).toBe(true);
    // При этом карточек техники у модели по-прежнему нет: «у вас таких нет» и «модель свободна» —
    // разные вопросы, и подменять один признак другим нельзя (Р11).
    expect(занята.equipmentCount).toBe(0);

    const refused = await inject(
      'DELETE',
      `/api/v1/office-equipment-models/${model.id}`,
      ctx.admin.auth,
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().message).toContain('привязан расходник');
    // И именно про расходник, а не про технику: её здесь нет ни одной карточки.
    expect(refused.json().message).not.toContain('ссылается техника');

    const refusal = await dbRefusal(
      ctx.db.execute(sql`DELETE FROM office_equipment_models WHERE id = ${model.id}`),
    );
    expect(refusal.code).toBe('23503');

    // Сняли совместимость — и модель уходит совсем: это разметка, а не история.
    const cleared = await patchConsumable(c.id, { modelIds: [] });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await modelRow(model.name)).isUsed, 'модель осталась занятой после снятия связи').toBe(
      false,
    );
    const removed = await inject(
      'DELETE',
      `/api/v1/office-equipment-models/${model.id}`,
      ctx.admin.auth,
    );
    expect(removed.statusCode, removed.body).toBe(200);
  });

  // ── 11. Счётчик «в парке» считается в области смотрящего (Р12, Р15) ──

  describe('счётчик аппаратов у расходника', () => {
    /**
     * Второе число заказа: остаток 12 при 68 аппаратах и при 2 аппаратах означает разное (Р15).
     * Парк одной модели разложен по обеим осям области сразу, и числа у четырёх ролей разные
     * намеренно: совпади они, случай перестал бы различать правила.
     *
     * Счётчик живёт у РАСХОДНИКА, а не у модели, и потому ходит через связь — то есть через
     * коррелированный подзапрос внутри коррелированного подзапроса. Ловушка, ради которой этот
     * блок и написан, объяснена у своего случая.
     */
    let modelId: string;
    let consumable: OfficeEquipmentConsumableDto;
    /** Живой и активный парк базы целиком — ровно то число, которое показывает сломанная корреляция. */
    let parkTotal: number;

    beforeAll(async () => {
      const model = await createModel('Xerox B310');
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
      // Обе стоят на своей площадке и без отдела — то есть попали бы в область сразу трёх ролей,
      // не будь они отсеяны.
      const archived = await at(ctx.objectId, null);
      const gone = await inject(
        'DELETE',
        `/api/v1/office-equipment/${archived.id}`,
        ctx.admin.auth,
      );
      expect(gone.statusCode, gone.body).toBe(200);
      await createCard({ modelId, objectId: ctx.objectId, isActive: false });

      consumable = await createConsumable({ modelIds: [modelId] });
      parkTotal = await countRows(sql`
        SELECT count(*)::int AS c FROM office_equipment
         WHERE deleted_at IS NULL AND is_active`);
    }, 120_000);

    /**
     * Счётчик глазами субъекта — из ОБЕИХ дверей сразу, и это не удвоение работы: список и
     * карточка собирают его одним и тем же выражением, но список идёт по странице, а карточка по
     * одному `id`. Первая разновидность этой же ловушки (`hasStockHistory`) давала расхождение
     * ровно между такими двумя контекстами, и спрашивать оба — единственный способ его увидеть.
     */
    async function seenBy(
      auth: Auth,
      of: OfficeEquipmentConsumableDto = consumable,
    ): Promise<number> {
      const card = await detailOf(of.id, auth);
      const [row] = await listConsumables({ search: of.code }, auth);
      expect(row!.equipmentCount, 'список и карточка разошлись в счётчике').toBe(
        card.equipmentCount,
      );
      return card.equipmentCount;
    }

    /**
     * То же число, посчитанное **тем же предикатом**, что стоит в маршруте. Тест берёт
     * `officeEquipmentScopeWhere` из `lib/access.ts`, а не пишет свою версию правила: разойдясь,
     * они разрешили бы роли одной площадки узнать масштаб чужого парка — и оба остались бы
     * зелёными.
     *
     * Модели передаются СПИСКОМ, прочитанным заранее, а не подзапросом по расходнику: коррелировать
     * здесь нечего, и писать в тесте тот самый приём, который тест и сторожит, значило бы получить
     * проверку, разделяющую с маршрутом его ошибку.
     */
    async function scopedCount(userId: string, modelIds: string[]): Promise<number> {
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
            inArray(schema.officeEquipment.modelId, modelIds),
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
      expect(await seenBy(ctx.objectUser.auth)).toBe(3);
      expect(await scopedCount(ctx.objectUser.id, [modelId])).toBe(3);
    });

    it('роль отдела видит свои отделы и всю неразмеченную технику', async () => {
      // Карточки 2 и 3 — её отдела, 1 и 6 — ничьи. Неразмеченная попала в область намеренно: пока
      // за техникой не закреплён отдел, спрятать её от всех значило бы сделать невидимой ровно ту
      // часть парка, которую и надо разметить.
      expect(await seenBy(ctx.deptUser.auth)).toBe(4);
      expect(await scopedCount(ctx.deptUser.id, [modelId])).toBe(4);
    });

    it('роль отдела с пустым списком отделов видит ровно неразмеченную технику', async () => {
      // Пустой набор означает «своих отделов ноль», а не «видит всё»: карточки 1 и 6.
      expect(await seenBy(ctx.deptEmptyUser.auth)).toBe(2);
      expect(await scopedCount(ctx.deptEmptyUser.id, [modelId])).toBe(2);
    });

    it('сквозная область модуля показывает весь парк модели, у администратора — то же число', async () => {
      // Шесть живых и активных карточек — обе оси, обе площадки. У администратора столько же, но
      // по другой причине: у его роли области нет вовсе.
      expect(await seenBy(ctx.wideUser.auth)).toBe(6);
      expect(await scopedCount(ctx.wideUser.id, [modelId])).toBe(6);
      expect(await seenBy(ctx.admin.auth)).toBe(6);
    });

    it('счётчик считает аппараты СВОИХ моделей, а не весь парк в области', async () => {
      /*
       * ДВА РАЗНЫХ ЧИСЛА СРАЗУ, и это не перестраховка. Счётчик ошибается не нулём и не отказом, а
       * ПРАВДОПОДОБНЫМ числом: обломись корреляция по расходнику — он покажет ноль у карточки, к
       * которой привязана модель с аппаратами; вырви условие по модели — он покажет весь парк в
       * области, число внушительное и на вид совершенно нормальное. Глазами в окне не отличить ни
       * то, ни другое, поэтому случай сверяет счётчик и со своим ожидаемым числом, и с размером
       * живого парка базы.
       *
       * Что именно ломается в drizzle, замерено и записано в преамбуле файла: сторона ТЕХНИКИ
       * (`office_equipment.model_id`) квалификацию потерять может, но останется верной — голое имя
       * разрешается в её же `FROM`; а вот сторона РАСХОДНИКА, вписанная колонкой на место,
       * вырождается в `cm.consumable_id = cm.id`, и счётчик становится нулём. Поломкой проверено:
       * на этой форме краснеют все шесть случаев счётчика разом.
       */
      expect(
        parkTotal,
        'в базе слишком мало техники: случай перестал различать 6 и «весь парк»',
      ).toBeGreaterThan(50);
      const seen = await seenBy(ctx.admin.auth);
      expect(seen).toBe(6);
      expect(
        seen,
        'счётчик показал весь парк — корреляция по модели выродилась в тавтологию',
      ).not.toBe(parkTotal);

      // И расходник БЕЗ единой модели — ноль, а не «все карточки, у которых модели нет»: пустой
      // список моделей делает условие ложным, а не пропускающим.
      const unlinked = await createConsumable();
      expect(await seenBy(ctx.admin.auth, unlinked)).toBe(0);
    }, 60_000);

    it('считаются аппараты, а не пары «карточка — модель»', async () => {
      /*
       * Соединение с таблицей связи размножило бы карточку по числу подходящих ей моделей
       * расходника, поэтому связь спрашивается подзапросом `IN (…)`.
       *
       * ЧЕСТНОЙ СЦЕНЫ С ДВОЙНЫМ СЧЁТОМ СЕГОДНЯ НЕ СОБРАТЬ, и это стоит сказать прямо: у карточки
       * ровно один `model_id`, пара «расходник — модель» уникальна, а `IN` строк не размножает —
       * то есть один аппарат под двумя моделями расходника невозможен ни сверху, ни снизу.
       * Проверяется поэтому то, что проверить можно и что сломается первым при переписывании на
       * соединение: расходник, подходящий ДВУМ моделям, получает СУММУ их аппаратов, и она равна
       * числу РАЗНЫХ карточек, посчитанному соединением напрямую.
       */
      const second = await createModel('Xerox B315');
      await createCard({ modelId: second.id, objectId: ctx.objectId, departmentId: null });
      await createCard({ modelId: second.id, objectId: ctx.objectId, departmentId: null });
      const pair = await createConsumable({ modelIds: [modelId, second.id] });

      // Шесть аппаратов первой модели и два второй — каждый по одному разу.
      expect(await seenBy(ctx.wideUser.auth, pair)).toBe(8);
      expect(await scopedCount(ctx.wideUser.id, [modelId, second.id])).toBe(8);

      // То же число, посчитанное соединением через связь, но с `DISTINCT` по карточке: разойдись
      // они — и счётчик считает пары, а не аппараты.
      const distinctCards = await countRows(sql`
        SELECT count(DISTINCT e.id)::int AS c
          FROM office_equipment e
          JOIN office_equipment_consumable_models cm ON cm.model_id = e.model_id
         WHERE cm.consumable_id = ${pair.id}
           AND e.deleted_at IS NULL
           AND e.is_active`);
      expect(distinctCards).toBe(8);
    }, 60_000);
  });
});
