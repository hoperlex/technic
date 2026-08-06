import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../src/db/migration-journal';
// Только типы: значения берутся через `await import` уже после того, как выставлено окружение.
import type { db as AppDb } from '../src/db/client';
import type * as DbSchema from '../src/db/schema';
import type {
  createRun as CreateRun,
  dueSchedules as DueSchedules,
  performRun as PerformRun,
} from '../src/services/mailings/run';

/**
 * Запуск рассылки на живой схеме (ADR 0075).
 *
 * Зачем база. Всё, ради чего заведён запуск, держится не кодом, а данными: уникальность
 * `(schedule_id, planned_at)` не даёт двум worker'ам развести двойную рассылку, а дедупликация
 * писем по `(kind, dedupe_key)` делает повтор упавшего запуска безопасным. Проверить это на
 * правилах нельзя — расходятся не правила, а код и схема, и цена расхождения здесь: водитель
 * получает два одинаковых задания либо не получает ни одного.
 *
 * Запуск:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_archive_test \
 *     pnpm --filter @technic/api test mailing-run
 */

const DB_URL = process.env.TEST_DATABASE_URL;

/** День рейсов — заведомо будущий: на «сегодня» рейсы заводят соседние тесты. */
const ROUTE_DATE = '2099-04-02';
/** Рассылка «вечером накануне»: 1 апреля 18:00 МСК — это 15:00 UTC. */
const PLANNED_AT = new Date('2099-04-01T15:00:00.000Z');

interface Ctx {
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  schema: typeof DbSchema;
  createRun: typeof CreateRun;
  performRun: typeof PerformRun;
  dueSchedules: typeof DueSchedules;
  userId: string;
  objectId: string;
  vehicleId: string;
  driverId: string;
  driverEmail: string;
  /** Водитель с рейсом, но без адреса: его считает статистика, письма ему не создаётся. */
  namelessDriverId: string;
  scheduleId: string;
}

let ctx: Ctx;
const createdRouteIds: string[] = [];
const createdRequestIds: string[] = [];

/** СНИЛС с верной контрольной суммой: база общая, номера наполнения в ней заняты. */
function makeSnils(): string {
  const digits = Array.from({ length: 9 }, (_, i) =>
    i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10),
  );
  const sum = digits.reduce((acc, digit, i) => acc + digit * (9 - i), 0);
  const rest = sum < 100 ? sum : sum % 101;
  const checksum = rest === 100 ? 0 : rest;
  return `${digits.join('')}${String(checksum).padStart(2, '0')}`;
}

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
  // Письма составляются в журнал и наружу не уходят: проверяется очередь, а не SMTP.
  process.env.MAIL_ENABLED = 'true';
  process.env.MAIL_TRANSPORT = 'log';
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

/** Рейс тестового водителя на дату — то, ради чего рассылка и существует. */
async function makeRoute(driverId: string): Promise<string> {
  const { schema } = ctx;
  const [request] = await ctx.db
    .insert(schema.vehicleRequests)
    .values({
      requestType: 'freight_transport',
      objectId: ctx.objectId,
      vehicleTypeId: (
        await ctx.db
          .select({ id: schema.vehicles.vehicleTypeId })
          .from(schema.vehicles)
          .where(eq(schema.vehicles.id, ctx.vehicleId))
      )[0]!.id,
      status: 'confirmed',
      createdBy: ctx.userId,
    })
    .returning({ id: schema.vehicleRequests.id });
  createdRequestIds.push(request!.id);

  await ctx.db.insert(schema.freightTransportRequestDetails).values({
    requestId: request!.id,
    scheduledAt: new Date(`${ROUTE_DATE}T05:30:00Z`),
    volumeM3: '5.000',
    loadingLocation: 'г Москва, ул Погрузочная, д 1',
    unloadingLocation: 'г Москва, ул Разгрузочная, д 2',
  });

  const [route] = await ctx.db
    .insert(schema.vehicleRoutes)
    .values({
      vehicleId: ctx.vehicleId,
      routeDate: ROUTE_DATE,
      purpose: 'freight',
      driverPersonId: driverId,
      createdBy: ctx.userId,
    })
    .returning({ id: schema.vehicleRoutes.id });
  createdRouteIds.push(route!.id);

  await ctx.db
    .insert(schema.vehicleRouteRequests)
    .values({ routeId: route!.id, requestId: request!.id, position: 1 });
  return route!.id;
}

