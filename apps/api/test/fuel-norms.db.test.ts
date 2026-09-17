import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  STAFF_SUBMIT_PAST_DAYS,
  type ReadingInput,
  type ReadingMonthRow,
  type ReportItemSubmit,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';
import type * as AggregateNs from '../src/services/readings-aggregate';

/**
 * СВЕРКА РАСХОДА С НОРМОЙ на живой схеме (план `docs/fuel-norms-plan.md`, §3).
 *
 * Зачем база, а не юнит. Вся сверка выражена формой одного сырого запроса: непрерывность пары —
 * `NOT EXISTS` по ожидаемым сменам двух разных документов, база — `CASE` по единице нормы,
 * действующая версия — боковой поиск максимума даты. Подменить это нечем: проверять надо ровно тот
 * SQL, который поедет в прод, и ровно на тех данных, которые заводят сервисы модуля показаний.
 *
 * Данные заводятся сервисами (`openReport`/`submitReport`), рейсами и листами — как в соседнем
 * тесте агрегата. Тест на прямых вставках зеленел бы ровно тогда, когда портал начал бы врать.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_fuelnorms_test \
 *     npx vitest run apps/api/test/fuel-norms.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-fuel-norms-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/**
 * Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам».
 * Метка своя на прогон — второй экземпляр файла рядом (полный `vitest run` разработчика) с общей
 * меткой унёс бы машины из-под живого теста.
 */
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: сверка с нормой';
const MARK = `${MARK_PREFIX} ${randomUUID().slice(0, 8)}`;
/** Номера бланков — из заведомо свободного диапазона, свой блок на прогон (см. `readings-stats`). */
const WAYBILL_NUMBER_BASE = 940_000_000 + Math.floor(Math.random() * 900) * 1_000;

const TODAY = moscowDateKeyOf(new Date());
/** Раньше этого дня персонал показания уже не внесёт (Р11): весь отрезок сценариев живёт внутри. */
const EARLIEST = shiftDateKey(TODAY, -STAFF_SUBMIT_PAST_DAYS);
const MONTH_START = `${TODAY.slice(0, 7)}-01`;

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof ReadingsNs;
  aggregate: typeof AggregateNs;
  closeDb: () => Promise<void>;
  adminId: string;
  objectId: string;
  typeId: string;
  organizationId: string;
  seriesId: string;
}

let ctx: Ctx;
let waybillNo = 0;

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

