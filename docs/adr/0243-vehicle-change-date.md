# ADR 0243. A vehicle change names the day it starts; signed days lock it only from that day on

- Статус: Реализовано (02.11.2026); not deployed
- Домены: заказ-тс
- Изменяет: [ADR 0210](0210-assignment-correction-shift-approvals-by-day.md) — the lock of a plain
  reassignment: a sign-off locked the change from anywhere in the term, now only from the change
  date to the end of the term; [ADR 0048](0048-vehicle-reassignment.md) — the change was "from
  today" with no way to say otherwise
- Развивает: [ADR 0212](0212-assignment-old-doors-write-history.md), decision 3 — the door already
  cuts the history row and the paper on its own date; the date only used to be fixed to today
- Связано: [ADR 0101](0101-backdated-correction.md) (past days: the right, the depth, the reason;
  the correction block stays the only way to rewrite worked weeks)
- Область: [body and date range](../../packages/contracts/src/vehicle-requests.ts),
  [planner](../../apps/api/src/services/assignment-reassign.ts),
  [lock](../../apps/api/src/services/shift-approval-scope.ts),
  [day routes](../../apps/api/src/services/vehicle-request-days.ts),
  [door](../../apps/api/src/routes/vehicle-requests.ts),
  [window](../../apps/web/src/widgets/vehicle-assignment-dialog),
  [command](../../apps/web/src/features/vehicle-assignment/model/command.ts)

## Context

The «Смена техники» window of a running on-site request asked for the vehicle, the rates and the
machinist, and nothing about when the change starts. The door took today (or the first day of a term
that has not begun), and the dispatcher read the window as "the vehicle for the whole period". On
02.11.2026 the owner asked for the date to be named explicitly in the window, and a survey the same
day fixed the scope: any day of the term, past included; the signatures of the object stand under
the work of the vehicle that went out, so they lock the change only from its start — the previous
vehicle answers for its own days.

Two things stood in the way. The body had no date. And the lock was term-wide: one signed day
anywhere hid the button on the list row and refused the door (ADR 0210), which made a request with a
signed Monday unchangeable until the object took the signature back, however late the change was
meant to start.

## Decision

1. **The body of `PATCH /vehicle-requests/:id/assignment` and of its preview gets an optional
   `effectiveDate`.** Absent — as before: today, or the first day of a term not begun. The range is
   `reassignEffectiveDateRange` of the contracts, one function for the picker and the refusal: from
   the first day of the term to its last (a request kept in work past its term keeps today legal).
   Outside it — 422. The date the door would take anyway is treated as no date: the fingerprint and
   the paper do not depend on whether the client sent it.
2. **The door cuts on that day.** The history row of the new vehicle lies on the date, the days
   before it stay with the previous vehicle, the paper follows the segment plan (ADR 0212,
   decision 3). Rows of later vehicle changes are cancelled with their groups, as for today's
   change: the new vehicle holds to the end of the term. The date works only in the `history` read
   mode and only for an on-site order: in `legacy` the assignment is one for the whole term and the
   door refuses instead of silently putting the vehicle on the whole term; freight has no term.
3. **A date before today is a past-days operation and is asked as one** (R32, ADR 0101): the
   `waybills.correct` right, no deeper than thirty days without `waybills.correctBeyondLimit`, and a
   reason in `backdateReason`, which goes to the request feed and to the reason of the re-issued
   sheets. Without it any role that may change the vehicle could rewrite past days with no trace.
   The verdict comes from the guard the correction block already uses, by the date itself.
4. **Worked weeks stay with the correction.** A plain change that would burn a sheet of an ended
   week, or issue one for an ended week without paper, is refused with the way out named: the
   correction block, whose date still comes from the sheets it reissues. The two do not combine in
   one body.
5. **The lock of signed days is asked from the change date.** `approvalsLockingReassignment` takes
   `fromDate`; the preview names the days from it as `blockedShiftDays`, the door refuses by them
   under its locks, and the message names the last signed day. The pre-transaction check by the
   shift summary is gone — it had counts without dates and could only be term-wide. The list row's
   `canReassignVehicle` no longer reads sign-offs for the same reason; the `reassign*Lock*` helpers
   of the contracts are removed. The summary field `approvedDaysWithoutRoute` stays — other readers
   count by it. In `legacy`, which changes the whole assignment, the lock still starts at the
   beginning of the term: earlier signatures cannot be preserved by a mode that has no dated cut.
   For a plain change in `history`, day-route reconciliation also starts at the change date, so
   switching to rental keeps earlier route days and their signatures with the previous vehicle.
6. **The window.** A «Новая техника работает с» field opens on the day the door takes anyway and is
   bound by the range; a role without `waybills.correct` cannot pick a past day, and one without
   `waybills.correctBeyondLimit` nothing older than thirty days. A past day brings a warning and a
   mandatory reason at its own field. The field goes away under the correction checkbox. The date
   goes into the preview and the command only when it differs from the default.

## Consequences

- A request with signed days earlier in the term can now change its vehicle from today: the
  signatures stay under the previous vehicle in `history`. Before, it needed the correction, which
  clears them. `legacy` retains its whole-term signature lock.
- A change dated before today is a recorded past-days operation: it appears in the feed with the
  date and the reason, and its current-week sheets are re-issued with that reason.
- The change date is ignored by no mode: `legacy` refuses it, so a rollback of the read mode never
  turns a dated change into a whole-term one unnoticed.
- The date of a correction is still derived from the sheets it names. Naming it explicitly there
  is a separate decision: it moves the depth the guard asks, the set of sign-offs the correction
  clears and the weeks it unlocks (ADR 0101).
- A future date records the new vehicle on the request at once (the denormalised assignment holds
  the last vehicle of the history, ADR 0212), so the list card shows it from today although the
  days before the date still belong to the previous one; the history readers are exact by date.
- Hours entered, not signed, on days from the change date stay and now count as the new vehicle's;
  deleting them is still not done by this door (the «workBlockRange» note of ADR 0210).
