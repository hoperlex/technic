import { and, asc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  pastShiftDaysCount,
  type RequestStatus,
  type SaveVehicleRequestShiftInput,
  shiftDaysOf,
  type VehicleRequestShiftDto,
  type VehicleRequestShiftsSummaryDto,
  type VehicleRequestType,
} from '@technic/contracts';
import { db } from '../db/client';
import { specialEquipmentRequestDetails, users, vehicleRequestShifts } from '../db/schema';
import { approvalLockingReassignmentSql, shiftWithinTermSql } from './shift-approval-scope';

// Подтверждение смен по заказу спецтехники: день работы, его показатели и подпись объекта.
// Здесь только данные — проверки прав, статусов и границ дня живут в маршруте, а правило «какой
// день можно вести» одно на портал и API и лежит в контрактах (`shiftDayBlocker`).

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Кто читает смены. Пул годится всюду, где смену показывают, а транзакция обязательна там, где по
 * прочитанному тут же принимают решение: подпись и правка перечитывают день **под** блокировкой
 * заявки, и чтение мимо транзакции вернуло бы им состояние до собственной блокировки.
 */
type Reader = Tx | typeof db;

/** Кто внёс часы и кто их принял — две разные учётки, поэтому два алиаса на таблицу учёток. */
const fillers = alias(users, 'shift_fillers');
const shiftApprovers = alias(users, 'shift_approvers');

/** Срок заказа, по которому строится таблица смен. */
export interface ShiftTerm {
  dateFrom: string;
  dateTo: string | null;
}

/** Заявка глазами сводки: тип и статус решают, считается ли по ней долг подписей. */
export interface ShiftSummarySubject {
  id: string;
  requestType: VehicleRequestType;
  status: RequestStatus;
  dateFrom: string | null;
  dateTo: string | null;
}

/**
 * "The shift row lies inside the current term" — one expression with the lock of a plain
 * reassignment (`shift-approval-scope.ts`), so the counts here and the days the door refuses by
 * cannot use different bounds.
 */
const withinTerm = shiftWithinTermSql();

/** pg returns `numeric` as a string; hours are always filled, so a non-number reads as zero. */
function hours(v: string | null): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** pg returns `time` as `08:00:00`; a shift is read to the minute, the way it is typed. */
function timeOnly(v: string | null): string | null {
  return v ? v.slice(0, 5) : null;
}

/** A day of the term nobody filled: it is a row of the table but has no row in the database. */
function emptyShift(date: string): VehicleRequestShiftDto {
  return {
    date,
    startedAt: null,
    endedAt: null,
    machineHours: 0,
    refuel: '',
    comment: '',
    filledBy: null,
    filledByName: null,
    filledAt: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
  };
}

/**
 * The physical shift rows of a request by day — what the site wrote, with nothing derived. Every
 * row, not only the term's: the linear days table shows a planned day outside the term that an
 * issued route still holds (ADR 0100), and its row must stay visible there.
 *
 * The one mapper of a row: the shift table and the linear days table read hours, times and the
 * sign-off through it, so the two cannot parse `numeric` and `time` differently.
 */
export async function loadShiftRows(
  reader: Reader,
  requestId: string,
): Promise<Map<string, VehicleRequestShiftDto>> {
  const rows = await reader
    .select({
      shiftDate: vehicleRequestShifts.shiftDate,
      startedAt: vehicleRequestShifts.startedAt,
      endedAt: vehicleRequestShifts.endedAt,
      machineHours: vehicleRequestShifts.machineHours,
      refuel: vehicleRequestShifts.refuel,
      comment: vehicleRequestShifts.comment,
      filledBy: vehicleRequestShifts.filledBy,
      filledByName: fillers.fullName,
      filledAt: vehicleRequestShifts.updatedAt,
      approvedBy: vehicleRequestShifts.approvedBy,
      approvedByName: shiftApprovers.fullName,
      approvedAt: vehicleRequestShifts.approvedAt,
    })
    .from(vehicleRequestShifts)
    .innerJoin(fillers, eq(vehicleRequestShifts.filledBy, fillers.id))
    .leftJoin(shiftApprovers, eq(vehicleRequestShifts.approvedBy, shiftApprovers.id))
    .where(eq(vehicleRequestShifts.requestId, requestId));
  return new Map(
    rows.map((row) => [
      row.shiftDate,
      {
        date: row.shiftDate,
        startedAt: timeOnly(row.startedAt),
        endedAt: timeOnly(row.endedAt),
        machineHours: hours(row.machineHours),
        refuel: row.refuel,
        comment: row.comment,
        filledBy: row.filledBy,
        filledByName: row.filledByName,
        filledAt: row.filledAt.toISOString(),
        approvedBy: row.approvedBy,
        approvedByName: row.approvedByName,
        approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      },
    ]),
  );
}