async function mailCount(runId: string): Promise<number> {
  const res = await ctx.db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM mail_messages WHERE mailing_run_id = ${runId}`,
  );
  return Number(res.rows[0]?.count ?? '0');
}

async function runRow(runId: string) {
  const [row] = await ctx.db
    .select()
    .from(ctx.schema.mailingRuns)
    .where(eq(ctx.schema.mailingRuns.id, runId));
  return row;
}

describe.skipIf(!DB_URL)('запуск рассылки заданий (живая схема)', () => {
  const suffix = randomUUID().slice(0, 8);

  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const { createRun, performRun, dueSchedules } = await import('../src/services/mailings/run');

    const [user] = await db
      .insert(schema.users)
      .values({
        email: `db-run-${suffix}@example.invalid`,
        lastName: 'Тестовый',
        firstName: 'Диспетчер',
        middleName: '',
        passwordHash: 'db-test-not-a-hash',
        role: 'admin',
        isActive: true,
      })
      .returning({ id: schema.users.id });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({
        code: `RUN-${suffix}`,
        name: `Тестовая площадка (рассылка) ${suffix}`,
        address: 'г Москва, ул Объектная, д 3',
      })
      .returning({ id: schema.constructionObjects.id });

    const typeRes = await db.execute<{ id: string }>(sql`
      SELECT vt.id FROM vehicle_types vt
      JOIN vehicle_kinds vk ON vk.id = vt.kind_id
      WHERE vk.code = 'freight_transport'
      ORDER BY vt.name LIMIT 1`);
    const typeId = typeRes.rows[0]!.id;

    const [model] = await db
      .insert(schema.vehicleModels)
      .values({ vehicleTypeId: typeId, name: `Тестовая модель ${suffix}` })
      .returning({ id: schema.vehicleModels.id });
    const [vehicle] = await db
      .insert(schema.vehicles)
      .values({
        ownership: 'own',
        vehicleTypeId: typeId,
        vehicleModelId: model!.id,
        registrationNumber: `Х${suffix.slice(0, 3).toUpperCase()}999`,
        status: 'active',
      })
      .returning({ id: schema.vehicles.id });

    const driverEmail = `run-driver-${suffix}@example.invalid`;
    const [driver] = await db
      .insert(schema.persons)
      .values({
        lastName: `Рассылкин${suffix}`,
        firstName: 'Иван',
        middleName: 'Петрович',
        snils: makeSnils(),
        email: driverEmail,
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: запуск рассылки',
      })
      .returning({ id: schema.persons.id });
    const [nameless] = await db
      .insert(schema.persons)
      .values({
        lastName: `Безадресный${suffix}`,
        firstName: 'Пётр',
        middleName: 'Сергеевич',
        snils: makeSnils(),
        comment: 'ТЕСТОВЫЕ ДАННЫЕ: водитель без email',
      })
      .returning({ id: schema.persons.id });

    // Расписание вечернее, окно «завтра»: ровно тот случай, ради которого рассылка и заведена.
    const [schedule] = await db
      .insert(schema.mailingSchedules)
      .values({
        type: 'driver_routes',
        name: `Тестовая рассылка ${suffix}`,
        isEnabled: true,
        periodicity: 'daily',
        sendAt: '18:00',
        windowFromDays: 1,
        windowToDays: 1,
        createdBy: user!.id,
      })
      .returning({ id: schema.mailingSchedules.id });

    ctx = {
      db,
      closeDb,
      schema,
      createRun,
      performRun,
      dueSchedules,
      userId: user!.id,
      objectId: object!.id,
      vehicleId: vehicle!.id,
      driverId: driver!.id,
      driverEmail,
      namelessDriverId: nameless!.id,
      scheduleId: schedule!.id,
    };

    await makeRoute(driver!.id);
  }, 120_000);

  afterAll(async () => {
    if (!ctx) return;
    const { schema, db } = ctx;
    // Письма ссылаются на запуск через SET NULL, поэтому убираются отдельно и первыми.
    await db.execute(sql`DELETE FROM mail_messages WHERE to_email LIKE ${`%${suffix}%`}`);
    await db.delete(schema.mailingSchedules).where(eq(schema.mailingSchedules.id, ctx.scheduleId));
    if (createdRouteIds.length > 0) {
      await db.execute(
        sql`DELETE FROM vehicle_routes WHERE id IN ${sql.raw(`('${createdRouteIds.join("','")}')`)}`,
      );
    }
    if (createdRequestIds.length > 0) {
      await db.execute(
        sql`DELETE FROM vehicle_requests WHERE id IN ${sql.raw(`('${createdRequestIds.join("','")}')`)}`,
      );
    }
    await db.execute(sql`DELETE FROM vehicles WHERE id = ${ctx.vehicleId}`);
    await db.execute(sql`DELETE FROM vehicle_models WHERE name LIKE ${`%${suffix}%`}`);
    await db.execute(sql`DELETE FROM construction_objects WHERE id = ${ctx.objectId}`);
    await db.execute(sql`DELETE FROM persons WHERE comment LIKE 'ТЕСТОВЫЕ ДАННЫЕ:%' AND snils IN (
      SELECT snils FROM persons WHERE id IN (${ctx.driverId}, ${ctx.namelessDriverId}))`);
    await db.execute(sql`DELETE FROM users WHERE id = ${ctx.userId}`);
    await ctx.closeDb();
  });

  it('запуск ставит письмо водителю и записывает итоги', async () => {
    const runId = await ctx.createRun({ scheduleId: ctx.scheduleId, plannedAt: PLANNED_AT });
    expect(runId).not.toBeNull();

    const stats = await ctx.performRun(runId!);
    expect(stats.sent).toBe(1);

    expect(await mailCount(runId!)).toBe(1);
    const run = await runRow(runId!);
    expect(run?.status).toBe('done');
    // Границы данных записаны: повтор обязан взять те же дни, а не пересчитать окно от «сегодня».
    expect(run?.periodStart).toBe(ROUTE_DATE);
    expect(run?.periodEnd).toBe(ROUTE_DATE);
  });

  it('повторное выполнение того же запуска не создаёт второго письма', async () => {
    const [run] = await ctx.db
      .select({ id: ctx.schema.mailingRuns.id })
      .from(ctx.schema.mailingRuns)
      .where(eq(ctx.schema.mailingRuns.scheduleId, ctx.scheduleId));

    // Ключ письма включает запуск: второй заход по нему упирается в дедупликацию, а не шлёт дубль.
    await ctx.performRun(run!.id);
    expect(await mailCount(run!.id)).toBe(1);
  });

  it('второй worker на то же время запуска не создаёт: это держит уникальный индекс', async () => {
    const again = await ctx.createRun({ scheduleId: ctx.scheduleId, plannedAt: PLANNED_AT });
    expect(again).toBeNull();
  });

  it('создание запуска двигает расписание вперёд: иначе оно сработало бы снова', async () => {
    const [row] = await ctx.db
      .select({ nextRunAt: ctx.schema.mailingSchedules.nextRunAt })
      .from(ctx.schema.mailingSchedules)
      .where(eq(ctx.schema.mailingSchedules.id, ctx.scheduleId));
    expect(row?.nextRunAt).not.toBeNull();
    expect(row!.nextRunAt!.getTime()).toBeGreaterThan(PLANNED_AT.getTime());
  });

  it('исключённому водителю письма нет, и он виден в статистике', async () => {
    await ctx.db
      .insert(ctx.schema.mailingScheduleExcludedPersons)
      .values({ scheduleId: ctx.scheduleId, personId: ctx.driverId });

    const runId = await ctx.createRun({
      scheduleId: ctx.scheduleId,
      plannedAt: new Date(PLANNED_AT.getTime() + 60_000),
    });
    const stats = await ctx.performRun(runId!);

    expect(stats.excluded).toBe(1);
    expect(stats.sent).toBe(0);
    expect(await mailCount(runId!)).toBe(0);

    await ctx.db
      .delete(ctx.schema.mailingScheduleExcludedPersons)
      .where(eq(ctx.schema.mailingScheduleExcludedPersons.scheduleId, ctx.scheduleId));
  });

  it('водитель без адреса считается отдельно: это пробел справочника, а не сбой рассылки', async () => {
    await makeRoute(ctx.namelessDriverId);

    const runId = await ctx.createRun({
      scheduleId: ctx.scheduleId,
      plannedAt: new Date(PLANNED_AT.getTime() + 120_000),
    });
    const stats = await ctx.performRun(runId!);

    expect(stats.withoutEmail).toBe(1);
    // Тому, у кого адрес есть, письмо при этом уходит: один пробел не отменяет всю рассылку.
    expect(stats.sent).toBe(1);
  });

  it('исключённая дата рейсов оставляет рассылку, но вычитает день из письма', async () => {
    await ctx.db
      .insert(ctx.schema.mailingScheduleExcludedDates)
      .values({ scheduleId: ctx.scheduleId, kind: 'route', excludedOn: ROUTE_DATE });

    const runId = await ctx.createRun({
      scheduleId: ctx.scheduleId,
      plannedAt: new Date(PLANNED_AT.getTime() + 180_000),
    });
    const stats = await ctx.performRun(runId!);

    // Рейсов после вычета не осталось — письма нет, и это состояние «пусто», а не «ошибка».
    expect(stats.sent).toBe(0);
    expect(stats.empty).toBeGreaterThan(0);

    await ctx.db
      .delete(ctx.schema.mailingScheduleExcludedDates)
      .where(eq(ctx.schema.mailingScheduleExcludedDates.scheduleId, ctx.scheduleId));
  });

  it('выключенное расписание планировщик не будит', async () => {
    await ctx.db
      .update(ctx.schema.mailingSchedules)
      .set({ isEnabled: false, nextRunAt: new Date('2000-01-01T00:00:00Z') })
      .where(eq(ctx.schema.mailingSchedules.id, ctx.scheduleId));

    const due = await ctx.dueSchedules(new Date());
    expect(due.some((d) => d.id === ctx.scheduleId)).toBe(false);

    await ctx.db
      .update(ctx.schema.mailingSchedules)
      .set({ isEnabled: true })
      .where(eq(ctx.schema.mailingSchedules.id, ctx.scheduleId));

    const dueAgain = await ctx.dueSchedules(new Date());
    expect(dueAgain.some((d) => d.id === ctx.scheduleId)).toBe(true);
  });
});
