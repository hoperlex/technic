import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatVehicleRequestNumber,
  formatVehicleRouteNumber,
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type DriverAssignmentEntry,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as AssignmentNs from '../src/services/driver-assignment';

/**
 * Задание работника на день (ADR 0102, план `docs/driver-portal-plan.md`, этап 2: Р11–Р13, Р16).
 *
 * Зачем база. Задание не собирается из переданного — оно само ходит за рейсами человека, за
 * составом каждого рейса, за контактами заявок в двух detail-таблицах и за действующими недельными
 * листами. Ветвлений в этом слое почти нет; есть запросы и границы: «живая заявка», «лист накрывает
 * день», «форма листа — ЭСМ-2». Разойтись здесь могут не правила, а запрос и схема, и цена
 * расхождения — не пустой экран, а водитель, уехавший не туда либо сдавший показания дважды.
 *
 * Отдельно проверяется правило Р16: у 4-П и формы № 3 заполнен `route_id`
 * (`waybills_form_source_check`), их выезд уже представлен рейсом, и своей строки такой лист не
 * даёт — иначе одна смена получила бы две карточки показаний.
 *
 * И Р13: у роли `driver` нет `directories.read`, поэтому строка задания состоит из готовых
 * подписей. Единственный идентификатор в ней — свой, источника; проверка это утверждение читает
 * буквально, вычёсывая из DTO все UUID.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/driver-assignment.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** Уникальный хвост прогона: база общая и переживает прогоны, а код серии бланков уникален. */
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const ADMIN_EMAIL = 'db-driver-assignment-admin@example.invalid';
/** Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам». */
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: задание работника';
/**
 * Своя серия бланков, а не общая: номер уникален внутри серии, и нумеровать листы в чужой серии
 * значило бы драться за номера с соседним db-тестом того же прогона. Префикс `zz_` — чтобы серия
 * не стала первой у тестов, берущих её `ORDER BY code LIMIT 1`.
 */
const SERIES_CODE_PREFIX = 'zz_driver_assignment_';
/** Марку и госномер водитель ищет в строке задания глазами — их же ищет проверка подписи. */
const MODEL_PREFIX = 'Тестовый самосвал (задание)';
const MODEL_NAME = `${MODEL_PREFIX} ${RUN}`;
const REG_NUMBER = `Т${randomUUID().slice(0, 6).toUpperCase()}ЗД777`;
/** Гаражный номер выезда: он снимается в рейс и в лист, а не читается из карточки машины. */
const GARAGE_NUMBER = '77';

/** UUID в любом виде: правило Р13 проверяется вычёсыванием их из готового DTO. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof AssignmentNs;
  closeDb: () => Promise<void>;
  adminId: string;
  objectId: string;
  typeId: string;
  organizationId: string;
  seriesId: string;
  modelId: string;
  /** Машина у всех сценариев одна: задание отбирается по работнику, а не по машине. */
  vehicleId: string;
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
 * Уборка своих данных — и перед прогоном тоже: упавший прогон оставляет рейсы, и следующий собрал
 * бы задание вместе с ними.
 *
 * Порядок обратный ссылкам и обязателен: показания держат машину и работника `RESTRICT`'ом (ADR
 * 0103), а листы и рейсы держат машину. Поэтому сначала отчёты, затем документы, заявки, машины,
 * модели и люди. Документы ищутся ещё и по метке машины, а не только по работнику: лист этой
 * машины мог выписать прежний прогон под другой учёткой, и «свои» по автору его не нашли бы.
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
  await db.execute(sql`DELETE FROM vehicle_models WHERE name LIKE ${`${MODEL_PREFIX}%`}`);
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
      middleName: 'Заданный',
      // Входа здесь нет: тест зовёт сервис напрямую, пароль не участвует.
      passwordHash: 'db-test-not-a-hash',
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Свой работник на сценарий: задание отбирается по человеку, и делить его между тестами нельзя. */
async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Заданкин', firstName, middleName: 'Тестович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

