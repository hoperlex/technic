import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  assignmentAcknowledgementsOf,
  moscowDateKeyOf,
  shiftDateKey,
  type PeriodApplyBody,
  type PeriodPreviewDto,
  type SpecialEquipmentRequestDto,
  type VehicleOnSiteListDto,
  type VehicleOnSiteSummaryDto,
} from '@technic/contracts';
import { describeReadModes, inLegacy, useReadModeDatabase } from './assignment-read-mode';
// Types only: the values of these modules are imported with `await import` after the environment
// is set — the config checks it at import time and fails without it.
import type { buildApp } from '../src/app';
import type { db as AppDb } from '../src/db/client';

/**
 * Shifts of an on-site order (ADR 0184) on the live schema, through the real handlers: the two
 * term doors refusing to drop a filled day, and the "On site" filter by the sign-off debt.
 *
 * WHY A LIVE DATABASE. Both subjects are wiring, not rules — the rules have their pure tests
 * (`vehicle-request-shifts.test.ts`). What only the database can prove:
 *
 * - **the two term doors ask the same refusal** (ADR 0184, 2026-10-12): the wide edit
 *   `PATCH /vehicle-requests/:id` and the term door — its preview and its apply — answer 422 naming
 *   the filled day, the text is one, and nothing is written: the term, the version and the shift row
 *   stay. A signed day and an unsigned one refuse alike; with the day's shift deleted in the shift
 *   window the same edit passes. A term that only grows never asks;
 * - **the "On site" filter keeps an order whose term is over while past days wait for a sign-off**
 *   (`hasUnapprovedPastShiftsSql`) — in the list and in the summary's `shiftsPending` — and lets it
 *   go once every day is signed; a filled but unsigned day is still a debt. Until now the rule was
 *   proven only by the contract (`onSitePresence`) and by the portal tag.
 *
 * RENTED VEHICLES. Their paper is the lessor's — the portal issues them no weekly sheets — so the
 * term doors here have nothing to burn, issue or sign for: the scene is about shifts, and a paper
 * plan would only add handshakes that are not the subject. Each case takes its own vehicle, so two
 * orders of one unit never overlap.
 *
 * TWO READ MODES for the doors (`describeReadModes`): production reads the history, and the term
 * door is a door of the `history` class. The refusal comes before every mode-dependent step, so the
 * halves are expected to coincide; the passing edit after the shift is deleted runs step 12 by
 * mode, and that is where they could part. The scene itself is prepared in `legacy` (`inLegacy`),
 * as in the neighbouring files. The "On site" filter reads no history and runs once.
 *
 * OWN DATABASE, created and dropped by the read-mode harness (`useReadModeDatabase`): the mode lives
 * in a control row, one per database.
 *
 * Run:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@localhost:5433/technic_test \
 *     npx vitest run test/vehicle-request-shifts.db.test.ts
 */

const readMode = useReadModeDatabase('shifts');
const DB_URL = readMode.enabled ? process.env.TEST_DATABASE_URL : undefined;

const PASSWORD = 'db-vehicle-shifts-password-123';
const RUN = randomUUID().slice(0, 8);
/**
 * Object code with «яя»: half of the code picks an object by `ORDER BY … LIMIT 1`, and a record that
 * became the first would steal other requests onto the test site.
 */
const OBJECT_CODE = `яя-vehicle-shifts-${RUN}`;
const TYPE_CODE = `vehicle_shifts_${RUN}`;
const DROP_TEXT = 'Новый срок выбрасывает дни с заполненными сменами';

interface Auth {
  authorization: string;
}

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: typeof AppDb;
  closeDb: () => Promise<void>;
  admin: Auth;
  /** Site of the door cases. */
  objectId: string;
  /**
   * Site of the "On site" case alone: it counts every row of its site, and an order a door case
   * left in work today (a failed run stops before moving its start) would change the count.
   */
  onSiteObjectId: string;
  driverId: string;
  typeId: string;
  /** Rented vehicles: two per read mode for the doors and one for the "On site" filter. */
  vehicles: string[];
  today: string;
}

let ctx: Ctx;

