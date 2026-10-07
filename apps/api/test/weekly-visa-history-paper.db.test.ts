import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  esm2Periods,
  moscowDateKeyOf,
  shiftDateKey,
  weekStartKey,
  type AssignmentIssueWarningsDto,
  type AssignmentPreviewDto,
  type WeeklyCorrectionPreviewDto,
} from '@technic/contracts';
// Types only: the modules themselves are imported after the environment is set, because the config
// validates it on import.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';
import { describeReadModes, useReadModeDatabase } from './assignment-read-mode';

/**
 * The weekly visa leads ESM-2 paper by the segment plan in `read_mode = history` (ADR 0220 —
 * [0220](../../../docs/adr/0220-weekly-visa-segment-paper.md)).
 *
 * WHAT THIS FILE HOLDS DOWN. The visa extends an order's term, and until ADR 0220 its paper was the
 * weekly sweep in both modes. The sweep knows one vehicle and one machinist per order and wants one
 * sheet per week, so on a week cut by a mid-week change it burnt the second half: on ТС-202 the
 * visa of the next week cancelled sheet 734 (02–04.10) and could not reissue it, because worked-out
 * 733 (01.10) locked the week. While the first half is not worked yet, the sweep burnt both halves
 * and printed the new pair over the previous one's days. Each case cuts a week the way the portal
 * does it and approves the next week on the same day.
 *
 * The vehicle case runs in both modes: in `legacy` the vehicle door does not cut the week, the
 * sweep has nothing to burn, and the visa must keep behaving as it did. The machinist and backdated
 * cases are `history` only: in `legacy` a future machinist change waits for the switch, and the
 * preview there is the sweep's own and unchanged.
 *
 * The file needs its own database and creates it: the read mode lives in one control row per base.
 */

const readMode = useReadModeDatabase('wvisa');

