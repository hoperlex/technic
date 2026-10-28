import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { weeklyAnnulItemState, type WeeklyApplyResultDto } from '@technic/contracts';
import { describeReadModes, useReadModeDatabase, type TestReadMode } from './assignment-read-mode';
// Types only: the values come by `await import` once the environment is set — the config checks it
// on import and fails without it.
import type { db as AppDb } from '../src/db/client';

/**
 * The month cut of a rental extension on the live schema (ADR 0238): the visa moves the existing
 * order only up to the last day of its month and opens a new order of the same rented vehicle for
 * the rest, in the same transaction.
 *
 * WHY THE SERVICE IS CALLED DIRECTLY WITH A PINNED DATE. A week that holds a month border is not
 * always among the four the portal offers (the nearest ones are 30 Nov – 6 Dec and 28 Dec – 3 Jan),
 * so the API cannot make the scene on a given day. `Date` alone is faked: the visa takes "today"
 * from it, while the pool and the database run on real timers.
 *
 * Both read modes run (`describeReadModes`): in `history` the new order writes the assignment
 * history through `enterWorkWithHistory`, in `legacy` it goes through the weekly sweep.
 *
 * Own database, a file of its own; run with `TEST_DATABASE_URL` pointing at a server:
 *
 *   TEST_DATABASE_URL=postgres://technic:technic@127.0.0.1:5433/postgres \
 *     npx vitest run test/weekly-rental-continuation.db.test.ts --maxWorkers=1
 */

const readMode = useReadModeDatabase('rentcont');

/** Monday 23 Nov 2026: the week of 30 Nov – 6 Dec is the nearest future one and holds the border. */
const PINNED_NOW = new Date('2026-11-23T09:00:00+03:00');
const WEEK = '2026-11-30';

interface Scene {
  db: typeof AppDb;
  actorId: string;
  typeId: string;
  rentalVehicleId: string;
  switchedOffVehicleId: string;
  /** Every order of the scene sits on a site of its own: `UNIQUE (object_id, week_start)`. */
  objects: string[];
}

let scene: Scene;
let suffix = 0;

async function freshObject(): Promise<string> {
  const code = `RC-${Date.now().toString(36)}-${++suffix}`;
  const rows = await scene.db.execute<{ id: string }>(sql`
    INSERT INTO construction_objects (code, name, address)
    VALUES (${code}, ${`ТЕСТ площадка ${code}`}, 'г Москва, ул Тестовая, д 1')
    RETURNING id`);
  const id = rows.rows[0]!.id;
  scene.objects.push(id);
  return id;
}

interface Order {
  id: string;
  num: number;
  objectId: string;
}

/**
 * An order of the rented vehicle already in work: what the status door leaves behind. `history`
 * adds the history rows of the entry, which the door writes in that mode.
 */
async function rentalOrderInWork(
  mode: TestReadMode,
  term: { dateFrom: string; dateTo: string },
  options: { vehicleId?: string } = {},
): Promise<Order> {
  const { createSpecialEquipmentRequest } = await import('../src/services/vehicle-request-create');
  const { enterWorkWithHistory } = await import('../src/services/assignment-work-entry');
  const { requireOpenDoor } = await import('../src/services/assignment-mode');
  const objectId = await freshObject();
  const vehicleId = options.vehicleId ?? scene.rentalVehicleId;
  return scene.db.transaction(async (tx) => {
    const snapshot = await requireOpenDoor(tx, 'history');
    const id = await createSpecialEquipmentRequest(tx, {
      objectId,
      vehicleTypeId: scene.typeId,
      vehicleCategoryId: null,
      dateFrom: term.dateFrom,
      dateTo: term.dateTo,
      responsibleName: 'Арендов Пётр Сергеевич',
      responsiblePhone: '9007770931',
      comment: 'ТЕСТ: аренда и граница месяца',
      createdBy: scene.actorId,
      approvedBy: scene.actorId,
      approvedAt: new Date(),
    });
    await tx.execute(sql`
      INSERT INTO vehicle_request_assignments
        (request_id, vehicle_id, vehicle_type_id, ordered_vehicle_type_id, price_per_hour,
         price_per_shift, shift_hours, assigned_by)
      VALUES (${id}, ${vehicleId}, ${scene.typeId}, ${scene.typeId}, 1500, 12000, 8,
              ${scene.actorId})`);
    await tx.execute(sql`
      UPDATE vehicle_requests SET status = 'confirmed', version = version + 1 WHERE id = ${id}`);
    await tx.execute(sql`
      INSERT INTO vehicle_request_status_history
        (vehicle_request_id, from_status, to_status, changed_by)
      VALUES (${id}, 'new', 'confirmed', ${scene.actorId})`);
    if (mode === 'history') {
      await enterWorkWithHistory(tx as never, {
        requestId: id,
        actor: { id: scene.actorId },
        asOf: '2026-11-23',
        mode: snapshot,
        driverPersonId: null,
        reason: 'ТЕСТ: заказ взят в работу',
      });
    }
    const [row] = (
      await tx.execute<{ num: number }>(sql`SELECT num FROM vehicle_requests WHERE id = ${id}`)
    ).rows;
    return { id, num: row!.num, objectId };
  });
}

