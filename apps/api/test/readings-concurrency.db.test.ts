import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type DriverReportDto,
  type ReadingInput,
  type ReportItemSubmit,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';

/**
 * Сериализация модуля показаний (ADR 0103, план `docs/driver-portal-plan.md`, этап 4: Р20, Р24,
 * Р25): встречные отправки, перестройка цепочек, перестановка позиций смен и идемпотентность.
 *
 * Зачем база. Проверять тут нечего на подменах — предмет теста и есть база: два водителя одной
 * машины ведут **разные отчёты**, и версия отчёта их не сериализует; между встречными операциями
 * стоит только порядок блокировок (`FOR UPDATE` по машине) и отложенное `report_items_chain_key`.
 * Ошибка здесь не даёт исключения: она даёт развилку в цепочке счётчика — две строки с одним
 * предшественником, — и учётные разности начинают считаться не с тем снимком. Увидеть это можно
 * только на настоящих транзакциях настоящей СУБД.
 *
 * Тесты зовут сервис (`openReport`/`submitReport`/`reorderShifts`/`resolveDiscrepancy`); прямой
 * SQL идёт только на подготовку фикстур и на чтение колонок цепочки, которых в DTO нет.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/readings-concurrency.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-readings-concurrency-admin@example.invalid';
/** Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам». */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: сериализация показаний';

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof ReadingsNs;
  closeDb: () => Promise<void>;
  adminId: string;
  objectId: string;
  typeId: string;
  today: string;
  /** Общая машина двух водителей: на ней проверяются развилка цепочки и перестановка смен. */
  shared: { vehicleId: string; first: string; second: string };
}

let ctx: Ctx;

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

/**
 * Уборка своих данных — и перед прогоном тоже: упавший прогон оставляет отчёты, а их показания
 * молча стали бы предшественниками в ряду следующего.
 *
 * Порядок обратный ссылкам и обязателен: показания держат машину и работника `RESTRICT`'ом (ADR
 * 0103) — учётный факт не исчезает вместе со справочной строкой, — а рейсы держат машину. Поэтому
 * сначала отчёты (за ними каскадом строки ожидания, показания и обе истории), затем рейсы, заявки,
 * машины и люди. Рейсы ищутся и по метке машины: их мог завести прежний прогон под другой учёткой.
 */
async function cleanup(db: typeof AppDb): Promise<void> {
  const persons = sql`(SELECT id FROM persons WHERE comment = ${MARK})`;
  const vehicles = sql`(SELECT id FROM vehicles WHERE note = ${MARK})`;
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE person_id IN ${persons}`);
  await db.execute(
    sql`DELETE FROM waybills WHERE driver_person_id IN ${persons} OR vehicle_id IN ${vehicles}`,
  );
  await db.execute(
    sql`DELETE FROM vehicle_routes WHERE driver_person_id IN ${persons} OR vehicle_id IN ${vehicles}`,
  );
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${MARK}`);
  await db.execute(sql`DELETE FROM vehicles WHERE note = ${MARK}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${MARK}`);
}

