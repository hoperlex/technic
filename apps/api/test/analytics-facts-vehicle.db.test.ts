import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
// Исключение — `types.ts`: конфига он не касается вовсе (только типы контрактов), а ключ позиции
// «техника не назначена» обязан приехать значением: свой литерал в тесте разошёлся бы с загрузчиком.
import {
  NO_VEHICLE_POSITION_KEY,
  type AnalyticsAtom,
  type AnalyticsFacts,
} from '../src/services/analytics/types';

/**
 * АТОМЫ ЗАКАЗА ТЕХНИКИ (план `docs/analytics-summary-export-plan.md`, этап Э1;
 * `apps/api/src/services/analytics/facts-vehicle.ts`).
 *
 * Файл доказывает правила, которые ни типами, ни схемой не держатся, а держатся договорённостью, —
 * и потому ломаются молча, цифрой в книге, а не падением:
 *
 *   1. **машино-смена перевозки не делится и не размножается** (Р6): три заявки одного заказчика в
 *      одном рейсе — одна смена, а две заявки двух заказчиков — по смене каждому;
 *   2. **позиция смены берётся историей назначения** (Р8): у заказа, где технику меняли внутри
 *      срока, текущая строка назначения врёт про прошлое;
 *   3. **границы периода режут по дню метрики** (Р11): смена соседнего дня в набор не входит;
 *   4. **отменённые и мягко удалённые не считаются нигде** (Р10);
 *   5. **деньги заявки раскладываются по её дням и сходятся к исходной сумме** (Р9, Р28);
 *   6. **перегон — счётчик, а не смена и не деньги** (Р27), и позицию ему задаёт рейс, а не
 *      назначение;
 *   7. **закрытая перевозка не теряется без рейса** (Д1): день ей даёт подача, смены у неё нет;
 *   8. **план смен считает только заказ** (Д2): срок «Новой» заявки планом не становится.
 *
 * ДАННЫЕ ЗАВОДЯТСЯ ВСТАВКАМИ, А НЕ СЕРВИСАМИ. Ручек заказа ТС, которые пришлось бы пройти ради
 * одной смены, добрый десяток (виза, перевод в работу, назначение, рейс, лист, подтверждение), и
 * половина из них к проверяемым правилам отношения не имеет. Цена приёма известна: тест не
 * проверяет, что портал СПОСОБЕН завести такую строку, — он проверяет, как загрузчик читает уже
 * заведённую.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: набор щёлкает ГЛОБАЛЬНЫМ режимом чтения истории
 * назначения (`assignment_periods_control.read_mode`), а он один на базу — параллельный прогон по
 * общей базе видел бы историю то включённой, то выключенной в середине собственного случая.
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api exec vitest run test/analytics-facts-vehicle.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_analytics_vehicle_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);

/** Период набора. Границы обеих метрик — день рейса и день смены — проверяются об него. */
const FROM = '2026-06-01';
const TO = '2026-06-30';

/** Идентификаторы заводятся заранее: по ним же и ищутся атомы в ответе. */
const id = {
  user: randomUUID(),
  objectA: randomUUID(),
  objectB: randomUUID(),
  department: randomUUID(),
  v1: randomUUID(),
  v2: randomUUID(),
  v3: randomUUID(),
  routeA: randomUUID(),
  routeOld: randomUUID(),
  routeDept: randomUUID(),
  fA1: randomUUID(),
  fA2: randomUUID(),
  fA3: randomUUID(),
  fB1: randomUUID(),
  fCancelled: randomUUID(),
  fOld: randomUUID(),
  fDept: randomUUID(),
  fNoRoute: randomUUID(),
  fNoVehicle: randomUUID(),
  fNoRouteNew: randomUUID(),
  fInWorkNoRoute: randomUUID(),
  s1: randomUUID(),
  s2: randomUUID(),
  s3: randomUUID(),
  s4: randomUUID(),
  sCancelled: randomUUID(),
  sDeleted: randomUUID(),
  s7: randomUUID(),
  s8: randomUUID(),
  s9: randomUUID(),
  s10: randomUUID(),
  s11: randomUUID(),
  sNew: randomUUID(),
  sNewShift: randomUUID(),
  sOneDay: randomUUID(),
  sBackdated: randomUUID(),
  shadowRun: randomUUID(),
};

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  load: (range: { from: string; to: string }) => Promise<AnalyticsFacts>;
}

let ctx: Ctx;
/** Ответ загрузчика за основной период: считается один раз, проверяется полутора десятками случаев. */
let facts: AnalyticsFacts;

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

// ── Поиск в ответе ──

function atomsOf(requestId: string): AnalyticsAtom[] {
  return facts.atoms
    .filter((a) => a.requestId === requestId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.positionKey.localeCompare(b.positionKey));
}

/** Атомы дня срока без смены: ни смены, ни перегона — только верхняя оценка (Р29). */
function bareOf(requestId: string): AnalyticsAtom[] {
  return atomsOf(requestId).filter((a) => a.shifts === 0 && a.relocations === 0);
}

function sumOf(atoms: readonly AnalyticsAtom[], field: keyof AnalyticsAtom): number {
  return atoms.reduce((acc, atom) => acc + (atom[field] as number), 0);
}

function qualityOf(key: string): { value: number; outOf: number | null } {
  const entry = facts.quality.find((q) => q.key === key);
  expect(entry, `строка качества ${key}`).toBeDefined();
  return { value: entry!.value, outOf: entry!.outOf };
}

