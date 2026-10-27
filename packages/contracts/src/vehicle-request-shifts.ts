import { z } from 'zod';
import { requestStatusLabels, type RequestStatus, type VehicleRequestType } from './enums';
import {
  dateKeySpan,
  dateKeysBetween,
  shiftDateKey,
  TIME_FORMAT_MESSAGE,
  TIME_PATTERN,
} from './time';
import type { ReadingSourceKind } from './driver-cabinet';
import type { DriverDayTimeIssue, ShiftInterval } from './reading-times';
import type { DiscrepancyKind, DriverReportState, ReadingKind } from './vehicle-readings';
import type { VehicleOwnership } from './vehicles';

// ── Подтверждение смен по заказу спецтехники ──
// Техника стоит на объекте неделями, а работа считается по дням: за каждый день заказа — время
// смены, машиночасы, заправка и подпись объекта, что этот день был именно таким. Пока подписи по
// прошедшим дням нет, заявка не уходит из среза «На объекте», а её закрытие предупреждает, что
// закрывают неподтверждённую работу.
//
// Правила живут здесь, а не на сервере, по той же причине, что и правила досрочного завершения
// (ADR 0044): портал обязан не предлагать действий, которые сервер отклонит, — и объяснять
// недоступное теми же словами, которыми откажет API.

/** Максимум машиночасов за день: сутки длиннее суток не бывают. */
export const MAX_MACHINE_HOURS = 24;

/**
 * Заявка глазами правил смен. Структурный тип, а не `Pick` от DTO: модуль стоит в импортах
 * раньше самих заявок (их DTO ссылается на здешнюю сводку), и обратная ссылка замкнула бы круг.
 */
export interface ShiftSubject {
  requestType: VehicleRequestType;
  status: RequestStatus;
  deletedAt: string | null;
  dateFrom?: string;
  dateTo?: string | null;
  shifts?: VehicleRequestShiftsSummaryDto | null;
}

/**
 * Shift summary of a request: approved days, the part of them that locks a plain reassignment, and
 * past days still waiting for a sign-off.
 *
 * Counts, not dates: the summary rides in every list row and serves four rules — the warning at
 * closing, the lock of the rollback to "new" (`approvedDays`), the lock of a plain reassignment
 * (`approvedDaysWithoutRoute`) and the "On site" warning. The dates themselves are needed only in
 * the shift table and in the reassignment preview, and the server gives them there.
 */
export interface VehicleRequestShiftsSummaryDto {
  approvedDays: number;
  /**
   * Approved days inside the term that do NOT sit in their own day route — the sign-offs that stand
   * under the assignment's vehicle and therefore lock a plain reassignment (ADR 0210). A day in a
   * route was worked by the route's vehicle; changing the assignment does not contradict it.
   *
   * Optional on purpose, and absence means "unknown", not zero: a server older than ADR 0210 does
   * not send it, and a newer portal must then lock by `approvedDays` — conservatively — instead of
   * offering a reassignment that server would refuse. An older portal ignores the field and keeps
   * locking by `approvedDays`, which is conservative too; the server decides by the new rule.
   */
  approvedDaysWithoutRoute?: number;
  /** Дни заказа, которые уже наступили, но не подтверждены. Ими и предупреждают о закрытии. */
  unapprovedPastDays: number;
}

/**
 * Where a day's hours and refuelling come from (readings-shifts-merge plan, D1 and §6.3): `site` —
 * the site's own row, always so for a signed day; `driver` — the driver's clean readings of an
 * unsigned day, which replace the site's unsigned numbers (D4).
 */
export const SHIFT_SOURCES = ['site', 'driver'] as const;
export type ShiftSource = (typeof SHIFT_SOURCES)[number];

/**
 * Why the driver's numbers of a day cannot be signed in one click (plan §6.2, D3). The day still
 * shows the sum it has; the site saves the form consciously before signing.
 */
export const DRIVER_DAY_ISSUES = [
  'no_data',
  'first_snapshot',
  'missing_engine_hours',
  'counter_reset',
  'gap',
  'discrepancy',
  'out_of_range',
] as const;
export type DriverDayIssue = (typeof DRIVER_DAY_ISSUES)[number];

