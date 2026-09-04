import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  type ReadingInput,
  type ReportAcceptBatchDto,
  type ReportItemSubmit,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';
import type * as IntakeNs from '../src/services/readings-intake';

/**
 * Пакетный приём отчётов дня на живой схеме (план «Показания техники», Р8, Р9).
 *
 * Зачем база. Главное утверждение ручки — про транзакции: **каждый отчёт принимается в своей**, и
 * приём девяти не падает целиком из-за десятого, который успели поправить в соседней вкладке.
 * Подменой это не проверяется никак: подмена сервиса согласовала бы ручку с выдумкой о границах
 * транзакции, а вопрос как раз в том, что именно осталось в базе после отказа посередине.
 *
 * Второе утверждение — что причины отказа настоящие: тексты «Отчёт изменился…» и «Отчёт принять
 * нельзя: отчёт уже принят» рождает сам приём, и разбор по ним обязан сходиться с живым сервисом,
 * а не с константой в тесте.
 *
 * Данные заводятся сервисами модуля (`openReport`/`submitReport`), рейсами и выписанными по ним
 * листами, а не вставками в `driver_daily_report_items`: тест на вставках зеленел бы ровно тогда,
 * когда портал начал бы врать.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/readings-accept-batch.db.test.ts
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-readings-batch-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
/** Метка своих данных: база у db-тестов общая, и уборка идёт по ней, а не «по последним строкам». */
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: пакетный приём';
const MARK = `${MARK_PREFIX} ${randomUUID().slice(0, 8)}`;
/** Номера бланков — из заведомо свободного диапазона, свой блок на прогон. */
const WAYBILL_NUMBER_BASE = 940_000_000 + Math.floor(Math.random() * 900) * 1_000;

const TODAY = moscowDateKeyOf(new Date());
/** День внутри окна записи персонала (30 дней) и подальше от соседних сценариев показаний. */
const DAY = shiftDateKey(TODAY, -6);

/** Девять принимаемых плюс один, который успеют поправить, — ровно сценарий Р9. */
const GOOD_COUNT = 9;

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof ReadingsNs;
  intake: typeof IntakeNs;
  closeDb: () => Promise<void>;
  auth: { authorization: string };
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
      middleName: 'Пакетный',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

// ── Фикстуры ──

async function newPerson(index: number): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({
      lastName: 'Пакетов',
      firstName: `Водитель${index}`,
      middleName: 'Тестович',
      comment: MARK,
    })
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
    issuedForDate: DAY,
    routeId,
    issuedBy: ctx.adminId,
  });
}

/**
 * Рейс-перегон с выписанным листом: кабинет строго документален (ADR 0105, Р5), и без листа рейс
 * заданием не является — строки ожидания у отчёта не появится вовсе.
 */
async function newRoute(vehicleId: string, personId: string): Promise<void> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId,
      routeDate: DAY,
      purpose: 'delivery',
      sourceRequestId: await newRequest(),
      moveFrom: 'База',
      moveTo: 'Объект',
      driverPersonId: personId,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  await issueWaybillFor(route!.id, vehicleId, personId);
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

function line(itemId: string, odometerKm: number): ReportItemSubmit {
  return {
    itemId,
    reading: values(odometerKm),
    fileIds: [],
    confirmOdometerAnomaly: false,
    confirmEngineHoursAnomaly: false,
  };
}

/** Весь ввод идёт «за водителя»: учёток у людей фикстуры нет, а показания с них ждут (Р26). */
const STAFF = { mode: 'staff' as const };

/**
 * Показание с одним лишь остатком на начало смены (ADR 0163): утро сдано, вечер — нет. Своя
 * фикстура, а не `values()`: там одометр обязателен по сигнатуре, а здесь предмет проверки как раз
 * его отсутствие.
 */
function morningFuel(liters: number): ReadingInput {
  return {
    kind: 'values',
    odometerKm: null,
    engineHours: null,
    fuelStartLiters: liters,
    fuelFilledLiters: null,
    comment: '',
  } as ReadingInput;
}

/**
 * Отчёт дня с одной сданной строкой: единственное показание машины — первое в её цепочке, поэтому
 * аномалии сравнивать не с чем и день выходит зелёным целиком (Р6).
 */
