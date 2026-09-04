import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  intakeLevel,
  moscowDateKeyOf,
  ODOMETER_JUMP_PER_DAY_KM,
  READING_OVERDUE_DAYS,
  shiftDateKey,
  type ReadingInput,
  type ReadingIntakeRow,
  type ReportItemSubmit,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';
import type * as IntakeNs from '../src/services/readings-intake';

/**
 * Реестр приёма показаний на живой схеме (план «Показания техники», §5, §6; Р5—Р9а, Р23, Р26, Р32).
 *
 * Зачем база. Реестр строится **от ожидаемых смен**, а не от строк ожидания (Р26), и главное его
 * утверждение выражено формой запроса: полным внешним объединением двух координат смены. Строка
 * дня, который никто не открывал, существует только там — в наборе; подменить это нечем.
 *
 * Данные заводятся сервисами модуля (`openReport`/`submitReport`/`acceptReport`), рейсами и
 * выписанными по ним листами, а не вставками в `driver_daily_report_items`. Тест на вставках
 * зеленел бы ровно тогда, когда портал начал бы врать: он согласовал бы реестр сам с собой, а не с
 * модулем, у которого «ожидаемая смена» и «расхождение» имеют смысл.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/readings-intake.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-readings-intake-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам». */
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: реестр приёма';
const MARK = `${MARK_PREFIX} ${randomUUID().slice(0, 8)}`;
/** Номера бланков — из заведомо свободного диапазона, свой блок на прогон. */
const WAYBILL_NUMBER_BASE = 930_000_000 + Math.floor(Math.random() * 900) * 1_000;

const TODAY = moscowDateKeyOf(new Date());

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof ReadingsNs;
  intake: typeof IntakeNs;
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

/** Хвосты прошлых прогонов — только заведомо мёртвые (старше часа): рядом идёт живой тест. */
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
      middleName: 'Приёмный',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** День от сегодняшнего назад: сценариям одной машины дни соседей безразличны, машины у них свои. */
function ago(days: number): string {
  return shiftDateKey(TODAY, -days);
}

// ── Фикстуры ──

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Приёмов', firstName, middleName: 'Тестович', comment: MARK })
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

/** Заявка-пустышка: рейсу она основание (колонка NOT NULL). */
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
 * листа рейс заданием не является — а ожидаемые смены реестр берёт по тому же правилу (Р26а).
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

/** Весь ввод идёт «за водителя»: половина дней отрезка старше водительского окна записи. */
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

/** Открыть день и сдать по нему одну строку. */
async function reportDay(personId: string, date: string, reading: ReadingInput): Promise<void> {
  const opened = await report(personId, date);
  expect(opened.items).toHaveLength(1);
  await submit(personId, date, [line(opened.items[0]!.id, reading)]);
}

// ── Чтение реестра ──

/**
 * Страница заведомо больше любого дня общей базы: реестр отвечает про **весь парк**, и строки
 * соседних прогонов в его ответе законны. Разрешённый схемой потолок (500) их бы обрезал, и тест
 * падал бы не на своём утверждении, а на чужих данных.
 */
const PAGE = { page: 1, pageSize: 1_000_000 };

/**
 * Реестр периода. Свойства строк проверяются на полном наборе, а листание — своим тестом.
 */
async function intakeOf(from: string, to: string, now?: Date) {
  return ctx.intake.loadReadingIntake({ from, to, ...PAGE }, now);
}

/** Строки своей машины: реестр отвечает про весь парк, и чужие строки в его ответе законны. */
function rowsOfVehicle(
  answer: { items: ReadingIntakeRow[] },
  vehicleId: string,
): ReadingIntakeRow[] {
  return answer.items.filter((row) => row.vehicleId === vehicleId);
}

function messages(row: ReadingIntakeRow): string[] {
  return row.issues.map((issue) => issue.message);
}

/** Коды пометок: по ним караул спрашивает наличие или отсутствие вида, а не формулировку. */
function codes(row: ReadingIntakeRow): string[] {
  return row.issues.map((issue) => issue.code);
}

