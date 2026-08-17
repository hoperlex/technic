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
  type ReadingTotals,
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
 * Агрегат показаний на живой схеме (план «Показания техники», §5): месяцы, итог периода и качество
 * данных по парку.
 *
 * Зачем база. `services/readings-aggregate.ts` — это один сырой текст SQL (Р33), и почти каждое его
 * утверждение выражено не ветвлением, а формой запроса: полным внешним объединением двух координат
 * смены (Р32), самоджойном по набору вместо таблицы (Р32г), `coalesce(..., false)` вокруг признака
 * соответствия (Р32а) и фильтром `anomaly IS DISTINCT FROM 'counter_reset'`. Ошибка здесь живёт в
 * `USING`, в трёхзначной логике и в том, какая из двух дат попала в `to_char(…, 'YYYY-MM')`.
 * Подменить это нечем: проверять придётся ровно тот SQL, который поедет в прод.
 *
 * Второе — и главное: «ожидаемая смена» у статистики обязана значить ровно то же, что у кабинета
 * водителя и у реестра приёма (Р26а, Р26в). Поэтому данные заводятся сервисами модуля
 * (`openReport`/`submitReport`/`acceptReport`), рейсами и выписанными по ним листами, а не
 * вставками в `driver_daily_report_items` и `vehicle_readings`. Тест на вставках зеленел бы ровно
 * тогда, когда портал начал бы врать: он бы согласовал агрегат сам с собой, а не с модулем.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/readings-aggregate.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-readings-aggregate-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/**
 * Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам».
 * Метка своя на прогон — второй экземпляр файла рядом (полный `vitest run` разработчика) с общей
 * меткой унёс бы машины из-под живого теста.
 */
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: агрегат показаний';
const MARK = `${MARK_PREFIX} ${randomUUID().slice(0, 8)}`;
/** Номера бланков — из заведомо свободного диапазона, свой блок на прогон (см. `readings-stats`). */
const WAYBILL_NUMBER_BASE = 920_000_000 + Math.floor(Math.random() * 900) * 1_000;

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
 * приходится на прошлый месяц, остальные — на текущий.
 *
 * Граница вычисляется, а не пишется числом: окно записи — тридцать дней от сегодняшнего, и жёсткие
 * даты сделали бы файл годным ровно один месяц. Если запрошенная раскладка в окно не влезает
 * (первое число месяца, конец длинного), берётся любая другая с границей внутри, а на 31-м числе —
 * подряд идущие дни без границы вовсе: свойство «сумма месяцев равна итогу» верно и на одном
 * месяце, просто проверяет в этот день меньше.
 */
function daysAcrossMonth(count: number, before: number): string[] {
  const gaps = Array.from({ length: count - 1 }, (_, index) => index + 1);
  for (const gap of [before, ...gaps.filter((value) => value !== before)]) {
    const first = shiftDateKey(MONTH_START, -gap);
    if (first >= EARLIEST && shiftDateKey(first, count - 1) <= TODAY) return series(first, count);
  }
  return series(shiftDateKey(TODAY, -(count - 1)), count);
}