/** `YYYY-MM-DD` the way the refusal names a day. */
function ru(key: string): string {
  const [y, m, d] = key.split('-');
  return `${d}.${m}.${y}`;
}

function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return ctx.app.inject({ method, url, headers: ctx.admin, ...(payload ? { payload } : {}) });
}

async function ok(
  res: Promise<LightMyRequestResponse>,
  code = 200,
): Promise<LightMyRequestResponse> {
  const done = await res;
  expect(done.statusCode, done.body).toBe(code);
  return done;
}

async function versionOf(requestId: string): Promise<number> {
  const res = await ok(inject('GET', `/api/v1/vehicle-requests/${requestId}`));
  return res.json().version as number;
}

/**
 * An on-site order taken into work on a rented vehicle: created (with a declared reason when it
 * starts in the past), approved and confirmed.
 */
async function requestInProgress(options: {
  vehicleId: string;
  dateFrom: string;
  dateTo: string;
  objectId?: string;
}): Promise<{ id: string; num: number }> {
  const { vehicleId, dateFrom, dateTo } = options;
  const backdated = dateFrom < ctx.today;
  const created = await ok(
    inject('POST', '/api/v1/vehicle-requests', {
      requestType: 'special_equipment',
      objectId: options.objectId ?? ctx.objectId,
      vehicleTypeId: ctx.typeId,
      dateFrom,
      dateTo,
      responsibleName: 'Сменов Пётр Петрович',
      responsiblePhone: '9007790763',
      comment: 'Планировка площадки',
      ...(backdated
        ? { backdateReason: 'Техника вышла раньше, чем оформили', operationId: randomUUID() }
        : {}),
    }),
    201,
  );
  const request = created.json() as { id: string; num: number; version: number };
  const approved = await ok(
    inject('PATCH', `/api/v1/vehicle-requests/${request.id}/approval`, {
      approved: true,
      version: request.version,
    }),
  );
  await ok(
    inject('PATCH', `/api/v1/vehicle-requests/${request.id}/status`, {
      status: 'confirmed',
      comment: '',
      version: approved.json().version,
      assignment: {
        vehicleId,
        pricePerHour: 3000,
        pricePerShift: null,
        shiftHours: null,
        driverPersonId: ctx.driverId,
      },
      schedule: { requestType: 'special_equipment', dateFrom, dateTo },
    }),
  );
  return { id: request.id, num: request.num };
}

async function fillShift(requestId: string, date: string, machineHours = 8): Promise<void> {
  await ok(
    inject('PUT', `/api/v1/vehicle-requests/${requestId}/shifts/${date}`, {
      machineHours,
      refuel: '',
      comment: '',
    }),
  );
}

async function signShift(requestId: string, date: string, approved: boolean): Promise<void> {
  await ok(
    inject('POST', `/api/v1/vehicle-requests/${requestId}/shifts/${date}/approval`, { approved }),
  );
}

async function deleteShift(requestId: string, date: string): Promise<void> {
  await ok(inject('DELETE', `/api/v1/vehicle-requests/${requestId}/shifts/${date}`));
}

interface Stored {
  dateFrom: string;
  dateTo: string | null;
  version: number;
  shifts: { date: string; approved: boolean }[];
}

/** What a refused edit must leave untouched, read straight from the tables. */
async function storedOf(requestId: string): Promise<Stored> {
  const [row] = (
    await ctx.db.execute<{ date_from: string; date_to: string | null; version: number }>(sql`
      SELECT d.date_from::text AS date_from, d.date_to::text AS date_to, r.version
        FROM vehicle_requests r
        JOIN special_equipment_request_details d ON d.request_id = r.id
       WHERE r.id = ${requestId}`)
  ).rows;
  const shifts = (
    await ctx.db.execute<{ date: string; approved: boolean }>(sql`
      SELECT shift_date::text AS date, approved_at IS NOT NULL AS approved
        FROM vehicle_request_shifts WHERE request_id = ${requestId} ORDER BY shift_date`)
  ).rows;
  return {
    dateFrom: row!.date_from,
    dateTo: row!.date_to,
    version: Number(row!.version),
    shifts,
  };
}

