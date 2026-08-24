import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
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
 * Строки ожидания отчёта дня (ADR 0103, Р15–Р17, Р21): чей источник, сколько строк он даёт и что
 * с ним делает состав чужого отчёта.
 *
 * Зачем база. Всё, что здесь проверяется, живёт не в ветвлении сервиса, а в ограничениях схемы и
 * в запросах по ним: источник занят ГЛОБАЛЬНО (`report_items_route_key`), недельный лист занят
 * парой «лист + день» (`report_items_waybill_key`), а матрица состояний шапки — один CHECK, в
 * котором `draft` с заполненной приёмкой и `accepted` с разошедшимися редакциями незаконны
 * одинаково. Правилами это не воспроизводится: расходятся не правила, а код и база.
 *
 * Переназначение рейса тест делает прямым UPDATE намеренно: это действие чужого модуля, и звать
 * его сервис значило бы тащить сюда принципала, права и окна коррекции. Предмет теста — то, как
 * состав отчёта на такое изменение отвечает.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/report-items.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Уникальный хвост прогона: база общая и переживает прогоны, а код серии бланков уникален. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const ADMIN_EMAIL = 'db-report-items-admin@example.invalid';
/** Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам». */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: строки ожидания отчёта';
/**
 * Своя серия бланков, а не общая: номер уникален внутри серии, и нумеровать листы в чужой серии
 * значило бы драться за номера с соседним db-тестом, идущим тем же прогоном. Префикс `zz_` —
 * чтобы серия не стала первой у тестов, берущих её `ORDER BY code LIMIT 1`.
 */
const SERIES_CODE_PREFIX = 'zz_report_items_';

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof ReadingsNs;
  closeDb: () => Promise<void>;
  adminId: string;
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
 * Уборка своих данных — и перед прогоном тоже: упавший прогон оставляет отчёты, а брошенная строка
 * ожидания держала бы источник занятым и в следующем. Порядок обратный ссылкам: отчёты (за ними
 * каскадом строки, показания и обе истории), затем документы, заявки, машины, люди и серии.
 *
 * Листы и рейсы ищутся ещё и по метке машины, а не только по работнику: переназначение водителя
 * тест делает сам, и после него «свои» по прежнему водителю нашлись бы не все, — а машину они держат
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
  await db.execute(sql`DELETE FROM waybill_series WHERE code LIKE ${`${SERIES_CODE_PREFIX}%`}`);
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
      middleName: 'Строчный',
      // Входа здесь нет: тест зовёт сервисы напрямую, пароль не участвует.
      passwordHash: 'db-test-not-a-hash',
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Свой работник на сценарий: отчёт один на пару «человек + день», и делить их между тестами нельзя. */
async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Строкин', firstName, middleName: 'Тестович', comment: MARK })
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
 * Лист 4-П выписывается тут же: кабинет строго документален (ADR 0105, Р5), и рейс без
 * действительного листа строки ожидания не даёт вовсе. Фикстура тем самым описывает жизнь: у рейса,
 * по которому сдают показания, лист выписан.
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

/**
 * Лист 4-П по рейсу — та самая бумага, без которой рейса для кабинета нет (Р5). Форма требует
 * заполненного `route_id` (`waybills_form_source_check`), и своей строки такой лист не даёт (Р16):
 * его выезд уже представлен рейсом.
 */
