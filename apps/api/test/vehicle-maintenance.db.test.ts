import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type MaintenanceBasis,
  type ReadingInput,
  type ReportItemSubmit,
  type VehicleMaintenanceDto,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { Principal } from '../src/auth/principal';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as MaintenanceNs from '../src/services/vehicle-maintenance';
import type * as ReadingsNs from '../src/services/readings';

/**
 * Техобслуживание по пробегу на живой схеме (план «Показания техники», Р10—Р13, Р16, Р30): «пробег
 * с последнего ТО», оба вида незнания и журнал актов.
 *
 * Зачем база. Весь расчёт — это разбор случаев поверх цепочки показаний, которую строит чужой
 * модуль при записи: сброс счётчика становится аномалией только внутри `submitReport`, порядок
 * смен задаёт `shift_order` строки ожидания, а «ожидаемая смена» — это рейс с действующим листом
 * либо день недельного ЭСМ-2. Подменить это нечем: тест на вставках согласовал бы расчёт сам с
 * собой, а не с модулем, — и позеленел бы ровно тогда, когда портал начал бы врать.
 *
 * Поэтому данные заводятся сервисами: `openReport`/`submitReport` для показаний и
 * `createMaintenance`/`updateMaintenance` для актов.
 *
 * Запуск (база должна быть пустой или уже промигрированной — тест накатывает миграции сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/vehicle-maintenance.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-vehicle-maintenance-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/**
 * Метка своих данных: база у db-тестов общая, уборка идёт по ней. Метка своя на прогон — второй
 * экземпляр файла рядом (полный `vitest run` разработчика) с общей меткой унёс бы машины из-под
 * живого теста, и разбирать это пришлось бы как ошибку в расчёте.
 */
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: ТО техники';
const RUN = randomUUID().slice(0, 8);
const MARK = `${MARK_PREFIX} ${RUN}`;
/** Свои типы техники: признак `maintenance_basis` живёт у типа (Р13), и правка чужой строки справочника унесла бы с собой соседние тесты. */
const TYPE_CODE_PREFIX = `zz_test_maintenance_${RUN}`;
/**
 * Ключи объектов сканов — со своим прогоном внутри: файл не помечен ни машиной, ни человеком, и
 * убрать его уборка может только по этому префиксу. Тем же приёмом чистит свои вложения тест
 * заявок на обслуживание оргтехники.
 */
const fileKeyPrefix = (run: string) => `db-vehicle-maintenance/${run}/`;
/** Номера бланков — из заведомо свободного диапазона, свой блок на прогон (см. `readings-stats`). */
const WAYBILL_NUMBER_BASE = 930_000_000 + Math.floor(Math.random() * 900) * 1_000;

const TODAY = moscowDateKeyOf(new Date());

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  readings: typeof ReadingsNs;
  maintenance: typeof MaintenanceNs;
  closeDb: () => Promise<void>;
  adminId: string;
  /**
   * Тот же администратор принципалом: сервису ТО он нужен целиком, а не одним идентификатором —
   * им подписывается аудит, который пишется внутри той же транзакции.
   */
  admin: Principal;
  objectId: string;
  requestTypeId: string;
  /** Тип, по которому ТО ведут (`odometer`), и тип, по которому не ведут (`none`) — Р13. */
  trackedTypeId: string;
  untrackedTypeId: string;
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

/**
 * Уборка одного прогона. Порядок обратный ссылкам: отчёты (за ними каскадом строки и показания),
 * акты ТО, документы, заявки, машины, люди и в самом конце — свои типы техники, на которые машины
 * ссылались. Сканы актов уходят следом за записями ТО: строки связи забирает каскад от файла, но
 * сам файл ничьей меткой не помечен и убирается своим префиксом ключа.
 */