/** A pending week of the order's site with one `extend` row, signed through the service. */
async function applyExtension(
  order: Order,
  from: string,
  dateTo: string,
): Promise<{ weeklyId: string; result: WeeklyApplyResultDto }> {
  const { applyWeeklyRequest } = await import('../src/services/weekly-request-apply');
  const header = await scene.db.execute<{ id: string; version: number }>(sql`
    INSERT INTO weekly_vehicle_requests (object_id, week_start, status, created_by)
    VALUES (${order.objectId}, ${WEEK}::date, 'pending'::weekly_request_status, ${scene.actorId})
    RETURNING id, version`);
  const weekly = header.rows[0]!;
  await scene.db.execute(sql`
    INSERT INTO weekly_vehicle_request_items
      (weekly_request_id, week_start, position, kind, source_request_id, date_to, expected_date_to)
    VALUES (${weekly.id}, ${WEEK}::date, 0, 'extend'::weekly_request_item_kind, ${order.id},
            ${dateTo}::date, ${from}::date)`);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PINNED_NOW);
  try {
    const outcome = await scene.db.transaction((tx) =>
      applyWeeklyRequest(tx, {
        weeklyRequestId: weekly.id,
        expectedVersion: weekly.version,
        actor: { id: scene.actorId },
      }),
    );
    return { weeklyId: weekly.id, result: outcome.result };
  } finally {
    vi.useRealTimers();
  }
}

async function termOf(id: string) {
  const rows = await scene.db.execute<{ date_from: string; date_to: string | null }>(sql`
    SELECT date_from::text AS date_from, date_to::text AS date_to
      FROM special_equipment_request_details WHERE request_id = ${id}`);
  return rows.rows[0]!;
}

async function orderRow(id: string) {
  const rows = await scene.db.execute<{
    status: string;
    version: number;
    comment: string;
    approved_by: string | null;
    vehicle_id: string | null;
    price_per_hour: string | null;
    price_per_shift: string | null;
    shift_hours: number | null;
  }>(sql`
    SELECT r.status::text AS status, r.version, r.comment, r.approved_by,
           a.vehicle_id, a.price_per_hour::text AS price_per_hour,
           a.price_per_shift::text AS price_per_shift, a.shift_hours
      FROM vehicle_requests r
      LEFT JOIN vehicle_request_assignments a ON a.request_id = r.id
     WHERE r.id = ${id}`);
  return rows.rows[0]!;
}

async function itemRow(weeklyId: string) {
  const rows = await scene.db.execute<{
    result: string;
    previous_date_to: string | null;
    continuation_request_id: string | null;
  }>(sql`
    SELECT result::text AS result, previous_date_to::text AS previous_date_to,
           continuation_request_id
      FROM weekly_vehicle_request_items WHERE weekly_request_id = ${weeklyId}`);
  return rows.rows[0]!;
}

async function statusHistory(id: string) {
  const rows = await scene.db.execute<{ from_status: string | null; to_status: string }>(sql`
    SELECT from_status::text AS from_status, to_status::text AS to_status
      FROM vehicle_request_status_history WHERE vehicle_request_id = ${id}
     ORDER BY to_status`);
  return rows.rows.map((r) => `${r.from_status ?? '—'}→${r.to_status}`);
}