const EMAIL_PREFIX = 'db-weekly-visa-paper';
const MARK = 'ТЕСТОВЫЕ ДАННЫЕ: виза недели ведёт бумагу отрезками';
const OBJECT_PREFIX = 'WVP-';
const RUN = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`.replace(/[^a-z0-9]/gu, '');
const PASSWORD = 'db-test-password-123';

// The term starts last Monday: the cut week is the current one, the visa is for the next.
const TODAY = moscowDateKeyOf(new Date());
const MONDAY = weekStartKey(TODAY);
const SUNDAY = shiftDateKey(MONDAY, 6);
const TERM_FROM = shiftDateKey(MONDAY, -7);
const TOMORROW = shiftDateKey(TODAY, 1);
const NEXT_MONDAY = shiftDateKey(MONDAY, 7);
const NEXT_SUNDAY = shiftDateKey(MONDAY, 13);
/**
 * The overdue week of the backdated case: the latest ended week no month cuts. A cut week splits
 * the wanted sheet, and the Monday–Wednesday sheet could then match one half and need no reissue;
 * of two neighbouring weeks at most one holds a month's end, so the second candidate is whole.
 */
const PREV_MONDAY = [shiftDateKey(MONDAY, -7), shiftDateKey(MONDAY, -14)].find(
  (monday) => esm2Periods(monday, shiftDateKey(monday, 6)).length === 1,
)!;
const PREV_WEDNESDAY = shiftDateKey(PREV_MONDAY, 2);
const PREV_SUNDAY = shiftDateKey(PREV_MONDAY, 6);
/** The order of the backdated case worked the week before and ended in the overdue week's middle. */
const BACKDATED_FROM = shiftDateKey(PREV_MONDAY, -7);

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: { id: string; auth: { authorization: string } };
  vehicleA: { id: string; typeId: string };
  vehicleB: { id: string; typeId: string };
  personA: string;
}

let ctx: Ctx;
const names = new Map<string, string>();

beforeAll(async () => {
  if (!readMode.enabled) return;
  process.env.MAIL_ENABLED = 'false';
  const { buildApp: build } = await import('../src/app');
  const { db, closeDb } = await import('../src/db/client');
  ctx = { app: await build(), db, closeDb } as Ctx;

  // Own, non-linear special equipment of one type: only such an order gets weekly ESM-2 paper by
  // itself, and the vehicle door changes a unit within its classification position.
  const [pair] = (
    await db.execute<{ a: string; b: string; type_id: string }>(sql`
      SELECT min(v.id::text) AS a, max(v.id::text) AS b, v.vehicle_type_id AS type_id
        FROM vehicles v
        JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
        JOIN vehicle_kinds vk ON vk.id = vt.kind_id
       WHERE v.deleted_at IS NULL AND v.status = 'active' AND v.ownership = 'own'
         AND vk.code = 'special_equipment' AND vt.is_linear = false AND vt.is_active
       GROUP BY v.vehicle_type_id
      HAVING count(*) >= 2
       ORDER BY v.vehicle_type_id
       LIMIT 1`)
  ).rows;
  if (!pair) throw new Error('the directory has no two own vehicles of one type');
  ctx.vehicleA = { id: pair.a, typeId: pair.type_id };
  ctx.vehicleB = { id: pair.b, typeId: pair.type_id };
  names.set(pair.a, 'A');
  names.set(pair.b, 'B');
  ctx.personA = await newPerson('Прежнев', 'personA');
  ctx.admin = await newAdmin();
}, 240_000);

afterAll(async () => {
  if (!readMode.enabled || !ctx) return;
  const db = ctx.db;
  const ours = sql`SELECT id FROM vehicle_requests WHERE comment = ${MARK}`;
  const objects = sql`SELECT id FROM construction_objects WHERE code LIKE ${`${OBJECT_PREFIX}%`}`;
  await db.execute(sql`
    DELETE FROM audit_log WHERE entity_type = 'vehicle_request'
       AND entity_id IN (SELECT id::text FROM vehicle_requests WHERE comment = ${MARK})`);
  await db.execute(sql`DELETE FROM waybills WHERE source_request_id IN (${ours})`);
  await db.execute(sql`DELETE FROM weekly_vehicle_requests WHERE object_id IN (${objects})`);
  await db.execute(sql`DELETE FROM vehicle_requests WHERE comment = ${MARK}`);
  await db.execute(sql`
    DELETE FROM waybill_corrections WHERE actor_user_id IN (
      SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`
    DELETE FROM audit_log WHERE actor_user_id IN (
      SELECT id FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`})`);
  await db.execute(sql`DELETE FROM construction_objects WHERE id IN (${objects})`);
  await db.execute(sql`DELETE FROM users WHERE email LIKE ${`${EMAIL_PREFIX}%`}`);
  await db.execute(sql`DELETE FROM persons WHERE comment = ${MARK}`);
  await ctx.app?.close();
  await ctx.closeDb?.();
});

async function newPerson(lastName: string, label: string): Promise<string> {
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
  names.set(row!.id, label);
  return row!.id;
}

async function newAdmin(): Promise<Ctx['admin']> {
  const email = `${EMAIL_PREFIX}-${RUN}@example.invalid`;
  const { hashPassword } = await import('../src/auth/password');
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role,
                         is_active, email_verified_at)
      VALUES (${email}, 'Визов', 'Пров', '', ${await hashPassword(PASSWORD)}, 'admin', true, now())
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

/** A site of its own per case: one live weekly request per «site + week» pair. */
async function freshObject(): Promise<string> {
  const code = `${OBJECT_PREFIX}${randomUUID().slice(0, 8)}`;
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${code}, ${`Тестовая площадка ${code}`}, 'г Москва, ул Тестовая, д 1')
      RETURNING id`)
  ).rows;
  return row!.id;
}

/**
 * An order in work on vehicle A with `personA` from `termFrom`, its history materialized and its
 * sheets issued from the start of the term — the way the portal leaves an order that has worked
 * since then. Built by SQL: in `history` the status door stops at the backstop (Р22), and taking
 * an order into work is not what this file checks.
 */
