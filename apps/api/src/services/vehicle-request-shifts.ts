import { and, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
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

/** «Смена внутри нынешнего срока заявки» — условие, общее для сводки и для отбора среза. */
const withinTerm = sql`${vehicleRequestShifts.shiftDate}
  BETWEEN ${specialEquipmentRequestDetails.dateFrom}
  AND coalesce(${specialEquipmentRequestDetails.dateTo}, ${specialEquipmentRequestDetails.dateFrom})`;

/** numeric из pg приходит строкой; часы всегда заполнены — нечисло читается как ноль. */
function hours(v: string | null): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** `time` из pg приходит как `08:00:00`; смена читается до минут — так её и вводят. */
function timeOnly(v: string | null): string | null {
  return v ? v.slice(0, 5) : null;
}

/** День заказа, за который ничего не внесли: строкой в таблице он есть, в базе — ещё нет. */
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
 * Смены заявки по дням заказа: заполненные строки и пустые дни, за которые ещё ничего не внесли.
 * Дни считаются из срока, а не из таблицы — строк на незаполненные дни в базе нет вовсе, и без
 * этого таблица показывала бы только то, что уже успели записать.
 */
export async function loadRequestShifts(
  requestId: string,
  term: ShiftTerm,
  reader: Reader = db,
): Promise<VehicleRequestShiftDto[]> {
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

  const saved = new Map(rows.map((r) => [r.shiftDate, r]));
  return shiftDaysOf(term).map((date) => {
    const row = saved.get(date);
    if (!row) return emptyShift(date);
    return {
      date,
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
    };
  });
}

/**
 * Одна смена по её дню; `null` — за этот день ничего не внесено.
 *
 * Читателя передают все пишущие ручки смен: они перечитывают день **внутри** транзакции и после
 * `lockRequestRow`, иначе решение принималось бы по состоянию, которое к моменту записи уже
 * неверно (план Р18, подэтап 2a).
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
 * Сводка смен для строк списка: сколько дней подтверждено и сколько прошедших дней ещё ждёт
 * подписи. Двумя числами — их хватает трём правилам сразу (предупреждение при закрытии, смена
 * машины, предупреждение в срезе), а даты нужны только в перечне дней и в самой таблице смен.
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
 * Снять все смены заявки — при откате в «Новую» (ADR 0058). Откат стирает работу целиком: машины
 * нет, рейса нет, и дни её работы вместе с ними. Подтверждённых дней тут уже не бывает — с ними
 * откат отклоняется, — и удаляются только черновики часов.
 */
export async function dropRequestShifts(tx: Tx, requestId: string): Promise<void> {
  await tx.delete(vehicleRequestShifts).where(eq(vehicleRequestShifts.requestId, requestId));
}