describe.skipIf(!DB_URL)('атомы заказа техники: перевозки и работа на площадке', () => {
  beforeAll(async () => {
    /*
     * СВОЯ БАЗА С НУЛЯ. Первые миграции требуют расширений, которых в свежей базе нет вовсе
     * (`pgcrypto` для `gen_random_uuid`, `citext` для адреса учётки, `pg_trgm` для поиска).
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
    const { loadVehicleFacts } = await import('../src/services/analytics/facts-vehicle');
    ctx = { db, closeDb, load: loadVehicleFacts };

    await db.execute(sql`
      INSERT INTO users (id, email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${id.user}, ${`db-av-${RUN}@example.invalid`}, 'Тестовый', 'Пользователь', '',
              'x', 'admin', true, now())`);

    await db.execute(sql`
      INSERT INTO construction_objects (id, code, name, address) VALUES
        (${id.objectA}, ${`AV-A-${RUN}`}, ${`Площадка А ${RUN}`}, 'г Москва, ул Тестовая, д 1'),
        (${id.objectB}, ${`AV-B-${RUN}`}, ${`Площадка Б ${RUN}`}, 'г Москва, ул Тестовая, д 2')`);
    await db.execute(sql`
      INSERT INTO departments (id, code, name)
      VALUES (${id.department}, ${`AV-D-${RUN}`}, ${`Снабжение ${RUN}`})`);

    // Тип ТС берётся из справочника, наполненного миграциями: заводить свой значило бы заводить и
    // вид, и категорию прав — к проверяемым правилам это отношения не имеет.
    const typeRow = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicle_types ORDER BY code LIMIT 1`,
    );
    const typeId = typeRow.rows[0]?.id;
    if (!typeId) throw new Error('В базе нет типов ТС: миграция 0010 не применена');

    await db.execute(sql`
      INSERT INTO vehicles (id, ownership, vehicle_type_id, registration_number) VALUES
        (${id.v1}, 'own', ${typeId}, ${`А001АА${RUN.slice(0, 3)}`}),
        (${id.v2}, 'own', ${typeId}, ${`В002ВВ${RUN.slice(0, 3)}`}),
        (${id.v3}, 'own', ${typeId}, ${`С003СС${RUN.slice(0, 3)}`})`);

    /** Заявка: заказчик задаётся ровно одной колонкой (CHECK `vehicle_requests_customer_check`). */
    const request = async (params: {
      id: string;
      type: 'freight_transport' | 'special_equipment';
      objectId?: string;
      departmentId?: string;
      status: 'new' | 'confirmed' | 'done' | 'cancelled';
      deleted?: boolean;
    }): Promise<void> => {
      await db.execute(sql`
        INSERT INTO vehicle_requests (id, request_type, object_id, department_id, vehicle_type_id,
                                      status, created_by, deleted_at, deleted_by)
        VALUES (${params.id}, ${sql.raw(`'${params.type}'::vehicle_request_type`)},
                ${params.objectId ?? null}, ${params.departmentId ?? null}, ${typeId},
                ${sql.raw(`'${params.status}'::request_status`)}, ${id.user},
                ${params.deleted ? sql`now()` : null}, ${params.deleted ? id.user : null})`);
    };

    /** Назначение: цена может быть пустой — такая заявка и есть «без цены» (Р9). */
    const assign = async (
      requestId: string,
      vehicleId: string,
      price: { perShift?: number; perHour?: number; shiftHours?: number } = {},
    ): Promise<void> => {
      await db.execute(sql`
        INSERT INTO vehicle_request_assignments (request_id, vehicle_id, vehicle_type_id,
                                                 price_per_shift, price_per_hour, shift_hours,
                                                 assigned_by)
        VALUES (${requestId}, ${vehicleId}, ${typeId}, ${price.perShift ?? null},
                ${price.perHour ?? null}, ${price.shiftHours ?? null}, ${id.user})`);
    };

    const term = async (requestId: string, from: string, to: string | null): Promise<void> => {
      await db.execute(sql`
        INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
        VALUES (${requestId}, ${from}::date, ${to}::date)`);
    };

    const shift = async (
      requestId: string,
      date: string,
      hours: number,
      approved: boolean,
    ): Promise<void> => {
      await db.execute(sql`
        INSERT INTO vehicle_request_shifts (request_id, shift_date, machine_hours, filled_by,
                                            approved_by, approved_at)
        VALUES (${requestId}, ${date}::date, ${hours}, ${id.user},
                ${approved ? id.user : null}, ${approved ? sql`now()` : null})`);
    };

    // ── Перевозки: один рейс, три заявки площадки А, одна площадки Б и одна отменённая ──
    for (const requestId of [id.fA1, id.fA2, id.fA3]) {
      await request({
        id: requestId,
        type: 'freight_transport',
        objectId: id.objectA,
        status: 'confirmed',
      });
    }
    await request({ id: id.fB1, type: 'freight_transport', objectId: id.objectB, status: 'done' });
    await request({
      id: id.fCancelled,
      type: 'freight_transport',
      objectId: id.objectA,
      status: 'cancelled',
    });
    await request({
      id: id.fOld,
      type: 'freight_transport',
      objectId: id.objectA,
      status: 'confirmed',
    });
    await request({
      id: id.fDept,
      type: 'freight_transport',
      departmentId: id.department,
      status: 'confirmed',
    });
    for (const requestId of [id.fA1, id.fA2, id.fA3, id.fB1, id.fCancelled, id.fOld, id.fDept]) {
      await ctx.db.execute(sql`
        INSERT INTO freight_transport_request_details (request_id, scheduled_at)
        VALUES (${requestId}, '2026-06-10T08:00:00+03:00')`);
    }

    await db.execute(sql`
      INSERT INTO vehicle_routes (id, vehicle_id, route_date, purpose, created_by) VALUES
        (${id.routeA},    ${id.v1}, '2026-06-10'::date, 'freight', ${id.user}),
        (${id.routeOld},  ${id.v1}, '2026-05-31'::date, 'freight', ${id.user}),
        (${id.routeDept}, ${id.v1}, '2026-06-20'::date, 'freight', ${id.user})`);
    const inRoute = async (routeId: string, requestId: string, position: number): Promise<void> => {
      await db.execute(sql`
        INSERT INTO vehicle_route_requests (route_id, request_id, position)
        VALUES (${routeId}, ${requestId}, ${position})`);
    };
    await inRoute(id.routeA, id.fA1, 1);
    await inRoute(id.routeA, id.fA2, 2);
    await inRoute(id.routeA, id.fA3, 3);
    await inRoute(id.routeA, id.fB1, 4);
    await inRoute(id.routeA, id.fCancelled, 5);
    await inRoute(id.routeOld, id.fOld, 1);
    await inRoute(id.routeDept, id.fDept, 1);

    await db.execute(sql`
      INSERT INTO vehicle_request_trips (request_id, num, from_location, to_location,
                                         volume_m3, weight_tons) VALUES
        (${id.fA1}, 1, 'Склад', 'Площадка А', 10, 1.5),
        (${id.fA1}, 2, 'Площадка А', 'Склад',  20, 2.5),
        (${id.fA1}, 3, 'Склад', 'Площадка А', 99, 99),
        (${id.fB1}, 1, 'Склад', 'Площадка Б',  5, 0.5)`);
    // Удалённая ездка не ехала и в объём не входит (Р13а плана маршрутов).
    await db.execute(sql`
      UPDATE vehicle_request_trips SET deleted_at = now()
       WHERE request_id = ${id.fA1} AND num = 3`);

    await assign(id.fA1, id.v1, { perShift: 5000 });
    await assign(id.fA2, id.v1, { perShift: 1000 });
    await assign(id.fA3, id.v1, { perShift: 1000 });
    await assign(id.fB1, id.v1, { perShift: 1000 });
    await assign(id.fDept, id.v1, { perShift: 1000 });
    await db.execute(sql`
      INSERT INTO vehicle_request_completions (request_id, worked_unit, worked_amount, total_cost,
                                               completed_by)
      VALUES (${id.fB1}, 'shifts', 1, 7000, ${id.user})`);

    /*
     * ── Перевозки, не доехавшие до рейса (Д1) ──
     *
     * Рейса у них нет вовсе — ни в периоде, ни за его границей: так выглядит заявка, закрытая без
     * постановки в рейс, и та, чей рейс снесли вместе с путевым листом. Закрытие рейса не требует,
     * а «в работе и без маршрута» схема называет законным состоянием — потеряться такая заявка
     * права не имеет. День ей даёт подача, и заводится она ОТДЕЛЬНО от общего цикла деталей выше
     * ровно потому, что дата подачи у каждой своя: ею и проверяется правило дня.
     */
    await request({
      id: id.fNoRoute,
      type: 'freight_transport',
      objectId: id.objectA,
      status: 'done',
    });
    /*
     * Закрыта БЕЗ суммы и без назначения: позиция обязана стать общим ключом «техника не назначена»,
     * а сама заявка — «без цены», а не оценённой нулём (Р29). Закрытие без суммы законно — так
     * закрывают свою машину без ставки (`total_cost` nullable).
     */
    await request({
      id: id.fNoVehicle,
      type: 'freight_transport',
      objectId: id.objectA,
      status: 'done',
    });
    // Незакрытые без рейса в книгу не попадают: «Новая» работой не стала, а «в работе» её ещё не
    // начала — рейс у неё будет, и придёт она своим днём (Р25).
    await request({
      id: id.fNoRouteNew,
      type: 'freight_transport',
      objectId: id.objectB,
      status: 'new',
    });
    await request({
      id: id.fInWorkNoRoute,
      type: 'freight_transport',
      objectId: id.objectA,
      status: 'confirmed',
    });
    await assign(id.fInWorkNoRoute, id.v1, { perShift: 1000 });
    await db.execute(sql`
      INSERT INTO freight_transport_request_details (request_id, scheduled_at) VALUES
        (${id.fNoRoute},       '2026-06-15T09:00:00+03:00'),
        (${id.fNoVehicle},     '2026-06-17T01:00:00+03:00'),
        (${id.fNoRouteNew},    '2026-06-18T08:00:00+03:00'),
        (${id.fInWorkNoRoute}, '2026-06-19T08:00:00+03:00')`);
    await db.execute(sql`
      INSERT INTO vehicle_request_trips (request_id, num, from_location, to_location,
                                         volume_m3, weight_tons) VALUES
        (${id.fNoRoute}, 1, 'Склад', 'Площадка А', 7, 0.7),
        (${id.fNoRoute}, 2, 'Площадка А', 'Склад', 3, 0.3)`);
    await assign(id.fNoRoute, id.v1, { perShift: 1000 });
    await db.execute(sql`
      INSERT INTO vehicle_request_completions (request_id, worked_unit, worked_amount, total_cost,
                                               completed_by)
      VALUES (${id.fNoRoute}, 'shifts', 1, 3000, ${id.user})`);
    await db.execute(sql`
      INSERT INTO vehicle_request_completions (request_id, worked_unit, worked_amount, total_cost,
                                               completed_by)
      VALUES (${id.fNoVehicle}, 'shifts', 1, NULL, ${id.user})`);

    // ── Техника на объекте ──
    await request({
      id: id.s1,
      type: 'special_equipment',
      objectId: id.objectA,
      status: 'confirmed',
    });
    await term(id.s1, '2026-06-08', '2026-06-12');
    await assign(id.s1, id.v2, { perShift: 1000 });
    await shift(id.s1, '2026-06-09', 4, true);
    await shift(id.s1, '2026-06-10', 6, false);
    await shift(id.s1, '2026-06-11', 5, true);
    // Перегоны: доставка и вывоз техники своего же заказа (Р27).
    await db.execute(sql`
      INSERT INTO vehicle_routes (id, vehicle_id, route_date, purpose, source_request_id,
                                  move_from, move_to, created_by) VALUES
        (${randomUUID()}, ${id.v2}, '2026-06-08'::date, 'delivery', ${id.s1},
         'База', 'Площадка А', ${id.user}),
        (${randomUUID()}, ${id.v2}, '2026-06-12'::date, 'pickup', ${id.s1},
         'Площадка А', 'База', ${id.user})`);

    await request({
      id: id.s2,
      type: 'special_equipment',
      objectId: id.objectA,
      status: 'confirmed',
    });
    await term(id.s2, '2026-06-28', '2026-07-03');
    await assign(id.s2, id.v2, { perHour: 500, shiftHours: 8 });
    await shift(id.s2, '2026-06-30', 7, false);
    await shift(id.s2, '2026-07-01', 8, false);

    await request({ id: id.s3, type: 'special_equipment', objectId: id.objectB, status: 'done' });
    await term(id.s3, '2026-06-01', '2026-06-03');
    await assign(id.s3, id.v3, { perShift: 900 });
    await shift(id.s3, '2026-06-01', 8, true);
    await shift(id.s3, '2026-06-02', 8, true);
    await shift(id.s3, '2026-06-03', 8, true);
    await db.execute(sql`
      INSERT INTO vehicle_request_completions (request_id, worked_unit, worked_amount, total_cost,
                                               completed_by)
      VALUES (${id.s3}, 'shifts', 3, 1000, ${id.user})`);

    await request({
      id: id.s4,
      type: 'special_equipment',
      objectId: id.objectB,
      status: 'confirmed',
    });
    await term(id.s4, '2026-06-20', '2026-06-21');
    await assign(id.s4, id.v3);
    await shift(id.s4, '2026-06-20', 8, false);

    await request({
      id: id.sCancelled,
      type: 'special_equipment',
      objectId: id.objectA,
      status: 'cancelled',
    });
    await term(id.sCancelled, '2026-06-15', '2026-06-15');
    await assign(id.sCancelled, id.v2, { perShift: 1000 });
    await shift(id.sCancelled, '2026-06-15', 8, true);

    await request({
      id: id.sDeleted,
      type: 'special_equipment',
      objectId: id.objectA,
      status: 'confirmed',
      deleted: true,
    });
    await term(id.sDeleted, '2026-06-16', '2026-06-16');
    await assign(id.sDeleted, id.v2, { perShift: 1000 });
    await shift(id.sDeleted, '2026-06-16', 8, true);

    /*
     * Смена техники внутри срока (Р8). Денормализация назначения помнит ПОСЛЕДНЮЮ машину — ту,
     * что работала с 6 июня; история помнит обе, и второе июня обязано достаться первой.
     */
    await request({
      id: id.s7,
      type: 'special_equipment',
      objectId: id.objectB,
      status: 'confirmed',
    });
    await term(id.s7, '2026-06-01', '2026-06-10');
    await assign(id.s7, id.v3, { perShift: 100 });
    await shift(id.s7, '2026-06-02', 8, true);
    await shift(id.s7, '2026-06-08', 8, true);
    await db.execute(sql`
      INSERT INTO vehicle_request_assignment_changes (request_id, effective_date, dimension,
                                                      vehicle_id, origin, created_by) VALUES
        (${id.s7}, '2026-06-01'::date, 'vehicle', ${id.v2}, 'assignment',   ${id.user}),
        (${id.s7}, '2026-06-06'::date, 'vehicle', ${id.v3}, 'reassignment', ${id.user})`);

    /*
     * Заказ, пересекающий границу периода (Р28): сумма закрытия делится между ВСЕМИ тремя днями
     * его смен, и июнь обязан забрать долю одного дня, а не всю сумму.
     */
    await request({ id: id.s8, type: 'special_equipment', objectId: id.objectB, status: 'done' });
    await term(id.s8, '2026-06-30', '2026-07-02');
    await assign(id.s8, id.v3, { perShift: 400 });
    await shift(id.s8, '2026-06-30', 8, true);
    await shift(id.s8, '2026-07-01', 8, true);
    await shift(id.s8, '2026-07-02', 8, true);
    await db.execute(sql`
      INSERT INTO vehicle_request_completions (request_id, worked_unit, worked_amount, total_cost,
                                               completed_by)
      VALUES (${id.s8}, 'shifts', 3, 1000, ${id.user})`);

    // Часовая ставка без длины смены: цены дня нет, оценить нечем — «без цены», а не ноль (Р29).
    await request({
      id: id.s9,
      type: 'special_equipment',
      objectId: id.objectA,
      status: 'confirmed',
    });
    await term(id.s9, '2026-06-05', '2026-06-06');
    await assign(id.s9, id.v2, { perHour: 300 });
    await shift(id.s9, '2026-06-05', 8, true);

    // Заказ, простоявший срок без единой заполненной смены: нижняя оценка — ноль, верхняя — цена
    // срока (Р29). Ради этого случая вилка и заведена.
    await request({
      id: id.s10,
      type: 'special_equipment',
      objectId: id.objectB,
      status: 'confirmed',
    });
    await term(id.s10, '2026-06-18', '2026-06-19');
    await assign(id.s10, id.v3, { perShift: 700 });

    // Заказ без цены и без смен: нести ему нечего вовсе — и всё-таки его срок обязан попасть в
    // план, иначе колонка отвечала бы про заполненность, а не про срок.
    await request({
      id: id.s11,
      type: 'special_equipment',
      objectId: id.objectA,
      status: 'confirmed',
    });
    await term(id.s11, '2026-06-23', '2026-06-24');
    await assign(id.s11, id.v2);

    // «Новая» со сроком внутри периода (Д2): заказом заявка становится после подтверждения, и до
    // него её срок — намерение. Ни атома, ни плана, ни строки свода у площадки (Р25).
    await request({
      id: id.sNew,
      type: 'special_equipment',
      objectId: id.objectA,
      status: 'new',
    });
    await term(id.sNew, '2026-06-25', '2026-06-26');
    await assign(id.sNew, id.v2, { perShift: 1000 });

    // «Новая», у которой смена всё-таки заполнена: строка смены — ФАКТ независимо от статуса, и
    // отбор плана её не касается. Плана при этом нет: срок «Новой» планом не становится.
    await request({
      id: id.sNewShift,
      type: 'special_equipment',
      objectId: id.objectB,
      status: 'new',
    });
    await term(id.sNewShift, '2026-06-27', '2026-06-27');
    await assign(id.sNewShift, id.v3, { perShift: 500 });
    await shift(id.sNewShift, '2026-06-27', 8, true);

    // Однодневный срок пустой `date_to`: единственная форма, которой он выражается в схеме, и
    // `shiftDaysOf` обязан дать по ней ровно один день плана.
    await request({
      id: id.sOneDay,
      type: 'special_equipment',
      objectId: id.objectB,
      status: 'confirmed',
    });
    await term(id.sOneDay, '2026-06-22', null);
    await assign(id.sOneDay, id.v3, { perShift: 300 });

    // Смена ЗА ПРЕДЕЛАМИ срока: заказ закрыли раньше, а коррекция задним числом день оставила
    // (ADR 0101). Верхней границы у такого дня нет, и он обязан ответить своей нижней.
    await request({
      id: id.sBackdated,
      type: 'special_equipment',
      objectId: id.objectA,
      status: 'confirmed',
    });
    await term(id.sBackdated, '2026-06-13', '2026-06-14');
    await assign(id.sBackdated, id.v2, { perShift: 800 });
    await shift(id.sBackdated, '2026-06-16', 8, true);

    /*
     * Перегон машиной, ОТЛИЧНОЙ от назначенной: в назначении s4 стоит v3, а везёт технику v1.
     * Позицию задаёт рейс — перегон заводится на ту машину, которая реально шла; спроси загрузчик
     * назначение, и работа тягача уехала бы в позицию экскаватора.
     */
    await db.execute(sql`
      INSERT INTO vehicle_routes (id, vehicle_id, route_date, purpose, source_request_id,
                                  move_from, move_to, created_by)
      VALUES (${randomUUID()}, ${id.v1}, '2026-06-19'::date, 'delivery', ${id.s4},
              'База', 'Площадка Б', ${id.user})`);

    /*
     * История включается на всю базу: `requestDayVehicleSql` спрашивает режим модуля у самой базы,
     * и при `legacy` обе смены ответили бы денормализацией — то есть мартовской машиной на
     * январской смене, ровно тем, что Р8 и запрещает. Ссылка на поколение теневой сверки
     * обязательна (CHECK `assignment_periods_control_cutover_check`).
     */
    await db.execute(sql`
      INSERT INTO assignment_shadow_runs (run_id, status, as_of, algo_version, build_version,
                                          expected_checks, finished_at)
      VALUES (${id.shadowRun}, 'completed', ${FROM}::date, 'test', 'test', 0, now())`);
    const control = await db.execute(sql`
      UPDATE assignment_periods_control
         SET read_mode = 'history', cutover_run_id = ${id.shadowRun}
       WHERE id`);
    expect(control.rowCount, 'управляющая строка заведена миграцией 0167').toBe(1);

    facts = await ctx.load({ from: FROM, to: TO });
  }, 180_000);

  afterAll(async () => {
    // База своя — уносим её целиком: чужих строк в ней нет по построению, а оставленная база
    // помешала бы следующему прогону завести её заново.
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

  // ── 1. Перевозки: машино-смена пары «машина + день» (Р6) ──

  describe('перевозки', () => {
    it('три заявки одного заказчика в одном рейсе дают ОДНУ смену', () => {
      const own = [...atomsOf(id.fA1), ...atomsOf(id.fA2), ...atomsOf(id.fA3)];
      expect(own).toHaveLength(3);
      expect(own.every((a) => a.module === 'freight')).toBe(true);
      expect(own.every((a) => a.date === '2026-06-10')).toBe(true);
      // Смена одна на всю тройку: делить её на доли «1/3» запрещено (Р6), поэтому она целиком
      // лежит на первом атоме пары, а не размазана по трём.
      expect(sumOf(own, 'shifts')).toBe(1);
      expect(own.filter((a) => a.shifts === 1)).toHaveLength(1);
    });

    it('заявка другого заказчика в том же рейсе получает свою смену целиком', () => {
      const other = atomsOf(id.fB1);
      expect(other).toHaveLength(1);
      expect(other[0]!.shifts).toBe(1);
      // Машина у обеих одна и та же: между заказчиками машино-смена не делится, и сумма по
      // строкам свода поэтому больше числа машино-смен парка (Р6, сказано в подписи колонки).
      expect(other[0]!.positionKey).toBe(id.v1);
      expect(atomsOf(id.fA1)[0]!.positionKey).toBe(id.v1);
    });

    it('ездки и количества считаются по заявке, удалённая ездка не входит', () => {
      const atom = atomsOf(id.fA1)[0]!;
      expect(atom.trips).toBe(2);
      expect(atom.volumeM3).toBe(30);
      expect(atom.weightTons).toBe(4);
      // Соседки по рейсу своих ездок не имеют — и чужих не получают.
      expect(atomsOf(id.fA2)[0]!.trips).toBe(0);
    });

    it('позиция — машина рейса: ключ, подпись и гос. номер', () => {
      const atom = atomsOf(id.fA1)[0]!;
      expect(atom.positionKey).toBe(id.v1);
      expect(atom.registrationNumber).toMatch(/^А001АА/);
      expect(atom.positionLabel).toContain(atom.registrationNumber!);
      expect(atom.requestLabel).toMatch(/^ТС-\d+$/);
    });

    it('заказчиком бывает и отдел: у него та же смена и пустой отдел-плательщик', () => {
      const atom = atomsOf(id.fDept)[0]!;
      expect(atom.customerKind).toBe('department');
      expect(atom.customerId).toBe(id.department);
      expect(atom.shifts).toBe(1);
      // Отдел-плательщик бывает только у механизации (Р22): здесь отдел — сам заказчик.
      expect(atom.payerDepartmentId).toBeNull();
    });

    // ── Заявка без рейса: день даёт подача (Д1) ──

    it('закрытая перевозка без рейса приходит по дню подачи, а не теряется', () => {
      const atoms = atomsOf(id.fNoRoute);
      // Рейса нет вовсе, и раньше такая заявка не давала ни денег, ни ездок, ни объёма — молча.
      expect(atoms).toHaveLength(1);
      const atom = atoms[0]!;
      expect(atom.module).toBe('freight');
      expect(atom.date).toBe('2026-06-15');
      expect(atom.moneyFact).toBe(3000);
      expect(atom.trips).toBe(2);
      expect(atom.volumeM3).toBe(10);
      expect(atom.weightTons).toBe(1);
      // Позиция — назначенная машина: у дня подачи своей машины нет, и спрашивать историю не о чем.
      expect(atom.positionKey).toBe(id.v1);
    });

    it('смены у дня подачи нет: машино-смена — это пара «машина и день РЕЙСА» (Р6)', () => {
      // Выдай смену заявке, которая никуда не поехала, и колонка «смен» начала бы считать намерения.
      expect(atomsOf(id.fNoRoute)[0]!.shifts).toBe(0);
      expect(atomsOf(id.fNoVehicle)[0]!.shifts).toBe(0);
    });

    it('без назначения позиция закрытой заявки — общий ключ «техника не назначена»', () => {
      const atoms = atomsOf(id.fNoVehicle);
      expect(atoms).toHaveLength(1);
      // Подача 17 июня в 01:00 МСК — это ещё 16-е по UTC: день считается московскими сутками, иначе
      // заявка первого числа выпала бы из месяца целиком.
      expect(atoms[0]!.date).toBe('2026-06-17');
      expect(atoms[0]!.positionKey).toBe(NO_VEHICLE_POSITION_KEY);
      expect(atoms[0]!.registrationNumber).toBeNull();
      // Закрытие без суммы — «без цены», а не ноль: ноль в денежной клетке означает бесплатную
      // работу и ничего больше (Р29).
      expect(atoms[0]!.priced).toBe(false);
      expect(atoms[0]!.moneyFact + atoms[0]!.moneyLow + atoms[0]!.moneyHigh).toBe(0);
    });

    it('незакрытая перевозка без рейса в книгу не попадает — ни «Новая», ни «в работе»', () => {
      // Ветвь читает только ЗАКРЫТЫЕ: терялись деньги закрытых заявок. «В работе, но ещё не в
      // рейсе» — работа, которая ещё не началась, и рейс у неё будет; заведи ей атом по дню подачи,
      // и самый частый случай («завели, машину назначили, рейс не собрали») создавал бы площадке
      // строку свода с оценкой там, где работы не было (Р25).
      expect(atomsOf(id.fNoRouteNew)).toHaveLength(0);
      expect(atomsOf(id.fInWorkNoRoute)).toHaveLength(0);
    });

    it('рейс за границей периода в набор не входит и «без рейса» не считается', () => {
      // У fOld подача 10 июня, а рейс 31 мая: свою сумму заявка отдала маю. Отбор требует, чтобы
      // рейса не было ВООБЩЕ, — иначе июнь забрал бы ту же сумму по дню подачи второй раз, и два
      // соседних отчёта в сумме оказались бы больше годового (Р28).
      expect(atomsOf(id.fOld)).toHaveLength(0);
    });
  });

  // ── 2. Техника на объекте: смена, виза, моточасы (Р7) ──

  describe('техника на объекте', () => {
    it('атом на строку смены: моточасы и позиция по назначению', () => {
      const atoms = atomsOf(id.s1).filter((a) => a.shifts === 1);
      expect(atoms.map((a) => a.date)).toEqual(['2026-06-09', '2026-06-10', '2026-06-11']);
      expect(atoms.map((a) => a.engineHours)).toEqual([4, 6, 5]);
      expect(atoms.every((a) => a.module === 'onsite' && a.positionKey === id.v2)).toBe(true);
      // Перевозочных величин у площадки не бывает: ездки и объём остаются нулями.
      expect(sumOf(atoms, 'trips')).toBe(0);
    });

    it('у дня со сменой второго атома не заводится (Р29)', () => {
      // Дни 09–11 июня — и дни срока, и дни смен. Заведи срок им ещё по атому, верхняя оценка
      // площадки удвоилась бы, а удвоение верхней границы хуже её отсутствия.
      const days = atomsOf(id.s1)
        .filter((a) => a.relocations === 0)
        .map((a) => a.date);
      expect(days).toEqual(['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12']);
      expect(new Set(days).size).toBe(days.length);
    });

    it('смена за границей периода не считается, а соседний период её видит', async () => {
      expect(
        atomsOf(id.s2)
          .filter((a) => a.shifts === 1)
          .map((a) => a.date),
      ).toEqual(['2026-06-30']);
      const july = await ctx.load({ from: '2026-07-01', to: '2026-07-31' });
      const inJuly = july.atoms.filter((a) => a.requestId === id.s2 && a.shifts === 1);
      expect(inJuly.map((a) => a.date)).toEqual(['2026-07-01']);
    });

    it('перегон — счётчик, а не смена и не деньги (Р27)', () => {
      const moves = atomsOf(id.s1).filter((a) => a.relocations === 1);
      expect(moves.map((a) => a.date)).toEqual(['2026-06-08', '2026-06-12']);
      expect(moves.every((a) => a.module === 'onsite' && a.shifts === 0)).toBe(true);
      expect(sumOf(moves, 'moneyFact') + sumOf(moves, 'moneyLow') + sumOf(moves, 'moneyHigh')).toBe(
        0,
      );
      // Перегон идёт машиной своего же заказа, а не чужой: позиция та же, что у смен.
      expect(moves.every((a) => a.positionKey === id.v2)).toBe(true);
    });

    it('перегон идёт машиной РЕЙСА, даже когда в назначении другая', () => {
      // У s4 в назначении v3, а технику везёт v1. Позицию задаёт рейс: спроси загрузчик назначение,
      // и работа тягача уехала бы в позицию экскаватора — «ед. техники» посчиталась бы не по тем.
      const moves = atomsOf(id.s4).filter((a) => a.relocations === 1);
      expect(moves.map((a) => a.date)).toEqual(['2026-06-19']);
      expect(moves[0]!.positionKey).toBe(id.v1);
      // Смена той же заявки осталась при своей машине: перегон её позицию не перебивает.
      expect(atomsOf(id.s4).filter((a) => a.shifts === 1)[0]!.positionKey).toBe(id.v3);
    });

    it('позиция смены берётся историей назначения, а не текущей строкой (Р8)', () => {
      const atoms = atomsOf(id.s7).filter((a) => a.shifts === 1);
      expect(atoms.map((a) => a.date)).toEqual(['2026-06-02', '2026-06-08']);
      // В денормализации стоит машина, работавшая с 6 июня; второе июня обязано достаться первой.
      expect(atoms[0]!.positionKey).toBe(id.v2);
      expect(atoms[1]!.positionKey).toBe(id.v3);
    });
  });

  // ── 3. План смен: день срока несёт единицу плана (Р7) ──

  describe('план смен', () => {
    it('день со сменой несёт и план, и факт — одним атомом', () => {
      const day = atomsOf(id.s1).filter((a) => a.date === '2026-06-09' && a.relocations === 0);
      expect(day).toHaveLength(1);
      expect(day[0]!.shifts).toBe(1);
      expect(day[0]!.planShifts).toBe(1);
      // Иначе верхняя оценка этого дня удвоилась бы вместе с планом (Р29).
      expect(day[0]!.moneyHigh).toBe(1000);
    });

    it('заказ без цены и без смен даёт план по дням срока и ноль во всех деньгах', () => {
      const atoms = atomsOf(id.s11);
      expect(atoms.map((a) => a.date)).toEqual(['2026-06-23', '2026-06-24']);
      expect(atoms.map((a) => a.planShifts)).toEqual([1, 1]);
      expect(sumOf(atoms, 'shifts')).toBe(0);
      expect(sumOf(atoms, 'moneyFact') + sumOf(atoms, 'moneyLow') + sumOf(atoms, 'moneyHigh')).toBe(
        0,
      );
      expect(atoms.every((a) => !a.priced)).toBe(true);
    });

    it('заявка «Новая» плана не даёт и строки свода не создаёт (Д2)', () => {
      // Заказом заявка становится после подтверждения (Р7 — «дни срока ЗАКАЗА»). Дай ей план — и у
      // площадки появилась бы строка свода там, где работы не было (Р25), а знаменатель «смен
      // заполнено из дней срока» раздулся бы днями неподтверждённых заявок.
      expect(atomsOf(id.sNew)).toHaveLength(0);
    });

    it('смена «Новой» заявки остаётся фактом, но плана у неё нет', () => {
      const atoms = atomsOf(id.sNewShift);
      expect(atoms).toHaveLength(1);
      expect(atoms[0]!.shifts).toBe(1);
      expect(atoms[0]!.engineHours).toBe(8);
      // Срок «Новой» планом не становится, и день со сменой несёт только факт.
      expect(atoms[0]!.planShifts).toBe(0);
      // Верхней границы у такого дня нет: срок её не подтверждает, и он отвечает своей нижней.
      expect(atoms[0]!.moneyLow).toBe(500);
      expect(atoms[0]!.moneyHigh).toBe(500);
    });

    it('однодневный срок (пустая date_to) даёт ровно один день плана', () => {
      const atoms = atomsOf(id.sOneDay);
      // Пустая `date_to` — единственная форма однодневного срока в схеме, и второй ответ на
      // «сколько дней в заказе» разошёлся бы с таблицей смен карточки на первом же таком заказе.
      expect(atoms.map((a) => a.date)).toEqual(['2026-06-22']);
      expect(atoms[0]!.planShifts).toBe(1);
      expect(atoms[0]!.shifts).toBe(0);
      expect(atoms[0]!.moneyLow).toBe(0);
      expect(atoms[0]!.moneyHigh).toBe(300);
    });

    it('сумма плана площадки равна числу дней срока её заказов внутри периода', () => {
      const onA = facts.atoms.filter((a) => a.module === 'onsite' && a.customerId === id.objectA);
      // s1 (08–12.06, 5) + s2 (28–30.06, 3) + s9 (05–06.06, 2) + s11 (23–24.06, 2)
      //   + sBackdated (13–14.06, 2) = 14.
      // Отменённая и удалённая заявки срока не имеют вовсе (Р10), «Новая» sNew — плана (Д2).
      expect(sumOf(onA, 'planShifts')).toBe(14);
    });

    it('перегоны и перевозки плана не несут: срока у них нет', () => {
      const moves = facts.atoms.filter((a) => a.relocations === 1);
      expect(moves.length).toBeGreaterThan(0);
      expect(sumOf(moves, 'planShifts')).toBe(0);
      expect(
        sumOf(
          facts.atoms.filter((a) => a.module === 'freight'),
          'planShifts',
        ),
      ).toBe(0);
    });

    it('план сходится со знаменателем строки качества', () => {
      const onsite = facts.atoms.filter((a) => a.module === 'onsite');
      expect(sumOf(onsite, 'planShifts')).toBe(qualityOf('onsite.shifts-plan-fact').outOf);
      expect(sumOf(onsite, 'shifts')).toBe(qualityOf('onsite.shifts-plan-fact').value);
    });
  });

  // ── 4. Отменённые и удалённые не считаются нигде (Р10) ──

  describe('отменённые и удалённые', () => {
    it('отменённая заявка не даёт ни атома — ни на площадке, ни в рейсе', () => {
      expect(atomsOf(id.sCancelled)).toHaveLength(0);
      expect(atomsOf(id.fCancelled)).toHaveLength(0);
    });

    it('мягко удалённая заявка не даёт ни атома', () => {
      expect(atomsOf(id.sDeleted)).toHaveLength(0);
    });

    it('их смены не попали и в счётчики качества', () => {
      // Двенадцать смен живых заявок; смены отменённой и удалённой сюда не входят, иначе
      // знаменатель «без визы» считался бы по несуществующей работе.
      expect(qualityOf('onsite.shifts-unapproved').outOf).toBe(14);
    });
  });

  // ── 5. Деньги: факт, вилка и раскладка по дням (Р9, Р28) ──

  describe('деньги', () => {
    it('факт закрытия раскладывается по дням и сходится к исходной сумме', () => {
      const atoms = atomsOf(id.s3);
      expect(atoms).toHaveLength(3);
      expect(atoms.map((a) => a.moneyFact)).toEqual([333.33, 333.33, 333.34]);
      expect(sumOf(atoms, 'moneyFact')).toBe(1000);
      // У закрытой заявки оценок нет вовсе: иначе «факт + оценка» посчитали бы работу дважды.
      expect(sumOf(atoms, 'moneyLow')).toBe(0);
      expect(sumOf(atoms, 'moneyHigh')).toBe(0);
    });

    it('незакрытая заявка оценивается вилкой: факт смен снизу, срок заказа сверху', () => {
      const worked = atomsOf(id.s1).filter((a) => a.shifts === 1);
      // Нижняя — цена смены на каждый ЗАПОЛНЕННЫЙ день: 3 × 1000.
      expect(worked.map((a) => a.moneyLow)).toEqual([1000, 1000, 1000]);
      // Верхняя — цена смены на КАЖДЫЙ день срока (08–12 июня), и день срока без смены несёт её
      // сам (Р29): 2 голых атома по 1000 плюс три дня со сменами.
      const bare = bareOf(id.s1);
      expect(bare.map((a) => a.date)).toEqual(['2026-06-08', '2026-06-12']);
      expect(bare.map((a) => a.moneyHigh)).toEqual([1000, 1000]);
      expect(bare.every((a) => a.moneyLow === 0 && a.moneyFact === 0)).toBe(true);
      expect(sumOf([...worked, ...bare], 'moneyHigh')).toBe(5000);
      expect(sumOf(atomsOf(id.s1), 'moneyFact')).toBe(0);
    });

    it('заказ без единой смены живёт одной верхней оценкой (Р29)', () => {
      const atoms = atomsOf(id.s10);
      expect(atoms.map((a) => a.date)).toEqual(['2026-06-18', '2026-06-19']);
      expect(atoms.every((a) => a.shifts === 0 && a.engineHours === 0)).toBe(true);
      // Нижняя честно даёт ноль — фактом не подтверждено ничего; верхняя обязана дать цену срока,
      // иначе вилка схлопывается там, где она нужнее всего.
      expect(sumOf(atoms, 'moneyLow')).toBe(0);
      expect(atoms.map((a) => a.moneyHigh)).toEqual([700, 700]);
      expect(atoms.every((a) => a.priced)).toBe(true);
      // Позиция у дня срока — та же машина назначения, что работала бы в этот день (Р8).
      expect(atoms.every((a) => a.positionKey === id.v3)).toBe(true);
    });

    it('часовая ставка считает низ по моточасам, а верх — по длине смены', () => {
      const worked = atomsOf(id.s2).filter((a) => a.shifts === 1);
      expect(worked.map((a) => a.date)).toEqual(['2026-06-30']);
      // 500 ₽/ч × 7 моточасов заполненного дня.
      expect(worked[0]!.moneyLow).toBe(3500);
      // Цена дня — 500 ₽/ч × 8 часов смены, и она же стоит на каждом дне срока внутри периода
      // (28–30 июня): 3 × 4000. День 1 июля лежит за границей и своей цены не отдаёт.
      expect(worked[0]!.moneyHigh).toBe(4000);
      expect(sumOf(atomsOf(id.s2), 'moneyHigh')).toBe(12000);
    });

    it('заявка, пересекающая границу, отдаёт периоду ДОЛЮ суммы, а не всю (Р28)', async () => {
      // Три дня смен, сумма закрытия 1000 ₽: июню достаётся один день, июлю — два.
      const june = atomsOf(id.s8);
      expect(june.map((a) => a.date)).toEqual(['2026-06-30']);
      expect(june[0]!.moneyFact).toBe(333.33);
      const july = await ctx.load({ from: '2026-07-01', to: '2026-07-31' });
      const inJuly = july.atoms.filter((a) => a.requestId === id.s8);
      expect(inJuly.map((a) => a.date)).toEqual(['2026-07-01', '2026-07-02']);
      expect(sumOf(inJuly, 'moneyFact')).toBe(666.67);
      // Два соседних отчёта в сумме дают сумму заявки, а не две суммы: знаменатель — вся её работа.
      expect(sumOf(june, 'moneyFact') + sumOf(inJuly, 'moneyFact')).toBe(1000);
    });

    it('перевозка оценивается днями рейсов, и обе оценки у неё совпадают', () => {
      const atom = atomsOf(id.fA1)[0]!;
      expect(atom.moneyLow).toBe(5000);
      // Срока у перевозки нет — есть день подачи, и выдумывать вилку не из чего (Р9).
      expect(atom.moneyHigh).toBe(5000);
      const closed = atomsOf(id.fB1)[0]!;
      expect(closed.moneyFact).toBe(7000);
      expect(closed.moneyLow).toBe(0);
    });

    it('заявка без цены назначения помечена и в деньги не вошла', () => {
      const atom = atomsOf(id.s4)[0]!;
      expect(atom.priced).toBe(false);
      expect(atom.moneyFact + atom.moneyLow + atom.moneyHigh).toBe(0);
      // Остальные оценены хоть как-нибудь: флаг живёт на атоме, а считается по заявке.
      expect(atomsOf(id.s1).every((a) => a.priced)).toBe(true);
    });

    it('часовая ставка без длины смены — «без цены», а не оценка нулём (Р29)', () => {
      const atoms = atomsOf(id.s9);
      // Цены дня нет: домножать часовую ставку на дни, не зная часов в дне, значит выдумать число.
      expect(atoms.every((a) => !a.priced)).toBe(true);
      expect(sumOf(atoms, 'moneyLow') + sumOf(atoms, 'moneyHigh')).toBe(0);
      // День срока без смены атомом всё равно становится — ради плана (Р7), но денег не несёт.
      const bare = bareOf(id.s9);
      expect(bare.map((a) => a.date)).toEqual(['2026-06-06']);
      expect(bare[0]!.planShifts).toBe(1);
    });

    it('смена за пределами срока отвечает своей нижней оценкой (ADR 0101)', () => {
      // Заказ закрыли раньше, а коррекция задним числом день оставила: 16 июня в срок 13–14.06 не
      // входит. Верхней границы у такого дня нет — цену срока он не подтверждает, — и инвариант
      // «низ не больше верха» держится поатомно, а не поправкой в итоге.
      const outside = atomsOf(id.sBackdated).filter((a) => a.shifts === 1);
      expect(outside.map((a) => a.date)).toEqual(['2026-06-16']);
      expect(outside[0]!.planShifts).toBe(0);
      expect(outside[0]!.moneyLow).toBe(800);
      expect(outside[0]!.moneyHigh).toBe(800);
      // Дни самого срока при этом живут своей верхней оценкой и без единой смены.
      const bare = bareOf(id.sBackdated);
      expect(bare.map((a) => a.date)).toEqual(['2026-06-13', '2026-06-14']);
      expect(bare.map((a) => a.moneyHigh)).toEqual([800, 800]);
      expect(sumOf(bare, 'moneyLow')).toBe(0);
    });

    it('нижняя оценка нигде не больше верхней', () => {
      expect(facts.atoms.every((a) => a.moneyLow <= a.moneyHigh + 0.01)).toBe(true);
    });
  });

  // ── 6. Лист «Качество данных» (Р20) ──

  describe('качество данных', () => {
    it('смены без визы площадки — долей от всех смен периода', () => {
      // Всего смен июня: 3 (s1) + 1 (s2) + 3 (s3) + 1 (s4) + 2 (s7) + 1 (s8) + 1 (s9)
      //   + 1 (sNewShift) + 1 (sBackdated) = 14.
      // Без подписи: 10 июня (s1), 30 июня (s2), 20 июня (s4).
      expect(qualityOf('onsite.shifts-unapproved')).toEqual({ value: 3, outOf: 14 });
    });

    it('закрытые перевозки без рейса названы числом — потеря обязана быть видимой', () => {
      // fNoRoute (сумма 3000) и fNoVehicle (закрыта без суммы) в рейс не попали; знаменатель — все
      // закрытые перевозки периода, то есть они же плюс fB1. Без этой строки починка Д1 была бы
      // неотличима от «данных и не было».
      expect(qualityOf('freight.closed-without-route')).toEqual({ value: 2, outOf: 3 });
    });

    it('«без цены» считается по заявкам, а не по строкам', () => {
      // s4 и s11 (цены нет вовсе), s9 (часовая ставка без длины смены) и fNoVehicle (перевозка без
      // назначения). Будь счёт по атомам, заявка с тремя сменами дала бы три.
      expect(qualityOf('vehicle.requests-unpriced')).toEqual({ value: 4, outOf: null });
    });

    it('заявки, не закрытые на момент выгрузки, названы числом', () => {
      // Перевозки: fA1, fA2, fA3, fDept; площадка: s1, s2, s4, s7, s9, s10, s11, sOneDay,
      // sNewShift, sBackdated. Закрытые (fB1, s3, s8, fNoRoute, fNoVehicle) не в счёт, а
      // fInWorkNoRoute атома не даёт вовсе.
      expect(qualityOf('vehicle.requests-open')).toEqual({ value: 14, outOf: null });
    });

    it('подпись счётчика незакрытых отвечает про тот же момент, что и расчёт (Д3)', () => {
      // Закрытия этого набора записаны `now()` — то есть ПОСЛЕ конца июня, — и всё-таки fB1 считана
      // закрытой: и счётчик, и деньги рядом с ним отвечают про момент выгрузки. Пока статус на
      // атоме сегодняшний, подпись «на конец периода» обещала бы другое: заявка, закрытая после
      // границы, стояла бы в «Факте» и в «незакрытых» одновременно.
      const entry = facts.quality.find((q) => q.key === 'vehicle.requests-open');
      expect(entry!.label).toContain('на момент выгрузки');
      const closed = atomsOf(id.fB1)[0]!;
      expect(closed.requestStatus).toBe('done');
      expect(closed.moneyFact).toBe(7000);
    });

    it('план и факт смен: дни срока против заполненных смен', () => {
      // План: 5 (s1) + 3 (s2 внутри периода) + 3 (s3) + 2 (s4) + 10 (s7) + 1 (s8) + 2 (s9)
      //       + 2 (s10) + 2 (s11) + 1 (sOneDay) + 2 (sBackdated) = 33 дня срока против 14
      //       заполненных смен. «Новые» sNew и sNewShift знаменателя не раздувают (Д2).
      expect(qualityOf('onsite.shifts-plan-fact')).toEqual({ value: 14, outOf: 33 });
    });
  });
});
