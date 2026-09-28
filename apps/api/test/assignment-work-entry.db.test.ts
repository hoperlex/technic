import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type AssignmentPreviewDto,
} from '@technic/contracts';
// Types only: the modules themselves are imported after the environment is set, because the config
// validates it on import.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/**
 * Taking a special-equipment request into work writes the assignment history it starts from
 * (ADR 0212, decisions 1–2 — [0212](../../../docs/adr/0212-assignment-old-doors-write-history.md)).
 *
 * WHAT THIS FILE HOLDS DOWN. In `read_mode = history` the status door used to write only the
 * assignment. A first entry was then refused by the backstop (fixed by `239f8595`), and a re-entry
 * after a rollback to «Новая» silently kept the previous pair in history: readers showed the old
 * vehicle and the next machinist command re-issued sheets for it. Each case below asks the three
 * questions that exposed it — which rows are active, which vehicle a reader sees on a day, and on
 * which vehicle the next history command would issue paper.
 *
 * Both read modes run: in `legacy` the door must keep its old behaviour (no rows, weekly sweep),
 * because that mode is the rollback of the switch.
 *
 * The file needs its own database and creates it: the read mode lives in one control row per base.
 */

const readMode = useReadModeDatabase('work-entry');

const EMAIL_PREFIX = 'db-work-entry';
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: перевод в работу пишет историю';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const PASSWORD = 'db-test-password-123';

// The term starts last Monday: it has a worked week, the current one and the next one.
const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
const TERM_FROM = shiftDateKey(MONDAY, -7);
const TERM_TO = shiftDateKey(MONDAY, 13);
const PAST_DAY = shiftDateKey(TERM_FROM, 1);
const NEXT_MONDAY = shiftDateKey(MONDAY, 7);
const FUTURE_DAY = shiftDateKey(MONDAY, 8);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: { id: string; auth: { authorization: string } };
  objectId: string;
  vehicleA: { id: string; typeId: string };
  vehicleB: { id: string; typeId: string };
  personA: string;
}

let ctx: Ctx;

beforeAll(async () => {
  if (!readMode.enabled) return;
  process.env.MAIL_ENABLED = 'false';
  const { buildApp: build } = await import('../src/app');
  const { db, closeDb } = await import('../src/db/client');
  ctx = { app: await build(), db, closeDb } as Ctx;

  const one = async (q: Parameters<typeof db.execute>[0]): Promise<Record<string, string>> => {
    const [row] = (await db.execute<Record<string, string>>(q)).rows;
    if (!row) throw new Error('the directory is empty: the scene cannot be built');
    return row;
  };
  ctx.objectId = (await one(sql`SELECT id FROM construction_objects LIMIT 1`)).id!;
  // Own, non-linear special equipment: only such a request gets weekly ESM-2 paper by itself.
  const vehicle = async (offset: number) => {
    const row = await one(sql`
      SELECT v.id, v.vehicle_type_id FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.deleted_at IS NULL AND v.ownership = 'own' AND vk.code = 'special_equipment'
         AND vt.is_linear = false
       ORDER BY v.id OFFSET ${offset} LIMIT 1`);
    return { id: row.id!, typeId: row.vehicle_type_id! };
  };
  ctx.vehicleA = await vehicle(0);
  ctx.vehicleB = await vehicle(1);
  ctx.personA = await newPerson('Прежнев');
  ctx.admin = await newAdmin();
}, 240_000);

afterAll(async () => {
  if (!readMode.enabled || !ctx) return;
  const db = ctx.db;
  await db.execute(sql`
    DELETE FROM audit_log WHERE entity_type = 'vehicle_request' AND entity_id IN (
      SELECT id::text FROM vehicle_requests WHERE comment = ${MARK})`);
  await db.execute(sql`
    DELETE FROM waybills WHERE source_request_id IN (
      SELECT id FROM vehicle_requests WHERE comment = ${MARK})`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${MARK}`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${MARK}`);
  await ctx.app?.close();
  await ctx.closeDb?.();
});