export const driverDayIssueLabels: Record<DriverDayIssue, string> = {
  no_data: 'показание без чисел',
  first_snapshot: 'первое показание машины — не с чем сравнить',
  missing_engine_hours: 'моточасы не указаны',
  counter_reset: 'счётчик моточасов сброшен',
  gap: 'предыдущее показание раньше вчерашнего дня',
  discrepancy: 'расхождение с источником не разобрано',
  out_of_range: `сумма за день вне 0–${MAX_MACHINE_HOURS} ч`,
};

/**
 * The driver's numbers of a request day, read from the submitted readings of the day (plan §6.1,
 * §6.2). Everyone who reads the request sees them (D10): the site signs these numbers.
 */
export interface ShiftDriverDayDto {
  /** Sum of the engine-hour deltas the day has; `null` — no reading of the day has hours. */
  machineHours: number | null;
  /**
   * Sum of the refilled liters; an empty refill counts as "not refuelled", as the garage reads it
   * (`readings-aggregate.ts`). `null` — the day has no reading with numbers at all.
   */
  refuelLiters: number | null;
  /** Signable in one click: every reading has hours from a snapshot of this or the previous day. */
  clean: boolean;
  /** The oldest predecessor snapshot when it is older than the previous day: «23 ч с 14.08». */
  since: string | null;
  /**
   * What the person signs or saves (§6.4): the readings with their versions, their predecessors,
   * their sources and the computed numbers — not the report state, so a dispatcher accepting the
   * report between load and click changes nothing. Sent back as `expectedDriverFingerprint`.
   */
  fingerprint: string;
  /**
   * The driver's shift time of the day (plan §8, stage 3): one interval when the readings fold into
   * one, otherwise `null` with `timeIssue`. Optional, like the source: a server before stage 3 sends
   * none, and the portal then keeps the site's time.
   */
  startedAt?: string | null;
  endedAt?: string | null;
  /** Every complete pair of the day — shown when they cannot be merged into one interval. */
  intervals?: ShiftInterval[];
  timeIssue?: DriverDayTimeIssue | null;
}

/** One reading of the day as a principal with `vehicleReadings.read` sees it (D10). */
export interface ShiftDriverReadingDto {
  readingId: string;
  personName: string;
  reportState: DriverReportState;
  sourceKind: ReadingSourceKind;
  /** «ЭСМ-2 № 0012» or «Р-12». */
  sourceLabel: string;
  kind: ReadingKind;
  machineHours: number | null;
  refuelLiters: number | null;
  /** Day of the engine-hour predecessor; `null` — the first snapshot of the vehicle. */
  previousDate: string | null;
  noDataReason: string;
  comment: string;
  discrepancies: { kind: DiscrepancyKind; resolved: boolean }[];
}

/**
 * The diagnostics of a driver day: names, comments, report states and discrepancy kinds. Readings
 * live behind `vehicleReadings.read`, so the server fills this block only for that right; the
 * site, the requester and a lessor see the numbers and the mark without it (D10,
 * docs/access-model.md).
 */
export interface ShiftDriverDiagnosticsDto {
  readings: ShiftDriverReadingDto[];
  issues: DriverDayIssue[];
}

/** Смена одного дня. Пустая (`filledAt === null`) — день заказа, за который ещё ничего не внесли. */
export interface VehicleRequestShiftDto {
  date: string;
  /** Время смены `HH:mm`; пусто — не проставили (машина работала, но часы записали одним числом). */
  startedAt: string | null;
  endedAt: string | null;
  machineHours: number;
  /** Заправка свободным текстом: «120 л», «залили полный», «по талону». */
  refuel: string;
  comment: string;
  filledBy: string | null;
  filledByName: string | null;
  /** When the site's row was written; `null` — the site wrote nothing for this day. */
  filledAt: string | null;
  /** Подпись объекта: кто и когда подтвердил этот день. `null` — день ещё не согласован. */
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  /**
   * The effective source of the hours and refuelling above (§6.3); `null` — nothing. Optional: a
   * server older than the merge does not send it, and `shiftSourceOf` falls back to `filledAt`.
   */
  source?: ShiftSource | null;
  /**
   * The driver's numbers of the day, clean or not; `null` — no submitted reading for this day. On a
   * signed day they stay next to the signed numbers, so a later reading edit shows as a difference.
   */
  driverDay?: ShiftDriverDayDto | null;
  /** Diagnostics, filled only for a principal with `vehicleReadings.read`. */
  driver?: ShiftDriverDiagnosticsDto | null;
}

