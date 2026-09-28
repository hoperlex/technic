import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type AssignmentIssueWarningsDto,
  type AssignmentPreviewDto,
  type Role,
} from '@technic/contracts';
// Только типы: значения этих модулей берутся через `await import` уже после того, как выставлено
// окружение, — конфиг проверяет его при импорте и без него падает.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { byReadMode, describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/**
 * "Change vehicle" writes history when history is read (ADR 0212, decision 3 —
 * [0212](../../../docs/adr/0212-assignment-old-doors-write-history.md)).
 *
 * WHAT THIS FILE HOLDS DOWN. The old reassignment door rewrote the assignment and the paper but not
 * history. In `read_mode = history` the previous vehicle stayed the history tail: readers kept
 * showing it, and the next machinist command re-issued sheets onto it. Each case asks the three
 * questions the audit asked — which rows are active, which vehicle a reader sees on a day, and on
 * which vehicle the next history command issues paper — in both read modes: `legacy` is the
 * rollback of the switch and must keep the door as it was.
 *
 * The scene and the doors are the reassignment test's own (`assignment-reassign.db.test.ts`):
 * a request in work since last Monday, history "A + machinist" materialized, sheets for the term.
 * Assertions do not assume today's weekday: a change made mid-week splits the current sheet, and
 * the days before the change stay on the previous vehicle.
 */

const readMode = useReadModeDatabase('reassign-history');

/** Метки своих строк: уборка идёт по ним, а не «по последним записям». */
const EMAIL_PREFIX = 'db-reassign-history';
const PERSON_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: смена техники пишет историю';
const REQUEST_MARK = 'ТЕСТОВЫЕ ДАННЫЕ: смена техники пишет историю';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const PASSWORD = 'db-test-password-123';

// ── Календарь сцены ──
//
// Считается от понедельника текущей недели: так у срока есть и отработанная неделя (прошлая), и
// ещё не кончившаяся (текущая), и предстоящая. Без отработанной недели коррекции нечего
// разблокировать, а без предстоящей — нечего выписывать.

const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
const TERM_FROM = shiftDateKey(MONDAY, -7);
const TERM_TO = shiftDateKey(MONDAY, 13);
/** День внутри отработанной недели: под ним и стоит подпись объекта. */
const PAST_DAY = shiftDateKey(TERM_FROM, 1);
/** День предстоящей недели: он лежит внутри `workBlockRange` обычной смены техники. */
const FUTURE_DAY = shiftDateKey(MONDAY, 8);

interface Account {
  id: string;
  auth: { authorization: string };
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Account;
  objectId: string;
  vehicleA: { id: string; typeId: string };
  vehicleB: { id: string; typeId: string };
  personA: string;
}

let ctx: Ctx;
let seq = 0;

beforeAll(async () => {
  if (!readMode.enabled) return;
  // Окружение и своя база готовы хуком механики; почта в прогоне не нужна вовсе.
  process.env.MAIL_ENABLED = 'false';

  const { buildApp: build } = await import('../src/app');
  const { db, closeDb } = await import('../src/db/client');
  ctx = { app: await build(), db, closeDb } as Ctx;

  const one = async (q: Parameters<typeof db.execute>[0]): Promise<Record<string, string>> => {
    const [row] = (await db.execute<Record<string, string>>(q)).rows;
    if (!row) throw new Error('в справочнике пусто: сцену не собрать');
    return row;
  };
  ctx.objectId = (await one(sql`SELECT id FROM construction_objects LIMIT 1`)).id!;
  // Своя спецтехника, нелинейная: линейный заказ ведёт бумагу по требованию, и недельного плана,
  // который проверяет этот файл, у него нет вовсе (ADR 0100 §6).
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
  ctx.personA = await newPerson('Машинистов');
  // Администратор: у исторической коррекции исход `crew`, и коррекционные права ей нужны (Р32).
  ctx.admin = await newAccount('admin');
}, 240_000);