/**
 * Shifts of a request by the days of its term: filled rows and the empty days nobody has filled
 * yet. The days come from the term, not from the table — unfilled days have no rows at all, and
 * without this the table would show only what was already written.
 */
export async function loadRequestShifts(
  requestId: string,
  term: ShiftTerm,
  reader: Reader = db,
): Promise<VehicleRequestShiftDto[]> {
  const saved = await loadShiftRows(reader, requestId);
  return shiftDaysOf(term).map((date) => saved.get(date) ?? emptyShift(date));
}

/**
 * One shift by its day; `null` — nothing is entered for this day.
 *
 * Every writing shift door passes its transaction as the reader: the day is re-read **inside** it
 * and after `lockRequestRow`, otherwise the decision would rest on a state that is already wrong
 * by the time of the write (plan Р18, sub-stage 2a).
 */
export async function loadRequestShift(
  requestId: string,
  date: string,
  term: ShiftTerm,
  reader: Reader = db,
): Promise<VehicleRequestShiftDto | null> {
  const shift = (await loadRequestShifts(requestId, term, reader)).find((s) => s.date === date);
  return shift?.filledAt ? shift : null;
}

/**
 * Shift summary of a list row: how many days are approved, how many of them lock a plain
 * reassignment, and how many past days still wait for a sign-off. Counts, not dates: they serve the
 * warning at closing, the lock of the vehicle and of the rollback, and the "On site" warning, and
 * dates are needed only in the day list and in the shift table itself.
 *
 * Долг считается только у заявки в работе: у «Новой» на объект никто не выходил, у отменённой
 * работы не было, а у выполненной он остался бы навсегда — заявки, закрытые до появления смен,
 * иначе показывали бы долг, погасить который уже нечем.
 */
export async function shiftSummaries(
  requests: ShiftSummarySubject[],
  onDate: string,
): Promise<Map<string, VehicleRequestShiftsSummaryDto>> {
  const summaries = new Map<string, VehicleRequestShiftsSummaryDto>();
  const special = requests.filter((r) => r.requestType === 'special_equipment' && r.dateFrom);
  if (special.length === 0) return summaries;

  const rows = await db
    .select({
      requestId: vehicleRequestShifts.requestId,
      // Подтверждённые дни — только внутри нынешнего срока: правка начала периода могла оставить
      // за его пределами строку, которая к сегодняшнему заказу уже не относится.
      approvedDays: sql<number>`count(*) FILTER (
        WHERE ${vehicleRequestShifts.approvedAt} IS NOT NULL AND ${withinTerm}
      )`,
      // The days that lock a plain reassignment (ADR 0210) — counted by the very predicate the door
      // re-reads under its locks and the preview names them by; a day in its own route was worked
      // by the route's vehicle and does not count. `true`: the list does not know the next vehicle
      // and counts the own case, the door asks again with the rented one.
      approvedDaysWithoutRoute: sql<number>`count(*) FILTER (
        WHERE ${approvalLockingReassignmentSql(true)}
      )`,
      approvedPastDays: sql<number>`count(*) FILTER (
        WHERE ${vehicleRequestShifts.approvedAt} IS NOT NULL AND ${withinTerm}
          AND ${vehicleRequestShifts.shiftDate} <= ${onDate}::date
      )`,
    })
    .from(vehicleRequestShifts)
    .innerJoin(
      specialEquipmentRequestDetails,
      eq(specialEquipmentRequestDetails.requestId, vehicleRequestShifts.requestId),
    )
    .where(
      inArray(
        vehicleRequestShifts.requestId,
        special.map((r) => r.id),
      ),
    )
    .groupBy(vehicleRequestShifts.requestId);

  const counted = new Map(rows.map((r) => [r.requestId, r]));
  for (const r of special) {
    const row = counted.get(r.id);
    const pastDays =
      r.status === 'confirmed'
        ? pastShiftDaysCount({ dateFrom: r.dateFrom!, dateTo: r.dateTo }, onDate)
        : 0;
    summaries.set(r.id, {
      approvedDays: Number(row?.approvedDays ?? 0),
      approvedDaysWithoutRoute: Number(row?.approvedDaysWithoutRoute ?? 0),
      unapprovedPastDays: Math.max(0, pastDays - Number(row?.approvedPastDays ?? 0)),
    });
  }
  return summaries;
}

/**
 * У заявки остались наступившие, но не подтверждённые дни — SQL-выражение для отбора и сводки
 * среза «На объекте». Запрос обязан быть соединён с деталями спецтехники: срок живёт там.
 *
 * Считается разницей «сколько дней уже прошло» и «сколько из них подтверждено» — тем же счётом,
 * что и сводка строки. Отдельного флага у заявки нет намеренно: он разошёлся бы с таблицей смен
 * при первой же правке срока.
 */
