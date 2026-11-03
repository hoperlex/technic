import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type IdleReason,
  type ReadingInput,
  type ReportItemSubmit,
} from '@technic/contracts';
import type * as Contracts from '@technic/contracts';
import { applyMigrations } from '../src/db/migration-journal';
// Types only: the values are imported after the environment is set — the config validates it on
// import and fails without it.
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';
import type * as AggregateNs from '../src/services/readings-aggregate';
import type * as ExpectedNs from '../src/services/readings-expected';
import type * as IntakeNs from '../src/services/readings-intake';
import type * as IdleNs from '../src/services/readings-idle';
import type * as StatsNs from '../src/services/readings-stats';
import type * as AssignmentNs from '../src/services/driver-assignment';

/**
 * «Не работал» in the ledger and in the garage (ADR 0244, plan docs/rest-days-plan.md §4.1, §4.3).
 *
 * The write was closed in release 1A (`IDLE_READINGS_OPEN = false`) and is open since 1B; the suite
 * sets the switch through the contracts module where a case depends on it, and checks the refusal
 * with the switch closed.
 *
 * Every scenario lives in the week that holds `day(0)`, Monday to Wednesday: a Sunday is a rest day
 * (ADR 0242) and would exempt the very shift a scenario is about. Each scenario has its own vehicle
 * and person, so they share the dates without touching each other.
 */

const idleGate = vi.hoisted(() => ({ open: null as boolean | null }));
vi.mock('@technic/contracts', async (importOriginal) => {
  const original = await importOriginal<typeof Contracts>();
  return {
    ...original,
    get IDLE_READINGS_OPEN() {
      return idleGate.open ?? original.IDLE_READINGS_OPEN;
    },
  };
});

const DB_URL = process.env.TEST_DATABASE_URL;

const ADMIN_EMAIL = 'db-readings-idle-admin@example.invalid';
const PASSWORD = 'db-test-password-123';
const MARK_PREFIX = 'ТЕСТОВЫЕ ДАННЫЕ: не работал';
const MARK = `${MARK_PREFIX} ${randomUUID().slice(0, 8)}`;
const WAYBILL_NUMBER_BASE = 930_000_000 + Math.floor(Math.random() * 900) * 1_000;

