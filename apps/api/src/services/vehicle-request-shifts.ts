import { and, asc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  driverDayInterval,
  pastShiftDaysCount,
  refuelLabel,
  type RequestStatus,
  type SaveVehicleRequestShiftInput,
  SHIFT_IDLE_COMMENT_MESSAGE,
  shiftDaysOf,
  type VehicleRequestShiftDto,
  type VehicleRequestShiftsSummaryDto,
  type VehicleRequestType,
} from '@technic/contracts';
import { db } from '../db/client';
import { specialEquipmentRequestDetails, users, vehicleRequestShifts } from '../db/schema';
import { err } from '../lib/errors';
import { dateKeyRu } from './request-diff';
import { approvalLockingReassignmentSql, shiftWithinTermSql } from './shift-approval-scope';
import {
  driverDayDto,
  driverDiagnosticsDto,
  loadDriverShiftDays,
  type DriverShiftDay,
} from './shift-driver-days';

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
  date?: string,
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
    .where(
      and(
        eq(vehicleRequestShifts.requestId, requestId),
        date === undefined ? undefined : eq(vehicleRequestShifts.shiftDate, date),
      ),
    );
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

/** What a reader of the shift table may see beyond the numbers (D10). */
export interface ShiftReadOptions {
  /** The diagnostic `driver` block — only for a principal with `vehicleReadings.read`. */
  diagnostics?: boolean;
}

/**
 * The effective day (readings-shifts-merge plan §6.3 and §8), one rule for the shift table and the
 * linear days table:
 *
 * | day                      | hours, refuelling | time                   | comment | source   |
 * | ------------------------ | ----------------- | ---------------------- | ------- | -------- |
 * | signed                   | the row (frozen)  | the row (frozen)       | the row | `site`   |
 * | unsigned, driver clean   | driver            | driver's interval, row | the row | `driver` |
 * | unsigned, not clean, row | the row           | the row                | the row | `site`   |
 * | nothing                  | empty             | empty                  | empty   | `null`   |
 *
 * The driver's time is taken only on a clean day and only as ONE interval (`driverDayTime`); a day
 * whose readings do not fold into one keeps the site's time and shows the intervals instead. The
 * portal locks the time inputs by the same pair of conditions (`isShiftTimeFromDriver`).
 *
 * The driver's numbers ride along on every day that has them: under a signed day they show a later
 * reading edit as a difference instead of rewriting the signature (D4).
 */
export function effectiveShift(
  date: string,
  row: VehicleRequestShiftDto | undefined,
  driverDay: DriverShiftDay | undefined,
  options: ShiftReadOptions = {},
): VehicleRequestShiftDto {
  const extras: Pick<VehicleRequestShiftDto, 'driverDay' | 'driver'> = {
    driverDay: driverDay ? driverDayDto(driverDay) : null,
    ...(options.diagnostics ? { driver: driverDay ? driverDiagnosticsDto(driverDay) : null } : {}),
  };
  if (row?.approvedAt) return { ...row, source: 'site', ...extras };
  if (driverDay?.clean && driverDay.machineHours !== null) {
    return {
      ...(row ?? emptyShift(date)),
      ...driverDayInterval(driverDay),
      machineHours: driverDay.machineHours,
      refuel: refuelLabel(driverDay.refuelLiters),
      source: 'driver',
      ...extras,
    };
  }
  if (row) return { ...row, source: 'site', ...extras };
  return { ...emptyShift(date), source: null, ...extras };
}

/** The first and last day of a term — the range the driver days are read for. */
function termRange(days: readonly string[]): { from: string; to: string } | null {
  return days.length === 0 ? null : { from: days[0]!, to: days[days.length - 1]! };
}

/**
 * Shifts of a request by the days of its term: the effective day of each (§6.3), including the
 * empty days nobody has filled yet. The days come from the term, not from the table — unfilled
 * days have no rows at all, and without this the table would show only what was already written.
 */
export async function loadRequestShifts(
  requestId: string,
  term: ShiftTerm,
  reader: Reader = db,
  options: ShiftReadOptions = {},
): Promise<VehicleRequestShiftDto[]> {
  const days = shiftDaysOf(term);
  const range = termRange(days);
  if (!range) return [];
  const [saved, driver] = await Promise.all([
    loadShiftRows(reader, requestId),
    loadDriverShiftDays(reader, requestId, range),
  ]);
  return days.map((date) => effectiveShift(date, saved.get(date), driver.get(date), options));
}