async function greenReport(personId: string, odometerKm: number): Promise<void> {
  const opened = await ctx.service.openReport(personId, DAY, ctx.adminId, STAFF);
  expect(opened.items).toHaveLength(1);
  await ctx.service.submitReport(
    personId,
    DAY,
    { version: opened.version, items: [line(opened.items[0]!.id, odometerKm)], reason: '' },
    ctx.adminId,
    null,
    { ...STAFF, reason: '' },
  );
}

/** Правка чужого числа: у персонала причина обязательна, и она уезжает в историю показания. */
async function editReading(personId: string, odometerKm: number): Promise<void> {
  const current = (await ctx.service.loadReport(personId, DAY))!;
  await ctx.service.submitReport(
    personId,
    DAY,
    {
      version: current.version,
      items: [line(current.items[0]!.id, odometerKm)],
      reason: 'сверка с путевым листом',
    },
    ctx.adminId,
    null,
    { ...STAFF, reason: 'сверка с путевым листом' },
  );
}

async function reportOf(personId: string) {
  return (await ctx.service.loadReport(personId, DAY))!;
}

async function acceptBatch(reports: { id: string; version: number }[]) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/vehicle-readings/reports/accept-batch',
    headers: ctx.auth,
    payload: { reports },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ReportAcceptBatchDto>();
}

/** Люди дня: девять принимаемых и десятый, которого поправят между показом и приёмом. */
const persons: string[] = [];