async function issueWaybillFor(
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
      number: waybillNo,
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

/**
 * Переназначение рейса так, как оно происходит в жизни: вместе с рейсом переписывается и лист.
 *
 * Бумага именная, и кабинет спрашивает лист **этого** работника (ADR 0105): передвинуть один рейс
 * значило бы проверять состав в состоянии, где документ противоречит наряду. Такое состояние —
 * предмет отдельного теста ниже, а не фон для остальных.
 */
async function reassignRoute(routeId: string, personId: string): Promise<void> {
  await ctx.db
    .update(ctx.schema.vehicleRoutes)
    .set({ driverPersonId: personId })
    .where(eq(ctx.schema.vehicleRoutes.id, routeId));
  await ctx.db
    .update(ctx.schema.waybills)
    .set({ driverPersonId: personId })
    .where(eq(ctx.schema.waybills.routeId, routeId));
}

/*
 * ЭСМ2-РАЗРЕЗ. Лист умеет быть **отрезком**, а не только неделей: после переключения чтения (этап 5)
 * состав меняется внутри срока, и понедельник со вторником могут принадлежать **разным** листам.
 * Умолчание оставлено недельным — прочие случаи файла проверяют не разрез, — а случаи разреза
 * передают границы явно.
 *
 * Проверено здесь: строка отчёта занимает пару «лист и день» (`report_items_waybill_key`), и это
 * верно при любой длине листа. От недельности не зависит ничего: ключ смотрит на `waybill_id` и
 * дату, а не на то, сколько дней покрывает бумага.
 */
async function newEsm2(
  vehicleId: string,
  personId: string,
  day: string,
  span?: { from: string; to: string },
): Promise<string> {
  waybillNo += 1;
  const from = span ? span.from : weekStartKey(day);
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: waybillNo,
      formCode: 'esm2',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId,
      driverPersonId: personId,
      issuedForDate: from,
      sourceRequestId: await newRequest(),
      periodFrom: from,
      periodTo: span ? span.to : shiftDateKey(from, 6),
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

/** События истории шапки парами «событие + причина»: порядок внутри транзакции им не задан. */
async function reportEvents(reportId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({
      event: ctx.schema.driverDailyReportHistory.event,
      reason: ctx.schema.driverDailyReportHistory.reason,
    })
    .from(ctx.schema.driverDailyReportHistory)
    .where(eq(ctx.schema.driverDailyReportHistory.reportId, reportId));
  return rows.map((row) => `${row.event}: ${row.reason}`);
}

describe.skipIf(!DB_URL)('строки ожидания: состав отчёта дня на живой схеме', () => {
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
    if (!objects.rows[0] || !types.rows[0] || !organizations.rows[0]) {
      throw new Error('В базе нет объекта, типа ТС или организации');
    }
    const [series] = await db
      .insert(schema.waybillSeries)
      .values({
        code: `${SERIES_CODE_PREFIX}${RUN}`,
        name: `Тестовая серия (строки ожидания) ${RUN}`,
        prefix: 'ТСТ-',
      })
      .returning({ id: schema.waybillSeries.id });

    ctx = {
      db,
      schema,
      service,
      closeDb,
      adminId,
      objectId: objects.rows[0].id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: series!.id,
      today: moscowDateKeyOf(new Date()),
    };
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await cleanup(ctx.db);
      await ctx.closeDb();
    }
  });

  it('один рейс не попадает в два отчёта: источник занят глобально', async () => {
    const first = await newPerson('Первый');
    const second = await newPerson('Второй');
    const vehicle = await newVehicle();
    const otherVehicle = await newVehicle();
    const routeId = await newRoute(vehicle, ctx.today, first);
    await newRoute(otherVehicle, ctx.today, second);

    const mine = await ctx.service.openReport(first, ctx.today, ctx.adminId);
    expect(mine.items.map((i) => i.sourceId)).toEqual([routeId]);
    const alien = await ctx.service.openReport(second, ctx.today, ctx.adminId);
    expect(alien.items.map((i) => i.sourceId)).not.toContain(routeId);

    // Прямая вставка: сервис до этого места не доходит — он видит источник занятым и второй строки
    // не заводит, — а проверяется здесь само ограничение, последний рубеж правила.
    expect(
      await rejectedConstraint(() =>
        ctx.db.insert(ctx.schema.driverDailyReportItems).values({
          reportId: alien.id,
          sourceKind: 'route',
          routeId,
          vehicleId: vehicle,
          reportDate: ctx.today,
          // Позиция свободна: точка цепочки тут ни при чём, падение обязано быть на источнике.
          shiftOrder: 2,
        }),
      ),
    ).toBe('report_items_route_key');
  });

  it('недельный лист даёт по строке на каждый день: занята пара «лист и день»', async () => {
    const person = await newPerson('Недельный');
    const vehicle = await newVehicle();
    // Прошлая неделя целиком: оба дня заведомо в прошлом, а понедельник и вторник одной недели —
    // единственная пара соседних дней, которую бланк накрывает при любом сегодня.
    const monday = weekStartKey(shiftDateKey(ctx.today, -7));
    const tuesday = shiftDateKey(monday, 1);
    const waybillId = await newEsm2(vehicle, person, monday);

    // Персоналом: окно записи водителя — восемь дней, а прошлый понедельник от него дальше.
    const first = await ctx.service.openReport(person, monday, ctx.adminId, { mode: 'staff' });
    const second = await ctx.service.openReport(person, tuesday, ctx.adminId, { mode: 'staff' });
    expect(first.items.map((i) => i.sourceId)).toEqual([waybillId]);
    expect(second.items.map((i) => i.sourceId)).toEqual([waybillId]);
    // Строки разные, и каждая — первая смена своего дня: позиция считается внутри дня машины.
    expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
    expect([first.items[0]!.shiftOrder, second.items[0]!.shiftOrder]).toEqual([1, 1]);

    expect(
      await rejectedConstraint(() =>
        ctx.db.insert(ctx.schema.driverDailyReportItems).values({
          reportId: second.id,
          sourceKind: 'esm2',
          waybillId,
          vehicleId: vehicle,
          reportDate: tuesday,
          shiftOrder: 2,
        }),
      ),
    ).toBe('report_items_waybill_key');
  });

  /*
   * ЭСМ2-РАЗРЕЗ. Разрезанная неделя: понедельник и вторник принадлежат **разным** листам, потому
   * что во вторник сменился состав. Строки отчёта обязаны сослаться каждая на свой лист — иначе
   * смена окажется приписана бумаге, в которой её дня нет, и сводка покажет работу не тому
   * машинисту.
   *
   * До разреза случай был невоспроизводим: неделя была одним листом, и «строки разные» проверялось
   * только позицией внутри дня, а не принадлежностью бумаге.
   */
  it('разрезанная неделя: строки соседних дней ссылаются на разные листы', async () => {
    const person = await newPerson('Разрезанный');
    const vehicle = await newVehicle();
    const monday = weekStartKey(shiftDateKey(ctx.today, -7));
    const tuesday = shiftDateKey(monday, 1);
    // Один день — один лист: стык день-в-день, ровно как его напишет смена состава со вторника.
    const first = await newEsm2(vehicle, person, monday, { from: monday, to: monday });
    const second = await newEsm2(vehicle, person, tuesday, { from: tuesday, to: tuesday });

    const mondayReport = await ctx.service.openReport(person, monday, ctx.adminId, {
      mode: 'staff',
    });
    const tuesdayReport = await ctx.service.openReport(person, tuesday, ctx.adminId, {
      mode: 'staff',
    });
    expect(mondayReport.items.map((i) => i.sourceId)).toEqual([first]);
    expect(tuesdayReport.items.map((i) => i.sourceId)).toEqual([second]);

    /*
     * Ключ `report_items_waybill_key` занят парой «лист и день», а не листом целиком: вставка листа
     * вторника на понедельник ограничение **не** нарушает. С недельной бумагой этого было не
     * различить — оба дня принадлежали одному листу, и любая вторая строка упиралась бы в ключ, чем
     * бы он ни держался.
     *
     * Проверяется именно ограничение, а не ответ сервиса: `openReport` собирает состав дня по
     * листам, которые его накрывают, и такую строку не покажет — и правильно, лист вторника
     * понедельника не касается.
     */
    await ctx.db.insert(ctx.schema.driverDailyReportItems).values({
      reportId: mondayReport.id,
      sourceKind: 'esm2',
      waybillId: second,
      vehicleId: vehicle,
      reportDate: monday,
      shiftOrder: 2,
    });
    const stored = await ctx.db
      .select({ waybillId: ctx.schema.driverDailyReportItems.waybillId })
      .from(ctx.schema.driverDailyReportItems)
      .where(eq(ctx.schema.driverDailyReportItems.reportId, mondayReport.id));
    expect(stored.map((r) => r.waybillId).sort()).toEqual([first, second].sort());

    // А тот же лист на тот же день второй строкой ключ уже не пускает.
    expect(
      await rejectedConstraint(() =>
        ctx.db.insert(ctx.schema.driverDailyReportItems).values({
          reportId: mondayReport.id,
          sourceKind: 'esm2',
          waybillId: first,
          vehicleId: vehicle,
          reportDate: monday,
          shiftOrder: 3,
        }),
      ),
    ).toBe('report_items_waybill_key');
  });

  it('источник из чужого пустого черновика переезжает вместе с заданием', async () => {
    const owner = await newPerson('Прежний');
    const heir = await newPerson('Сменщик');
    const vehicle = await newVehicle();
    const routeId = await newRoute(vehicle, ctx.today, owner);

    const before = await ctx.service.openReport(owner, ctx.today, ctx.adminId);
    expect(before.items.map((i) => i.sourceId)).toEqual([routeId]);

    // Переназначение рейса — действие чужого модуля: предмет теста в том, что ему отвечает состав.
    await reassignRoute(routeId, heir);

    const taken = await ctx.service.openReport(heir, ctx.today, ctx.adminId);
    expect(taken.items.map((i) => i.sourceId)).toEqual([routeId]);
    // Брошенный черновик прежнего работника иначе держал бы рейс занятым до уборки.
    const left = await ctx.service.loadReport(owner, ctx.today);
    expect(left!.items).toEqual([]);
    expect(left!.discrepancies).toEqual([]);

    // Перенос виден в обеих историях: без этого строка исчезала бы у одного и появлялась у другого
    // без следа, и разобрать потом «куда делся рейс» было бы нечем.
    expect(await reportEvents(before.id)).toContain('item_removed: источник переназначен');
    expect(await reportEvents(taken.id)).toContain('item_added: источник переназначен');
  });

  it('источник из отправленного отчёта не переезжает: это расхождение, а не перенос', async () => {
    const owner = await newPerson('Сдавший');
    const heir = await newPerson('Опоздавший');
    const closed = await newVehicle();
    const open = await newVehicle();
    const closedRouteId = await newRoute(closed, ctx.today, owner);
    // Второй рейс уходит из отчёта НЕЗАКРЫТЫМ намеренно: держи источник одно лишь показание,
    // правило «отправленный не отдаёт» подтверждалось бы наличием числа, а не состоянием шапки, —
    // и снятая проверка состояния прошла бы незамеченной.
    const openRouteId = await newRoute(open, ctx.today, owner);

    const opened = await ctx.service.openReport(owner, ctx.today, ctx.adminId);
    expect(opened.items).toHaveLength(2);
    const closedItem = opened.items.find((i) => i.sourceId === closedRouteId)!;
    const sent = await ctx.service.submitReport(
      owner,
      ctx.today,
      {
        version: opened.version,
        items: [line(closedItem.id, values({ odometerKm: 12_345 }))],
        reason: '',
      },
      ctx.adminId,
      null,
    );
    expect(sent.state).toBe('submitted');

    await reassignRoute(openRouteId, heir);

    // У нового работника рейс в задании есть, а строки нет: отправленный отчёт заморожен, и состав
    // его меняет не синхронизация, а человек — разбором расхождения.
    const heirReport = await ctx.service.openReport(heir, ctx.today, ctx.adminId);
    expect(heirReport.items).toEqual([]);
    expect(heirReport.discrepancies.map((d) => d.kind)).toEqual(['missing_source']);
    expect(heirReport.discrepancies[0]!.sourceId).toBe(openRouteId);

    // У прежнего обе строки на месте: и закрытая числом, и пустая, — а расхождение по работнику
    // держит приёмку.
    const ownerAfter = await ctx.service.loadReport(owner, ctx.today);
    expect(ownerAfter!.items.map((i) => i.sourceId).sort()).toEqual(
      [closedRouteId, openRouteId].sort(),
    );
    expect(ownerAfter!.items.find((i) => i.sourceId === closedRouteId)!.reading!.odometerKm).toBe(
      12_345,
    );
    expect(ownerAfter!.items.find((i) => i.sourceId === openRouteId)!.reading).toBeNull();
    expect(ownerAfter!.discrepancies.map((d) => d.kind)).toEqual(['driver']);
    expect(ownerAfter!.canAccept).toBe(false);
  });

  it('матрица состояний: черновик с заполненной приёмкой в базу не ложится', async () => {
    const person = await newPerson('Матричный');
    const day = shiftDateKey(ctx.today, -3);

    // Поля по одному этого не поймали бы: `accepted_content_version` тут не больше `content_version`,
    // и версии свою проверку проходят — незаконно именно сочетание с состоянием.
    expect(
      await rejectedConstraint(() =>
        ctx.db.insert(ctx.schema.driverDailyReports).values({
          personId: person,
          reportDate: day,
          state: 'draft',
          acceptedAt: new Date(),
          acceptedBy: ctx.adminId,
          acceptedContentVersion: 0,
          createdBy: ctx.adminId,
        }),
      ),
    ).toBe('driver_daily_reports_state_check');
  });

  it('матрица состояний: принятый с разошедшимися редакциями в базу не ложится', async () => {
    const person = await newPerson('Принятый');
    const day = shiftDateKey(ctx.today, -4);
    const now = new Date();
    const [accepted] = await ctx.db
      .insert(ctx.schema.driverDailyReports)
      .values({
        personId: person,
        reportDate: day,
        state: 'accepted',
        submittedAt: now,
        acceptedAt: now,
        acceptedBy: ctx.adminId,
        acceptedContentVersion: 0,
        contentVersion: 0,
        createdBy: ctx.adminId,
      })
      .returning({ id: ctx.schema.driverDailyReports.id });

    // `accepted` и есть «подтверждённая редакция равна текущей»: правка содержимого без смены
    // состояния делала бы приём подписью под данными, которых принимавший не видел.
    expect(
      await rejectedConstraint(() =>
        ctx.db
          .update(ctx.schema.driverDailyReports)
          .set({ contentVersion: 1 })
          .where(eq(ctx.schema.driverDailyReports.id, accepted!.id)),
      ),
    ).toBe('driver_daily_reports_state_check');

    // Та же пара чисел под именем `needs_reacceptance` законна — оно этим расхождением и определено.
    const [reopened] = await ctx.db
      .update(ctx.schema.driverDailyReports)
      .set({ state: 'needs_reacceptance', contentVersion: 1 })
      .where(
        and(
          eq(ctx.schema.driverDailyReports.id, accepted!.id),
          eq(ctx.schema.driverDailyReports.state, 'accepted'),
        ),
      )
      .returning({ state: ctx.schema.driverDailyReports.state });
    expect(reopened!.state).toBe('needs_reacceptance');
  });
});