/** Таблица смен заявки: дни заказа целиком, включая пустые, и день, по которому считался срез. */
export interface VehicleRequestShiftsDto {
  items: VehicleRequestShiftDto[];
  /** День среза (`YYYY-MM-DD`) по Москве: по нему решается, какой день ещё в будущем. */
  onDate: string;
}

/** Последний день работ: пустая дата окончания — однодневный срок (так же читает его весь модуль). */
function lastDayOf(r: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>): string {
  return r.dateTo || r.dateFrom || '';
}

/**
 * Дни заказа — по ним и строится таблица смен. Строк в базе на эти дни может не быть вовсе:
 * смену заводит первое заполнение (иначе заготовку было бы не отличить от «не заполнили»).
 */
export function shiftDaysOf(r: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>): string[] {
  if (!r.dateFrom) return [];
  return dateKeysBetween(r.dateFrom, lastDayOf(r));
}

/**
 * Сколько дней заказа уже наступило на `onDate` (сегодняшний — считается). Ровно столько подписей
 * и должно стоять к этому дню; разницу с подтверждёнными и показывает сводка.
 */
export function pastShiftDaysCount(
  r: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>,
  onDate: string,
): number {
  if (!r.dateFrom || r.dateFrom > onDate) return 0;
  const last = lastDayOf(r);
  return dateKeySpan(r.dateFrom, last < onDate ? last : onDate);
}

/** День принадлежит сроку заявки. */
export function isShiftDayInTerm(
  r: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>,
  day: string,
): boolean {
  return !!r.dateFrom && day >= r.dateFrom && day <= lastDayOf(r);
}

/**
 * Filled shift days that a term edit would drop out of the term: days of the CURRENT term that the
 * new term no longer covers and that have a shift row (ADR 0184, section of 2026-10-12).
 *
 * The rule both term doors refuse by — the wide edit `PATCH /vehicle-requests/:id` and the term
 * command `PATCH /vehicle-requests/:id/period` — through one server helper
 * (`assertTermKeepsFilledShifts`). A row left outside the term is not deleted, but every reader of
 * the module reads days inside the term only (`shiftDaysOf`, the summary, the "On site" filter, the
 * card's shift tab), so its hours and the object's sign-off would silently drop out of the request:
 * the very evidence the table is kept for. Hence a refusal naming the days, never a silent move.
 *
 * Only days of the current term count. A row already outside it (left by an edit made before this
 * rule) is not dropped by this edit, and refusing for it would lock every later term edit with no
 * way out: the shift window cannot reach a day outside the term to delete it.
 *
 * In contracts rather than on the server for the same reason as `shiftRangeAfterActualEnd`: a
 * portal that names these days before the press must count them by the rule the server refuses by.
 */
export function shiftDaysDroppedByTerm(
  before: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>,
  after: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>,
  filledDays: readonly string[],
): string[] {
  return filledDays
    .filter((day) => isShiftDayInTerm(before, day) && !isShiftDayInTerm(after, day))
    .sort();
}

/**
 * Отрезок дней смен; обе границы включительно — в этой форме его одинаково читают и SQL
 * (`BETWEEN`), и перебор уже прочитанных строк.
 *
 * Вырожденной пары («конец раньше начала») не бывает: «снимать нечего» выражается `null`, а не
 * пустым отрезком. Пустой отрезок молча прошёл бы в запрос и удалил ноль строк там, где вызывающий
 * ждал отказа, — а различить «диапазона нет» и «в диапазоне ничего не нашлось» обязаны и окно, и
 * аудит.
 */
export interface ShiftDayRange {
  from: string;
  to: string;
}

