import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type GarageDriverScheduleDto,
  type GarageDriverShiftDto,
  moscowDateKeyOf,
  type ReadingInput,
  type ReportItemSubmit,
  shiftDateKey,
} from '@technic/contracts';
import { useReadModeDatabase } from './assignment-read-mode';
// Types only: the modules are imported after the environment is set — the config checks it on
// import and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import type * as SchemaNs from '../src/db/schema';
import type * as ReadingsNs from '../src/services/readings';
import type * as ScheduleNs from '../src/services/garage-driver-schedule';

/**
 * The garage driver schedule on a live schema: which shifts of a month are due a reading, what
 * became of each, and which days the driver is named without paper.
 *
 * The set is SQL over the readings module's own fragments, so the file seeds what the module
 * reads — routes with and without waybills, weekly sheets, a site order with assignment history —
 * and hands readings in through the readings service, never by inserting report rows: a test on
 * inserted rows would agree with itself rather than with the module that defines "submitted".
 *
 * The file runs on its own database (`useReadModeDatabase`): the history-derived days need the
 * `history` read mode, and the control row is one per database.
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:55980/technic_drv_sched \
 *     npx vitest run garage-driver-schedule --maxWorkers=1
 */

const readMode = useReadModeDatabase('drvsched');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

const PASSWORD = 'drv-schedule-test-password-123';
const ADMIN_EMAIL = 'drv-schedule-admin@example.invalid';
const MECHANIC_EMAIL = 'drv-schedule-mechanic@example.invalid';
const SHTAB_EMAIL = 'drv-schedule-shtab@example.invalid';
const MARK = `ТЕСТОВЫЕ ДАННЫЕ: график водителя ${randomUUID().slice(0, 8)}`;

const TODAY = moscowDateKeyOf(new Date());
const ago = (days: number): string => shiftDateKey(TODAY, -days);
const monthOf = (date: string): string => date.slice(0, 7);

/** A sheet week across a month boundary: 28.09.2026 is a Monday, 04.10.2026 its Sunday. */
const CROSS_WEEK = { from: '2026-09-28', to: '2026-10-04' };

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  schema: typeof SchemaNs;
  readings: typeof ReadingsNs;
  schedule: typeof ScheduleNs;
  closeDb: () => Promise<void>;
  adminId: string;
  auth: { admin: Headers; mechanic: Headers; shtab: Headers };
  objectId: string;
  freightTypeId: string;
  specialTypeId: string;
  organizationId: string;
  mainSeriesId: string;
  esm2SeriesId: string;
  driverSpecializationId: string;
}

type Headers = { authorization: string };

let ctx: Ctx;
let waybillNo = 900_000;

// ── Fixtures ──

async function newPerson(firstName: string, options: { driver?: boolean } = {}): Promise<string> {
  const [person] = await ctx.db
    .insert(ctx.schema.persons)
    .values({ lastName: 'Графиков', firstName, middleName: 'Тестович', comment: MARK })
    .returning({ id: ctx.schema.persons.id });
  if (options.driver !== false) {
    await ctx.db.insert(ctx.schema.personSpecializations).values({
      personId: person!.id,
      specializationId: ctx.driverSpecializationId,
      isPrimary: true,
      startedOn: '2024-01-15',
    });
  }
  return person!.id;
}

async function newVehicle(typeId: string, ownership: 'own' = 'own'): Promise<string> {
  const [vehicle] = await ctx.db
    .insert(ctx.schema.vehicles)
    .values({
      ownership,
      vehicleTypeId: typeId,
      status: 'active',
      registrationNumber: `Г${randomUUID().slice(0, 4).toUpperCase()}777`,
      note: MARK,
    })
    .returning({ id: ctx.schema.vehicles.id });
  return vehicle!.id;
}

async function newRequest(
  status: 'new' | 'confirmed' = 'confirmed',
): Promise<{ id: string; num: number }> {
  const [request] = await ctx.db
    .insert(ctx.schema.vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: ctx.objectId,
      vehicleTypeId: ctx.specialTypeId,
      status,
      createdBy: ctx.adminId,
      comment: MARK,
    })
    .returning({ id: ctx.schema.vehicleRequests.id, num: ctx.schema.vehicleRequests.num });
  return request!;
}

