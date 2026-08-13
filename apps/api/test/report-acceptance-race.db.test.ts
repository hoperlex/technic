import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  type DriverReportDto,
  type ReadingInput,
  type ReportItemSubmit,
} from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type * as ReadingsService from '../src/services/readings';

/**
 * Граница гарантии приёма (ADR 0103, план Р22) — на живой схеме и во встречных транзакциях.
 *
 * Приём обещает ровно одно и отказывается обещать большее, и обе половины проверяются здесь.
 *
 * ЧТО ГАРАНТИРУЕТСЯ. Всё, что описано снимком отчёта: источники его строк берутся `FOR SHARE`, и
 * рейс, переназначенный между показом кнопки и записью, приём не пропустит — он дождётся чужой
 * транзакции и пересчитает расхождения под блокировками. Проверить это одной транзакцией нельзя в
 * принципе: предмет — встречная правка, и второе соединение здесь не декорация, а сам сценарий.
 *
 * ЧТО НЕ ГАРАНТИРУЕТСЯ. Полнота состава после приёма: источник, у которого строки в отчёте нет,
 * заблокировать нечем. Рейс, заведённый этому человеку на этот день секундой позже, принятый день
 * не откатывает — он делает его красным по `missing_source`, и разбирают его как расхождение, а не
 * как гонку. Это заявленная граница, и тест закрепляет именно её: молчаливого отката быть не
 * должно, красноты — должно.
 *
 * Запуск (миграции тест накатывает сам):
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     npx vitest run apps/api/test/report-acceptance-race.db.test.ts
 *
 * Без `TEST_DATABASE_URL` файл пропускается — как и остальные `*.db.test.ts`.
 */

const DB_URL = process.env.TEST_DATABASE_URL;

const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
const ADMIN_EMAIL = `db-accept-race-${RUN}@example.invalid`;
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: граница гарантии приёма';

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  readings: typeof ReadingsService;
  userId: string;
  objectId: string;
  vehicleTypeId: string;
  modelId: string;
  /** Чужой работник: ему переназначают рейс встречной транзакцией. */
  strangerId: string;
  today: string;
}

let ctx: Ctx;

const created = {
  personIds: [] as string[],
  vehicleIds: [] as string[],
  routeIds: [] as string[],
  requestIds: [] as string[],
};

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

function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
}

async function makeDriver(lastName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({
      lastName: `${lastName}${RUN}`,
      firstName: 'Семён',
      middleName: 'Игоревич',
      snils: makeSnils(),
      comment: PERSON_MARK,
    })
    .returning({ id: ctx.schema.persons.id });
  created.personIds.push(person!.id);
  return person!.id;
}

async function makeVehicle(): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership: 'own',
      vehicleTypeId: ctx.vehicleTypeId,
      vehicleModelId: ctx.modelId,
      registrationNumber: `У${randomUUID().slice(0, 6).toUpperCase()}ГЦ${created.vehicleIds.length}77`,
      status: 'active',
    })
    .returning({ id: ctx.schema.vehicles.id });
  created.vehicleIds.push(vehicle!.id);
  return vehicle!.id;
}

async function makeRoute(opts: {
  vehicleId: string;
  personId: string;
  date: string;
}): Promise<string> {
  const { schema } = ctx;
  const [request] = await ctx.db
    .insert(schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.vehicleTypeId,
      status: 'confirmed',
      createdBy: ctx.userId,
    })
    .returning({ id: schema.vehicleRequests.id });
  created.requestIds.push(request!.id);
  await ctx.db.insert(schema.freightTransportRequestDetails).values({
    requestId: request!.id,
    scheduledAt: new Date(`${opts.date}T05:30:00Z`),
    volumeM3: '10.000',
    loadingLocation: 'г Москва, ул Погрузочная, д 5',
    unloadingLocation: 'г Москва, ул Разгрузочная, д 6',
  });

  const [route] = await ctx.db
    .insert(schema.vehicleRoutes)
    .values({
      vehicleId: opts.vehicleId,
      routeDate: opts.date,
      purpose: 'freight',
      driverPersonId: opts.personId,
      createdBy: ctx.userId,
    })
    .returning({ id: schema.vehicleRoutes.id });
  created.routeIds.push(route!.id);
  await ctx.db
    .insert(schema.vehicleRouteRequests)
    .values({ routeId: route!.id, requestId: request!.id, position: 1 });
  return route!.id;
}

