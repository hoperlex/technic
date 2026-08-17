import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type ReadingInput,
  type ReportItemSubmit,
  type VehicleReadingStatsRow,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';
import type * as AggregateNs from '../src/services/readings-aggregate';

/**
 * Числа сводки по парку, снятые сверкой при замене прежней формулы агрегатом (план «Показания
 * техники», §5).
 *
 * Откуда файл. Сводку считала `loadFleetReadingStats` (`services/readings-stats.ts`) — проходом по
 * цепочке в памяти; теперь её считает `loadFleetStats` (`services/readings-aggregate.ts`) — одним
 * запросом с полным внешним объединением двух координат смены. Перед заменой обе функции были
 * прогнаны **на этих самых данных** и сверены по четырём числам каждой машины: `distanceKm`,
 * `engineHours`, `fuelFilledLiters` и `gaps`. Числа ниже — их общий ответ; он же и остаётся
 * ожиданием, потому что прежняя функция удалена (§5: два ответа на «сколько проехала машина» плану
 * противопоказаны), и сравнивать теперь не с чем.
 *
 * Почему файл не удалён вместе со сверкой. Главное из четырёх чисел — `gaps`: колонка живёт на
 * экране с подписью «Сброшенный счётчик или смена без показания: на них ряд рвётся», считается своим
 * счётчиком (Р28а), и ни один другой тест её не проверяет. Расхождение со «суммой трёх» здесь
 * двустороннее, и оба его конца стоят сценариями: несданная смена (сумма разрывов счётчиков дала бы
 * ноль) и сброс обоих счётчиков сразу (дала бы два).
 *
 * Чего в файле нет и быть не может. Сравнения составов списков: прежняя сводка показывала машины по
 * строкам ожидания, агрегат — по ожидаемым сменам (Р26в), поэтому машина, чей день никто не
 * открывал, есть только у второго. Это и есть смысл замены; сверка показала расхождение состава
 * ровно на ней одной, и утверждение о ней стоит своим.
 *
 * Данные заводятся сервисами модуля (`openReport`/`submitReport`), рейсами и выписанными по ним
 * листами, а не вставками в `driver_daily_report_items` и `vehicle_readings`: сводка читает то,
 * что собрал модуль показаний, и подменять его тут значило бы проверять формулу на данных,
 * которых модуль никогда не создаёт.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/readings-aggregate-parity.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-readings-parity-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/**
 * Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам».
 * Метка своя на прогон — второй экземпляр файла рядом (полный `vitest run` разработчика) с общей
 * меткой унёс бы машины из-под живого теста.
 */
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: сверка сводок показаний';
const MARK = `${MARK_PREFIX} ${randomUUID().slice(0, 8)}`;
/** Номера бланков — из заведомо свободного диапазона, свой блок на прогон (см. `readings-stats`). */
const WAYBILL_NUMBER_BASE = 930_000_000 + Math.floor(Math.random() * 900) * 1_000;

const TODAY = moscowDateKeyOf(new Date());

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

/** Машины сценариев: имя сценария → идентификатор. Сверка идёт по ним, а не по всему парку. */
const fleet = new Map<string, string>();

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
      middleName: 'Сверочный',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/**
 * День от сегодняшнего назад. Весь отрезок сценариев умещается в окно записи персонала
 * (`STAFF_SUBMIT_PAST_DAYS` = 30 дней), иначе первый же `openReport` ответил бы отказом окна.
 */
function ago(days: number): string {
  return shiftDateKey(TODAY, -days);
}

// ── Фикстуры ──

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Сверкин', firstName, middleName: 'Тестович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

/** Своя машина: у собственной описание пустое и цен нет — этого требует `vehicles_own_fields_check`. */
async function newVehicle(name: string): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({ ownership: 'own', vehicleTypeId: ctx.typeId, status: 'active', note: MARK })
    .returning({ id: ctx.schema.vehicles.id });
  fleet.set(name, vehicle!.id);
  return vehicle!.id;
}

/** Заявка-пустышка: рейсу-перегону она основание, недельному листу — источник (обе колонки NOT NULL). */
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
): Promise<void> {
  waybillNo += 1;
  await ctx.db.insert(ctx.schema.waybills).values({
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
  });
}

