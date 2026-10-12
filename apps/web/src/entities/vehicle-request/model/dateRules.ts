import dayjs, { type Dayjs } from 'dayjs';
import {
  type AccessSubject,
  minRequestDateKey,
  minVehicleRequestDateKey,
  moscowDateKeyOf,
  type Permission,
  VEHICLE_REQUEST_LEAD_TIME_MESSAGE,
} from '@technic/contracts';

/**
 * The calendar of the vehicle request form: the earliest available day, a lock on everything
 * nearer, and a hint on why it is so (ADR 0104).
 *
 * The contract computes the boundary (`minVehicleRequestDateKey`), one function for the portal and
 * the server: a requester gets tomorrow, after the 15:00 cut-off the day after tomorrow, and the
 * one who leads the orders gets today by Moscow time. This module only turns it into what
 * `DatePicker` understands.
 *
 * Editing an existing request is locked by the same rule, not by the former «just not in the past»:
 * the server asks it on every edit that moves the calendar, and the portal must not offer a date it
 * will refuse. An already saved value is shown as is — a locked calendar does not touch an edit of
 * the phone or the comment.
 *
 * Every permission here is asked of `can`, the portal's membership in the list the server computed
 * (ADR 0223), never of the contracts matrix over `subject`. Inside a deploy window the bundle is
 * newer than the running API, and a matrix that already knows a permission the server does not
 * grant yet would open days the handler refuses. `subject` stays for what is not a permission.
 */
export function vehicleRequestDateRules(
  subject: AccessSubject | null | undefined,
  can: (permission: Permission) => boolean,
): {
  minDate: Dayjs;
  disabledDate: (d: Dayjs) => boolean;
  leadTimeHint?: string;
} {
  const minKey = minVehicleRequestDateKey(subject, undefined, can);
  const today = moscowDateKeyOf(new Date());
  /*
   * The past lives by its own rule (ADR 0101, R37), in three modes: without the correction
   * permission there is none (the boundary is today), `waybills.correct` opens thirty days, and
   * with `waybills.correctBeyondLimit` there is no boundary and `minRequestDateKey` returns `null`.
   *
   * The two rules do not compete because they split the calendar at today instead of fighting over
   * one boundary: lead time locks the **near future** days, backdating opens the **past** ones. The
   * server asks them in the same order — on a past date lead time is not asked at all (`backdated ?
   * null : vehicleRequestLeadTimeBlocker`), and the predicate below repeats that literally;
   * otherwise the calendar would lock yesterday for someone the handler lets in.
   */
  const backdateFloor = minRequestDateKey(undefined, {
    correct: can('waybills.correct'),
    beyondLimit: can('waybills.correctBeyondLimit'),
  });
  return {
    minDate: dayjs(minKey).startOf('day'),
    disabledDate: (d) => {
      const key = d.format('YYYY-MM-DD');
      if (key < today) return backdateFloor !== null && key < backdateFloor;
      return key < minKey;
    },
    // The hint appears exactly where the near days are locked: the one who leads the orders has
    // today open and needs no explanation, while a requester would otherwise learn the reason only
    // from a refusal.
    leadTimeHint:
      minKey > moscowDateKeyOf(new Date()) ? VEHICLE_REQUEST_LEAD_TIME_MESSAGE : undefined,
  };
}