/**
 * Смены за фактической датой закрытия: дни строго после факта и по прежний конец срока —
 * `(endedOn, previousDateTo]`. `null` — снимать нечего.
 *
 * Здесь, в контрактах, а не на сервере, по той же причине, что и `earlyEndDateBounds`: окно
 * закрытия обязано перечислить снимаемые дни тем же составом, каким их посчитает сервер. Иначе
 * человек подтверждает отпечаток одного множества, а стирается другое, — и расходятся такие пары
 * молча.
 *
 * **Слева граница открыта**: день, которым закрыли, — рабочий. В него техника ещё стояла на
 * объекте, его часы предъявляются фактом выполнения, и стереть их значило бы вычесть из отчёта
 * работу, за которую выставлен счёт. Закрытие вообще не трогает работу **внутри** факта.
 *
 * **Справа стоит прежний конец срока, а не сегодняшний день.** Считается диапазон до того, как
 * дверь подвинула срок (после — он схлопнулся бы в ничто по построению), а заказ бывает заведён
 * вперёд: дни после сегодняшнего — такие же дни заказа, и заполненные смены по ним встречаются
 * (день заполняют вечером, а закрывают заказ утром следующего).
 *
 * **Пустая `dateTo` — однодневный срок** с концом в `dateFrom` (так её читает весь модуль): у
 * такого заказа фактическая дата совпадает с единственным днём, и диапазон всегда пуст.
 *
 * Факт вне срока дверь не пропускает (`date_from ≤ факт ≤ min(date_to, сегодня)`), но расчёт от
 * её проверки не зависит: начало отрезка не опускается ниже `dateFrom`, потому что смен до начала
 * срока не бывает — обещать их снятие значило бы показать окну дни, которых нет.
 */
export function shiftRangeAfterActualEnd(
  r: Pick<ShiftSubject, 'dateFrom' | 'dateTo'>,
  endedOn: string,
): ShiftDayRange | null {
  const last = lastDayOf(r);
  if (!r.dateFrom || !last || !endedOn) return null;
  if (endedOn >= last) return null;
  const next = shiftDateKey(endedOn, 1);
  return { from: next < r.dateFrom ? r.dateFrom : next, to: last };
}

/**
 * Почему по этой заявке нельзя вести смены — текстом, либо `null`, если можно. Одна функция на
 * портал и API: сервер отвечает этой строкой (422), портал ею же объясняет неактивную строку
 * таблицы.
 *
 * Условие то же, при котором техника считается работающей: заказ спецтехники в работе. У «Новой»
 * на объект ещё никто не выходил, у закрытой день работы уже предъявлен фактом (ADR 0029).
 */
export function shiftsBlocker(r: ShiftSubject): string | null {
  if (r.requestType !== 'special_equipment') {
    return 'Смены ведут по заказу техники на объект: у грузоперевозки срока работ нет';
  }
  if (r.deletedAt) return 'Заявка в архиве';
  if (r.status !== 'confirmed') {
    return `Смены ведут у заявки в статусе «${requestStatusLabels.confirmed}»`;
  }
  return null;
}

/**
 * Почему нельзя вести смену конкретного дня. Сверх общего запрета — две границы дня: он должен
 * принадлежать сроку заявки и не лежать в будущем.
 *
 * Будущий день не подтверждают и не заполняют: смену пишут по факту, а подпись под днём, который
 * ещё не наступил, — это подпись под тем, чего не было. `onDate` считает сервер и отдаёт в ответе:
 * часы клиента бывают сбиты, а браузер восточнее Москвы начинает сутки раньше.
 */
export function shiftDayBlocker(r: ShiftSubject, day: string, onDate: string): string | null {
  const blocker = shiftsBlocker(r);
  if (blocker) return blocker;
  if (!isShiftDayInTerm(r, day)) return 'День вне срока заявки';
  if (day > onDate) return 'День ещё не наступил — смену подтверждают по факту';
  return null;
}

/** Можно ли вести смену этого дня — тот же разбор, что и `shiftDayBlocker`. */
export function canEditShiftDay(r: ShiftSubject, day: string, onDate: string): boolean {
  return shiftDayBlocker(r, day, onDate) === null;
}