async function workingOrder(objectId: string, termFrom: string, termTo: string): Promise<string> {
  const [row] = (
    await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO vehicle_requests (request_type, object_id, vehicle_type_id, status, comment,
                                    created_by, approved_by, approved_at,
                                    assignment_history_state, assignment_history_validated_on)
      VALUES ('special_equipment', ${objectId}, ${ctx.vehicleA.typeId}, 'confirmed', ${MARK},
              ${ctx.admin.id}, ${ctx.admin.id}, now(), 'ready', ${TODAY})
      RETURNING id`)
  ).rows;
  const requestId = row!.id;
  await ctx.db.execute(sql`
    INSERT INTO special_equipment_request_details (request_id, date_from, date_to)
    VALUES (${requestId}, ${termFrom}, ${termTo})`);
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
    VALUES (${requestId}, ${termFrom}, 'vehicle', ${ctx.vehicleA.id}, NULL, NULL, 'assignment',
            ${group}),
           (${requestId}, ${termFrom}, 'driver', NULL, ${ctx.personA}, 'set', 'assignment',
            ${group})`);
  const { syncEsm2Waybills } = await import('../src/services/waybill-esm2');
  await ctx.db.transaction(async (tx) => {
    await syncEsm2Waybills(tx, {
      requestId,
      actor: { id: ctx.admin.id },
      reason: 'test scene: paper for the whole term',
      driverPersonId: ctx.personA,
      asOf: termFrom,
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

/** Signatures for every sheet that has something to confirm — as the window collects them (Б4). */
const acknowledgementsOf = (
  issues: readonly AssignmentIssueWarningsDto[],
): Record<string, string> =>
  Object.fromEntries(
    issues
      .filter((issue) => issue.warnings.length > 0)
      .map((issue) => [String(issue.issueKey), issue.warningFingerprint]),
  );

/** "Change vehicle" from today — the old door that writes history (ADR 0212, decision 3). */
async function changeVehicleToday(requestId: string): Promise<void> {
  const body = { vehicleId: ctx.vehicleB.id, version: await versionOf(requestId) };
  const preview = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment/preview`,
    headers: ctx.admin.auth,
    payload: body,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const dto = preview.json<AssignmentPreviewDto>();
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/vehicle-requests/${requestId}/assignment`,
    headers: ctx.admin.auth,
    payload: {
      ...body,
      previewFingerprint: dto.fingerprint,
      acknowledgements: acknowledgementsOf(dto.issues),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** "Change machinist" from a date — the history command. */
async function changeMachinist(
  requestId: string,
  effectiveDate: string,
  driverPersonId: string,
): Promise<void> {
  const body = {
    kind: 'set',
    dimension: 'driver',
    effectiveDate,
    driverPersonId,
    version: await versionOf(requestId),
  };
  const preview = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes/preview`,
    headers: ctx.admin.auth,
    payload: body,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const dto = preview.json<AssignmentPreviewDto>();
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/vehicle-requests/${requestId}/assignment-changes`,
    headers: ctx.admin.auth,
    payload: {
      ...body,
      previewFingerprint: dto.fingerprint,
      acknowledgements: acknowledgementsOf(dto.issues),
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** A weekly request with one extension row, submitted for the visa. */
async function pendingWeekly(
  objectId: string,
  weekStart: string,
  requestId: string,
  dateTo: string,
): Promise<{ id: string; version: number }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/weekly-vehicle-requests',
    headers: ctx.admin.auth,
    payload: {
      objectId,
      weekStart,
      items: [{ kind: 'extend', sourceRequestId: requestId, dateTo }],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const weekly = created.json<{ id: string; version: number }>();
  const submitted = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/weekly-vehicle-requests/${weekly.id}/status`,
    headers: ctx.admin.auth,
    payload: { status: 'pending', version: weekly.version },
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  const pending = submitted.json<{ request: { id: string; version: number; status: string } }>();
  expect(pending.request.status).toBe('pending');
  return { id: pending.request.id, version: pending.request.version };
}

function approve(
  weekly: { id: string; version: number },
  correction?: { operationId: string; reason: string; unlockWaybillIds: string[] },
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/weekly-vehicle-requests/${weekly.id}/approval`,
    headers: ctx.admin.auth,
    payload: {
      approved: true,
      comment: '',
      version: weekly.version,
      ...(correction ? { correction } : {}),
    },
  });
}

// ── Reads ──

interface Sheet {
  id: string;
  from: string;
  to: string;
  vehicle: string;
  driver: string;
}

async function activeSheets(requestId: string): Promise<Sheet[]> {
  return (
    await ctx.db.execute<{
      id: string;
      period_from: string;
      period_to: string;
      vehicle_id: string;
      driver_person_id: string | null;
    }>(sql`
      SELECT id, period_from::text, period_to::text, vehicle_id, driver_person_id FROM waybills
       WHERE source_request_id = ${requestId} AND status <> 'cancelled'
         AND form_code = 'esm2' AND period_from IS NOT NULL
       ORDER BY period_from`)
  ).rows.map((r) => ({
    id: r.id,
    from: r.period_from,
    to: r.period_to,
    vehicle: names.get(r.vehicle_id) ?? r.vehicle_id,
    driver: r.driver_person_id ? (names.get(r.driver_person_id) ?? r.driver_person_id) : '—',
  }));
}

/** Sheets the visa burnt: their cancel reason starts with the weekly request's own reason. */
async function burntByVisa(requestId: string): Promise<string[]> {
  return (
    await ctx.db.execute<{ id: string }>(sql`
      SELECT id FROM waybills
       WHERE source_request_id = ${requestId} AND status = 'cancelled'
         AND cancel_reason LIKE 'Недельная заявка %'`)
  ).rows.map((r) => r.id);
}

const shape = (sheets: readonly Sheet[]) =>
  sheets.map((s) => `${s.from}..${s.to} ${s.vehicle} ${s.driver}`);

/** Every day of `from..to` is covered by exactly one active sheet. */
function coversOnce(sheets: readonly Sheet[], from: string, to: string): boolean {
  for (let day = from; day <= to; day = shiftDateKey(day, 1)) {
    if (sheets.filter((s) => s.from <= day && day <= s.to).length !== 1) return false;
  }
  return true;
}

// ── Cases ──

describeReadModes(readMode, 'виза следующей недели после смены техники в середине недели', () => {
  it('обе половины разрезанной недели остаются, следующая неделя выписывается', async () => {
    const objectId = await freshObject();
    const requestId = await workingOrder(objectId, TERM_FROM, SUNDAY);
    await changeVehicleToday(requestId);
    const before = await activeSheets(requestId);
    // From today the week is paper of vehicle B, whoever cut it and however.
    expect(before.filter((s) => s.to >= TODAY).every((s) => s.vehicle === 'B')).toBe(true);

    const weekly = await pendingWeekly(objectId, NEXT_MONDAY, requestId, NEXT_SUNDAY);
    const res = await approve(weekly);
    expect(res.statusCode, res.body).toBe(200);
    const esm2 = res.json<{ apply: { esm2: { cancelled: string[]; issued: number }[] } }>().apply
      .esm2;
    expect(esm2.flatMap((e) => e.cancelled)).toEqual([]);

    const after = await activeSheets(requestId);
    // Nothing the visa did not add has moved: the cut week keeps both halves under their numbers.
    expect(after.filter((s) => s.from < NEXT_MONDAY)).toEqual(before);
    expect(shape(after.filter((s) => s.from >= NEXT_MONDAY))).toEqual(
      esm2Periods(NEXT_MONDAY, NEXT_SUNDAY).map((p) => `${p.from}..${p.to} B personA`),
    );
    expect(await burntByVisa(requestId)).toEqual([]);
    expect(coversOnce(after, MONDAY, NEXT_SUNDAY)).toBe(true);
  });
});

describeReadModes(readMode, 'виза недели для заказа, кончающегося в середине недели', () => {
  it('частичный лист недели переоформляется до воскресенья, дни без бумаги не остаются', async () => {
    /*
     * The most common extension: the order ends in the middle of the target week and the visa
     * takes it to Sunday. The partial sheet is not worked yet, so it burns and the week is issued
     * whole — in `legacy` by the sweep, in `history` by the segment plan, whose scope takes in the
     * documents of the opened days (ADR 0220). Burning here is legitimate, and it is the visa's.
     */
    const objectId = await freshObject();
    const wednesday = shiftDateKey(NEXT_MONDAY, 2);
    const requestId = await workingOrder(objectId, TERM_FROM, wednesday);
    const before = await activeSheets(requestId);
    const partial = before.filter((s) => s.to === wednesday).map((s) => s.id);
    expect(partial).toHaveLength(1);

    const weekly = await pendingWeekly(objectId, NEXT_MONDAY, requestId, NEXT_SUNDAY);
    const res = await approve(weekly);
    expect(res.statusCode, res.body).toBe(200);

    const after = await activeSheets(requestId);
    expect(shape(after)).toEqual(
      esm2Periods(TERM_FROM, NEXT_SUNDAY).map((p) => `${p.from}..${p.to} A personA`),
    );
    // Only the sheets of the opened week moved; the weeks before keep their numbers.
    expect(after.filter((s) => s.to < NEXT_MONDAY)).toEqual(
      before.filter((s) => s.to < NEXT_MONDAY),
    );
    // The partial sheet burns; a month's end before Wednesday would leave its first half as is.
    const burnt = await burntByVisa(requestId);
    expect(burnt).toEqual(partial);
    expect(burnt.every((id) => !after.some((s) => s.id === id))).toBe(true);
  });
});

describeReadModes(
  readMode,
  'виза недели в history: бумага по отрезкам',
  () => {
    it.skipIf(TODAY === SUNDAY)(
      'смена машиниста с завтрашнего дня: дни прежнего машиниста не перепечатываются на нового',
      async () => {
        const objectId = await freshObject();
        const requestId = await workingOrder(objectId, TERM_FROM, SUNDAY);
        const personB = await newPerson('Сменщиков', 'personB');
        await changeMachinist(requestId, TOMORROW, personB);
        const before = await activeSheets(requestId);
        // The scene: the week is cut at tomorrow, today and before stay with personA.
        expect(before.filter((s) => s.from <= TODAY && s.to >= MONDAY)).not.toEqual([]);
        expect(
          before.filter((s) => s.from <= TODAY && s.to >= MONDAY).every((s) => s.to <= TODAY),
        ).toBe(true);

        const weekly = await pendingWeekly(objectId, NEXT_MONDAY, requestId, NEXT_SUNDAY);
        const res = await approve(weekly);
        expect(res.statusCode, res.body).toBe(200);

        const after = await activeSheets(requestId);
        expect(after.filter((s) => s.from < NEXT_MONDAY)).toEqual(before);
        expect(after.filter((s) => s.driver === 'personB').every((s) => s.from >= TOMORROW)).toBe(
          true,
        );
        expect(shape(after.filter((s) => s.from >= NEXT_MONDAY))).toEqual(
          esm2Periods(NEXT_MONDAY, NEXT_SUNDAY).map((p) => `${p.from}..${p.to} A personB`),
        );
        expect(await burntByVisa(requestId)).toEqual([]);
        expect(coversOnce(after, MONDAY, NEXT_SUNDAY)).toBe(true);
      },
    );

    it('проведение прошедшей недели: предпросмотр называет лист плана, без него — 422, с ним — перевыписка', async () => {
      const objectId = await freshObject();
      const requestId = await workingOrder(objectId, BACKDATED_FROM, PREV_WEDNESDAY);
      const sheets = await activeSheets(requestId);
      const midWeek = sheets.find((s) => s.from === PREV_MONDAY && s.to === PREV_WEDNESDAY);
      expect(midWeek, JSON.stringify(sheets)).toBeDefined();

      const weekly = await pendingWeekly(objectId, PREV_MONDAY, requestId, PREV_SUNDAY);

      // The preview names exactly the sheet the plan reissues — not every worked sheet of the
      // order, as the weekly sweep's scope did: the week before last stays out of reach.
      const preview = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/weekly-vehicle-requests/${weekly.id}/correction`,
        headers: ctx.admin.auth,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      const dto = preview.json<WeeklyCorrectionPreviewDto>();
      expect(dto.allowed).toBe(true);
      expect(dto.unlockable.map((u) => u.waybillId)).toEqual([midWeek!.id]);
      expect(dto.pastWeeks).toEqual([]);

      // Unnamed — the visa refuses, naming the order, and nothing moves.
      const refused = await approve(weekly, {
        operationId: randomUUID(),
        reason: 'Неделю согласовали устно, в портал внесли задним числом',
        unlockWaybillIds: [],
      });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json<{ message: string }>().message).toContain('отметьте их к перевыписке');
      expect(await activeSheets(requestId)).toEqual(sheets);
      const [term] = (
        await ctx.db.execute<{ date_to: string }>(sql`
            SELECT date_to::text FROM special_equipment_request_details
             WHERE request_id = ${requestId}`)
      ).rows;
      expect(term!.date_to).toBe(PREV_WEDNESDAY);

      // Named — the sheet is replaced by the whole week under the operation.
      const applied = await approve(weekly, {
        operationId: randomUUID(),
        reason: 'Неделю согласовали устно, в портал внесли задним числом',
        unlockWaybillIds: [midWeek!.id],
      });
      expect(applied.statusCode, applied.body).toBe(200);
      const after = await activeSheets(requestId);
      expect(shape(after)).toEqual([
        ...shape(sheets.filter((s) => s.id !== midWeek!.id)),
        `${PREV_MONDAY}..${PREV_SUNDAY} A personA`,
      ]);
      const [replacement] = (
        await ctx.db.execute<{ corrects_waybill_id: string | null; correction_id: string | null }>(
          sql`SELECT corrects_waybill_id, correction_id FROM waybills
                 WHERE source_request_id = ${requestId} AND status <> 'cancelled'
                   AND period_from = ${PREV_MONDAY}`,
        )
      ).rows;
      expect(replacement!.corrects_waybill_id).toBe(midWeek!.id);
      expect(replacement!.correction_id).not.toBeNull();
    });
  },
  { modes: ['history'] },
);