async function issue4p(routeId: string, vehicleId: string, personId: string, date: string) {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.mainSeriesId,
      number: waybillNo,
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
 * A relocation: it has work by its purpose, so only the waybill decides whether a reading is due.
 * `paperFor` names the person the waybill is issued to; `null` issues none.
 */
async function newRoute(
  vehicleId: string,
  date: string,
  personId: string,
  paperFor: string | null = personId,
): Promise<string> {
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
  if (paperFor) await issue4p(route!.id, vehicleId, paperFor, date);
  return route!.id;
}

/*
 * ЭСМ2-РАЗРЕЗ: the sheet is inserted with the bounds the scene names — a one-day segment, the shape
 * the read switch produces, and one Monday-to-Sunday sheet only because it is the widest the week
 * CHECK allows across a month boundary. No assertion reads a sheet as "a week from Monday": the
 * schedule expands whatever period a sheet has, day by day, clipped by the month.
 */
async function newEsm2(opts: {
  vehicleId: string;
  personId: string;
  requestId: string;
  from: string;
  to: string;
}): Promise<string> {
  waybillNo += 1;
  const [waybill] = await ctx.db
    .insert(ctx.schema.waybills)
    .values({
      seriesId: ctx.esm2SeriesId,
      number: waybillNo,
      formCode: 'esm2',
      status: 'issued',
      organizationId: ctx.organizationId,
      vehicleId: opts.vehicleId,
      driverPersonId: opts.personId,
      issuedForDate: opts.from,
      sourceRequestId: opts.requestId,
      periodFrom: opts.from,
      periodTo: opts.to,
      issuedBy: ctx.adminId,
    })
    .returning({ id: ctx.schema.waybills.id });
  return waybill!.id;
}

// ── Readings through the module ──

const STAFF = { mode: 'staff' as const };

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
    confirmOdometerAnomaly: false,
    confirmEngineHoursAnomaly: false,
  };
}

async function submitDay(personId: string, date: string, reading: ReadingInput, reason = '') {
  const opened = await ctx.readings.openReport(personId, date, ctx.adminId, STAFF);
  expect(opened.items).toHaveLength(1);
  const current = await ctx.readings.loadReport(personId, date);
  return ctx.readings.submitReport(
    personId,
    date,
    { version: current!.version, items: [line(opened.items[0]!.id, reading)], reason },
    ctx.adminId,
    null,
    { ...STAFF, reason },
  );
}

// ── Reading the schedule ──

async function scheduleOf(
  personId: string,
  month: string,
  canReadReadings = true,
): Promise<GarageDriverScheduleDto> {
  const answer = await ctx.schedule.loadDriverSchedule(personId, month, { canReadReadings });
  if (!answer) throw new Error('schedule not found');
  return answer;
}

/** Shifts of every month the given days fall into: the days ago may straddle a month boundary. */
async function shiftsAround(personId: string, days: string[]): Promise<GarageDriverShiftDto[]> {
  const months = [...new Set(days.map(monthOf))].sort();
  const answers = await Promise.all(months.map((month) => scheduleOf(personId, month)));
  return answers.flatMap((answer) => answer.shifts);
}

async function login(email: string): Promise<Headers> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { authorization: `Bearer ${res.json().accessToken}` };
}