/**
 * Чем рискует закрытие заявки прямо сейчас: остались дни, за которые никто не расписался. Работу
 * принимает объект — по дням, а не одним итогом в момент закрытия, — и незакрытый день означает,
 * что о машиночасах этого дня ещё не договорились.
 *
 * Предупреждение, а не запрет (Р9 плана смен пересмотрен): флоу заявки прогоняют целиком — заказ,
 * работа, закрытие, — и отказ закрыть упирал бы каждый прогон в тринадцать подписей, которых на
 * этом этапе никто не ставит. Незамеченным закрытие не проходит: портал показывает этот текст в
 * окне закрытия, а сервер оставляет пометку в истории заявки — сводка смен после закрытия
 * обнуляется, и другого следа не осталось бы. Вернуть запрет — одна проверка в маршруте статуса.
 */
export function shiftsCompletionWarning(r: ShiftSubject): string | null {
  if (r.requestType !== 'special_equipment') return null;
  const pending = r.shifts?.unapprovedPastDays ?? 0;
  if (pending <= 0) return null;
  return `${pendingDaysLabel(pending)} без согласования — заявка закрывается без подписи объекта`;
}

/**
 * Why a request cannot be rolled back to "new": the rollback erases the assignment and the shifts
 * themselves, so ANY approved day inside the term locks it — a day in its own route included, since
 * its hours and the object's sign-off would go with the rest. Without this lock the rollback would
 * also be a one-step way around the lock of a plain reassignment.
 *
 * It is no longer the lock of a plain reassignment: that one counts only the days under the
 * assignment's vehicle (`reassignApprovedShiftsBlocker`, ADR 0210).
 */
export function approvedShiftsBlocker(r: ShiftSubject): string | null {
  if (r.requestType !== 'special_equipment') return null;
  const approved = r.shifts?.approvedDays ?? 0;
  if (approved <= 0) return null;
  return `По заявке согласовано смен: ${approved} — сначала снимите согласование`;
}

/**
 * Whether the request's day routes outlive a reassignment that leaves a vehicle of this ownership
 * on the assignment (ADR 0210).
 *
 * The reassign door runs the day sync after writing the assignment, and the sync sweeps every day
 * off its route once the assigned vehicle is rented (`linearDaysBlocker`: a rented vehicle does not
 * go on routes, its lessor issues the paper). Such a day becomes route-less and falls under the
 * assignment again — so its sign-off counts as the assignment's, both for the lock of a plain
 * reassignment and for what a correction clears. Days frozen by an issued waybill are treated as
 * swept too: for the lock that is the conservative side, and a correction refuses them anyway.
 */
export function dayRoutesKeptWith(ownership: VehicleOwnership): boolean {
  return ownership === 'own';
}

/**
 * How many approved days lock a plain reassignment to a vehicle of `nextOwnership` (ADR 0210):
 * the days without their own route; with a rented vehicle — all of them, see `dayRoutesKeptWith`.
 *
 * `nextOwnership` defaults to `own` for a list row, where the next vehicle is not chosen yet: the
 * button is offered by the optimistic case, and the door re-checks with the real vehicle.
 * A summary without `approvedDaysWithoutRoute` (a server older than ADR 0210) counts every approved
 * day — the old, conservative lock.
 */
export function reassignLockingApprovedDays(
  shifts: VehicleRequestShiftsSummaryDto | null | undefined,
  nextOwnership: VehicleOwnership = 'own',
): number {
  if (!shifts) return 0;
  if (!dayRoutesKeptWith(nextOwnership)) return shifts.approvedDays;
  return shifts.approvedDaysWithoutRoute ?? shifts.approvedDays;
}

/**
 * Why a plain reassignment is refused: approved days stand under the work of the assigned vehicle,
 * and swapping it would turn the object's sign-off into a sign-off under someone else's hours.
 * Unlike `approvedShiftsBlocker`, a day that sat in its own day route does not count — its vehicle
 * is the route's (ADR 0210). The rollback to "new" keeps the older, wider lock on purpose: it erases
 * the shifts themselves, route or not.
 */
export function reassignApprovedShiftsBlocker(
  r: ShiftSubject,
  nextOwnership: VehicleOwnership = 'own',
): string | null {
  if (r.requestType !== 'special_equipment') return null;
  const locking = reassignLockingApprovedDays(r.shifts, nextOwnership);
  if (locking <= 0) return null;
  return `По заявке согласовано смен: ${locking} — сначала снимите согласование`;
}