async function newPerson(lastName: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO persons (last_name, first_name, comment)
      VALUES (${lastName}, 'Пров', ${MARK}) RETURNING id`)
  ).rows;
  const [spec] = (
    await ctx.db.execute<{ id: string }>(sql`SELECT id FROM specializations WHERE code = 'driver'`)
  ).rows;
  await ctx.db.execute(sql`
    INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
    VALUES (${row!.id}, ${spec!.id}, true, ${shiftDateKey(TERM_FROM, -400)})`);
  return row!.id;
}

async function newAdmin(): Promise<Ctx['admin']> {
  const email = `${EMAIL_PREFIX}-${RUN}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Входов', 'Пров', '', ${await hashPassword(PASSWORD)}, 'admin', true, now())
      RETURNING id`)
  ).rows;
  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const { accessToken } = login.json<{ accessToken: string }>();
  return { id: row!.id, auth: { authorization: `Bearer ${accessToken}` } };
}

// ── Scenes ──

/** A new approved request that has never been in work: no assignment, no rows, no sheets. */
async function newRequest(): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                    created_by, approved_by, approved_at)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.vehicleA.typeId}, 'new', ${MARK},
              ${ctx.admin.id}, ${ctx.admin.id}, now())
      RETURNING id`)
  ).rows;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${row!.id}, ${TERM_FROM}, ${TERM_TO})`);
  return row!.id;
}

/**
 * A request in work since last Monday on vehicle A with `personA`, its history materialized and
 * sheets issued from the start of the term — the worked week keeps its sheet after a rollback.
 */
async function workingRequest(): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                    created_by, approved_by, approved_at,
                                    assignment_history_state, assignment_history_validated_on)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.vehicleA.typeId}, 'confirmed', ${MARK},
              ${ctx.admin.id}, ${ctx.admin.id}, now(), 'ready', ${TODAY})
      RETURNING id`)
  ).rows;
  const requestId = row!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${TERM_FROM}, ${TERM_TO})`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${ctx.vehicleA.id}, ${ctx.vehicleA.typeId}, ${ctx.vehicleA.typeId},
            ${ctx.admin.id})`);
  const group = randomUUID();
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${requestId}, ${TERM_FROM}, 'vehicle', ${ctx.vehicleA.id}, NULL, NULL, 'assignment',
            ${group}),
           (${requestId}, ${TERM_FROM}, 'driver', NULL, ${ctx.personA}, 'set', 'assignment',
            ${group})`);
  const { syncEsm2Waybills } = await import('../src/services/waybill-esm2');
  await ctx.db.transaction(async (tx) => {
    await syncEsm2Waybills(tx, {
      requestId,
      actor: { id: ctx.admin.id },
      reason: 'test scene: paper for the whole term',
      driverPersonId: ctx.personA,
      asOf: TERM_FROM,
    });
  });
  return requestId;
}

// ── Doors ──

async function versionOf(requestId: string): Promise<number> {
  const [row] = (
    await ctx.db.execute<{ version: number }>(
      sql`SELECT version FROM vehicle_requests WHERE id = ${requestId}`,
    )
  ).rows;
  return Number(row!.version);
}

async function takeIntoWork(requestId: string, vehicleId: string, driverPersonId: string | null) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${requestId}/status`,
    headers: ctx.admin.auth,
    payload: {
      status: 'confirmed',
      comment: '',
      version: await versionOf(requestId),
      assignment: {
        vehicleId,
        pricePerHour: null,
        pricePerShift: null,
        shiftHours: null,
        ...(driverPersonId ? { driverPersonId } : {}),
      },
      schedule: { requestType: 'special_equipment', dateFrom: TERM_FROM, dateTo: TERM_TO },
    },
  });
}