afterAll(async () => {
  if (!readMode.enabled || !ctx) return;
  await cleanup();
  await ctx.app?.close();
  await ctx.closeDb?.();
});

async function cleanup(): Promise<void> {
  const db = ctx.db;
  await db.execute(sql`
    DELETE FROM audit_log WHERE entity_type = 'vehicle_request' AND entity_id IN (
      SELECT id::text FROM vehicle_requests WHERE comment = ${REQUEST_MARK})`);
  await db.execute(sql`
    DELETE FROM waybills WHERE source_request_id IN (
      SELECT id FROM vehicle_requests WHERE comment = ${REQUEST_MARK})`);
  // Заявки первыми: строки истории ссылаются на операции под RESTRICT, и уносит их каскад заявки.
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${REQUEST_MARK}`);
  // The rental unit of the rental case; its requests and history rows are gone by now.
  await db.execute(sql`DELETE FROM vehicles WHERE description LIKE ${`${REQUEST_MARK}%`}`);
  await db.execute(sql`
    DELETE FROM waybill_corrections WHERE actor_user_id IN (
      SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${PERSON_MARK}`);
}

async function newPerson(lastName: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO persons (last_name, first_name, comment)
      VALUES (${lastName}, 'Пров', ${PERSON_MARK}) RETURNING id`)
  ).rows;
  const personId = row!.id;
  const [spec] = (
    await ctx.db.execute<{ id: string }>(sql`SELECT id FROM specializations WHERE code = 'driver'`)
  ).rows;
  // Специализация водителя — реализм сцены, а не требование листа: печать ФИО от неё не зависит
  // (ADR 0164), но водителем справочника человек числится именно ею.
  await ctx.db.execute(sql`
    INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
    VALUES (${personId}, ${spec!.id}, true, ${shiftDateKey(TERM_FROM, -400)})`);
  return personId;
}

async function newAccount(role: Role): Promise<Account> {
  seq += 1;
  const email = `${EMAIL_PREFIX}-${role}-${RUN}-${seq}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Сменов', 'Пров', '', ${await hashPassword(PASSWORD)}, ${role}, true, now())
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

// ── Сцена ──

interface Scene {
  requestId: string;
  version: number;
  /** Лист отработанной недели: цель разблокировки у коррекции. */
  pastSheetId: string;
}

interface SceneOptions {
  /** Подписанный объектом день внутри отработанной недели. */
  approvedPastDay?: boolean;
}

/**
 * Заказ спецтехники в работе: своя машина на весь срок, история материализована, бумага выписана
 * расчётом от начала срока — тогда лист получает и та неделя, что к сегодня уже отработана.
 *
 * Собирается SQL'ем, а не статусной ручкой, намеренно: в режиме `history` перевод в работу упирается
 * в бэкстоп (Р22), а предмет этого файла к подготовке отношения не имеет.
 */
async function makeScene(options: SceneOptions = {}): Promise<Scene> {
  const [request] = (
    await ctx.db.execute<{ id: string; version: number }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                    created_by, assignment_history_state,
                                    assignment_history_validated_on)
      VALUES ('special_equipment', ${ctx.objectId}, ${ctx.vehicleA.typeId}, 'confirmed',
              ${REQUEST_MARK}, ${ctx.admin.id}, 'materialized', ${TODAY})
      RETURNING id, version`)
  ).rows;
  const requestId = request!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${TERM_FROM}, ${TERM_TO})`);
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignments
      (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, assigned_by)
    VALUES (${requestId}, ${ctx.vehicleA.id}, ${ctx.vehicleA.typeId}, ${ctx.vehicleA.typeId},
            ${ctx.admin.id})`);
  // История, какой её оставил бы бэкфилл: машина и человек с начала срока. Без неё бэкстоп чужих
  // дверей называл бы пробелы машиниста, и предпросмотр показывал бы первую фазу Р16.
  await insertChange({
    requestId,
    effectiveDate: TERM_FROM,
    dimension: 'vehicle',
    vehicleId: ctx.vehicleA.id,
    origin: 'assignment',
  });
  await insertChange({
    requestId,
    effectiveDate: TERM_FROM,
    dimension: 'driver',
    driverPersonId: ctx.personA,
    driverState: 'set',
    origin: 'assignment',
  });

  const { syncEsm2Waybills } = await import('../src/services/waybill-esm2');
  await ctx.db.transaction(async (tx) => {
    await syncEsm2Waybills(tx, {
      requestId,
      actor: { id: ctx.admin.id },
      reason: 'сцена теста: бумага на весь срок',
      driverPersonId: ctx.personA,
      // Расчёт от начала срока: иначе отработанная неделя листа не получила бы вовсе.
      asOf: TERM_FROM,
    });
  });

  if (options.approvedPastDay) {
    await insertShift(requestId, PAST_DAY, 8, true);
  }

  const [sheet] = (
    await ctx.db.execute<{ id: string }>(sql`
      SELECT id FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled' AND period_to < ${TODAY}
       ORDER BY period_from LIMIT 1`)
  ).rows;
  if (!sheet)
    throw new Error('у сцены нет листа отработанной недели: срок или расчёт собраны не так');

  return { requestId, version: await versionOf(requestId), pastSheetId: sheet.id };
}