async function purge(db: typeof AppDb, mark: string, typeCodes: string): Promise<void> {
  const persons = sql`(SELECT id FROM persons WHERE comment = ${mark})`;
  const vehicles = sql`(SELECT id FROM vehicles WHERE note = ${mark})`;
  const run = mark.split(' ').at(-1) ?? '';
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_maintenance WHERE vehicle_id IN ${vehicles}`);
  await db.execute(sql`DELETE FROM files WHERE object_key LIKE ${`${fileKeyPrefix(run)}%`}`);
  await db.execute(sql`DELETE FROM waybills WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_routes WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${mark}`);
  await db.execute(sql`DELETE FROM vehicles WHERE note = ${mark}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${mark}`);
  await db.execute(sql`DELETE FROM vehicle_types WHERE code LIKE ${`${typeCodes}%`}`);
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
  for (const row of marks.rows) {
    await purge(db, row.mark, `zz_test_maintenance_${row.mark.split(' ').at(-1) ?? ''}`);
  }
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
      middleName: 'Ремонтный',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

// ── Дни сценариев ──

/** День от сегодняшнего назад: сценарии живут на своих машинах, и дни у них пересекаются свободно. */
function ago(days: number): string {
  return shiftDateKey(TODAY, -days);
}

function series(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => shiftDateKey(first, index));
}

// ── Фикстуры ──

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Механиков', firstName, middleName: 'Тестович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

/** Своя машина: у собственной описание пустое и цен нет — этого требует `vehicles_own_fields_check`. */
async function newVehicle(basis: MaintenanceBasis = 'odometer'): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'own',
      vehicleTypeId: basis === 'none' ? ctx.untrackedTypeId : ctx.trackedTypeId,
      status: 'active',
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
      vehicleTypeId: ctx.requestTypeId,
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
 * Рейс-перегон с выписанным листом: ровно он и делает день ожидаемой сменой (Р26а) — и для
 * показаний, и для хвоста расчёта ТО.
 */
async function newRoute(vehicleId: string, date: string, personId: string): Promise<void> {
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
}

/** Числа показания: поля с умолчаниями схема заполняет сама, а сервис зовётся уже разобранным телом. */
function values(odometerKm: number | null): ReadingInput {
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
    confirmOdometerAnomaly: false,
    confirmEngineHoursAnomaly: false,
  };
}

/**
 * Весь ввод идёт «за водителя» (`mode: 'staff'`): половина дней сценариев старше водительского окна
 * записи. На числа и на аномалии режим не влияет — он виден только в `source` показания.
 */
const STAFF = { mode: 'staff' as const };

/**
 * Ожидаемая смена дня и сданное по ней показание — одним движением. `odometerKm = null` означает
 * «смену ждали, чисел не сдали»: строка ожидания есть, показания нет вовсе.
 */
async function reportDay(
  personId: string,
  vehicleId: string,
  date: string,
  odometerKm: number | null,
): Promise<void> {
  await newRoute(vehicleId, date, personId);
  const opened = await ctx.readings.openReport(personId, date, ctx.adminId, STAFF);
  expect(opened.items).toHaveLength(1);
  if (odometerKm === null) return;
  const current = await ctx.readings.loadReport(personId, date);
  await ctx.readings.submitReport(
    personId,
    date,
    {
      version: current!.version,
      items: [line(opened.items[0]!.id, values(odometerKm))],
      reason: '',
    },
    ctx.adminId,
    null,
    { ...STAFF, reason: '' },
  );
}

/**
 * Скан акта: завершённая загрузка администратора. Именно ей его и заводим — `assertFilesAttachable`
 * подшивает только свой (`uploaded_by`) и только `active` файл (Р18), и файл чужого автора отверг бы
 * не расчёт, а файловый сервис.
 */
async function newScan(filename: string, size: number) {
  const objectKey = `${fileKeyPrefix(RUN)}${randomUUID()}`;
  const [file] = await ctx.db
    .insert(ctx.schema.files)
    .values({
      bucket: 'test',
      objectKey,
      filename,
      contentType: 'application/pdf',
      size,
      status: 'active',
      uploadedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.files.id });
  return { id: file!.id, filename, contentType: 'application/pdf', size };
}

/** Принципал администратора — тем видом, каким его отдаёт `loadPrincipal` обработчику ручки. */
function principalOf(id: string): Principal {
  return {
    id,
    email: ADMIN_EMAIL,
    lastName: 'Тестов',
    firstName: 'Админ',
    middleName: '',
    fullName: 'Тестов Админ',
    phone: '',
    role: 'admin',
    isActive: true,
    mustChangePassword: false,
    constructionObjectIds: [],
    departmentIds: [],
    departmentObjectIds: [],
    counterpartyId: null,
    personId: null,
    counterpartyType: null,
    grantCodes: [],
    grantPermissions: [],
    addons: [],
    authVersion: 1,
  };
}

/** Акт обслуживания — тем же сервисом, каким его заводит ручка. */
async function addMaintenance(vehicleId: string, performedOn: string, odometerKm: number | null) {
  return ctx.maintenance.createMaintenance(
    vehicleId,
    {
      performedOn,
      odometerKm,
      documentNumber: `АКТ-${performedOn}`,
      note: '',
      fileIds: [],
    },
    ctx.admin,
  );
}

async function summaryOf(vehicleId: string, onDate: string) {
  const summary = await ctx.maintenance.loadMaintenanceSummary(vehicleId, onDate);
  expect(summary).not.toBeNull();
  return summary!;
}

describe.skipIf(!DB_URL)('ТО техники: пробег с обслуживания, флаги незнания и журнал', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const readings = await import('../src/services/readings');
    const maintenance = await import('../src/services/vehicle-maintenance');
    await purgeStale(db);

    const adminId = await seedAdmin(db, schema);
    const objects = await db.execute<{ id: string }>(
      sql`SELECT id FROM construction_objects WHERE is_active LIMIT 1`,
    );
    const kinds = await db.execute<{ id: string }>(
      sql`SELECT id FROM vehicle_kinds WHERE code = 'freight_transport' LIMIT 1`,
    );
    const requestTypes = await db.execute<{ id: string }>(
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
    if (
      !objects.rows[0] ||
      !kinds.rows[0] ||
      !requestTypes.rows[0] ||
      !organizations.rows[0] ||
      !seriesRows.rows[0]
    ) {
      throw new Error('В базе нет объекта, вида техники, организации или серии бланков');
    }

    // Свои типы техники: признак «ведём ли ТО» живёт у типа (Р13), и размечать чужую строку
    // справочника нельзя — она видна всей базе, в том числе соседним прогонам db-тестов.
    const [tracked] = await db
      .insert(schema.vehicleTypes)
      .values({
        kindId: kinds.rows[0].id,
        code: `${TYPE_CODE_PREFIX}_odometer`,
        name: 'ТЕСТ: тип с ТО по пробегу',
        maintenanceBasis: 'odometer',
        isActive: false,
      })
      .returning({ id: schema.vehicleTypes.id });
    const [untracked] = await db
      .insert(schema.vehicleTypes)
      .values({
        kindId: kinds.rows[0].id,
        code: `${TYPE_CODE_PREFIX}_none`,
        name: 'ТЕСТ: тип без ТО',
        maintenanceBasis: 'none',
        isActive: false,
      })
      .returning({ id: schema.vehicleTypes.id });

    ctx = {
      db,
      schema,
      readings,
      maintenance,
      closeDb,
      adminId,
      admin: principalOf(adminId),
      objectId: objects.rows[0].id,
      requestTypeId: requestTypes.rows[0].id,
      trackedTypeId: tracked!.id,
      untrackedTypeId: untracked!.id,
      organizationId: organizations.rows[0].id,
      seriesId: seriesRows.rows[0].id,
    };
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await purge(ctx.db, MARK, TYPE_CODE_PREFIX);
      await ctx.closeDb();
    }
  });

  it('якорь из акта: 100 000 — ТО — 100 300 даёт 300 км, а не ноль', async () => {
    const person = await newPerson('Якорев');
    const vehicle = await newVehicle();
    const [before, maintained, after] = series(ago(20), 3);

    await reportDay(person, vehicle, before!, 100_000);
    await addMaintenance(vehicle, maintained!, 100_000);
    await reportDay(person, vehicle, after!, 100_300);

    // Буквальный агрегат за период `[performed_on, on]` дал бы здесь ноль: предшественник снимка
    // 100 300 остался бы снаружи периода, и правило «обе точки пары внутри» (Р4) съело бы первый
    // участок. Якорь берётся из акта (Р11а) — и первая же дельта считается от него.
    const summary = await summaryOf(vehicle, after!);
    expect(summary).toMatchObject({
      kmSince: 300,
      chainBroken: false,
      lowerBound: false,
      state: 'ok',
      maintenanceBasis: 'odometer',
    });
    // Последний одометр — единственное показание, видимое под правом ТО (Р14б): без него «300 км с
    // ТО» нечем проверить.
    expect(summary.lastOdometer).toEqual({ km: 100_300, measuredOn: after });
    expect(summary.lastMaintenance).toMatchObject({
      performedOn: maintained,
      odometerKm: 100_000,
      version: 0,
      updatedByName: '',
    });
  });

  it('показание дня ТО в расчёт не идёт, но и не теряется: следующая дельта его накрывает', async () => {
    const person = await newPerson('Днёвкин');
    const vehicle = await newVehicle();
    const [before, maintained, after] = series(ago(19), 3);

    await reportDay(person, vehicle, before!, 99_800);
    // Показание дня ТО снято УТРОМ, до обслуживания, — у акта времени нет, и различить это нечем
    // (Р11б). Одометр в акте больше: машина доехала до сервиса уже после того, как сдала смену.
    await reportDay(person, vehicle, maintained!, 100_000);
    await addMaintenance(vehicle, maintained!, 100_200);
    await reportDay(person, vehicle, after!, 100_400);

    // 200, а не 400, и без единой пометки. Учти расчёт снимок дня ТО — он оказался бы «меньше
    // якоря», то есть выглядел бы сброшенным счётчиком: машина получила бы `chainBroken` и
    // «неизвестно» на ровном месте. Пробег дня ТО после обслуживания при этом не потерян — он
    // целиком внутри дельты 100 200 → 100 400.
    expect(await summaryOf(vehicle, after!)).toMatchObject({
      kmSince: 200,
      chainBroken: false,
      lowerBound: false,
      state: 'ok',
    });
  });

  it('ТО → сброс счётчика → показания → новое ТО: минуса нет, chainBroken поднят, порог работает', async () => {
    const person = await newPerson('Сбросов');
    const vehicle = await newVehicle();
    const [maintained, first, reset, afterReset, far] = series(ago(18), 5);

    await addMaintenance(vehicle, maintained!, 50_000);
    await reportDay(person, vehicle, first!, 50_200);
    // Прибор заменили: значение меньше предыдущего — модуль показаний ставит `counter_reset` сам.
    await reportDay(person, vehicle, reset!, 100);
    await reportDay(person, vehicle, afterReset!, 900);

    const broken = await summaryOf(vehicle, afterReset!);
    // 200 до сброса плюс 800 после него: переход через сброс неизвестен и в сумму не идёт, но
    // известные участки складываются, и отрицательным результат быть не может.
    expect(broken).toMatchObject({ kmSince: 1_000, chainBroken: true, lowerBound: false });
    // Ниже норматива при поднятом флаге — `unknown`, а не `ok`: «не меньше 1 000 км» (Р11в).
    expect(broken.state).toBe('unknown');

    await reportDay(person, vehicle, far!, 12_000);
    const overdue = await summaryOf(vehicle, far!);
    expect(overdue.kmSince).toBe(12_100);
    // Превышение норматива достоверно при любых флагах: больше известного машина проехать могла,
    // меньше — нет. Поставь проверку флагов раньше — и просроченная машина со сброшенным счётчиком
    // показывала бы «неизвестно» вместо «просрочено».
    expect(overdue).toMatchObject({ chainBroken: true, state: 'overdue' });

    // Следующее ТО заводится по новому прибору, хотя его пробег меньше пробега прошлого акта:
    // монотонности не требуется, замена прибора законна (Р11а).
    await addMaintenance(vehicle, far!, 12_000);
    expect(await summaryOf(vehicle, far!)).toMatchObject({
      kmSince: 0,
      chainBroken: false,
      lowerBound: false,
      state: 'ok',
    });
  });

  it('сброс в день ТО обнуляет якорь: ни минуса, ни ложного пробега от негодного якоря', async () => {
    const [before, maintained, next, later] = series(ago(17), 4);

    // (а) В акте — число СТАРОГО прибора. Снимок со сбросом отфильтрован правилом Р11б, и без Р11г
    // якорь остался бы от прибора, которого уже нет: первый же снимок следующего дня дал бы минус.
    const oldDevice = await newVehicle();
    const first = await newPerson('Заменов');
    await reportDay(first, oldDevice, before!, 80_000);
    await reportDay(first, oldDevice, maintained!, 5);
    await addMaintenance(oldDevice, maintained!, 80_000);
    await reportDay(first, oldDevice, next!, 300);
    await reportDay(first, oldDevice, later!, 900);

    const summary = await summaryOf(oldDevice, later!);
    // Счёт начинается со снимка после сброса: 900 − 300. Ни минуса, ни 80 000 «пробега» из разности
    // двух разных приборов, а незнание названо флагом.
    expect(summary).toMatchObject({ kmSince: 600, chainBroken: true, state: 'unknown' });
    expect(summary.kmSince!).toBeGreaterThanOrEqual(0);

    // (б) В акте — число НОВОГО прибора, поставленного в тот же день. Минуса здесь не будет и без
    // Р11г — зато будет ложный пробег: якорь 150 меньше следующих снимков, и разность 900 − 150
    // молча зачлась бы в наработку с ТО, а флага не подняла бы ни одного.
    const newDevice = await newVehicle();
    const second = await newPerson('Приборов');
    await reportDay(second, newDevice, before!, 5_000);
    await reportDay(second, newDevice, maintained!, 200);
    await addMaintenance(newDevice, maintained!, 150);
    await reportDay(second, newDevice, next!, 900);
    await reportDay(second, newDevice, later!, 1_200);

    // 300, а не 1 050: якорь из акта негоден с той секунды, как в этот день сменили прибор, и счёт
    // начинается со снимка после сброса.
    expect(await summaryOf(newDevice, later!)).toMatchObject({
      kmSince: 300,
      chainBroken: true,
      state: 'unknown',
    });
  });

  it('пропущенная смена: закрытая следующим числом — не хвост, незакрытая к срезу — хвост', async () => {
    const person = await newPerson('Пропущев');
    const closed = await newVehicle();
    const [start, gap, end] = series(ago(16), 3);

    await addMaintenance(closed, start!, 1_000);
    await reportDay(person, closed, start!, 1_000);
    // Смену ждали, чисел не сдали. Сама по себе она ни одного флага не даёт (Р11в): цепочка
    // назначает такой строке предшественником последний снимок с числом, и следующее числовое
    // показание накрывает пропуск целиком.
    await reportDay(person, closed, gap!, null);
    await reportDay(person, closed, end!, 1_300);

    expect(await summaryOf(closed, end!)).toMatchObject({
      kmSince: 300,
      chainBroken: false,
      lowerBound: false,
      state: 'ok',
    });

    // Тот же пропуск, но не закрытый к дню среза: последняя ожидаемая смена правее последнего
    // числового снимка — известного меньше, чем проехано.
    const open = await newVehicle();
    const other = await newPerson('Хвостов');
    await addMaintenance(open, start!, 1_000);
    await reportDay(other, open, start!, 1_000);
    await reportDay(other, open, gap!, 1_300);
    await reportDay(other, open, end!, null);

    expect(await summaryOf(open, end!)).toMatchObject({
      kmSince: 300,
      chainBroken: false,
      lowerBound: true,
      state: 'unknown',
    });
    // На дне, где хвост ещё закрыт, того же флага нет: срез спрашивает про свой день (Р16).
    expect(await summaryOf(open, gap!)).toMatchObject({ kmSince: 300, lowerBound: false });
  });

  it('акт без одометра — нижняя граница сразу; тип без ТО — not_tracked при тех же данных', async () => {
    const person = await newPerson('Безякорев');
    const vehicle = await newVehicle();
    const untracked = await newVehicle('none');
    const [maintained, first, second] = series(ago(15), 3);

    await addMaintenance(vehicle, maintained!, null);
    await addMaintenance(untracked, maintained!, null);
    for (const [date, km] of [
      [first!, 5_000],
      [second!, 5_400],
    ] as const) {
      await reportDay(person, vehicle, date, km);
      await reportDay(await newPerson(`Двойник-${km}`), untracked, date, km);
    }

    // Якоря нет — счёт начинается с первого снимка после ТО, и всё, что проехали до него, осталось
    // неизвестным. Число при этом честное: «не меньше 400 км».
    expect(await summaryOf(vehicle, second!)).toMatchObject({
      kmSince: 400,
      chainBroken: false,
      lowerBound: true,
      state: 'unknown',
    });

    // Пакетная сводка — та же, что у карточки: колонка гаража спрашивает её по странице целиком.
    const snapshot = await ctx.maintenance.loadMaintenanceSnapshot(
      [vehicle, untracked, randomUUID()],
      second!,
    );
    // Машины, которой нет, в ответе нет: «нет такой» и «ТО не было» — разные ответы.
    expect(snapshot.size).toBe(2);
    // «Не ведём» — это ответ справочника, а не незнание: цепочку по такой машине никто не считает.
    expect(snapshot.get(untracked)).toMatchObject({
      maintenanceBasis: 'none',
      kmSince: null,
      chainBroken: false,
      lowerBound: false,
      state: 'not_tracked',
    });
    expect(snapshot.get(vehicle)).toMatchObject({ state: 'unknown', kmSince: 400 });
  });

  it('машина без единого акта — законная сводка, а не отсутствие ответа', async () => {
    const vehicle = await newVehicle();
    const summary = await summaryOf(vehicle, TODAY);
    expect(summary).toMatchObject({
      lastMaintenance: null,
      lastOdometer: null,
      kmSince: null,
      state: 'unknown',
    });
    expect(await ctx.maintenance.loadMaintenanceSummary(randomUUID(), TODAY)).toBeNull();
  });

  it('правка записи в середине истории меняет интервалы соседних срезов, версия сторожит правку', async () => {
    const person = await newPerson('Правкин');
    const vehicle = await newVehicle();
    const [d0, d1, d2, d3, d4] = series(ago(14), 5);

    for (const [date, km] of [
      [d0!, 1_000],
      [d1!, 1_200],
      [d2!, 1_500],
      [d3!, 1_800],
      [d4!, 2_000],
    ] as const) {
      await reportDay(person, vehicle, date, km);
    }
    const first = await addMaintenance(vehicle, d0!, 1_000);
    const middle = await addMaintenance(vehicle, d2!, 1_500);
    const last = await addMaintenance(vehicle, d4!, 2_000);

    // Порядок истории — Р30: сначала последнее по дате, ключ замыкают `created_at` и `id`.
    const history = await ctx.maintenance.loadMaintenanceHistory(vehicle);
    expect(history.map((row) => row.id)).toEqual([last.id, middle.id, first.id]);

    // До правки: срез d2 стоит ровно на дне среднего акта — снимки этого дня в счёт не идут (Р11б),
    // и пробега с ТО ещё нет. Срез d3 отвечает первым участком, 1 800 − 1 500.
    expect(await summaryOf(vehicle, d2!)).toMatchObject({ kmSince: 0 });
    expect(await summaryOf(vehicle, d3!)).toMatchObject({ kmSince: 300 });

    // Механик переносит средний акт на день позже и переписывает пробег. Дата — самая опасная
    // правка из возможных: она меняет, какой акт вообще считается последним на срезе.
    const moved = await ctx.maintenance.updateMaintenance(
      middle.id,
      {
        performedOn: d3!,
        odometerKm: 1_800,
        documentNumber: 'АКТ-исправленный',
        note: 'перенесено на день позже',
        fileIds: [],
      },
      middle.version,
      ctx.admin,
    );
    expect(moved).toMatchObject({
      version: middle.version + 1,
      performedOn: d3,
      odometerKm: 1_800,
    });
    expect(moved.updatedByName).not.toBe('');

    // Пересчитывать нечего: `kmSince` не хранится, а собирается на чтении — и оба соседних среза
    // отвечают уже новыми числами. Срез d2 перешёл к первому акту (1 500 − 1 000), срез d3 — к
    // перенесённому, у которого своих снимков после дня ТО ещё нет.
    expect(await summaryOf(vehicle, d2!)).toMatchObject({ kmSince: 500 });
    expect(await summaryOf(vehicle, d3!)).toMatchObject({ kmSince: 0 });
    // Версия поднялась только у правленой записи: соседям она стережёт их собственные поля, и
    // подними мы её всем, открытая рядом форма соседнего акта отказала бы ни за что.
    const afterEdit = await ctx.maintenance.loadMaintenanceHistory(vehicle);
    expect(afterEdit.find((row) => row.id === first.id)!.version).toBe(0);

    // Устаревшая версия — отказ, и правка не применяется (Р30).
    await expect(
      ctx.maintenance.updateMaintenance(
        middle.id,
        { performedOn: d3!, odometerKm: 9_999, documentNumber: '', note: '', fileIds: [] },
        middle.version,
        ctx.admin,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'version_conflict' });
    expect(
      (await ctx.maintenance.loadMaintenanceHistory(vehicle)).map((row) => row.odometerKm),
    ).toEqual([2_000, 1_800, 1_000]);

    // Удаление — та же оптимистическая блокировка: чужой версией запись не унести.
    await expect(
      ctx.maintenance.deleteMaintenance(last.id, last.version + 5, ctx.admin),
    ).rejects.toMatchObject({ statusCode: 409 });
    await ctx.maintenance.deleteMaintenance(last.id, last.version, ctx.admin);
    expect((await ctx.maintenance.loadMaintenanceHistory(vehicle)).map((row) => row.id)).toEqual([
      moved.id,
      first.id,
    ]);
  });

  /**
   * Скан акта в ответе (§3.3). Одних идентификаторов форме мало: по списку `string[]` она
   * подписывала вложения «Скан 1», «Скан 2» — не зная ни имени документа, ни его размера, ни того,
   * откроется ли за подписью что-нибудь вообще. Проверяется поэтому не «подшилось ли», а состав
   * ответа: имя, тип и размер приходят из строки `files`, и приходят одинаково из всех трёх мест,
   * которые отдают запись, — заведения, истории и сводки.
   */
  it('скан акта приходит с именем, типом и размером — и снимается правкой', async () => {
    const vehicle = await newVehicle();
    const first = await newScan('акт-152.pdf', 240_128);
    const second = await newScan('дефектная-ведомость.pdf', 51_200);

    const record = await ctx.maintenance.createMaintenance(
      vehicle,
      {
        performedOn: TODAY,
        odometerKm: 12_000,
        documentNumber: 'АКТ-152',
        note: '',
        fileIds: [first.id],
      },
      ctx.admin,
    );
    expect(record.files).toEqual([first]);

    // История и сводка отвечают тем же составом: DTO записи собирает одно место.
    const [fromHistory] = await ctx.maintenance.loadMaintenanceHistory(vehicle);
    expect(fromHistory?.files).toEqual([first]);
    expect((await summaryOf(vehicle, TODAY)).lastMaintenance?.files).toEqual([first]);

    // Правка подшивает второй документ: порядок — подшивки, а не сортировки по имени.
    const withBoth = await ctx.maintenance.updateMaintenance(
      record.id,
      {
        performedOn: TODAY,
        odometerKm: 12_000,
        documentNumber: 'АКТ-152',
        note: '',
        fileIds: [second.id, first.id],
      },
      record.version,
      ctx.admin,
    );
    expect(withBoth.files).toEqual([first, second]);

    // И снимает оба: связи больше нет — в ответе не остаётся ни одного файла.
    const withNone = await ctx.maintenance.updateMaintenance(
      record.id,
      {
        performedOn: TODAY,
        odometerKm: 12_000,
        documentNumber: 'АКТ-152',
        note: '',
        fileIds: [],
      },
      withBoth.version,
      ctx.admin,
    );
    expect(withNone.files).toEqual([]);
  });

  it('подсказка ввода — последний известный одометр на день среза', async () => {
    const person = await newPerson('Подсказкин');
    const vehicle = await newVehicle();
    const [first, second] = series(ago(9), 2);

    await reportDay(person, vehicle, first!, 7_000);
    await reportDay(person, vehicle, second!, 7_400);

    expect(await ctx.maintenance.loadOdometerHint(vehicle, second!)).toEqual({
      km: 7_400,
      measuredOn: second,
    });
    // Верхняя граница существенна (Р16): форма, открытая на прошлый день, не подсказывает будущее.
    expect(await ctx.maintenance.loadOdometerHint(vehicle, first!)).toEqual({
      km: 7_000,
      measuredOn: first,
    });
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * ЗАМОРОЖЕННЫЙ СКЛАД АВТОЗАПЧАСТЕЙ (план `docs/auto-part-receipts-plan.md`, Р2, Р3, Р26;
   * миграция [0188](../drizzle/0188_vehicle_maintenance_parts.sql) остаётся в базе нетронутой).
   *
   * Акт обслуживания БОЛЬШЕ НЕ ДВИГАЕТ СКЛАД — ни заведением, ни правкой, ни аннулированием. Строк
   * расхода у него нет вовсе, деньги на детали ведут чеки, а `auto_parts`, `auto_part_stock_entries`
   * и `vehicle_maintenance_parts` живут в схеме со своими триггерами: выпуск 2 «Заморозка» идёт без
   * единой миграции (Р26), и вернуть склад — это снять сокрытие, а не восстанавливать схему.
   *
   * Отсюда предмет этих случаев: не расход, а ГРАНИЦА замороженного. Проверяются ровно две вещи,
   * которые заморозка обязана была сохранить, и одна, которую она обязана была убрать:
   *
   *   · аннулирование не пишет НИ ОДНОГО движения (Р3) — «склад не двигается вовсе» без исключения
   *     «кроме аннулирования»; раньше оно возвращало весь расход акта;
   *   · акт, за которым числятся ИСТОРИЧЕСКИЕ движения, по-прежнему неудаляем, и отказ приходит
   *     СЛОВАМИ, а не именем ограничения: `RESTRICT` журнала никуда не делся;
   *   · признак `hasPartMovements` остался в полном DTO — портал по нему объясняет, почему старый
   *     акт не удаляется, и объясняет ДО нажатия, а не после 409.
   *
   * Историю расхода заводит прямой SQL, и иначе быть не может: кода, который её пишет, в портале не
   * осталось. Это и есть точное состояние прода после заморозки — старые строки лежат, новых не
   * появляется, — а инварианты миграции `0188` при такой вставке проверяются по-настоящему: они
   * отложенные и срабатывают на коммите.
   *
   * Своё убирается своим `afterAll` — раньше общего: журнал склада неудаляем триггером, а его
   * строки ссылаются на акты под `RESTRICT`, и общая уборка не смогла бы снести ни акта.
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   */
  describe('заморозка склада: акт не двигает остаток, но старые движения его держат', () => {
    /** Метка своих позиций склада: имя уникально по построению, по нему же идёт уборка. */
    const PART_MARK = `АЗЧ-ТО ${RUN}`;

    let partNo = 0;

    interface Part {
      id: string;
      name: string;
    }

    /**
     * Позиция склада прямым SQL: справочника автозапчастей в портале больше нет вовсе, а таблица
     * есть. Порядок внутри транзакции тот же, что был у ручки, и он обязателен: триггер цепочки
     * сверяет «стало» события с ФАКТИЧЕСКИМ остатком карточки, поэтому сперва карточка с числом,
     * потом событие «0 → N».
     */
    async function newPart(quantity = 0): Promise<Part> {
      partNo += 1;
      const name = `${PART_MARK} №${partNo}`;
      return ctx.db.transaction(async (tx) => {
        const created = await tx.execute<{ id: string }>(sql`
          INSERT INTO auto_parts (name, quantity, is_active, created_by, updated_by)
          VALUES (${name}, ${quantity}, true, ${ctx.adminId}, ${ctx.adminId})
          RETURNING id`);
        const id = created.rows[0]!.id;
        if (quantity > 0) {
          await tx.execute(sql`
            INSERT INTO auto_part_stock_entries
              (auto_part_id, quantity_before, quantity_after, reason, changed_by)
            VALUES (${id}, 0, ${quantity}, 'Заведение карточки: начальный остаток', ${ctx.adminId})`);
        }
        return { id, name };
      });
    }

    /**
     * СТАРЫЙ расход по акту: строка документа и списание журнала — прямым SQL, как их писал сервис
     * до заморозки. Пишется одной транзакцией и в том же порядке (карточка → событие → строка):
     * триггер цепочки `0187` сверяет «стало» с остатком карточки, а инвариант `0188` («количество
     * строки = Σ issue − Σ return по паре») отложен и сойдётся на коммите — то есть история
     * заводится законной, а не продавленной мимо защит.
     */
    async function addFrozenConsumption(
      maintenanceId: string,
      part: Part,
      quantity: number,
    ): Promise<void> {
      await ctx.db.transaction(async (tx) => {
        const card = await tx.execute<{ quantity: number }>(
          sql`SELECT quantity FROM auto_parts WHERE id = ${part.id} FOR UPDATE`,
        );
        const before = card.rows[0]!.quantity;
        const after = before - quantity;
        await tx.execute(sql`UPDATE auto_parts SET quantity = ${after} WHERE id = ${part.id}`);
        await tx.execute(sql`
          INSERT INTO auto_part_stock_entries
            (auto_part_id, entry_kind, quantity_before, quantity_after, reason, maintenance_id,
             changed_by)
          VALUES (${part.id}, 'issue', ${before}, ${after}, 'Списание по акту обслуживания',
                  ${maintenanceId}, ${ctx.adminId})`);
        await tx.execute(sql`
          INSERT INTO vehicle_maintenance_parts (maintenance_id, auto_part_id, quantity)
          VALUES (${maintenanceId}, ${part.id}, ${quantity})`);
      });
    }

    async function stockOf(partId: string): Promise<number> {
      const res = await ctx.db.execute<{ quantity: number }>(
        sql`SELECT quantity FROM auto_parts WHERE id = ${partId}`,
      );
      return res.rows[0]!.quantity;
    }

    interface Movement {
      kind: string;
      before: number;
      after: number;
      reason: string;
      maintenanceId: string | null;
    }

    /** Журнал позиции снизу вверх — по `seq`, а не по времени: он и есть порядок событий. */
    async function movementsOf(partId: string): Promise<Movement[]> {
      const res = await ctx.db.execute<{
        entry_kind: string;
        quantity_before: number;
        quantity_after: number;
        reason: string;
        maintenance_id: string | null;
      }>(sql`
        SELECT entry_kind, quantity_before, quantity_after, reason, maintenance_id
          FROM auto_part_stock_entries WHERE auto_part_id = ${partId} ORDER BY seq`);
      return res.rows.map((r) => ({
        kind: r.entry_kind,
        before: r.quantity_before,
        after: r.quantity_after,
        reason: r.reason,
        maintenanceId: r.maintenance_id,
      }));
    }

    /** Строки акта прямым SQL: DTO их больше не отдаёт вовсе, а в таблице они лежат. */
    async function linesOf(
      maintenanceId: string,
    ): Promise<Array<{ partId: string; quantity: number }>> {
      const res = await ctx.db.execute<{ auto_part_id: string; quantity: number }>(sql`
        SELECT auto_part_id, quantity FROM vehicle_maintenance_parts
         WHERE maintenance_id = ${maintenanceId} ORDER BY auto_part_id`);
      return res.rows.map((r) => ({ partId: r.auto_part_id, quantity: r.quantity }));
    }

    interface ActInput {
      on?: string;
      odometerKm?: number | null;
      documentNumber?: string;
    }

    async function newAct(vehicleId: string, input: ActInput = {}): Promise<VehicleMaintenanceDto> {
      return ctx.maintenance.createMaintenance(
        vehicleId,
        {
          performedOn: input.on ?? TODAY,
          odometerKm: input.odometerKm ?? null,
          documentNumber: input.documentNumber ?? `АКТ-${RUN}`,
          note: '',
          fileIds: [],
        },
        ctx.admin,
      );
    }

    function editAct(
      act: { id: string; version: number },
      fields: {
        on?: string;
        odometerKm?: number | null;
        documentNumber?: string;
        note?: string;
      },
    ): Promise<VehicleMaintenanceDto> {
      return ctx.maintenance.updateMaintenance(
        act.id,
        {
          performedOn: fields.on ?? TODAY,
          odometerKm: fields.odometerKm ?? null,
          documentNumber: fields.documentNumber ?? `АКТ-${RUN}`,
          note: fields.note ?? '',
          fileIds: [],
        },
        act.version,
        ctx.admin,
      );
    }

    /** Метаданные последней записи аудита по акту — «что именно портал записал про действие». */
    async function auditMeta(
      maintenanceId: string,
      action: string,
    ): Promise<Record<string, unknown>> {
      const res = await ctx.db.execute<{ metadata: Record<string, unknown> }>(sql`
        SELECT metadata FROM audit_log
         WHERE entity_type = 'vehicleMaintenance' AND entity_id = ${maintenanceId}
           AND action = ${action}
         ORDER BY created_at DESC LIMIT 1`);
      return res.rows[0]!.metadata;
    }

    /**
     * Отказ базы, разобранный так же, как его разбирает сервер: код и имя ограничения лежат не на
     * верхнем объекте, а в `cause`. Текст собирается по всей цепочке причин — слова триггера живут
     * в ошибке драйвера, а не в обёртке.
     */
    async function dbRefusal(
      run: Promise<unknown>,
    ): Promise<{ code?: string; constraint?: string; message: string }> {
      // Обработчик вешается ПЕРВЫМ ЖЕ действием, до всякого `await import`: обещание сюда приходит уже
      // запущенным, и отложи мы `await` хоть на такт — отказ успел бы стать unhandled rejection, а
      // vitest считает такую ошибку падением прогона. Разбор идёт после, когда ошибка уже поймана.
      let caught: unknown;
      let принято = false;
      try {
        await run;
        принято = true;
      } catch (e) {
        caught = e;
      }
      if (принято) throw new Error('база приняла запись, которую обязана была отбить');
      const { pgErrorOf } = await import('../src/lib/pg-error');
      const info = pgErrorOf(caught);
      let message = '';
      let current: unknown = caught;
      for (let depth = 0; depth < 5 && current; depth += 1) {
        const candidate = current as { message?: string; cause?: unknown };
        if (typeof candidate.message === 'string') message += `${candidate.message}\n`;
        current = candidate.cause;
      }
      return { code: info?.code, constraint: info?.constraint, message };
    }

    /**
     * Уборка своего — РАНЬШЕ общей (вложенный `afterAll` отрабатывает до внешнего), и порядок в ней
     * задан схемой, а не вкусом:
     *
     *   1. строки журнала склада неудаляемы триггером, и обойти это нечем: каскада сюда не ведёт ни
     *      одного, `session_replication_role` триггеру не указ (`ENABLE ALWAYS`), а `TRUNCATE` унёс
     *      бы вместе со своим и чужое. Значит триггер гасится на время уборки — одной транзакцией
     *      (`ALTER TABLE` транзакционен, оборванный прогон откатывает и гашение) и с возвратом
     *      `ENABLE ALWAYS`, а не простого `ENABLE`: тот оставил бы защиту неработающей на
     *      реплике-приёмнике;
     *   2. строки актов — после журнала: их отложенный инвариант сходится ровно потому, что
     *      движений к этому моменту уже нет (обе стороны по нулю);
     *   3. позиции — последними: до этого их держал `RESTRICT` и журнала, и строк актов.
     *
     * Сами акты уносит общая уборка файла: к её моменту ссылок на них из журнала уже не осталось.
     *
     * Аудит убирается двумя условиями, и второе не шире первого, а ДОПОЛНЯЕТ его: по своим актам
     * поимённо — этого хватает почти всему, — плюс СИРОТЫ, то есть строки про акты, которых больше
     * нет. Сироты нужны потому, что часть актов файл удаляет по ходу дела, и след их заведения
     * поимённым отбором уже не поймать. Соседнему прогону это не мешает: пока он работает, его акты
     * существуют, а сиротой строка становится ровно тогда, когда акт унесли, — и его собственная
     * уборка снесла бы её следом.
     */
    afterAll(async () => {
      if (!ctx?.db) return;
      const мои = sql`SELECT id FROM auto_parts WHERE name LIKE ${`${PART_MARK}%`}`;
      const акты = sql`
        SELECT id FROM vehicle_maintenance
         WHERE vehicle_id IN (SELECT id FROM vehicles WHERE note = ${MARK})`;
      await ctx.db.execute(sql`
        DELETE FROM audit_log
         WHERE entity_type = 'vehicleMaintenance'
           AND (entity_id IN (SELECT id::text FROM (${акты}) a)
                OR entity_id NOT IN (SELECT id::text FROM vehicle_maintenance))`);
      await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        await tx.execute(
          sql`ALTER TABLE auto_part_stock_entries DISABLE TRIGGER auto_part_stock_immutable`,
        );
        await tx.execute(sql`DELETE FROM auto_part_stock_entries WHERE auto_part_id IN (${мои})`);
        await tx.execute(
          sql`ALTER TABLE auto_part_stock_entries ENABLE ALWAYS TRIGGER auto_part_stock_immutable`,
        );
        await tx.execute(sql`DELETE FROM vehicle_maintenance_parts WHERE auto_part_id IN (${мои})`);
        await tx.execute(sql`DELETE FROM auto_parts WHERE name LIKE ${`${PART_MARK}%`}`);
      });
    });

    // ── 1. Аннулирование про расчёт, а не про склад (Р3) ──

    it('аннулирование акта со старым расходом не пишет ни одного движения склада', async () => {
      /*
       * РЕГРЕСС ЗАМОРОЗКИ, и он про исключение, которого больше нет. Раньше `voidMaintenance` звал
       * диффер с пустым набором: строки снимались, а на склад ложились возвраты. Обещание «склад не
       * двигается вовсе» с оговоркой «кроме аннулирования» не было бы обещанием — мёртвый склад
       * продолжал бы жить по чужому поводу, и остаток менялся бы у позиции, которой в портале нет.
       *
       * При этом сама ручка остаётся нужной, и вторая половина случая — про это: аннулирование
       * заведено ради РАСЧЁТА. Ошибочный акт, оставленный в журнале, был бы последним обслуживанием
       * машины, и «пробег с ТО» считался бы от ложного якоря.
       */
      const person = await newPerson('Заморозк');
      const vehicle = await newVehicle();
      const [d0, d1, d2, d3, d4] = series(ago(28), 5);
      const part = await newPart(10);

      await reportDay(person, vehicle, d0!, 99_900);
      const верный = await newAct(vehicle, { on: d1!, odometerKm: 100_000 });
      await reportDay(person, vehicle, d2!, 100_200);
      const ошибочный = await newAct(vehicle, {
        on: d3!,
        odometerKm: 100_300,
        documentNumber: 'АКТ-ошибочный',
      });
      // История: по этому акту когда-то списали три штуки — до заморозки, ручкой, которой больше нет.
      await addFrozenConsumption(ошибочный.id, part, 3);
      await reportDay(person, vehicle, d4!, 100_500);

      const движенияДо = await movementsOf(part.id);
      expect(движенияДо).toHaveLength(2);
      expect(await stockOf(part.id)).toBe(7);

      const до = await summaryOf(vehicle, d4!);
      expect(до.lastMaintenance?.id).toBe(ошибочный.id);
      expect(до.kmSince).toBe(200);

      const voided = await ctx.maintenance.voidMaintenance(
        ошибочный.id,
        { version: ошибочный.version, reason: 'акт составлен не на ту машину' },
        ctx.admin,
      );

      // ГЛАВНОЕ: журнал склада не прирос ни строкой, остаток не сдвинулся ни на единицу, и строка
      // документа осталась лежать — снять её было бы тем же движением склада.
      expect(await movementsOf(part.id), 'аннулирование двинуло замороженный склад').toEqual(
        движенияДо,
      );
      expect(await stockOf(part.id)).toBe(7);
      expect(await linesOf(ошибочный.id)).toEqual([{ partId: part.id, quantity: 3 }]);
      // И в аудите про возврат больше ни слова: возвращать нечего, а поле «returned» рассказывало бы
      // про движение, которого не было.
      const метаданные = await auditMeta(ошибочный.id, 'vehicleMaintenance.void');
      expect(метаданные.reason).toBe('акт составлен не на ту машину');
      expect(метаданные).not.toHaveProperty('returned');

      // Три поля одним состоянием: отметка, подпись и причина. Порознь они не бывают — это держат
      // `CHECK`и пары и причины.
      expect(voided.voidedAt).not.toBeNull();
      expect(voided.voidedByName).not.toBe('');
      expect(voided.voidReason).toBe('акт составлен не на ту машину');
      // Признак движений остался: они были и остались навсегда, и по нему портал объясняет, почему
      // этот акт не удаляют, а аннулируют.
      expect(voided.hasPartMovements).toBe(true);

      // Акт выпал из «последнего ТО» и из `kmSince`: якорем снова стал верный акт, и пробег
      // пересчитался сам — ни одно производное число не хранится.
      const после = await summaryOf(vehicle, d4!);
      expect(после.lastMaintenance?.id).toBe(верный.id);
      expect(после.kmSince).toBe(500);
      expect(после.state).toBe('ok');

      // Но из ИСТОРИИ он никуда не делся: на него ссылается журнал склада, и спрятать основание
      // движения значило бы оставить в замороженном журнале запись, которую нечем прочитать.
      const история = await ctx.maintenance.loadMaintenanceHistory(vehicle);
      expect(история.map((row) => row.id)).toContain(ошибочный.id);
      expect(история.find((row) => row.id === ошибочный.id)).toMatchObject({
        voidReason: 'акт составлен не на ту машину',
        hasPartMovements: true,
      });

      // Правка и повторное аннулирование — 409 со СВОИМ кодом: «откройте заново» тут не поможет,
      // документ закрыт навсегда, и исправление вводится новым актом.
      await expect(
        editAct({ id: ошибочный.id, version: voided.version }, { on: d3!, odometerKm: 100_300 }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'maintenance_voided' });
      await expect(
        ctx.maintenance.voidMaintenance(
          ошибочный.id,
          { version: voided.version, reason: 'ещё раз' },
          ctx.admin,
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'maintenance_voided' });
    }, 60_000);

    // ── 2. Старые движения по-прежнему держат акт (Р3) ──

    it('акт с движениями не удаляется — 409 словами про автозапчасти и RESTRICT при прямом DELETE', async () => {
      // Удаление остаётся ровно для акта, по которому движений не было: опечатку убирают как
      // раньше. Правило держит `RESTRICT` журнала, а проверка в сервисе стоит не вместо него, а
      // ПЕРЕД ним — чтобы человек прочитал, что делать вместо, а не что сломалось. Заморозка это
      // правило не отменяет: писать в журнал больше некому, а записанное раньше никуда не делось.
      const vehicle = await newVehicle();
      const part = await newPart(5);
      const сРасходом = await newAct(vehicle, { documentNumber: 'АКТ-с-расходом' });
      await addFrozenConsumption(сРасходом.id, part, 1);

      // Портал узнаёт правило ДО нажатия — по признаку полного DTO, а не из отказа после.
      const [запись] = await ctx.maintenance.loadMaintenanceHistory(vehicle);
      expect(запись?.hasPartMovements).toBe(true);

      await expect(
        ctx.maintenance.deleteMaintenance(сРасходом.id, сРасходом.version, ctx.admin),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'maintenance_has_stock_movements',
        message: expect.stringContaining('автозапчаст'),
      });

      const refusal = await dbRefusal(
        ctx.db.execute(sql`DELETE FROM vehicle_maintenance WHERE id = ${сРасходом.id}`),
      );
      expect(refusal.code).toBe('23503');
      expect(refusal.constraint).toBe('auto_part_stock_entries_maintenance_id_fkey');

      // Правка реквизитов такому акту по-прежнему доступна: неудаляем он, а не неприкосновенен.
      const правленый = await editAct(сРасходом, { documentNumber: 'АКТ-с-расходом-1' });
      expect(правленый.documentNumber).toBe('АКТ-с-расходом-1');
      expect(правленый.hasPartMovements).toBe(true);

      // Акт без движений удаляется по-прежнему, версией.
      const пустой = await newAct(vehicle, { documentNumber: 'АКТ-опечатка' });
      expect(пустой.hasPartMovements).toBe(false);
      await ctx.maintenance.deleteMaintenance(пустой.id, пустой.version, ctx.admin);
      expect(
        (await ctx.maintenance.loadMaintenanceHistory(vehicle)).map((row) => row.id),
      ).not.toContain(пустой.id);
    }, 60_000);

    // ── 3. Аудит акта пишется ТОЙ ЖЕ транзакцией (Р22 плана склада) ──

    it('искусственный сбой после записи аудита откатывает и аудит, и саму правку', async () => {
      /*
       * `writeAuditTx` отличается от общего `writeAudit` двумя свойствами, и оба здесь предмет
       * проверки: он берёт соединение ТРАНЗАКЦИИ и не глушит ошибку. Общий `writeAudit` пишет своим
       * соединением — его запись пережила бы откат и осталась бы в журнале рассказывать о правке,
       * которой не было.
       *
       * Сбой делается отложенным constraint-триггером на самом `audit_log`, и это не уловка, а
       * единственный способ упасть ПОСЛЕ записи аудита: отложенный триггер срабатывает на коммите,
       * то есть заведомо позже всего, что транзакция успела сделать. Триггер прицелен по
       * идентификатору нашего акта — соседние прогоны он не видит вовсе.
       *
       * Заодно случай доказывает, что аудит В ЭТОЙ ТРАНЗАКЦИИ ВООБЩЕ ПИШЕТСЯ: не пишись он, триггер
       * не сработал бы и правка прошла бы насквозь.
       */
      const vehicle = await newVehicle();
      const act = await newAct(vehicle, { documentNumber: 'АКТ-аудит' });
      const fn = `zz_test_audit_boom_${RUN}`;

      await ctx.db.execute(
        sql.raw(`
        CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          RAISE EXCEPTION 'ИСКУССТВЕННЫЙ СБОЙ ПОСЛЕ ЗАПИСИ АУДИТА' USING ERRCODE = 'check_violation';
        END
        $fn$`),
      );
      await ctx.db.execute(
        sql.raw(`
        CREATE CONSTRAINT TRIGGER ${fn} AFTER INSERT ON audit_log
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (NEW.entity_id = '${act.id}')
          EXECUTE FUNCTION ${fn}()`),
      );
      try {
        const refusal = await dbRefusal(editAct(act, { documentNumber: 'АКТ-аудит-2' }));
        expect(refusal.code).toBe('23514');
        expect(
          refusal.message,
          'аудит не писался вовсе — триггер не сработал, и правка прошла бы насквозь',
        ).toContain('ИСКУССТВЕННЫЙ СБОЙ ПОСЛЕ ЗАПИСИ АУДИТА');
      } finally {
        await ctx.db.execute(sql.raw(`DROP TRIGGER ${fn} ON audit_log`));
        await ctx.db.execute(sql.raw(`DROP FUNCTION ${fn}()`));
      }

      // Откатилось ВСЁ: строки аудита не осталось, реквизиты и версия акта прежние.
      const аудит = await ctx.db.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM audit_log
         WHERE entity_type = 'vehicleMaintenance' AND entity_id = ${act.id}
           AND action = 'vehicleMaintenance.update'`);
      expect(аудит.rows[0]!.c, 'запись аудита пережила откат — писал не `writeAuditTx`').toBe(0);
      const [целый] = await ctx.maintenance.loadMaintenanceHistory(vehicle);
      expect(целый?.documentNumber).toBe('АКТ-аудит');
      expect(целый?.version).toBe(act.version);

      // А в обычном ходе события аудит ПИШЕТСЯ — и заведение, и правка, и аннулирование поимённо.
      const ok = await editAct(act, { documentNumber: 'АКТ-аудит-3' });
      await ctx.maintenance.voidMaintenance(
        ok.id,
        { version: ok.version, reason: 'разбор аудита' },
        ctx.admin,
      );
      const действия = await ctx.db.execute<{ action: string }>(sql`
        SELECT action FROM audit_log
         WHERE entity_type = 'vehicleMaintenance' AND entity_id = ${act.id}
         ORDER BY created_at, action`);
      expect(действия.rows.map((r) => r.action).sort()).toEqual([
        'vehicleMaintenance.create',
        'vehicleMaintenance.update',
        'vehicleMaintenance.void',
      ]);
    }, 60_000);

    // ── 4. Сводка гаража: признак движений не превращает снапшот в N+1 (Р23 плана склада) ──

    it('число запросов снапшота не зависит ни от числа машин, ни от признака движений', async () => {
      /*
       * `VehicleMaintenanceDto` живёт не только в истории: КРАТКАЯ его половина входит в сводку, а
       * сводки приходят ПАЧКОЙ на всю видимую страницу гаража. Полный DTO стоит лишнего запроса —
       * признак `hasPartMovements` читается из журнала склада, — и склей мы два типа, каждое
       * открытие гаража спрашивало бы замороженный журнал ради колонки, которой нужны только дата и
       * состояние.
       *
       * Считаются запросы обёрткой вокруг `pool.query` — единственной двери, через которую drizzle
       * ходит в базу. Вывод делается не из абсолютного числа (оно зависит от того, как устроен
       * расчёт), а из его НЕИЗМЕННОСТИ при росте числа машин.
       */
      const { pool } = await import('../src/db/client');
      type RawQuery = (...args: unknown[]) => unknown;

      async function запросы<T>(run: () => Promise<T>): Promise<{ value: T; count: number }> {
        const original = pool.query as unknown as RawQuery;
        let count = 0;
        const spy: RawQuery = (...args) => {
          count += 1;
          return original.apply(pool, args);
        };
        pool.query = spy as unknown as typeof pool.query;
        try {
          return { value: await run(), count };
        } finally {
          pool.query = original as unknown as typeof pool.query;
        }
      }

      const part = await newPart(100);
      const vehicles = [await newVehicle(), await newVehicle(), await newVehicle()];
      const acts: VehicleMaintenanceDto[] = [];
      for (const vehicle of vehicles) {
        acts.push(await newAct(vehicle, { odometerKm: 50_000, documentNumber: 'АКТ-снапшот' }));
      }
      // У одного из актов — старое движение: сводке оно безразлично, а истории видно.
      await addFrozenConsumption(acts[0]!.id, part, 1);

      const одна = await запросы(() =>
        ctx.maintenance.loadMaintenanceSnapshot([vehicles[0]!], TODAY),
      );
      const все = await запросы(() => ctx.maintenance.loadMaintenanceSnapshot(vehicles, TODAY));
      expect(все.count, 'снапшот запрашивает базу на каждую машину — это и есть N+1').toBe(
        одна.count,
      );

      // И самое главное: в сводке признака движений НЕТ ВОВСЕ — не «ложь», а отсутствие поля.
      // `false` означал бы «движений не было», а это неправда: по этому акту они есть.
      const сводка = все.value.get(vehicles[0]!)!;
      expect(сводка.lastMaintenance?.id).toBe(acts[0]!.id);
      expect(сводка.lastMaintenance).not.toHaveProperty('hasPartMovements');
      expect(сводка.lastMaintenance).not.toHaveProperty('parts');
      // А история той же машины признак отдаёт — там акт открыт по одному, и по нему решают,
      // удалять его или аннулировать.
      expect(
        (await ctx.maintenance.loadMaintenanceHistory(vehicles[0]!))[0]!.hasPartMovements,
      ).toBe(true);
    }, 60_000);
  });
});