/** Уборка одного прогона. Порядок обратный ссылкам: отчёты, документы, заявки, машины, люди. */
async function purge(db: typeof AppDb, mark: string): Promise<void> {
  const persons = sql`(SELECT id FROM persons WHERE comment = ${mark})`;
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM waybills WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_routes WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${mark}`);
  await db.execute(
    sql`DELETE FROM vehicle_fuel_norms WHERE vehicle_id IN (SELECT id FROM vehicles WHERE note = ${mark})`,
  );
  await db.execute(sql`DELETE FROM vehicles WHERE note = ${mark}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${mark}`);
}

/**
 * Хвосты прошлых прогонов — только заведомо мёртвые (старше часа): прогон, идущий рядом прямо
 * сейчас, — это живой тест, и унести его данные значит уронить его в случайном месте.
 */
async function purgeStale(db: typeof AppDb): Promise<void> {
  const marks = await db.execute<{ mark: string }>(sql`
    SELECT DISTINCT mark FROM (
      SELECT comment AS mark, created_at FROM persons WHERE comment LIKE ${`${MARK_PREFIX}%`}
      UNION ALL
      SELECT note AS mark, created_at FROM vehicles WHERE note LIKE ${`${MARK_PREFIX}%`}
    ) t WHERE created_at < now() - interval '1 hour'`);
  for (const row of marks.rows) await purge(db, row.mark);
}

async function seedAdmin(db: typeof AppDb, schema: typeof SchemaNs): Promise<string> {
  const { hashPassword } = await import('../src/auth/password');
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, ADMIN_EMAIL));
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.users)
    .values({
      email: ADMIN_EMAIL,
      lastName: 'Тестовый',
      firstName: 'Администратор',
      middleName: 'Агрегатный',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

// ── Дни сценариев ──

function series(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => shiftDateKey(first, index));
}

/**
 * `count` подряд идущих дней окна записи, через которые проходит граница месяца: `before` из них
 * приходится на прошлый месяц, остальные — на текущий. Раскладки с границей внутри окна может не
 * быть вовсе — тогда ответ `undefined`, и что с этим делать, решает вызывающий.
 *
 * Граница вычисляется, а не пишется числом: окно записи — тридцать дней от сегодняшнего, и жёсткие
 * даты сделали бы файл годным ровно один месяц. Запрошенная раскладка в окно иногда не влезает
 * (первое число месяца, конец длинного) — тогда берётся любая другая с границей внутри.
 *
 * КОГДА РАСКЛАДКИ НЕТ. Прошлый месяц целиком раньше `EARLIEST` — то есть в 31-й день 31-дневного
 * месяца: окно сдачи показаний (`STAFF_SUBMIT_PAST_DAYS` = 30 дней) короче такого месяца, и за его
 * последнее число персонал уже не вправе вносить показания. Таких дней в году семь — по одному на
 * каждый 31-дневный месяц, — и один из них, 31.08.2026, как раз и уронил прогон.
 *
 * ПОЧЕМУ ОТКАЗ, А НЕ ЗАПАСНОЙ РЯД. Раньше на этот случай помощник молча отдавал подряд идущие дни
 * **внутри** одного месяца. Это худший из возможных ответов: посылка помощника («два дня по разные
 * стороны границы») нарушена, сказано об этом не было, и сценарий переноса рейса падал утверждением
 * про ключи месяцев — то есть день, в который сцену просто не собрать, читался как поломка продукта
 * (§2.4 плана [test-gates-plan.md](../../../docs/test-gates-plan.md)). Отказ отдаётся значением, а
 * не броском, именно потому, что цена границы у сценариев разная: одному она обязательна и без неё
 * проверять нечего, другому лишь желательна — и бросок отнял бы у второго тот единственный день,
 * который он честно проходит.
 */
function daysAcrossMonth(count: number, before: number): string[] | undefined {
  const gaps = Array.from({ length: count - 1 }, (_, index) => index + 1);
  for (const gap of [before, ...gaps.filter((value) => value !== before)]) {
    const first = shiftDateKey(MONTH_START, -gap);
    if (first >= EARLIEST && shiftDateKey(first, count - 1) <= TODAY) return series(first, count);
  }
  return undefined;
}

/** День от сегодняшнего назад: сценариям одной машины дни соседей безразличны, машины у них свои. */
function ago(days: number): string {
  return shiftDateKey(TODAY, -days);
}

// ── Фикстуры ──

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Нормов', firstName, middleName: 'Тестович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

/** Своя машина: у собственной описание пустое и цен нет — этого требует `vehicles_own_fields_check`. */
async function newVehicle(): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({ ownership: 'own', vehicleTypeId: ctx.typeId, status: 'active', note: MARK })
    .returning({ id: ctx.schema.vehicles.id });
  return vehicle!.id;
}

/** Заявка-пустышка: рейсу-перегону она основание (колонка NOT NULL). */
async function newRequest(): Promise<string> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.typeId,
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id });
  return request!.id;
}

/** Лист 4-П по рейсу: `waybills_form_source_check` требует у него заполненный `route_id`. */
async function issueWaybillFor(
  routeId: string,
  vehicleId: string,
  personId: string,
  date: string,
): Promise<string> {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: WAYBILL_NUMBER_BASE + waybillNo,
      formCode: '4p',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId,
      driverPersonId: personId,
      issuedForDate: date,
      routeId,
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

/**
 * Рейс-перегон, по умолчанию с выписанным листом: кабинет строго документален (ADR 0105, Р5), и без
 * листа рейс заданием не является — а ожидаемые смены статистика берёт по тому же правилу (Р26а).
 * Ровно поэтому лист здесь можно и не выписывать: это отдельный сценарий, а не забытая фикстура.
 */
async function newRoute(
  vehicleId: string,
  date: string,
  personId: string,
  options: { documented?: boolean } = {},
): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId,
      routeDate: date,
      purpose: 'delivery',
      sourceRequestId: await newRequest(),
      moveFrom: 'База',
      moveTo: 'Объект',
      driverPersonId: personId,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  if (options.documented !== false) await issueWaybillFor(route!.id, vehicleId, personId, date);
  return route!.id;
}

/** Числа показания: поля с умолчаниями схема заполняет сама, а сервис зовётся уже разобранным телом. */
function values(input: Partial<Omit<ReadingInput & { kind: 'values' }, 'kind'>>): ReadingInput {
  return {
    kind: 'values',
    odometerKm: null,
    engineHours: null,
    fuelFilledLiters: null,
    comment: '',
    ...input,
  } as ReadingInput;
}

function line(itemId: string, reading: ReadingInput): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: [],
    confirmOdometerAnomaly: false,
    confirmEngineHoursAnomaly: false,
  };
}

/**
 * Весь ввод идёт «за водителя» (`mode: 'staff'`, Р26): половина дней отрезка старше водительского
 * окна записи, и сам водитель их не закрыл бы. На числа и на качество данных режим не влияет: он
 * виден только в `source` показания.
 */
const STAFF = { mode: 'staff' as const };

async function report(personId: string, date: string) {
  return ctx.service.openReport(personId, date, ctx.adminId, STAFF);
}

async function submit(personId: string, date: string, items: ReportItemSubmit[], reason = '') {
  const current = await ctx.service.loadReport(personId, date);
  return ctx.service.submitReport(
    personId,
    date,
    { version: current!.version, items, reason },
    ctx.adminId,
    null,
    { ...STAFF, reason },
  );
}

/** Открыть день и сдать по нему одну строку: сценариев в файле много, шагов у них два. */
async function reportDay(personId: string, date: string, reading: ReadingInput): Promise<void> {
  const opened = await report(personId, date);
  expect(opened.items).toHaveLength(1);
  await submit(personId, date, [line(opened.items[0]!.id, reading)]);
}


// ── Чтение агрегата ──

async function fleetRowOf(vehicleId: string, from: string, to: string) {
  const rows = await ctx.aggregate.loadFleetStats(from, to);
  return rows.find((row) => row.vehicleId === vehicleId) ?? null;
}

/** Сверка одной машины за период — четыре числа плюс признак нормы, как их видит сводка. */
async function checkOf(vehicleId: string, from: string, to: string) {
  const row = await fleetRowOf(vehicleId, from, to);
  expect(row, 'строка сводки').not.toBeNull();
  return {
    spent: row!.fuelSpentLiters,
    norm: row!.fuelNormLiters,
    verified: row!.verifiedShifts,
    withFuel: row!.shiftsWithFuel,
    hasNorm: row!.hasNorm,
  };
}

/** Норма машины версией: справочник пишется прямой вставкой — его ручки проверяет свой тест. */
async function setNorm(
  vehicleId: string,
  input: {
    effectiveFrom: string;
    unit?: 'l_per_100km' | 'l_per_hour';
    winterRate?: number;
    summerRate?: number;
  },
): Promise<void> {
  await ctx.db.insert(ctx.schema.vehicleFuelNorms).values({
    vehicleId,
    effectiveFrom: input.effectiveFrom,
    unit: input.unit ?? 'l_per_100km',
    winterRate: String(input.winterRate ?? 40),
    summerRate: String(input.summerRate ?? 30),
  });
}

/** Границы сезона на время теста: сверка обязана считаться и зимой, и летом одинаково предсказуемо. */
async function setSeason(winterFromMd: string, winterToMd: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO fuel_norm_settings (winter_from_md, winter_to_md, tolerance_percent)
    VALUES (${winterFromMd}, ${winterToMd}, 5)
    ON CONFLICT (id) DO UPDATE SET winter_from_md = ${winterFromMd}, winter_to_md = ${winterToMd}`);
}