function odometer(km: number): ReadingInput {
  return { kind: 'values', odometerKm: km, engineHours: null, fuelFilledLiters: null, comment: '' };
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

function itemOf(report: DriverReportDto, sourceId: string) {
  const item = report.items.find((i) => i.sourceId === sourceId);
  if (!item) throw new Error(`в отчёте нет строки по источнику ${sourceId}`);
  return item;
}

/** Сданный день с одной закрытой строкой — исходное состояние обоих сценариев. */
async function submitDay(personId: string, routeId: string, km: number): Promise<DriverReportDto> {
  const opened = await ctx.readings.openReport(personId, ctx.today, ctx.userId);
  return ctx.readings.submitReport(
    personId,
    ctx.today,
    {
      version: opened.version,
      items: [line(itemOf(opened, routeId).id, odometer(km))],
      reason: '',
    },
    ctx.userId,
    null,
  );
}

async function failure(
  promise: Promise<unknown>,
): Promise<{ statusCode: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode: number; message: string };
  }
  throw new Error('ожидался отказ, но операция прошла');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!DB_URL)('приём дня: что он гарантирует и что нет (живая схема)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const readings = await import('../src/services/readings');

    const [user] = await db
      .insert(schema.users)
      .values({
        email: ADMIN_EMAIL,
        lastName: 'Тестовый',
        firstName: 'Диспетчер',
        middleName: 'Гоночный',
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `яя-accept-race-${RUN}`,
        name: `Тестовая площадка (гонка приёма) ${RUN}`,
        address: 'г Москва, ул Объектная, д 3',
      })
      .returning({ id: schema.constructionObjects.id });

    const typeRes = await db.execute<{ id: string }>(sql`
      SELECT vt.id FROM vehicle_types vt
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE vk.code = 'freight_transport'
      ORDER BY vt.name
      LIMIT 1`);
    const vehicleTypeId = typeRes.rows[0]?.id;
    if (!vehicleTypeId) throw new Error('В базе нет грузового типа ТС: наполнение не применено');

    const [model] = await db
      .insert(schema.vehicleModels)
      .values({ vehicleTypeId, name: `Тестовый тентованный ${RUN}` })
      .returning({ id: schema.vehicleModels.id });

    ctx = {
      db,
      closeDb,
      schema,
      readings,
      userId: user!.id,
      objectId: object!.id,
      vehicleTypeId,
      modelId: model!.id,
      strangerId: '',
      today: moscowDateKeyOf(new Date()),
    };
    ctx.strangerId = await makeDriver('Встречн');
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { schema, db } = ctx;
    if (created.personIds.length > 0) {
      await db
        .delete(schema.driverDailyReports)
        .where(inArray(schema.driverDailyReports.personId, created.personIds));
    }
    if (created.routeIds.length > 0) {
      await db
        .delete(schema.vehicleRoutes)
        .where(inArray(schema.vehicleRoutes.id, created.routeIds));
    }
    if (created.requestIds.length > 0) {
      await db
        .delete(schema.vehicleRequests)
        .where(inArray(schema.vehicleRequests.id, created.requestIds));
    }
    if (created.vehicleIds.length > 0) {
      await db.delete(schema.vehicles).where(inArray(schema.vehicles.id, created.vehicleIds));
    }
    await db.delete(schema.vehicleModels).where(eq(schema.vehicleModels.id, ctx.modelId));
    if (created.personIds.length > 0) {
      await db.delete(schema.persons).where(inArray(schema.persons.id, created.personIds));
    }
    await db
      .delete(schema.constructionObjects)
      .where(eq(schema.constructionObjects.id, ctx.objectId));
    await db.delete(schema.users).where(eq(schema.users.id, ctx.userId));
    await ctx.closeDb();
  });

  it('рейс из состава, переназначенный между проверкой и записью, принять день не даёт', async () => {
    const person = await makeDriver('Ожидан');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const submitted = await submitDay(person, route, 2500);
    expect(submitted.canAccept).toBe(true);

    // Встречная транзакция: диспетчер переназначает рейс и держит строку рейса заблокированной.
    const rival = new pg.Client({ connectionString: DB_URL! });
    await rival.connect();
    try {
      await rival.query('BEGIN');
      await rival.query('UPDATE vehicle_routes SET driver_person_id = $1 WHERE id = $2', [
        ctx.strangerId,
        route,
      ]);

      // Приём видел версию, при которой принимать было можно, — и всё же обязан дождаться чужой
      // транзакции: источники строк он берёт `FOR SHARE`, а условия перепроверяет под блокировками.
      const accepting = failure(
        ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId),
      );
      // Пока чужая транзакция открыта, приём стоит на блокировке источника, а не проходит мимо:
      // проверяется именно это — что операция ЖДЁТ, а не что она уже успела отказать.
      const WAITING = Symbol('приём ждёт источник');
      expect(await Promise.race([accepting, sleep(300).then(() => WAITING)])).toBe(WAITING);
      const stillSubmitted = await ctx.db
        .select({ state: ctx.schema.driverDailyReports.state })
        .from(ctx.schema.driverDailyReports)
        .where(eq(ctx.schema.driverDailyReports.id, submitted.id));
      expect(stillSubmitted[0]?.state).toBe('submitted');

      await rival.query('COMMIT');
      const denied = await accepting;
      expect(denied.statusCode).toBe(409);
      expect(denied.message).toContain('не разобрано расхождений: 1');
    } finally {
      await rival.query('ROLLBACK').catch(() => undefined);
      await rival.end();
    }

    const after = await ctx.readings.loadReportById(submitted.id);
    expect(after.state).toBe('submitted');
    expect(after.discrepancies).toMatchObject([{ kind: 'driver', resolved: false }]);
  });

  it('рейс, заведённый после приёма, день не откатывает, а делает его красным по составу', async () => {
    const person = await makeDriver('Позднев');
    const route = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });
    const submitted = await submitDay(person, route, 2600);
    const accepted = await ctx.readings.acceptReport(submitted.id, submitted.version, ctx.userId);
    expect(accepted.state).toBe('accepted');

    // Секундой позже диспетчер заводит этому человеку второй рейс на тот же день. Заблокировать
    // источник, которого в отчёте нет, приёму было нечем — и это названная граница гарантии.
    const late = await makeRoute({
      vehicleId: await makeVehicle(),
      personId: person,
      date: ctx.today,
    });

    const red = await ctx.readings.loadReportById(accepted.id);
    // Принятое не откатывается молча: состояние и принятая редакция те же.
    expect(red.state).toBe('accepted');
    expect(red.acceptedContentVersion).toBe(accepted.acceptedContentVersion);
    expect(red.contentVersion).toBe(accepted.contentVersion);
    // Но день красный: источник дня не вошёл в отчёт, и это расхождение, а не гонка.
    expect(red.discrepancies).toMatchObject([
      { kind: 'missing_source', sourceId: late, resolved: false },
    ]);
    expect(red.canAccept).toBe(false);

    // Разбор возвращает день в оборот: добавленный источник переводит принятый отчёт на повторный
    // приём — ровно так же, как если бы рейс завели через час после приёмки.
    const reopened = await ctx.readings.resolveDiscrepancy(
      red.id,
      {
        kind: 'missing_source',
        itemId: null,
        sourceKind: 'route',
        sourceId: late,
        fingerprint: red.discrepancies[0]!.fingerprint,
        resolution: 'source_added',
        reason: 'рейс завели после приёмки, показание сдаётся отдельно',
        version: red.version,
      },
      ctx.userId,
    );
    expect(reopened.state).toBe('needs_reacceptance');
    expect(reopened.items.map((i) => i.sourceId)).toContain(late);
    expect(reopened.acceptedContentVersion).toBe(accepted.acceptedContentVersion);
    expect(reopened.contentVersion).toBe(accepted.contentVersion + 1);
    expect(reopened.blockers.join('; ')).toContain('не закрыто строк: 1');
  });
});