/** Заявка на грузоперевозку с деталями: состав рейса читает обе таблицы — адреса и контакты в них. */
async function newFreightRequest(fixture: {
  loading: string;
  unloading: string;
  scheduledAt: Date;
  status?: 'new' | 'confirmed' | 'cancelled';
  deleted?: boolean;
  loadingName?: string;
  loadingPhone?: string;
}): Promise<{ id: string; displayNumber: string }> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.typeId,
      status: fixture.status ?? 'confirmed',
      comment: MARK,
      createdBy: ctx.adminId,
      ...(fixture.deleted ? { deletedAt: new Date(), deletedBy: ctx.adminId } : {}),
    })
    .returning({ id: ctx.schema.vehicleRequests.id, num: ctx.schema.vehicleRequests.num });

  await ctx.db.insert(ctx.schema.freightTransportRequestDetails).values({
    requestId: request!.id,
    scheduledAt: fixture.scheduledAt,
    volumeM3: '10.000',
    loadingLocation: fixture.loading,
    unloadingLocation: fixture.unloading,
    loadingResponsibleName: fixture.loadingName ?? '',
    loadingResponsiblePhone: fixture.loadingPhone ?? '',
  });
  return { id: request!.id, displayNumber: formatVehicleRequestNumber(request!.num) };
}

/** Заявка-пустышка: рейсу-перегону она основание, недельному листу — источник (обе колонки NOT NULL). */
async function newSpecialRequest(): Promise<string> {
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

/** Грузовой рейс с составом: позиции — порядок строк задания бланка. */
async function newFreightRoute(opts: {
  date: string;
  personId: string;
  requestIds: string[];
  comment?: string;
}): Promise<{ id: string; displayNumber: string }> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId: ctx.vehicleId,
      routeDate: opts.date,
      purpose: 'freight',
      driverPersonId: opts.personId,
      comment: opts.comment ?? '',
      // Гаражный номер — реквизит выезда, а не карточки машины: он снимается в рейс и в лист, и
      // задание обязано брать его оттуда же, откуда его берёт бланк.
      garageNumber: GARAGE_NUMBER,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id, num: ctx.schema.vehicleRoutes.num });

  if (opts.requestIds.length > 0) {
    await ctx.db.insert(ctx.schema.vehicleRouteRequests).values(
      opts.requestIds.map((requestId, index) => ({
        routeId: route!.id,
        requestId,
        position: index + 1,
      })),
    );
  }
  return { id: route!.id, displayNumber: formatVehicleRouteNumber(route!.num) };
}

/** Перегон: состава у него нет, зато есть заявка-основание и задание «откуда — куда». */
async function newRelocationRoute(opts: {
  date: string;
  personId: string;
  moveFrom?: string;
  moveTo?: string;
}): Promise<{ id: string; displayNumber: string }> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId: ctx.vehicleId,
      routeDate: opts.date,
      purpose: 'delivery',
      sourceRequestId: await newSpecialRequest(),
      moveFrom: opts.moveFrom ?? 'База',
      moveTo: opts.moveTo ?? 'Объект',
      driverPersonId: opts.personId,
      garageNumber: GARAGE_NUMBER,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id, num: ctx.schema.vehicleRoutes.num });
  return { id: route!.id, displayNumber: formatVehicleRouteNumber(route!.num) };
}