/**
 * Рейс-перегон с выписанным по нему листом: кабинет строго документален (ADR 0105, Р5), и рейс без
 * действующего листа строки ожидания не даёт — а без неё сверять нечего.
 */
async function newRoute(vehicleId: string, date: string, personId: string): Promise<string> {
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
  await issueWaybillFor(route!.id, vehicleId, personId, date);
  return route!.id;
}

/** Действующий недельный лист ЭСМ-2, накрывающий день: неделя целиком, от понедельника. */
async function newEsm2(vehicleId: string, personId: string, date: string): Promise<void> {
  waybillNo += 1;
  const from = weekStartKey(date);
  await ctx.db.insert(ctx.schema.waybills).values({
    seriesId: ctx.seriesId,
    number: WAYBILL_NUMBER_BASE + waybillNo,
    formCode: 'esm2',
    status: 'issued',
    organizationId: ctx.organizationId,
    vehicleId,
    driverPersonId: personId,
    issuedForDate: from,
    sourceRequestId: await newRequest(),
    periodFrom: from,
    periodTo: shiftDateKey(from, 6),
    issuedBy: ctx.adminId,
  });
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

function noData(): ReadingInput {
  return { kind: 'no_data', noDataReason: 'счётчик разбит', comment: '' };
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
 * Весь ввод идёт «за водителя» (`mode: 'staff'`): часть дней отрезка старше водительского окна
 * записи, и сам водитель их не закрыл бы. На сравниваемые числа режим не влияет — он виден только
 * в `source` показания.
 */
const STAFF = { mode: 'staff' as const };

async function report(personId: string, date: string) {
  return ctx.service.openReport(personId, date, ctx.adminId, STAFF);
}

async function submit(personId: string, date: string, items: ReportItemSubmit[]): Promise<void> {
  const current = await ctx.service.loadReport(personId, date);
  await ctx.service.submitReport(
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

// ── Сверка ──

/** Что именно сверялось: четыре числа строки сводки. Подпись машины обе брали из `vehicleLabel`. */
function numbersOf(row: VehicleReadingStatsRow) {
  return {
    distanceKm: row.distanceKm,
    engineHours: row.engineHours,
    fuelFilledLiters: row.fuelFilledLiters,
    gaps: row.gaps,
  };
}

/** Сводка за период, свои машины в ней — по имени сценария. */
async function summary(from: string, to: string): Promise<Map<string, VehicleReadingStatsRow>> {
  const byId = new Map((await ctx.aggregate.loadFleetStats(from, to)).map((r) => [r.vehicleId, r]));
  const named = new Map<string, VehicleReadingStatsRow>();
  for (const [name, vehicleId] of fleet) {
    const row = byId.get(vehicleId);
    if (row) named.set(name, row);
  }
  return named;
}

describe.skipIf(!DB_URL)('сводка показаний: агрегат отвечает то же, что прежняя формула', () => {
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

    // ── Пять сценариев сверки плюс машина, которой в старой сводке нет ──

    // 1. Обычная цепочка: три снимка подряд, разрывов нет вовсе.
    {
      const person = await newPerson('Цепочкин');
      const vehicle = await newVehicle('цепочка');
      const days = [ago(4), ago(3), ago(2)];
      const odometer = [1000, 1150, 1400];
      const hours = [10, 12.5, 15];
      const fuel = [50, null, 30];
      for (const [i, date] of days.entries()) {
        await newRoute(vehicle, date, person);
        await reportDay(
          person,
          date,
          values({ odometerKm: odometer[i]!, engineHours: hours[i]!, fuelFilledLiters: fuel[i]! }),
        );
      }
    }

    // 2. Несданная смена посреди ряда: строка ожидания есть, показания по ней нет вовсе. Обе
    //    формулы обязаны назвать её разрывом — у новой это ровно тот случай, который сумма
    //    `odometerGaps + engineHoursGaps` теряет: сброса счётчика тут нет ни одного.
    {
      const person = await newPerson('Несдавший');
      const vehicle = await newVehicle('несданная смена');
      const [first, skipped, last] = [ago(7), ago(6), ago(5)];
      await newRoute(vehicle, first, person);
      await reportDay(person, first, values({ odometerKm: 2000, engineHours: 20 }));
      await newRoute(vehicle, skipped, person);
      await report(person, skipped); // день открыт, показание не сдано
      await newRoute(vehicle, last, person);
      await reportDay(person, last, values({ odometerKm: 2300, engineHours: 26 }));
    }

    // 3. `no_data` посреди ряда: «работали, но снять нечего» — закрытие строки, а не пропуск, и
    //    цепочка назначает предшественником последний снимок с числом.
    {
      const person = await newPerson('Безданных');
      const vehicle = await newVehicle('no_data');
      const days = [ago(10), ago(9), ago(8)];
      const readings = [values({ odometerKm: 3000 }), noData(), values({ odometerKm: 3400 })];
      for (const [i, date] of days.entries()) {
        await newRoute(vehicle, date, person);
        await reportDay(person, date, readings[i]!);
      }
    }

    // 4. Сброс ОБОИХ счётчиков в одной строке — вторая половина расхождения двух формул: строка
    //    одна, а счётчиков на ней два, и сумма разрывов посчитала бы её дважды.
    {
      const person = await newPerson('Сбросов');
      const vehicle = await newVehicle('сброс обоих счётчиков');
      const days = [ago(13), ago(12), ago(11)];
      const odometer = [9000, 5, 200];
      const hours = [100, 1, 4];
      for (const [i, date] of days.entries()) {
        await newRoute(vehicle, date, person);
        await reportDay(person, date, values({ odometerKm: odometer[i]!, engineHours: hours[i]! }));
      }
    }

    // 5. Две смены в один день: рейс и недельный ЭСМ-2 дают две строки ожидания одного дня, и
    //    разность между ними — пара внутри дня. Порядок ряда — `(день, позиция смены)`, и у двух
    //    формул он обязан совпасть.
    {
      const person = await newPerson('Двусменный');
      const vehicle = await newVehicle('две смены в день');
      const date = ago(15);
      await newEsm2(vehicle, person, date);
      await newRoute(vehicle, date, person);
      const opened = await report(person, date);
      expect(opened.items).toHaveLength(2);
      await submit(person, date, [
        line(opened.items[0]!.id, values({ odometerKm: 500, fuelFilledLiters: 20 })),
        line(opened.items[1]!.id, values({ odometerKm: 560, fuelFilledLiters: 10 })),
      ]);
    }

    // 6. Машина, чей день никто не открывал: строк ожидания у неё нет, а смена была. Она есть
    //    только в новой сводке (Р26в) — и это законное различие состава, а не расхождение.
    {
      const person = await newPerson('Неоткрытый');
      const vehicle = await newVehicle('день не открывали');
      await newRoute(vehicle, ago(16), person);
    }
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await purge(ctx.db, MARK);
      await ctx.closeDb();
    }
  });

  it('четыре числа сводки — те же, что давала прежняя формула', async () => {
    const rows = await summary(ago(16), ago(2));

    // Состав сверяемого — целиком: сверка, где сравнивать нечего, зеленела бы всегда. Шестая
    // машина («день не открывали») стоит отдельным утверждением ниже: строк ожидания у неё нет, и
    // прежняя сводка её не показывала вовсе.
    expect([...rows.keys()].sort()).toEqual(
      [
        'no_data',
        'день не открывали',
        'две смены в день',
        'несданная смена',
        'сброс обоих счётчиков',
        'цепочка',
      ].sort(),
    );

    // Разрывов нет; 150 + 250 и 2,5 + 2,5; литры — простая сумма.
    expect(numbersOf(rows.get('цепочка')!)).toEqual({
      distanceKm: 400,
      engineHours: 5,
      fuelFilledLiters: 80,
      gaps: 0,
    });
    // Несданная смена пару не рвёт — предшественником цепочка назначает последний снимок с числом,
    // и разность накрывает пропуск целиком, — но разрывом ряда считается: 2300 − 2000 и 26 − 20 при
    // одном разрыве. Это первая половина расхождения со «суммой трёх»: счётчик не сбрасывался ни
    // разу, и сумма разрывов счётчиков дала бы здесь ноль.
    expect(numbersOf(rows.get('несданная смена')!)).toEqual({
      distanceKm: 300,
      engineHours: 6,
      fuelFilledLiters: 0,
      gaps: 1,
    });
    // `no_data` — то же самое: строка закрыта ответом «снять нечего», ряд на ней рвётся.
    expect(numbersOf(rows.get('no_data')!)).toEqual({
      distanceKm: 400,
      engineHours: null,
      fuelFilledLiters: 0,
      gaps: 1,
    });
    // Пара со сбросом в сумму не идёт (её разность заведомо неверна), следующая считается как ни в
    // чём не бывало: 200 − 5 и 4 − 1. Разрыв при этом ОДИН, хотя сброшены оба счётчика, — вторая
    // половина расхождения со «суммой трёх».
    expect(numbersOf(rows.get('сброс обоих счётчиков')!)).toEqual({
      distanceKm: 195,
      engineHours: 3,
      fuelFilledLiters: 0,
      gaps: 1,
    });
    // Две смены одного дня — обычная пара ряда: порядок в цепочке `(день, позиция смены)`.
    expect(numbersOf(rows.get('две смены в день')!)).toEqual({
      distanceKm: 60,
      engineHours: null,
      fuelFilledLiters: 30,
      gaps: 0,
    });
  });

  it('сводная колонка разрывов — не сумма трёх раздельных чисел (Р28а)', async () => {
    // Ровно то, ради чего сводный счётчик заведён своим. У машины со сбросом обоих счётчиков сумма
    // `odometerGaps + engineHoursGaps` вдвое больше сводной колонки: строка одна, а счётчиков на
    // ней два. У несданной смены — наоборот: сводная колонка её считает, а оба раздельных числа
    // молчат, потому что ни один счётчик не сбрасывался. Расхождение двустороннее, и подпись
    // колонки на экране («Сброшенный счётчик или смена без показания») — про строки, а не счётчики.
    const reset = await ctx.aggregate.loadVehicleCard(
      fleet.get('сброс обоих счётчиков')!,
      ago(16),
      ago(2),
    );
    expect(reset!.total).toMatchObject({ odometerGaps: 1, engineHoursGaps: 1 });

    const missed = await ctx.aggregate.loadVehicleCard(
      fleet.get('несданная смена')!,
      ago(16),
      ago(2),
    );
    expect(missed!.total).toMatchObject({
      odometerGaps: 0,
      engineHoursGaps: 0,
      missingReadings: 1,
    });

    const rows = await summary(ago(16), ago(2));
    expect(rows.get('сброс обоих счётчиков')!.gaps).toBe(1);
    expect(rows.get('несданная смена')!.gaps).toBe(1);
  });

  it('машина, чей день никто не открывал, в сводке есть — прежняя её не показывала', async () => {
    const rows = await summary(ago(16), ago(2));

    // Единственное место, где ответы двух формул расходились законно (Р26в), и расходились
    // односторонне: строк ожидания у машины нет, а смена была. Сверка это показала на живых
    // данных — прежняя сводка знала пять машин из шести.
    const row = rows.get('день не открывали');
    expect(row).toBeDefined();
    // Чисел по ней нет и быть не может: показаний никто не передавал. Разрывом ряда несданная
    // смена становится, только если строка ожидания у неё есть, — поэтому здесь ноль, а про саму
    // смену отвечает `missingReadings` карточки.
    expect(numbersOf(row!)).toEqual({
      distanceKm: null,
      engineHours: null,
      fuelFilledLiters: 0,
      gaps: 0,
    });
    const card = await ctx.aggregate.loadVehicleCard(
      fleet.get('день не открывали')!,
      ago(16),
      ago(2),
    );
    expect(card!.total).toMatchObject({ shifts: 1, missingReadings: 1, unacceptedShifts: 1 });
  });

  it('правило «обе точки пары внутри периода» — то же, что было', async () => {
    // Хвост цепочки: предшественник первого снимка периода остался за границей, и его разность
    // отвечала бы за работу, сделанную до начала периода. Прежняя сводка держала это картой `byId`
    // в памяти, агрегат — самоджойном по набору (Р32г), и ответ у них один.
    const rows = await summary(ago(3), ago(2));
    expect(numbersOf(rows.get('цепочка')!)).toEqual({
      distanceKm: 250,
      engineHours: 2.5,
      fuelFilledLiters: 30,
      gaps: 0,
    });
  });
});