describe.skipIf(!DB_URL)('пакетный приём отчётов дня на живой схеме', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/readings');
    const intake = await import('../src/services/readings-intake');
    const { buildApp } = await import('../src/app');
    await purgeStale(db);

    const adminId = await seedAdmin(db, schema);
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: ADMIN_EMAIL, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);

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
      app,
      db,
      schema,
      service,
      intake,
      closeDb,
      auth: { authorization: `Bearer ${login.json().accessToken}` },
      adminId,
      objectId: objects.rows[0].id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: seriesRows.rows[0].id,
    };

    /*
     * Водитель у каждой машины свой, и это не украшение фикстуры: отчёт дня принадлежит паре
     * «работник + день», и десять отчётов одного дня — это ровно десять человек за рулём.
     */
    for (let index = 0; index <= GOOD_COUNT; index += 1) {
      const person = await newPerson(index);
      persons.push(person);
      await newRoute(await newVehicle(), person);
      await greenReport(person, 10_000 + index);
    }
  }, 180_000);

  afterAll(async () => {
    if (ctx) {
      await ctx.app.close();
      await purge(ctx.db, MARK);
      await ctx.closeDb();
    }
  });

  it('девять отчётов приняты, десятый с устаревшей версией отказал — и не задел соседей', async () => {
    // Версии сняты так, как их видит экран приёма: реестр отдаёт их рядом с `batchEligible` (Р9а),
    // и в пакет уходит ровно то, что показали принимающему.
    const registry = await ctx.intake.loadReadingIntake({
      from: DAY,
      to: DAY,
      page: 1,
      pageSize: 500,
    });
    const shown = new Map(registry.reports.map((row) => [row.reportId, row]));
    const seen = await Promise.all(persons.map(reportOf));
    for (const report of seen) {
      expect(shown.get(report.id), 'зелёный отчёт дня обязан быть пригоден к пакету').toMatchObject(
        { batchEligible: true, version: report.version },
      );
    }

    // Десятый отчёт правят между показом и приёмом — то самое «успели поправить в соседней
    // вкладке», ради которого у каждого отчёта своя транзакция (Р9).
    const stale = seen.at(-1)!;
    await editReading(persons.at(-1)!, 12_345);
    expect((await reportOf(persons.at(-1)!)).version).toBeGreaterThan(stale.version);

    const answer = await acceptBatch(
      seen.map((report) => ({ id: report.id, version: report.version })),
    );

    // Девять приняты, и порядок ответа — порядок запроса: ответ читают рядом с реестром.
    expect(answer.accepted).toEqual(seen.slice(0, GOOD_COUNT).map((report) => report.id));
    expect(answer.failed).toEqual([
      { id: stale.id, code: 'version', reason: 'Отчёт изменился, обновите страницу и повторите' },
    ]);

    // В базе — то же самое: принятые приняты, и версия у каждого сдвинулась (приём пишет историю).
    const after = await Promise.all(persons.map(reportOf));
    for (let index = 0; index < GOOD_COUNT; index += 1) {
      expect(after[index]!.state, `отчёт №${index}`).toBe('accepted');
      expect(after[index]!.version).toBeGreaterThan(seen[index]!.version);
      expect(after[index]!.acceptedAt).not.toBeNull();
    }
    // Отказавший остался нетронутым: чужая транзакция его не откатила и не приняла.
    expect(after.at(-1)!.state).toBe('submitted');
    expect(after.at(-1)!.acceptedAt).toBeNull();
  });

  it('повтор пакета: принятые отвечают «уже принят», пропавший — «не найден», поправленный проходит', async () => {
    const fresh = await Promise.all(persons.map(reportOf));
    const gone = randomUUID();
    // Версии на этот раз свежие у всех: отказ «уже принят» приходит именно из проверки условий под
    // блокировками, а не из расхождения версий, — и текст у него другой.
    const answer = await acceptBatch([
      ...fresh.map((report) => ({ id: report.id, version: report.version })),
      { id: gone, version: 0 },
    ]);

    // Поправленный отчёт принимается свежей версией: отказ прошлого пакета его не испортил.
    expect(answer.accepted).toEqual([fresh.at(-1)!.id]);
    expect(answer.failed.map((row) => row.id)).toEqual([
      ...fresh.slice(0, GOOD_COUNT).map((report) => report.id),
      gone,
    ]);
    for (const row of answer.failed.slice(0, GOOD_COUNT)) {
      expect(row.code).toBe('blocked');
      expect(row.reason).toBe('Отчёт принять нельзя: отчёт уже принят');
    }
    expect(answer.failed.at(-1)).toEqual({
      id: gone,
      code: 'gone',
      reason: 'Отчёт дня не найден',
    });
  });

  /*
   * Жёлтая строка «вечерние показания не переданы» (ADR 0163, план гаража Р4) выбивает отчёт из
   * ПАКЕТА и только из него. Это и есть вся цена пометки — и вся её польза: пакет предлагают
   * нажатием на всё сразу, и день, о котором стоит подумать, туда попадать не должен; а диспетчер,
   * знающий, что вечерних чисел у этой машины не будет, принимает его одиночным приёмом и одним
   * нажатием. Ни блокера, ни запрета выпуск не добавляет (Р5), и караул охраняет обе половины
   * сразу: ужесточи кто-нибудь условия приёма — упадёт вторая, ослабь пригодность к пакету —
   * первая.
   *
   * Свой человек и своя машина: `persons` — люди двух пакетов выше, и лишняя строка в их списке
   * сдвинула бы ожидаемые ответы.
   */
  it('отчёт с недосданным вечером в пакет не попадает, но принимается одиночным приёмом', async () => {
    const person = await newPerson(GOOD_COUNT + 100);
    await newRoute(await newVehicle(), person);
    const opened = await ctx.service.openReport(person, DAY, ctx.adminId, STAFF);
    expect(opened.items).toHaveLength(1);
    await ctx.service.submitReport(
      person,
      DAY,
      {
        version: opened.version,
        items: [
          {
            itemId: opened.items[0]!.id,
            reading: morningFuel(60),
            fileIds: [],
            confirmOdometerAnomaly: false,
            confirmEngineHoursAnomaly: false,
          },
        ],
        reason: '',
      },
      ctx.adminId,
      null,
      { ...STAFF, reason: '' },
    );

    const submitted = await reportOf(person);
    const registry = await ctx.intake.loadReadingIntake({
      from: DAY,
      to: DAY,
      page: 1,
      pageSize: 500,
    });
    const shown = registry.reports.find((row) => row.reportId === submitted.id)!;
    expect(shown).toMatchObject({ itemCount: 1, greenCount: 0, batchEligible: false });
    expect(
      registry.items.find((row) => row.reportId === submitted.id)!.issues.map((i) => i.code),
    ).toEqual(['shift_tail_missing']);

    // Экран строит пакет из пригодных строк реестра — и этого отчёта в нём нет вовсе.
    expect(
      registry.reports.filter((row) => row.batchEligible).map((row) => row.reportId),
    ).not.toContain(submitted.id);

    // А одиночный приём проходит: блокеры приёма считают строки БЕЗ показания, и такая строка для
    // них закрыта.
    const accepted = await ctx.service.acceptReport(submitted.id, submitted.version, ctx.adminId);
    expect(accepted.state).toBe('accepted');
    expect(accepted.acceptedContentVersion).toBe(submitted.contentVersion);
  });
});