/** The wide edit with nothing but the term: the body an old tab sends for the dates. */
function wideEdit(
  requestId: string,
  version: number,
  term: { dateFrom?: string; dateTo?: string },
) {
  return inject('PATCH', `/api/v1/vehicle-requests/${requestId}`, {
    requestType: 'special_equipment',
    version,
    ...term,
  });
}

function periodPreview(requestId: string, version: number, dateFrom: string) {
  return inject('POST', `/api/v1/vehicle-requests/${requestId}/period/preview`, {
    version,
    dateFrom,
  });
}

/** The apply body the portal builds from a preview it has shown (`silentTermApplyBody`). */
function armed(version: number, dateFrom: string, preview: PeriodPreviewDto): PeriodApplyBody {
  const acknowledgements = assignmentAcknowledgementsOf(preview.issues);
  return {
    version,
    dateFrom,
    previewFingerprint: preview.fingerprint,
    ...(preview.cancelGroupsFingerprint
      ? { cancelGroupsFingerprint: preview.cancelGroupsFingerprint }
      : {}),
    ...(preview.unlockFingerprint !== null ? { unlockFingerprint: preview.unlockFingerprint } : {}),
    ...(Object.keys(acknowledgements).length > 0 ? { acknowledgements } : {}),
  };
}

/** The refusal of a dropped filled day, checked the same way at every door. */
function expectDropRefusal(res: LightMyRequestResponse, day: string, hours: number): void {
  expect(res.statusCode, res.body).toBe(422);
  const body = res.json() as {
    message: string;
    fields?: Record<string, string>;
    details?: { blockedShiftDays?: { date: string; hours: number }[] };
  };
  expect(body.message).toContain(DROP_TEXT);
  expect(body.message).toContain(`(${ru(day)})`);
  // In work the way out is the shift window — the refusal names it.
  expect(body.message).toContain('на вкладке «На объекте»');
  expect(Object.keys(body.fields ?? {})).toEqual(['dateFrom']);
  expect(body.details?.blockedShiftDays).toEqual([{ date: day, hours }]);
}

function onSiteList(): Promise<VehicleOnSiteListDto> {
  return ok(inject('GET', `/api/v1/vehicle-requests/on-site?objectId=${ctx.onSiteObjectId}`)).then(
    (res) => res.json() as VehicleOnSiteListDto,
  );
}

function onSiteSummary(): Promise<VehicleOnSiteSummaryDto> {
  return ok(
    inject('GET', `/api/v1/vehicle-requests/on-site/summary?objectId=${ctx.onSiteObjectId}`),
  ).then((res) => res.json() as VehicleOnSiteSummaryDto);
}

const rowOf = (list: VehicleOnSiteListDto, id: string): SpecialEquipmentRequestDto | undefined =>
  list.items.find((item) => item.id === id);

