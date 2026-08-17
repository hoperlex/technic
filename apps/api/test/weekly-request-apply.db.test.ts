import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatWeeklyRequestNumber,
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
} from '@technic/contracts';
import { runSeed, snilsOf } from './db-identity';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Недельная заявка на технику (ADR 0085, план §11 «По базе») — применение визой на живой схеме.
 *
 * Зачем база. Применение — единственное место портала, которое одной транзакцией трогает **чужие
 * конкурентные сущности**: двигает срок заказа, поднимает его версию, жжёт и выписывает бланки
 * строгой отчётности и порождает заказы, а перед этим перечитывает то, что решили о машине в
 * других модулях, — оформленный вывоз и запрос на досрочный отъезд. Ни одно из этих последствий
 * контрактным тестом не видно: расходятся здесь не правила, а код, схема и сверка ЭСМ-2 — и ценой
 * расхождения будет либо сгоревший номер бланка, либо согласованное продление, которого не
 * случилось.
 *
 * Данные готовятся настоящими HTTP-путями везде, где портал это умеет: так проверяется и маршрут
 * тоже. Прямой SQL остаётся ровно там, где путь закрыт по существу: заказ задним числом
 * (`isAllowedRequestDate`) и недельная заявка на уже начавшуюся неделю (`weeklyWeekBlocker`) через
 * API не заводятся вовсе, а проверять поведение на них нужно.
 *
 * Своя площадка почти на каждый тест — не аккуратность, а требование схемы: частичный
 * `UNIQUE (object_id, week_start)` разрешает ровно одну живую заявку на пару, и общая площадка
 * превратила бы файл в очередь за четырьмя доступными неделями.
 *
 * Запуск (база пустая либо уже промигрированная — миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_weekly_test \
 *     pnpm --filter @technic/api test -- weekly-request-apply
 *
 * Без `TEST_DATABASE_URL` файл пропускается.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Свой суффикс на прогон: файл переживает повторный запуск на той же базе. */
const RUN = randomUUID().slice(0, 8);
const PASSWORD = 'db-test-password-123';
/** Тестовый машинист: СНИЛС из одинаковых цифр с верной контрольной суммой, серия «00 00». */
// Свой на прогон, а не общая константа: пять файлов заводили водителя по одному номеру, и
// первый добежавший решал, с какими документами тот живёт до конца прогона (см. `db-identity`).
const DRIVER_SNILS = snilsOf(runSeed('weekly-request-apply'));
/** Контакт строки «нужна дополнительно»: десять цифр — тот же формат, что в базе (ADR 0066). */
const CONTACT_PHONE = '9990000001';

// ── Календарь прогона ──
//
// Все даты считаются от «сегодня», а не задаются константами: неделя заявки обязана быть будущей
// (Р2), и захардкоженный понедельник протух бы на следующей неделе, превратив весь файл в
// 422-заглушку.
const TODAY = moscowDateKeyOf(new Date());
const CUR_MON = weekStartKey(TODAY);
const CUR_SAT = shiftDateKey(CUR_MON, 5);
const CUR_SUN = shiftDateKey(CUR_MON, 6);
/** Ближайшая будущая неделя — на неё собирается почти всё в этом файле. */
const W1 = shiftDateKey(CUR_MON, 7);
const W1_END = shiftDateKey(W1, 6);
/** Вторая будущая: ею проверяется порядок применения двух недель на один заказ (§8). */
const W2 = shiftDateKey(CUR_MON, 14);
const W2_END = shiftDateKey(W2, 6);
const W3 = shiftDateKey(CUR_MON, 21);
/** Четвёртая будущая — последняя допустимая (`WEEKLY_SELECTABLE_WEEKS`). */
const W4 = shiftDateKey(CUR_MON, 28);
/** Пятая будущая — уже за пределом предлагаемых. */
const W5 = shiftDateKey(CUR_MON, 35);
/**
 * Конец срока заказа-основания: суббота текущей недели, но не раньше сегодня — заказ задним
 * числом сервер не принимает. В воскресенье она совпадает с сегодняшним днём, и лист текущей
 * недели оказывается уже целым: два теста ЭСМ-2 в этот день предмета не имеют.
 */
const SRC_END = CUR_SAT >= TODAY ? CUR_SAT : TODAY;
const RUNS_ON_SUNDAY = SRC_END === CUR_SUN;

interface Auth {
  authorization: string;
}

interface TestUser {
  id: string;
  email: string;
  auth: Auth;
}

interface PoolVehicle {
  id: string;
  typeId: string;
  categoryId: string | null;
}

interface Order {
  id: string;
  num: number;
  displayNumber: string;
  /** Версия заказа после перевода в работу — с неё стартуют все дальнейшие правки. */
  version: number;
  vehicleId: string;
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
  dateFrom: string;
  /** Эффективный последний день срока: `coalesce(date_to, date_from)`, как его читает портал. */
  effectiveDateTo: string;
}

interface WeeklyItemRow {
  id: string;
  position: number;
  kind: string;
  result: string;
  skip_reason: string;
  date_to: string | null;
  expected_date_to: string | null;
  previous_date_to: string | null;
  applied_source_version: number | null;
  snapshot_vehicle_id: string | null;
  created_request_id: string | null;
}

interface WeeklyDto {
  id: string;
  num: number;
  displayNumber: string;
  status: string;
  version: number;
  items: { id: string; kind: string; result: string; skipReason: string }[];
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: TestUser;
  rukstroy: TestUser;
  shtab: TestUser;
  /** Штаб чужой площадки: у него своя, и ничего с наших он видеть не должен. */
  shtabForeign: TestUser;
  dispatcher: TestUser;
  manager: TestUser;
  observer: TestUser;
  commandant: TestUser;
  department: TestUser;
  wasteOperator: TestUser;
  lessor: TestUser;
  /** Контрагент-арендодатель: им помечается машина, которой открывается его видимость недели. */
  lessorCounterpartyId: string;
  foreignObjectId: string;
  personId: string;
  /** Пул техники: своя машина на каждый заказ — снимок строки хранит именно её идентичность. */
  ownVehicles: PoolVehicle[];
  rentalVehicles: PoolVehicle[];
  /**
   * Две арендные машины одной позиции классификатора: ими проверяется переназначение. Отложены на
   * старте, потому что подобрать пару из остатков пула к концу файла может быть уже не из чего.
   */
  rentalPair: [PoolVehicle, PoolVehicle];
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

/** Свой адрес на каждый вход: попытки ограничены по IP, а учёток здесь одиннадцать. */
let requestNo = 0;
function nextAddress(): string {
  requestNo += 1;
  return `10.${(requestNo >> 16) & 0xff}.${(requestNo >> 8) & 0xff}.${requestNo & 0xff}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** «11.08» — тем же видом, каким даты печатают причины отказа (`dayMonth` контрактов). */
function dayMonth(dateKey: string): string {
  const [, month, day] = dateKey.split('-');
  return `${day}.${month}`;
}

// ── Обращения к API ──

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
) {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

/**
 * Площадка под сценарий. Объектные роли привязываются к каждой: их область — набор (ADR 0039), и
 * привязка ко всем тестовым площадкам сразу избавляет от очереди за четырьмя неделями одной.
 *
 * `bindUsers: false` — для тестов удаления площадки насовсем: `purge` объекта отказывает, пока на
 * нём висит хоть одна учётка, и привязка сломала бы проверку раньше, чем дошло бы до заявок.
 */
async function freshObject(prefix = 'WK', bindUsers = true): Promise<string> {
  const code = `${prefix}-${randomUUID().slice(0, 8)}`;
  const res = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${code}, ${`Тестовая площадка ${code}`}, 'г Москва, ул Тестовая, д 1')
    RETURNING id`);
  const id = res.rows[0]!.id;
  if (bindUsers) {
    await ctx.db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${ctx.shtab.id}, ${id}), (${ctx.rukstroy.id}, ${id})`);
  }
  return id;
}

/**
 * Заказ спецтехники, взятый в работу: основание строк «остаётся» и «уезжает».
 *
 * Через настоящие ручки, а не вставкой: недельная заявка сверяется с состоянием заказа, и заказ,
 * собранный мимо маршрутов, отвечал бы на её проверки не тем, чем отвечает рабочий.
 */
async function makeOrder(opts: {
  objectId: string;
  ownership?: 'own' | 'rental';
  dateFrom?: string;
  dateTo?: string | null;
  /** Заданная машина вместо очередной из пула — там, где важна её позиция классификатора. */
  vehicle?: PoolVehicle;
}): Promise<Order> {
  const rental = opts.ownership === 'rental';
  const vehicle = opts.vehicle ?? (rental ? ctx.rentalVehicles : ctx.ownVehicles).pop();
  if (!vehicle) throw new Error('Пул тестовой техники исчерпан — расширьте выборку в seed');
  const dateFrom = opts.dateFrom ?? TODAY;
  const dateTo = opts.dateTo === undefined ? SRC_END : opts.dateTo;

  const created = await inject('POST', '/api/v1/vehicle-requests', ctx.admin.auth, {
    requestType: 'special_equipment',
    objectId: opts.objectId,
    vehicleTypeId: vehicle.typeId,
    vehicleCategoryId: vehicle.categoryId,
    dateFrom,
    dateTo,
    responsibleName: 'Иванов Иван Иванович',
    responsiblePhone: '+79990000000',
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();

  // Администратор автовизы не получает (ADR 0032) — визируем отдельным шагом, иначе заказ не
  // взять в работу.
  const approved = await inject(
    'PATCH',
    `/api/v1/vehicle-requests/${request.id}/approval`,
    ctx.admin.auth,
    { approved: true, version: request.version },
  );
  expect(approved.statusCode, approved.body).toBe(200);

  const confirmed = await inject(
    'PATCH',
    `/api/v1/vehicle-requests/${request.id}/status`,
    ctx.admin.auth,
    {
      status: 'confirmed',
      comment: '',
      version: approved.json().version,
      assignment: {
        vehicleId: vehicle.id,
        // Аренда без ставки в работу не берётся: заявка в работе означала бы, что цену выяснят
        // потом.
        pricePerHour: rental ? 1500 : null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.personId,
      },
      schedule: { requestType: 'special_equipment', dateFrom, dateTo },
    },
  );
  expect(confirmed.statusCode, confirmed.body).toBe(200);

  return {
    id: request.id,
    num: request.num,
    displayNumber: request.displayNumber,
    version: confirmed.json().version,
    vehicleId: vehicle.id,
    vehicleTypeId: vehicle.typeId,
    vehicleCategoryId: vehicle.categoryId,
    dateFrom,
    effectiveDateTo: dateTo ?? dateFrom,
  };
}

type WeeklyItemPayload = Record<string, unknown>;

function extendItem(order: Order, dateTo: string): WeeklyItemPayload {
  return { kind: 'extend', sourceRequestId: order.id, dateTo };
}

function leaveItem(order: Order): WeeklyItemPayload {
  return { kind: 'leave', sourceRequestId: order.id };
}

function newItem(
  classification: { typeId: string; categoryId: string | null },
  dateFrom: string,
  dateTo: string,
  extra: WeeklyItemPayload = {},
): WeeklyItemPayload {
  return {
    kind: 'new',
    vehicleTypeId: classification.typeId,
    vehicleCategoryId: classification.categoryId,
    dateFrom,
    dateTo,
    responsibleName: 'Петров Пётр Петрович',
    responsiblePhone: CONTACT_PHONE,
    ...extra,
  };
}

/**
 * ИНН из девяти произвольных цифр плюс контрольная — по тому же правилу, которым его проверяет
 * портал (веса 2·4·10·3·5·9·4·6·8, остаток от 11, затем от 10).
 *
 * Считается, а не берётся «каким-нибудь»: тестовые контрагенты остаются в общей тестовой базе
 * после прогона, а обмен справочниками (ADR 0073) выгружает её целиком и загружает обратно —
 * невалидный ИНН роняет **чужой** тест, и виноватого в нём не видно.
 */
function testInn(nineDigits: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(nineDigits[i]), 0);
  return `${nineDigits}${((sum % 11) % 10).toString()}`;
}

/**
 * Выдача недельных заявок — лента раздела «Заказ автотехники» (ADR 0089): своего списка у модуля
 * не осталось, и видимость проверяется там же, где её видит человек.
 */
const FEED_WEEKLY = '/api/v1/vehicle-requests/feed?kind=weekly&pageSize=200';

/** Идентификаторы недельных строк ленты: строка размечена видом документа, а не угадывается. */
function feedWeeklyIds(res: { json: () => { items: { kind: string; weekly?: WeeklyDto }[] } }) {
  return res
    .json()
    .items.filter((row) => row.kind === 'weekly')
    .map((row) => row.weekly!.id);
}

async function makeWeekly(
  auth: Auth,
  params: { objectId: string; weekStart: string; items?: WeeklyItemPayload[] },
): Promise<WeeklyDto> {
  const res = await inject('POST', '/api/v1/weekly-vehicle-requests', auth, {
    objectId: params.objectId,
    weekStart: params.weekStart,
    items: params.items ?? [],
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as WeeklyDto;
}

function submitWeekly(auth: Auth, id: string, version: number) {
  return inject('POST', `/api/v1/weekly-vehicle-requests/${id}/status`, auth, {
    status: 'pending',
    version,
  });
}

function cancelWeekly(auth: Auth, id: string, version: number, reason = 'Передумали') {
  return inject('POST', `/api/v1/weekly-vehicle-requests/${id}/status`, auth, {
    status: 'cancelled',
    reason,
    version,
  });
}

function approveWeekly(auth: Auth, id: string, version: number, approved = true, comment = '') {
  return inject('POST', `/api/v1/weekly-vehicle-requests/${id}/approval`, auth, {
    approved,
    comment,
    version,
  });
}

/** Подать и завизировать администратором: два шага — автовизы у него нет (Р12). */
async function submitAndApprove(weekly: WeeklyDto) {
  const submitted = await submitWeekly(ctx.admin.auth, weekly.id, weekly.version);
  expect(submitted.statusCode, submitted.body).toBe(200);
  const pending = submitted.json().request as WeeklyDto;
  expect(pending.status).toBe('pending');
  return { pending, approval: await approveWeekly(ctx.admin.auth, weekly.id, pending.version) };
}

async function orderDto(id: string) {
  const res = await inject('GET', `/api/v1/vehicle-requests/${id}`, ctx.admin.auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

// ── Чтение состояния из базы ──

async function weeklyRow(id: string) {
  const res = await ctx.db.execute<{
    status: string;
    version: number;
    approved_by: string | null;
    applied_at: string | null;
  }>(sql`SELECT status::text, version, approved_by, applied_at::text
         FROM weekly_vehicle_requests WHERE id = ${id}`);
  return res.rows[0];
}

async function itemRows(weeklyId: string): Promise<WeeklyItemRow[]> {
  const res = await ctx.db.execute<WeeklyItemRow>(sql`
    SELECT id, position, kind::text, result::text, skip_reason, date_to::text,
           expected_date_to::text, previous_date_to::text, applied_source_version,
           snapshot_vehicle_id, created_request_id
    FROM weekly_vehicle_request_items WHERE weekly_request_id = ${weeklyId} ORDER BY position`);
  return res.rows;
}

async function historyRows(weeklyId: string) {
  const res = await ctx.db.execute<{
    event: string;
    from_status: string | null;
    to_status: string | null;
    comment: string;
  }>(sql`SELECT event::text, from_status::text, to_status::text, comment
         FROM weekly_vehicle_request_history WHERE weekly_request_id = ${weeklyId}
         ORDER BY changed_at`);
  return res.rows;
}

async function orderRow(id: string) {
  const res = await ctx.db.execute<{
    version: number;
    updated_by: string | null;
    date_to: string | null;
    date_from: string;
  }>(sql`SELECT r.version, r.updated_by, d.date_to::text, d.date_from::text
         FROM vehicle_requests r
         JOIN special_equipment_request_details d ON d.request_id = r.id
         WHERE r.id = ${id}`);
  return res.rows[0]!;
}

/** Листы ЭСМ-2 заказа — то, чем отвечает сверка: что сгорело и что выписано взамен. */
async function sheetsOf(requestId: string) {
  const res = await ctx.db.execute<{
    id: string;
    status: string;
    number: number;
    period_from: string;
    period_to: string;
  }>(sql`SELECT id, status::text, number, period_from::text, period_to::text
         FROM waybills WHERE source_request_id = ${requestId} AND form_code = 'esm2'
         ORDER BY number`);
  return res.rows;
}

async function auditActions(entityId: string): Promise<string[]> {
  const res = await ctx.db.execute<{ action: string }>(
    sql`SELECT action FROM audit_log WHERE entity_id = ${entityId} ORDER BY created_at`,
  );
  return res.rows.map((r) => r.action);
}

async function pendingEarlyEnds(requestId: string): Promise<number> {
  const res = await ctx.db.execute<{ c: string }>(
    sql`SELECT count(*)::text AS c FROM vehicle_request_early_endings
        WHERE request_id = ${requestId} AND status = 'pending'`,
  );
  return Number(res.rows[0]!.c);
}

/** Свой тип ТС на тест: гасить и сносить общий из наполнения нельзя — на нём стоят соседи. */
async function makeVehicleType(prefix: string): Promise<{ id: string; name: string }> {
  const code = `${prefix}_${randomUUID()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10)}`;
  const res = await ctx.db.execute<{ id: string; name: string }>(sql`
    INSERT INTO vehicle_types (kind_id, code, name)
    SELECT id, ${code}, ${`Тестовый тип ${code}`} FROM vehicle_kinds WHERE code = 'special_equipment'
    RETURNING id, name`);
  return res.rows[0]!;
}

/**
 * Свой тип ТС вместе с одной категорией. Категория в этой схеме не «строка с именем»: триггер
 * `vehicle_categories_consistency` требует, чтобы у типа была ТТХ, у категории — значение по
 * каждой, а сигнатура совпадала со значениями. Триггер отложен до конца транзакции, поэтому три
 * записи заводятся одной, а сигнатура считается той же функцией БД — руками её не сложить.
 */
async function makeTypeWithCategory(
  prefix: string,
  categoryName: string,
): Promise<{ typeId: string; categoryId: string }> {
  const type = await makeVehicleType(prefix);
  return ctx.db.transaction(async (tx) => {
    const spec = await tx.execute<{ id: string; code: string }>(
      sql`SELECT id, code FROM vehicle_specs ORDER BY code LIMIT 1`,
    );
    const { id: specId, code } = spec.rows[0]!;
    await tx.execute(
      sql`INSERT INTO vehicle_type_specs (vehicle_type_id, spec_id) VALUES (${type.id}, ${specId})`,
    );
    const category = await tx.execute<{ id: string }>(sql`
      INSERT INTO vehicle_categories (vehicle_type_id, name, is_auto_name, spec_signature)
      VALUES (${type.id}, ${categoryName}, false,
              vehicle_category_signature(jsonb_build_object(${code}::text, 12)))
      RETURNING id`);
    const categoryId = category.rows[0]!.id;
    await tx.execute(sql`
      INSERT INTO vehicle_category_spec_values (category_id, vehicle_type_id, spec_id, value_num)
      VALUES (${categoryId}, ${type.id}, ${specId}, 12)`);
    return { typeId: type.id, categoryId };
  });
}

/**
 * Недельная заявка на уже начавшуюся неделю: через API её не завести вовсе (`weeklyWeekBlocker`),
 * а состояние «черновик пролежал до понедельника» проверять надо — ради него и существует пятая
 * точка проверки недели (§8).
 */
async function insertWeekly(status: 'draft' | 'pending'): Promise<{ id: string; version: number }> {
  const objectId = await freshObject('WK-STALE');
  const res = await ctx.db.execute<{ id: string; version: number }>(sql`
    INSERT INTO weekly_vehicle_requests (object_id, week_start, status, created_by)
    VALUES (${objectId}, ${CUR_MON}::date,
            ${sql.raw(`'${status}'::weekly_request_status`)}, ${ctx.admin.id})
    RETURNING id, version`);
  return res.rows[0]!;
}

/**
 * Оформленный вывоз — рейс-перегон по заказу (`purpose = 'pickup'`). Прямым SQL: выписка перегона
 * живёт в чужом модуле со своими правами и своей формой, а проверяется здесь не она, а то, что
 * оформленный вывоз выбрасывает строку недели.
 */
async function insertPickupRoute(order: Order): Promise<number> {
  const res = await ctx.db.execute<{ num: number }>(sql`
    INSERT INTO vehicle_routes (vehicle_id, route_date, purpose, source_request_id,
                                move_from, move_to, created_by)
    VALUES (${order.vehicleId}, ${shiftDateKey(TODAY, 3)}::date, 'pickup', ${order.id},
            'Объект', 'База', ${ctx.admin.id})
    RETURNING num`);
  return res.rows[0]!.num;
}

/**
 * Применённая недельная заявка прошедшей недели с решением «уезжает» по заказу — целиком SQL'ом.
 *
 * Через API такого состояния теперь не собрать: первая же применённая неделя закрывает заказ для
 * всех следующих. Но в базе оно есть — его завели до этого правила, — и предложение обязано его
 * пережить: именно на нём и проверяется, что кандидат не размножается.
 */
async function insertAppliedLeave(
  objectId: string,
  order: Order,
  weekStart: string,
): Promise<number> {
  const weekly = await ctx.db.execute<{ id: string; num: number }>(sql`
    INSERT INTO weekly_vehicle_requests (object_id, week_start, status, created_by,
                                         approved_by, approved_at, applied_at)
    VALUES (${objectId}, ${weekStart}::date, 'applied'::weekly_request_status, ${ctx.admin.id},
            ${ctx.admin.id}, now(), now())
    RETURNING id, num`);
  const row = weekly.rows[0]!;
  await ctx.db.execute(sql`
    INSERT INTO weekly_vehicle_request_items
      (weekly_request_id, week_start, position, kind, source_request_id, expected_date_to,
       previous_date_to, applied_source_version, snapshot_vehicle_id, result)
    VALUES (${row.id}, ${weekStart}::date, 0, 'leave'::weekly_request_item_kind, ${order.id},
            ${order.effectiveDateTo}::date, ${order.effectiveDateTo}::date, ${order.version},
            ${order.vehicleId}, 'left'::weekly_request_item_result)`);
  return row.num;
}

/** Запрос на досрочный отъезд, оставшийся ждать визы: администратор автовизы не получает. */
async function requestEarlyEnd(order: Order): Promise<void> {
  const res = await inject(
    'POST',
    `/api/v1/vehicle-requests/${order.id}/early-end`,
    ctx.admin.auth,
    {
      newDateTo: TODAY,
      reason: 'Работы на площадке закончились раньше',
      version: order.version,
    },
  );
  expect(res.statusCode, res.body).toBe(200);
  expect(await pendingEarlyEnds(order.id)).toBe(1);
}

describe.skipIf(!DB_URL)('недельная заявка: применение визой (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);

    async function makeUser(input: {
      tag: string;
      role: string;
      counterpartyId?: string;
    }): Promise<{ id: string; email: string }> {
      const email = `db-weekly-${input.tag}-${RUN}@example.invalid`;
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                           is_active, email_verified_at, counterparty_id)
        VALUES (${email}, 'Тестовый', 'Пользователь', ${input.tag}, ${passwordHash},
                ${sql.raw(`'${input.role}'::role`)}, true, now(), ${input.counterpartyId ?? null})
        RETURNING id`);
      return { id: res.rows[0]!.id, email };
    }

    // Контрагенты нужны только ради ролей от контрагента: без них учётка «Оператор» не заводится
    // (CHECK `users_operator_counterparty_check`). Арендодатель — та же роль, другой тип.
    const counterparty = async (type: 'operator' | 'vehicle_lessor', inn: string) => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (type, name, inn)
        VALUES (${sql.raw(`'${type}'::counterparty_type`)},
                ${`Тестовый контрагент ${type} ${RUN}`}, ${inn})
        RETURNING id`);
      return res.rows[0]!.id;
    };
    const digits = String(Date.now()).slice(-6);
    const operatorCp = await counterparty('operator', testInn(`10${digits}0`));
    const lessorCp = await counterparty('vehicle_lessor', testInn(`10${digits}1`));

    const users = {
      admin: await makeUser({ tag: 'admin', role: 'admin' }),
      rukstroy: await makeUser({ tag: 'ruk', role: 'rukstroy' }),
      shtab: await makeUser({ tag: 'shtab', role: 'shtab' }),
      shtabForeign: await makeUser({ tag: 'shtabf', role: 'shtab' }),
      dispatcher: await makeUser({ tag: 'disp', role: 'dispatcher' }),
      manager: await makeUser({ tag: 'mgr', role: 'manager' }),
      observer: await makeUser({ tag: 'obs', role: 'observer' }),
      commandant: await makeUser({ tag: 'cmd', role: 'commandant' }),
      department: await makeUser({ tag: 'dept', role: 'department' }),
      wasteOperator: await makeUser({ tag: 'oper', role: 'operator', counterpartyId: operatorCp }),
      lessor: await makeUser({ tag: 'lessor', role: 'operator', counterpartyId: lessorCp }),
    };

    // Чужая площадка: своя у штаба-соседа, и ни одна заявка этого файла на неё не заводится.
    const foreign = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`WK-FOREIGN-${RUN}`}, ${`Тестовая чужая площадка ${RUN}`}, 'г Москва, ул Чужая, д 2')
      RETURNING id`);
    const foreignObjectId = foreign.rows[0]!.id;
    await db.execute(sql`
      INSERT INTO user_construction_objects (user_id, construction_object_id)
      VALUES (${users.shtabForeign.id}, ${foreignObjectId}),
             (${users.commandant.id}, ${foreignObjectId})`);

    // Машинист: на него выписываются недельные листы ЭСМ-2, без него сверка отказывает.
    const existingPerson = await db.execute<{ id: string }>(
      sql`SELECT id FROM persons WHERE snils = ${DRIVER_SNILS}`,
    );
    let personId = existingPerson.rows[0]?.id ?? '';
    if (!personId) {
      const created = await db.execute<{ id: string }>(sql`
        INSERT INTO persons (last_name, first_name, middle_name, snils, comment)
        VALUES ('Тестовый', 'Машинист', 'Недельный', ${DRIVER_SNILS},
                'ТЕСТОВЫЕ ДАННЫЕ: интеграционный тест недельной заявки')
        RETURNING id`);
      personId = created.rows[0]!.id;
      await db.execute(sql`
        INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
        SELECT ${personId}, id, true, '2024-01-15' FROM specializations WHERE code = 'driver'`);
      await db.execute(sql`
        INSERT INTO person_employments (person_id, employment_type, personnel_no, job_title,
                                        started_on)
        VALUES (${personId}, 'staff', ${`Т-${RUN.slice(0, 4)}`}, 'Машинист', '2024-01-15')`);
      const credential = await db.execute<{ id: string }>(sql`
        INSERT INTO person_credentials (person_id, credential_type_id, series, number, issued_on,
                                        expires_on, verification_status, verified_at)
        SELECT ${personId}, id, '00 00', '000102', '2021-03-12',
               -- Срок заведомо длинный: тест идёт «на сегодня», и истечение сломало бы отбор
               -- водителя молча — пустым списком вместо понятного отказа.
               '2099-03-12', 'verified', now()
        FROM credential_types WHERE code = 'driver_license'
        RETURNING id`);
      await db.execute(sql`
        INSERT INTO person_credential_categories (credential_id, qualification_category_id,
                                                  credential_type_id, valid_from)
        -- Категория берётся вместе со своим видом документа: с миграции 0123 «B» и «C» есть и у
        -- тракторного удостоверения, а перекрёстный подбор положил бы его категорию в ВУ — такую
        -- пару не пропускает составной внешний ключ.
        SELECT ${credential.rows[0]!.id}, qc.id, ct.id, '2021-03-12'
        FROM qualification_categories qc
        JOIN credential_types ct ON ct.id = qc.credential_type_id
        WHERE qc.code IN ('b', 'c') AND ct.code = 'driver_license'`);
    }

    // Парк: своя техника с категорией (заказ на тип с категориями сервер без неё не примет) и
    // арендная — ею проверяется, что портал документов на аренду не выписывает (Р19).
    const pool = async (ownership: 'own' | 'rental') => {
      const res = await db.execute<{ id: string; type_id: string; category_id: string | null }>(sql`
        SELECT v.id, v.vehicle_type_id AS type_id, v.vehicle_category_id AS category_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
        WHERE v.ownership = ${ownership} AND v.status = 'active' AND v.deleted_at IS NULL
          AND vk.code = 'special_equipment' AND vt.is_active AND v.vehicle_category_id IS NOT NULL
        ORDER BY v.id`);
      return res.rows.map((r) => ({ id: r.id, typeId: r.type_id, categoryId: r.category_id }));
    };
    const ownVehicles = await pool('own');
    const rentalVehicles = await pool('rental');
    if (ownVehicles.length < 6 || rentalVehicles.length < 28) {
      throw new Error('В базе не хватает спецтехники: миграции наполнения не применены');
    }
    // Пара одной позиции классификатора под переназначение: заменять машину на технику другого
    // типа заказ не обязан позволять (ADR 0059), и проверять надо не это.
    const pairIndex = rentalVehicles.findIndex(
      (v, i) =>
        rentalVehicles.findIndex(
          (o, j) => j > i && o.typeId === v.typeId && o.categoryId === v.categoryId,
        ) >= 0,
    );
    if (pairIndex < 0)
      throw new Error('В базе нет двух арендных машин одной позиции классификатора');
    const first = rentalVehicles.splice(pairIndex, 1)[0]!;
    const secondIndex = rentalVehicles.findIndex(
      (o) => o.typeId === first.typeId && o.categoryId === first.categoryId,
    );
    const second = rentalVehicles.splice(secondIndex, 1)[0]!;

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
      admin: await withAuth(users.admin),
      rukstroy: await withAuth(users.rukstroy),
      shtab: await withAuth(users.shtab),
      shtabForeign: await withAuth(users.shtabForeign),
      dispatcher: await withAuth(users.dispatcher),
      manager: await withAuth(users.manager),
      observer: await withAuth(users.observer),
      commandant: await withAuth(users.commandant),
      department: await withAuth(users.department),
      wasteOperator: await withAuth(users.wasteOperator),
      lessor: await withAuth(users.lessor),
      lessorCounterpartyId: lessorCp,
      foreignObjectId,
      personId,
      ownVehicles,
      rentalVehicles,
      rentalPair: [first, second],
    };
  }, 180_000);

  afterAll(async () => {
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  // ── Продление: срок, версия, снимок ──

  describe('продление заказа', () => {
    it('двигает срок, поднимает версию с автором и пишет снимок момента применения', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });

      const before = await orderRow(order.id);
      const { approval } = await submitAndApprove(weekly);
      expect(approval.statusCode, approval.body).toBe(200);
      const apply = approval.json().apply;
      expect(apply.applied).toBe(1);
      expect(apply.skipped).toBe(0);

      // Срок двинулся ровно на дату строки, а не «на неделю вперёд».
      const after = await orderRow(order.id);
      expect(after.date_to).toBe(W1_END);
      // Версия и автор — без них следующий читатель заказа получил бы старую версию (Р6).
      expect(after.version).toBe(before.version + 1);
      expect(after.updated_by).toBe(ctx.admin.id);

      // Снимок момента применения (Р14): три поля обязаны быть заполнены вместе — полуснимок
      // однажды прочитают как факт.
      const [item] = await itemRows(weekly.id);
      expect(item!.result).toBe('extended');
      expect(item!.previous_date_to).toBe(order.effectiveDateTo);
      expect(item!.applied_source_version).toBe(before.version);
      expect(item!.snapshot_vehicle_id).toBe(order.vehicleId);
      // `expected_date_to` сервер читает из самого заказа, а не из тела (§7), и им же сверяет
      // применимость строки.
      expect(item!.expected_date_to).toBe(order.effectiveDateTo);

      const header = await weeklyRow(weekly.id);
      expect(header!.status).toBe('applied');
      expect(header!.approved_by).toBe(ctx.admin.id);
      expect(header!.applied_at).not.toBeNull();
      // Подача и применение — два перехода, каждый поднимает версию шапки.
      expect(header!.version).toBe(weekly.version + 2);

      // История — своей транзакционной таблицей, а не только аудитом (Р17).
      const history = await historyRows(weekly.id);
      expect(
        history.some((h) => h.event === 'status' && h.to_status === 'applied'),
        JSON.stringify(history),
      ).toBe(true);
    }, 60_000);

    it('строка «уезжает» заказ не трогает, но снимок пишет', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [leaveItem(order)],
      });
      const before = await orderRow(order.id);
      const { approval } = await submitAndApprove(weekly);
      expect(approval.statusCode, approval.body).toBe(200);

      const after = await orderRow(order.id);
      // «Уезжает» — решение, а не действие: срок кончится сам, версия заказа не растёт.
      expect(after.date_to).toBe(before.date_to);
      expect(after.version).toBe(before.version);

      const [item] = await itemRows(weekly.id);
      expect(item!.result).toBe('left');
      // Снимок обязателен и здесь: через месяц к строке придут с тем же вопросом — какая машина
      // и до какого числа стояла.
      expect(item!.previous_date_to).toBe(order.effectiveDateTo);
      expect(item!.snapshot_vehicle_id).toBe(order.vehicleId);
    }, 60_000);
  });

  // ── ЭСМ-2: план сверки, а не «ровно один новый лист» ──

  describe('ЭСМ-2 после продления', () => {
    it.skipIf(RUNS_ON_SUNDAY)(
      'заказ, кончавшийся в середине текущей недели, теряет частичный лист и получает два новых',
      async () => {
        // Лист текущей недели выписан частичным (сегодня…суббота), и продление до конца целевой
        // недели обязано аннулировать его, выписать вместо него полный и добавить лист целевой.
        const objectId = await freshObject();
        const order = await makeOrder({ objectId });
        const before = await sheetsOf(order.id);
        expect(before.filter((s) => s.status !== 'cancelled')).toHaveLength(1);

        const weekly = await makeWeekly(ctx.admin.auth, {
          objectId,
          weekStart: W1,
          items: [extendItem(order, W1_END)],
        });
        const { approval } = await submitAndApprove(weekly);
        expect(approval.statusCode, approval.body).toBe(200);

        // Проверяется фактический план сверки: один сгоревший номер и две выписки. «Ровно один
        // новый лист» скрыл бы перевыписку — а именно она расходует бланк строгой отчётности.
        const esm2 = approval.json().apply.esm2;
        expect(esm2).toHaveLength(1);
        expect(esm2[0].requestId).toBe(order.id);
        expect(esm2[0].cancelled).toHaveLength(1);
        expect(esm2[0].issued).toBe(2);

        const after = await sheetsOf(order.id);
        expect(after.filter((s) => s.status === 'cancelled')).toHaveLength(1);
        expect(
          after
            .filter((s) => s.status !== 'cancelled')
            .map((s) => `${s.period_from}..${s.period_to}`)
            .sort(),
        ).toEqual([`${TODAY}..${CUR_SUN}`, `${W1}..${W1_END}`].sort());

        // Сгоревший номер объясняется не только строкой ответа: аудит переписанной бумаги пишется
        // по каждому затронутому заказу.
        expect(await auditActions(order.id)).toContain('waybill.esm2_sync');
      },
      60_000,
    );

    it.skipIf(RUNS_ON_SUNDAY)(
      'лист прошедшей недели не трогается и второй раз на ту же неделю не выписывается',
      async () => {
        const objectId = await freshObject();
        const order = await makeOrder({ objectId });
        const [sheet] = await sheetsOf(order.id);
        expect(sheet).toBeDefined();

        // Заказ, начавшийся в прошлую среду, через API не завести: `isAllowedRequestDate` не даёт
        // заказывать задним числом. Двигаем начало и переклеиваем выданный лист на прошедшую
        // неделю — ровно то состояние, в котором заказ встречает вторую неделю работы.
        const prevWed = shiftDateKey(CUR_MON, -5);
        const prevSun = shiftDateKey(CUR_MON, -1);
        await ctx.db.execute(sql`
          UPDATE special_equipment_request_details SET date_from = ${prevWed}::date
          WHERE request_id = ${order.id}`);
        await ctx.db.execute(sql`
          UPDATE waybills
          SET period_from = ${prevWed}::date, period_to = ${prevSun}::date,
              issued_for_date = ${prevWed}::date
          WHERE id = ${sheet!.id}`);

        const weekly = await makeWeekly(ctx.admin.auth, {
          objectId,
          weekStart: W1,
          items: [extendItem(order, W1_END)],
        });
        const { approval } = await submitAndApprove(weekly);
        expect(approval.statusCode, approval.body).toBe(200);

        // Отработанная неделя неприкосновенна: её лист не аннулируется, и второго на неё не
        // выписывается — иначе на одну работу вышло бы два документа.
        const esm2 = approval.json().apply.esm2;
        expect(esm2[0].cancelled).toHaveLength(0);
        expect(esm2[0].issued).toBe(2);

        const after = await sheetsOf(order.id);
        const old = after.find((s) => s.id === sheet!.id)!;
        expect(old.status).not.toBe('cancelled');
        expect(`${old.period_from}..${old.period_to}`).toBe(`${prevWed}..${prevSun}`);
        expect(
          after
            .filter((s) => s.status !== 'cancelled')
            .map((s) => `${s.period_from}..${s.period_to}`)
            .sort(),
        ).toEqual([`${prevWed}..${prevSun}`, `${CUR_MON}..${CUR_SUN}`, `${W1}..${W1_END}`].sort());
      },
      60_000,
    );

    it('аренда: продление арендного заказа листов не порождает, чек-лист отвечает «ведёт арендодатель»', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      // Бумаги у аренды нет и до продления: `esm2Required` требует собственной машины.
      expect(await sheetsOf(order.id)).toHaveLength(0);

      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      const { approval } = await submitAndApprove(weekly);
      expect(approval.statusCode, approval.body).toBe(200);

      expect(await sheetsOf(order.id)).toHaveLength(0);
      // Строка в ответе есть — применение кладёт по одной на каждый продлённый заказ, — но она
      // пустая: сверка ничего не аннулировала и ничего не выписала. Проверяется именно это, а не
      // отсутствие строки: пустой итог сверки и есть «портал в бумагу арендодателя не лезет».
      const esm2 = approval.json().apply.esm2;
      expect(
        esm2.every((e: { cancelled: string[]; issued: number }) => e.cancelled.length === 0),
      ).toBe(true);
      expect(esm2.every((e: { issued: number }) => e.issued === 0)).toBe(true);
      expect((await orderRow(order.id)).date_to).toBe(W1_END);

      const docs = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${weekly.id}/documents`,
        ctx.admin.auth,
      );
      expect(docs.statusCode, docs.body).toBe(200);
      // Нейтральное состояние, а не красное «не выписано»: иначе неделя из арендной техники
      // всегда выглядела бы незаконченной (Р19).
      const row = docs.json().rows[0];
      expect(row.esm2.state).toBe('lessor');
      expect(row.esm2.text.toLowerCase()).toContain('арендодател');
    }, 60_000);
  });

  // ── Идемпотентность визы ──

  it('повторная виза не применяет дважды и не жжёт номеров', async () => {
    const objectId = await freshObject();
    const order = await makeOrder({ objectId });
    const weekly = await makeWeekly(ctx.admin.auth, {
      objectId,
      weekStart: W1,
      items: [extendItem(order, W1_END)],
    });
    const { approval } = await submitAndApprove(weekly);
    expect(approval.statusCode, approval.body).toBe(200);

    const appliedHeader = await weeklyRow(weekly.id);
    const sheetsAfterFirst = await sheetsOf(order.id);
    const orderAfterFirst = await orderRow(order.id);

    // Виза и применение — одно событие, поэтому вторая виза не повторяет его, а упирается в
    // статус: применённая заявка уже история (Р13).
    const second = await approveWeekly(ctx.admin.auth, weekly.id, appliedHeader!.version);
    expect(second.statusCode, second.body).toBe(422);
    expect(second.json().message).toContain('уже применена');

    expect(await weeklyRow(weekly.id)).toEqual(appliedHeader);
    // Ни одного нового номера: сгоревший на ровном месте бланк — худшее последствие
    // неидемпотентной визы.
    expect(await sheetsOf(order.id)).toEqual(sheetsAfterFirst);
    expect(await orderRow(order.id)).toEqual(orderAfterFirst);
  }, 60_000);

  // ── Строка «нужна дополнительно» ──

  it('строка «нужна дополнительно» рождает завизированный заказ «Новая» с нужным сроком и основанием', async () => {
    const objectId = await freshObject();
    const classification = ctx.ownVehicles[0]!;
    const weekly = await makeWeekly(ctx.admin.auth, {
      objectId,
      weekStart: W1,
      items: [
        newItem(
          { typeId: classification.typeId, categoryId: classification.categoryId },
          W1,
          shiftDateKey(W1, 4),
          { deliveryNeeded: true, deliveryFrom: 'г Москва, ул Складская, д 5' },
        ),
      ],
    });
    const { approval } = await submitAndApprove(weekly);
    expect(approval.statusCode, approval.body).toBe(200);

    const [item] = await itemRows(weekly.id);
    expect(item!.result).toBe('created');
    expect(item!.created_request_id).not.toBeNull();
    // Снимка у порождённой строки быть не должно: снимок отвечает на «что застали», а застали
    // здесь пустоту — заказа до применения не существовало.
    expect(item!.previous_date_to).toBeNull();
    expect(item!.snapshot_vehicle_id).toBeNull();

    const created = await orderDto(item!.created_request_id!);
    expect(created.status).toBe('new');
    expect(created.requestType).toBe('special_equipment');
    expect(created.dateFrom).toBe(W1);
    expect(created.dateTo).toBe(shiftDateKey(W1, 4));
    expect(created.objectId).toBe(objectId);
    expect(created.vehicleTypeId).toBe(classification.typeId);
    // Виза одна на пакет: порождённый заказ второй визы не спрашивает (Р8).
    expect(created.approvedAt).not.toBeNull();
    expect(created.approvedBy).toBe(ctx.admin.id);
    // Форме перевода в работу нужны значения, а не повод сходить за ними вторым запросом (Р11).
    expect(created.weeklyOrigin).not.toBeNull();
    expect(created.weeklyOrigin.weeklyRequestId).toBe(weekly.id);
    expect(created.weeklyOrigin.weeklyRequestNum).toBe(weekly.num);
    expect(created.weeklyOrigin.deliveryNeeded).toBe(true);
    expect(created.weeklyOrigin.deliveryFrom).toBe('г Москва, ул Складская, д 5');
  }, 60_000);

  // ── Предвалидация: негодная строка неделю не роняет ──

  describe('предвалидация строк', () => {
    it('заказ отменили после сборки — строка пропущена, соседняя применяется', async () => {
      const objectId = await freshObject();
      const cancelled = await makeOrder({ objectId, ownership: 'rental' });
      const alive = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(cancelled, W1_END), extendItem(alive, W1_END)],
      });

      const closed = await inject(
        'PATCH',
        `/api/v1/vehicle-requests/${cancelled.id}/status`,
        ctx.admin.auth,
        {
          status: 'cancelled',
          comment: 'Работы отменены заказчиком',
          version: cancelled.version,
        },
      );
      expect(closed.statusCode, closed.body).toBe(200);

      const { approval } = await submitAndApprove(weekly);
      expect(approval.statusCode, approval.body).toBe(200);
      const apply = approval.json().apply;
      expect(apply.applied).toBe(1);
      expect(apply.skipped).toBe(1);

      const items = await itemRows(weekly.id);
      expect(items[0]!.result).toBe('skipped');
      expect(items[0]!.skip_reason).toContain('В работе');
      expect(items[1]!.result).toBe('extended');
      expect((await orderRow(alive.id)).date_to).toBe(W1_END);
    }, 60_000);

    it('срок изменился после подачи — строка уходит в skipped с обеими датами в причине', async () => {
      const objectId = await freshObject();
      const moved = await makeOrder({ objectId, ownership: 'rental' });
      const alive = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(moved, W1_END), extendItem(alive, W1_END)],
      });

      // Заказ продлили обычной правкой между сборкой и визой: решение принималось про другой
      // срок, и провести его через визу молча нельзя (Р14).
      const movedTo = shiftDateKey(W1, 2);
      const patched = await inject(
        'PATCH',
        `/api/v1/vehicle-requests/${moved.id}`,
        ctx.admin.auth,
        { requestType: 'special_equipment', dateTo: movedTo, version: moved.version },
      );
      expect(patched.statusCode, patched.body).toBe(200);

      const { approval } = await submitAndApprove(weekly);
      expect(approval.statusCode, approval.body).toBe(200);

      const items = await itemRows(weekly.id);
      expect(items[0]!.result).toBe('skipped');
      // Обе даты в причине: площадка пересобирает неделю, зная факт, а не «что-то изменилось».
      expect(items[0]!.skip_reason).toContain('изменился');
      expect(items[0]!.skip_reason).toContain(dayMonth(moved.effectiveDateTo));
      expect(items[0]!.skip_reason).toContain(dayMonth(movedTo));
      expect(items[1]!.result).toBe('extended');
    }, 60_000);

    it('правка, не трогающая срок, строку не выбрасывает — сверяется срок, а не версия', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });

      // Версия заказа растёт от любой правки, включая телефон ответственного; сверка по версии
      // выбрасывала бы строки по поводам, к решению не относящимся.
      const patched = await inject(
        'PATCH',
        `/api/v1/vehicle-requests/${order.id}`,
        ctx.admin.auth,
        {
          requestType: 'special_equipment',
          comment: 'Уточнили въезд с северных ворот',
          responsiblePhone: '+79990000009',
          version: order.version,
        },
      );
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json().version).toBe(order.version + 1);

      const { approval } = await submitAndApprove(weekly);
      expect(approval.statusCode, approval.body).toBe(200);
      expect(approval.json().apply.applied).toBe(1);

      const [item] = await itemRows(weekly.id);
      expect(item!.result).toBe('extended');
      // В снимок ушла версия, прочитанная под блокировкой, — та, что была на момент применения.
      expect(item!.applied_source_version).toBe(order.version + 1);
    }, 60_000);

    it('все строки негодны — 422, статус остаётся pending, skipped в строках не сохраняется', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      const closed = await inject(
        'PATCH',
        `/api/v1/vehicle-requests/${order.id}/status`,
        ctx.admin.auth,
        { status: 'cancelled', comment: 'Отменено', version: order.version },
      );
      expect(closed.statusCode, closed.body).toBe(200);

      const submitted = await submitWeekly(ctx.admin.auth, weekly.id, weekly.version);
      expect(submitted.statusCode, submitted.body).toBe(200);
      const pending = submitted.json().request as WeeklyDto;

      const approval = await approveWeekly(ctx.admin.auth, weekly.id, pending.version);
      expect(approval.statusCode, approval.body).toBe(422);
      // Причины считаются в памяти и уходят в ответ: документа-основания без единого следствия
      // не бывает (Р9).
      expect(approval.json().message).toContain(formatWeeklyRequestNumber(weekly.num));

      const header = await weeklyRow(weekly.id);
      expect(header!.status).toBe('pending');
      expect(header!.approved_by).toBeNull();
      expect(header!.applied_at).toBeNull();
      // Транзакция откачена целиком: хранимый результат бывает только у применённой заявки.
      const [item] = await itemRows(weekly.id);
      expect(item!.result).toBe('pending');
      expect(item!.skip_reason).toBe('');
    }, 60_000);

    it('деактивированный тип ТС в строке «нужна дополнительно» пропускает строку, а не роняет неделю', async () => {
      const objectId = await freshObject();
      const type = await makeVehicleType('wk_dead_type');
      const alive = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [
          newItem({ typeId: type.id, categoryId: null }, W1, W1_END),
          extendItem(alive, W1_END),
        ],
      });

      await ctx.db.execute(sql`UPDATE vehicle_types SET is_active = false WHERE id = ${type.id}`);

      const { approval } = await submitAndApprove(weekly);
      // Погашенная позиция классификатора неделю не роняет, но и заказ на неё молча не рождает
      // (Р9).
      expect(approval.statusCode, approval.body).toBe(200);
      const items = await itemRows(weekly.id);
      expect(items[0]!.result).toBe('skipped');
      expect(items[0]!.skip_reason).toContain('огашен');
      expect(items[0]!.created_request_id).toBeNull();
      expect(items[1]!.result).toBe('extended');
    }, 60_000);

    it('деактивированная категория в строке «нужна дополнительно» тоже пропускает строку', async () => {
      const objectId = await freshObject();
      const { typeId, categoryId } = await makeTypeWithCategory('wk_dead_cat', 'Под гашение');
      const alive = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [newItem({ typeId, categoryId }, W1, W1_END), extendItem(alive, W1_END)],
      });

      await ctx.db.execute(
        sql`UPDATE vehicle_categories SET is_active = false WHERE id = ${categoryId}`,
      );

      const { approval } = await submitAndApprove(weekly);
      expect(approval.statusCode, approval.body).toBe(200);
      const items = await itemRows(weekly.id);
      expect(items[0]!.result).toBe('skipped');
      expect(items[0]!.skip_reason).toContain('огашен');
      expect(items[1]!.result).toBe('extended');
    }, 60_000);
  });

  it('машину переназначили между подачей и визой: снимок берёт новую, расхождение показывается только после применения', async () => {
    const objectId = await freshObject();
    const [before, after] = ctx.rentalPair;
    const order = await makeOrder({ objectId, ownership: 'rental', vehicle: before });
    const weekly = await makeWeekly(ctx.admin.auth, {
      objectId,
      weekStart: W1,
      items: [extendItem(order, W1_END)],
    });
    const submitted = await submitWeekly(ctx.admin.auth, weekly.id, weekly.version);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const pending = submitted.json().request as WeeklyDto;

    // Замена техники — отдельное решение со своей визой (ADR 0048), и строку недели она не
    // выбрасывает никогда: сверяется срок, а не машина и не версия.
    const swapped = await inject(
      'PATCH',
      `/api/v1/vehicle-requests/${order.id}/assignment`,
      ctx.admin.auth,
      { vehicleId: after.id, pricePerHour: 1500, version: order.version },
    );
    expect(swapped.statusCode, swapped.body).toBe(200);

    const approval = await approveWeekly(ctx.admin.auth, weekly.id, pending.version);
    expect(approval.statusCode, approval.body).toBe(200);
    // Снимок берётся **при применении**, поэтому переназначение до визы в него просто попадает.
    const [item] = await itemRows(weekly.id);
    expect(item!.result).toBe('extended');
    expect(item!.snapshot_vehicle_id).toBe(after.id);

    const docsUrl = `/api/v1/weekly-vehicle-requests/${weekly.id}/documents`;
    const quiet = await inject('GET', docsUrl, ctx.admin.auth);
    expect(quiet.statusCode, quiet.body).toBe(200);
    expect(quiet.json().rows[0].vehicleChanged).toBe(false);

    // А вот переназначение **после** применения — уже расхождение с согласованным, и чек-лист
    // обязан его показать.
    const current = await orderDto(order.id);
    const swappedBack = await inject(
      'PATCH',
      `/api/v1/vehicle-requests/${order.id}/assignment`,
      ctx.admin.auth,
      { vehicleId: before.id, pricePerHour: 1500, version: current.version },
    );
    expect(swappedBack.statusCode, swappedBack.body).toBe(200);
    const loud = await inject('GET', docsUrl, ctx.admin.auth);
    expect(loud.statusCode, loud.body).toBe(200);
    expect(loud.json().rows[0].vehicleChanged).toBe(true);
  }, 60_000);

  // ── Назначенный и заявленный вывоз исключают единицу из недели ──
  //
  // Правило одно на три источника: вывоз оформлен рейсом-перегоном, отъезд решён другой применённой
  // неделей, отъезд заявлен и ждёт визы. По такой единице решение уже принято, и второе решение о
  // той же машине ему противоречило бы. Проверка живёт в `sourceItemBlocker`, поэтому действует и
  // при сборке, и **на применении**: между подачей и визой проходят часы, и вывоз в эти часы
  // вполне успевают оформить.

  describe('назначенный и заявленный вывоз', () => {
    /** Заказ с запасом в два дня: сокращать нечего у срока, кончающегося сегодня. */
    const earlyEndOrder = (objectId: string) =>
      makeOrder({ objectId, ownership: 'rental', dateTo: shiftDateKey(TODAY, 2) });

    it('запрос на отъезд, поданный между подачей и визой, выбрасывает строку с причиной', async () => {
      const objectId = await freshObject();
      const order = await earlyEndOrder(objectId);
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      await requestEarlyEnd(order);

      const { approval } = await submitAndApprove(weekly);
      // Единственная строка негодна — заявка остаётся на визе.
      expect(approval.statusCode, approval.body).toBe(422);
      expect(approval.json().message).toContain('досрочный отъезд');

      const [item] = await itemRows(weekly.id);
      expect(item!.result).toBe('pending');
      // Чужое решение неделя не отменяет ни молча, ни согласием: запрос остаётся на месте, срок
      // заказа — прежним. Согласия в составе больше нет вовсе — второго способа снять чужой
      // запрос у модуля быть не должно.
      expect(await pendingEarlyEnds(order.id)).toBe(1);
      expect((await orderRow(order.id)).date_to).toBe(order.effectiveDateTo);
    }, 60_000);

    it('единицу с нерешённым запросом на отъезд в состав не принимают вовсе', async () => {
      const objectId = await freshObject();
      const order = await earlyEndOrder(objectId);
      await requestEarlyEnd(order);

      const res = await inject('POST', '/api/v1/weekly-vehicle-requests', ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      // Отказ на сохранении, а не молчаливое включение: решать запрос — отдельное действие со
      // своей визой (ADR 0044), и неделя его не заменяет.
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toContain('ждёт визы');
    }, 60_000);

    it('вывоз, оформленный между подачей и визой, выбрасывает строку и называет рейс', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      const routeNum = await insertPickupRoute(order);

      const { approval } = await submitAndApprove(weekly);
      expect(approval.statusCode, approval.body).toBe(422);
      // Причина называет рейс: отменяют вывоз им, а не поиском по журналу.
      expect(approval.json().message).toContain(`Р-${routeNum}`);
      expect((await orderRow(order.id)).date_to).toBe(order.effectiveDateTo);
    }, 60_000);

    /**
     * Тест ради того, зачем «уезжает» вынесено из `leftJoin` в отдельную выборку: применённых
     * недель с решением об отъезде по одному заказу бывает несколько (машина уехала по одной
     * неделе, потом заказ продлили обычной правкой и снова отпустили по другой), и join размножил
     * бы кандидата — то есть строку в предложении и в составе.
     *
     * Обе недели заводятся прямым SQL: собрать их через API теперь нельзя вовсе — первая же
     * применённая закрывает заказ для второй, — но данные такого вида в базе есть, и предложение
     * обязано их пережить.
     */
    it('заказ, уехавший в двух применённых неделях, приходит одной строкой и называет последнюю', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId });
      const older = await insertAppliedLeave(objectId, order, shiftDateKey(CUR_MON, -14));
      const newer = await insertAppliedLeave(objectId, order, shiftDateKey(CUR_MON, -7));

      const res = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/suggestion?objectId=${objectId}&weekStart=${W1}`,
        ctx.admin.auth,
      );
      expect(res.statusCode, res.body).toBe(200);
      const suggestion = res.json();

      const rows = [...suggestion.extend, ...suggestion.leaving, ...suggestion.beyond].filter(
        (o: { requestId: string }) => o.requestId === order.id,
      );
      expect(rows).toHaveLength(0);
      const blocked = suggestion.blocked.filter(
        (b: { requestId: string }) => b.requestId === order.id,
      );
      // Ровно одна строка — размножения кандидата не случилось.
      expect(blocked).toHaveLength(1);
      // И названа последняя из двух недель: «уезжает по НЗ-19» и «по НЗ-15» — разные сообщения,
      // и выбор «какой-нибудь» строки давал бы разный текст между двумя одинаковыми запросами.
      expect(blocked[0].reason).toContain(formatWeeklyRequestNumber(newer));
      expect(blocked[0].reason).not.toContain(formatWeeklyRequestNumber(older));
    }, 60_000);
  });

  /**
   * История заказа объясняет продление (Р6, §5 шаг 7, §8 шаг 7): срок сдвинула виза под чужим
   * документом, и без события дата менялась бы будто сама собой. Номер пакета виден и join'ом
   * (`weeklyExtensions`), но на вопрос «почему у заказа другой срок» отвечает история.
   */
  it('история заказа объясняет продление номером недельной заявки', async () => {
    const objectId = await freshObject();
    const order = await makeOrder({ objectId, ownership: 'rental' });
    const weekly = await makeWeekly(ctx.admin.auth, {
      objectId,
      weekStart: W1,
      items: [extendItem(order, W1_END)],
    });
    const { approval } = await submitAndApprove(weekly);
    expect(approval.statusCode, approval.body).toBe(200);

    const history = await inject(
      'GET',
      `/api/v1/vehicle-requests/${order.id}/history`,
      ctx.admin.auth,
    );
    expect(history.statusCode, history.body).toBe(200);
    expect(JSON.stringify(history.json())).toContain(formatWeeklyRequestNumber(weekly.num));
  }, 60_000);

  // ── Версии, недели и уникальность документа ──

  describe('версии и недели', () => {
    it('применение с устаревшей версией — 409, а не тихая виза чужого состава', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      const submitted = await submitWeekly(ctx.admin.auth, weekly.id, weekly.version);
      expect(submitted.statusCode, submitted.body).toBe(200);
      const pending = submitted.json().request as WeeklyDto;

      // Версия доходит до сервиса, а не остаётся в маршруте: иначе согласовали бы не тот состав,
      // который видел визирующий (Р6).
      const stale = await approveWeekly(ctx.admin.auth, weekly.id, pending.version - 1);
      expect(stale.statusCode, stale.body).toBe(409);
      expect((await weeklyRow(weekly.id))!.status).toBe('pending');
      expect((await orderRow(order.id)).date_to).toBe(order.effectiveDateTo);

      const fresh = await approveWeekly(ctx.admin.auth, weekly.id, pending.version);
      expect(fresh.statusCode, fresh.body).toBe(200);
    }, 60_000);

    it('недопустимая неделя в теле запроса — 422 от API, а не только от формы', async () => {
      const objectId = await freshObject();
      const cases: [string, string][] = [
        [shiftDateKey(CUR_MON, -7), 'прошедшая неделя'],
        [CUR_MON, 'текущая неделя'],
        [W5, 'пятая будущая неделя'],
        [shiftDateKey(W1, 1), 'вторник вместо понедельника'],
      ];
      for (const [weekStart, what] of cases) {
        const res = await inject('POST', '/api/v1/weekly-vehicle-requests', ctx.admin.auth, {
          objectId,
          weekStart,
          items: [],
        });
        expect(res.statusCode, `${what}: ${res.body}`).toBe(422);
      }
      // Четвёртая будущая — последняя допустимая: граница проверяется с обеих сторон.
      const ok = await makeWeekly(ctx.admin.auth, { objectId, weekStart: W4 });
      expect(ok.status).toBe('draft');
    }, 60_000);

    it('черновик дожил до своей недели: подача и виза — 422, отмена проходит', async () => {
      // Заявку на текущую неделю API не заводит вовсе, поэтому состояние «черновик пролежал до
      // понедельника» воспроизводится вставкой — ради него и существует проверка на подаче.
      const stale = await insertWeekly('draft');
      const submitted = await submitWeekly(ctx.admin.auth, stale.id, stale.version);
      expect(submitted.statusCode, submitted.body).toBe(422);
      expect((await weeklyRow(stale.id))!.status).toBe('draft');

      // Та же заявка, доживи она до недели уже поданной: виза обязана отказать под блокировкой,
      // иначе портал продлил бы сроки задним числом относительно собственного правила.
      const pending = await insertWeekly('pending');
      const approval = await approveWeekly(ctx.admin.auth, pending.id, pending.version);
      expect(approval.statusCode, approval.body).toBe(422);
      expect((await weeklyRow(pending.id))!.status).toBe('pending');

      // Снять с рассмотрения нужно уметь всегда — проверка недели к отмене не применяется (§8).
      const cancelled = await cancelWeekly(
        ctx.admin.auth,
        pending.id,
        pending.version,
        'Неделя прошла',
      );
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect((await weeklyRow(pending.id))!.status).toBe('cancelled');
    }, 60_000);

    it('вторая заявка на ту же пару «объект + неделя» — отказ с номером первой', async () => {
      const objectId = await freshObject();
      const first = await makeWeekly(ctx.admin.auth, { objectId, weekStart: W3 });
      const second = await inject('POST', '/api/v1/weekly-vehicle-requests', ctx.admin.auth, {
        objectId,
        weekStart: W3,
        items: [],
      });
      expect(second.statusCode, second.body).toBe(409);
      // Ответ называет существующую: кнопка открывает её, а не заводит вторую (Р3).
      expect(second.json().message).toContain(formatWeeklyRequestNumber(first.num));

      // Снятая заявка место не занимает — частичный UNIQUE её не считает.
      const dropped = await cancelWeekly(ctx.admin.auth, first.id, first.version);
      expect(dropped.statusCode, dropped.body).toBe(200);
      const third = await makeWeekly(ctx.admin.auth, { objectId, weekStart: W3 });
      expect(third.id).not.toBe(first.id);
    }, 60_000);
  });

  // ── Две недели на один заказ ──

  it('дальняя неделя применена раньше ближней: ближняя пропускает строку, остальные применяются', async () => {
    const objectId = await freshObject();
    // Заказ, кончающийся внутри ближней недели: только такой годится сразу в обе — дальняя
    // требует конца не раньше своего понедельника минус семь дней.
    const shared = await makeOrder({
      objectId,
      ownership: 'rental',
      dateTo: shiftDateKey(W1, 5),
    });
    const own = await makeOrder({ objectId, ownership: 'rental' });

    const near = await makeWeekly(ctx.admin.auth, {
      objectId,
      weekStart: W1,
      items: [extendItem(shared, W1_END), extendItem(own, W1_END)],
    });
    const far = await makeWeekly(ctx.admin.auth, {
      objectId,
      weekStart: W2,
      items: [extendItem(shared, W2_END)],
    });

    // Запрета на две недели у одного заказа нет намеренно: порядок применения свободен, а
    // результат определён сроком, а не очередью (§8).
    const farApplied = await submitAndApprove(far);
    expect(farApplied.approval.statusCode, farApplied.approval.body).toBe(200);
    expect((await orderRow(shared.id)).date_to).toBe(W2_END);

    const nearApplied = await submitAndApprove(near);
    expect(nearApplied.approval.statusCode, nearApplied.approval.body).toBe(200);
    const items = await itemRows(near.id);
    expect(items[0]!.result).toBe('skipped');
    // Причина обязана называть дату, до которой заказ уже продлён: без неё площадка не поймёт,
    // почему знакомая строка не прошла.
    expect(items[0]!.skip_reason).toContain(dayMonth(W2_END));
    expect(items[1]!.result).toBe('extended');
    expect((await orderRow(own.id)).date_to).toBe(W1_END);
    // Дальняя неделя не откатилась: срок заказа остался её.
    expect((await orderRow(shared.id)).date_to).toBe(W2_END);
  }, 60_000);

  it('заказ, продлённый двумя неделями подряд, показывает обе ссылки в карточке', async () => {
    const objectId = await freshObject();
    const order = await makeOrder({ objectId, ownership: 'rental' });
    const first = await makeWeekly(ctx.admin.auth, {
      objectId,
      weekStart: W1,
      items: [extendItem(order, W1_END)],
    });
    const firstApplied = await submitAndApprove(first);
    expect(firstApplied.approval.statusCode, firstApplied.approval.body).toBe(200);

    // Вторая неделя собирается уже после применения первой: снимок `expected_date_to` берётся
    // из заказа сейчас, и расхождения не будет.
    const second = await makeWeekly(ctx.admin.auth, {
      objectId,
      weekStart: W2,
      items: [extendItem(order, W2_END)],
    });
    const secondApplied = await submitAndApprove(second);
    expect(secondApplied.approval.statusCode, secondApplied.approval.body).toBe(200);

    const dto = await orderDto(order.id);
    // Одно поле «Основание» солгало бы на второй же неделе (Р16): у продлённого заказа основания
    // нет вовсе, а продлений список.
    expect(dto.weeklyOrigin).toBeNull();
    expect(
      dto.weeklyExtensions.map((e: { weeklyRequestNum: number }) => e.weeklyRequestNum),
    ).toEqual([first.num, second.num]);
    expect((await orderRow(order.id)).date_to).toBe(W2_END);
  }, 60_000);

  // ── Права и область ──

  describe('права и область', () => {
    it('модуль закрыт коменданту и оператору вывоза', async () => {
      const denied: [string, Auth][] = [
        ['комендант', ctx.commandant.auth],
        ['оператор вывоза', ctx.wasteOperator.auth],
      ];
      for (const [who, auth] of denied) {
        // У обоих нет и чтения заказов ТС: комендант — заказчик только по мусору, оператор вывоза
        // к технике не относится вовсе. Объяснять им продления нечем, и модуль закрыт правом.
        const res = await inject('GET', FEED_WEEKLY, auth);
        expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
      }
    });

    it('штаб чужой площадки заявку не видит, штаб своей — видит', async () => {
      const objectId = await freshObject();
      const weekly = await makeWeekly(ctx.admin.auth, { objectId, weekStart: W2 });

      const foreign = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${weekly.id}`,
        ctx.shtabForeign.auth,
      );
      // 404, а не 403: проверка чтения идёт тем же предикатом, что фильтрует список, и о
      // документе, которого учётка не видит, портал не сообщает даже факта существования.
      // Внятный отказ «работает только со своими объектами» остался на правке и визе.
      expect(foreign.statusCode, foreign.body).toBe(404);

      const own = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${weekly.id}`,
        ctx.shtab.auth,
      );
      expect(own.statusCode, own.body).toBe(200);
    }, 60_000);

    it('наблюдатель читает недели всех площадок и не правит ни одной', async () => {
      const objectId = await freshObject();
      const weekly = await makeWeekly(ctx.admin.auth, { objectId, weekStart: W2 });

      const list = await inject('GET', FEED_WEEKLY, ctx.observer.auth);
      expect(list.statusCode, list.body).toBe(200);
      expect(feedWeeklyIds(list)).toContain(weekly.id);

      const card = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${weekly.id}`,
        ctx.observer.auth,
      );
      expect(card.statusCode, card.body).toBe(200);
      // Сквозной просмотр — это просмотр: ни собрать неделю, ни подать, ни завизировать.
      const submit = await submitWeekly(ctx.observer.auth, weekly.id, weekly.version);
      expect(submit.statusCode, submit.body).toBe(403);
    }, 60_000);

    /**
     * Отдел видит неделю **своей площадки** (ADR 0062) и только её: собственной объектной оси у
     * роли нет, а площадка приходит из справочника отдела. Отдел без площадки не видит ни одной —
     * пустая область означает «ничего», а не «всё».
     */
    it('сотрудник отдела видит неделю площадки своего отдела и не видит соседнюю', async () => {
      const own = await freshObject();
      const foreign = await freshObject();
      const digits = String(Date.now()).slice(-6);
      const dept = await ctx.db.execute<{ id: string }>(sql`
          INSERT INTO departments (code, name, construction_object_id)
          VALUES (${`WK-DEP-${digits}`}, ${`Тестовый отдел ${digits}`}, ${own})
          RETURNING id`);
      await ctx.db.execute(sql`
          INSERT INTO user_departments (user_id, department_id)
          VALUES (${ctx.department.id}, ${dept.rows[0]!.id})
          ON CONFLICT DO NOTHING`);

      const mine = await makeWeekly(ctx.admin.auth, { objectId: own, weekStart: W2 });
      const alien = await makeWeekly(ctx.admin.auth, { objectId: foreign, weekStart: W2 });

      const list = await inject('GET', FEED_WEEKLY, ctx.department.auth);
      expect(list.statusCode, list.body).toBe(200);
      const ids = feedWeeklyIds(list);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(alien.id);

      const denied = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${alien.id}`,
        ctx.department.auth,
      );
      expect(denied.statusCode, denied.body).toBe(404);
    }, 90_000);

    /**
     * Арендодатель — единственный субъект, чья область считается не площадкой, а составом: неделю
     * ему открывает его же машина. Всё, что показывает чужой состав, обязано сузиться тем же
     * условием — строки, счётчики и `payload` истории, — иначе документ отдаёт ему парк площадки:
     * номера чужих заказов, машины конкурентов и их сроки.
     */
    it('арендодатель видит неделю со своей машиной, в ней — только свои строки и историю без payload', async () => {
      const objectId = await freshObject();
      const mineOrder = await makeOrder({ objectId, ownership: 'rental' });
      const foreignOrder = await makeOrder({ objectId, ownership: 'rental' });
      // Машина заказа помечается его контрагентом: роль арендодателя появляется в заявке вместе
      // с назначением (ADR 0027, 0038), своего поля исполнителя у заявки ТС нет.
      await ctx.db.execute(sql`
          UPDATE vehicles SET lessor_id = ${ctx.lessorCounterpartyId}
          WHERE id = ${mineOrder.vehicleId}`);

      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(mineOrder, W1_END), extendItem(foreignOrder, W1_END)],
      });
      const without = await makeWeekly(ctx.admin.auth, {
        objectId: await freshObject(),
        weekStart: W1,
      });

      const list = await inject('GET', FEED_WEEKLY, ctx.lessor.auth);
      expect(list.statusCode, list.body).toBe(200);
      const ids = feedWeeklyIds(list);
      expect(ids).toContain(weekly.id);
      // Неделя без его техники не видна вовсе — и в списке, и по прямой ссылке.
      expect(ids).not.toContain(without.id);
      const alien = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${without.id}`,
        ctx.lessor.auth,
      );
      expect(alien.statusCode, alien.body).toBe(404);

      const card = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${weekly.id}`,
        ctx.lessor.auth,
      );
      expect(card.statusCode, card.body).toBe(200);
      const dto = card.json() as WeeklyDto;
      expect(dto.items).toHaveLength(1);
      expect(dto.items[0]!.sourceRequestId).toBe(mineOrder.id);
      // Счётчик считается по видимым строкам: «2 единицы» рядом с одной строкой сказали бы ровно
      // то, что от него закрыто.
      expect(dto.counts.extend).toBe(1);

      const history = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${weekly.id}/history`,
        ctx.lessor.auth,
      );
      expect(history.statusCode, history.body).toBe(200);
      const events = history.json() as { event: string; payload: unknown }[];
      expect(events.length).toBeGreaterThan(0);
      // `payload` несёт содержание документа отдельно от строк: размер состава у
      // `items_changed`, номера и сроки всех заказов у `applied`. Сужения строк тут мало.
      for (const event of events) expect(event.payload, event.event).toBeNull();

      // Полный состав при этом видит тот, кому площадка своя, — сравнение с той же заявкой.
      const full = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${weekly.id}`,
        ctx.admin.auth,
      );
      expect((full.json() as WeeklyDto).items).toHaveLength(2);
    }, 120_000);

    it('диспетчер и менеджер без объектов видят все площадки', async () => {
      const first = await freshObject();
      const second = await freshObject();
      const onFirst = await makeWeekly(ctx.admin.auth, { objectId: first, weekStart: W3 });
      const onSecond = await makeWeekly(ctx.admin.auth, { objectId: second, weekStart: W3 });

      for (const [who, auth] of [
        ['диспетчер', ctx.dispatcher.auth],
        ['менеджер', ctx.manager.auth],
      ] as [string, Auth][]) {
        const res = await inject('GET', FEED_WEEKLY, auth);
        expect(res.statusCode, `${who}: ${res.body}`).toBe(200);
        const ids = feedWeeklyIds(res);
        // Та самая ветка, которую легко потерять: объектов у офисной роли нет, и правило,
        // выведенное из «есть ли у роли объекты», закрыло бы ей список, а не открыло.
        expect(ids, who).toContain(onFirst.id);
        expect(ids, who).toContain(onSecond.id);
      }
    }, 60_000);

    it('штаб продлевает заказ недельной заявкой, хотя править работающий заказ ему закрыто', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });

      // Прямая правка срока штабу закрыта: `assertObjectRoleEditable` не даёт объектной роли
      // трогать заказ вне статуса «Новая» — именно это и делало продление невозможным.
      const direct = await inject('PATCH', `/api/v1/vehicle-requests/${order.id}`, ctx.shtab.auth, {
        requestType: 'special_equipment',
        dateTo: W1_END,
        version: order.version,
      });
      expect(direct.statusCode, direct.body).toBe(403);

      const weekly = await makeWeekly(ctx.shtab.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      // У штаба нет `weeklyRequests.approve`: подача оставляет заявку на визе.
      const submitted = await submitWeekly(ctx.shtab.auth, weekly.id, weekly.version);
      expect(submitted.statusCode, submitted.body).toBe(200);
      const pending = submitted.json().request as WeeklyDto;
      expect(pending.status).toBe('pending');
      expect(submitted.json().apply).toBeNull();

      const approval = await approveWeekly(ctx.rukstroy.auth, weekly.id, pending.version);
      expect(approval.statusCode, approval.body).toBe(200);
      // Продлевает не тот, кто просил, а виза руководителя строительства — осознанное
      // исключение (Р7).
      expect((await orderRow(order.id)).date_to).toBe(W1_END);
      expect((await weeklyRow(weekly.id))!.approved_by).toBe(ctx.rukstroy.id);
    }, 60_000);

    it('руководитель строительства своей площадки: подача применяет заявку сразу', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.rukstroy.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      const submitted = await submitWeekly(ctx.rukstroy.auth, weekly.id, weekly.version);
      expect(submitted.statusCode, submitted.body).toBe(200);
      // Виза применяет заявку той же транзакцией: состояния «завизировано, но сроки прежние» не
      // бывает (Р6, Р8).
      expect(submitted.json().request.status).toBe('applied');
      expect(submitted.json().apply.applied).toBe(1);
      expect((await orderRow(order.id)).date_to).toBe(W1_END);
    }, 60_000);

    it('администратор визирует вручную, но автовизы при подаче не получает', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      const submitted = await submitWeekly(ctx.admin.auth, weekly.id, weekly.version);
      expect(submitted.statusCode, submitted.body).toBe(200);
      // Право визы у администратора есть, но действует он не за объект (ADR 0032, Р12).
      expect(submitted.json().request.status).toBe('pending');
      expect(submitted.json().apply).toBeNull();
      expect((await orderRow(order.id)).date_to).toBe(order.effectiveDateTo);

      const approval = await approveWeekly(
        ctx.admin.auth,
        weekly.id,
        submitted.json().request.version,
      );
      expect(approval.statusCode, approval.body).toBe(200);
      expect((await orderRow(order.id)).date_to).toBe(W1_END);
    }, 60_000);

    it('черновик виден руководителю своей площадки, но в очередь визы не попадает', async () => {
      const objectId = await freshObject();
      const before = await inject('GET', FEED_WEEKLY, ctx.rukstroy.auth);
      expect(before.statusCode, before.body).toBe(200);
      const pendingBefore = before.json().weeklyPendingCount as number;

      const draft = await makeWeekly(ctx.admin.auth, { objectId, weekStart: W4 });
      const seen = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${draft.id}`,
        ctx.rukstroy.auth,
      );
      expect(seen.statusCode, seen.body).toBe(200);

      const after = await inject('GET', FEED_WEEKLY, ctx.rukstroy.auth);
      expect(after.statusCode, after.body).toBe(200);
      // Черновик в ленте есть — руководителю своей площадки он виден.
      expect(feedWeeklyIds(after)).toContain(draft.id);
      // Но очередь визы им не выросла: вместо запрета видеть — фильтр счётчика, решать по
      // черновику пока нечего (§10 ADR 0085).
      expect(after.json().weeklyPendingCount).toBe(pendingBefore);
    }, 60_000);
  });

  // ── Уборка следов при удалении насовсем (Р15) ──

  describe('purge: намерение уступает, факт держит', () => {
    it('purge заказа снимает строки неприменённой заявки, поднимает версию и пишет item_dropped', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      const submitted = await submitWeekly(ctx.admin.auth, weekly.id, weekly.version);
      expect(submitted.statusCode, submitted.body).toBe(200);
      const pending = submitted.json().request as WeeklyDto;

      const archived = await inject(
        'DELETE',
        `/api/v1/vehicle-requests/${order.id}`,
        ctx.admin.auth,
      );
      expect(archived.statusCode, archived.body).toBe(200);
      const purged = await inject(
        'DELETE',
        `/api/v1/vehicle-requests/${order.id}/purge`,
        ctx.admin.auth,
      );
      expect(purged.statusCode, purged.body).toBe(200);

      expect(await itemRows(weekly.id)).toHaveLength(0);
      const header = await weeklyRow(weekly.id);
      // Версия здесь не формальность: без неё виза прошла бы по составу, которого уже нет.
      expect(header!.version).toBe(pending.version + 1);
      const dropped = (await historyRows(weekly.id)).filter((h) => h.event === 'item_dropped');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]!.comment).toContain(order.displayNumber);

      // Состав, открытый до `purge`, при применении получает 409, а не молча визирует
      // исчезнувшую строку.
      const stale = await approveWeekly(ctx.admin.auth, weekly.id, pending.version);
      expect(stale.statusCode, stale.body).toBe(409);
    }, 60_000);

    it('удаление категории и purge типа ТС снимают строки «нужна дополнительно»', async () => {
      const objectId = await freshObject();
      const { typeId, categoryId } = await makeTypeWithCategory('wk_purge_cat', 'Под снос');
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [newItem({ typeId, categoryId }, W1, W1_END)],
      });

      // Категория сносится обычным удалением справочника: уборка сидит внутри его транзакции.
      const catRes = await inject(
        'DELETE',
        `/api/v1/vehicle-categories/${categoryId}`,
        ctx.admin.auth,
      );
      expect(catRes.statusCode, catRes.body).toBe(200);
      expect(await itemRows(weekly.id)).toHaveLength(0);
      const droppedCat = (await historyRows(weekly.id)).filter((h) => h.event === 'item_dropped');
      expect(droppedCat).toHaveLength(1);
      expect(droppedCat[0]!.comment).toContain('атегория');
      expect((await weeklyRow(weekly.id))!.version).toBe(weekly.version + 1);

      // Тип сносится своим `purge` и только погашенным.
      const typeOnly = await makeVehicleType('wk_purge_type');
      const weekly2 = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W2,
        items: [newItem({ typeId: typeOnly.id, categoryId: null }, W2, W2_END)],
      });
      await ctx.db.execute(
        sql`UPDATE vehicle_types SET is_active = false WHERE id = ${typeOnly.id}`,
      );
      const typeRes = await inject(
        'DELETE',
        `/api/v1/vehicle-types/${typeOnly.id}/purge`,
        ctx.admin.auth,
      );
      expect(typeRes.statusCode, typeRes.body).toBe(200);
      expect(await itemRows(weekly2.id)).toHaveLength(0);
      expect(
        (await historyRows(weekly2.id)).filter((h) => h.event === 'item_dropped'),
      ).toHaveLength(1);
      expect((await weeklyRow(weekly2.id))!.version).toBe(weekly2.version + 1);
    }, 60_000);

    it('purge площадки сносит неприменённые заявки целиком — открытая страница получает 404', async () => {
      // Без привязки учёток: `purge` объекта отказывает, пока на нём висит хоть одна.
      const objectId = await freshObject('WK-PURGE', false);
      const weekly = await makeWeekly(ctx.admin.auth, { objectId, weekStart: W1, items: [] });
      await ctx.db.execute(
        sql`UPDATE construction_objects SET is_active = false WHERE id = ${objectId}`,
      );

      const purged = await inject('DELETE', `/api/v1/objects/${objectId}/purge`, ctx.admin.auth);
      expect(purged.statusCode, purged.body).toBe(200);

      // Не «строки сняты», а документа больше нет: заявка на снесённую площадку — документ ни о
      // чём, и клиенту здесь положен 404, а не 409.
      const gone = await inject(
        'GET',
        `/api/v1/weekly-vehicle-requests/${weekly.id}`,
        ctx.admin.auth,
      );
      expect(gone.statusCode, gone.body).toBe(404);
    }, 60_000);

    it('применённая заявка держит и заказ, и площадку: отказ называет того, кто ссылается', async () => {
      const objectId = await freshObject('WK-HELD', false);
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      const { approval } = await submitAndApprove(weekly);
      expect(approval.statusCode, approval.body).toBe(200);

      const archived = await inject(
        'DELETE',
        `/api/v1/vehicle-requests/${order.id}`,
        ctx.admin.auth,
      );
      expect(archived.statusCode, archived.body).toBe(200);
      const purged = await inject(
        'DELETE',
        `/api/v1/vehicle-requests/${order.id}/purge`,
        ctx.admin.auth,
      );
      expect(purged.statusCode, purged.body).toBe(409);
      expect(purged.json().message).toContain('применённых недельных заявок');
      // Строка на месте: факт, объясняющий, откуда взялось продление, не затирается.
      expect(await itemRows(weekly.id)).toHaveLength(1);

      await ctx.db.execute(
        sql`UPDATE construction_objects SET is_active = false WHERE id = ${objectId}`,
      );
      const objectPurge = await inject(
        'DELETE',
        `/api/v1/objects/${objectId}/purge`,
        ctx.admin.auth,
      );
      expect(objectPurge.statusCode, objectPurge.body).toBe(409);
      expect((await weeklyRow(weekly.id))!.status).toBe('applied');
    }, 60_000);

    it('заявка стала applied, пока purge ждал блокировку: строки не снимаются, приходит отказ', async () => {
      const objectId = await freshObject();
      const order = await makeOrder({ objectId, ownership: 'rental' });
      const weekly = await makeWeekly(ctx.admin.auth, {
        objectId,
        weekStart: W1,
        items: [extendItem(order, W1_END)],
      });
      const archived = await inject(
        'DELETE',
        `/api/v1/vehicle-requests/${order.id}`,
        ctx.admin.auth,
      );
      expect(archived.statusCode, archived.body).toBe(200);

      // Соседняя сессия держит шапку `FOR UPDATE` — ровно так её берёт применение. `purge`
      // встаёт на этой блокировке и обязан перечитать статус после неё, а не работать по
      // снимку, снятому до ожидания.
      const holder = new pg.Client({ connectionString: DB_URL! });
      await holder.connect();
      let purgeRes: Awaited<ReturnType<typeof inject>>;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM weekly_vehicle_requests WHERE id = $1 FOR UPDATE', [
          weekly.id,
        ]);
        const pending = inject(
          'DELETE',
          `/api/v1/vehicle-requests/${order.id}/purge`,
          ctx.admin.auth,
        );
        await sleep(500);
        await holder.query(
          `UPDATE weekly_vehicle_request_items
             SET result = 'extended', previous_date_to = current_date,
                 applied_source_version = 1, snapshot_vehicle_id = $2
             WHERE weekly_request_id = $1`,
          [weekly.id, order.vehicleId],
        );
        await holder.query(
          `UPDATE weekly_vehicle_requests
             SET status = 'applied', approved_by = $2, approved_at = now(), applied_at = now(),
                 version = version + 1
             WHERE id = $1`,
          [weekly.id, ctx.admin.id],
        );
        await holder.query('COMMIT');
        purgeRes = await pending;
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }

      // Статус перечитан под блокировкой: строка применённой заявки не снята, и удаление честно
      // упирается в `RESTRICT`.
      expect(purgeRes.statusCode, purgeRes.body).toBe(409);
      expect(await itemRows(weekly.id)).toHaveLength(1);
      expect((await historyRows(weekly.id)).filter((h) => h.event === 'item_dropped')).toHaveLength(
        0,
      );
    }, 60_000);
  });
});