async function rollBack(requestId: string) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${requestId}/status`,
    headers: ctx.admin.auth,
    payload: { status: 'new', comment: 'не та машина', version: await versionOf(requestId) },
  });
}

/** Preview of "Change machinist" from next Monday: the paper the next history command would issue. */
async function machinistPreview(requestId: string): Promise<AssignmentPreviewDto> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/preview`,
    headers: ctx.admin.auth,
    payload: {
      kind: 'set',
      dimension: 'driver',
      effectiveDate: NEXT_MONDAY,
      driverPersonId: await newPerson('Сменщиков'),
      version: await versionOf(requestId),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AssignmentPreviewDto>();
}

// ── Reads ──

async function activeRows(requestId: string): Promise<string[]> {
  const rows = (
    await ctx.db.execute<{
      effective_date: string;
      dimension: string;
      vehicle_id: string | null;
      driver_person_id: string | null;
      driver_state: string | null;
      origin: string;
    }>(sql`
      SELECT effective_date::text, dimension, vehicle_id, driver_person_id, driver_state, origin
        FROM vehicle_request_assignment_changes
       WHERE request_id = ${requestId} AND superseded_at IS NULL
       ORDER BY effective_date, dimension DESC`)
  ).rows;
  return rows.map((r) =>
    r.dimension === 'vehicle'
      ? `${r.effective_date} vehicle ${nameOf(r.vehicle_id)} ${r.origin}`
      : `${r.effective_date} driver ${r.driver_state === 'set' ? nameOf(r.driver_person_id) : r.driver_state} ${r.origin}`,
  );
}

async function historyState(requestId: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ state: string }>(sql`
      SELECT assignment_history_state AS state FROM vehicle_requests WHERE id = ${requestId}`)
  ).rows;
  return row!.state;
}

/** The vehicle every history-aware reader sees on a day (`requestDayVehicleSql`). */
async function readerVehicleOn(requestId: string, day: string): Promise<string | null> {
  const { requestDayVehicleSql } = await import('../src/services/assignment-read');
  const [row] = (
    await ctx.db.execute<{ v: string | null }>(
      sql`SELECT ${requestDayVehicleSql(
        sql`${requestId}::uuid`,
        sql`(SELECT vehicle_id FROM vehicle_request_assignments WHERE request_id = ${requestId})`,
        day,
      )} AS v`,
    )
  ).rows;
  return nameOf(row?.v ?? null);
}

async function activeSheets(
  requestId: string,
): Promise<{ from: string; to: string; vehicle: string | null; driver: string | null }[]> {
  return (
    await ctx.db.execute<{
      period_from: string;
      period_to: string;
      vehicle_id: string;
      driver_person_id: string | null;
    }>(sql`
      SELECT period_from::text, period_to::text, vehicle_id, driver_person_id FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled' AND period_from IS NOT NULL
       ORDER BY period_from`)
  ).rows.map((r) => ({
    from: r.period_from,
    to: r.period_to,
    vehicle: nameOf(r.vehicle_id),
    driver: nameOf(r.driver_person_id),
  }));
}

const names = new Map<string, string>();
function nameOf(id: string | null): string | null {
  if (id === null) return null;
  if (id === ctx.vehicleA.id) return 'A';
  if (id === ctx.vehicleB.id) return 'B';
  if (id === ctx.personA) return 'personA';
  return names.get(id) ?? id;
}

// ── Cases ──

