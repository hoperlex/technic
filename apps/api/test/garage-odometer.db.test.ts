import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type GarageVehicleDto,
  type ReadingInput,
  type ReportItemSubmit,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb, pool as AppPool } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as AggregateNs from '../src/services/readings-aggregate';
import type * as ReadingsNs from '../src/services/readings';

/**
 * Колонка «Одометр» вкладки «Техника» гаража (план «Показания техники», Р16).
 *
 * Проверяется здесь ровно то, чем эта колонка отличается от «последнего показания вообще», и
 * проверяется на живой схеме — потому что вся разница живёт в SQL, а не в ветвлении:
 *
 * 1. **Не позже дня среза.** Показания правят задним числом (ADR 0101), и снимок, сделанный
 *    позже выбранного дня, в колонку попадать не должен: гараж отвечает про конкретный день, тот
 *    же, которым он показывает занятость.
 * 2. **Дата снятия рядом с числом.** У дня без своего показания в колонке стоит число прошлой
 *    смены — и её дата, иначе цифра читается как сегодняшняя.
 * 3. **Выборка пакетная.** `DISTINCT ON (vehicle_id)` — одна на страницу, а не запрос на строку.
 * 4. **Право.** Одометр принадлежит модулю показаний: без `vehicleReadings.read` поля в ответе
 *    нет вовсе (механику гараж виден, показания — нет).
 *
 * Данные заводятся сервисом показаний (`openReport`/`submitReport`), а не вставками в таблицы:
 * колонка обязана показывать тот же снимок, который модуль записал, — вставками тест зеленел бы
 * ровно тогда, когда портал начал бы врать.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/garage-odometer.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-garage-odometer-admin@example.invalid';
const MECHANIC_EMAIL = 'db-garage-odometer-mechanic@example.invalid';
const PASSWORD = 'db-test-password-123';

/** Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по свежим строкам». */
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: одометр гаража';
const RUN = randomUUID().slice(0, 8);
const MARK = `${MARK_PREFIX} ${RUN}`;
/** Гаражный номер — им же тест сужает страницу гаража до своих машин поиском. */
const GARAGE_TAG = `ОДО-${RUN}`;
/** Номера бланков из заведомо свободного диапазона: `next_number` серии тест не двигает. */
const WAYBILL_NUMBER_BASE = 930_000_000 + Math.floor(Math.random() * 900) * 1_000;

/**
 * Дни отсчитываются от «сегодня минус двадцать»: окно записи за работника — тридцать дней
 * (`STAFF_SUBMIT_PAST_DAYS`), и весь отрезок сценария обязан уместиться внутри него.
 */
const DAY_OFFSET = -20;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  pool: typeof AppPool;
  schema: typeof SchemaNs;
  service: typeof ReadingsNs;
  aggregate: typeof AggregateNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
  mechanicAuth: { authorization: string };
  adminId: string;
  objectId: string;
  typeId: string;
  organizationId: string;
  seriesId: string;
  base: string;
  /** Машина с рядом снимков: по ней и проверяется день среза. */
  ridden: string;
  /** Машина, чей единственный снимок сделан ПОСЛЕ дня среза. */
  late: string;
  /** Третья машина — ею проверяется пакетность выборки. */
  spare: string;
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
 * сейчас, — живой тест, и унести его данные значит уронить его в случайном месте.
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

