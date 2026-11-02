# ADR 0242. Sunday is a rest day: a shift laid by the calendar alone is not asked for (hotfix)

- Статус: Реализовано (02.11.2026); not deployed. A hotfix: the full decision on what makes a
  weekend a working day is open (see «Open»)
- Домены: кабинет-водителя, гараж
- Изменяет: plan [vehicle-readings-stats-plan.md](../vehicle-readings-stats-plan.md) — Р34 (an
  ESM-2 is an expected shift on EVERY calendar day of its validity): its Sunday is now expected only
  when a reading came; [ADR 0207](0207-vehicle-request-day-batch.md) — decision 3 (one expected
  shift per day of site work) stays, but a site-day 4-П on a Sunday is no longer one by itself
- Связано: [ADR 0237](0237-driver-readings-whole-at-shift-end.md) (whole shifts; an empty day is
  not accepted, so a Sunday debt could not be cleared), [ADR 0103](0103-vehicle-readings.md) (the
  ledger accepts what is sent), [ADR 0241](0241-readings-report-in-garage-header.md) (the readings
  report keeps its weekend rows and colours them)
- Область: [rest-day rule](../../apps/api/src/services/readings-expected.ts),
  [not-submitted filter and day state](../../apps/api/src/services/readings-stats.ts),
  [maintenance tail](../../apps/api/src/services/readings-aggregate.ts),
  [driver schedule](../../apps/api/src/services/garage-driver-schedule.ts),
  [cabinet task](../../apps/api/src/services/driver-assignment.ts),
  [task entry field](../../packages/contracts/src/driver-cabinet.ts),
  [day line](../../apps/web/src/pages/driver/dayState.ts),
  [debt line](../../apps/web/src/pages/driver/DriverLayout.tsx)

## Context

After the cabinet modernisation (ADR 0237) the owner reported on 02.11.2026 that the submission
ignores days off: Sunday is a rest day, and no readings may be required for it unless there is an
explicit indication otherwise.

The cause is older than the modernisation. A weekly ESM-2 is laid out as an expected shift over
every calendar day it is in force (Р34), and an ESM-2 week ends on Sunday by construction. The day
batch of ADR 0207 issues a 4-П for every day of the term, Sundays included. So on Monday:

- the cabinet's debt line said «Не переданы показания за …» about the Sunday, and the driver could
  not clear it: an empty day is not accepted, only «нет возможности снять показания» with a reason;
- following the link opened the Sunday, and opening a day creates its rows: a weekly sheet's day
  «opened without numbers» breaks the counter pair of the Monday after it (Р13б), so the fuel norm
  check and the one-click sign-off of Monday failed;
- the garage intake showed the Sunday «ждём показание», then red «нет показания N дней», and the
  data quality counted it as missing.

The owner's survey of the same day: the explicit indication is a paper for that day with a real
task under it; the issue of site-work 4-П on weekends needs its own working-out; right now a quick
hotfix, the full solution after it. Scope: the cabinet and the garage. Release: isolated.

## Decision

1. **A rest-day shift.** A Sunday shift of a weekly ESM-2, or of a route with no trip of its own
   (every served row of its composition is a day of site work, `work_date` set). A trip — a freight
   row, a delivery, a pickup — is a task for that very day and stays asked for: that is the "paper
   with a real task" of the survey, read narrowly for the hotfix.
2. **Not asked for, still accepted.** A rest-day shift without a reading is not an expected shift.
   A reading in any non-voided report, `no_data` included, ends the exemption: the shift is then
   counted and checked as any other. The cabinet keeps the block; a driver who worked sends it as
   usual. Nothing leaves the ledger — only the demand goes.
3. **One rule, one place.** `restDayShiftSql` and `restDayExemptSql` in `readings-expected.ts`,
   next to the expected-shift fragments, asked by every reader of expected shifts: the relation
   (intake, fleet months and their quality, counter continuity — and through it the request day
   sign-off and the readings report's pairs), the "not submitted" filter, the missing-source check,
   the garage day state, the driver schedule and the maintenance tail. The relation drops the shift
   after the full join, so both a Sunday nobody opened and a Sunday opened empty go. The TypeScript
   twin `isRestDayShift` sits beside them for the cabinet task.
4. **The cabinet asks the server.** The task entry gets `readingOptional` (additive, absence means
   "asked for"). A day whose entries are all optional is no debt, and its day line says «Выходной ·
   Показания нужны, только если техника работала» instead of «Передать показания». The portal holds
   no weekday rule of its own.
5. **The readings report is not a demand.** Its rows are request days and keep their Sundays
   (ADR 0241 colours them); only its counter-pair continuity follows the relation.
6. **No migration of the schema, no client floor.** The field is optional, an old tab ignores it and
   keeps the old debt line until reloaded.

## Consequences

- (+) On Monday a driver sees no Sunday debt for a day the calendar laid; the garage stops painting
  that Sunday; Monday's counter pair is continuous.
- (+) A Sunday worked and submitted is counted exactly as before.
- (−) A Sunday that really was worked and not submitted is no longer flagged: the garage learns of it
  only from the Monday reading (its counter difference covers both days). The fuel norm of such a
  pair is then judged over two days of work against one shift.
- (−) The weekly sheet's expected shifts drop from seven to six a week without a Sunday reading; the
  data quality of past months improves retroactively, since it is computed, not stored.
- (−) Only Sunday. Saturday stays a working day; public holidays are not covered.

## Open

The full solution, as a separate task: what makes a weekend of site work real (a mark on the request
or a planned day, not the calendar), whether the day batch should skip or ask about weekends, and a
holiday calendar. Until then a site-day 4-П on Sunday is treated as calendar, not as a task.

## Verification

API db suite `readings-stats.db.test.ts`, «воскресенье — выходной (ADR 0242)»: a weekly sheet's
Sunday is neither pending nor counted until submitted, opened empty it stays so, submitted it counts;
the maintenance tail ends on Saturday, then on the submitted Sunday; a site-day Sunday route is
optional, a freight row and a relocation are not; a Sunday opened empty does not break the
Saturday–Monday pair and gives no garage day state. The tests of the sheet's days were rewritten
(Sunday not pending) and a scenario on a floating date was pinned to a working day. The whole db
circle of readings was run as if today were each day of the week (clock shift in the test
process). Portal: the debt line skips an all-optional day and keeps a day with an asked-for trip; the
day line says «Выходной» and the form stays open.