async function insertChange(row: {
  requestId: string;
  effectiveDate: string;
  dimension: 'vehicle' | 'driver';
  vehicleId?: string;
  driverPersonId?: string;
  driverState?: string;
  origin: string;
}): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_assignment_changes
      (request_id, effective_date, dimension, vehicle_id, driver_person_id, driver_state, origin,
       change_group_id)
    VALUES (${row.requestId}, ${row.effectiveDate}, ${row.dimension}, ${row.vehicleId ?? null},
            ${row.driverPersonId ?? null}, ${row.driverState ?? null}, ${row.origin},
            ${randomUUID()})`);
}

async function insertShift(
  requestId: string,
  date: string,
  hours: number,
  approved: boolean,
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO vehicle_request_shifts (request_id, shift_date, machine_hours, filled_by,
                                        approved_by, approved_at)
    VALUES (${requestId}, ${date}, ${hours}, ${ctx.admin.id},
            ${approved ? ctx.admin.id : null}, ${approved ? new Date().toISOString() : null})`);
}

async function versionOf(requestId: string): Promise<number> {
  const [row] = (
    await ctx.db.execute<{ version: number }>(
      sql`SELECT version FROM vehicle_requests WHERE id = ${requestId}`,
    )
  ).rows;
  return Number(row!.version);
}

// ── Ручки ──

/** Подписи по всем листам, которым есть что подтверждать, — так их собирает и окно (Б4). */
const acknowledgementsOf = (
  issues: readonly AssignmentIssueWarningsDto[],
): Record<string, string> =>
  Object.fromEntries(
    issues
      .filter((issue) => issue.warnings.length > 0)
      .map((issue) => [String(issue.issueKey), issue.warningFingerprint]),
  );

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

/** Reassign through the real doors: preview first, then the command with its fingerprint. */
async function reassign(
  scene: Scene,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  const preview = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${scene.requestId}/assignment/preview`,
    headers: ctx.admin.auth,
    payload: { version: scene.version, ...body },
  });
  if (preview.statusCode !== 200) return preview;
  const dto = preview.json<AssignmentPreviewDto>();
  return ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${scene.requestId}/assignment`,
    headers: ctx.admin.auth,
    payload: {
      version: scene.version,
      ...body,
      previewFingerprint: dto.fingerprint,
      acknowledgements: acknowledgementsOf(dto.issues),
    },
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
      effectiveDate: shiftDateKey(MONDAY, 7),
      driverPersonId: await newPerson('Сменщиков'),
      version: await versionOf(requestId),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<AssignmentPreviewDto>();
}

// ── Cases ──