/** Показание с топливом: остатки на концах смены и заправка между ними. */
function fuel(
  odometerKm: number | null,
  start: number | null,
  filled: number | null,
  end: number | null,
  engineHours: number | null = null,
): ReadingInput {
  return values({
    odometerKm,
    engineHours,
    fuelStartLiters: start,
    fuelFilledLiters: filled,
    fuelEndLiters: end,
  } as Partial<Omit<ReadingInput & { kind: 'values' }, 'kind'>>);
}

describe.skipIf(!DB_URL)('сверка расхода топлива с нормой', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/readings');
    const aggregate = await import('../src/services/readings-aggregate');
    await purgeStale(db);

    const adminId = await seedAdmin(db, schema);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const types = await db.execute<{ id: string }>(
      sql`SELECT vt.id FROM vehicle_types vt
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          WHERE vk.code = 'freight_transport' ORDER BY vt.code LIMIT 1`,
    );
    const organizations = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
    );
    const seriesRows = await db.execute<{ id: string }>(
      sql`SELECT id FROM waybill_series ORDER BY code LIMIT 1`,
    );
    if (!objects.rows[0] || !types.rows[0] || !organizations.rows[0] || !seriesRows.rows[0]) {
      throw new Error('В базе нет объекта, типа ТС, организации или серии бланков');
    }
    ctx = {
      db,
      schema,
      service,
      aggregate,
      closeDb,
      adminId,
      objectId: objects.rows[0].id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: seriesRows.rows[0].id,
    };
    // Зима на весь год: сценарии ставок проверяют выбор ставки отдельным случаем, а остальным
    // важно, чтобы ставка была одна и та же независимо от дня, в который идёт прогон.
    await setSeason('01-01', '12-31');
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await purge(ctx.db, MARK);
      await ctx.closeDb();
    }
  });

  it('расход считается только по сменам с обоими остатками', async () => {
    const person = await newPerson('Остатков');
    const vehicle = await newVehicle();
    const [d1, d2, d3] = [ago(5), ago(4), ago(3)];
    await newRoute(vehicle, d1!, person);
    await newRoute(vehicle, d2!, person);
    await newRoute(vehicle, d3!, person);
    // Первая смена задаёт начало ряда: пары у неё нет, и в сверку она не идёт по устройству (Р14б).
    await reportDay(person, d1!, fuel(1000, 100, 0, 80));
    // Вторая: 100 км, сожжено 100 + 50 − 90 = 60 л.
    await reportDay(person, d2!, fuel(1100, 100, 50, 90));
    // Третья: остатков нет вовсе — расхода у неё нет, и в знаменатель охвата она не идёт.
    await reportDay(person, d3!, fuel(1200, null, 40, null));
    await setNorm(vehicle, { effectiveFrom: d1!, winterRate: 40, summerRate: 40 });

    const check = await checkOf(vehicle, d1!, d3!);
    expect(check.withFuel, 'смен с посчитанным расходом').toBe(2);
    expect(check.verified, 'сверяемых смен').toBe(1);
    expect(check.spent, 'расход сверяемых смен').toBe(60);
    // 100 км по ставке 40 л/100 км.
    expect(check.norm, 'норма сверяемых смен').toBe(40);
    expect(check.hasNorm).toBe(true);
  });

  it('у машины без норм расход виден, а норма и признак молчат', async () => {
    const person = await newPerson('Безнормов');
    const vehicle = await newVehicle();
    const [d1, d2] = [ago(5), ago(4)];
    await newRoute(vehicle, d1!, person);
    await newRoute(vehicle, d2!, person);
    await reportDay(person, d1!, fuel(500, 90, 0, 70));
    await reportDay(person, d2!, fuel(600, 70, 30, 60));

    const check = await checkOf(vehicle, d1!, d2!);
    expect(check.hasNorm, 'нормы не заводили').toBe(false);
    // Годность смены от нормы не зависит (Р9в): расход показывается, сверять его просто не с чем.
    expect(check.spent).toBe(40);
    expect(check.verified).toBe(1);
    expect(check.norm, 'нормы нет — и нормы в литрах нет').toBe(0);
  });

  it('смена раньше первой версии нормы не сверяется и в расход не идёт', async () => {
    const person = await newPerson('Досидов');
    const vehicle = await newVehicle();
    const [d1, d2, d3] = [ago(6), ago(5), ago(4)];
    for (const day of [d1!, d2!, d3!]) await newRoute(vehicle, day, person);
    await reportDay(person, d1!, fuel(2000, 100, 0, 80));
    await reportDay(person, d2!, fuel(2100, 100, 0, 60));
    await reportDay(person, d3!, fuel(2200, 100, 0, 50));
    // Приказ пришёл с третьего дня: вторая смена нормы не имеет, и её расход в колонку не идёт —
    // иначе отклонение показало бы перерасход ровно на её величину (Р9г).
    await setNorm(vehicle, { effectiveFrom: d3!, winterRate: 50, summerRate: 50 });

    const check = await checkOf(vehicle, d1!, d3!);
    expect(check.withFuel, 'расход посчитан у обеих смен с парой').toBe(3);
    expect(check.verified, 'сверяется только смена под действием приказа').toBe(1);
    expect(check.spent).toBe(50);
    expect(check.norm).toBe(50);
  });

  it('ставка выбирается сезоном по дате смены', async () => {
    const person = await newPerson('Сезонов');
    const vehicle = await newVehicle();
    const [d1, d2] = [ago(5), ago(4)];
    await newRoute(vehicle, d1!, person);
    await newRoute(vehicle, d2!, person);
    await reportDay(person, d1!, fuel(3000, 100, 0, 90));
    await reportDay(person, d2!, fuel(3100, 100, 0, 60));
    await setNorm(vehicle, { effectiveFrom: d1!, winterRate: 60, summerRate: 20 });

    // Зима на весь год — действует зимняя ставка: 100 км × 60/100 = 60 л.
    await setSeason('01-01', '12-31');
    expect((await checkOf(vehicle, d1!, d2!)).norm).toBe(60);

    // Зима «через Новый год» длиной в один день, в который сегодня не попасть: остаётся летняя.
    const far = shiftDateKey(TODAY, 40).slice(5);
    await setSeason(far, far);
    expect((await checkOf(vehicle, d1!, d2!)).norm).toBe(20);

    await setSeason('01-01', '12-31');
  });

  it('норма в литрах на час считается по моточасам', async () => {
    const person = await newPerson('Моточасов');
    const vehicle = await newVehicle();
    const [d1, d2] = [ago(5), ago(4)];
    await newRoute(vehicle, d1!, person);
    await newRoute(vehicle, d2!, person);
    await reportDay(person, d1!, fuel(null, 100, 0, 90, 10));
    await reportDay(person, d2!, fuel(null, 100, 0, 70, 18));
    await setNorm(vehicle, {
      effectiveFrom: d1!,
      unit: 'l_per_hour',
      winterRate: 4,
      summerRate: 4,
    });

    const check = await checkOf(vehicle, d1!, d2!);
    expect(check.verified).toBe(1);
    expect(check.spent).toBe(30);
    // 8 моточасов по 4 л/час.
    expect(check.norm).toBe(32);
  });

  it('несданная смена рейса рвёт непрерывность: разность накрыла бы чужую работу', async () => {
    const person = await newPerson('Разрывов');
    const vehicle = await newVehicle();
    const [d1, d2, d3] = [ago(6), ago(5), ago(4)];
    await newRoute(vehicle, d1!, person);
    await newRoute(vehicle, d2!, person);
    await newRoute(vehicle, d3!, person);
    await reportDay(person, d1!, fuel(4000, 100, 0, 90));
    // Средний день ждали (рейс с листом есть), но показаний по нему не сдавали вовсе.
    await reportDay(person, d3!, fuel(4300, 100, 0, 40));
    await setNorm(vehicle, { effectiveFrom: d1!, winterRate: 40, summerRate: 40 });

    const check = await checkOf(vehicle, d1!, d3!);
    expect(check.withFuel, 'расход у последней смены посчитан').toBe(2);
    expect(check.verified, 'но её пара накрыла несданный день — сверки нет').toBe(0);
    expect(check.spent).toBe(0);
  });

  it('отрицательный расход в сверку не идёт, но в охват попадает', async () => {
    const person = await newPerson('Минусов');
    const vehicle = await newVehicle();
    const [d1, d2] = [ago(5), ago(4)];
    await newRoute(vehicle, d1!, person);
    await newRoute(vehicle, d2!, person);
    await reportDay(person, d1!, fuel(5000, 50, 0, 40));
    // Конец больше начала с заправкой: заправку не записали, и «экономия» здесь — выдумка.
    await reportDay(person, d2!, fuel(5100, 40, 0, 95));
    await setNorm(vehicle, { effectiveFrom: d1!, winterRate: 40, summerRate: 40 });

    const check = await checkOf(vehicle, d1!, d2!);
    expect(check.withFuel).toBe(2);
    expect(check.verified).toBe(0);
    expect(check.spent).toBe(0);
    expect(check.norm).toBe(0);
  });

  it('сумма месяцев равна итогу периода и по сверке', async () => {
    const days = daysAcrossMonth(4, 2);
    if (!days) return;
    const person = await newPerson('Помесячный');
    const vehicle = await newVehicle();
    for (const day of days) await newRoute(vehicle, day, person);
    let odometer = 7000;
    let index = 0;
    for (const day of days) {
      odometer += 100;
      index += 1;
      await reportDay(person, day, fuel(odometer, 100, 0, 100 - index * 10));
    }
    await setNorm(vehicle, { effectiveFrom: days[0]!, winterRate: 40, summerRate: 40 });

    const from = days[0]!;
    const to = days[days.length - 1]!;
    const card = await ctx.aggregate.loadVehicleCard(vehicle, from, to);
    expect(card).not.toBeNull();
    const months = card!.months;
    expect(months.length, 'период обязан пересекать границу месяца').toBeGreaterThan(1);
    const sum = (pick: (m: ReadingMonthRow) => number) =>
      months.reduce((acc, month) => acc + pick(month), 0);
    expect(card!.total.fuelSpentLiters).toBeCloseTo(sum((m) => m.fuelSpentLiters), 5);
    expect(card!.total.fuelNormLiters).toBeCloseTo(sum((m) => m.fuelNormLiters), 5);
    expect(card!.total.verifiedShifts).toBe(sum((m) => m.verifiedShifts));
    expect(card!.total.shiftsWithFuel).toBe(sum((m) => m.shiftsWithFuel));
    // Карточка несёт допуск и признак нормы: без них портал не покрасил бы превышение (Р12б, Р15а).
    expect(card!.hasNorm).toBe(true);
    expect(card!.tolerancePercent).toBeGreaterThanOrEqual(0);
  });
});