describe.skipIf(!DB_URL)('гараж: график водителя на живой схеме', () => {
  beforeAll(async () => {
    await readMode.setReadMode('history');
    const { db, closeDb } = await import('../src/db/client');
    const schema = await import('../src/db/schema');
    const readings = await import('../src/services/readings');
    const schedule = await import('../src/services/garage-driver-schedule');
    const { hashPassword } = await import('../src/auth/password');
    const { buildApp } = await import('../src/app');

    const passwordHash = await hashPassword(PASSWORD);
    const users = await db
      .insert(schema.users)
      .values(
        (
          [
            [ADMIN_EMAIL, 'admin'],
            [MECHANIC_EMAIL, 'mechanic'],
            [SHTAB_EMAIL, 'shtab'],
          ] as const
        ).map(([email, role]) => ({
          email,
          lastName: 'Тестовый',
          firstName: 'Пользователь',
          middleName: 'Графиков',
          passwordHash,
          role,
          isActive: true,
        })),
      )
      .returning({ id: schema.users.id, email: schema.users.email });

    const [object] = await db
      .insert(schema.constructionObjects)
      .values({ code: `ГРФ-${randomUUID().slice(0, 6)}`, name: MARK })
      .returning({ id: schema.constructionObjects.id });

    /*
     * Dictionaries arrive with the migrations and are the portal's own, not data of a neighbour:
     * the vehicle classifier, the organization, the blank series and the driver specialization.
     * The special type is non-linear — a linear order is run by its routes and has no history.
     */
    const pick = async (query: ReturnType<typeof sql>, what: string): Promise<string> => {
      const rows = await db.execute<{ id: string }>(query);
      if (!rows.rows[0]) throw new Error(`В базе нет: ${what}`);
      return rows.rows[0].id;
    };
    const freightTypeId = await pick(
      sql`SELECT vt.id FROM vehicle_types vt JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          WHERE vk.code = 'freight_transport' AND NOT vt.is_linear ORDER BY vt.code LIMIT 1`,
      'грузовой тип',
    );
    const specialTypeId = await pick(
      sql`SELECT vt.id FROM vehicle_types vt JOIN vehicle_kinds vk ON vk.id = vt.kind_id
          WHERE vk.code = 'special_equipment' AND NOT vt.is_linear ORDER BY vt.code LIMIT 1`,
      'нелинейная спецтехника',
    );
    const organizationId = await pick(
      sql`SELECT id FROM organizations WHERE is_active ORDER BY name LIMIT 1`,
      'организация',
    );
    const mainSeriesId = await pick(
      sql`SELECT id FROM waybill_series WHERE code = 'main'`,
      'серия бланков main',
    );
    const esm2SeriesId = await pick(
      sql`SELECT id FROM waybill_series WHERE code = 'esm2'`,
      'серия бланков esm2',
    );
    const driverSpecializationId = await pick(
      sql`SELECT id FROM specializations WHERE code = 'driver'`,
      'специализация водителя',
    );

    const app = await buildApp();
    ctx = {
      app,
      db,
      schema,
      readings,
      schedule,
      closeDb,
      adminId: users.find((u) => u.email === ADMIN_EMAIL)!.id,
      auth: {} as Ctx['auth'],
      objectId: object!.id,
      freightTypeId,
      specialTypeId,
      organizationId,
      mainSeriesId,
      esm2SeriesId,
      driverSpecializationId,
    };
    ctx.auth = {
      admin: await login(ADMIN_EMAIL),
      mechanic: await login(MECHANIC_EMAIL),
      shtab: await login(SHTAB_EMAIL),
    };
  }, 180_000);

  afterAll(async () => {
    if (!ctx) return;
    await ctx.app.close();
    await ctx.closeDb();
  });

  it('смены рейсов: каждое состояние показания и день без листа', async () => {
    const driver = await newPerson('Маршрутный');
    const vehicle = await newVehicle(ctx.freightTypeId);
    const other = await newPerson('Сменщик');

    const days = {
      missing: ago(2),
      submitted: ago(3),
      accepted: ago(4),
      reaccept: ago(5),
      noData: ago(6),
      noPaper: ago(7),
      reassigned: ago(8),
      ahead: shiftDateKey(TODAY, 2),
    };
    const routes = {
      missing: await newRoute(vehicle, days.missing, driver),
      submitted: await newRoute(vehicle, days.submitted, driver),
      accepted: await newRoute(vehicle, days.accepted, driver),
      reaccept: await newRoute(vehicle, days.reaccept, driver),
      noData: await newRoute(vehicle, days.noData, driver),
      noPaper: await newRoute(vehicle, days.noPaper, driver, null),
      // Reassigned to this driver without reissuing: the waybill still names the former one.
      reassigned: await newRoute(vehicle, days.reassigned, driver, other),
      ahead: await newRoute(vehicle, days.ahead, driver),
    };

    await submitDay(driver, days.noData, {
      kind: 'no_data',
      noDataReason: 'счётчик разбит',
      comment: '',
    });
    const reaccept = await submitDay(driver, days.reaccept, values(1000));
    await ctx.readings.acceptReport(reaccept.id, reaccept.version, ctx.adminId);
    const fixed = await ctx.readings.submitReport(
      driver,
      days.reaccept,
      {
        version: (await ctx.readings.loadReport(driver, days.reaccept))!.version,
        items: [line(reaccept.items[0]!.id, values(1010))],
        reason: 'опечатка в одометре',
      },
      ctx.adminId,
      null,
      { ...STAFF, reason: 'опечатка в одометре' },
    );
    expect(fixed.state).toBe('needs_reacceptance');
    const accepted = await submitDay(driver, days.accepted, values(1100));
    await ctx.readings.acceptReport(accepted.id, accepted.version, ctx.adminId);
    const submitted = await submitDay(driver, days.submitted, values(1200));

    const shifts = await shiftsAround(driver, Object.values(days));
    const byKey = new Map(shifts.map((s) => [s.key, s]));
    const status = (key: string) => byKey.get(key)?.readingStatus;

    expect(status(`route:${routes.missing}`)).toBe('not_submitted');
    expect(status(`route:${routes.submitted}`)).toBe('submitted');
    expect(status(`route:${routes.accepted}`)).toBe('accepted');
    expect(status(`route:${routes.reaccept}`)).toBe('needs_reacceptance');
    expect(status(`route:${routes.noData}`)).toBe('no_data');
    expect(status(`route:${routes.ahead}`)).toBe('upcoming');
    // No waybill at all, and a waybill on someone else: both are «без листа» for this driver.
    expect(status(`no_paper:route:${routes.noPaper}`)).toBe('not_expected');
    expect(status(`no_paper:route:${routes.reassigned}`)).toBe('not_expected');
    expect(byKey.has(`route:${routes.noPaper}`)).toBe(false);
    expect(byKey.has(`route:${routes.reassigned}`)).toBe(false);

    const shift = byKey.get(`route:${routes.submitted}`)!;
    expect(shift).toMatchObject({
      date: days.submitted,
      source: 'route',
      routeId: routes.submitted,
      vehicleId: vehicle,
      reportId: submitted.id,
      request: null,
    });
    expect(shift.routeNumber).toMatch(/^Р-\d+$/);
    expect(shift.waybill).toMatchObject({ formCode: '4p' });
    expect(shift.vehicleLabel).toMatch(/^Г.+777$/);
    // The day nobody opened has no report to open; a day without paper never points to one.
    expect(byKey.get(`route:${routes.missing}`)!.reportId).toBeNull();
    expect(byKey.get(`no_paper:route:${routes.noPaper}`)).toMatchObject({
      waybill: null,
      reportId: null,
      noDataReason: null,
    });

    // The reason is readings content: present with the right, absent without it.
    expect(byKey.get(`route:${routes.noData}`)!.noDataReason).toBe('счётчик разбит');
    expect(byKey.get(`route:${routes.missing}`)!.noDataReason).toBeNull();
    const blind = await scheduleOf(driver, monthOf(days.noData), false);
    const blindShift = blind.shifts.find((s) => s.key === `route:${routes.noData}`)!;
    expect(blindShift.readingStatus).toBe('no_data');
    expect('noDataReason' in blindShift).toBe(false);

    // Another driver's shifts never leak in; his own month has the route his waybill names.
    const strange = await newPerson('Посторонний');
    const strangeRoute = await newRoute(await newVehicle(ctx.freightTypeId), days.missing, strange);
    expect(shifts.some((s) => s.routeId === strangeRoute)).toBe(false);
    const theirs = await scheduleOf(strange, monthOf(days.missing));
    expect(theirs.shifts.map((s) => s.key)).toEqual([`route:${strangeRoute}`]);
    // The former driver keeps no row of the reassigned route: the route no longer names him.
    const former = await scheduleOf(other, monthOf(days.reassigned));
    expect(former.shifts.some((s) => s.routeId === routes.reassigned)).toBe(false);
  });

  it('итог месяца: ожидаемые, переданные и пропущенные', async () => {
    const driver = await newPerson('Итоговый');
    const vehicle = await newVehicle(ctx.freightTypeId);
    // Two shifts in the same month as each other: the boundary-safe pair is today and yesterday
    // unless today is the 1st, when it is today and tomorrow.
    const [first, second] = TODAY.endsWith('-01')
      ? [TODAY, shiftDateKey(TODAY, 1)]
      : [shiftDateKey(TODAY, -1), TODAY];
    await newRoute(vehicle, first, driver);
    await newRoute(vehicle, second, driver);
    await newRoute(vehicle, first, driver, null);
    await submitDay(driver, first, values(500));

    const month = await scheduleOf(driver, monthOf(first));
    expect(month.summary).toEqual({
      expected: 2,
      submitted: 1,
      missing: second > TODAY ? 0 : 1,
    });
  });

  it('недельный ЭСМ-2 даёт смену на каждый день и делится границей месяца', async () => {
    const driver = await newPerson('Недельный');
    const vehicle = await newVehicle(ctx.specialTypeId);
    const request = await newRequest();
    const waybill = await newEsm2({
      vehicleId: vehicle,
      personId: driver,
      requestId: request.id,
      ...CROSS_WEEK,
    });

    const september = await scheduleOf(driver, '2026-09');
    const october = await scheduleOf(driver, '2026-10');
    expect(september).toMatchObject({ month: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    expect(september.shifts.map((s) => s.date)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
    expect(october.shifts.map((s) => s.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    for (const shift of [...september.shifts, ...october.shifts]) {
      expect(shift).toMatchObject({
        key: `esm2:${waybill}:${shift.date}`,
        source: 'esm2',
        routeId: null,
        routeNumber: null,
        vehicleId: vehicle,
      });
      expect(shift.waybill).toMatchObject({ id: waybill, formCode: 'esm2' });
    }

    // A sheet day handed in counts by the sheet and the day, not by the week.
    const day = ago(10);
    const recent = await newEsm2({
      vehicleId: vehicle,
      personId: driver,
      requestId: (await newRequest()).id,
      from: day,
      to: day,
    });
    await submitDay(driver, day, values(300));
    const [handed] = (await scheduleOf(driver, monthOf(day))).shifts.filter(
      (s) => s.waybill?.id === recent,
    );
    expect(handed).toMatchObject({ key: `esm2:${recent}:${day}`, readingStatus: 'submitted' });
  });

  it('день заказа по истории назначения без листа — «без листа», лист закрывает свой день', async () => {
    const driver = await newPerson('Машинист');
    const vehicle = await newVehicle(ctx.specialTypeId);
    const request = await newRequest('confirmed');
    const term = { from: ago(1), to: shiftDateKey(TODAY, 1) };
    await ctx.db.execute(sql`
      INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
      VALUES (${request.id}, ${term.from}::date, ${term.to}::date)`);
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignments (request_id, vehicle_id, vehicle_type_id,
                                               ordered_vehicle_type_id, assigned_by)
      VALUES (${request.id}, ${vehicle}, ${ctx.specialTypeId}, ${ctx.specialTypeId}, ${ctx.adminId})`);
    await ctx.db.execute(sql`
      INSERT INTO vehicle_request_assignment_changes
        (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin)
      VALUES (${request.id}, ${term.from}::date, 'vehicle', ${vehicle}, NULL, NULL, 'assignment'),
             (${request.id}, ${term.from}::date, 'driver', NULL, ${driver}, 'set', 'assignment')`);
    // The sheet on him covers the last day only: that day is his weekly shift, not «без листа».
    const sheet = await newEsm2({
      vehicleId: vehicle,
      personId: driver,
      requestId: request.id,
      from: term.to,
      to: term.to,
    });

    const termDays = [term.from, TODAY, term.to];
    const shifts = await shiftsAround(driver, termDays);
    expect(shifts.map((s) => [s.date, s.source])).toEqual([
      [term.from, 'no_paper'],
      [TODAY, 'no_paper'],
      [term.to, 'esm2'],
    ]);
    const [firstDay] = shifts;
    expect(firstDay).toMatchObject({
      key: `no_paper:request:${request.id}:${term.from}`,
      request: { id: request.id, displayNumber: `ТС-${request.num}` },
      vehicleId: vehicle,
      readingStatus: 'not_expected',
      reportId: null,
      waybill: null,
    });
    expect(shifts[2]!.waybill?.id).toBe(sheet);

    // Days without paper never count in the month's numbers.
    const month = await scheduleOf(driver, monthOf(TODAY));
    const expected = month.shifts.filter((s) => s.source !== 'no_paper').length;
    expect(month.summary.expected).toBe(expected);

    // In the legacy read mode the machinist is known only from paper: the order days disappear,
    // and the sheet day stays.
    await readMode.setReadMode('legacy');
    try {
      const legacy = await shiftsAround(driver, termDays);
      expect(legacy.map((s) => s.source)).toEqual(['esm2']);
    } finally {
      await readMode.setReadMode('history');
    }
  });

  describe('ручка: право и область', () => {
    const url = (personId: string, query = '') =>
      `/api/v1/garage/drivers/${personId}/schedule${query}`;

    it('без месяца отвечает текущим московским, с месяцем — названным', async () => {
      const driver = await newPerson('Адресный');
      const route = await newRoute(await newVehicle(ctx.freightTypeId), ago(2), driver);

      const current = await ctx.app.inject({
        method: 'GET',
        url: url(driver),
        headers: ctx.auth.admin,
      });
      expect(current.statusCode, current.body).toBe(200);
      expect(current.json()).toMatchObject({
        personId: driver,
        fullName: 'Графиков Адресный Тестович',
        month: monthOf(TODAY),
        today: TODAY,
      });

      const named = await ctx.app.inject({
        method: 'GET',
        url: url(driver, `?month=${monthOf(ago(2))}`),
        headers: ctx.auth.admin,
      });
      expect(named.statusCode, named.body).toBe(200);
      const body = named.json() as GarageDriverScheduleDto;
      expect(body.month).toBe(monthOf(ago(2)));
      expect(body.shifts.map((s) => s.key)).toContain(`route:${route}`);
      expect(body.shifts[0]).toHaveProperty('noDataReason');
    });

    it('механику — график без причин «нет данных»: показания ему не положены', async () => {
      const driver = await newPerson('Механический');
      await newRoute(await newVehicle(ctx.freightTypeId), ago(2), driver);
      const res = await ctx.app.inject({
        method: 'GET',
        url: url(driver, `?month=${monthOf(ago(2))}`),
        headers: ctx.auth.mechanic,
      });
      expect(res.statusCode, res.body).toBe(200);
      const [shift] = (res.json() as GarageDriverScheduleDto).shifts;
      expect(shift).toBeDefined();
      expect(shift).not.toHaveProperty('noDataReason');
    });

    it('без права на гараж — 403', async () => {
      const driver = await newPerson('Закрытый');
      const res = await ctx.app.inject({
        method: 'GET',
        url: url(driver),
        headers: ctx.auth.shtab,
      });
      expect(res.statusCode).toBe(403);
    });

    it('человек не из перечня водителей — 404, неверный месяц — 400', async () => {
      const outsider = await newPerson('Неводитель', { driver: false });
      const notListed = await ctx.app.inject({
        method: 'GET',
        url: url(outsider),
        headers: ctx.auth.admin,
      });
      expect(notListed.statusCode).toBe(404);

      const driver = await newPerson('Месячный');
      for (const month of ['2026-13', '2026-10-01']) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: url(driver, `?month=${month}`),
          headers: ctx.auth.admin,
        });
        expect(res.statusCode, month).toBe(400);
      }
    });
  });
});