/** День от сегодняшнего назад: сценариям одной машины дни соседей безразличны, машины у них свои. */
function ago(days: number): string {
  return shiftDateKey(TODAY, -days);
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

// ── Фикстуры ──

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Агрегатов', firstName, middleName: 'Тестович', comment: MARK })
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

async function submit(personId: string, date: string, items: ReportItemSubmit[]) {
  const current = await ctx.service.loadReport(personId, date);
  return ctx.service.submitReport(
    personId,
    date,
    { version: current!.version, items, reason: '' },
    ctx.adminId,
    null,
    { ...STAFF, reason: '' },
  );
}

/** Открыть день и сдать по нему одну строку: сценариев в файле много, шагов у них два. */
async function reportDay(personId: string, date: string, reading: ReadingInput): Promise<void> {
  const opened = await report(personId, date);
  expect(opened.items).toHaveLength(1);
  await submit(personId, date, [line(opened.items[0]!.id, reading)]);
}

// ── Чтение агрегата ──

async function cardOf(vehicleId: string, from: string, to: string) {
  return ctx.aggregate.loadVehicleCard(vehicleId, from, to);
}

/** Месяцы своей машины: агрегат отвечает про весь парк, и чужие строки в его ответе законны. */
async function monthsOf(
  vehicleId: string,
  from: string,
  to: string,
): Promise<Map<string, ReadingMonthRow>> {
  const fleet = await ctx.aggregate.loadFleetMonths(from, to, vehicleId);
  return new Map((fleet.get(vehicleId) ?? []).map((row) => [row.month, row]));
}

async function fleetRowOf(vehicleId: string, from: string, to: string) {
  const rows = await ctx.aggregate.loadFleetStats(from, to);
  return rows.find((row) => row.vehicleId === vehicleId) ?? null;
}

/** Числовые поля `ReadingTotals` целиком: свойство Р4 проверяется по каждому, а не по трём знакомым. */
const TOTAL_KEYS = [
  'distanceKm',
  'engineHours',
  'fuelFilledLiters',
  'odometerGaps',
  'engineHoursGaps',
  'missingReadings',
  'shifts',
  'unacceptedShifts',
] as const satisfies readonly (keyof ReadingTotals)[];

/** Прочерк складывается с числом как отсутствие слагаемого, а не как ноль: месяц без пар молчит. */
function foldMonths(months: readonly ReadingMonthRow[], key: (typeof TOTAL_KEYS)[number]) {
  const known = months.map((row) => row[key]).filter((value): value is number => value !== null);
  return known.length === 0 ? null : round3(known.reduce((sum, value) => sum + value, 0));
}

function round3(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

describe.skipIf(!DB_URL)('агрегат показаний: месяцы, итог периода и качество данных', () => {
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
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await purge(ctx.db, MARK);
      await ctx.closeDb();
    }
  });

  it('сумма месяцев равна итогу периода: пара засчитана месяцу своего снимка', async () => {
    const person = await newPerson('Помесячный');
    const vehicle = await newVehicle();
    // Пять дней подряд, граница месяца — после второго: ряд обязан перешагнуть её парой, иначе
    // правило «пара идёт в месяц текущего снимка» (Р4) проверять не на чем.
    const days = daysAcrossMonth(5, 2);
    /**
     * День ряда и его вклад в месяц. Вклад объявлен, а не вычислен: тест утверждает правило, а не
     * повторяет расчёт. Пропуск посреди месяца (`no_data`) пару не рвёт — цепочка назначает
     * предшественником последний снимок с числом, и разность накрывает пропуск целиком.
     */
    const facts = [
      { odometerKm: 1000, engineHours: 10, fuel: 20, km: null, hours: null, missing: false },
      { odometerKm: 1100, engineHours: 12, fuel: null, km: 100, hours: 2, missing: false },
      { odometerKm: 1300, engineHours: 15, fuel: 10, km: 200, hours: 3, missing: false },
      { odometerKm: null, engineHours: null, fuel: null, km: null, hours: null, missing: true },
      { odometerKm: 1600, engineHours: 20, fuel: 5, km: 300, hours: 5, missing: false },
    ] as const;

    for (const [index, date] of days.entries()) {
      const fact = facts[index]!;
      await newRoute(vehicle, date, person);
      await reportDay(
        person,
        date,
        fact.odometerKm === null
          ? { kind: 'no_data', noDataReason: 'счётчик разбит', comment: '' }
          : values({
              odometerKm: fact.odometerKm,
              engineHours: fact.engineHours,
              fuelFilledLiters: fact.fuel,
            }),
      );
    }

    const card = await cardOf(vehicle, days[0]!, days[4]!);
    expect(card).not.toBeNull();
    expect(card!.from).toBe(days[0]);
    expect(card!.to).toBe(days[4]);
    // 100 + 200 + 300 и 2 + 3 + 5: считается работа между снимками, а не сами снимки. Литры —
    // простая сумма, они не разность и от цепочки не зависят вовсе.
    expect(card!.total).toMatchObject({
      distanceKm: 600,
      engineHours: 10,
      fuelFilledLiters: 35,
      missingReadings: 1,
      shifts: 5,
      unacceptedShifts: 5,
    });

    // Главное свойство Р4 — по каждому числу, а не по трём знакомым: разойдись месяц и итог хоть в
    // разрывах, карточка спорила бы сама с собой.
    for (const key of TOTAL_KEYS) {
      expect([key, foldMonths(card!.months, key)]).toEqual([key, round3(card!.total[key])]);
    }

    const expected = new Map<string, Record<string, number | null>>();
    for (const [index, date] of days.entries()) {
      const fact = facts[index]!;
      const row = expected.get(monthOf(date)) ?? {
        distanceKm: null,
        engineHours: null,
        fuelFilledLiters: 0,
        missingReadings: 0,
        shifts: 0,
        unacceptedShifts: 0,
      };
      row.distanceKm = fact.km === null ? row.distanceKm : (row.distanceKm ?? 0) + fact.km;
      row.engineHours = fact.hours === null ? row.engineHours : (row.engineHours ?? 0) + fact.hours;
      row.fuelFilledLiters = (row.fuelFilledLiters ?? 0) + (fact.fuel ?? 0);
      row.missingReadings = (row.missingReadings ?? 0) + (fact.missing ? 1 : 0);
      row.shifts = (row.shifts ?? 0) + 1;
      row.unacceptedShifts = (row.unacceptedShifts ?? 0) + 1;
      expected.set(monthOf(date), row);
    }

    const months = await monthsOf(vehicle, days[0]!, days[4]!);
    expect([...months.keys()].sort()).toEqual([...expected.keys()].sort());
    // Помесячная выгрузка и карточка отвечают одним числом: два ответа на «сколько проехали в
    // августе» — ровно то, чего план избегает.
    expect(new Map(card!.months.map((row) => [row.month, row]))).toEqual(months);
    for (const [month, row] of expected) {
      expect([month, months.get(month)]).toEqual([month, expect.objectContaining(row)]);
    }
  });

  it('пара с предшественником за границей периода не считается нигде', async () => {
    const person = await newPerson('Пограничный');
    const vehicle = await newVehicle();
    const days = series(ago(4), 3);

    for (const [index, date] of days.entries()) {
      await newRoute(vehicle, date, person);
      await reportDay(person, date, values({ odometerKm: [1000, 1150, 1400][index]! }));
    }

    expect(await cardOf(vehicle, days[0]!, days[2]!)).toMatchObject({ total: { distanceKm: 400 } });

    // Предшественник первого снимка периода остался снаружи, и его разность отвечала бы за работу,
    // сделанную до начала периода. Самоджойн идёт по набору, а не по таблице (Р32г) ровно ради
    // этого: соединение с `vehicle_readings` молча притянуло бы соседа из-за границы.
    const card = await cardOf(vehicle, days[1]!, days[2]!);
    expect(card!.total).toMatchObject({ distanceKm: 250, shifts: 2 });
    // «Нигде» — это и месяцы тоже: спрятать лишние 150 км в первом месяце периода запрещено ровно
    // так же, как показать их в итоге.
    for (const key of TOTAL_KEYS) {
      expect([key, foldMonths(card!.months, key)]).toEqual([key, round3(card!.total[key])]);
    }
  });

  it('сброс счётчика выбывает из пробега и рвёт только свою цепочку', async () => {
    const person = await newPerson('Сбросов');
    const vehicle = await newVehicle();
    const days = series(ago(7), 2);

    for (const [index, date] of days.entries()) {
      await newRoute(vehicle, date, person);
      await reportDay(
        person,
        date,
        values({ odometerKm: [5000, 10][index]!, engineHours: [10, 20][index]! }),
      );
    }

    const card = await cardOf(vehicle, days[0]!, days[1]!);
    // Единственная пара одометра — со сброшенным счётчиком, и в сумму она не идёт: ноль означал бы
    // «машина стояла», тогда как известно ровно обратное. Моточасы при этом считаются как ни в чём
    // не бывало: цепочки счётчиков независимы (Р28), и один сброс не смеет обнулять обе.
    expect(card!.total).toMatchObject({
      distanceKm: null,
      engineHours: 10,
      odometerGaps: 1,
      engineHoursGaps: 0,
    });
  });

  it('аннулированный отчёт чисел не даёт, а его смену портал по-прежнему ждёт', async () => {
    const person = await newPerson('Аннулиров');
    const vehicle = await newVehicle();
    const date = ago(9);
    await newRoute(vehicle, date, person);

    const opened = await report(person, date);
    await submit(person, date, [
      line(opened.items[0]!.id, values({ odometerKm: 300, fuelFilledLiters: 40 })),
    ]);
    expect((await cardOf(vehicle, date, date))!.total).toMatchObject({
      fuelFilledLiters: 40,
      missingReadings: 0,
      shifts: 1,
    });

    // Состояние ставится прямой правкой шапки: через сервис в `voided` уходит опустевший отчёт —
    // перенос уносит строки вместе с показаниями. Проверяется здесь ровно отбор по состоянию, и он
    // обязан стоять в `observed` (INNER JOIN), а не условием LEFT JOIN: во втором случае строка
    // осталась бы с пустым состоянием и её показание попало бы и в суммы, и в качество данных.
    await ctx.db
      .update(ctx.schema.driverDailyReports)
      .set({ state: 'voided' })
      .where(eq(ctx.schema.driverDailyReports.id, opened.id));

    const card = await cardOf(vehicle, date, date);
    // Рейс с листом жив, значит смену этого дня по-прежнему ждут: `shifts` не уменьшился, а
    // показаний по ней теперь нет — и об этом говорит выросший `missingReadings` (Р26в).
    expect(card!.total).toMatchObject({
      distanceKm: null,
      fuelFilledLiters: 0,
      missingReadings: 1,
      shifts: 1,
      unacceptedShifts: 1,
    });
  });

  it('день, который никто не открывал, — ожидаемая смена без показаний, и машина в сводке есть', async () => {
    const person = await newPerson('Неоткрытый');
    const vehicle = await newVehicle();
    const date = ago(11);
    await newRoute(vehicle, date, person);
    // `openReport` не зовётся намеренно: водителя без учётки день ждёт ровно так же, а строк
    // ожидания у него нет вовсе. Посчитанное по `driver_daily_report_items` качество данных дало бы
    // здесь ноль — и статистика уверяла бы, что данные полные (Р26в).

    const card = await cardOf(vehicle, date, date);
    expect(card).not.toBeNull();
    expect(card!.total).toMatchObject({
      distanceKm: null,
      fuelFilledLiters: 0,
      missingReadings: 1,
      shifts: 1,
      unacceptedShifts: 1,
    });
    // Состав списка — тоже следствие Р26в: машина с ожидаемым источником стоит в сводке, даже если
    // отчёта у неё нет. Иначе гараж звал бы сдать показания по машине, которой в статистике нет.
    expect(await fleetRowOf(vehicle, date, date)).not.toBeNull();
  });

  it('принятый день выбывает из непринятых смен, оставаясь сменой', async () => {
    const person = await newPerson('Принятый');
    const vehicle = await newVehicle();
    const date = ago(12);
    await newRoute(vehicle, date, person);

    const opened = await report(person, date);
    const sent = await submit(person, date, [
      line(opened.items[0]!.id, values({ odometerKm: 500, fuelFilledLiters: 15 })),
    ]);
    expect((await cardOf(vehicle, date, date))!.total).toMatchObject({ unacceptedShifts: 1 });

    const accepted = await ctx.service.acceptReport(sent.id, sent.version, ctx.adminId);
    expect(accepted.state).toBe('accepted');

    // Приёмка меняет качество данных, а не сами данные (Р27): статистика оперативная, и литры
    // принятого дня те же, что были до приёмки. Числом рядом с итогом остаётся ноль непринятых —
    // ради него `unacceptedShifts` и заведён, и «всё принято» обязано быть отличимо от «нечего
    // принимать».
    expect((await cardOf(vehicle, date, date))!.total).toMatchObject({
      fuelFilledLiters: 15,
      missingReadings: 0,
      shifts: 1,
      unacceptedShifts: 0,
    });
  });

  it('перенос рейса уносит ожидание на новую дату, а число остаётся в месяце своей', async () => {
    const person = await newPerson('Перенесённый');
    const vehicle = await newVehicle();
    const [before, after] = daysAcrossMonth(2, 1);
    const routeId = await newRoute(vehicle, before!, person);
    await reportDay(person, before!, values({ odometerKm: 1000, fuelFilledLiters: 40 }));

    const start = await monthsOf(vehicle, before!, after!);
    expect(start.get(monthOf(before!))).toMatchObject({ fuelFilledLiters: 40, missingReadings: 0 });

    // Диспетчер перенёс рейс на следующий день уже после того, как показание сдали, — вместе с
    // листом (ADR 0101). Строка ожидания при этом осталась на исходной дате: снимочная координата
    // показания и живая координата источника разошлись (Р32).
    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ routeDate: after! })
      .where(eq(ctx.schema.vehicleRoutes.id, routeId));
    await ctx.db
      .update(ctx.schema.waybills)
      .set({ issuedForDate: after! })
      .where(eq(ctx.schema.waybills.routeId, routeId));

    const months = await monthsOf(vehicle, before!, after!);
    // Первое: число никуда не уехало. `coalesce(i.report_date, e.date)` свернул бы координаты в
    // одну и утащил бы литры в чужой месяц — их сдали за тот день, за который сдали.
    expect(months.get(monthOf(before!))).toMatchObject({ fuelFilledLiters: 40 });
    // Второе и третье: на новой дате появилась ожидаемая смена, и показания по ней нет. Признак
    // соответствия координат (Р32а) существует ровно ради третьего: без него строка по этому же
    // рейсу подавила бы `missing`, и требование сдать показание исчезло бы вместе с переносом.
    expect(months.get(monthOf(after!))).toMatchObject({ shifts: 1, missingReadings: 1 });
    // Четвёртое: машина видна в обоих месяцах — данные не потерялись, а ожидание не пропало.
    expect([...months.keys()].sort()).toEqual([monthOf(before!), monthOf(after!)].sort());
  });

  it('рейс без выписанного путевого листа ожидаемой сменой не является', async () => {
    const person = await newPerson('Бездокументный');
    const vehicle = await newVehicle();
    const date = ago(13);
    await newRoute(vehicle, date, person, { documented: false });

    // Правило кабинета (ADR 0105, Р5; Р26а): рейс без действующего листа на этого водителя заданием
    // не является — водитель его у себя даже не видит. Строк ожидания у дня поэтому нет.
    const opened = await report(person, date);
    expect(opened.items).toEqual([]);

    // И статистика обязана отвечать тем же: иначе портал требовал бы показаний по рейсам, которых
    // он сам водителю не показывает.
    expect((await cardOf(vehicle, date, date))?.total.shifts ?? 0).toBe(0);
    expect(await fleetRowOf(vehicle, date, date)).toBeNull();
  });
});