/** «3 смены», «11 смен» — количество с русским склонением. */
function pendingDaysLabel(days: number): string {
  const tail = days % 100;
  const last = days % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'смен'
      : last === 1
        ? 'смена'
        : last >= 2 && last <= 4
          ? 'смены'
          : 'смен';
  return `${days} ${form}`;
}

/**
 * Продолжительность смены в часах по её времени; `null` — время не проставлено. Смена через
 * полночь («20:00 – 08:00») считается перешедшей в следующие сутки: день здесь — заказанный день
 * заявки, а не астрономические сутки.
 *
 * Машиночасы этим числом не подменяются — техника внутри смены простаивает, — но расхождение
 * видно человеку, и форма показывает его подсказкой.
 */
export function shiftSpanHours(startedAt: string | null, endedAt: string | null): number | null {
  const minutes = shiftSpanMinutes(startedAt, endedAt);
  return minutes === null ? null : Math.round((minutes / 60) * 100) / 100;
}

/**
 * The same span in whole minutes, and the only interpreter of a start/end pair in the portal: the
 * site's shift window reads it in hours, a driver's ESM-2 reading in minutes (ADR 0234). Equal
 * clock times give 24 h; the driver's input refuses an equal pair instead of re-reading it here,
 * because changing this rule would also change the site's hint.
 */
export function shiftSpanMinutes(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const from = TIME_PATTERN.exec(startedAt);
  const to = TIME_PATTERN.exec(endedAt);
  if (!from || !to) return null;
  const start = Number(from[1]) * 60 + Number(from[2]);
  const end = Number(to[1]) * 60 + Number(to[2]);
  return end > start ? end - start : end + 24 * 60 - start;
}

/**
 * The effective source of a day: the server's answer, or — from a server older than the merge,
 * which never sends `source` — the old meaning "the site wrote a row". One place, so the approve
 * checkbox, the "not filled" tag and the window's form never read `filledAt` on their own.
 */
export function shiftSourceOf(
  shift: Pick<VehicleRequestShiftDto, 'source' | 'filledAt'>,
): ShiftSource | null {
  if (shift.source !== undefined) return shift.source;
  return shift.filledAt ? 'site' : null;
}

/** The driver's single interval of a day; `null` — none, ambiguous, or an older server. */
export function driverDayInterval(
  day: Pick<ShiftDriverDayDto, 'startedAt' | 'endedAt'> | null | undefined,
): ShiftInterval | null {
  if (!day?.startedAt || !day.endedAt) return null;
  return { startedAt: day.startedAt, endedAt: day.endedAt };
}

/**
 * The day's shift time is the driver's (plan §8): the effective day is the driver's — unsigned and
 * clean — and its readings fold into one interval. Then the time is locked like the hours and is
 * corrected in the garage; anywhere else the site types it. The server overlays the time by the
 * same two conditions, so the window never offers an input whose value the door would ignore.
 */
export function isShiftTimeFromDriver(
  shift: Pick<VehicleRequestShiftDto, 'source' | 'filledAt' | 'driverDay'>,
): boolean {
  return shiftSourceOf(shift) === 'driver' && driverDayInterval(shift.driverDay) !== null;
}

/** A day has numbers to sign: the site's row or the driver's clean readings. */
export function isShiftFilled(shift: Pick<VehicleRequestShiftDto, 'source' | 'filledAt'>): boolean {
  return shiftSourceOf(shift) !== null;
}

/**
 * The one way a driver's liters become the refuel text of a day (§6.3): «120 л» for a positive
 * sum and an empty text for nothing refilled — the same "not refuelled" the site writes as an
 * empty field.
 */
export function refuelLabel(liters: number | null | undefined): string {
  if (liters == null || !(liters > 0)) return '';
  return `${liters.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} л`;
}