describeReadModes(readMode, 'перевод в работу и история назначения', (mode) => {
  it('первый перевод называет пару на весь срок, и следующая команда пишет бумагу на неё же', async () => {
    const requestId = await newRequest();
    const res = await takeIntoWork(requestId, ctx.vehicleA.id, ctx.personA);
    expect(res.statusCode, res.body).toBe(200);

    expect(await activeRows(requestId)).toEqual(
      byReadMode(mode, {
        // The rollback mode writes no rows: history comes from the paper by backfill later.
        legacy: [],
        history: [`${TERM_FROM} vehicle A assignment`, `${TERM_FROM} driver personA assignment`],
      }),
    );
    expect(await historyState(requestId)).toBe(
      byReadMode(mode, { legacy: 'empty', history: 'ready' }),
    );
    expect(await readerVehicleOn(requestId, FUTURE_DAY)).toBe('A');

    // Paper is the same in both modes on a first entry: one pair for the whole term, the current
    // period issued whole, the fully worked week left without a sheet (ordinary work never fills
    // the past).
    const sheets = await activeSheets(requestId);
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.every((s) => s.vehicle === 'A' && s.driver === 'personA')).toBe(true);
    expect(sheets.every((s) => s.to >= TODAY)).toBe(true);
    expect(sheets.some((s) => s.from <= TODAY && TODAY <= s.to)).toBe(true);

    // The next history command: in `legacy` a machinist change from a future date is refused by
    // the weekly-paper gate, so only the mode where history issues paper is asked.
    if (mode === 'history') {
      const next = await machinistPreview(requestId);
      expect(next.plan.issue.length).toBeGreaterThan(0);
      expect(next.plan.issue.every((sheet) => sheet.vehicleId === ctx.vehicleA.id)).toBe(true);
    }
  });

  it('повторный перевод после отката: прошлое за прежней парой, с сегодняшнего дня — новая', async () => {
    const requestId = await workingRequest();
    const back = await rollBack(requestId);
    expect(back.statusCode, back.body).toBe(200);

    const personB = await newPerson('Новиков');
    names.set(personB, 'personB');
    const res = await takeIntoWork(requestId, ctx.vehicleB.id, personB);
    expect(res.statusCode, res.body).toBe(200);

    expect(await activeRows(requestId)).toEqual(
      byReadMode(mode, {
        legacy: [`${TERM_FROM} vehicle A assignment`, `${TERM_FROM} driver personA assignment`],
        history: [
          `${TERM_FROM} vehicle A assignment`,
          `${TERM_FROM} driver personA assignment`,
          `${TODAY} vehicle B assignment`,
          `${TODAY} driver personB assignment`,
        ],
      }),
    );
    // The previous pair keeps the day it worked; from today every reader sees the new vehicle.
    expect(await readerVehicleOn(requestId, PAST_DAY)).toBe(
      byReadMode(mode, { legacy: 'B', history: 'A' }),
    );
    expect(await readerVehicleOn(requestId, FUTURE_DAY)).toBe('B');

    const sheets = await activeSheets(requestId);
    // The worked week keeps its sheet, written for the pair that worked it.
    expect(sheets.some((s) => s.to < MONDAY && s.vehicle === 'A' && s.driver === 'personA')).toBe(
      true,
    );
    expect(sheets.some((s) => s.from <= TODAY && TODAY <= s.to && s.vehicle === 'B')).toBe(true);
    if (mode === 'history') {
      // No sheet of the new pair covers a day the previous pair worked this week.
      expect(sheets.filter((s) => s.vehicle === 'B').every((s) => s.from >= TODAY)).toBe(true);
      expect(await historyState(requestId)).toBe('ready');
      const next = await machinistPreview(requestId);
      expect(next.plan.issue.length).toBeGreaterThan(0);
      expect(next.plan.issue.every((sheet) => sheet.vehicleId === ctx.vehicleB.id)).toBe(true);
    }
  });

  it('своя машина без машиниста — отказ до записи', async () => {
    const requestId = await newRequest();
    const res = await takeIntoWork(requestId, ctx.vehicleA.id, null);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ message: string }>().message).toContain('Укажите машиниста');
    expect(await activeRows(requestId)).toEqual([]);
    const [row] = (
      await ctx.db.execute<{ status: string }>(
        sql`SELECT status FROM vehicle_requests WHERE id = ${requestId}`,
      )
    ).rows;
    expect(row!.status).toBe('new');
  });
});
