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
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
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

/** Акт обслуживания — тем же сервисом, каким его заводит ручка. */
async function addMaintenance(vehicleId: string, performedOn: string, odometerKm: number | null) {
  return ctx.maintenance.createMaintenance(
    vehicleId,
    { performedOn, odometerKm, documentNumber: `АКТ-${performedOn}`, note: '', fileIds: [] },
    ctx.adminId,
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
      ctx.adminId,
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
        ctx.adminId,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'version_conflict' });
    expect(
      (await ctx.maintenance.loadMaintenanceHistory(vehicle)).map((row) => row.odometerKm),
    ).toEqual([2_000, 1_800, 1_000]);

    // Удаление — та же оптимистическая блокировка: чужой версией запись не унести.
    await expect(
      ctx.maintenance.deleteMaintenance(last.id, last.version + 5, ctx.adminId),
    ).rejects.toMatchObject({ statusCode: 409 });
    await ctx.maintenance.deleteMaintenance(last.id, last.version, ctx.adminId);
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
      ctx.adminId,
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
      ctx.adminId,
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
      ctx.adminId,
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
});