/** Итог подтверждённых машиночасов — им подставляется факт выполнения при закрытии (ADR 0029). */
export function approvedMachineHours(shifts: VehicleRequestShiftDto[]): number {
  const total = shifts.reduce((sum, s) => (s.approvedAt ? sum + s.machineHours : sum), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Наступившие дни заказа без подписи объекта — их перечисляет предупреждение при закрытии. Считается
 * по самой таблице смен, а не по сводке: сводка отвечает числом, а закрывающему нужно знать, какие
 * именно дни он закрывает неподтверждёнными. Будущие дни сюда не попадают — их и не подписывают.
 */
export function unapprovedPastShiftDays(
  shifts: VehicleRequestShiftDto[],
  onDate: string,
): string[] {
  return shifts.filter((s) => s.date <= onDate && !s.approvedAt).map((s) => s.date);
}

// ── Схемы ──

/** Время смены — тот же канонический `HH:mm`, что и во всех заявках. */
export const shiftTimeSchema = z.string().trim().regex(TIME_PATTERN, TIME_FORMAT_MESSAGE);

/** Машиночасы: до суток, с точностью до сотой. Ноль — законное значение (простой, Р7). */
export const machineHoursSchema = z
  .number()
  .min(0, 'Машиночасы не бывают отрицательными')
  .max(MAX_MACHINE_HOURS, `Машиночасов за день не больше ${MAX_MACHINE_HOURS}`)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Не более 2 знаков после запятой');

export const SHIFT_IDLE_COMMENT_MESSAGE = 'Опишите, почему техника не работала';

/**
 * The driver numbers a person saw, echoed back (`ShiftDriverDayDto.fingerprint`). Sent only on a
 * `driver` day: a server older than the merge rejects an unknown key of these strict bodies with
 * 400, and it never reports `source`, so a portal falling back to `site` never sends it.
 */
export const driverFingerprintSchema = z.string().trim().min(1).max(200);

/**
 * The shift of one day. The date is not in the body: the day is part of the address
 * (`/shifts/:date`), and a second answer to "which day is this" would drift from the first.
 *
 * Zero machine-hours need a comment: idle time, rain, no work front — that is part of the record,
 * not a gap in it, and such a day is discussed with the lessor separately. The database `CHECK`
 * holds the same pair.
 *
 * On a clean driver day the door writes the server-computed hours and refuelling and takes only the
 * time and the comment from the body (plan §6.5); `expectedDriverFingerprint` proves the person saw
 * those numbers.
 */
export const saveVehicleRequestShiftSchema = z
  .object({
    startedAt: shiftTimeSchema.nullable().optional(),
    endedAt: shiftTimeSchema.nullable().optional(),
    machineHours: machineHoursSchema,
    refuel: z.string().trim().max(200).optional().default(''),
    comment: z.string().trim().max(2000).optional().default(''),
    expectedDriverFingerprint: driverFingerprintSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Half a shift describes nothing: «from 08:00» without an end is not a working time.
    if ((v.startedAt == null) !== (v.endedAt == null)) {
      ctx.addIssue({
        code: 'custom',
        path: [v.startedAt == null ? 'startedAt' : 'endedAt'],
        message: 'Укажите начало и конец смены',
      });
    }
    // On a driver day the hours are the server's, so the body's zero proves nothing: the door
    // applies the same rule to the server's hours, as the sign-off does.
    if (v.machineHours === 0 && !v.comment && !v.expectedDriverFingerprint) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: SHIFT_IDLE_COMMENT_MESSAGE });
    }
  });
export type SaveVehicleRequestShiftInput = z.infer<typeof saveVehicleRequestShiftSchema>;
export type SaveVehicleRequestShiftBody = z.input<typeof saveVehicleRequestShiftSchema>;

/**
 * The sign-off of a day and its revocation — one body, like the request approval (ADR 0025 item 6):
 * one right, one scope and one invariant; separate routes would drift in their checks.
 *
 * Signing a `driver` day writes its row from the server-computed numbers in the same transaction
 * (plan D1); `expectedDriverFingerprint` names the numbers the person saw, and a stale one is a 409.
 */
export const approveVehicleRequestShiftSchema = z
  .object({ approved: z.boolean(), expectedDriverFingerprint: driverFingerprintSchema.optional() })
  .strict();
export type ApproveVehicleRequestShiftInput = z.infer<typeof approveVehicleRequestShiftSchema>;