describe.skipIf(!DB_URL)('смены заказа на объект (живая схема)', () => {
  // Scenes are built through real handlers, dozens of transactions each.
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 600_000 });

  beforeAll(async () => {
    // Environment and the own database are ready by the harness (`useReadModeDatabase`).
    process.env.MAIL_ENABLED ??= 'false';

    const { db, closeDb } = await import('../src/db/client');
    const { hashPassword } = await import('../src/auth/password');
    const email = `db-vehicle-shifts-admin-${RUN}@example.invalid`;
    await db.execute(sql`
      INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
      VALUES (${email}, 'Тестовый', 'Администратор', '', ${await hashPassword(PASSWORD)}, 'admin'::role, true)`);

    const driver = await db.execute<{ id: string }>(sql`
      WITH person AS (
        INSERT INTO persons (last_name, first_name, middle_name, comment)
        VALUES ('Сменов', 'Тест', 'Дневной', 'ТЕСТОВЫЕ ДАННЫЕ: смены заказа на объект')
        RETURNING id
      ), link AS (
        INSERT INTO person_specializations (person_id, specialization_id, is_primary, started_on)
        SELECT person.id, s.id, true, '2024-01-15'
          FROM person, specializations s
         WHERE s.code = 'driver'
        RETURNING person_id
      )
      SELECT id FROM person`);
    const object = await db.execute<{ id: string; code: string }>(sql`
      INSERT INTO construction_objects (code, name, address)
      VALUES (${OBJECT_CODE}, ${`Площадка смен ${RUN}`}, 'г Москва, ул Сменная, д 1'),
             (${`${OBJECT_CODE}-on-site`}, ${`Площадка среза смен ${RUN}`}, 'г Москва, ул Сменная, д 2')
      RETURNING id, code`);
    const objectOf = (code: string) => object.rows.find((row) => row.code === code)!.id;

    const needed = 5;
    const rented = await db.execute<{ id: string }>(sql`
      SELECT v.id FROM vehicles v
       WHERE v.ownership = 'rental' AND v.status = 'active' AND v.deleted_at IS NULL
       ORDER BY v.id
       LIMIT ${needed}`);
    if (rented.rows.length < needed) {
      throw new Error(`в базе нет ${needed} арендных машин: миграции не применены`);
    }
    const kind = await db.execute<{ id: string }>(sql`
      SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'`);

    const { buildApp: build } = await import('../src/app');
    const app = await build();
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const admin = { authorization: `Bearer ${login.json().accessToken}` };

    const type = await app.inject({
      method: 'POST',
      url: '/api/v1/vehicle-types',
      headers: admin,
      payload: {
        kindId: kind.rows[0]!.id,
        code: TYPE_CODE,
        name: `Катки смен ${RUN}`,
        isLinear: false,
      },
    });
    expect(type.statusCode, type.body).toBe(201);

    ctx = {
      app,
      db,
      closeDb,
      admin,
      objectId: objectOf(OBJECT_CODE),
      onSiteObjectId: objectOf(`${OBJECT_CODE}-on-site`),
      driverId: driver.rows[0]!.id,
      typeId: type.json().id as string,
      vehicles: rented.rows.map((row) => row.id),
      today: moscowDateKeyOf(new Date()),
    };
  });

  afterAll(async () => {
    await ctx?.app.close();
    await ctx?.closeDb();
  });

  describeReadModes(readMode, 'правка срока не выбрасывает заполненный день', (mode) => {
    const slot = mode === 'legacy' ? 0 : 2;

    /**
     * The wide edit is the term route of an old tab and, permanently, of a «Новая» order edited
     * without the journal (S-22). For an order in work its shortened end is refused by ADR 0044
     * before anything else, so the start moved forward is the case left to it.
     */
    it('широкая правка: сдвиг начала через заполненный день — 422 с датой, ничего не записано', async () => {
      const { today } = ctx;
      const request = await inLegacy(readMode, () =>
        requestInProgress({
          vehicleId: ctx.vehicles[slot]!,
          dateFrom: today,
          dateTo: shiftDateKey(today, 5),
        }),
      );
      await inLegacy(readMode, () => fillShift(request.id, today, 7.5));
      const before = await storedOf(request.id);

      const refused = await wideEdit(request.id, before.version, {
        dateFrom: shiftDateKey(today, 1),
      });
      expectDropRefusal(refused, today, 7.5);
      expect(await storedOf(request.id)).toEqual(before);

      // A term that only grows drops nothing and is not asked.
      await ok(wideEdit(request.id, before.version, { dateTo: shiftDateKey(today, 6) }));
      const grown = await storedOf(request.id);
      expect(grown.dateTo).toBe(shiftDateKey(today, 6));
      expect(grown.shifts).toEqual(before.shifts);

      // With the day's shift deleted in the shift window, the same move passes.
      await inLegacy(readMode, () => deleteShift(request.id, today));
      await ok(
        wideEdit(request.id, await versionOf(request.id), { dateFrom: shiftDateKey(today, 1) }),
      );
      expect((await storedOf(request.id)).dateFrom).toBe(shiftDateKey(today, 1));
    });

    /**
     * The term door refuses in its plan, so the preview answers the very 422 of the apply — the
     * consequences window shows that text — and the apply refuses before its fingerprint is even
     * compared. A signed day and an unsigned one refuse alike.
     */
    it('дверь срока: предпросмотр и команда — тот же 422 с датой, подпись дела не меняет', async () => {
      const { today } = ctx;
      const nextDay = shiftDateKey(today, 1);
      const request = await inLegacy(readMode, () =>
        requestInProgress({
          vehicleId: ctx.vehicles[slot + 1]!,
          dateFrom: today,
          dateTo: shiftDateKey(today, 5),
        }),
      );
      await inLegacy(readMode, async () => {
        await fillShift(request.id, today, 9);
        await signShift(request.id, today, true);
      });
      const before = await storedOf(request.id);
      expect(before.shifts).toEqual([{ date: today, approved: true }]);

      expectDropRefusal(await periodPreview(request.id, before.version, nextDay), today, 9);
      expectDropRefusal(
        await inject('PATCH', `/api/v1/vehicle-requests/${request.id}/period`, {
          version: before.version,
          dateFrom: nextDay,
        }),
        today,
        9,
      );
      expect(await storedOf(request.id)).toEqual(before);

      // Unsigned, the day is still a filled one.
      await inLegacy(readMode, () => signShift(request.id, today, false));
      expectDropRefusal(await periodPreview(request.id, before.version, nextDay), today, 9);

      // The day deleted, the door previews and applies the same move.
      await inLegacy(readMode, () => deleteShift(request.id, today));
      const version = await versionOf(request.id);
      const preview = await ok(periodPreview(request.id, version, nextDay));
      await ok(
        inject(
          'PATCH',
          `/api/v1/vehicle-requests/${request.id}/period`,
          armed(version, nextDay, preview.json() as PeriodPreviewDto),
        ),
      );
      const after = await storedOf(request.id);
      expect(after.dateFrom).toBe(nextDay);
      expect(after.shifts).toEqual([]);
    });
  });

  describe('срез «На объекте» по долгу подписей', () => {
    /**
     * The order whose term ended three days ago stays on the screen people look at every morning
     * while any of its days waits for the object's sign-off; a filled day is not a signed one. The
     * summary's `shiftsPending` is narrowed by the same filter as the list. A running order sits on
     * the list by its dates, debt or not.
     */
    it('отработанный срок держит заявку в срезе и в сводке, пока все дни не подписаны', async () => {
      const { today } = ctx;
      const days = [shiftDateKey(today, -3), shiftDateKey(today, -2), shiftDateKey(today, -1)];
      const expired = await requestInProgress({
        vehicleId: ctx.vehicles[4]!,
        dateFrom: days[0]!,
        dateTo: days[2]!,
        objectId: ctx.onSiteObjectId,
      });
      const running = await requestInProgress({
        vehicleId: ctx.vehicles[4]!,
        dateFrom: today,
        dateTo: shiftDateKey(today, 2),
        objectId: ctx.onSiteObjectId,
      });

      let list = await onSiteList();
      expect(list.onDate).toBe(today);
      expect(rowOf(list, expired.id)?.shifts?.unapprovedPastDays).toBe(3);
      expect(rowOf(list, running.id)?.shifts?.unapprovedPastDays).toBe(1);
      expect(list.total).toBe(2);
      let summary = await onSiteSummary();
      expect(summary.total).toBe(2);
      expect(summary.shiftsPending).toBe(2);

      // All three days filled, two signed: the third is still a debt.
      for (const day of days) await fillShift(expired.id, day);
      await signShift(expired.id, days[0]!, true);
      await signShift(expired.id, days[1]!, true);
      list = await onSiteList();
      expect(rowOf(list, expired.id)?.shifts).toMatchObject({
        approvedDays: 2,
        unapprovedPastDays: 1,
      });

      // The last sign-off lets the order go: nothing of it is left to accept.
      await signShift(expired.id, days[2]!, true);
      list = await onSiteList();
      expect(rowOf(list, expired.id)).toBeUndefined();
      expect(list.items.map((item) => item.id)).toEqual([running.id]);
      expect(list.total).toBe(1);
      summary = await onSiteSummary();
      expect(summary.total).toBe(1);
      // The running order's today is unsigned: it counts in the digit, and the expired one no more.
      expect(summary.shiftsPending).toBe(1);

      // Revoking a sign-off brings the debt, and the order, back.
      await signShift(expired.id, days[1]!, false);
      expect(rowOf(await onSiteList(), expired.id)?.shifts?.unapprovedPastDays).toBe(1);
      expect((await onSiteSummary()).shiftsPending).toBe(2);
    });
  });
});
