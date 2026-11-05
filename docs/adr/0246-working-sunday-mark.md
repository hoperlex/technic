# ADR 0246. A working Sunday is marked on the request; the day batch and the rental cut follow Sunday

- Статус: Реализовано (05.11.2026), release 0.1.138.0246
- Домены: заказ-тс, кабинет-водителя, гараж
- Изменяет: [ADR 0242](0242-sunday-rest-day-readings.md) — decision 1 (what makes a Sunday shift
  asked for: now also a working mark, and for an ESM-2 the trip or mark of a route it suppresses)
  and decision 3 (the cabinet's TypeScript twin of the rule is gone: it asks the database);
  [ADR 0207](0207-vehicle-request-day-batch.md) — decision 3 (the batch issues every day of the
  term: now it skips Sundays unless asked); [ADR 0238](0238-rental-month-cut.md) — the first
  weekday of the next month (now: the first day that is not a Sunday)
- Развивает: [ADR 0244](0244-idle-shift-reading.md) (the intake's contradictions of «Не работал»
  gain the working mark)
- Связано: plan [rest-days-plan.md](../rest-days-plan.md) (D1, D2, D6, D8, §3, §5.1)
- Область: [mark table](../../apps/api/drizzle/0415_vehicle_request_working_days.sql),
  [rest-day rule](../../apps/api/src/services/readings-expected.ts),
  [card door](../../apps/api/src/routes/vehicle-request-working-days.ts),
  [mark lifecycle](../../apps/api/src/services/vehicle-request-working-days.ts),
  [contracts](../../packages/contracts/src/vehicle-request-working-days.ts),
  [card tab](../../apps/web/src/features/vehicle-request-working-days/ui/WorkingSundaysView.tsx),
  [day batch](../../apps/api/src/services/vehicle-request-day-batch.ts),
  [batch fields](../../apps/web/src/widgets/vehicle-assignment-dialog/ui/DayBatchFields.tsx),
  [rental cut](../../packages/contracts/src/weekly-vehicle-requests.ts)

## Context

The owner decided on 03.11.2026 (plan `docs/rest-days-plan.md`): Sunday is the only rest day by
default (D1); the dispatcher marks a working Sunday on the request card (D2); the day batch skips
Sundays unless asked, and then marks them (D6); the rental month cut follows Sunday only (D8).
Before this decision the only way a Sunday became asked for was a reading the driver happened to
send (ADR 0242), and nothing told the driver in advance that the Sunday was a working day.

## Decision

1. **A mark on the request and the date** (`vehicle_request_working_days`, primary key
   `(request_id, work_date)`, Sunday check). It belongs to the request, not to a vehicle, driver,
   route or paper: a reassignment or a reissue keeps it, and the current sources resolve it. No row
   means a rest day, so an empty table is exactly the hotfix.
2. **One rule of demand** (`restDayShiftSql`). A Sunday shift is asked for when the route carries a
   trip, when a served request of that day has a mark (any member of a shared route), and for a
   weekly ESM-2 when its own request has a mark or a route it suppresses (ADR 0207, one shift for two
   papers) carries a trip or a mark — route A+B under the sheet of A with only B marked makes the
   sheet's Sunday a working one, and no second expectation appears. A cancelled or archived request
   gives no demand. The cabinet asks the same SQL (`loadRestDayShifts`) instead of a copy of the
   rule; the portal holds no weekday rule.
3. **The card door.** The tab «Воскресенья» of a special-equipment request lists the term's Sundays
   with a «Рабочая смена» switch. Whoever assigns vehicles (`vehicleRequests.status`) sets and
   removes it, within the request's visibility and scope, while the request is in work, inside the
   effective term and not older than the driver's window (`DRIVER_SUBMIT_PAST_DAYS`); the status and
   the term are read under the request lock. A repeat is a no-op; a change is request history
   («Воскресенье отмечено рабочей сменой» / «Снята отметка рабочей смены»).
4. **The lifecycle.** Every term writer goes through `afterWorkPeriodChanged`, which drops the marks
   outside the new term and records it in the same transaction (`writeAuditTx`), so a later
   extension cannot bring an old decision back. The return to «Новая» and a change to freight clear
   the marks with the rest of the work; a physical deletion cascades.
5. **The garage.** «Не работал» on a marked Sunday is yellow: «на этот день стояла рабочая смена»
   (the fourth contradiction of ADR 0244; dormant until its release 1B opens the kind).
6. **The day batch.** `includeSundays` is optional without a default, and the portal sends it only
   when the checkbox «Включая воскресенья» is on: the operation fingerprint of a pre-release retry
   keeps its value. Without it Sundays leave the batch before the portion is measured — they take
   no room in the fifty and are no remainder — and the report names them «Воскресенье — не выписан:
   выходной». With it a Sunday goes like any day and a successful one gets the mark in the same
   transaction as its route and paper; one older than the driver's window is skipped by its own
   text, before any backdate check. The checkbox stands in the shared block of both dialogs.
7. **The rental cut.** A continuation order starts on the first day of the next month that is not a
   Sunday: a month that begins on Saturday starts the order there.

## Consequences

- (+) A Sunday the site works is known in advance: the driver's cabinet asks for it, the garage
  waits for it, and the mark is visible in the request history.
- (+) The batch issues no paper for Sundays nobody asked for, and long terms are walked to the end.
- (−) The mark is per request: a vehicle shared by two requests on a Sunday is asked for if either
  is marked, which is the plan's choice (any member's mark).
- (−) The card shows marks for the term only; a Sunday outside it cannot be marked until the term
  covers it.

## Verification

API db: `readings-idle.db.test.ts` — an unmarked sheet Sunday is neither pending nor asked of the
driver, a mark of its request makes it both; the sheet of A hiding route A+B becomes a working day
by B's mark, and by a freight row even without a mark, with one cabinet block; a cancelled marked
request gives no demand; «Не работал» on a marked Sunday is yellow; the database refuses a mark on
a weekday. `linear-request-days.db.test.ts` — the door sets and removes, a repeat writes no
history, a weekday and a Sunday outside the term are refused, the return to «Новая» clears the
marks, a shortened term drops its mark with a history entry. `vehicle-request-day-batch.db.test.ts`
— without the checkbox a Sunday is skipped with its text and no route; with it the Sunday is issued
and marked; skipped Sundays take no room in a portion over a ten-week term; an included Sunday older
than the window is skipped. `weekly-rental-month-split.test.ts` — a month from Saturday starts
there, one from Sunday on Monday.
