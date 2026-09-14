import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения модулей сервера берутся `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { AnalyticsAtom, AnalyticsFacts } from '../src/services/analytics/types';

/**
 * ЗАГРУЗЧИКИ АТОМОВ ВЫВОЗА И МЕХАНИЗАЦИИ (план `docs/analytics-summary-export-plan.md`, Э1).
 *
 * Файл доказывает не «функция что-то вернула», а ПРАВИЛА СЧЁТА, каждое из которых при ошибке даёт
 * правдоподобное, но неверное число — то есть такое, которое в книге никто не заметит:
 *
 *   1. **День отнесения вывоза** (Р11): фактический день закрытия, а при его отсутствии —
 *      календарный день доставки ПО МОСКВЕ. Оба случая проверяются на заявках, у которых плановый
 *      и фактический дни лежат в разных месяцах: перепутай правило — и заявка уедет в соседний
 *      период, оставаясь в книге.
 *   2. **Объём и вес не складываются** (Р17): металлолом приходит тоннами и в кубы не попадает.
 *   3. **Отменённые и удалённые не считаются нигде** (Р10).
 *   4. **Оценка у обоих модулей одна** (Р9): `moneyLow === moneyHigh`. Вилка заведена ради заказа
 *      ТС, и разойдись эти два числа здесь — свод показал бы ложный разброс.
 *   5. **Раскладка аренды по дням присутствия** (Р28): аренда, пересекающая обе границы периода,
 *      отдаёт в период только свои дни, а деньги и отработанные единицы делятся на дни ВСЕЙ
 *      аренды. Подели на дни куска — и аренда, начатая в июле и закрытая в сентябре, показала бы
 *      полную стоимость в каждом из трёх месяцев. Остаток округления ложится на последний день
 *      аренды: без него сумма атомов сходится с суммой заявки лишь примерно.
 *   6. **Часовая ставка без отработанных часов оценки не даёт** (Р29, тот же ответ, что у заказа
 *      техники): «500 ₽/ч, 5 дней» — это не 2 500 ₽, это «неизвестно».
 *   7. **Невозвращённая техника присутствует до конца периода**: аренда с планом до 31.07, не
 *      закрытая в августе, обязана остаться в августовской книге — и днями, и строкой качества.
 *   8. **Вывозом считается состоявшийся вывоз**: у заявки с плановым днём доставки внутри периода
 *      и закрытием в следующем месяце вывоз ровно один, и он в месяце закрытия. Считай вывозом
 *      план — и две соседние книги дадут два вывоза на одну заявку.
 *   9. **Сумма двух соседних периодов равна периоду целиком** — и по деньгам, и по количествам.
 *      Это тот самый инвариант, который ломается тише всего: по одной книге его не видно.
 *
 * СВОЯ БАЗА, А НЕ ОБЩАЯ `technic_archive_test`: загрузчики считают ПО ВСЕЙ ОРГАНИЗАЦИИ (Р3) — ни
 * объекта, ни исполнителя в параметрах у них нет, — поэтому любая чужая заявка в периоде попадает
 * в их ответ и ломает счётчики качества, у которых знаменатель это «все заявки периода».
 *
 * Запуск (базу тест заводит и сносит сам; `TEST_DATABASE_URL` нужен лишь ради адреса сервера):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/analytics-facts-waste-mech.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;
const OWN_DB_NAME = 'technic_analytics_waste_mech_test';
const OWN_DB = DB_URL?.replace(/\/[^/]+$/, `/${OWN_DB_NAME}`);
const ADMIN_DB = DB_URL?.replace(/\/[^/]+$/, '/postgres');

const RUN = randomUUID().slice(0, 8);

/** Период выгрузки: календарный август. Обе границы включительно. */
const RANGE = { from: '2026-08-01', to: '2026-08-31' };
/** Соседний месяц: в него обязана уехать заявка, закрытая первым сентября. */
const RANGE_SEP = { from: '2026-09-01', to: '2026-09-30' };
/** Две половины августа: их сумма обязана совпасть с августом целиком (Р28). */
const RANGE_H1 = { from: '2026-08-01', to: '2026-08-15' };
const RANGE_H2 = { from: '2026-08-16', to: '2026-08-31' };

interface Ctx {
  closeDb: () => Promise<void>;
  waste: AnalyticsFacts;
  /** Тот же набор данных за сентябрь: в нём проверяется «переезд» закрытой заявки. */
  wasteSep: AnalyticsFacts;
  mech: AnalyticsFacts;
  mechH1: AnalyticsFacts;
  mechH2: AnalyticsFacts;
}

let ctx: Ctx;
/**
 * Ответ базы на попытку закрыть аренду, не записав день возврата. Хранится строкой, а не проверяется
 * на месте: заводится набор один раз в beforeAll, и вставка — часть этого набора.
 */
let doneWithoutReturn = '';
/** Идентификаторы заведённых заявок по прозвищу случая: атомы ищутся по ним, а не по номеру. */
const ids: Record<string, string> = {};

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

// ── Помощники разбора ответа ──

function atomsOf(facts: AnalyticsFacts, tag: string): AnalyticsAtom[] {
  return facts.atoms.filter((atom) => atom.requestId === ids[tag]);
}

/** Ровно один атом случая: у вывоза заявка всегда лежит одним днём и одной позицией. */
function oneAtom(facts: AnalyticsFacts, tag: string): AnalyticsAtom {
  const found = atomsOf(facts, tag);
  expect(found, `у случая «${tag}» ровно один атом`).toHaveLength(1);
  return found[0]!;
}

function sumOf(atoms: AnalyticsAtom[], field: keyof AnalyticsAtom): number {
  return atoms.reduce((acc, atom) => acc + (atom[field] as number), 0);
}

function quality(facts: AnalyticsFacts, key: string): { value: number; outOf: number | null } {
  const entry = facts.quality.find((q) => q.key === key);
  expect(entry, `строка качества «${key}» есть в ответе`).toBeTruthy();
  return { value: entry!.value, outOf: entry!.outOf };
}

describe.skipIf(!DB_URL)('атомы аналитики: вывоз мусора и механизация', () => {
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
    const { loadWasteFacts } = await import('../src/services/analytics/facts-waste');
    const { loadMechFacts } = await import('../src/services/analytics/facts-mech');

    const one = async (query: SQL): Promise<string> => {
      const res = await db.execute<{ id: string }>(query);
      return res.rows[0]!.id;
    };

    // ── Справочники ──
    const objectId = await one(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${`AN-${RUN}`}, ${`Площадка ${RUN}`}, 'г Москва, ул Тестовая, д 1') RETURNING id`);
    const departmentId = await one(sql`
      INSERT INTO departments (code, name) VALUES (${`AND-${RUN}`}, ${`Снабжение ${RUN}`})
      RETURNING id`);
    const userId = await one(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${`db-an-${RUN}@example.invalid`}, 'Тестовый', 'Пользователь', 'Аналитикович',
              'x', 'admin'::role, true, now())
      RETURNING id`);
    const operatorId = await one(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('operator', ${`Перевозчик ${RUN}`}, '7700000001') RETURNING id`);
    const lessorId = await one(sql`
      INSERT INTO counterparties (type, name, inn)
      VALUES ('mech_lessor', ${`Арендодатель ${RUN}`}, '7700000002') RETURNING id`);
    const wasteTypeId = await one(sql`
      INSERT INTO waste_types (code, name) VALUES (${`an_debris_${RUN}`}, ${`Строительный мусор ${RUN}`})
      RETURNING id`);
    const truckId = await one(sql`
      INSERT INTO container_types (code, name, type, volume_m3)
      VALUES (${`an_truck_${RUN}`}, ${`Самосвал 20 ${RUN}`}, 'truck', 20) RETURNING id`);
    const contId = await one(sql`
      INSERT INTO container_types (code, name, type, volume_m3)
      VALUES (${`an_cont_${RUN}`}, ${`Контейнер 8 ${RUN}`}, 'cont', 8) RETURNING id`);
    const tariffId = await one(sql`
      INSERT INTO waste_tariffs (operator_counterparty_id, waste_type_id, container_type_id,
                                 price_per_m3)
      VALUES (${operatorId}, ${wasteTypeId}, ${truckId}, 100) RETURNING id`);
    const modelId = await one(sql`
      INSERT INTO mech_models (code, name)
      VALUES (${`an-vibro-${RUN}`}, ${`Виброплита ${RUN}`}) RETURNING id`);

    // ── Заявки на вывоз ──
    /** Заявка вывоза: общее у всех случаев — объект, автор, ответственный. */
    const waste = async (
      tag: string,
      row: {
        type: string;
        status: string;
        deliveryAt: string;
        wasteTypeId?: string | null;
        containerTypeId?: string | null;
        volumeM3?: number | null;
        priced?: boolean;
        deleted?: boolean;
      },
    ): Promise<string> => {
      const id = await one(sql`
        INSERT INTO waste_requests (object_id, request_type, status, delivery_at,
                                    waste_type_id, container_type_id, volume_m3,
                                    waste_tariff_id, price_per_m3, created_by, deleted_at)
        VALUES (${objectId}, ${sql.raw(`'${row.type}'::request_type`)},
                ${sql.raw(`'${row.status}'::request_status`)}, ${row.deliveryAt}::timestamptz,
                ${row.wasteTypeId ?? null}, ${row.containerTypeId ?? null}, ${row.volumeM3 ?? null},
                ${row.priced ? tariffId : null}, ${row.priced ? 100 : null}, ${userId},
                ${row.deleted ? sql`now()` : sql`NULL`})
        RETURNING id`);
      ids[tag] = id;
      return id;
    };
    /** Закрытие: ровно одна величина на строку — это держит CHECK `measure` (ADR 0067). */
    const closeWaste = async (
      id: string,
      row: { volumeM3?: number; weightTons?: number; totalCost?: number; removedOn?: string },
    ): Promise<void> => {
      await db.execute(sql`
        INSERT INTO waste_request_completions (request_id, volume_m3, weight_tons, total_cost,
                                               completed_by, removed_on, removed_on_source)
        VALUES (${id}, ${row.volumeM3 ?? null}, ${row.weightTons ?? null},
                ${row.totalCost ?? null}, ${userId}, ${row.removedOn ?? null},
                ${row.removedOn ? 'entered' : 'unknown'})`);
    };

    /* 1. Факт с проставленным днём вывоза: доставка в июле, вывезли в августе (Р11). */
    await waste('removed-on', {
      type: 'waste_removal',
      status: 'completed',
      deliveryAt: '2026-07-25T09:00:00+03:00',
      wasteTypeId,
      containerTypeId: truckId,
      volumeM3: 20,
      priced: true,
    });
    await closeWaste(ids['removed-on']!, {
      volumeM3: 20,
      totalCost: 1000,
      removedOn: '2026-08-10',
    });
    await db.execute(sql`
      INSERT INTO waste_tickets (request_id, origin, status, confirmed_by, confirmed_at)
      VALUES (${ids['removed-on']}, 'manual', 'confirmed', ${userId}, now())`);

    /*
     * 2. Закрытие старше колонки `removed_on` — день берётся у доставки, и берётся ПО МОСКВЕ.
     * 00:30 МСК первого августа это 21:30 UTC тридцать первого июля: забудь пояс — и заявка
     * выпадет из августа целиком, не оставив следа ни в одном листе.
     */
    await waste('msk-midnight', {
      type: 'waste_removal',
      status: 'done',
      deliveryAt: '2026-08-01T00:30:00+03:00',
      wasteTypeId,
      containerTypeId: truckId,
      volumeM3: 10,
      priced: true,
    });
    await closeWaste(ids['msk-midnight']!, { volumeM3: 10, totalCost: 500 });

    /* 3. Металлолом: вес, ни объёма, ни денег — предмета у заявки нет вовсе (ADR 0067). */
    await waste('metal', {
      type: 'metal_removal',
      status: 'completed',
      deliveryAt: '2026-08-12T10:00:00+03:00',
    });
    await closeWaste(ids['metal']!, { weightTons: 3.5, removedOn: '2026-08-12' });

    /* 4. Контейнерная операция: счётчик без объёма и без денег. */
    await waste('container', {
      type: 'container_install',
      status: 'new',
      deliveryAt: '2026-08-15T09:00:00+03:00',
      containerTypeId: contId,
    });

    /*
     * 4б. Та же операция, но ВЫПОЛНЕННАЯ. Закрытия у контейнерной операции не бывает вовсе
     * (предъявлять ей нечего), поэтому «сделали» у неё означает статус-факт: спроси у неё
     * закрытие — и колонка «Конт. опер.» обнулилась бы целиком.
     */
    await waste('container-done', {
      type: 'container_removal',
      status: 'done',
      deliveryAt: '2026-08-16T09:00:00+03:00',
      containerTypeId: contId,
    });

    /* 5. Отменённая — не считается нигде (Р10). */
    await waste('cancelled', {
      type: 'waste_removal',
      status: 'cancelled',
      deliveryAt: '2026-08-20T09:00:00+03:00',
      wasteTypeId,
      containerTypeId: truckId,
      volumeM3: 15,
      priced: true,
    });

    /* 6. Незакрытая: количество есть, объёма нет, деньги — оценка по заявленному объёму. */
    await waste('estimate-amount', {
      type: 'waste_removal',
      status: 'confirmed',
      deliveryAt: '2026-08-18T09:00:00+03:00',
      wasteTypeId,
      containerTypeId: truckId,
      volumeM3: 30,
      priced: true,
    });

    /* 7. Незакрытая со строками самосвалов: они побеждают сумму заявки, удалённая строка — нет. */
    await waste('estimate-vehicles', {
      type: 'waste_removal',
      status: 'confirmed',
      deliveryAt: '2026-08-19T09:00:00+03:00',
      wasteTypeId,
      containerTypeId: truckId,
      volumeM3: 5,
      priced: true,
    });
    await db.execute(sql`
      INSERT INTO waste_request_vehicles (request_id, container_type_id, volume_m3, vehicle_count,
                                          waste_tariff_id, price_per_m3, deleted_at)
      VALUES (${ids['estimate-vehicles']}, ${truckId}, 10, 2, ${tariffId}, 50, NULL),
             (${ids['estimate-vehicles']}, ${truckId}, 1, 1, ${tariffId}, 777, now())`);

    /* 8. Незакрытая без цены: оценить нечем — это и есть «заявка без цены». */
    await waste('unpriced', {
      type: 'waste_removal',
      status: 'confirmed',
      deliveryAt: '2026-08-21T09:00:00+03:00',
      wasteTypeId,
      volumeM3: 12,
    });

    /* 9. Доставка в августе, вывезли в сентябре: в августовской книге заявки нет (Р11). */
    await waste('late-removed-on', {
      type: 'waste_removal',
      status: 'completed',
      deliveryAt: '2026-08-20T09:00:00+03:00',
      wasteTypeId,
      containerTypeId: truckId,
      volumeM3: 7,
      priced: true,
    });
    await closeWaste(ids['late-removed-on']!, {
      volumeM3: 7,
      totalCost: 300,
      removedOn: '2026-09-01',
    });

    /* 10. Мягко удалённая — не считается нигде (Р10). */
    await waste('waste-deleted', {
      type: 'waste_removal',
      status: 'completed',
      deliveryAt: '2026-08-22T09:00:00+03:00',
      wasteTypeId,
      containerTypeId: truckId,
      volumeM3: 9,
      priced: true,
      deleted: true,
    });
    await closeWaste(ids['waste-deleted']!, {
      volumeM3: 9,
      totalCost: 400,
      removedOn: '2026-08-22',
    });

    /*
     * 11. Незакрытая с двумя строками самосвалов, у одной из которых тарифа нет вовсе (CHECK
     * `waste_request_vehicles_price_snapshot_check` разрешает пару NULL). Оценить заявку нечем:
     * sum() бесценную строку пропускает молча, и цена одной машины выдала бы себя за цену двух.
     */
    await waste('partial-priced', {
      type: 'waste_removal',
      status: 'confirmed',
      deliveryAt: '2026-08-23T09:00:00+03:00',
      wasteTypeId,
      containerTypeId: truckId,
      volumeM3: 8,
      priced: true,
    });
    await db.execute(sql`
      INSERT INTO waste_request_vehicles (request_id, container_type_id, volume_m3, vehicle_count,
                                          waste_tariff_id, price_per_m3)
      VALUES (${ids['partial-priced']}, ${truckId}, 10, 1, ${tariffId}, 50),
             (${ids['partial-priced']}, ${truckId}, 6, 1, NULL, NULL)`);

    // ── Аренды механизации ──
    const mech = async (
      tag: string,
      row: {
        status: string;
        plannedFrom: string;
        plannedTo: string;
        actualFrom?: string | null;
        actualTo?: string | null;
        actualUnits?: number | null;
        finalCost?: number | null;
        rate?: number | null;
        rateUnit?: 'hour' | 'shift' | null;
        modelId?: string | null;
        departmentId?: string | null;
        deleted?: boolean;
      },
    ): Promise<string> => {
      const hasDeal = row.rate != null;
      const id = await one(sql`
        INSERT INTO mech_requests (object_id, department_id, mech_model_id, planned_from, planned_to,
                                   responsible_name, responsible_phone, status,
                                   lessor_id, lessor_type, lessor_is_active, rate, rate_unit,
                                   actual_from, actual_to, actual_units, final_cost,
                                   created_by, deleted_at)
        VALUES (${objectId}, ${row.departmentId ?? null}, ${row.modelId ?? null},
                ${row.plannedFrom}::date, ${row.plannedTo}::date,
                'Иванов Иван Иванович', '9990000000',
                ${sql.raw(`'${row.status}'::request_status`)},
                ${hasDeal ? lessorId : null},
                ${hasDeal ? sql`'mech_lessor'::counterparty_type` : sql`NULL`},
                ${hasDeal ? sql`true` : sql`NULL`},
                ${row.rate ?? null},
                ${row.rateUnit ? sql.raw(`'${row.rateUnit}'::mech_rate_unit`) : sql`NULL`},
                ${row.actualFrom ?? null}, ${row.actualTo ?? null},
                ${row.actualUnits ?? null}, ${row.finalCost ?? null},
                ${userId}, ${row.deleted ? sql`now()` : sql`NULL`})
        RETURNING id`);
      ids[tag] = id;
      return id;
    };

    /*
     * M1. Аренда, пересекающая ОБЕ границы периода: 25.07 – 05.09, всего 43 дня. В августе 31 день,
     * и 43 смены с 4300 ₽ делятся на 43 дня — по смене и по сотне рублей в день.
     */
    await mech('cross-borders', {
      status: 'done',
      plannedFrom: '2026-07-25',
      plannedTo: '2026-09-05',
      actualFrom: '2026-07-25',
      actualTo: '2026-09-05',
      actualUnits: 43,
      finalCost: 4300,
      rate: 100,
      rateUnit: 'shift',
      modelId,
      departmentId,
    });

    /* M2. Выдана и не возвращена, модели нет: оценка — ставка × дни присутствия по плану. */
    await mech('in-work', {
      status: 'confirmed',
      plannedFrom: '2026-08-10',
      plannedTo: '2026-08-14',
      actualFrom: '2026-08-10',
      rate: 500,
      rateUnit: 'hour',
    });

    /* M3. Техника ещё не выдана: дни плановые, оценить нечем — договорённости нет. */
    await mech('not-issued', {
      status: 'new',
      plannedFrom: '2026-08-20',
      plannedTo: '2026-08-22',
      modelId,
    });

    /* M4, M5. Отменённая и удалённая — не считаются нигде (Р10). */
    await mech('mech-cancelled', {
      status: 'cancelled',
      plannedFrom: '2026-08-05',
      plannedTo: '2026-08-06',
      modelId,
    });
    await mech('mech-deleted', {
      status: 'new',
      plannedFrom: '2026-08-07',
      plannedTo: '2026-08-08',
      modelId,
      deleted: true,
    });

    /* M6. Закрытая почасовая: 32 часа и 16 000 ₽ на четыре дня — по 8 часов и 4 000 ₽ в день. */
    await mech('hour-fact', {
      status: 'done',
      plannedFrom: '2026-08-01',
      plannedTo: '2026-08-04',
      actualFrom: '2026-08-01',
      actualTo: '2026-08-04',
      actualUnits: 32,
      finalCost: 16000,
      rate: 200,
      rateUnit: 'hour',
      modelId,
    });

    /* M7. Технику вернули, но заявку не завершили: деньги — ещё оценка, а не факт (Р10). */
    await mech('returned-open', {
      status: 'confirmed',
      plannedFrom: '2026-08-05',
      plannedTo: '2026-08-08',
      actualFrom: '2026-08-05',
      actualTo: '2026-08-08',
      actualUnits: 4,
      finalCost: 4400,
      rate: 1000,
      rateUnit: 'shift',
      modelId,
    });

    /*
     * M8. Выдана 01.07 с планом до 31.07 и НЕ ВОЗВРАЩЕНА: в августе техника всё ещё на площадке.
     * Плановый конец давно прошёл, и присутствие тянется до конца запрошенного периода — иначе
     * аренда выпала бы из августовской книги целиком, вместе со строкой листа «Качество».
     */
    await mech('overdue', {
      status: 'confirmed',
      plannedFrom: '2026-07-01',
      plannedTo: '2026-07-31',
      actualFrom: '2026-07-01',
      rate: 700,
      rateUnit: 'shift',
      modelId,
    });

    /* M9. Возвращена 03.09: на конец августа она в работе, сколько бы раз книгу ни перепечатывали. */
    await mech('returned-after-period', {
      status: 'done',
      plannedFrom: '2026-08-20',
      plannedTo: '2026-09-05',
      actualFrom: '2026-08-20',
      actualTo: '2026-09-03',
      actualUnits: 15,
      finalCost: 7500,
      rate: 500,
      rateUnit: 'shift',
      modelId,
    });

    /*
     * M11. Закрытая аренда без дня возврата — состояние, которое книге пришлось бы называть вслух
     * (по датам она выглядела бы и действующей, и просроченной). База его не допускает, и проверка
     * стоит здесь ради этого ответа: он и есть инвариант, на который опирается счёт «в работе».
     */
    try {
      await mech('done-without-return', {
        status: 'done',
        plannedFrom: '2026-08-05',
        plannedTo: '2026-08-07',
        actualFrom: '2026-08-05',
        actualUnits: 3,
        finalCost: 900,
        rate: 300,
        rateUnit: 'shift',
        modelId,
      });
    } catch (error) {
      // Имя нарушенного CHECK лежит в причине: drizzle оборачивает ошибку драйвера своей.
      doneWithoutReturn = `${String(error)} ${String((error as { cause?: unknown }).cause ?? '')}`;
    }

    /* M10. 100 ₽ и 10 смен на три дня: ровно не делится, и остаток обязан лечь на последний день. */
    await mech('remainder', {
      status: 'done',
      plannedFrom: '2026-08-10',
      plannedTo: '2026-08-12',
      actualFrom: '2026-08-10',
      actualTo: '2026-08-12',
      actualUnits: 10,
      finalCost: 100,
      rate: 40,
      rateUnit: 'shift',
      modelId,
    });

    ctx = {
      closeDb,
      waste: await loadWasteFacts(RANGE),
      wasteSep: await loadWasteFacts(RANGE_SEP),
      mech: await loadMechFacts(RANGE),
      mechH1: await loadMechFacts(RANGE_H1),
      mechH2: await loadMechFacts(RANGE_H2),
    };
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

  // ── Вывоз мусора ──

  describe('вывоз мусора: день отнесения (Р11)', () => {
    it('закрытие с фактической датой ложится на день вывоза, а не доставки', () => {
      const atom = oneAtom(ctx.waste, 'removed-on');
      expect(atom.date, 'доставляли 25.07, вывезли 10.08').toBe('2026-08-10');
      expect(atom.module).toBe('waste');
      expect(atom.customerKind, 'заказчик вывоза — всегда объект').toBe('object');
      expect(atom.payerDepartmentId, 'отдела-плательщика у вывоза не бывает').toBeNull();
      expect(atom.registrationNumber).toBeNull();
    });

    it('закрытие без фактической даты ложится на МОСКОВСКИЙ день доставки', () => {
      const atom = oneAtom(ctx.waste, 'msk-midnight');
      expect(atom.date, '00:30 МСК первого августа — это август, а не 31 июля по UTC').toBe(
        '2026-08-01',
      );
    });

    it('вывоз, закрытый днём следующего месяца, в периоде не участвует', () => {
      expect(
        atomsOf(ctx.waste, 'late-removed-on'),
        'доставка в августе, вывоз 01.09 — заявка уходит в сентябрьскую книгу',
      ).toHaveLength(0);
    });
  });

  describe('вывоз мусора: количества (Р17, Р21)', () => {
    it('вывоз мусора считается заявкой, а объём берётся из факта', () => {
      const atom = oneAtom(ctx.waste, 'removed-on');
      expect(atom.removals).toBe(1);
      expect(atom.volumeM3).toBe(20);
      expect(atom.weightTons).toBe(0);
      expect(atom.containerOps).toBe(0);
      expect(atom.positionLabel, 'позиция — «вид отхода · тип контейнера»').toBe(
        `Строительный мусор ${RUN} · Самосвал 20 ${RUN}`,
      );
    });

    it('металлолом приходит весом и в объём не попадает', () => {
      const atom = oneAtom(ctx.waste, 'metal');
      expect(atom.weightTons).toBe(3.5);
      expect(atom.volumeM3, 'тонны в кубы не переливаются (Р17)').toBe(0);
      expect(atom.removals).toBe(1);
      expect(atom.positionLabel).toBe('Металлолом');
      expect(atom.moneyFact, 'лом денег не несёт вовсе (ADR 0067)').toBe(0);
      expect(
        atom.priced,
        'у лома денег нет по построению — «без цены» это НЕ УДАЛОСЬ оценить, а не «бесплатно»',
      ).toBe(true);
    });

    it('выполненная контейнерная операция — свой счётчик, без объёма и без денег', () => {
      const atom = oneAtom(ctx.waste, 'container-done');
      expect(atom.containerOps).toBe(1);
      expect(atom.removals).toBe(0);
      expect(atom.volumeM3).toBe(0);
      expect(atom.moneyFact + atom.moneyLow + atom.moneyHigh).toBe(0);
      expect(atom.priced, 'контейнерная операция не тарифицируется (ADR 0019)').toBe(true);
    });

    /*
     * То же правило, что у вывоза: колонка отвечает «сколько сделали». Заявка на 15 августа,
     * которую ещё не выполнили, в августовскую книгу количеством не идёт — иначе, выполненная
     * вторым сентября, она посчиталась бы дважды: планом в августе и фактом в сентябре.
     */
    it('незавершённая контейнерная операция в счётчик не идёт', () => {
      const atom = oneAtom(ctx.waste, 'container');
      expect(atom.containerOps, 'заказана, но не сделана').toBe(0);
      expect(atom.removals).toBe(0);
    });

    it('незакрытая заявка вывозом не считается — ни объёма, ни количества', () => {
      const atom = oneAtom(ctx.waste, 'estimate-amount');
      expect(atom.removals, 'закрытия нет — вывоз ещё не состоялся').toBe(0);
      expect(atom.volumeM3, 'заявленный объём — план, а считается вывезенное').toBe(0);
      expect(atom.moneyLow, 'деньги-оценка при этом остаются: атом никуда не девается').toBe(3000);
    });

    /*
     * Д4. Пара соседних книг на одну заявку: доставка 20.08, закрытие 01.09. Пока заявка не
     * закрыта, августовская книга ставит ей ноль вывозов; после закрытия она уходит в сентябрь
     * целиком. Считай вывозом плановый день — и августовский отчёт, напечатанный по горячим
     * следам, вместе с сентябрьским дали бы два вывоза на одну заявку.
     */
    it('вывоз считается один раз и ровно в том месяце, когда состоялся', () => {
      expect(atomsOf(ctx.waste, 'late-removed-on'), 'в августе её нет вовсе').toHaveLength(0);
      const sep = oneAtom(ctx.wasteSep, 'late-removed-on');
      expect(sep.date, 'вывоз ложится на день закрытия').toBe('2026-09-01');
      expect(sep.removals, 'и считается ровно в сентябре').toBe(1);
      expect(sep.volumeM3).toBe(7);
      const august = sumOf(atomsOf(ctx.waste, 'estimate-amount'), 'removals');
      const inSep = sumOf(atomsOf(ctx.wasteSep, 'late-removed-on'), 'removals');
      expect(august + inSep, 'два соседних отчёта не удваивают вывоз').toBe(1);
    });

    it('отменённой и удалённой заявок нет вовсе (Р10)', () => {
      expect(atomsOf(ctx.waste, 'cancelled')).toHaveLength(0);
      expect(atomsOf(ctx.waste, 'waste-deleted')).toHaveLength(0);
    });
  });

  describe('вывоз мусора: деньги (Р9)', () => {
    it('факт закрытия — в «Факт», оценки у закрытой заявки нет', () => {
      const atom = oneAtom(ctx.waste, 'removed-on');
      expect(atom.moneyFact).toBe(1000);
      expect(atom.moneyLow).toBe(0);
      expect(atom.moneyHigh).toBe(0);
      expect(atom.priced).toBe(true);
    });

    it('оценка незакрытой — сумма заявки, и она ОДНА: ниж. = верх.', () => {
      const atom = oneAtom(ctx.waste, 'estimate-amount');
      expect(atom.moneyFact).toBe(0);
      expect(atom.moneyLow, '30 м³ × 100 ₽').toBe(3000);
      expect(atom.moneyHigh).toBe(3000);
    });

    it('строки самосвалов побеждают сумму заявки, удалённая строка не считается', () => {
      const atom = oneAtom(ctx.waste, 'estimate-vehicles');
      expect(atom.moneyLow, '10 м³ × 2 машины × 50 ₽, а не 5 × 100 заявки').toBe(1000);
      expect(atom.moneyHigh).toBe(1000);
    });

    /*
     * Д3. Цена есть у одной строки из двух: оценить заявку нечем вовсе. Старое правило считало
     * sum() по живым строкам, бесценную строку пропускало молча и выдавало 500 ₽ — цену ОДНОЙ
     * машины за работу двух, — да ещё и с priced = true, то есть без единого следа на листе
     * «Качество».
     */
    it('строки самосвалов без тарифа обнуляют оценку, а не уменьшают её', () => {
      const atom = oneAtom(ctx.waste, 'partial-priced');
      expect(atom.moneyLow, 'не 500 ₽ по одной строке и не 800 ₽ по сумме заявки').toBe(0);
      expect(atom.moneyHigh).toBe(0);
      expect(atom.priced, 'ноль в денежной клетке — это «бесплатно», а тут «неизвестно»').toBe(
        false,
      );
    });

    it('оценить нечем — заявка без цены', () => {
      const atom = oneAtom(ctx.waste, 'unpriced');
      expect(atom.moneyLow).toBe(0);
      expect(atom.priced).toBe(false);
    });

    it('у всех атомов вывоза нижняя оценка равна верхней', () => {
      for (const atom of ctx.waste.atoms) {
        expect(atom.moneyLow, `${atom.requestLabel}: у вывоза оценка одна`).toBe(atom.moneyHigh);
      }
    });
  });

  describe('вывоз мусора: качество данных (Р20)', () => {
    it('закрытия без фактической даты — одно из трёх закрытий периода', () => {
      expect(quality(ctx.waste, 'waste.completions_without_removed_on')).toEqual({
        value: 1,
        outOf: 3,
      });
    });

    /*
     * Знаменатель — состоявшиеся вывозы, те же три, что стоят в колонке «Вывозов»: закрытий в
     * периоде три (вывоз с датой, вывоз без даты, лом), талон подтверждён у одного. Считай здесь
     * и незакрытые заявки — и «5 из 6» не сошлось бы ни с одной клеткой книги.
     */
    it('вывозы без принятого талона считаются по состоявшимся вывозам', () => {
      expect(quality(ctx.waste, 'waste.removals_without_ticket')).toEqual({ value: 2, outOf: 3 });
    });

    it('заявок без цены — две из девяти, и лом с контейнерными операциями в счёт не идут', () => {
      // Без цены: заявка без тарифа вовсе и заявка, где тариф есть лишь у части строк (Д3).
      expect(quality(ctx.waste, 'waste.requests_without_price')).toEqual({ value: 2, outOf: 9 });
    });
  });

  // ── Механизация ──

  describe('механизация: дни присутствия и раскладка (Р28)', () => {
    it('аренда, пересекающая обе границы, отдаёт периоду только свои дни', () => {
      const atoms = atomsOf(ctx.mech, 'cross-borders');
      expect(atoms, 'август целиком, без июля и сентября').toHaveLength(31);
      expect(sumOf(atoms, 'mechDays')).toBe(31);
      expect(atoms.every((a) => a.date >= RANGE.from && a.date <= RANGE.to)).toBe(true);
    });

    it('actual_units и final_cost делятся на дни ВСЕЙ аренды, а не её куска', () => {
      const atoms = atomsOf(ctx.mech, 'cross-borders');
      // 43 смены и 4300 ₽ на 43 дня аренды: в августе 31 день — 31 смена и 3100 ₽.
      for (const atom of atoms) {
        expect(atom.shifts).toBeCloseTo(1, 10);
        expect(atom.moneyFact).toBeCloseTo(100, 10);
      }
      expect(sumOf(atoms, 'shifts')).toBeCloseTo(31, 10);
      expect(sumOf(atoms, 'moneyFact')).toBeCloseTo(3100, 10);
      expect(sumOf(atoms, 'mechHours'), 'ставка за смену — часов у аренды нет').toBe(0);
    });

    it('часовая ставка наполняет моточасы, а не смены (Р17)', () => {
      const atoms = atomsOf(ctx.mech, 'hour-fact');
      expect(atoms).toHaveLength(4);
      expect(sumOf(atoms, 'mechHours')).toBeCloseTo(32, 10);
      expect(sumOf(atoms, 'shifts'), 'часы и смены не складываются').toBe(0);
      expect(sumOf(atoms, 'moneyFact')).toBeCloseTo(16000, 10);
      for (const atom of atoms) {
        expect(atom.mechHours).toBeCloseTo(8, 10);
        expect(atom.moneyFact).toBeCloseTo(4000, 10);
      }
    });

    it('невыданная аренда присутствует плановыми днями', () => {
      const atoms = atomsOf(ctx.mech, 'not-issued');
      expect(atoms, '20–22 августа по плану').toHaveLength(3);
      expect(atoms.map((a) => a.date)).toEqual(['2026-08-20', '2026-08-21', '2026-08-22']);
      expect(
        atoms.every((a) => a.priced),
        'договорённости нет — оценить нечем',
      ).toBe(false);
    });

    /*
     * Д2. Просроченная невозвращённая аренда: выдана 01.07, план до 31.07, возврата нет. Присутствие
     * тянется до конца запрошенного периода, поэтому август у неё полный. Старое правило обрывало
     * присутствие плановым днём — и аренда пропадала из августовской книги ЦЕЛИКОМ: ни дней, ни
     * денег, ни строки на листе «Качество», который считается по тем же арендам.
     */
    it('невозвращённая техника присутствует до конца периода, а не до планового дня', () => {
      const atoms = atomsOf(ctx.mech, 'overdue');
      expect(atoms, 'весь август, хотя план кончился 31 июля').toHaveLength(31);
      expect(atoms[0]!.date).toBe('2026-08-01');
      expect(atoms[atoms.length - 1]!.date).toBe('2026-08-31');
      expect(sumOf(atoms, 'mechDays')).toBe(31);
      // Знаменатель — 62 дня присутствия (июль и август), ставка за смену: доля дня равна ставке.
      expect(sumOf(atoms, 'moneyLow'), '700 ₽ × 31 день августа').toBeCloseTo(21700, 6);
      expect(atoms.every((a) => a.priced)).toBe(true);
    });

    /*
     * Д5. Остаток деления кладётся на последний день аренды (Р28): 100 ₽ и 10 смен на три дня. Без
     * досыпки остатка сумма атомов была бы 99,99 ₽ и 9,99 смены — расхождение, которое на листе
     * «Свод» выглядит опечаткой, а происходит на каждой аренде, не делящейся нацело.
     */
    it('остаток деления ложится на последний день аренды', () => {
      const atoms = atomsOf(ctx.mech, 'remainder').sort((a, b) => a.date.localeCompare(b.date));
      expect(atoms).toHaveLength(3);
      expect(atoms.map((a) => a.moneyFact)).toEqual([33.33, 33.33, 33.34]);
      expect(atoms.map((a) => a.shifts)).toEqual([3.33, 3.33, 3.34]);
      expect(sumOf(atoms, 'moneyFact'), 'раскладка сходится до копейки').toBeCloseTo(100, 6);
      expect(sumOf(atoms, 'shifts')).toBeCloseTo(10, 6);
    });

    it('отменённой и удалённой аренд нет вовсе (Р10)', () => {
      expect(atomsOf(ctx.mech, 'mech-cancelled')).toHaveLength(0);
      expect(atomsOf(ctx.mech, 'mech-deleted')).toHaveLength(0);
    });
  });

  /*
   * Р28 в самом опасном его виде: инвариант «две половины равны целому». Ломается он тише всего —
   * по одной книге расхождения не видно, а сумма двух соседних отчётов оказывается больше годового.
   */
  describe('механизация: сумма соседних периодов равна периоду целиком (Р28)', () => {
    const FIELDS = [
      'moneyFact',
      'moneyLow',
      'moneyHigh',
      'mechDays',
      'shifts',
      'mechHours',
    ] as const;

    it('половины августа в сумме дают август', () => {
      for (const field of FIELDS) {
        const whole = sumOf(ctx.mech.atoms, field);
        const halves = sumOf(ctx.mechH1.atoms, field) + sumOf(ctx.mechH2.atoms, field);
        expect(halves, `${field}: 1–15 плюс 16–31 равно августу`).toBeCloseTo(whole, 6);
      }
    });

    it('аренда, пересекающая обе границы, делится между половинами, а не удваивается', () => {
      const first = atomsOf(ctx.mechH1, 'cross-borders');
      const second = atomsOf(ctx.mechH2, 'cross-borders');
      expect(first).toHaveLength(15);
      expect(second).toHaveLength(16);
      expect(sumOf(first, 'moneyFact'), '15 дней по 100 ₽').toBeCloseTo(1500, 6);
      expect(sumOf(second, 'moneyFact'), '16 дней по 100 ₽').toBeCloseTo(1600, 6);
    });

    /*
     * У НЕВОЗВРАЩЁННОЙ аренды знаменатель раскладки зависит от периода (присутствие дотянуто до его
     * конца) — и всё равно половины сходятся с целым: при ставке за смену доля дня равна самой
     * ставке, сколько бы дней присутствия ни насчитал период.
     */
    it('просроченная аренда сходится и по половинам', () => {
      expect(sumOf(atomsOf(ctx.mechH1, 'overdue'), 'moneyLow')).toBeCloseTo(10500, 6);
      expect(sumOf(atomsOf(ctx.mechH2, 'overdue'), 'moneyLow')).toBeCloseTo(11200, 6);
    });
  });

  describe('механизация: заказчик и позиция (Р22)', () => {
    it('строка свода — объект-место, отдел едет отдельным полем', () => {
      const atom = atomsOf(ctx.mech, 'cross-borders')[0]!;
      expect(atom.customerKind, 'место эксплуатации, а не плательщик').toBe('object');
      expect(
        atom.payerDepartmentId,
        'отдел-плательщик — своим полем, не второй строкой',
      ).toBeTruthy();
      expect(atom.payerDepartmentName).toBe(`Снабжение ${RUN}`);
      expect(atom.positionLabel).toBe(`Виброплита ${RUN}`);
      expect(atom.registrationNumber).toBeNull();
    });

    it('аренда без модели собирается в свою позицию с устойчивым ключом', () => {
      // Аренда выдана 10.08 и не возвращена: присутствие тянется до конца августа (Д2).
      const atoms = atomsOf(ctx.mech, 'in-work');
      expect(atoms).toHaveLength(22);
      expect(new Set(atoms.map((a) => a.positionKey)), 'ключ один на все дни').toEqual(
        new Set(['mech|no-model']),
      );
      expect(atoms[0]!.positionLabel).toBe('Без модели');
      expect(atoms[0]!.payerDepartmentId, 'отдел у этой аренды не указан').toBeNull();
    });
  });

  describe('механизация: деньги (Р9)', () => {
    /*
     * Д1. Часовая ставка без отработанных часов не даёт оценки ВОВСЕ — тот же ответ, что у заказа
     * техники (facts-vehicle.ts, dayPrice, Р29). Прежнее правило множило 500 ₽/ч на календарные
     * дни и выдавало 2 500 ₽ там, где по смыслу около 20 000: число правдоподобное, а потому
     * неопровержимое. Заявка идёт в счётчик «без цены», и ноль в денежной клетке остаётся
     * признаком бесплатной работы, а не «неизвестно».
     */
    it('часовая ставка без отработанных часов оценки не даёт', () => {
      const atoms = atomsOf(ctx.mech, 'in-work');
      expect(sumOf(atoms, 'moneyFact'), 'факта у незакрытой аренды нет').toBe(0);
      expect(sumOf(atoms, 'moneyLow'), 'не 500 ₽ × дни: часов в дне не знает никто').toBe(0);
      expect(sumOf(atoms, 'moneyHigh')).toBe(0);
      expect(
        atoms.every((a) => a.priced),
        'оценить нечем — значит «без цены»',
      ).toBe(false);
    });

    /* При ставке ЗА СМЕНУ расчёт по дням присутствия остаётся: смена и день сопоставимы. */
    it('ставка за смену без отработанных единиц считается по дням присутствия', () => {
      const atoms = atomsOf(ctx.mech, 'overdue');
      expect(atoms.every((a) => a.moneyLow === 700)).toBe(true);
      expect(atoms.every((a) => a.priced)).toBe(true);
    });

    it('возвращённая, но не завершённая аренда — оценка по отработанным единицам', () => {
      const atoms = atomsOf(ctx.mech, 'returned-open');
      expect(atoms).toHaveLength(4);
      expect(sumOf(atoms, 'moneyFact'), 'статус не «Выполнена» — факта нет (Р10)').toBe(0);
      expect(sumOf(atoms, 'moneyLow'), '1000 ₽ × 4 смены, а не введённые 4400').toBeCloseTo(
        4000,
        10,
      );
      expect(sumOf(atoms, 'shifts')).toBeCloseTo(4, 10);
    });

    it('у всех атомов механизации нижняя оценка равна верхней', () => {
      for (const atom of ctx.mech.atoms) {
        expect(atom.moneyLow, `${atom.requestLabel}: у механизации оценка одна`).toBe(
          atom.moneyHigh,
        );
      }
    });
  });

  describe('механизация: качество данных (Р20)', () => {
    // Знаменатель у всех строк один — восемь аренд, пересекающихся с августом.
    it('аренды без итоговой суммы — три из восьми аренд периода', () => {
      // Сумма не введена у незакрытых: почасовая в работе, невыданная и просроченная.
      expect(quality(ctx.mech, 'mech.rentals_without_final_cost')).toEqual({ value: 3, outOf: 8 });
    });

    it('аренда без модели — одна из восьми', () => {
      expect(quality(ctx.mech, 'mech.rentals_without_model')).toEqual({ value: 1, outOf: 8 });
    });

    /*
     * Д6. «В работе на конец периода» считается НА КОНЕЦ ПЕРИОДА, а не на момент запроса: в счёт
     * идут и две аренды, возвращённые уже в сентябре, — на 31 августа техника стояла на площадке.
     * Спрашивай сегодняшнее состояние, и августовская книга худела бы с каждым возвратом, то есть
     * отвечала бы разными числами при каждой перепечатке.
     */
    it('в работе на конец периода: возврат в сентябре августу не помогает', () => {
      expect(quality(ctx.mech, 'mech.rentals_in_progress')).toEqual({ value: 4, outOf: 8 });
      const returnedLater = atomsOf(ctx.mech, 'returned-after-period');
      expect(returnedLater, 'вернули 03.09 — августу достались 12 дней').toHaveLength(12);
      expect(sumOf(returnedLater, 'moneyFact'), '7 500 ₽ на 15 дней, августу 12').toBeCloseTo(
        6000,
        6,
      );
    });

    /*
     * Д2. Просрочка названа вслух отдельной строкой: её дни присутствия дотянуты до конца периода,
     * и без счётчика этот домысел в книге ничем не помечен. Порог — конец периода, а не «сегодня»:
     * иначе строка меняла бы значение день ото дня у одной и той же книги.
     */
    it('просроченные аренды названы отдельной строкой качества', () => {
      expect(quality(ctx.mech, 'mech.rentals_overdue')).toEqual({ value: 2, outOf: 8 });
    });

    /*
     * СЧЁТ «В РАБОТЕ» ПО ДАТАМ ОПИРАЕТСЯ НА ИНВАРИАНТ БАЗЫ, и вот он. Закрытая аренда обязана нести
     * день возврата (`mech_requests_done_check`; «Завершена» у механизации запрещена вовсе),
     * поэтому «не возвращена к концу периода» и «не закрыта» — про одни и те же строки, а счётчик
     * не путает стоящую на площадке технику с незаполненным фактом.
     *
     * Упадёт этот тест — значит CHECK ослабили, и книге понадобилась строка «Аренд закрыто без
     * даты возврата»: иначе такая аренда молча попадёт и в действующие, и в просроченные, и
     * читатель решит, что техники на площадках вдвое больше.
     */
    it('закрытой аренды без дня возврата база не допускает', () => {
      expect(doneWithoutReturn, 'инвариант держит CHECK, а не счётчик книги').toMatch(
        /mech_requests_done_check/,
      );
    });
  });
});
