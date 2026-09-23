import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  DAY_BATCH_LIMIT,
  DAY_BATCH_SKIP_AMBIGUOUS_ROUTE,
  DAY_BATCH_SKIP_BACKDATED,
  DAY_BATCH_SKIP_BEYOND_LIMIT,
  DAY_BATCH_SKIP_FROZEN,
  DAY_BATCH_SKIP_NO_ROOM,
  DAY_BATCH_SKIP_PLANNED,
  WAYBILL_CORRECTION_DAYS,
  moscowDateKeyOf,
  shiftDateKey,
  type VehicleRequestDayBatchResultDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
import { issueRouteWaybill } from './waybill-issue-helper';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Пачка «4-П на весь период заказа техники на объект» — `POST /vehicle-requests/:id/days/batch`
 * ([ADR 0207](../../../docs/adr/0207-vehicle-request-day-batch.md), план
 * [docs/vehicle-request-day-batch-plan.md](../../../docs/vehicle-request-day-batch-plan.md)).
 *
 * ЗАЧЕМ ЖИВАЯ БАЗА. Предмет пачки — не правило, а ПОСЛЕДОВАТЕЛЬНОСТЬ ЗАПИСЕЙ: своя транзакция на
 * каждый день (§8), номера «Р-» и номера бланков, которые из последовательностей не возвращаются,
 * ленивая строка журнала коррекций (§9) и повтор по ключу операции. Ни одно из этого не
 * воспроизводится на правилах: там, где пачка ошибётся, разойдутся код и база, а цена ошибки —
 * выданная и не названная бумага.
 *
 * Что доказывается:
 *
 * - **линейность дверь не воротит** (§1): срок НЕЛИНЕЙНОГО заказа проходит целиком, и за тот же
 *   день у него остаётся недельный ЭСМ-2 — двойная бумага названа границей Г1, а не дефектом (§2);
 * - **отчёт построчный и счётчики сходятся** — шапку «выписано N, пропущено M» читают там, где
 *   строк не показывают вовсе;
 * - **конфликтный день пропускается, а пачка идёт дальше** (§7) — и каждая из пяти помех
 *   называется СВОИМИ словами: день уже в рейсе, два рейса у машины, рейс заморожен листом, в
 *   бланке кончились строки задания, прошлое без права либо глубже предела;
 * - **замороженный рейс не обходится вторым рейсом** — иначе у машины на день оказалось бы два
 *   бланка на одну работу;
 * - **прошедшие дни идут одной операцией** (§9): строка `waybill_corrections` вида `day_batch`
 *   одна на пачку, заводится лениво и помечает причиной каждый рождённый ею лист;
 * - **предпроверка стоит до первой записи**: отказ пачки не оставляет в `vehicle_routes` ни строки,
 *   то есть не жжёт номера «Р-» (последствие ADR 0207 про рваные номера — про оборвавшуюся пачку,
 *   а не про отказ на входе);
 * - **длинный срок идёт порциями** (§11): нажатие берёт первые `DAY_BATCH_LIMIT` нераспланированных
 *   дней, называет остаток, а второе нажатие добирает хвост — уже сделанные дни места не занимают;
 * - **повтор по ключу операции продолжает работу, а не выписывает вторую стопку**.
 *
 * СВОЯ БАЗА. Файл заводит собственную базу и сносит её за собой: общая база db-тестов врёт в обе
 * стороны (шапка `apps/api/scripts/quality-db.ts`), а пачка считает рейсы МАШИНЫ НА ДАТУ — чужой
 * рейс, заведённый соседним файлом на ту же единицу и тот же день, превратил бы «ноль кандидатов»
 * в «их несколько» и покрасил бы невиновного. Из `TEST_DATABASE_URL` берётся только кластер.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_dev \
 *     pnpm --filter @technic/api exec vitest run vehicle-request-day-batch.db
 */

const DB_URL = process.env.TEST_DATABASE_URL;
/**
 * Имя своей базы ПРОИЗВОДНОЕ от основной — `<основная>_day_batch`, а не постоянное.
 *
 * Уборка `pnpm check:db` сносит базу прогона вместе со всем, что названо `<основная>_%`
 * (`apps/api/scripts/quality-db.ts`): оборванный прогон не доходит до своего `afterAll`, и база с
 * постоянным именем пережила бы его, а снаружи её от чужой не отличить. Производное имя делает
 * «сносится за собой» правдой и для прогона, убитого посередине.
 */
const OWN_DB_NAME = `${DB_URL?.replace(/^.*\//, '') ?? ''}_day_batch`;
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const PASSWORD = 'db-day-batch-password-123';
/** Хвост прогона: база своя, но коды справочников уникальны и внутри неё. */
const RUN = randomUUID().slice(0, 8);
/**
 * Код площадки — с «яя»: половина кода берёт объект выражением `ORDER BY … LIMIT 1`, и запись,
 * ставшая первой, увела бы чужие заявки на тестовую площадку. У типа ТС тот же приём в имени: код
 * у него только латиницей.
 */