async function seedAdmin(db: typeof AppDb, schema: typeof SchemaNs): Promise<string> {
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
      firstName: 'Диспетчер',
      middleName: 'Цепочный',
      // Входа здесь нет: тест зовёт сервисы напрямую, пароль не участвует.
      passwordHash: 'db-test-not-a-hash',
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Цепочкин', firstName, middleName: 'Тестович', comment: MARK })
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

/** Заявка-пустышка: рейсу-перегону она основание (`vehicle_routes_source_request_check`). */
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

/**
 * Рейс-перегон: он виден в задании всегда, тогда как грузовой пропадает, оставшись без живых
 * заявок состава, — а тесту нужен источник, а не проверка отбора заданий.
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

/** Открыть день и сразу закрыть его единственную строку — четыре строки на каждый сценарий иначе. */
async function submitDay(
  personId: string,
  date: string,
  reading: ReadingInput,
): Promise<DriverReportDto> {
  const opened = await ctx.service.openReport(personId, date, ctx.adminId, { mode: 'staff' });
  return ctx.service.submitReport(
    personId,
    date,
    { version: opened.version, items: [line(opened.items[0]!.id, reading)], reason: '' },
    ctx.adminId,
    null,
    { mode: 'staff' },
  );
}

/** Строки показаний машины в порядке самой цепочки — `(report_date, shift_order)`. */
async function chainOf(vehicleId: string) {
  return ctx.db
    .select()
    .from(ctx.schema.vehicleReadings)
    .where(eq(ctx.schema.vehicleReadings.vehicleId, vehicleId))
    .orderBy(
      asc(ctx.schema.vehicleReadings.reportDate),
      asc(ctx.schema.vehicleReadings.shiftOrder),
    );
}

/** Позиции смен машины за день: их двигает перестановка и не двигает поздняя вставка. */
async function shiftOrdersOf(vehicleId: string, date: string): Promise<Record<string, number>> {
  const rows = await ctx.db
    .select({
      id: ctx.schema.driverDailyReportItems.id,
      shiftOrder: ctx.schema.driverDailyReportItems.shiftOrder,
    })
    .from(ctx.schema.driverDailyReportItems)
    .where(
      and(
        eq(ctx.schema.driverDailyReportItems.vehicleId, vehicleId),
        eq(ctx.schema.driverDailyReportItems.reportDate, date),
      ),
    );
  return Object.fromEntries(rows.map((row) => [row.id, row.shiftOrder]));
}

async function reportEvents(reportId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ event: ctx.schema.driverDailyReportHistory.event })
    .from(ctx.schema.driverDailyReportHistory)
    .where(eq(ctx.schema.driverDailyReportHistory.reportId, reportId))
    .orderBy(asc(ctx.schema.driverDailyReportHistory.changedAt));
  return rows.map((row) => row.event);
}

async function readingEvents(readingId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ event: ctx.schema.vehicleReadingHistory.event })
    .from(ctx.schema.vehicleReadingHistory)
    .where(eq(ctx.schema.vehicleReadingHistory.readingId, readingId))
    .orderBy(asc(ctx.schema.vehicleReadingHistory.version));
  return rows.map((row) => row.event);
}