export function hasUnapprovedPastShiftsSql(onDate: string): SQL<boolean> {
  return sql<boolean>`(
    GREATEST(
      0,
      LEAST(
        coalesce(${specialEquipmentRequestDetails.dateTo}, ${specialEquipmentRequestDetails.dateFrom}),
        ${onDate}::date
      ) - ${specialEquipmentRequestDetails.dateFrom} + 1
    ) > (
      SELECT count(*)
      FROM vehicle_request_shifts s
      WHERE s.request_id = ${specialEquipmentRequestDetails.requestId}
        AND s.approved_at IS NOT NULL
        AND s.shift_date <= ${onDate}::date
        AND s.shift_date BETWEEN ${specialEquipmentRequestDetails.dateFrom}
          AND coalesce(${specialEquipmentRequestDetails.dateTo}, ${specialEquipmentRequestDetails.dateFrom})
    )
  )`;
}

/** Наступившие дни заказа без подписи — ими пометка в истории объясняет, что закрыли без приёмки. */
export async function unapprovedPastShiftDates(
  requestId: string,
  term: ShiftTerm,
  onDate: string,
): Promise<string[]> {
  const rows = await db
    .select({ shiftDate: vehicleRequestShifts.shiftDate })
    .from(vehicleRequestShifts)
    .where(
      and(
        eq(vehicleRequestShifts.requestId, requestId),
        isNotNull(vehicleRequestShifts.approvedAt),
      ),
    );
  const approved = new Set(rows.map((r) => r.shiftDate));
  return shiftDaysOf(term).filter((day) => day <= onDate && !approved.has(day));
}

/**
 * Записать смену дня: первое заполнение заводит строку, повторное её переписывает. Согласованную
 * строку сюда не пускает маршрут — сначала снимают подпись, иначе принятый день менялся бы под
 * уже поставленной подписью.
 */
export async function saveRequestShift(
  tx: Tx,
  params: { requestId: string; date: string; actorId: string; input: SaveVehicleRequestShiftInput },
): Promise<void> {
  const { requestId, date, actorId, input } = params;
  const values = {
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    machineHours: String(input.machineHours),
    refuel: input.refuel,
    comment: input.comment,
    filledBy: actorId,
  };
  await tx
    .insert(vehicleRequestShifts)
    .values({ requestId, shiftDate: date, ...values })
    .onConflictDoUpdate({
      target: [vehicleRequestShifts.requestId, vehicleRequestShifts.shiftDate],
      set: { ...values, updatedAt: new Date() },
    });
}

/** Поставить подпись объекта под днём или снять её. */
export async function setShiftApproval(
  tx: Tx,
  params: { requestId: string; date: string; approved: boolean; actorId: string },
): Promise<void> {
  const { requestId, date, approved, actorId } = params;
  await tx
    .update(vehicleRequestShifts)
    .set({
      approvedBy: approved ? actorId : null,
      approvedAt: approved ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(vehicleRequestShifts.requestId, requestId), eq(vehicleRequestShifts.shiftDate, date)),
    );
}

/** Убрать ошибочно заведённый день; согласованный не удаляется — это проверяет маршрут. */
export async function deleteRequestShift(tx: Tx, requestId: string, date: string): Promise<void> {
  await tx
    .delete(vehicleRequestShifts)
    .where(
      and(eq(vehicleRequestShifts.requestId, requestId), eq(vehicleRequestShifts.shiftDate, date)),
    );
}

/**
 * Every shift row of the request with its approval mark — exactly the rows `dropRequestShifts`
 * deletes, read by the rollback plan (ADR 0211) so the preview names what the door erases.
 *
 * All rows, not only the days of the current term: the door deletes by request, and an approved
 * day left outside the term by an earlier start-date edit goes too — it does not block the rollback
 * (`approvedShiftsBlocker` counts days inside the term only), so the preview must say it aloud.
 */
export async function requestShiftRows(
  reader: Reader,
  requestId: string,
): Promise<{ date: string; approved: boolean }[]> {
  const rows = await reader
    .select({
      shiftDate: vehicleRequestShifts.shiftDate,
      approvedAt: vehicleRequestShifts.approvedAt,
    })
    .from(vehicleRequestShifts)
    .where(eq(vehicleRequestShifts.requestId, requestId))
    .orderBy(asc(vehicleRequestShifts.shiftDate));
  return rows.map((row) => ({ date: row.shiftDate, approved: row.approvedAt !== null }));
}

/**
 * Снять все смены заявки — при откате в «Новую» (ADR 0058). Откат стирает работу целиком: машины
 * нет, рейса нет, и дни её работы вместе с ними. Подтверждённых дней тут уже не бывает — с ними
 * откат отклоняется, — и удаляются только черновики часов.
 */
export async function dropRequestShifts(tx: Tx, requestId: string): Promise<void> {
  await tx.delete(vehicleRequestShifts).where(eq(vehicleRequestShifts.requestId, requestId));
}
