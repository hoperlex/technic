import { z } from 'zod';
import { DRIVER_SUBMIT_PAST_DAYS } from './driver-cabinet';
import type { RequestStatus, VehicleRequestType } from './enums';
import { can, type AccessSubject, type Permission } from './permissions';
import { shiftDateKey, weekStartKey } from './time';

/**
 * «Рабочая смена» on a Sunday of a special-equipment request (ADR 0246, plan
 * docs/rest-days-plan.md D2): Sunday is a rest day by default (ADR 0242), and the mark makes one
 * Sunday of THIS request an ordinary working day — its weekly ESM-2 and its site-day 4-П are asked
 * for, the driver's cabinet calls it a debt. The server applies the mark in the expected-shift rule
 * (`restDayShiftSql`); the portal only shows the switch this module allows.
 */

/** The body of the switch: set or remove the mark of the date in the path. */
export const workingDaySetSchema = z.object({ working: z.boolean() }).strict();
export type WorkingDaySetInput = z.infer<typeof workingDaySetSchema>;

/** One Sunday of the request's term as the card shows it. */
export interface WorkingSundayDto {
  date: string;
  working: boolean;
  /** Why the switch is off; `null` — the date may be changed by a principal with the right. */
  blocker: string | null;
}

export interface VehicleRequestWorkingDaysDto {
  /** Every Sunday of the effective term, in order; empty for a term without a Sunday. */
  sundays: WorkingSundayDto[];
  /** Moscow today, from the server: the window of the switch is counted from it. */
  today: string;
}

/**
 * The request states a mark belongs to: in work. A «Новая» request has no work to mark yet — its
 * return there clears the marks with the rest of the work — and a closed one has its days signed.
 */
export const WORKING_DAY_STATUSES: readonly RequestStatus[] = ['confirmed'];

/** Whether a calendar key is a Sunday: the last day of its Monday-started week. */
export function isSundayKey(dateKey: string): boolean {
  return shiftDateKey(weekStartKey(dateKey), 6) === dateKey;
}

/**
 * Why a Sunday cannot be marked or unmarked now; `null` when it can. One rule for the server door
 * and the card switch:
 *
 * - a special-equipment request in work — freight has no site days, so no calendar Sunday;
 * - only a Sunday is a rest day (D1);
 * - within the request's effective term;
 * - backwards as far as the driver may still submit (`DRIVER_SUBMIT_PAST_DAYS`, D2): a mark on an
 *   older Sunday would demand a reading nobody can send any more; forward — to the end of the term.
 */
export function workingSundayBlocker(input: {
  date: string;
  today: string;
  term: { dateFrom: string; dateTo: string };
  status: RequestStatus;
  requestType: VehicleRequestType;
}): string | null {
  if (input.requestType !== 'special_equipment') {
    return 'Рабочая смена отмечается у заявки на спецтехнику';
  }
  if (!WORKING_DAY_STATUSES.includes(input.status)) {
    return 'Рабочую смену отмечают у заявки в работе';
  }
  if (!isSundayKey(input.date)) return 'Рабочей сменой отмечается только воскресенье';
  if (input.date < input.term.dateFrom || input.date > input.term.dateTo) {
    return 'Это воскресенье вне срока заявки';
  }
  if (input.date < shiftDateKey(input.today, -DRIVER_SUBMIT_PAST_DAYS)) {
    return `Прошедшее воскресенье отмечают не позже чем через ${DRIVER_SUBMIT_PAST_DAYS} дней`;
  }
  return null;
}

/** The Sundays of a term, in order. */
export function termSundays(term: { dateFrom: string; dateTo: string }): string[] {
  const days: string[] = [];
  let day = shiftDateKey(weekStartKey(term.dateFrom), 6);
  for (; day <= term.dateTo; day = shiftDateKey(day, 7)) {
    if (day >= term.dateFrom) days.push(day);
  }
  return days;
}

/**
 * Whether the subject may set or remove working marks at all: whoever assigns vehicles
 * (`vehicleRequests.status`, D2). The request's visibility and scope are the server's part — a
 * query, not a predicate. `has` answers the permission: the server leaves the default, the portal
 * passes its `can` over the list the server computed (ADR 0223).
 */
export function canSetWorkingSunday(
  subject: AccessSubject | null | undefined,
  has: (permission: Permission) => boolean = (permission) => can(subject, permission),
): boolean {
  return has('vehicleRequests.status');
}