interface Ctx {
  db: typeof AppDb;
  schema: typeof SchemaNs;
  service: typeof ReadingsNs;
  aggregate: typeof AggregateNs;
  expected: typeof ExpectedNs;
  intake: typeof IntakeNs;
  idle: typeof IdleNs;
  stats: typeof StatsNs;
  assignment: typeof AssignmentNs;
  closeDb: () => Promise<void>;
  adminId: string;
  objectId: string;
  typeId: string;
  organizationId: string;
  seriesId: string;
  monday: string;
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

/** Reports first (their rows, readings and histories cascade), then papers, requests, vehicles. */
async function purge(db: typeof AppDb, mark: string): Promise<void> {
  const persons = sql`(SELECT id FROM persons WHERE comment = ${mark})`;
  await db.execute(sql`DELETE FROM driver_daily_reports WHERE person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM waybills WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_routes WHERE driver_person_id IN ${persons}`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${mark}`);
  await db.execute(sql`DELETE FROM vehicles WHERE note = ${mark}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${mark}`);
}

/** Leftovers of dead runs only (older than an hour): a run going on next to this one is alive. */
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
      middleName: 'Простойный',
      passwordHash: await hashPassword(PASSWORD),
      role: 'admin',
      isActive: true,
    })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Monday, Tuesday, Wednesday… of the scenario week. */
const weekday = (index: number): string => shiftDateKey(ctx.monday, index);

async function newPerson(firstName: string): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Простоев', firstName, middleName: 'Тестович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  return person!.id;
}

async function newVehicle(): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({ ownership: 'own', vehicleTypeId: ctx.typeId, status: 'active', note: MARK })
    .returning({ id: ctx.schema.vehicles.id });
  return vehicle!.id;
}

async function newRequest(): Promise<{ id: string; num: number }> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.typeId,
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id, num: ctx.schema.vehicleRequests.num });
  return { id: request!.id, num: request!.num! };
}

async function issueWaybillFor(routeId: string, vehicleId: string, personId: string, date: string) {
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

/** A delivery route with its paper: a trip of its own (`routeHasTripSql`). */
async function newDelivery(vehicleId: string, date: string, personId: string): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId,
      routeDate: date,
      purpose: 'delivery',
      sourceRequestId: (await newRequest()).id,
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
 * A weekly ESM-2 from Monday to Sunday of the scenario week, for the given request.
 *
 * ЭСМ2-РАЗРЕЗ: the week only gives Monday–Wednesday an ESM-2 source; every assertion reads a day,
 * a counter pair or the intake rows of a day, and segments after the read switch serve the same.
 */
async function newEsm2(vehicleId: string, personId: string, requestId: string): Promise<string> {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.seriesId,
      number: WAYBILL_NUMBER_BASE + waybillNo,
      formCode: 'esm2',
      organizationId: ctx.organizationId,
      vehicleId,
      driverPersonId: personId,
      issuedForDate: ctx.monday,
      sourceRequestId: requestId,
      periodFrom: ctx.monday,
      periodTo: shiftDateKey(ctx.monday, 6),
      issuedBy: ctx.adminId,
      status: 'issued',
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

/**
 * A freight route of the day with composition rows: `site` rows carry the day (`work_date`), the
 * kind the ESM-2 of the same request suppresses (ADR 0207); a `freight` row has no day — a trip.
 */
async function newSharedRoute(
  vehicleId: string,
  date: string,
  personId: string,
  rows: { requestId: string; site: boolean }[],
): Promise<string> {
  const [route] = await ctx.db
    .insert(ctx.schema.vehicleRoutes)
    .values({
      vehicleId,
      routeDate: date,
      purpose: 'freight',
      driverPersonId: personId,
      createdBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.vehicleRoutes.id });
  await ctx.db.insert(ctx.schema.vehicleRouteRequests).values(
    rows.map((row, index) => ({
      routeId: route!.id,
      requestId: row.requestId,
      position: index + 1,
      workDate: row.site ? date : null,
    })),
  );
  await issueWaybillFor(route!.id, vehicleId, personId, date);
  return route!.id;
}

/** The site's own hours of a request day, signed. */
async function signHours(requestId: string, date: string, hours: number): Promise<void> {
  await ctx.db.insert(ctx.schema.vehicleRequestShifts).values({
    requestId,
    shiftDate: date,
    machineHours: hours.toFixed(2),
    comment: hours > 0 ? '' : 'дождь',
    filledBy: ctx.adminId,
    approvedBy: ctx.adminId,
    approvedAt: new Date(),
  });
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

const idle = (idleReason: IdleReason = 'day_off', comment = ''): ReadingInput => ({
  kind: 'idle',
  idleReason,
  comment,
});

function line(itemId: string, reading: ReadingInput): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: [],
    confirmOdometerAnomaly: true,
    confirmEngineHoursAnomaly: true,
  };
}

const STAFF = { mode: 'staff' as const };

async function open(personId: string, date: string) {
  return ctx.service.openReport(personId, date, ctx.adminId, STAFF);
}

async function submit(personId: string, date: string, items: ReportItemSubmit[], reason = '') {
  const current = await ctx.service.loadReport(personId, date);
  return ctx.service.submitReport(
    personId,
    date,
    { version: current!.version, items, reason },
    ctx.adminId,
    null,
    { ...STAFF, reason },
  );
}

/** Open the day and send one reading for its only (or given) row. */
async function sendDay(
  personId: string,
  date: string,
  reading: ReadingInput,
  pick: (items: { id: string; sourceKind: string }[]) => string = (items) => items[0]!.id,
) {
  const opened = await open(personId, date);
  return submit(personId, date, [line(pick(opened.items), reading)]);
}

async function intakeRowsOf(vehicleId: string, date: string) {
  const intake = await ctx.intake.loadReadingIntake({
    from: date,
    to: date,
    page: 1,
    pageSize: 1000,
  });
  return { rows: intake.items.filter((row) => row.vehicleId === vehicleId), intake };
}

/** A working mark on a request's Sunday (ADR 0246), as the card's switch leaves it. */
async function markSunday(requestId: string, date: string): Promise<void> {
  await ctx.db
    .insert(ctx.schema.vehicleRequestWorkingDays)
    .values({ requestId, workDate: date, setBy: ctx.adminId });
}

/** Whether the garage's «не сданы» filter keeps the vehicle on the day. */
async function isPending(date: string, vehicleId: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: ctx.schema.vehicles.id })
    .from(ctx.schema.vehicles)
    .where(sql`${ctx.schema.vehicles.id} = ${vehicleId} AND ${ctx.stats.pendingReadingsSql(date)}`);
  return rows.length > 0;
}

/** The cabinet's word on each source of the day: `true` when the shift is optional. */
async function optionalOf(personId: string, date: string): Promise<Record<string, boolean>> {
  const entries = await ctx.assignment.loadDayEntries(personId, date);
  return Object.fromEntries(entries.map((e) => [e.sourceKind, e.readingOptional === true]));
}

describe.skipIf(!DB_URL)('показания: «Не работал» (ADR 0244)', () => {
  beforeAll(async () => {
    prepareEnv(DB_URL!);
    await migrate(DB_URL!);

    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const service = await import('../src/services/readings');
    const aggregate = await import('../src/services/readings-aggregate');
    const expected = await import('../src/services/readings-expected');
    const intake = await import('../src/services/readings-intake');
    const idleModule = await import('../src/services/readings-idle');
    const stats = await import('../src/services/readings-stats');
    const assignment = await import('../src/services/driver-assignment');
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
    const series = await db.execute<{ id: string }>(
      sql`SELECT id FROM waybill_series ORDER BY code LIMIT 1`,
    );
    if (!objects.rows[0] || !types.rows[0] || !organizations.rows[0] || !series.rows[0]) {
      throw new Error('В базе нет объекта, типа ТС, организации или серии бланков');
    }
    // The week of «today − 20»: inside the staff window (30 days) from Monday to Wednesday.
    const base = shiftDateKey(moscowDateKeyOf(new Date()), -20);
    ctx = {
      db,
      schema,
      service,
      aggregate,
      expected,
      intake,
      idle: idleModule,
      stats,
      assignment,
      closeDb,
      adminId,
      objectId: objects.rows[0].id,
      typeId: types.rows[0].id,
      organizationId: organizations.rows[0].id,
      seriesId: series.rows[0].id,
      monday: weekStartKey(base),
    };
  }, 180_000);

  afterEach(() => {
    idleGate.open = null;
  });

  afterAll(async () => {
    if (ctx) {
      await purge(ctx.db, MARK);
      await ctx.closeDb();
    }
  });

  describe('запись', () => {
    it('закрытый переключатель выпуска не даёт записать отметку ни водителю, ни персоналу', async () => {
      idleGate.open = false;
      const person = await newPerson('Закрытый');
      const vehicle = await newVehicle();
      await newEsm2(vehicle, person, (await newRequest()).id);
      await expect(sendDay(person, weekday(0), idle())).rejects.toThrow(/пока недоступна/u);
      const report = await ctx.service.loadReport(person, weekday(0));
      expect(report?.items[0]?.reading).toBeNull();
    });

    it('«Не работал» записывается с причиной, без чисел и времени, и переходит в числа и обратно', async () => {
      idleGate.open = true;
      const person = await newPerson('Переходный');
      const vehicle = await newVehicle();
      await newEsm2(vehicle, person, (await newRequest()).id);

      const first = await sendDay(person, weekday(0), values({ engineHours: 100 }));
      expect(first.items[0]?.reading?.kind).toBe('values');

      const asIdle = await submit(
        person,
        weekday(0),
        [line(first.items[0]!.id, idle('repair'))],
        'машина в ремонте',
      );
      expect(asIdle.items[0]?.reading).toMatchObject({
        kind: 'idle',
        idleReason: 'repair',
        engineHours: null,
        startedAt: null,
        endedAt: null,
        points: [],
      });

      const back = await submit(
        person,
        weekday(0),
        [line(first.items[0]!.id, values({ engineHours: 101 }))],
        'ошиблись отметкой',
      );
      expect(back.items[0]?.reading).toMatchObject({
        kind: 'values',
        idleReason: null,
        engineHours: 101,
      });
    });

    it('«Другое» без слова схема не принимает, а база не хранит причину у чисел', async () => {
      const { readingInputSchema } = await import('@technic/contracts');
      expect(readingInputSchema.safeParse(idle('other')).success).toBe(false);
      expect(readingInputSchema.safeParse(idle('other', 'нет фронта работ')).success).toBe(true);

      const person = await newPerson('Проверочный');
      const vehicle = await newVehicle();
      await newEsm2(vehicle, person, (await newRequest()).id);
      const sent = await sendDay(person, weekday(0), values({ engineHours: 100 }));
      const readingId = sent.items[0]!.reading!.id;
      // The checks of 0413 hold the shape below every writer: a reason belongs to `idle` alone, and
      // `idle` carries no number.
      await expect(
        ctx.db.execute(
          sql`UPDATE vehicle_readings SET idle_reason = 'day_off' WHERE id = ${readingId}`,
        ),
      ).rejects.toMatchObject({ cause: { constraint: 'vehicle_readings_idle_check' } });
      await expect(
        ctx.db.execute(
          sql`UPDATE vehicle_readings SET kind = 'idle', idle_reason = 'day_off' WHERE id = ${readingId}`,
        ),
      ).rejects.toMatchObject({ cause: { constraint: 'vehicle_readings_values_check' } });
    });
  });

  describe('счётчики, месяцы и хвост ТО', () => {
    it('выровненное «Не работал» не рвёт пару, несданная смена — рвёт', async () => {
      idleGate.open = true;
      const person = await newPerson('Непрерывный');
      const vehicle = await newVehicle();
      await newEsm2(vehicle, person, (await newRequest()).id);
      await sendDay(person, weekday(0), values({ engineHours: 100 }));
      await sendDay(person, weekday(1), idle());
      await sendDay(person, weekday(2), values({ engineHours: 108 }));

      const control = await newPerson('Разрывный');
      const other = await newVehicle();
      await newEsm2(other, control, (await newRequest()).id);
      await sendDay(control, weekday(0), values({ engineHours: 100 }));
      await open(control, weekday(1));
      await sendDay(control, weekday(2), values({ engineHours: 108 }));

      const broken = await ctx.expected.loadBrokenCounterPairs(ctx.db, 'engineHours', [
        { vehicleId: vehicle, previousDate: weekday(0), date: weekday(2) },
        { vehicleId: other, previousDate: weekday(0), date: weekday(2) },
      ]);
      expect([...broken]).toEqual([`${other}|${weekday(0)}|${weekday(2)}`]);
    });

    it('месяц считает «Не работал» закрытой сменой отдельным числом, без разрыва ряда', async () => {
      idleGate.open = true;
      const person = await newPerson('Месячный');
      const vehicle = await newVehicle();
      await newEsm2(vehicle, person, (await newRequest()).id);
      await sendDay(person, weekday(0), values({ engineHours: 100 }));
      await sendDay(person, weekday(1), idle());
      await sendDay(person, weekday(2), values({ engineHours: 108 }));

      const card = await ctx.aggregate.loadVehicleCard(vehicle, weekday(0), weekday(2));
      expect(card?.total).toMatchObject({ shifts: 3, idleShifts: 1, missingReadings: 0 });
      expect(card?.total.engineHours).toBe(8);
    });

    it('хвост ТО не поднимается днями «Не работал» после последнего снимка', async () => {
      idleGate.open = true;
      const person = await newPerson('Праздничный');
      const vehicle = await newVehicle();
      await newEsm2(vehicle, person, (await newRequest()).id);
      await sendDay(person, weekday(0), values({ engineHours: 100 }));
      await sendDay(person, weekday(1), idle());
      await sendDay(person, weekday(2), idle());

      const control = await newPerson('Несданный');
      const other = await newVehicle();
      await newEsm2(other, control, (await newRequest()).id);
      await sendDay(control, weekday(0), values({ engineHours: 100 }));

      const tail = await ctx.aggregate.loadLastExpectedShiftDays(
        [vehicle, other],
        weekday(0),
        weekday(2),
      );
      expect(tail.get(vehicle)).toBe(weekday(0));
      expect(tail.get(other)).toBe(weekday(2));
    });
  });

  describe('приём в гараже: противоречия', () => {
    it('без противоречий «Не работал» — зелёная сданная смена', async () => {
      idleGate.open = true;
      const person = await newPerson('Чистый');
      const vehicle = await newVehicle();
      await newEsm2(vehicle, person, (await newRequest()).id);
      await sendDay(person, weekday(1), idle());

      const { rows } = await intakeRowsOf(vehicle, weekday(1));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reading?.kind).toBe('idle');
      expect(rows[0]?.issues).toEqual([]);
    });

    it('рейс с собственной перевозкой: «назначен рейс, водитель отметил: не работал»', async () => {
      idleGate.open = true;
      const person = await newPerson('Рейсовый');
      const vehicle = await newVehicle();
      await newDelivery(vehicle, weekday(1), person);
      await sendDay(person, weekday(1), idle());

      const { rows, intake } = await intakeRowsOf(vehicle, weekday(1));
      expect(rows[0]?.issues.map((issue) => issue.code)).toEqual(['idle_trip']);
      const report = intake.reports.find((r) => r.reportId === rows[0]?.reportId);
      expect(report?.batchEligible).toBe(false);
      const contradicted = await ctx.idle.idleContradictedReports([rows[0]!.reportId!]);
      expect(contradicted.has(rows[0]!.reportId!)).toBe(true);
    });

    it('другая смена машины в тот же день с числами: «машина в этот день работала»', async () => {
      idleGate.open = true;
      const person = await newPerson('Подменный');
      const vehicle = await newVehicle();
      await newEsm2(vehicle, person, (await newRequest()).id);
      await newDelivery(vehicle, weekday(1), person);
      const opened = await open(person, weekday(1));
      const esm2 = opened.items.find((item) => item.sourceKind === 'esm2')!;
      const route = opened.items.find((item) => item.sourceKind === 'route')!;
      await submit(person, weekday(1), [
        line(esm2.id, idle('site_idle')),
        line(route.id, values({ odometerKm: 5000 })),
      ]);

      const { rows } = await intakeRowsOf(vehicle, weekday(1));
      const idleRow = rows.find((row) => row.reading?.kind === 'idle');
      expect(idleRow?.issues.map((issue) => issue.code)).toEqual(['idle_worked']);
      expect(idleRow?.issues[0]?.message).toMatch(/^машина в этот день работала: Р-/u);
    });

    it('объект подписал часы по заявке листа: «объект подписал N ч»', async () => {
      idleGate.open = true;
      const person = await newPerson('Подписанный');
      const vehicle = await newVehicle();
      const request = await newRequest();
      await newEsm2(vehicle, person, request.id);
      await signHours(request.id, weekday(1), 7.5);
      await sendDay(person, weekday(1), idle());

      const { rows } = await intakeRowsOf(vehicle, weekday(1));
      expect(rows[0]?.issues.map((issue) => issue.code)).toEqual(['idle_signed']);
      expect(rows[0]?.issues[0]?.message).toMatch(/^объект подписал 7,5 ч по заявке /u);
    });

    it('лист A прячет общий рейс A+B: перевозка B и часы B видны у листа', async () => {
      idleGate.open = true;
      const person = await newPerson('Общий');
      const vehicle = await newVehicle();
      const a = await newRequest();
      const b = await newRequest();
      await newEsm2(vehicle, person, a.id);
      await newSharedRoute(vehicle, weekday(1), person, [
        { requestId: a.id, site: true },
        { requestId: b.id, site: false },
      ]);
      await sendDay(person, weekday(1), idle());

      const { rows } = await intakeRowsOf(vehicle, weekday(1));
      // The route is suppressed (one shift for two papers, ADR 0207): the sheet is the only row.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sourceKind).toBe('esm2');
      expect(rows[0]?.issues.map((issue) => issue.code)).toEqual(['idle_trip']);

      const signedPerson = await newPerson('ОбщийПодписанный');
      const signedVehicle = await newVehicle();
      const c = await newRequest();
      const d = await newRequest();
      await newEsm2(signedVehicle, signedPerson, c.id);
      await newSharedRoute(signedVehicle, weekday(2), signedPerson, [
        { requestId: c.id, site: true },
        { requestId: d.id, site: true },
      ]);
      await signHours(d.id, weekday(2), 4);
      await sendDay(signedPerson, weekday(2), idle());

      const signed = await intakeRowsOf(signedVehicle, weekday(2));
      expect(signed.rows[0]?.issues.map((issue) => issue.code)).toEqual(['idle_signed']);
    });

    it('часы, подписанные после показа реестра, выбивают отчёт из пакета', async () => {
      idleGate.open = true;
      const person = await newPerson('Поздний');
      const vehicle = await newVehicle();
      const request = await newRequest();
      await newEsm2(vehicle, person, request.id);
      const sent = await sendDay(person, weekday(2), idle());

      expect((await ctx.idle.idleContradictedReports([sent.id])).has(sent.id)).toBe(false);
      await signHours(request.id, weekday(2), 3);
      expect((await ctx.idle.idleContradictedReports([sent.id])).has(sent.id)).toBe(true);
    });
  });

  describe('рабочее воскресенье (ADR 0246)', () => {
    const sunday = () => weekday(6);

    it('воскресенье листа без отметки не спрашивается, с отметкой его заявки — спрашивается', async () => {
      const person = await newPerson('Воскресный');
      const vehicle = await newVehicle();
      const request = await newRequest();
      await newEsm2(vehicle, person, request.id);
      expect(await isPending(sunday(), vehicle)).toBe(false);
      expect(await optionalOf(person, sunday())).toEqual({ esm2: true });

      await markSunday(request.id, sunday());
      expect(await isPending(sunday(), vehicle)).toBe(true);
      expect(await optionalOf(person, sunday())).toEqual({ esm2: false });
    });

    it('лист A прячет рейс A+B: отметка B делает воскресенье листа рабочим, рейс остаётся спрятан', async () => {
      const person = await newPerson('Общевоскресный');
      const vehicle = await newVehicle();
      const a = await newRequest();
      const b = await newRequest();
      await newEsm2(vehicle, person, a.id);
      await newSharedRoute(vehicle, sunday(), person, [
        { requestId: a.id, site: true },
        { requestId: b.id, site: true },
      ]);
      expect(await isPending(sunday(), vehicle)).toBe(false);

      await markSunday(b.id, sunday());
      expect(await isPending(sunday(), vehicle)).toBe(true);
      // One shift for two papers (ADR 0207): the mark reaches the sheet, no second block appears.
      expect(await optionalOf(person, sunday())).toEqual({ esm2: false });
    });

    it('перевозка в рейсе под листом делает воскресенье листа рабочим и без отметки', async () => {
      const person = await newPerson('Перевозочный');
      const vehicle = await newVehicle();
      const a = await newRequest();
      const b = await newRequest();
      await newEsm2(vehicle, person, a.id);
      await newSharedRoute(vehicle, sunday(), person, [
        { requestId: a.id, site: true },
        { requestId: b.id, site: false },
      ]);
      expect(await isPending(sunday(), vehicle)).toBe(true);
      expect(await optionalOf(person, sunday())).toEqual({ esm2: false });
    });

    it('отметка снятой заявки рабочим воскресенье не делает', async () => {
      const person = await newPerson('Снятый');
      const vehicle = await newVehicle();
      const request = await newRequest();
      await newEsm2(vehicle, person, request.id);
      await markSunday(request.id, sunday());
      await ctx.db
        .update(ctx.schema.vehicleRequests)
        .set({ status: 'cancelled' })
        .where(eq(ctx.schema.vehicleRequests.id, request.id));
      expect(await isPending(sunday(), vehicle)).toBe(false);
    });

    it('«Не работал» в отмеченное воскресенье — жёлтое: «стояла рабочая смена»', async () => {
      idleGate.open = true;
      const person = await newPerson('Отмеченный');
      const vehicle = await newVehicle();
      const request = await newRequest();
      await newEsm2(vehicle, person, request.id);
      await markSunday(request.id, sunday());
      await sendDay(person, sunday(), idle());

      const { rows } = await intakeRowsOf(vehicle, sunday());
      expect(rows[0]?.issues.map((issue) => issue.code)).toEqual(['idle_marked']);
      expect(rows[0]?.issues[0]?.message).toMatch(/^на этот день стояла рабочая смена по заявке /u);
    });

    it('база не принимает отметку не на воскресенье', async () => {
      const request = await newRequest();
      await expect(markSunday(request.id, weekday(5))).rejects.toMatchObject({
        cause: { constraint: 'vehicle_request_working_days_sunday_check' },
      });
    });
  });
});