/**
 * The site's physical row of one day; `null` — the site wrote nothing for it. Write doors decide
 * by the row, never by the effective day: a driver-only day has no row to delete, and DELETE
 * answering 404 for it is the rule (§6.5).
 *
 * Every writing shift door passes its transaction as the reader: the day is re-read **inside** it
 * and after `lockRequestRow`, otherwise the decision would rest on a state that is already wrong
 * by the time of the write (plan Р18, sub-stage 2a).
 */
export async function loadShiftRow(
  reader: Reader,
  requestId: string,
  date: string,
): Promise<VehicleRequestShiftDto | null> {
  return (await loadShiftRows(reader, requestId, date)).get(date) ?? null;
}

/** What the save and sign-off doors decide by, read under the request lock. */
export interface ShiftDoorState {
  row: VehicleRequestShiftDto | null;
  driverDay: DriverShiftDay | null;
  /** The effective day is the driver's: unsigned and clean (§6.3). */
  driverDriven: boolean;
}

/**
 * The candidate of a write door: the row and the driver day, computed by the same helper the
 * table reads with, under the request lock the door already holds. Readings themselves are not
 * locked: the signature records what this transaction read, and a later reading edit shows as a
 * difference next to the signed row (§6.5).
 */
export async function loadShiftDoorState(
  tx: Tx,
  requestId: string,
  date: string,
): Promise<ShiftDoorState> {
  const [row, driver] = await Promise.all([
    loadShiftRow(tx, requestId, date),
    loadDriverShiftDays(tx, requestId, { from: date, to: date }),
  ]);
  const driverDay = driver.get(date) ?? null;
  return {
    row,
    driverDay,
    driverDriven: !row?.approvedAt && !!driverDay?.clean && driverDay.machineHours !== null,
  };
}

/**
 * The handshake of a write door (§6.4): on a driver day the body must name the very driver numbers
 * the person saw, and anywhere else it must name none.
 *
 * Both mismatches are a 409 with a reload, not a 422. An old tab that saw a site-only row now
 * overlaid by a clean reading sends no fingerprint — signing would put a signature under numbers
 * nobody saw. A tab that saw a driver day sends one that no longer matches when a reading was
 * edited, rebased, voided or moved to another request — saving would bring back numbers that are
 * gone. In both cases refreshing the day is the whole cure.
 */
export function assertDriverHandshake(
  state: ShiftDoorState,
  expected: string | undefined,
  date: string,
): 'driver' | 'site' {
  if (state.driverDriven) {
    if (expected !== state.driverDay!.fingerprint) {
      throw err.conflict(
        `Показания водителя за ${dateKeyRu(date)} изменились — обновите смены и проверьте часы`,
      );
    }
    return 'driver';
  }
  if (expected !== undefined) {
    throw err.conflict(
      `Смена за ${dateKeyRu(date)} больше не берётся из показаний водителя — обновите смены`,
    );
  }
  return 'site';
}

/**
 * The reason of an idle driver day (zero hours; the database `CHECK` and the save schema hold the
 * same pair) is the site's own comment, else a 422 asking the site for one. Never the driver's
 * reading comment: it is diagnostics behind `vehicleReadings.read` (D10, access-model §9.3), the
 * signer may not hold that right and would publish a text it was never shown — the row's comment
 * goes to every reader of the request, the lessor included, and into the request history.
 */
export function driverDayComment(day: DriverShiftDay, siteComment: string, date: string): string {
  const comment = siteComment.trim();
  if (day.machineHours !== 0 || comment) return comment;
  throw err.unprocessable(
    `Смена за ${dateKeyRu(date)}: по показаниям водителя машина не работала — ${SHIFT_IDLE_COMMENT_MESSAGE.toLowerCase()}`,
    { comment: SHIFT_IDLE_COMMENT_MESSAGE },
  );
}

/**
 * The row a driver day is written as: the server-computed hours and refuelling, the driver's single
 * interval when the readings give one (plan §8), else the site's time, and the site's comment.
 * Neither door takes the driver's part from the body — a stale tab could otherwise bring back
 * numbers or times of a report voided or rebased meanwhile; the fingerprint covers the interval.
 */
export function driverShiftInput(
  day: DriverShiftDay,
  site: { startedAt: string | null; endedAt: string | null; comment: string },
  date: string,
): SaveVehicleRequestShiftInput {
  const time = driverDayInterval(day) ?? { startedAt: site.startedAt, endedAt: site.endedAt };
  return {
    startedAt: time.startedAt,
    endedAt: time.endedAt,
    machineHours: day.machineHours!,
    refuel: refuelLabel(day.refuelLiters),
    comment: driverDayComment(day, site.comment, date),
  };
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