describeReadModes(readMode, 'смена техники и история назначения', (mode) => {
  it('смена A → B пишет строку с сегодняшнего дня, и следующая команда пишет бумагу на B', async () => {
    const scene = await makeScene();
    const res = await reassign(scene, { vehicleId: ctx.vehicleB.id });
    expect(res.statusCode, res.body).toBe(200);

    expect(await activeRows(scene.requestId)).toEqual(
      byReadMode(mode, {
        // The rollback mode keeps the door as it was: history is not written.
        legacy: [`${TERM_FROM} vehicle A assignment`, `${TERM_FROM} driver personA assignment`],
        history: [
          `${TERM_FROM} vehicle A assignment`,
          `${TERM_FROM} driver personA assignment`,
          `${TODAY} vehicle B reassignment`,
        ],
      }),
    );
    // Readers: history answers by day, `legacy` answers by the assignment.
    expect(await readerVehicleOn(scene.requestId, PAST_DAY)).toBe(
      byReadMode(mode, { legacy: 'B', history: 'A' }),
    );
    expect(await readerVehicleOn(scene.requestId, FUTURE_DAY)).toBe('B');

    const sheets = await activeSheets(scene.requestId);
    expect(sheets.some((s) => s.from <= TODAY && TODAY <= s.to && s.vehicle === 'B')).toBe(true);
    // The machinist is inherited: the command changed the vehicle, not the person.
    expect(sheets.every((s) => s.driver === 'personA')).toBe(true);
    if (mode === 'history') {
      // The cut is by day: nothing before today is written onto B, nothing from today onto A.
      expect(sheets.filter((s) => s.vehicle === 'B').every((s) => s.from >= TODAY)).toBe(true);
      expect(sheets.filter((s) => s.vehicle === 'A').every((s) => s.to < TODAY)).toBe(true);
      const next = await machinistPreview(scene.requestId);
      expect(next.plan.issue.length).toBeGreaterThan(0);
      expect(next.plan.issue.every((sheet) => sheet.vehicleId === ctx.vehicleB.id)).toBe(true);
    }
  });

  it('смена на арендную машину снимает машиниста, и листов на неё не выписывается', async () => {
    // A rental unit of the ordered type, created here: the seeded fleet does not guarantee one.
    const [lessor] = (
      await ctx.db.execute<{ id: string }>(sql`
        SELECT id FROM counterparties WHERE type = 'vehicle_lessor' ORDER BY id LIMIT 1`)
    ).rows;
    expect(lessor, 'the seed has a vehicle lessor').toBeDefined();
    const [rental] = (
      await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO vehicles (vehicle_type_id, ownership, lessor_id, lessor_type, lessor_is_active,
                              description, price_per_shift, shift_hours, status)
        VALUES (${ctx.vehicleA.typeId}, 'rental', ${lessor!.id}, 'vehicle_lessor', true,
                ${`${REQUEST_MARK} ${mode}`}, 12000, 8, 'active')
        RETURNING id`)
    ).rows;
    if (!rental) throw new Error('the rental unit was not created');
    names.set(rental.id, 'R');
    const scene = await makeScene();
    const res = await reassign(scene, { vehicleId: rental.id, pricePerShift: 10000 });
    expect(res.statusCode, res.body).toBe(200);

    if (mode === 'history') {
      expect(await activeRows(scene.requestId)).toEqual([
        `${TERM_FROM} vehicle A assignment`,
        `${TERM_FROM} driver personA assignment`,
        `${TODAY} vehicle R reassignment`,
        `${TODAY} driver cleared reassignment`,
      ]);
      expect(await readerVehicleOn(scene.requestId, FUTURE_DAY)).toBe('R');
    }
    const sheets = await activeSheets(scene.requestId);
    // The lessor writes the rental unit's paper: none of ours covers a day from today.
    expect(sheets.every((s) => s.vehicle === 'A')).toBe(true);
    expect(sheets.every((s) => s.to < TODAY)).toBe(true);
  });
});