describe.skipIf(!DB_URL)('реестр приёма: ожидаемые смены, пометки и пригодность к пакету', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/readings');
    const intake = await import('../src/services/readings-intake');
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
      intake,
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

  it('день, который никто не открывал, приходит виртуальной строкой: красной с просрочки', async () => {
    const person = await newPerson('Неоткрытый');
    const vehicle = await newVehicle();
    const late = ago(READING_OVERDUE_DAYS + 1);
    const fresh = ago(1);
    const lateRoute = await newRoute(vehicle, late, person);
    const freshRoute = await newRoute(vehicle, fresh, person);
    // `openReport` не зовётся намеренно (Р26): у водителя без учётки строк ожидания нет вовсе, а
    // показания с него ждут — и реестр, построенный по `driver_daily_report_items`, потерял бы
    // ровно тот день, ради которого экран и нужен.

    const answer = await intakeOf(late, fresh);
    const rows = rowsOfVehicle(answer, vehicle);
    expect(rows.map((row) => row.key).sort()).toEqual(
      [`route:${lateRoute}`, `route:${freshRoute}`].sort(),
    );

    const overdue = rows.find((row) => row.reportDate === late)!;
    // Строки ожидания нет, отчёта нет, показания нет — но смена есть, и её ждут четвёртый день.
    expect(overdue.itemId).toBeNull();
    expect(overdue.reportId).toBeNull();
    expect(overdue.reading).toBeNull();
    expect(overdue.personId).toBe(person);
    expect(intakeLevel(overdue.issues)).toBe('red');
    expect(messages(overdue)).toEqual([`нет показания ${READING_OVERDUE_DAYS + 1} дня`]);

    // До трёх дней та же строка жёлтая: ожидание — ещё не просрочка (Р6).
    const waiting = rows.find((row) => row.reportDate === fresh)!;
    expect(intakeLevel(waiting.issues)).toBe('yellow');
    expect(messages(waiting)).toEqual(['ждём показание']);

    // Отчётов у периода нет вовсе: приписывать виртуальную строку некому, и пакет пуст.
    expect(answer.reports.filter((r) => r.personName.includes('Неоткрытый'))).toEqual([]);
  });

  it('рейс без действующего листа в реестр не попадает', async () => {
    const person = await newPerson('Бездокументный');
    const vehicle = await newVehicle();
    const date = ago(2);
    await newRoute(vehicle, date, person, { documented: false });

    // Правило кабинета (ADR 0105, Р5; Р26а): рейс без листа заданием не является, и водитель его у
    // себя не видит. Реестр обязан отвечать тем же — иначе приём требовал бы показаний по сменам,
    // которых портал сам водителю не показывал.
    expect(await report(person, date)).toMatchObject({ items: [] });
    expect(rowsOfVehicle(await intakeOf(date, date), vehicle)).toEqual([]);
  });

  it('зелёная строка — пустой список пометок, а отчёт из зелёных строк пригоден к пакету', async () => {
    const person = await newPerson('Зелёный');
    const vehicle = await newVehicle();
    const date = ago(2);
    await newRoute(vehicle, date, person);
    await reportDay(person, date, values({ odometerKm: 1000, fuelFilledLiters: 30 }));

    const answer = await intakeOf(date, date);
    const [row] = rowsOfVehicle(answer, vehicle);
    // Зелёное — строго (Р6): числа есть, координаты сошлись, аномалий и расхождений нет. Пустой
    // список пометок и есть это утверждение: «зелёный» не пометка, а их отсутствие.
    expect(row!.issues).toEqual([]);
    expect(intakeLevel(row!.issues)).toBe('green');
    expect(row!.reading).toMatchObject({ kind: 'values', odometerKm: 1000, fuelFilledLiters: 30 });

    const report = answer.reports.find((r) => r.reportId === row!.reportId)!;
    expect(report).toMatchObject({ itemCount: 1, greenCount: 1, batchEligible: true });

    // Принятый отчёт из пакета выбывает: принять его второй раз нельзя, и предлагать это нечестно.
    const accepted = await ctx.service.acceptReport(report.reportId, report.version, ctx.adminId);
    expect(accepted.state).toBe('accepted');
    const after = await intakeOf(date, date);
    expect(after.reports.find((r) => r.reportId === report.reportId)).toMatchObject({
      state: 'accepted',
      greenCount: 1,
      batchEligible: false,
    });
  });

  it('неподтверждённая аномалия делает строку жёлтой, и в тексте стоят числа', async () => {
    const person = await newPerson('Аномальный');
    const vehicle = await newVehicle();
    const [first, second] = [ago(3), ago(2)];
    await newRoute(vehicle, first, person);
    await newRoute(vehicle, second, person);
    await reportDay(person, first, values({ odometerKm: 1000 }));
    // Прирост заведомо выше суточного порога и не подтверждён: модуль показаний поставил аномалию,
    // а реестр обязан назвать её числами (Р7), а не видом.
    const jump = ODOMETER_JUMP_PER_DAY_KM * 10;
    await reportDay(person, second, values({ odometerKm: 1000 + jump }));

    const rows = rowsOfVehicle(await intakeOf(second, second), vehicle);
    expect(rows).toHaveLength(1);
    expect(intakeLevel(rows[0]!.issues)).toBe('yellow');
    const text = messages(rows[0]!).join(' | ');
    expect(text).toContain(jump.toLocaleString('ru-RU'));
    expect(text).toContain(ODOMETER_JUMP_PER_DAY_KM.toLocaleString('ru-RU'));
    expect(text).toContain('за 1 день при пороге');
  });

  it('«нет возможности снять показания» — жёлтая с причиной, а не просрочка', async () => {
    const person = await newPerson('Беспоказательный');
    const vehicle = await newVehicle();
    const date = ago(5);
    await newRoute(vehicle, date, person);
    await reportDay(person, date, {
      kind: 'no_data',
      noDataReason: 'счётчик разбит',
      comment: '',
    });

    const [row] = rowsOfVehicle(await intakeOf(date, date), vehicle);
    // `no_data` — закрытие строки с причиной, а не пропуск: день старше трёх суток, и просрочкой
    // строка всё равно не становится.
    expect(intakeLevel(row!.issues)).toBe('yellow');
    expect(messages(row!)).toEqual(['нет возможности снять показания: счётчик разбит']);
  });

  it('неразобранное расхождение — жёлтая пометка с текстом, который собрал модуль показаний', async () => {
    const person = await newPerson('Расхожденский');
    const vehicle = await newVehicle();
    const [was, now] = [ago(1), TODAY];
    const routeId = await newRoute(vehicle, was, person);
    await reportDay(person, was, values({ odometerKm: 4000 }));

    // Диспетчер перенёс рейс на следующий день уже после того, как показание сдали (ADR 0101):
    // снимочная координата строки и живая координата источника разошлись (Р32).
    await ctx.db
      .update(ctx.schema.vehicleRoutes)
      .set({ routeDate: now })
      .where(eq(ctx.schema.vehicleRoutes.id, routeId));
    await ctx.db
      .update(ctx.schema.waybills)
      .set({ issuedForDate: now })
      .where(eq(ctx.schema.waybills.routeId, routeId));

    const answer = await intakeOf(was, now);
    const rows = rowsOfVehicle(answer, vehicle);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Строка стоит на живой координате — там, где показание теперь ждут (Р32а).
    expect(row.reportDate).toBe(now);
    expect(intakeLevel(row.issues)).toBe('yellow');
    // Текст пришёл готовым от модуля показаний (Р7): и подпись источника, и вид расхождения — его.
    expect(messages(row)).toEqual([
      `${row.sourceLabel}: источник перенесён на другую дату`,
      'ждём показание',
    ]);
    // Показание при этом никуда не делось: терять уже собранное нельзя, и строка его показывает.
    expect(row.reading).toMatchObject({ odometerKm: 4000 });
    // Отчёт с неразобранным расхождением в пакет не идёт — тот же ответ, что даст `acceptReport`.
    expect(answer.reports.find((r) => r.reportId === row.reportId)).toMatchObject({
      batchEligible: false,
      greenCount: 0,
    });
  });

  // ── Топливо в реестре и пометка «вечер не сдан» (ADR 0163, план гаража Р4) ──

  /*
   * Три числа топлива в строке реестра и новая пометка у утреннего показания. Числа приходят не
   * сами: `IntakeSqlRow` перечисляет колонки поимённо, а `readingOf` переносит их во вложенный
   * `VehicleReadingDto` — забудь любой из двух шагов, и пометка считалась бы по НЕПОЛНОМУ
   * показанию, то есть висела бы на строке, у которой остаток конца смены на самом деле есть.
   *
   * Сама пометка закрывает цену решения Р3 плана гаража: состояние дня считается по НАЛИЧИЮ строки
   * показания, а не по её полноте, и смена с одним утренним остатком выглядит для гаража сданной.
   * Дыру закрывает жёлтая строка реестра, а не новое состояние в базе и не блокер приёма.
   */
  it('утренний остаток: реестр отдаёт три числа топлива и ставит `shift_tail_missing`', async () => {
    const person = await newPerson('Утренний');
    const vehicle = await newVehicle();
    const date = ago(2);
    await newRoute(vehicle, date, person);
    await reportDay(person, date, values({ fuelStartLiters: 60 }));

    const [row] = rowsOfVehicle(await intakeOf(date, date), vehicle);
    // Все три числа топлива — в одном показании и порознь: уровень на концах смены и поток за неё.
    expect(row!.reading).toMatchObject({
      kind: 'values',
      fuelStartLiters: 60,
      fuelFilledLiters: null,
      fuelEndLiters: null,
      odometerKm: null,
      engineHours: null,
    });
    expect(codes(row!)).toEqual(['shift_tail_missing']);
    expect(messages(row!)).toEqual(['вечерние показания не переданы']);
    // Жёлтый, а не красный: день сдан честно, просто ещё не до конца.
    expect(intakeLevel(row!.issues)).toBe('yellow');

    /*
     * И то, ради чего пометка вообще что-то значит (план гаража, Р4): жёлтая строка выбивает отчёт
     * из ПАКЕТНОГО приёма. Ни блокера, ни запрета при этом не появляется — одиночный приём
     * проверяет `readings-accept-batch.db.test.ts`.
     */
    const answer = await intakeOf(date, date);
    const report = answer.reports.find((r) => r.reportId === row!.reportId)!;
    expect(report).toMatchObject({ itemCount: 1, greenCount: 0, batchEligible: false });
  });

  /*
   * Вторая ранняя половина условия — дневная заправка. Текст пометки нарочно не говорит «сдано
   * начало»: водитель мог передать только заправку, и подпись, называющая утренний остаток,
   * оказалась бы прямой неправдой на этой самой строке.
   */
  it('одна лишь заправка получает ту же пометку, и текст не говорит «сдано начало»', async () => {
    const person = await newPerson('Заправочный');
    const vehicle = await newVehicle();
    const date = ago(2);
    await newRoute(vehicle, date, person);
    await reportDay(person, date, values({ fuelFilledLiters: 40 }));

    const [row] = rowsOfVehicle(await intakeOf(date, date), vehicle);
    expect(row!.reading).toMatchObject({
      fuelFilledLiters: 40,
      fuelStartLiters: null,
      fuelEndLiters: null,
    });
    expect(codes(row!)).toEqual(['shift_tail_missing']);
    expect(messages(row!)).toEqual(['вечерние показания не переданы']);
    expect(messages(row!).join(' ')).not.toMatch(/начал/iu);
  });

  /*
   * Границы пометки со всех четырёх сторон разом: любое ОДНО число конца смены её снимает, `no_data`
   * её не получает, и строка без показания тоже — там уже стоит своя пометка, и вторая про тот же
   * пропуск была бы шумом. Проверять это порознь бессмысленно: условие в `readings-intake.ts`
   * одно, и ошибка в нём разъезжается сразу по всем случаям.
   */
  it('пометка не ставится: ни при числе конца смены, ни у `no_data`, ни там, где показания нет', async () => {
    const person = await newPerson('Границын');
    const date = ago(2);

    /** Любое одно число конца смены закрывает вечер: у техники их бывает по одному, а не по три. */
    const tails: [string, ReadingInput][] = [
      ['одометр', values({ fuelStartLiters: 60, odometerKm: 1000 })],
      ['моточасы', values({ fuelStartLiters: 60, engineHours: 12.5 })],
      ['остаток на конец', values({ fuelStartLiters: 60, fuelEndLiters: 18 })],
    ];
    for (const [what, reading] of tails) {
      // Работник и машина у каждого случая свои: день одного человека — один отчёт, и три машины в
      // нём пришлось бы разбирать по строкам, тогда как предмет проверки — вид показания.
      const driver = await newPerson(`Вечерний-${what}`);
      const vehicle = await newVehicle();
      await newRoute(vehicle, date, driver);
      await reportDay(driver, date, reading);

      const row = rowsOfVehicle(await intakeOf(date, date), vehicle)[0]!;
      expect(codes(row), what).not.toContain('shift_tail_missing');
      expect(intakeLevel(row.issues), what).toBe('green');
    }

    // `no_data` — закрытие строки с причиной, и чисел у него не бывает вовсе: «вечер не сдан» на
    // нём означало бы, что снять было чем.
    const closedVehicle = await newVehicle();
    await newRoute(closedVehicle, date, person);
    await reportDay(person, date, {
      kind: 'no_data',
      noDataReason: 'бак не читается',
      comment: '',
    });
    const closedRow = rowsOfVehicle(await intakeOf(date, date), closedVehicle)[0]!;
    expect(codes(closedRow)).toEqual(['no_data']);

    // А там, где показания нет вовсе, стоит своя пометка про ожидание, и вторая про тот же пропуск
    // была бы шумом: строка и так не зелёная.
    const emptyVehicle = await newVehicle();
    const emptyPerson = await newPerson('Несдавший');
    await newRoute(emptyVehicle, date, emptyPerson);
    await report(emptyPerson, date);
    const emptyRow = rowsOfVehicle(await intakeOf(date, date), emptyVehicle)[0]!;
    expect(emptyRow.reading).toBeNull();
    expect(codes(emptyRow)).toEqual(['waiting']);
  });

  it('«сегодня» считает сервер и по московскому дню', async () => {
    const person = await newPerson('Часовой');
    const vehicle = await newVehicle();
    // Даты абсолютные: утверждение о часовом поясе не должно зависеть от дня прогона.
    const date = '2026-08-12';
    await newRoute(vehicle, date, person);

    // 22:30 UTC — это уже 01:30 следующего дня в Москве: серверный день 15-е, ожиданию три дня, и
    // строка красная. Час назад по тем же данным день ещё 14-е, ожиданию два дня, и строка жёлтая.
    const past = new Date('2026-08-14T22:30:00Z');
    const later = await intakeOf('2026-08-10', '2026-08-16', past);
    expect(later.today).toBe('2026-08-15');
    expect(messages(rowsOfVehicle(later, vehicle)[0]!)).toEqual(['нет показания 3 дня']);

    const earlier = await intakeOf('2026-08-10', '2026-08-16', new Date('2026-08-14T20:30:00Z'));
    expect(earlier.today).toBe('2026-08-14');
    expect(messages(rowsOfVehicle(earlier, vehicle)[0]!)).toEqual(['ждём показание']);
  });

  it('пригодность к пакету не зависит от страницы, а страницы дают тот же список', async () => {
    const person = await newPerson('Многосменный');
    const vehicles = [await newVehicle(), await newVehicle(), await newVehicle()];
    // День выбран подальше от остальных сценариев файла, но внутри окна записи персонала: страницы
    // режутся по всему парку, и на людном дне первые три строки были бы чужими.
    const date = ago(20);
    for (const vehicle of vehicles) await newRoute(vehicle, date, person);

    const opened = await report(person, date);
    expect(opened.items).toHaveLength(3);
    // Одна строка из трёх без чисел: отчёт заведомо непригоден к пакету — и обязан оставаться
    // непригодным на КАЖДОЙ странице (Р9а).
    await submit(person, date, [
      line(opened.items[0]!.id, values({ odometerKm: 700 })),
      line(opened.items[1]!.id, values({ odometerKm: 800 })),
      line(opened.items[2]!.id, { kind: 'no_data', noDataReason: 'кабина опечатана', comment: '' }),
    ]);

    const whole = await ctx.intake.loadReadingIntake({ from: date, to: date, ...PAGE });
    const mine = whole.reports.find((r) => r.reportId === opened.id)!;
    expect(mine).toMatchObject({ itemCount: 3, greenCount: 2, batchEligible: false });

    /*
     * Страница взята меньше разрешённой схемой (50) намеренно: свойство проверяется ГРАНИЦЕЙ
     * страницы, а не числом 50, и разложить отчёт по страницам иначе значило бы завести полсотни
     * рейсов ради одного утверждения. Схему это не обходит — её проверяет ручка, а здесь спрашивают
     * сам расчёт.
     */
    const pages = [1, 2, 3].map((page) =>
      ctx.intake.loadReadingIntake({ from: date, to: date, page, pageSize: 1 }),
    );
    const [one, two, three] = await Promise.all(pages);
    for (const page of [one, two, three]) {
      // Счётчики отчёта одни и те же на всех страницах: они считаются по ВСЕМ строкам (Р9а), а не
      // по видимым. Считай их портал по странице — он предложил бы принять день, в котором с
      // невидимой страницы висит несданная смена.
      expect(page.reports.find((r) => r.reportId === opened.id)).toEqual(mine);
      expect(page.total).toBe(whole.total);
    }

    const keys = [one, two, three].flatMap((page) => page.items.map((row) => row.key));
    // Страницы не пересекаются и вместе дают тот же список в том же порядке.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(whole.items.slice(0, 3).map((row) => row.key));
  });
});
