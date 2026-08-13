import { generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  readingInputSchema,
  shiftDateKey,
  weekStartKey,
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
 * Показания техники на живой схеме (ADR 0103, Р14–Р26): отчёт дня, строки ожидания и снимки
 * счётчиков.
 *
 * Зачем база. Половина утверждений модуля — это не ветвления сервиса, а ограничения схемы, и
 * проверить их на правилах невозможно в принципе: составной ключ снимка (`vehicle_readings_snapshot_fk`),
 * матрица состояний шапки, CHECK вида показания, отложенная уникальность точки цепочки. Вторая
 * половина — цепочки счётчиков: предшественник ищется строчным сравнением `(report_date, shift_order)`
 * прямо в SQL, и ошибка здесь живёт не в условии, а в границе дня.
 *
 * Тесты зовут сервис (`openReport`/`submitReport`), а не пишут в таблицы: единственное исключение —
 * случаи, где проверяется именно ограничение БД, и тогда идёт прямой INSERT с ожиданием отказа.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/vehicle-readings.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-vehicle-readings-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам». */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: показания техники';
/**
 * Номера бланков берутся из заведомо свободного диапазона: серия общая с остальной базой, а
 * `next_number` тест не двигает — свои листы он заводит прямой вставкой и сам за собой убирает.
 */
const WAYBILL_NUMBER_BASE = 900_000_000;

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof ReadingsNs;
  closeDb: () => Promise<void>;
  adminId: string;
  /** Три работника: канонический источник, две смены одной машины и ряды счётчиков. */
  drivers: { canon: string; twin: string; chain: string };
  /** Машины заводятся свои: цепочка показаний живёт по машине, и чужая строка сдвинула бы ряд. */
  vehicles: { route: string; esm2: string; twin: string; chain: string; alien: string };
  objectId: string;
  typeId: string;
  organizationId: string;
  seriesId: string;
  today: string;
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

/**
 * Уборка своих данных — и перед прогоном тоже: упавший прогон оставляет отчёты, а ряд счётчиков
 * следующего прогона они сдвинули бы молча. Порядок обратный ссылкам: отчёты (за ними каскадом
 * строки, показания и обе истории), затем документы, заявки, машины и люди.
 *
 * Листы ищутся ещё и по метке машины, а не только по работнику: лист этой машины мог выписать
 * прежний прогон под другой учёткой, и «свои» по водителю его не нашли бы — а машину он держит
 * `RESTRICT`'ом, и следующий прогон упёрся бы в неудаляемую строку.
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
      middleName: 'Показаний',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Показаньев', firstName, middleName: 'Тестович', comment: MARK })
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

/**
 * Рейс-перегон: он виден в задании всегда, тогда как грузовой пропадает, оставшись без живых
 * заявок состава, — а тесту нужен источник, а не проверка отбора заданий.
 *
 * Лист 4-П выписывается тут же, если не сказано иного: кабинет строго документален (ADR 0105, Р5),
 * и рейс без действительного листа не даёт ни строки задания, ни строки ожидания. Фикстура тем
 * самым описывает жизнь: у рейса, по которому сдают показания, лист выписан.
 */
async function newRoute(
  vehicleId: string,
  date: string,
  personId: string,
  opts: { waybill?: boolean } = {},
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
  if (opts.waybill ?? true) await new4p(route!.id, vehicleId, personId, date);
  return route!.id;
}

/** Действующий недельный лист ЭСМ-2, накрывающий день: неделя целиком, от понедельника. */
async function newEsm2(vehicleId: string, personId: string, day: string): Promise<string> {
  waybillNo += 1;
  const from = weekStartKey(day);
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
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
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

/** Лист 4-П по рейсу: у него заполнен `route_id`, и своей карточки показаний он давать не должен. */
async function new4p(
  routeId: string,
  vehicleId: string,
  personId: string,
  day: string,
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
      issuedForDate: day,
      routeId,
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
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

function line(itemId: string, reading: ReadingInput, confirm = false): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: [],
    confirmOdometerAnomaly: confirm,
    confirmEngineHoursAnomaly: confirm,
  };
}

/**
 * Имя нарушенного ограничения из отказа базы. Драйвер прячет его в `cause`, а drizzle заворачивает
 * запрос в свою ошибку — поэтому цепочка причин разбирается целиком: сравнивать с текстом «Failed
 * query…» значило бы проверять формат сообщения библиотеки, а не правило схемы.
 */
function constraintName(error: unknown): string {
  let current: unknown = error;
  while (current !== null && typeof current === 'object') {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === 'string') return name;
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

async function rejectedConstraint(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return constraintName(error);
  }
  throw new Error('операция прошла, хотя должна была упасть на ограничении базы');
}

async function readingRow(itemId: string) {
  const [row] = await ctx.db
    .select()
    .from(ctx.schema.vehicleReadings)
    .where(eq(ctx.schema.vehicleReadings.itemId, itemId));
  return row;
}

describe.skipIf(!DB_URL)('показания техники: отчёт дня на живой схеме', () => {
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
    const organizations = await db.execute<{ id: string }>(
      sql`SELECT id FROM organizations ORDER BY id LIMIT 1`,
    );
    const series = await db.execute<{ id: string }>(
      sql`SELECT id FROM waybill_series ORDER BY code LIMIT 1`,
    );
    if (!objects.rows[0] || !types.rows[0] || !organizations.rows[0] || !series.rows[0]) {
      throw new Error('В базе нет объекта, типа ТС, организации или серии бланков');
    }

    ctx = {
      db,
      schema,
      service,
      closeDb,
      adminId,
      objectId: objects.rows[0].id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: series.rows[0].id,
      drivers: { canon: '', twin: '', chain: '' },
      vehicles: { route: '', esm2: '', twin: '', chain: '', alien: '' },
      today: moscowDateKeyOf(new Date()),
    };
    ctx.drivers = {
      canon: await newPerson('Канон'),
      twin: await newPerson('Двусменный'),
      chain: await newPerson('Цепочкин'),
    };
    ctx.vehicles = {
      route: await newVehicle(),
      esm2: await newVehicle(),
      twin: await newVehicle(),
      chain: await newVehicle(),
      alien: await newVehicle(),
    };
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await cleanup(ctx.db);
      await ctx.closeDb();
    }
  });

  it('канонический источник: лист 4-П карточки не даёт, ЭСМ-2 даёт', async () => {
    // Лист выписывается здесь же, руками, а не фикстурой: он и есть предмет проверки, а действующий
    // лист на рейс всего один (`waybills_route_unique`).
    const routeId = await newRoute(ctx.vehicles.route, ctx.today, ctx.drivers.canon, {
      waybill: false,
    });
    const fourPId = await new4p(routeId, ctx.vehicles.route, ctx.drivers.canon, ctx.today);
    const esm2Id = await newEsm2(ctx.vehicles.esm2, ctx.drivers.canon, ctx.today);

    const report = await ctx.service.openReport(ctx.drivers.canon, ctx.today, ctx.adminId);
    expect(report.state).toBe('draft');
    // Ровно две строки на три документа: выезд по 4-П уже представлен своим рейсом (Р16), и
    // второй карточки на тот же выезд быть не должно.
    expect(report.items).toHaveLength(2);
    expect(report.items.map((i) => i.sourceId).sort()).toEqual([routeId, esm2Id].sort());
    expect(report.items.map((i) => i.sourceId)).not.toContain(fourPId);
    expect(report.items.find((i) => i.sourceId === esm2Id)?.sourceKind).toBe('esm2');
    // Ни один документ не пропал молча: расхождений у только что открытого отчёта нет.
    expect(report.discrepancies).toEqual([]);
  });

  it('два действующих ЭСМ-2 одной машины в один день получают разные позиции смен', async () => {
    const first = await newEsm2(ctx.vehicles.twin, ctx.drivers.twin, ctx.today);
    const second = await newEsm2(ctx.vehicles.twin, ctx.drivers.twin, ctx.today);

    const report = await ctx.service.openReport(ctx.drivers.twin, ctx.today, ctx.adminId);
    expect(report.items).toHaveLength(2);
    expect(report.items.every((i) => i.vehicleId === ctx.vehicles.twin)).toBe(true);
    // Точка цепочки одна на машину, день и позицию (`report_items_chain_key`): две смены одной
    // машины обязаны разойтись позициями, иначе вторая просто не сохранилась бы.
    expect(report.items.map((i) => i.shiftOrder).sort()).toEqual([1, 2]);
    expect(report.items.map((i) => i.sourceId).sort()).toEqual([first, second].sort());
  });

  it('окно записи: за восьмой день назад водитель сдать не может, персонал — может', async () => {
    const day = shiftDateKey(ctx.today, -8);
    await newRoute(ctx.vehicles.route, day, ctx.drivers.canon);

    await expect(ctx.service.openReport(ctx.drivers.canon, day, ctx.adminId)).rejects.toMatchObject(
      { statusCode: 403 },
    );

    const staff = await ctx.service.openReport(ctx.drivers.canon, day, ctx.adminId, {
      mode: 'staff',
    });
    expect(staff.reportDate).toBe(day);
    expect(staff.items).toHaveLength(1);
  });

  it('`values` без единого числа и `no_data` без причины не сохраняются', async () => {
    const report = await ctx.service.loadReport(ctx.drivers.twin, ctx.today);
    const itemId = report!.items[0]!.id;

    // Первая линия обороны — схема ввода: до сервиса такое тело не доходит вовсе.
    expect(readingInputSchema.safeParse({ kind: 'values' }).success).toBe(false);
    expect(readingInputSchema.safeParse({ kind: 'no_data', noDataReason: '  ' }).success).toBe(
      false,
    );

    // Вторая — CHECK: он и есть последний рубеж, если правило когда-нибудь обойдут мимо схемы.
    expect(
      await rejectedConstraint(() =>
        ctx.service.submitReport(
          ctx.drivers.twin,
          ctx.today,
          { version: report!.version, items: [line(itemId, values({}))], reason: '' },
          ctx.adminId,
          null,
        ),
      ),
    ).toBe('vehicle_readings_values_check');

    expect(
      await rejectedConstraint(() =>
        ctx.service.submitReport(
          ctx.drivers.twin,
          ctx.today,
          {
            version: report!.version,
            items: [line(itemId, { kind: 'no_data', noDataReason: '   ', comment: '' })],
            reason: '',
          },
          ctx.adminId,
          null,
          // Вид `no_data` водителю запрещён вовсе (план кабинета, Р4), и его отправка не дошла бы
          // до CHECK: проверять последний рубеж надо тем, кому этот вид разрешён, — персоналом.
          { mode: 'staff' },
        ),
      ),
    ).toBe('vehicle_readings_values_check');

    // Отказ откатил всё: отчёт остался черновиком той же редакции, показания не появилось.
    const after = await ctx.service.loadReport(ctx.drivers.twin, ctx.today);
    expect(after!.state).toBe('draft');
    expect(after!.version).toBe(report!.version);
    expect(after!.items.every((i) => i.reading === null)).toBe(true);
  });

  it('показание с чужой машиной в копиях снимка не вставляется', async () => {
    const report = await ctx.service.loadReport(ctx.drivers.twin, ctx.today);
    const item = report!.items[1]!;

    expect(
      await rejectedConstraint(() =>
        ctx.db.insert(ctx.schema.vehicleReadings).values({
          itemId: item.id,
          reportId: report!.id,
          // Машина не та, что в строке ожидания: копии снимка скреплены составным ключом, и
          // подменить машину в обход строки нельзя.
          vehicleId: ctx.vehicles.alien,
          reportDate: report!.reportDate,
          shiftOrder: item.shiftOrder,
          kind: 'values',
          odometerKm: 100,
          source: 'staff',
          createdBy: ctx.adminId,
        }),
      ),
    ).toBe('vehicle_readings_snapshot_fk');
  });

  it('счётчики идут своими рядами: моточасы не рвут одометр, а начало ряда не аномалия', async () => {
    const first = shiftDateKey(ctx.today, -2);
    const second = shiftDateKey(ctx.today, -1);
    await newRoute(ctx.vehicles.chain, first, ctx.drivers.chain);
    await newRoute(ctx.vehicles.chain, second, ctx.drivers.chain);

    const day1 = await ctx.service.openReport(ctx.drivers.chain, first, ctx.adminId);
    const sent1 = await ctx.service.submitReport(
      ctx.drivers.chain,
      first,
      {
        version: day1.version,
        items: [line(day1.items[0]!.id, values({ odometerKm: 1000, engineHours: 10 }))],
        reason: '',
      },
      ctx.adminId,
      null,
    );
    const start = sent1.items[0]!.reading!;
    // Предшественника нет — это состояние, а не отклонение: иначе первое показание каждой машины
    // навсегда осталось бы расхождением.
    expect(start.odometerAnomaly).toBeNull();
    expect(start.engineHoursAnomaly).toBeNull();
    expect(start.odometerDelta).toBeNull();

    const day2 = await ctx.service.openReport(ctx.drivers.chain, second, ctx.adminId);
    const sent2 = await ctx.service.submitReport(
      ctx.drivers.chain,
      second,
      {
        version: day2.version,
        items: [line(day2.items[0]!.id, values({ engineHours: 20 }))],
        reason: '',
      },
      ctx.adminId,
      null,
    );
    const hoursOnly = sent2.items[0]!.reading!;
    expect(hoursOnly.engineHoursDelta).toBe(10);
    expect(hoursOnly.odometerDelta).toBeNull();

    const rows = await ctx.db
      .select()
      .from(ctx.schema.vehicleReadings)
      .where(eq(ctx.schema.vehicleReadings.vehicleId, ctx.vehicles.chain))
      .orderBy(asc(ctx.schema.vehicleReadings.reportDate));
    const startRow = rows.find((r) => r.reportDate === first)!;
    const hoursRow = rows.find((r) => r.reportDate === second)!;
    expect(startRow.previousOdometerId).toBeNull();
    expect(startRow.previousEngineHoursId).toBeNull();
    // У строки без одометра ряда одометра нет вовсе — она его и не разрывает.
    expect(hoursRow.previousOdometerId).toBeNull();
    expect(hoursRow.previousEngineHoursId).toBe(startRow.id);
  });

  it('порог второй смены того же дня не обнуляется: 1400 км — норма, 1600 — аномалия', async () => {
    const first = shiftDateKey(ctx.today, -2);
    await newEsm2(ctx.vehicles.chain, ctx.drivers.chain, ctx.today);
    await newRoute(ctx.vehicles.chain, ctx.today, ctx.drivers.chain);

    const report = await ctx.service.openReport(ctx.drivers.chain, ctx.today, ctx.adminId);
    expect(report.items).toHaveLength(2);
    const shift1 = report.items.find((i) => i.shiftOrder === 1)!;
    const shift2 = report.items.find((i) => i.shiftOrder === 2)!;
    // Первичная нумерация смен: сначала недельные листы, затем рейсы (Р15).
    expect(shift1.sourceKind).toBe('esm2');
    expect(shift2.sourceKind).toBe('route');

    const sent = await ctx.service.submitReport(
      ctx.drivers.chain,
      ctx.today,
      {
        version: report.version,
        items: [
          line(shift1.id, values({ odometerKm: 1400 })),
          line(shift2.id, values({ odometerKm: 2800 })),
        ],
        reason: '',
      },
      ctx.adminId,
      null,
    );
    const second = sent.items.find((i) => i.shiftOrder === 2)!.reading!;
    // d = 0 у двух смен одного дня, и `max(1, d)` даёт им нормальные сутки на двоих: 1400 < 1500.
    expect(second.odometerDelta).toBe(1400);
    expect(second.odometerAnomaly).toBeNull();
    // Предшественник первой смены — позавчерашняя строка того же ряда, а не «предыдущий день»:
    // вчерашняя строка была без одометра и в этом ряду её нет вовсе.
    const firstShift = sent.items.find((i) => i.shiftOrder === 1)!.reading!;
    expect(firstShift.odometerAnomaly).toBeNull();
    expect(firstShift.odometerDelta).toBe(400);
    const chainRows = await ctx.db
      .select()
      .from(ctx.schema.vehicleReadings)
      .where(eq(ctx.schema.vehicleReadings.vehicleId, ctx.vehicles.chain));
    const startRow = chainRows.find((r) => r.reportDate === first)!;
    expect(chainRows.find((r) => r.id === firstShift.id)!.previousOdometerId).toBe(startRow.id);

    const jumped = await ctx.service.submitReport(
      ctx.drivers.chain,
      ctx.today,
      {
        version: sent.version,
        items: [line(shift2.id, values({ odometerKm: 3000 }))],
        reason: '',
      },
      ctx.adminId,
      null,
    );
    const anomaly = jumped.items.find((i) => i.shiftOrder === 2)!.reading!;
    expect(anomaly.odometerDelta).toBe(1600);
    expect(anomaly.odometerAnomaly).toMatchObject({
      kind: 'implausible_jump',
      confirmed: false,
      previousValue: 1400,
    });
    // Неподтверждённая аномалия — одно из четырёх условий приёма (Р22).
    expect(jumped.canAccept).toBe(false);
    expect(jumped.blockers.join('; ')).toContain('одометр');
  });

  it('обе истории пишутся той же транзакцией, что и числа', async () => {
    const opened = await ctx.service.loadReport(ctx.drivers.twin, ctx.today);
    const [item1, item2] = opened!.items;

    const sent = await ctx.service.submitReport(
      ctx.drivers.twin,
      ctx.today,
      {
        version: opened!.version,
        items: [line(item1!.id, values({ odometerKm: 500 }))],
        reason: '',
      },
      ctx.adminId,
      null,
    );
    expect(sent.state).toBe('submitted');

    const events = await ctx.db
      .select()
      .from(ctx.schema.driverDailyReportHistory)
      .where(eq(ctx.schema.driverDailyReportHistory.reportId, sent.id))
      .orderBy(asc(ctx.schema.driverDailyReportHistory.changedAt));
    expect(events.map((e) => e.event)).toEqual([
      'created',
      'item_added',
      'item_added',
      'submitted',
    ]);
    expect(events.at(-1)!.reportVersion).toBe(sent.version);

    const reading = await readingRow(item1!.id);
    const readingEvents = await ctx.db
      .select()
      .from(ctx.schema.vehicleReadingHistory)
      .where(eq(ctx.schema.vehicleReadingHistory.readingId, reading!.id));
    expect(readingEvents.map((e) => e.event)).toEqual(['created']);
    expect(readingEvents[0]!.version).toBe(reading!.version);

    // Транзакционность проверяется отказом: вторая строка тела нарушает CHECK, и вместе с ней
    // откатывается и правка первой, и обе истории.
    expect(
      await rejectedConstraint(() =>
        ctx.service.submitReport(
          ctx.drivers.twin,
          ctx.today,
          {
            version: sent.version,
            items: [line(item1!.id, values({ odometerKm: 600 })), line(item2!.id, values({}))],
            reason: '',
          },
          ctx.adminId,
          null,
        ),
      ),
    ).toBe('vehicle_readings_values_check');

    const afterFail = await ctx.service.loadReport(ctx.drivers.twin, ctx.today);
    expect(afterFail!.version).toBe(sent.version);
    expect(afterFail!.items.find((i) => i.id === item1!.id)!.reading!.odometerKm).toBe(500);
    expect(afterFail!.items.find((i) => i.id === item2!.id)!.reading).toBeNull();
    const afterEvents = await ctx.db
      .select({ id: ctx.schema.vehicleReadingHistory.id })
      .from(ctx.schema.vehicleReadingHistory)
      .where(eq(ctx.schema.vehicleReadingHistory.readingId, reading!.id));
    expect(afterEvents).toHaveLength(1);
  });

  it('отправка с устаревшей версией отчёта отвергается', async () => {
    const report = await ctx.service.loadReport(ctx.drivers.twin, ctx.today);
    await expect(
      ctx.service.submitReport(
        ctx.drivers.twin,
        ctx.today,
        {
          version: report!.version - 1,
          items: [line(report!.items[0]!.id, values({ odometerKm: 900 }))],
          reason: '',
        },
        ctx.adminId,
        null,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