describe.skipIf(!readMode.enabled)('аренда: разрез продления границей месяца (живая схема)', () => {
  beforeAll(async () => {
    const { db } = await import('../src/db/client');
    const [actor] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, last_name, first_name, middle_name, password_hash, role, is_active)
        VALUES (${`db-rentcont-${Date.now()}@example.invalid`}, 'Тестовый', 'Визирующий', '',
                'x', 'admin', true)
        RETURNING id`)
    ).rows;
    const [lessor] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO counterparties (name, type, inn, comment)
        VALUES (${`ТЕСТ Арендодатель границы месяца (${Date.now()})`}, 'vehicle_lessor',
                ${String(Date.now()).slice(-10)}, 'ТЕСТОВЫЕ ДАННЫЕ: граница месяца')
        RETURNING id`)
    ).rows;
    const [kind] = (
      await db.execute<{ id: string }>(
        sql`SELECT id FROM vehicle_kinds WHERE code = 'special_equipment'`,
      )
    ).rows;
    // A type of its own with no categories: the order needs no category, and no neighbour's
    // directory change can break the scene.
    const [type] = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO vehicle_types (kind_id, code, name, is_linear)
        VALUES (${kind!.id}, ${`rentcont_${Date.now().toString(36)}`}, 'Яя тестовый тип границы месяца', false)
        RETURNING id`)
    ).rows;
    const rental = async (description: string, status: string) =>
      (
        await db.execute<{ id: string }>(sql`
          INSERT INTO vehicles (vehicle_type_id, ownership, lessor_id, lessor_type, lessor_is_active,
                                description, price_per_hour, price_per_shift, shift_hours, status)
          VALUES (${type!.id}, 'rental', ${lessor!.id}, 'vehicle_lessor', true, ${description},
                  1500, 12000, 8, ${sql.raw(`'${status}'::vehicle_status`)})
          RETURNING id`)
      ).rows[0]!.id;
    scene = {
      db,
      actorId: actor!.id,
      typeId: type!.id,
      rentalVehicleId: await rental('ТЕСТ аренда границы месяца', 'active'),
      switchedOffVehicleId: await rental('ТЕСТ аренда выключена', 'active'),
      objects: [],
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    const { closeDb } = await import('../src/db/client');
    await closeDb();
  });

  describeReadModes(readMode, 'граница месяца', (mode) => {
    it('продление через границу: старый заказ — до конца месяца, новый — с 1-го числа, в работе', async () => {
      const order = await rentalOrderInWork(mode, { dateFrom: '2026-11-23', dateTo: '2026-11-29' });
      const before = await orderRow(order.id);
      const { weeklyId, result } = await applyExtension(order, '2026-11-29', '2026-12-06');

      expect(await termOf(order.id)).toEqual({ date_from: '2026-11-23', date_to: '2026-11-30' });
      expect((await orderRow(order.id)).version).toBe(before.version + 1);

      const item = await itemRow(weeklyId);
      expect(item.result).toBe('extended');
      expect(item.previous_date_to).toBe('2026-11-29');
      expect(item.continuation_request_id).not.toBeNull();

      const continuation = item.continuation_request_id!;
      expect(await termOf(continuation)).toEqual({
        date_from: '2026-12-01',
        date_to: '2026-12-06',
      });
      const created = await orderRow(continuation);
      expect(created.status).toBe('confirmed');
      expect(created.approved_by).toBe(scene.actorId);
      expect(created.vehicle_id).toBe(scene.rentalVehicleId);
      expect(created.price_per_hour).toBe('1500.00');
      expect(created.price_per_shift).toBe('12000.00');
      expect(created.shift_hours).toBe(8);
      expect(created.comment).toContain(`ТС-${order.num}`);
      expect(await statusHistory(continuation)).toEqual(['new→confirmed', '—→new']);

      const row = result.items[0]!;
      expect(row.result).toBe('extended');
      expect(row.previousDateTo).toBe('2026-11-29');
      expect(row.newDateTo).toBe('2026-11-30');
      expect(row.continuation).toMatchObject({
        requestId: continuation,
        dateFrom: '2026-12-01',
        dateTo: '2026-12-06',
        assigned: true,
      });
      expect(row.continuation?.note).toContain('откроется новый заказ той же машины');
    });

    it('«продление с 1 числа»: заказ кончается в последний день месяца — он не меняется, всё уходит новому заказу', async () => {
      const order = await rentalOrderInWork(mode, { dateFrom: '2026-11-23', dateTo: '2026-11-30' });
      const before = await orderRow(order.id);
      const { weeklyId, result } = await applyExtension(order, '2026-11-30', '2026-12-06');

      expect(await termOf(order.id)).toEqual({ date_from: '2026-11-23', date_to: '2026-11-30' });
      // The existing order is not touched at all: not even its version moves.
      expect((await orderRow(order.id)).version).toBe(before.version);

      const item = await itemRow(weeklyId);
      expect(item.result).toBe('extended');
      expect(item.previous_date_to).toBe('2026-11-30');
      expect(await termOf(item.continuation_request_id!)).toEqual({
        date_from: '2026-12-01',
        date_to: '2026-12-06',
      });
      expect(result.items[0]?.newDateTo).toBe('2026-11-30');
      expect(result.items[0]?.continuation?.note).toContain('заказ остаётся как есть');
    });

    it('продление не дальше границы идёт как раньше и нового заказа не открывает', async () => {
      const order = await rentalOrderInWork(mode, { dateFrom: '2026-11-23', dateTo: '2026-11-29' });
      const { weeklyId, result } = await applyExtension(order, '2026-11-29', '2026-11-30');

      expect(await termOf(order.id)).toEqual({ date_from: '2026-11-23', date_to: '2026-11-30' });
      expect((await itemRow(weeklyId)).continuation_request_id).toBeNull();
      expect(result.items[0]?.continuation).toBeNull();
    });

    it('машину нельзя поставить на новый заказ: он остаётся «Новой» без машины, неделя не падает', async () => {
      const vehicleId = scene.switchedOffVehicleId;
      const order = await rentalOrderInWork(
        mode,
        { dateFrom: '2026-11-23', dateTo: '2026-11-29' },
        { vehicleId },
      );
      // The rental offer is switched off after the order went into work: the assignment stays, the
      // vehicle no longer goes out (a rental has only `active` and `inactive`).
      await scene.db.execute(sql`UPDATE vehicles SET status = 'inactive' WHERE id = ${vehicleId}`);
      const { weeklyId, result } = await applyExtension(order, '2026-11-29', '2026-12-06');

      expect(await termOf(order.id)).toEqual({ date_from: '2026-11-23', date_to: '2026-11-30' });
      const continuation = (await itemRow(weeklyId)).continuation_request_id!;
      const created = await orderRow(continuation);
      expect(created.status).toBe('new');
      expect(created.vehicle_id).toBeNull();
      expect(created.approved_by).toBe(scene.actorId);
      expect(result.items[0]?.continuation).toMatchObject({ assigned: false });
      expect(result.items[0]?.continuation?.note).toContain('машина недоступна: неактивна');
      expect(result.items[0]?.continuation?.note).toContain('назначьте её вручную');
    });

    it('новый заказ завести нельзя (тип погашен): строка пропущена целиком, старый заказ не тронут', async () => {
      const order = await rentalOrderInWork(mode, { dateFrom: '2026-11-23', dateTo: '2026-11-29' });
      await scene.db.execute(
        sql`UPDATE vehicle_types SET is_active = false WHERE id = ${scene.typeId}`,
      );
      try {
        await expect(applyExtension(order, '2026-11-29', '2026-12-06')).rejects.toThrow(
          /новый заказ завести нельзя: тип ТС погашен/,
        );
      } finally {
        await scene.db.execute(
          sql`UPDATE vehicle_types SET is_active = true WHERE id = ${scene.typeId}`,
        );
      }
      expect(await termOf(order.id)).toEqual({ date_from: '2026-11-23', date_to: '2026-11-29' });
    });

    it('разворот недели ждёт, пока заказ-продолжение жив, и отпускает после его отмены', async () => {
      const { annulStates } = await import('../src/services/weekly-request-annul-state');
      const order = await rentalOrderInWork(mode, { dateFrom: '2026-11-23', dateTo: '2026-11-29' });
      const { weeklyId } = await applyExtension(order, '2026-11-29', '2026-12-06');
      const item = await itemRow(weeklyId);

      const read = async () => {
        const states = await annulStates(scene.db, {
          weeklyId,
          appliedAt: new Date(),
          items: [
            {
              id: 'row',
              kind: 'extend',
              result: 'extended',
              dateTo: '2026-12-06',
              previousDateTo: item.previous_date_to,
              orderId: order.id,
              continuationRequestId: item.continuation_request_id,
            },
          ],
        });
        return states[0]!;
      };

      const blocked = await read();
      expect(blocked.state).toBe('blocked');
      expect(blocked.reason).toContain('откатите его в «Новую» и отмените');

      await scene.db.execute(
        sql`UPDATE vehicle_requests SET status = 'cancelled' WHERE id = ${item.continuation_request_id}`,
      );
      const released = await read();
      expect(released.state).toBe('reversible');
      expect(released.reverse).toBe('shorten_to');
      expect(released.shortenTo).toBe('2026-11-29');
      // The same verdict the portal computes from the same facts.
      expect(
        weeklyAnnulItemState(
          {
            id: 'row',
            kind: 'extend',
            result: 'extended',
            dateTo: '2026-12-06',
            previousDateTo: '2026-11-29',
            laterWeekRefs: [],
            continuationOrder: { num: 1, status: 'cancelled', deletedAt: null },
          },
          {
            status: 'confirmed',
            deletedAt: null,
            dateFrom: '2026-11-23',
            dateTo: '2026-11-30',
            pickupRoute: null,
            pendingEarlyEndDate: null,
          },
        ).state,
      ).toBe('reversible');
    });
  });
});