/** Действующий недельный лист ЭСМ-2: неделя целиком, от понедельника (`waybills_period_check`). */
async function newEsm2(personId: string, day: string): Promise<string> {
  waybillNo += 1;
  const from = weekStartKey(day);
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: waybillNo,
      formCode: 'esm2',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId: ctx.vehicleId,
      driverPersonId: personId,
      issuedForDate: from,
      sourceRequestId: await newSpecialRequest(),
      periodFrom: from,
      periodTo: shiftDateKey(from, 6),
      garageNumber: GARAGE_NUMBER,
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

/** Лист 4-П по рейсу: `waybills_form_source_check` требует у него заполненный `route_id`. */
async function new4p(routeId: string, personId: string, day: string): Promise<string> {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: waybillNo,
      formCode: '4p',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId: ctx.vehicleId,
      driverPersonId: personId,
      issuedForDate: day,
      routeId,
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

/** Задание целиком — так его спрашивает и настоящий кабинет (`GET /driver/assignment`). */
function assignment(personId: string, date: string, canSubmit = true) {
  return ctx.service.buildAssignment(personId, date, canSubmit);
}

function entryOf(entries: readonly DriverAssignmentEntry[], sourceId: string) {
  return entries.find((entry) => entry.sourceId === sourceId);
}

describe.skipIf(!DB_URL)('задание работника на день (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/driver-assignment');
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
        name: `Тестовая серия (задание) ${RUN}`,
        prefix: 'ЗАД-',
      })
      .returning({ id: schema.waybillSeries.id });
    // Марка и госномер свои: подпись машины в задании — это пара «модель · госномер», и проверять
    // её на чужой машине значило бы проверять чужое наполнение.
    const [model] = await db
      .insert(schema.vehicleModels)
      .values({ vehicleTypeId: types.rows[0].id, name: MODEL_NAME })
      .returning({ id: schema.vehicleModels.id });
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({
        ownership: 'own',
        vehicleTypeId: types.rows[0].id,
        vehicleModelId: model!.id,
        registrationNumber: REG_NUMBER,
        status: 'active',
        note: MARK,
      })
      .returning({ id: schema.vehicles.id });

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
      modelId: model!.id,
      vehicleId: vehicle!.id,
      today: moscowDateKeyOf(new Date()),
    };
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await cleanup(ctx.db);
      await ctx.closeDb();
    }
  });

  it('в задание дня входят оба рейса работника: грузоперевозка и перегон', async () => {
    const person = await newPerson('Двурейсовый');
    const request = await newFreightRequest({
      loading: 'г Москва, ул Погрузочная, д 1',
      unloading: 'г Москва, ул Разгрузочная, д 2',
      // 05:30 UTC — это 08:30 по МСК: время подачи в задании печатается так, как его называют.
      scheduledAt: new Date(`${ctx.today}T05:30:00Z`),
      loadingName: 'Иванов Иван',
      loadingPhone: '9001234567',
    });
    const freight = await newFreightRoute({
      date: ctx.today,
      personId: person,
      requestIds: [request.id],
      comment: 'Позвонить диспетчеру за час до выезда',
    });
    const relocation = await newRelocationRoute({
      date: ctx.today,
      personId: person,
      moveFrom: 'Стоянка на Кольцевой',
      moveTo: 'Площадка № 4',
    });

    const dto = await assignment(person, ctx.today);
    // `canSubmit` приходит готовым: окно записи у водителя уже окна чтения (Р11), и считает его
    // маршрут, у которого есть принципал, а не этот слой.
    expect(dto).toMatchObject({ date: ctx.today, canSubmit: true });
    expect(dto.entries).toHaveLength(2);

    const freightEntry = entryOf(dto.entries, freight.id)!;
    expect(freightEntry).toMatchObject({
      sourceKind: 'route',
      sourceLabel: freight.displayNumber,
      purposeLabel: 'Грузоперевозка',
      comment: 'Позвонить диспетчеру за час до выезда',
      // Строка ожидания показаний появляется при открытии отчёта (Р17): в задании её ещё нет.
      itemId: null,
      shiftOrder: null,
    });
    // Состав рейса — то, ради чего он едет: без него строка «Машина: …» не сообщает ничего.
    expect(freightEntry.requests).toHaveLength(1);
    expect(freightEntry.requests[0]).toMatchObject({
      displayNumber: request.displayNumber,
      loadingLocation: 'г Москва, ул Погрузочная, д 1',
      unloadingLocation: 'г Москва, ул Разгрузочная, д 2',
      time: '08:30',
    });
    // Телефон едет цифрами, как лежит в базе (ADR 0066): набираемый вид — правило контрактов, одно
    // на письмо и на кабинет.
    expect(freightEntry.requests[0]!.contacts).toEqual([
      { label: 'Погрузка', name: 'Иванов Иван', phone: '9001234567' },
    ]);

    const relocationEntry = entryOf(dto.entries, relocation.id)!;
    expect(relocationEntry).toMatchObject({
      sourceKind: 'route',
      sourceLabel: relocation.displayNumber,
      purposeLabel: 'Перегон техники',
      moveFrom: 'Стоянка на Кольцевой',
      moveTo: 'Площадка № 4',
    });
    // У перегона задание не в составе, а в «откуда/куда»: талонов заказчиков у него нет.
    expect(relocationEntry.requests).toEqual([]);
  });

  it('грузовой рейс без живых заявок выпадает, перегон остаётся всегда', async () => {
    const person = await newPerson('Пустопорожний');
    const cancelled = await newFreightRequest({
      loading: 'г Москва, ул Отменённая, д 3',
      unloading: 'г Москва, ул Разгрузочная, д 4',
      scheduledAt: new Date(`${ctx.today}T06:00:00Z`),
      status: 'cancelled',
    });
    const deleted = await newFreightRequest({
      loading: 'г Москва, ул Удалённая, д 5',
      unloading: 'г Москва, ул Разгрузочная, д 6',
      scheduledAt: new Date(`${ctx.today}T07:00:00Z`),
      deleted: true,
    });
    const empty = await newFreightRoute({
      date: ctx.today,
      personId: person,
      requestIds: [cancelled.id, deleted.id],
    });
    const relocation = await newRelocationRoute({ date: ctx.today, personId: person });

    const dto = await assignment(person, ctx.today);

    // Заголовок «Рейс Р-12 · Грузоперевозка» и «Машина: …» без единой строки задания сообщают
    // водителю ровно ничего: ехать по отменённым и удалённым заявкам не надо.
    expect(dto.entries.map((entry) => entry.sourceId)).toEqual([relocation.id]);
    expect(entryOf(dto.entries, empty.id)).toBeUndefined();
    // Из состава рейса заявки при этом не выбывают: рейс помнит, на что был выписан талон.
    const kept = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM vehicle_route_requests WHERE route_id = ${empty.id}`,
    );
    expect(kept.rows[0]?.count).toBe('2');

    // Перегон виден и без единой заявки состава — у него их не бывает по построению.
    expect(entryOf(dto.entries, relocation.id)?.purposeLabel).toBe('Перегон техники');
  });

  it('недельный лист ЭСМ-2 входит своей строкой и стоит после рейсов', async () => {
    const person = await newPerson('Недельный');
    const relocation = await newRelocationRoute({ date: ctx.today, personId: person });
    const esm2 = await newEsm2(person, ctx.today);

    const dto = await assignment(person, ctx.today);

    // Порядок тот же, каким день машины читает гараж: сначала рейсы, следом документ недели, —
    // два экрана не должны расходиться.
    expect(dto.entries.map((entry) => entry.sourceId)).toEqual([relocation.id, esm2]);
    const weekly = entryOf(dto.entries, esm2)!;
    expect(weekly).toMatchObject({
      sourceKind: 'esm2',
      purposeLabel: 'Работа на объекте',
      // Состава и «откуда/куда» у листа нет: неделю работы задаёт заявка-основание, а машина всю
      // неделю там же, куда её привезли.
      requests: [],
      moveFrom: '',
      moveTo: '',
      comment: '',
    });
    expect(weekly.sourceLabel).toMatch(/^ЭСМ-2 № ЗАД-/u);

    // Соседний день той же недели лист накрывает тоже: его время задано периодом, а не датой.
    const nextDay = shiftDateKey(ctx.today, 1);
    const sameWeek = weekStartKey(nextDay) === weekStartKey(ctx.today);
    const next = await assignment(person, nextDay);
    expect(next.entries.map((entry) => entry.sourceId)).toEqual(sameWeek ? [esm2] : []);
  });

  it('лист 4-П своей строки не даёт: его выезд уже представлен рейсом (Р16)', async () => {
    const person = await newPerson('Четырёхпэшный');
    const request = await newFreightRequest({
      loading: 'г Москва, ул Погрузочная, д 7',
      unloading: 'г Москва, ул Разгрузочная, д 8',
      scheduledAt: new Date(`${ctx.today}T06:00:00Z`),
    });
    const route = await newFreightRoute({
      date: ctx.today,
      personId: person,
      requestIds: [request.id],
    });
    const fourP = await new4p(route.id, person, ctx.today);

    const dto = await assignment(person, ctx.today);

    // Ровно одна строка на два документа: второй карточкой на ту же смену лист задвоил бы и
    // задание, и будущую точку цепочки показаний.
    expect(dto.entries).toHaveLength(1);
    expect(dto.entries[0]!.sourceId).toBe(route.id);
    expect(dto.entries.map((entry) => entry.sourceId)).not.toContain(fourP);
    // Лист при этом выписан и жив: строки нет не потому, что документа нет.
    const [row] = await ctx.db
      .select({ status: ctx.schema.waybills.status, routeId: ctx.schema.waybills.routeId })
      .from(ctx.schema.waybills)
      .where(eq(ctx.schema.waybills.id, fourP));
    expect(row).toMatchObject({ status: 'issued', routeId: route.id });
  });

  it('подписи приходят готовыми, а идентификаторов справочников в задании нет вовсе', async () => {
    const person = await newPerson('Подписной');
    const request = await newFreightRequest({
      loading: 'г Москва, ул Погрузочная, д 9',
      unloading: 'г Москва, ул Разгрузочная, д 10',
      scheduledAt: new Date(`${ctx.today}T06:00:00Z`),
    });
    const route = await newFreightRoute({
      date: ctx.today,
      personId: person,
      requestIds: [request.id],
    });
    const esm2 = await newEsm2(person, ctx.today);

    const dto = await assignment(person, ctx.today);
    expect(dto.entries).toHaveLength(2);

    for (const entry of dto.entries) {
      // Машина названа парой «марка · госномер»: водитель узнаёт её во дворе по марке раньше, чем
      // по номеру, и пустая подпись отправила бы его искать «Машина: ».
      expect(entry.vehicleLabel).toBe(`${MODEL_NAME} · ${REG_NUMBER}`);
      expect(entry.sourceLabel).not.toBe('');
      expect(entry.garageNumber).toBe(GARAGE_NUMBER);
      // Прицепа у машины нет — и графа пуста: «Прицеп: …» у рейса без прицепа отправил бы
      // водителя цеплять то, чего сегодня не везут.
      expect(entry.trailerLabel).toBe('');
    }
    expect(entryOf(dto.entries, route.id)?.sourceLabel).toBe(route.displayNumber);
    expect(entryOf(dto.entries, esm2)?.sourceLabel).toMatch(/^ЭСМ-2 № /u);

    // Р13 буквально: у роли `driver` нет `directories.read`, поэтому единственные идентификаторы
    // в задании — свои, источников. Ни типа ТС, ни контрагента, ни объекта, ни самой машины.
    const found = [...JSON.stringify(dto.entries).matchAll(UUID_RE)].map((m) => m[0]);
    expect(new Set(found)).toEqual(new Set(dto.entries.map((entry) => entry.sourceId)));
    for (const entry of dto.entries) {
      expect(entry).not.toHaveProperty('vehicleId');
      expect(entry).not.toHaveProperty('vehicleTypeId');
    }
  });

  it('чужой день и чужой человек в задание не попадают', async () => {
    const mine = await newPerson('Свойдень');
    const alien = await newPerson('Чуждень');
    const yesterday = shiftDateKey(ctx.today, -1);

    const myToday = await newRelocationRoute({ date: ctx.today, personId: mine });
    const myYesterday = await newRelocationRoute({ date: yesterday, personId: mine });
    // Тот же день и та же машина, но чужой человек: рейсы отбираются работником, а не машиной.
    const alienToday = await newRelocationRoute({ date: ctx.today, personId: alien });
    await newEsm2(alien, ctx.today);

    const today = await assignment(mine, ctx.today);
    expect(today.entries.map((entry) => entry.sourceId)).toEqual([myToday.id]);

    const before = await assignment(mine, yesterday);
    expect(before.entries.map((entry) => entry.sourceId)).toEqual([myYesterday.id]);

    // Чужие строки не приходят даже через машину, на которой оба сегодня ездят.
    const alienDay = await assignment(alien, ctx.today);
    expect(alienDay.entries.map((entry) => entry.sourceId)).toContain(alienToday.id);
    expect(alienDay.entries.map((entry) => entry.sourceId)).not.toContain(myToday.id);

    // Пустое задание — законное состояние экрана, а не ошибка.
    const empty = await assignment(mine, shiftDateKey(ctx.today, 3), false);
    expect(empty).toMatchObject({
      date: shiftDateKey(ctx.today, 3),
      canSubmit: false,
      entries: [],
    });
  });
});