const OBJECT_CODE = `яя-day-batch-${RUN}`;
const TYPE_PREFIX = `day_batch_${RUN}`;

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  /** Администратор: им собираются сцены и им же спрашивается прошлое глубже предела. */
  admin: Auth;
  /** Диспетчер — `waybills.correct` есть, `waybills.correctBeyondLimit` нет (ADR 0101 п. 4). */
  dispatcher: Auth;
  /** Менеджер — прошлого ему не положено вовсе: им проверяется пропуск прошедших дней. */
  manager: Auth;
  objectId: string;
  driverId: string;
  /** Тип нелинейный: ради него ADR 0207 §1 и снимал замок. */
  plainTypeId: string;
  /** Линейный тип — им собирается обстановка: у него портал не выписывает недельных ЭСМ-2. */
  linearTypeId: string;
  /**
   * Свои грузовые машины с бланком 4-П — по одной на случай.
   *
   * Разные машины у разных случаев не аккуратность, а условие: рейс принадлежит паре
   * «машина + дата», и два случая на одной единице в одни и те же дни видели бы рейсы друг друга —
   * «ноль кандидатов» превращалось бы в «их несколько» в зависимости от порядка тестов.
   */
  vehicles: string[];
  /** Машина, снятая с линии: ею проверяется отказ предпроверки. */
  inactiveVehicleId: string;
  /** Арендная машина: дней у такого заказа не бывает вовсе. */
  rentalVehicleId: string;
  today: string;
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
  process.env.MAIL_ENABLED ??= 'false';
}

/** Своя база с нуля: заводится, промигрируется и сносится в `afterAll`. */
async function createOwnDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_DB });
  await admin.connect();
  try {
    // `FORCE` — от соединений ПРОШЛОГО прогона, брошенных упавшим или убитым процессом: без него
    // остаток вчерашней сессии не даёт завести базу, и файл краснеет не своей виной.
    await admin.query(`DROP DATABASE IF EXISTS "${OWN_DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${OWN_DB_NAME}"`);
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
}

async function seedUser(role: 'admin' | 'dispatcher' | 'manager'): Promise<string> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/auth/password');
  const email = `db-day-batch-${role}@example.invalid`;
  await db.execute(sql`
    INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
    VALUES (${email}, 'Тестовый', ${role}, '', ${await hashPassword(PASSWORD)}, ${role}::role, true)`);
  return email;
}

/**
 * Водитель рейса: человек со специализацией «водитель». Удостоверений не заводим — отбор ставит
 * одно условие, «человек есть и он водитель» (ADR 0064), а пробелы в документах превращаются в
 * предупреждения выписки, и именно их пачка подтверждает за человека сама (§10).
 */
async function seedDriver(): Promise<string> {
  const { db } = await import('../src/db/client');
  const rows = await db.execute<{ id: string }>(sql`
    WITH person AS (
      INSERT INTO persons (last_name, first_name, middle_name, comment)
      VALUES ('Пачкин', 'Тест', 'Дневной', 'ТЕСТОВЫЕ ДАННЫЕ: пачка дней заказа')
      RETURNING id
    ), link AS (
      INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
      SELECT person.id, s.id, true, '2024-01-15'
        FROM person, specializations s
       WHERE s.code = 'driver'
      RETURNING person_id
    )
    SELECT id FROM person`);
  return rows.rows[0]!.id;
}

// ── Обращения к порталу ──

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  auth: Auth,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
}