/** Учётка с заданной ролью: механик нужен ровно для проверки права. */
async function seedUser(
  db: typeof AppDb,
  schema: typeof SchemaNs,
  email: string,
  role: 'admin' | 'mechanic',
): Promise<string> {
  const { hashPassword } = await import('../src/auth/password');
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  if (existing) return existing.id;
  const [created] = await db
    .insert(schema.users)
    .values({
      email,
      lastName: 'Тестовый',
      firstName: role === 'admin' ? 'Администратор' : 'Механик',
      middleName: 'Одометрович',
      passwordHash: await hashPassword(PASSWORD),
      role,
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

function day(offset: number): string {
  return shiftDateKey(ctx.base, offset);
}

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Одометров', firstName, middleName: 'Тестович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

/** Своя машина: у собственной описание пустое и цен нет — этого требует `vehicles_own_fields_check`. */
async function newVehicle(tag: string): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'own',
      vehicleTypeId: ctx.typeId,
      status: 'active',
      garageNumber: `${GARAGE_TAG}-${tag}`,
      note: MARK,
    })
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

/**
 * Рейс-перегон с выписанным по нему листом. Лист обязателен: кабинет строго документален
 * (ADR 0105, Р5) — рейс без действующего листа строки ожидания не даёт, и снимать показание было
 * бы не с чего.
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
    routeId: route!.id,
    issuedBy: ctx.adminId,
  });
  return route!.id;
}

function values(odometerKm: number): ReadingInput {
  return {
    kind: 'values',
    odometerKm,
    engineHours: null,
    fuelFilledLiters: null,
    comment: '',
  } as ReadingInput;
}

function line(itemId: string, reading: ReadingInput): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: [],
    confirmOdometerAnomaly: true,
    confirmEngineHoursAnomaly: true,
  };
}

/**
 * Снимок одометра за день: рейс, открытый отчёт и переданные числа. Ввод идёт «за работника»
 * (`mode: 'staff'`) — половина дней отрезка старше водительского окна записи.
 */
async function reading(vehicleId: string, personId: string, date: string, km: number) {
  await newRoute(vehicleId, date, personId);
  const opened = await ctx.service.openReport(personId, date, ctx.adminId, { mode: 'staff' });
  const item = opened.items.find((entry) => entry.vehicleId === vehicleId);
  expect(item, `строка ожидания за ${date}`).toBeDefined();
  const current = await ctx.service.loadReport(personId, date);
  await ctx.service.submitReport(
    personId,
    date,
    { version: current!.version, items: [line(item!.id, values(km))], reason: '' },
    ctx.adminId,
    null,
    { mode: 'staff', reason: '' },
  );
}

/** Строка гаража по машине: страница сужена поиском по гаражному номеру — своих машин три. */
async function vehicleRow(
  vehicleId: string,
  on: string,
  auth = ctx.auth,
): Promise<GarageVehicleDto | undefined> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/garage/vehicles?on=${on}&pageSize=100&search=${encodeURIComponent(GARAGE_TAG)}`,
    headers: auth,
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().onDate).toBe(on);
  return (res.json().items as GarageVehicleDto[]).find((row) => row.id === vehicleId);
}

/**
 * Тексты запросов, ушедших в базу за время вызова, — ими и проверяется пакетность.
 *
 * Журнал снимается до `mockRestore`: он возвращает исходную реализацию и **заодно очищает
 * записанные вызовы**, поэтому спрашивать `mock.calls` после восстановления бесполезно. Драйвер
 * зовёт `pool.query` либо строкой, либо объектом запроса — разбор один на оба случая.
 */
async function recordQueries<T>(run: () => Promise<T>): Promise<{ texts: string[]; result: T }> {
  const spy = vi.spyOn(ctx.pool, 'query');
  try {
    const result = await run();
    const texts = spy.mock.calls.map((args) => {
      const first = args[0] as string | { text?: string };
      return (typeof first === 'string' ? first : (first.text ?? '')).toLowerCase();
    });
    return { texts, result };
  } finally {
    spy.mockRestore();
  }
}

describe.skipIf(!DB_URL)('гараж: последний одометр на день среза', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, pool, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/readings');
    const aggregate = await import('../src/services/readings-aggregate');
    const { buildApp } = await import('../src/app');
    await purgeStale(db);

    const adminId = await seedUser(db, schema, ADMIN_EMAIL, 'admin');
    await seedUser(db, schema, MECHANIC_EMAIL, 'mechanic');
    const app = await buildApp();

    const tokens: Record<string, string> = {};
    for (const email of [ADMIN_EMAIL, MECHANIC_EMAIL]) {
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: PASSWORD },
      });
      expect(login.statusCode, login.body).toBe(200);
      tokens[email] = login.json().accessToken;
    }

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
      app,
      db,
      pool,
      schema,
      service,
      aggregate,
      closeDb,
      auth: { authorization: `Bearer ${tokens[ADMIN_EMAIL]}` },
      mechanicAuth: { authorization: `Bearer ${tokens[MECHANIC_EMAIL]}` },
      adminId,
      objectId: objects.rows[0].id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: series.rows[0].id,
      base: shiftDateKey(moscowDateKeyOf(new Date()), DAY_OFFSET),
      ridden: '',
      late: '',
      spare: '',
    };

    ctx.ridden = await newVehicle('1');
    ctx.late = await newVehicle('2');
    ctx.spare = await newVehicle('3');

    /*
     * Водитель у каждой машины свой, и это не украшение фикстуры: отчёт дня принадлежит человеку,
     * а состав пересобирается только пока он в черновике (ADR 0103, Р17 п. 2). Две машины одного
     * водителя в один день означали бы, что рейс второй заводится уже после отправки отчёта — и
     * строки ожидания у него не будет.
     */
    // Ряд снимков одной машины: два дня внутри среза и один — заведомо после него.
    const driven = await newPerson('Первый');
    await reading(ctx.ridden, driven, day(0), 100_000);
    await reading(ctx.ridden, driven, day(2), 100_300);
    await reading(ctx.ridden, driven, day(4), 100_900);
    // Единственный снимок второй машины сделан ПОСЛЕ дня среза.
    await reading(ctx.late, await newPerson('Второй'), day(4), 5_000);
    await reading(ctx.spare, await newPerson('Третий'), day(0), 700);
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await ctx.app.close();
      await purge(ctx.db, MARK);
      await ctx.closeDb();
    }
  });

  it('в колонку идёт показание не позже дня среза, а снятое позже — не идёт', async () => {
    const row = await vehicleRow(ctx.ridden, day(2));
    // Именно снимок дня среза, а не последний вообще: он на 600 км больше и лежит в day(4).
    expect(row?.lastOdometer).toEqual({ km: 100_300, measuredOn: day(2) });

    // Машина, у которой показание есть только после среза, в этот день о пробеге не говорит
    // ничего. `null`, а не отсутствие поля: право у смотрящего есть, показаний нет.
    const late = await vehicleRow(ctx.late, day(2));
    expect(late?.lastOdometer).toBeNull();

    // День среза сдвинулся вперёд — и оба ответа меняются вместе с ним.
    const later = await vehicleRow(ctx.ridden, day(4));
    expect(later?.lastOdometer).toEqual({ km: 100_900, measuredOn: day(4) });
    expect((await vehicleRow(ctx.late, day(4)))?.lastOdometer).toEqual({
      km: 5_000,
      measuredOn: day(4),
    });
  });

  it('у дня без своего показания в колонке прошлое число — и его собственная дата', async () => {
    // День среза между снимками: числа за него нет, и колонка показывает позавчерашнее — но
    // называет, когда его сняли. Без даты «100 300 км» читалось бы как показание этого дня.
    const row = await vehicleRow(ctx.ridden, day(3));
    expect(row?.lastOdometer).toEqual({ km: 100_300, measuredOn: day(2) });
    expect(row?.lastOdometer?.measuredOn).not.toBe(day(3));
  });

  it('без права на показания поля нет вовсе: механику гараж виден, одометр — нет', async () => {
    const row = await vehicleRow(ctx.ridden, day(2), ctx.mechanicAuth);
    // Срез дня механику положен (`garage.read`) — строка на месте.
    expect(row).toBeDefined();
    // А одометра в ответе нет ни числом, ни `null`: «нет права» и «нет показаний» — разные ответы.
    expect(row && 'lastOdometer' in row).toBe(false);
  });

  it('выборка пакетная: одна на страницу, а не запрос на строку', async () => {
    // Журнал снимается ДО `mockRestore`: он не только возвращает исходную реализацию, но и
    // очищает записанные вызовы.
    const { texts, result: odometers } = await recordQueries(() =>
      ctx.aggregate.loadLastOdometers([ctx.ridden, ctx.late, ctx.spare], day(4)),
    );

    // Три машины — один поход в базу: колонка гаража иначе превращалась бы в полсотни запросов
    // на страницу.
    expect(texts).toHaveLength(1);
    // Верхнюю строку каждой машины снимает `DISTINCT ON`, а не подзапрос на строку.
    expect(texts[0]).toContain('distinct on');

    expect(odometers.get(ctx.ridden)).toEqual({ km: 100_900, measuredOn: day(4) });
    expect(odometers.get(ctx.late)).toEqual({ km: 5_000, measuredOn: day(4) });
    expect(odometers.get(ctx.spare)).toEqual({ km: 700, measuredOn: day(0) });
  });

  it('пустой список машин в базу не ходит вовсе', async () => {
    const { texts, result } = await recordQueries(() =>
      ctx.aggregate.loadLastOdometers([], day(4)),
    );
    expect(result).toEqual(new Map());
    expect(texts).toHaveLength(0);
  });
});