describe.skipIf(!DB_URL)('показания: сериализация, цепочки и идемпотентность (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/readings');
    await cleanup(db);

    const adminId = await seedAdmin(db, schema);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const types = await db.execute<{ id: string }>(
      sql`SELECT vt.id FROM vehicle_types vt
          JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          WHERE vk.code = 'freight_transport' ORDER BY vt.code LIMIT 1`,
    );
    if (!objects.rows[0] || !types.rows[0]) throw new Error('В базе нет объекта или типа ТС');

    ctx = {
      db,
      schema,
      service,
      closeDb,
      adminId,
      objectId: objects.rows[0].id,
      typeId: types.rows[0].id,
      today: moscowDateKeyOf(new Date()),
      shared: { vehicleId: '', first: '', second: '' },
    };
    ctx.shared = {
      vehicleId: await newVehicle(),
      first: await newPerson('Первосменный'),
      second: await newPerson('Второсменный'),
    };
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await cleanup(ctx.db);
      await ctx.closeDb();
    }
  });

  /**
   * Главное утверждение этапа. Два водителя одной машины ведут разные отчёты, и версия отчёта их
   * не сериализует: единственное, что стоит между их отправками, — блокировка машины. Отправки
   * идут навстречу друг другу намеренно, и порядок фиксации ролей не играет: у кого бы транзакция
   * ни закоммитилась первой, вторая обязана перестроить соседа, а не встать рядом с ним.
   */
  it('встречные отправки двух работников по одной машине оставляют цепочку линейной', async () => {
    const { vehicleId, first, second } = ctx.shared;
    await newRoute(vehicleId, ctx.today, first);
    await newRoute(vehicleId, ctx.today, second);

    const openedFirst = await ctx.service.openReport(first, ctx.today, ctx.adminId, {
      mode: 'staff',
    });
    const openedSecond = await ctx.service.openReport(second, ctx.today, ctx.adminId, {
      mode: 'staff',
    });
    // Позиция смены одна на машину, день и место (`report_items_chain_key`): второй водитель
    // встаёт следом за первым, а не рядом.
    expect(openedFirst.items[0]!.shiftOrder).toBe(1);
    expect(openedSecond.items[0]!.shiftOrder).toBe(2);

    const [sentFirst, sentSecond] = await Promise.all([
      ctx.service.submitReport(
        first,
        ctx.today,
        {
          version: openedFirst.version,
          items: [line(openedFirst.items[0]!.id, values({ odometerKm: 1000 }))],
          reason: '',
        },
        ctx.adminId,
        null,
        { mode: 'staff' },
      ),
      ctx.service.submitReport(
        second,
        ctx.today,
        {
          version: openedSecond.version,
          items: [line(openedSecond.items[0]!.id, values({ odometerKm: 1200 }))],
          reason: '',
        },
        ctx.adminId,
        null,
        { mode: 'staff' },
      ),
    ]);
    expect(sentFirst.state).toBe('submitted');
    expect(sentSecond.state).toBe('submitted');

    const chain = await chainOf(vehicleId);
    expect(chain).toHaveLength(2);
    // Ряд линеен: начало ряда без предшественника, вторая смена — следом за первой.
    expect(chain[0]!.previousOdometerId).toBeNull();
    expect(chain[1]!.previousOdometerId).toBe(chain[0]!.id);
    // И ни одной развилки: два показания с общим предшественником означали бы, что вторая
    // отправка посчитала разность по снимку, которого уже не существует.
    const parents = chain.map((row) => row.previousOdometerId).filter((id) => id !== null);
    expect(new Set(parents).size).toBe(parents.length);

    // Разность спрашивается перечитыванием, а не берётся из ответа отправки, и это свойство
    // операции, а не удобство теста: ответ описывает момент СВОЕЙ фиксации, а соседа по ряду
    // перестраивает та транзакция, которая закоммитилась второй. Закоммитившийся первым увидел бы
    // у себя `null` — и был бы прав на тот момент.
    const settled = await ctx.service.loadReport(second, ctx.today);
    // d = 0 у двух смен одного дня, и `max(1, d)` даёт им нормальные сутки на двоих (Р20).
    expect(settled!.items[0]!.reading!.odometerDelta).toBe(200);
    expect(settled!.items[0]!.reading!.odometerAnomaly).toBeNull();
  });

  /**
   * То же утверждение, но в порядке, который встречные отправки дают лишь иногда: первая смена
   * сдана ПОСЛЕ второй. Планировщик такой порядок не гарантирует, а проверить его надо — здесь
   * работает не поиск предшественника при вставке, а перестройка уже существующего соседа, и
   * пропущенная перестройка оставила бы вторую смену началом ряда навсегда.
   */
  it('смена, сданная позже, но стоящая раньше, перестраивает соседа, а не встаёт рядом', async () => {
    const vehicleId = await newVehicle();
    const early = await newPerson('Ранний');
    const late = await newPerson('Поздний');
    await newRoute(vehicleId, ctx.today, early);
    await newRoute(vehicleId, ctx.today, late);

    const openedEarly = await ctx.service.openReport(early, ctx.today, ctx.adminId, {
      mode: 'staff',
    });
    const openedLate = await ctx.service.openReport(late, ctx.today, ctx.adminId, {
      mode: 'staff',
    });
    expect(openedEarly.items[0]!.shiftOrder).toBe(1);
    expect(openedLate.items[0]!.shiftOrder).toBe(2);

    // Вторая смена сдаётся первой: на этот момент она начало ряда — предшественника ещё нет.
    const sentLate = await ctx.service.submitReport(
      late,
      ctx.today,
      {
        version: openedLate.version,
        items: [line(openedLate.items[0]!.id, values({ odometerKm: 1200 }))],
        reason: '',
      },
      ctx.adminId,
      null,
      { mode: 'staff' },
    );
    expect(sentLate.items[0]!.reading!.odometerDelta).toBeNull();

    await ctx.service.submitReport(
      early,
      ctx.today,
      {
        version: openedEarly.version,
        items: [line(openedEarly.items[0]!.id, values({ odometerKm: 1000 }))],
        reason: '',
      },
      ctx.adminId,
      null,
      { mode: 'staff' },
    );

    const chain = await chainOf(vehicleId);
    expect(chain.map((row) => row.odometerKm)).toEqual([1000, 1200]);
    expect(chain[0]!.previousOdometerId).toBeNull();
    // Ссылка появилась у уже сохранённой строки — и появилась со следом в её истории: перестройка
    // цепочки меняет смысл разности не меньше, чем правка самого числа.
    expect(chain[1]!.previousOdometerId).toBe(chain[0]!.id);
    expect(await readingEvents(chain[1]!.id)).toEqual(['created', 'chain_relinked']);
    const reloaded = await ctx.service.loadReport(late, ctx.today);
    expect(reloaded!.items[0]!.reading!.odometerDelta).toBe(200);
  });

  /**
   * Преемник ищется по каждому счётчику отдельно (Р20): строка с одними моточасами ряда одометра
   * не разрывает и в нём не стоит вовсе. Между правленой строкой и её настоящим преемником такая
   * строка поставлена намеренно — «следующая строка по общему порядку» уткнулась бы в неё, и
   * учётная разность третьего дня осталась бы посчитанной по стёртому числу.
   */
  it('правка одометра перестраивает следующую строку с одометром, перешагнув строку с моточасами', async () => {
    const vehicleId = await newVehicle();
    const person = await newPerson('Промежуточный');
    const first = shiftDateKey(ctx.today, -4);
    const middle = shiftDateKey(ctx.today, -3);
    const last = shiftDateKey(ctx.today, -2);
    await newRoute(vehicleId, first, person);
    await newRoute(vehicleId, middle, person);
    await newRoute(vehicleId, last, person);

    const day1 = await submitDay(person, first, values({ odometerKm: 1000, engineHours: 100 }));
    // Средний день без одометра: прибор не сняли, а моточасы записали — законное состояние.
    const day2 = await submitDay(person, middle, values({ engineHours: 110 }));
    const day3 = await submitDay(person, last, values({ odometerKm: 1200, engineHours: 130 }));
    expect(day3.items[0]!.reading!.odometerDelta).toBe(200);
    expect(day3.items[0]!.reading!.odometerAnomaly).toBeNull();

    const middleBefore = (await chainOf(vehicleId)).find((row) => row.reportDate === middle)!;

    // Персонал правит сданное число — с причиной (Р19): 1000 было опечаткой, на приборе 5000.
    const corrected = await ctx.service.submitReport(
      person,
      first,
      {
        version: day1.version,
        items: [line(day1.items[0]!.id, values({ odometerKm: 5000, engineHours: 100 }))],
        reason: 'опечатка при вводе: на приборе 5000',
      },
      ctx.adminId,
      null,
      { mode: 'staff', reason: 'опечатка при вводе: на приборе 5000' },
    );
    expect(corrected.items[0]!.reading!.odometerKm).toBe(5000);

    const after = await ctx.service.loadReport(person, last);
    const lastReading = after!.items[0]!.reading!;
    // Третий день пересчитан по новому числу первого: 1200 < 5000 — счётчик «скручен».
    expect(lastReading.odometerAnomaly).toMatchObject({
      kind: 'counter_reset',
      confirmed: false,
      previousValue: 5000,
      previousDate: first,
    });
    expect(lastReading.odometerDelta).toBe(-3800);
    const chain = await chainOf(vehicleId);
    const day1Row = chain.find((row) => row.reportDate === first)!;
    const middleRow = chain.find((row) => row.reportDate === middle)!;
    const day3Row = chain.find((row) => row.reportDate === last)!;
    // Предшественник третьего дня — первый, а не средний: в ряду одометра среднего дня нет вовсе.
    expect(day3Row.previousOdometerId).toBe(day1Row.id);
    expect(middleRow.previousOdometerId).toBeNull();
    expect(await readingEvents(day3Row.id)).toEqual(['created', 'chain_relinked']);

    // Средняя строка не тронута ничем: её ряд моточасов правка одометра не касается.
    expect(middleRow.version).toBe(middleBefore.version);
    expect(middleRow.previousEngineHoursId).toBe(day1Row.id);
    expect(await readingEvents(middleRow.id)).toEqual(['created']);
    // И ряд моточасов третьего дня остался прежним: счётчики независимы (Р20).
    expect(day3Row.previousEngineHoursId).toBe(middleRow.id);
    expect(lastReading.engineHoursDelta).toBe(20);
    expect(lastReading.engineHoursAnomaly).toBeNull();
    expect(day2.items[0]!.reading!.engineHoursDelta).toBe(10);
  });

  /**
   * Перестановка позиций (Р24) — единственная операция модуля, которая трогает отчёты **двух**
   * водителей сразу. Одна транзакция здесь не удобство: `report_items_chain_key` сработало бы на
   * первом же `UPDATE`, поэтому проверка откладывается до конца транзакции, а промежуточное
   * состояние «две первые смены» законно.
   */
  it('перестановка смен идёт одной транзакцией и двигает историю обоих отчётов', async () => {
    const { vehicleId, first, second } = ctx.shared;
    const before = await Promise.all([
      ctx.service.loadReport(first, ctx.today),
      ctx.service.loadReport(second, ctx.today),
    ]);
    const [firstReport, secondReport] = before as [DriverReportDto, DriverReportDto];
    const firstItem = firstReport.items[0]!;
    const secondItem = secondReport.items[0]!;

    const result = await ctx.service.reorderShifts(
      {
        vehicleId,
        date: ctx.today,
        expectedOrder: [firstItem.id, secondItem.id],
        order: [
          { itemId: firstItem.id, shiftOrder: 2 },
          { itemId: secondItem.id, shiftOrder: 1 },
        ],
        reportVersions: {
          [firstReport.id]: firstReport.version,
          [secondReport.id]: secondReport.version,
        },
        reason: 'вторая смена выехала первой',
      },
      ctx.adminId,
    );

    // Отвечает операция обоими отчётами: перестановка — их общее изменение, и портал обновляет
    // оба, а не тот, по кнопке в котором её позвали.
    expect(result).toHaveLength(2);
    const byId = new Map(result.map((report) => [report.id, report]));
    expect(byId.get(firstReport.id)!.version).toBe(firstReport.version + 1);
    expect(byId.get(secondReport.id)!.version).toBe(secondReport.version + 1);
    expect(byId.get(firstReport.id)!.contentVersion).toBe(firstReport.contentVersion + 1);
    expect(byId.get(secondReport.id)!.contentVersion).toBe(secondReport.contentVersion + 1);
    expect(byId.get(firstReport.id)!.items[0]!.shiftOrder).toBe(2);
    expect(byId.get(secondReport.id)!.items[0]!.shiftOrder).toBe(1);

    // След остаётся в обеих историях: молча переставленная смена меняет чужие разности.
    expect(await reportEvents(firstReport.id)).toContain('shift_order_changed');
    expect(await reportEvents(secondReport.id)).toContain('shift_order_changed');

    // Цепочка перестроена по новому порядку: 1000 после 1200 — это «скручен счётчик».
    const chain = await chainOf(vehicleId);
    expect(chain.map((row) => row.odometerKm)).toEqual([1200, 1000]);
    expect(chain[0]!.previousOdometerId).toBeNull();
    expect(chain[1]!.previousOdometerId).toBe(chain[0]!.id);
    expect(chain[1]!.odometerAnomaly).toBe('counter_reset');
    expect(await readingEvents(chain[1]!.id)).toContain('chain_relinked');
  });

  it('перестановка с устаревшим порядком или устаревшей версией отчёта — конфликт', async () => {
    const { vehicleId, first, second } = ctx.shared;
    const firstReport = (await ctx.service.loadReport(first, ctx.today))!;
    const secondReport = (await ctx.service.loadReport(second, ctx.today))!;
    const firstItem = firstReport.items[0]!;
    const secondItem = secondReport.items[0]!;
    // Порядок после прошлой перестановки: вторая смена стоит первой.
    const current = [secondItem.id, firstItem.id];
    const swap = [
      { itemId: secondItem.id, shiftOrder: 2 },
      { itemId: firstItem.id, shiftOrder: 1 },
    ];
    const versions = {
      [firstReport.id]: firstReport.version,
      [secondReport.id]: secondReport.version,
    };

    // Ожидаемый порядок устарел: ровно так выглядит вторая вкладка диспетчера, открытая до чужой
    // перестановки. Без этой проверки она молча перезаписала бы чужое решение.
    await expect(
      ctx.service.reorderShifts(
        {
          vehicleId,
          date: ctx.today,
          expectedOrder: [firstItem.id, secondItem.id],
          order: swap,
          reportVersions: versions,
          reason: 'перестановка по устаревшему экрану',
        },
        ctx.adminId,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Версия отчёта устарела — тот же отказ, хотя порядок прислан правильный: версии сверяются у
    // ВСЕХ затронутых отчётов, а не только у того, чью строку двигают.
    await expect(
      ctx.service.reorderShifts(
        {
          vehicleId,
          date: ctx.today,
          expectedOrder: current,
          order: swap,
          reportVersions: { ...versions, [secondReport.id]: secondReport.version - 1 },
          reason: 'перестановка с устаревшей версией',
        },
        ctx.adminId,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Ни одна из двух попыток ничего не сдвинула: обе упали до записи.
    const orders = await shiftOrdersOf(vehicleId, ctx.today);
    expect(orders[secondItem.id]).toBe(1);
    expect(orders[firstItem.id]).toBe(2);
  });

  /**
   * Поздняя вставка (Р24): рейс, заведённый после отправки, добавляется в отчёт хвостом позиций.
   * Перенумеровать существующие нельзя — молчаливый сдвиг меняет разности, уже подтверждённые
   * человеком, и делает это в чужом отчёте: позиции у машины за день общие на всех её водителей.
   */
  it('поздняя строка встаёт в хвост порядка и не двигает существующие позиции', async () => {
    const { vehicleId, first, second } = ctx.shared;
    const before = await shiftOrdersOf(vehicleId, ctx.today);
    const lateRoute = await newRoute(vehicleId, ctx.today, first);

    const seen = await ctx.service.loadReport(first, ctx.today);
    const missing = seen!.discrepancies.find((d) => d.kind === 'missing_source')!;
    // Состав дня зафиксирован отправкой: заведённый после неё рейс — это расхождение, а не тихое
    // пополнение отчёта.
    expect(missing).toMatchObject({ sourceId: lateRoute, resolved: false });

    const added = await ctx.service.resolveDiscrepancy(
      seen!.id,
      {
        kind: 'missing_source',
        itemId: null,
        sourceKind: missing.sourceKind,
        sourceId: missing.sourceId,
        fingerprint: missing.fingerprint,
        resolution: 'source_added',
        reason: 'рейс всё-таки был: добавляем строку',
        version: seen!.version,
      },
      ctx.adminId,
    );

    const late = added.items.find((item) => item.sourceId === lateRoute)!;
    // Хвост считается по машине и дню целиком, а не по отчёту: у второго водителя первая позиция.
    expect(late.shiftOrder).toBe(3);
    const after = await shiftOrdersOf(vehicleId, ctx.today);
    for (const [itemId, shiftOrder] of Object.entries(before)) {
      expect(after[itemId]).toBe(shiftOrder);
    }
    expect(await ctx.service.loadReport(second, ctx.today)).toMatchObject({
      items: [{ shiftOrder: 1 }],
    });
  });

  /**
   * Идемпотентность — ключ **плюс** отпечаток тела (Р25). Ключ без отпечатка подтверждал бы под
   * старым ключом любую следующую команду, а отпечаток без ключа не отличал бы повтор от законной
   * второй правки теми же числами.
   */
  it('тот же ключ отправки: с тем же телом — повтор, с другим — конфликт', async () => {
    const vehicleId = await newVehicle();
    const person = await newPerson('Идемпотентный');
    await newRoute(vehicleId, ctx.today, person);
    const key = randomUUID();

    const opened = await ctx.service.openReport(person, ctx.today, ctx.adminId, { mode: 'staff' });
    const body = {
      version: opened.version,
      items: [line(opened.items[0]!.id, values({ odometerKm: 300 }))],
      reason: '',
    };
    const sent = await ctx.service.submitReport(person, ctx.today, body, ctx.adminId, key, {
      mode: 'staff',
    });
    expect(sent.state).toBe('submitted');

    // Повтор потерянного ответа: версия в теле заведомо устарела, и обычная оптимистическая
    // блокировка отвергла бы законный ретрай — поэтому ключ проверяется раньше версии.
    const repeated = await ctx.service.submitReport(person, ctx.today, body, ctx.adminId, key, {
      mode: 'staff',
    });
    expect(repeated.version).toBe(sent.version);
    expect(repeated.contentVersion).toBe(sent.contentVersion);
    expect(repeated.items[0]!.reading!.id).toBe(sent.items[0]!.reading!.id);
    // Ни второго показания, ни второй записи в истории: повтор ничего не сделал.
    expect(await chainOf(vehicleId)).toHaveLength(1);
    expect(await readingEvents(sent.items[0]!.reading!.id)).toEqual(['created']);
    expect((await reportEvents(sent.id)).filter((e) => e === 'submitted')).toHaveLength(1);

    // Тот же ключ с другим телом — уже другая команда под старым ключом, и подтвердить её молча
    // значило бы ответить «принято» на то, чего не принимали.
    await expect(
      ctx.service.submitReport(
        person,
        ctx.today,
        { ...body, items: [line(opened.items[0]!.id, values({ odometerKm: 999 }))] },
        ctx.adminId,
        key,
        { mode: 'staff' },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const unchanged = await ctx.service.loadReport(person, ctx.today);
    expect(unchanged!.items[0]!.reading!.odometerKm).toBe(300);
  });
});