/** Виза руководителя: без неё заявку в работу не берут. */
async function approve(request: { id: string; version: number }): Promise<number> {
  const res = await inject('PATCH', `/api/v1/vehicle-requests/${request.id}/approval`, ctx.admin, {
    approved: true,
    version: request.version,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version as number;
}

interface RequestOptions {
  typeId?: string;
  vehicleId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Объявленное прошлое: без него схема заявки не пропустит вчерашний срок. */
  backdateReason?: string;
  /** Ставка: у арендной машины назначение без денег не принимается вовсе. */
  pricePerHour?: number;
}

/** Заказ техники на объект, доведённый до работы: начало почти каждого случая. */
async function requestInProgress(
  options: RequestOptions = {},
): Promise<{ id: string; version: number; dateFrom: string; dateTo: string }> {
  const typeId = options.typeId ?? ctx.plainTypeId;
  const vehicleId = options.vehicleId ?? ctx.vehicles[0]!;
  const dateFrom = options.dateFrom ?? ctx.today;
  const dateTo = options.dateTo ?? shiftDateKey(dateFrom, 3);

  const created = await inject('POST', '/api/v1/vehicle-requests', ctx.admin, {
    requestType: 'special_equipment',
    objectId: ctx.objectId,
    vehicleTypeId: typeId,
    dateFrom,
    dateTo,
    responsibleName: 'Прорабов Пётр Петрович',
    responsiblePhone: '9007770761',
    comment: 'Планировка площадки',
    ...(options.backdateReason
      ? { backdateReason: options.backdateReason, operationId: randomUUID() }
      : {}),
  });
  expect(created.statusCode, created.body).toBe(201);
  const request = created.json();

  const confirmed = await inject(
    'PATCH',
    `/api/v1/vehicle-requests/${request.id}/status`,
    ctx.admin,
    {
      status: 'confirmed',
      comment: '',
      version: await approve(request),
      assignment: {
        vehicleId,
        pricePerHour: options.pricePerHour ?? null,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.driverId,
      },
      schedule: { requestType: 'special_equipment', dateFrom, dateTo },
    },
  );
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return {
    id: request.id as string,
    version: confirmed.json().version as number,
    dateFrom,
    dateTo,
  };
}

/** Пустой рейс на дату — им собираются обстановки «рейс уже есть» и «их два». */
async function createRoute(vehicleId: string, routeDate: string): Promise<string> {
  const created = await inject('POST', '/api/v1/vehicle-routes', ctx.admin, {
    vehicleId,
    routeDate,
    driverPersonId: ctx.driverId,
    trip: { communicationKind: 'городское' },
    // Прошедшая дата рейса требует объяснения (ADR 0101 п. 4); у будущей причина игнорируется.
    reason: 'подготовка обстановки теста',
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().id as string;
}

/** Рейс глазами карточки: версия нужна выписке, номер — сверке строк отчёта. */
async function routeOf(routeId: string): Promise<{ version: number; displayNumber: string }> {
  const res = await inject('GET', `/api/v1/vehicle-routes/${routeId}`, ctx.admin);
  expect(res.statusCode, res.body).toBe(200);
  return {
    version: res.json().version as number,
    displayNumber: res.json().displayNumber as string,
  };
}

/**
 * Выписать лист по рейсу — им рейс и замораживается.
 *
 * Через помощника: предмет случая — судьба дня под выданной бумагой, а не сама выписка, и
 * рукопожатие (ADR 0108 п. 21) здесь срабатывает всегда — документов тестовому водителю не заводят.
 */
async function freezeRoute(routeId: string): Promise<void> {
  await issueRouteWaybill({
    app: ctx.app,
    headers: { ...ctx.admin },
    routeId,
    payload: { version: (await routeOf(routeId)).version },
  });
}

/** Поставить один день подённой дверью — той самой, чьи правила пачка и повторяет. */
async function planDay(
  requestId: string,
  date: string,
  target: { routeId: string } | { vehicleId: string },
): Promise<LightMyRequestResponse> {
  const payload =
    'routeId' in target
      ? { routeId: target.routeId, reason: 'подготовка обстановки теста' }
      : {
          newRoute: { vehicleId: target.vehicleId, driverPersonId: ctx.driverId },
          reason: 'подготовка обстановки теста',
        };
  return inject(
    'POST',
    `/api/v1/vehicle-requests/${requestId}/days/${date}/route`,
    ctx.admin,
    payload,
  );
}

interface BatchBody {
  driverPersonId?: string;
  issueWaybills?: boolean;
  reason?: string;
  operationId?: string;
}

function batch(
  requestId: string,
  body: BatchBody = {},
  auth: Auth = ctx.admin,
): Promise<LightMyRequestResponse> {
  return inject('POST', `/api/v1/vehicle-requests/${requestId}/days/batch`, auth, {
    driverPersonId: ctx.driverId,
    issueWaybills: true,
    ...body,
  });
}

/** Пачка, которая обязана была пройти: 200 и разобранный отчёт. */
async function batchOk(
  requestId: string,
  body: BatchBody = {},
  auth: Auth = ctx.admin,
): Promise<VehicleRequestDayBatchResultDto> {
  const res = await batch(requestId, body, auth);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as VehicleRequestDayBatchResultDto;
}

// ── Вопросы к базе ──

/** Сколько рейсов у машины на дату: им и проверяется, сожжён ли номер «Р-». */
async function routeCount(vehicleId: string, date: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM vehicle_routes
     WHERE vehicle_id = ${vehicleId} AND route_date = ${date}`);
  return rows.rows[0]!.n;
}

/** Все рейсы этой машины, сколько бы дней ни прошло: ими считается «ни одной записи». */
async function routesOfVehicle(vehicleId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM vehicle_routes WHERE vehicle_id = ${vehicleId}`);
  return rows.rows[0]!.n;
}

interface DayWaybillRow {
  number: string;
  formCode: string;
  status: string;
  issuedForDate: string;
  correctionId: string | null;
  correctionReason: string;
}

/** Листы, выписанные по рейсам дней этой заявки, — по дню выезда. */
async function dayWaybills(requestId: string): Promise<DayWaybillRow[]> {
  const rows = await ctx.db.execute<{
    number: string;
    form_code: string;
    status: string;
    issued_for_date: string;
    correction_id: string | null;
    correction_reason: string;
  }>(sql`
    SELECT w.number::text AS number, w.form_code, w.status::text AS status,
           w.issued_for_date::text AS issued_for_date, w.correction_id::text AS correction_id,
           w.correction_reason
      FROM waybills w
      JOIN vehicle_route_requests rr ON rr.route_id = w.route_id
     WHERE rr.request_id = ${requestId}
     ORDER BY w.issued_for_date`);
  return rows.rows.map((row) => ({
    number: row.number,
    formCode: row.form_code,
    status: row.status,
    issuedForDate: row.issued_for_date,
    correctionId: row.correction_id,
    correctionReason: row.correction_reason,
  }));
}

/** Недельные ЭСМ-2 заявки: ими проверяется, что пачка их не тронула (§2, граница Г1). */
async function esm2Count(requestId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM waybills
     WHERE source_request_id = ${requestId} AND form_code = 'esm2' AND status <> 'cancelled'`);
  return rows.rows[0]!.n;
}

/** Строки журнала коррекций по ключу операции: их обязана быть ровно одна на пачку. */
async function correctionsOf(
  operationId: string,
): Promise<{ id: string; kind: string; reason: string; payload: Record<string, unknown> }[]> {
  const rows = await ctx.db.execute<{
    id: string;
    kind: string;
    reason: string;
    payload: Record<string, unknown>;
  }>(sql`
    SELECT id::text AS id, kind, reason, payload FROM waybill_corrections
     WHERE operation_id = ${operationId}`);
  return rows.rows;
}

/** Заявки, которых операция коснулась: по этой связи её находит карточка разбирательства. */
async function linkedRequests(correctionId: string): Promise<string[]> {
  const rows = await ctx.db.execute<{ request_id: string }>(sql`
    SELECT request_id::text AS request_id FROM vehicle_request_corrections
     WHERE correction_id = ${correctionId}`);
  return rows.rows.map((row) => row.request_id);
}

/** Строки состава рейса: ими считается ёмкость задания бланка. */
async function routeRequestCount(routeId: string): Promise<number> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM vehicle_route_requests WHERE route_id = ${routeId}`);
  return rows.rows[0]!.n;
}

describe.skipIf(!DB_URL)('пачка «4-П на весь период» (живая схема)', () => {
  /*
   * Сроки здесь измеряются десятками транзакций: каждый день пачки — своя транзакция с номером
   * бланка под `FOR UPDATE` (§8), а подготовка заводит заявки настоящими ручками. Пятисекундный
   * предел vitest по умолчанию рассчитан не на это.
   */
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 900_000 });

  beforeAll(async () => {
    await createOwnDatabase();
    prepareEnv(OWN_DB!);

    const { db, closeDb } = await import('../src/db/client');
    const adminEmail = await seedUser('admin');
    const dispatcherEmail = await seedUser('dispatcher');
    const managerEmail = await seedUser('manager');
    const driverId = await seedDriver();

    const objectRow = await db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${OBJECT_CODE}, ${`Площадка пачки дней ${RUN}`}, 'г Москва, ул Дневная, д 5')
      RETURNING id`);

    /*
     * Машины — из справочника: их наполняют миграции, и рейс заводится только на собственную
     * активную технику. Грузовой вид с бланком 4-П — тот самый документ, который печатает день.
     */
    const own = await db.execute<{ id: string; kind_id: string }>(sql`
      SELECT v.id, vt.kind_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.ownership = 'own' AND v.status = 'active' AND v.deleted_at IS NULL
         AND vt.waybill_form_code = '4p' AND vk.code = 'freight_transport'
       ORDER BY v.registration_number
       LIMIT 16`);
    if (own.rows.length < 16) {
      throw new Error('в базе нет шестнадцати своих грузовых машин с 4-П: миграции не применены');
    }
    const kindId = own.rows[0]!.kind_id;

    const rental = await db.execute<{ id: string }>(sql`
      SELECT id FROM vehicles
       WHERE ownership = 'rental' AND deleted_at IS NULL ORDER BY id LIMIT 1`);
    if (!rental.rows[0])
      throw new Error('в справочнике нет арендной техники: миграции не применены');

    const { buildApp: build } = await import('../src/app');
    const app = await build();
    await app.ready();

    async function login(email: string): Promise<Auth> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return { authorization: `Bearer ${res.json().accessToken}` };
    }

    const admin = await login(adminEmail);
    async function createType(isLinear: boolean): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/vehicle-types',
        headers: admin,
        payload: {
          kindId,
          code: `${TYPE_PREFIX}_${isLinear ? 'lin' : 'plain'}`,
          name: `Ямобуры пачки, ${isLinear ? 'линейный' : 'обычный'} ${RUN}`,
          isLinear,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    }

    // Последняя из шестнадцати уезжает в ремонт посреди работающего заказа — это делает сам
    // случай. Единица у него своя, чтобы у остальных ничего под ногами не менялось.
    const inactiveVehicleId = own.rows[15]!.id;

    ctx = {
      app,
      db,
      closeDb,
      admin,
      dispatcher: await login(dispatcherEmail),
      manager: await login(managerEmail),
      objectId: objectRow.rows[0]!.id,
      driverId,
      plainTypeId: await createType(false),
      linearTypeId: await createType(true),
      vehicles: own.rows.slice(0, 15).map((row) => row.id),
      inactiveVehicleId,
      rentalVehicleId: rental.rows[0].id,
      today: moscowDateKeyOf(new Date()),
    };
  });

  afterAll(async () => {
    // Уборки за собой нет намеренно: база своя и сносится целиком — вычищать в ней нечего.
    await ctx?.app.close();
    await ctx?.closeDb();
    if (!DB_URL) return;
    const admin = new pg.Client({ connectionString: ADMIN_DB });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${OWN_DB_NAME}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  /**
   * §1 и §2 разом: замок линейности снят, а ЭСМ-2 не тронут.
   *
   * Заявка здесь НЕЛИНЕЙНАЯ — та самая, которой до ADR 0207 дней не полагалось вовсе. Проверяется
   * не только «пачка прошла», но и обе половины цены: таблица дней у неё больше не пуста и блока
   * не показывает, а недельный ЭСМ-2 за тот же день остался на месте (граница Г1).
   */
  it('срок нелинейного заказа проходит целиком: дни в рейсах, листы выписаны, отчёт построчный', async () => {
    const vehicleId = ctx.vehicles[0]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));
    // Недельный лист заказу выписал сам перевод в работу: пачка его не отменяет и не заменяет.
    const esm2Before = await esm2Count(request.id);
    expect(esm2Before).toBeGreaterThan(0);

    const result = await batchOk(request.id);

    expect(result.issued).toBe(4);
    expect(result.planned).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    // Срок короче предела порции — за окном не осталось ничего (§11).
    expect(result.remaining).toBe(0);
    expect(result.rows.map((row) => row.date)).toEqual(days);
    for (const row of result.rows) {
      expect(row.outcome).toBe('issued');
      expect(row.reason).toBeUndefined();
      expect(row.routeNumber).toMatch(/^Р-\d+$/);
      expect(row.waybillNumber).toBeTruthy();
    }
    // Рейс у каждого дня свой: рейс принадлежит паре «машина + дата», и один на четыре дня был бы
    // невозможен физически (составной FK, миграция 0127).
    expect(new Set(result.rows.map((row) => row.routeNumber)).size).toBe(4);

    /*
     * Таблица дней приезжает вместе с отчётом и уже новая (§«Ответ» сервиса): карточка обязана
     * показать ту картину, по которой составлен отчёт.
     */
    expect(result.days.blocker).toBeNull();
    expect(result.days.items).toHaveLength(4);
    for (const item of result.days.items) {
      expect(item.route).not.toBeNull();
      expect(item.route!.vehicleId).toBe(vehicleId);
      // Машина взята из назначения (§5) — расхождения нет и помечать нечего.
      expect(item.otherVehicle).toBe(false);
      expect(item.route!.waybill).not.toBeNull();
    }

    const waybills = await dayWaybills(request.id);
    expect(waybills.map((w) => w.issuedForDate)).toEqual(days);
    for (const waybill of waybills) {
      expect(waybill.formCode).toBe('4p');
      expect(waybill.status).toBe('issued');
      // Сегодняшняя и будущая бумага операцией коррекции не является: строки журнала у неё нет.
      expect(waybill.correctionId).toBeNull();
    }

    // Двойная бумага названа границей Г1: недельный ЭСМ-2 на месте, дневные 4-П рядом.
    expect(await esm2Count(request.id)).toBe(esm2Before);
  });

  /**
   * Вторая половина решения §«Тело пачки»: `issueWaybills: false` расставляет дни и не расходует
   * ни одного номера бланка. Рейс собирают заранее, бумагу выдают тогда, когда она поедет.
   */
  it('без выписки листов пачка только заводит рейсы — номера бланков не расходуются', async () => {
    const request = await requestInProgress({ vehicleId: ctx.vehicles[1]! });

    const result = await batchOk(request.id, { issueWaybills: false });

    expect(result.planned).toBe(4);
    expect(result.issued).toBe(0);
    expect(result.skipped + result.failed).toBe(0);
    for (const row of result.rows) {
      expect(row.outcome).toBe('planned');
      expect(row.routeNumber).toMatch(/^Р-\d+$/);
      expect(row.waybillNumber).toBeUndefined();
    }
    expect(await dayWaybills(request.id)).toHaveLength(0);
    for (const item of result.days.items) {
      expect(item.route).not.toBeNull();
      expect(item.route!.waybill).toBeNull();
    }
  });

  /**
   * §7, первая из пяти помех: день, уже стоящий в рейсе этой заявки, пачка не трогает.
   *
   * Важно не только то, что он пропущен, но и то, что пачка ПОШЛА ДАЛЬШЕ: ради этого исход и
   * заведён отдельным от `failed`.
   */
  it('день, уже стоящий в рейсе, пропускается своими словами, а пачка идёт дальше', async () => {
    const vehicleId = ctx.vehicles[2]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));
    const planned = await planDay(request.id, days[1]!, { vehicleId });
    expect(planned.statusCode, planned.body).toBe(200);

    const result = await batchOk(request.id);

    expect(result.skipped).toBe(1);
    expect(result.issued).toBe(3);
    const skipped = result.rows.find((row) => row.date === days[1]);
    expect(skipped!.outcome).toBe('skipped');
    expect(skipped!.reason).toBe(DAY_BATCH_SKIP_PLANNED);
    // Второй рейс на тот же день пачка не завела: у машины на эту дату по-прежнему один.
    expect(await routeCount(vehicleId, days[1]!)).toBe(1);
    // И бумагу по чужому рейсу не выписала: пропущенный день пачка не трогает вовсе.
    expect((await dayWaybills(request.id)).map((w) => w.issuedForDate)).toEqual([
      days[0],
      days[2],
      days[3],
    ]);
  });

  /**
   * §7 и правило выбора рейса: два грузовых рейса машины на дату — законное состояние (утро и
   * вечер), и выбор между ними пачка на себя не берёт.
   *
   * Ошибись она — день уехал бы в чужое задание, а заметили бы это у принтера.
   */
  it('два рейса машины на дату: день пропускается, выбор остаётся диспетчеру', async () => {
    const vehicleId = ctx.vehicles[3]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));
    const morning = await createRoute(vehicleId, days[2]!);
    const evening = await createRoute(vehicleId, days[2]!);
    const numbers = [
      (await routeOf(morning)).displayNumber,
      (await routeOf(evening)).displayNumber,
    ];

    const result = await batchOk(request.id);

    const skipped = result.rows.find((row) => row.date === days[2]);
    expect(skipped!.outcome).toBe('skipped');
    expect(skipped!.reason).toBe(DAY_BATCH_SKIP_AMBIGUOUS_ROUTE);
    /*
     * Рейс назван поимённо: в отчёте на полсотни строк «где-то у машины два рейса» неисполнимо.
     * Который из двух — не оговорено и оговорено быть не может: кандидаты берутся под блокировку
     * по возрастанию `id`, а `id` случаен. Утверждение поэтому о принадлежности, а не о порядке.
     */
    expect(numbers).toContain(skipped!.routeNumber);
    expect(result.issued).toBe(3);
    // Третьего рейса пачка не завела — иначе у машины на день стало бы три бумаги.
    expect(await routeCount(vehicleId, days[2]!)).toBe(2);
  });

  /**
   * §7 и последствие «выписанный наперёд лист замораживает рейс» (Г2).
   *
   * Самое дорогое здесь — вторая половина: рядом с замороженным рейсом пачка НЕ заводит свой.
   * Заведи она — и у машины на один день оказалось бы два бланка на одну работу, а нашлось бы это
   * у принтера.
   */
  it('рейс, замороженный выписанным листом, день не принимает — и второго рейса рядом не заводится', async () => {
    const vehicleId = ctx.vehicles[4]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));

    // Чужой день в рейсе этой машины: лист по нему и замораживает рейс. Сосед — линейного типа,
    // чтобы перевод в работу не выписывал ему недельных ЭСМ-2, до которых этому случаю нет дела.
    const neighbour = await requestInProgress({ typeId: ctx.linearTypeId, vehicleId });
    const occupied = await planDay(neighbour.id, days[3]!, { vehicleId });
    expect(occupied.statusCode, occupied.body).toBe(200);
    const routeId = (
      occupied.json().items as { date: string; route: { id: string } | null }[]
    ).find((item) => item.date === days[3])!.route!.id;
    const frozen = await routeOf(routeId);
    await freezeRoute(routeId);

    const result = await batchOk(request.id);

    const skipped = result.rows.find((row) => row.date === days[3]);
    expect(skipped!.outcome).toBe('skipped');
    expect(skipped!.reason).toBe(DAY_BATCH_SKIP_FROZEN);
    // Назван тот самый рейс, который день не принял: человеку идти аннулировать именно его.
    expect(skipped!.routeNumber).toBe(frozen.displayNumber);
    expect(result.issued).toBe(3);
    expect(await routeCount(vehicleId, days[3]!)).toBe(1);
  });

  /**
   * §7 и ADR 0068: вместимость задаёт бланк рейса, и пачка её не обходит.
   *
   * Семь строк задания 4-П набираются днями семи соседних заказов — тем же подённым путём, каким
   * их набрал бы диспетчер. Ответить «ноль кандидатов» здесь было бы неправдой: рейс есть, и
   * человеку важно знать, что уплотнять день больше нечем.
   */
  it('в бланке рейса кончились строки задания — день пропускается своей причиной', async () => {
    const vehicleId = ctx.vehicles[5]!;
    const request = await requestInProgress({ vehicleId });
    const days = [0, 1, 2, 3].map((n) => shiftDateKey(request.dateFrom, n));
    const full = days[1]!;
    const routeId = await createRoute(vehicleId, full);
    const routeNumber = (await routeOf(routeId)).displayNumber;

    // Семь — ёмкость 4-П (`ROUTE_REQUEST_CAPACITY`): восьмой строке в бланке места нет.
    for (let i = 0; i < 7; i += 1) {
      const filler = await requestInProgress({ typeId: ctx.linearTypeId, vehicleId });
      const placed = await planDay(filler.id, full, { routeId });
      expect(placed.statusCode, placed.body).toBe(200);
    }
    expect(await routeRequestCount(routeId)).toBe(7);

    const result = await batchOk(request.id);

    const skipped = result.rows.find((row) => row.date === full);
    expect(skipped!.outcome).toBe('skipped');
    expect(skipped!.reason).toBe(DAY_BATCH_SKIP_NO_ROOM);
    // Назван тот рейс, в котором места не осталось: именно рядом с ним заводят второй.
    expect(skipped!.routeNumber).toBe(routeNumber);
    expect(result.issued).toBe(3);
    // Свой рейс рядом с полным пачка не завела: «заведите второй маршрут» — решение диспетчера.
    expect(await routeCount(vehicleId, full)).toBe(1);
    expect(await routeRequestCount(routeId)).toBe(7);
  });

  /**
   * §7, Р9 плана: прошлое без права `waybills.correct` — помеха КАЖДОГО прошедшего дня, а не
   * отказ всей пачке.
   *
   * Менеджеру прошлое не положено вовсе (ADR 0101 п. 4), и пачка обязана сказать это построчно, не
   * заведя ни одного рейса: дней в этом сроке нет ни одного будущего.
   */
  it('без права оформлять задним числом прошедшие дни пропускаются, и ни одной бумаги не выписано', async () => {
    const vehicleId = ctx.vehicles[6]!;
    const dateFrom = shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS + 2));
    const dateTo = shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS - 1));
    const request = await requestInProgress({
      typeId: ctx.linearTypeId,
      vehicleId,
      dateFrom,
      dateTo,
      backdateReason: 'работы шли в прошлом месяце, оформляем сейчас',
    });

    const result = await batchOk(request.id, { reason: 'оформляем прошедший период' }, ctx.manager);

    expect(result.skipped).toBe(4);
    expect(result.issued + result.planned + result.failed).toBe(0);
    for (const row of result.rows) {
      // Один текст на «нет права» и «слишком давно» отправил бы половину людей не туда: здесь
      // права нет вовсе, и выдаётся оно обычным порядком.
      expect(row.reason).toBe(DAY_BATCH_SKIP_BACKDATED);
    }
    expect(await routesOfVehicle(vehicleId)).toBe(0);
    expect(await dayWaybills(request.id)).toHaveLength(0);
  });

  /**
   * §9 целиком: прошедшие дни идут ОДНОЙ операцией, и она лениво заводится первым днём, дошедшим
   * до выписки.
   *
   * Тем же прогоном проверяется вторая граница прошлого — глубина. У диспетчера есть
   * `waybills.correct` и нет `waybills.correctBeyondLimit`, поэтому дни глубже
   * `WAYBILL_CORRECTION_DAYS` уходят в пропуск СВОИМ текстом: там право есть, а снимает предел
   * только то, что не назначается никому. Этот случай прежде не был покрыт ничем.
   */
  it('прошедшие дни: одна строка операции на пачку, причина в каждом листе, глубокое прошлое — пропуск', async () => {
    const vehicleId = ctx.vehicles[7]!;
    const dateFrom = shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS + 2));
    const dateTo = shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS - 1));
    const deep = [dateFrom, shiftDateKey(ctx.today, -(WAYBILL_CORRECTION_DAYS + 1))];
    const allowed = [shiftDateKey(ctx.today, -WAYBILL_CORRECTION_DAYS), dateTo];
    const request = await requestInProgress({
      typeId: ctx.linearTypeId,
      vehicleId,
      dateFrom,
      dateTo,
      backdateReason: 'работы шли в прошлом месяце, оформляем сейчас',
    });
    const operationId = randomUUID();
    const reason = 'бумага за прошедший период оформляется одним решением';

    const result = await batchOk(request.id, { reason, operationId }, ctx.dispatcher);

    // Глубже предела — свой текст: право у диспетчера есть, а глубину снимает неназначаемое.
    for (const date of deep) {
      const row = result.rows.find((r) => r.date === date)!;
      expect(row.outcome).toBe('skipped');
      expect(row.reason).toBe(DAY_BATCH_SKIP_BEYOND_LIMIT);
    }
    expect(result.skipped).toBe(2);
    expect(result.issued).toBe(2);
    expect(result.rows.filter((r) => r.outcome === 'issued').map((r) => r.date)).toEqual(allowed);

    // Строка операции ровно одна на всю пачку — ради этого §9 и заводил свой вид `day_batch`.
    const corrections = await correctionsOf(operationId);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.kind).toBe('day_batch');
    expect(corrections[0]!.reason).toBe(reason);
    // Связь ведётся с заявкой: листов под операцией до пятидесяти, а заказ один.
    expect(await linkedRequests(corrections[0]!.id)).toEqual([request.id]);
    // Снимок операции перечисляет то, что ею и сделано: только выписанные задним числом листы.
    const payload = corrections[0]!.payload as {
      waybills?: { date: string; number: string }[];
      term?: { days?: number };
    };
    expect(payload.waybills?.map((w) => w.date)).toEqual(allowed);
    expect(payload.term?.days).toBe(4);

    // Каждый лист прошедшего дня помечен той же причиной и той же операцией.
    const waybills = await dayWaybills(request.id);
    expect(waybills.map((w) => w.issuedForDate)).toEqual(allowed);
    for (const waybill of waybills) {
      expect(waybill.correctionId).toBe(corrections[0]!.id);
      expect(waybill.correctionReason).toBe(reason);
    }
  });

  /**
   * §9 и §«Повтор»: тот же ключ операции и то же тело продолжают прежнюю работу, а не выписывают
   * вторую стопку.
   *
   * Сцена собрана так, что первой пачке есть чего не доделать: на один день у машины стоят два
   * рейса, и он уходит в пропуск. Лишний рейс убирают — и повтор доделывает этот день ПОД ТОЙ ЖЕ
   * строкой операции, а уже выписанные дни отсекаются своим UNIQUE и уходят в пропуск.
   */
  it('повтор с тем же ключом операции доделывает пропущенное и не жжёт вторых номеров', async () => {
    const vehicleId = ctx.vehicles[8]!;
    const dateFrom = shiftDateKey(ctx.today, -3);
    const dateTo = shiftDateKey(ctx.today, -1);
    const days = [dateFrom, shiftDateKey(ctx.today, -2), dateTo];
    const request = await requestInProgress({
      typeId: ctx.linearTypeId,
      vehicleId,
      dateFrom,
      dateTo,
      backdateReason: 'работы шли на прошлой неделе',
    });
    // Два рейса на среднем дне: первая пачка его не возьмёт — выбирать между ними она не вправе.
    const spare = await createRoute(vehicleId, days[1]!);
    await createRoute(vehicleId, days[1]!);

    const operationId = randomUUID();
    const body = { reason: 'оформляем прошедшую неделю', operationId };
    const first = await batchOk(request.id, body, ctx.dispatcher);
    expect(first.issued).toBe(2);
    expect(first.rows.find((row) => row.date === days[1])!.reason).toBe(
      DAY_BATCH_SKIP_AMBIGUOUS_ROUTE,
    );
    const correctionId = (await correctionsOf(operationId))[0]!.id;
    const issuedFirst = new Map(
      (await dayWaybills(request.id)).map((w) => [w.issuedForDate, w.number]),
    );
    expect([...issuedFirst.keys()]).toEqual([days[0], days[2]]);

    // Лишний рейс убран — неоднозначности больше нет, и повтор тем же ключом доделывает день.
    const removed = await inject('DELETE', `/api/v1/vehicle-routes/${spare}`, ctx.admin);
    expect(removed.statusCode, removed.body).toBe(200);

    const second = await batchOk(request.id, body, ctx.dispatcher);

    expect(second.issued).toBe(1);
    expect(second.rows.find((row) => row.date === days[1])!.outcome).toBe('issued');
    // Уже сделанные дни не переделываются: их отсекает UNIQUE дня, а не вторая стопка бумаги.
    expect(second.skipped).toBe(2);
    for (const date of [days[0], days[2]]) {
      expect(second.rows.find((row) => row.date === date)!.reason).toBe(DAY_BATCH_SKIP_PLANNED);
    }

    // Операция осталась одна и та же: ключ отвечает на «повтор?», а не заводит вторую работу.
    const corrections = await correctionsOf(operationId);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.id).toBe(correctionId);

    // Три листа на три дня, и ни одним больше: второй стопки повтор не выписал.
    const waybills = await dayWaybills(request.id);
    expect(waybills).toHaveLength(3);
    expect(waybills.map((w) => w.issuedForDate)).toEqual(days);
    // Номера первых двух дней остались ТЕМИ ЖЕ: повтор их не переписывал и не дублировал.
    for (const [date, number] of issuedFirst) {
      expect(waybills.find((w) => w.issuedForDate === date)!.number).toBe(number);
    }
    for (const waybill of waybills) expect(waybill.correctionId).toBe(correctionId);
  });

  /**
   * Предпроверка стоит ДО первой записи — и это не про аккуратность, а про номера.
   *
   * `identity` последовательности «Р-» с транзакцией не откатывается: рейс, заведённый до отказа,
   * уносит свой номер навсегда. Поэтому всё, что относится ко ВСЕЙ пачке и узнаётся заранее,
   * обязано отказывать маршрутом, оставляя `vehicle_routes` нетронутым.
   */
  describe('отказ предпроверки не оставляет в базе ни строки', () => {
    it('арендная машина: дней у такого заказа не бывает вовсе', async () => {
      // Аренда — граница бумаги, а не типа (Р10 плана): лист на арендную машину выписывает
      // арендодатель. Ставка обязательна — без денег такое назначение не принимается вовсе.
      const request = await requestInProgress({
        vehicleId: ctx.rentalVehicleId,
        pricePerHour: 1000,
      });
      const res = await batch(request.id);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toContain('арендной техникой');
      expect(res.json().fields.requestId).toBe('Дни недоступны');
      expect(await routesOfVehicle(ctx.rentalVehicleId)).toBe(0);
    });

    it('машина снята с линии: отказ приходит до первого рейса', async () => {
      /*
       * Машина снимается с линии ПОСЛЕ назначения — потому что иначе её не назначить вовсе: ровно
       * тот же отказ приходит из назначения. Это и есть настоящая жизнь такого заказа: заявку
       * взяли в работу исправной машиной, а к моменту выписки бумаг она уехала в ремонт.
       */
      const request = await requestInProgress({ vehicleId: ctx.inactiveVehicleId });
      await ctx.db.execute(
        sql`UPDATE vehicles SET status = 'maintenance' WHERE id = ${ctx.inactiveVehicleId}`,
      );

      const res = await batch(request.id);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().message).toContain('Техника недоступна');
      expect(await routesOfVehicle(ctx.inactiveVehicleId)).toBe(0);
    });

    it('водителя нет — пачка не заводит рейсов со ссылкой на него', async () => {
      const vehicleId = ctx.vehicles[10]!;
      const request = await requestInProgress({ vehicleId });

      const res = await batch(request.id, { driverPersonId: randomUUID() });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().message).toContain('Водитель не найден');
      expect(await routesOfVehicle(vehicleId)).toBe(0);
    });

    it('прошедшие дни без причины и без ключа операции: два разных отказа, обе записи нулевые', async () => {
      const vehicleId = ctx.vehicles[11]!;
      const request = await requestInProgress({
        typeId: ctx.linearTypeId,
        vehicleId,
        dateFrom: shiftDateKey(ctx.today, -2),
        dateTo: shiftDateKey(ctx.today, -1),
        backdateReason: 'работы шли позавчера',
      });

      // Причина — одна на пачку и спрашивается до первой записи: объясняют само решение оформить
      // прошедший период, а не каждый день по отдельности.
      const noReason = await batch(request.id, {}, ctx.dispatcher);
      expect(noReason.statusCode, noReason.body).toBe(422);
      expect(noReason.json().fields.reason).toBe('Нужна причина');
      expect(await routesOfVehicle(vehicleId)).toBe(0);

      // Ключ обязателен ровно там, где пачка сожжёт номера бланков задним числом: повтор после
      // обрыва связи обязан продолжить прежнюю работу, а не выписать вторую стопку.
      const noKey = await batch(request.id, { reason: 'оформляем позавчерашнее' }, ctx.dispatcher);
      expect(noKey.statusCode, noKey.body).toBe(422);
      expect(noKey.json().fields.operationId).toBe('Не передан ключ операции');
      expect(await routesOfVehicle(vehicleId)).toBe(0);
    });
  });

  /**
   * §11 в нынешней редакции: предел стоит на ПОРЦИИ нажатия, а не на сроке.
   *
   * Прежде длинный срок отказывался целиком (`dayBatchTermLimitMessage`), и это отрезало от кнопки
   * ровно тот случай, ради которого её просили, — квартальный заказ. Теперь нажатие берёт первые
   * `DAY_BATCH_LIMIT` НЕРАСПЛАНИРОВАННЫХ дней и говорит, сколько осталось за окном; второе нажатие
   * добирает хвост, а уже сделанные дни места в порции не занимают — иначе кнопку жали бы до
   * бесконечности, а бумага не двигалась.
   *
   * Бумаги здесь не просят намеренно: предмет случая — окно порции и остаток, а полсотни номеров
   * строгой отчётности к этому вопросу ничего не добавляют.
   */
  it('срок длиннее предела проходится порциями: остаток назван, второе нажатие добирает хвост', async () => {
    const vehicleId = ctx.vehicles[9]!;
    // Квартальный заказ — ровно тот случай, ради которого кнопку и просили: девяносто дней.
    const term = 90;
    const tail = term - DAY_BATCH_LIMIT;
    const dateFrom = ctx.today;
    const dateTo = shiftDateKey(dateFrom, term - 1);
    const request = await requestInProgress({ vehicleId, dateFrom, dateTo });

    const first = await batchOk(request.id, { issueWaybills: false });
    expect(first.rows).toHaveLength(DAY_BATCH_LIMIT);
    expect(first.planned).toBe(DAY_BATCH_LIMIT);
    expect(first.skipped + first.failed + first.issued).toBe(0);
    // Хвост назван числом: без него длинный срок молча обрывался бы на полусотне дней.
    expect(first.remaining).toBe(tail);
    expect(first.days.items).toHaveLength(DAY_BATCH_LIMIT + tail);
    expect(first.days.items.filter((item) => item.route !== null)).toHaveLength(DAY_BATCH_LIMIT);

    const second = await batchOk(request.id, { issueWaybills: false });

    // Второе нажатие добрало хвост: сделанные дни в порцию не зачлись, и окно дотянулось до конца.
    expect(second.planned).toBe(tail);
    expect(second.remaining).toBe(0);
    expect(second.rows).toHaveLength(DAY_BATCH_LIMIT + tail);
    // Пройденные дни промолчать не могут: пачка прошла их и не сделала ничего — молчание читалось
    // бы как «сделала».
    expect(second.skipped).toBe(DAY_BATCH_LIMIT);
    for (const row of second.rows.slice(0, DAY_BATCH_LIMIT)) {
      expect(row.reason).toBe(DAY_BATCH_SKIP_PLANNED);
    }
    expect(second.days.items.filter((item) => item.route === null)).toHaveLength(0);
  });
});
