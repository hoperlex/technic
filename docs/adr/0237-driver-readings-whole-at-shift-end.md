# ADR 0237. The driver cabinet sends whole shifts at the end of the shift and asks about discrepancies once

- Статус: Принято (28.10.2026); contracts, the previous-shift snapshot on the server and the cabinet
  implemented. The owner's request of 28.10.2026 and the survey of the same day (the counters stay a
  snapshot of the end of the shift, an untouched block is skipped, an empty «Заправлено» means "not
  refuelled", the previous fuel end is shown under the fuel start)
- Домены: кабинет-водителя, гараж
- Изменяет: [ADR 0163](0163-vehicle-readings-fuel-levels.md) — decisions 2 and 4: the fuel levels
  are no longer optional for a block the driver sends, and the cabinet no longer sends a morning-only
  part to be completed in the evening; decision 5 (an untouched block does not hold the day) stays
- Изменяет: [ADR 0234](0234-driver-shift-and-stop-times.md) — decision 8: the «сейчас» button of
  owner decision D9 is removed from every time field; the driver's time rule (D11) judges the
  cabinet's block as a finished shift, whatever the numbers say
- Связано: [ADR 0103](0103-vehicle-readings.md) (the server keeps accepting a part-filled reading,
  and the anomalies it records are unchanged), [ADR 0129](0129-driver-cabinet-readings-first.md)
  (the draft format `v3` is unchanged: the saved «confirmed» flag of a block is simply never read),
  [ADR 0194](0194-fuel-norms.md) (consumption is the server's, computed once),
  plans [driver-fuel-readings-plan.md](../driver-fuel-readings-plan.md) (Р9 and Р10, the ban on
  comparing a fuel start with the previous end, are superseded here) and
  [driver-cabinet-ux-plan.md](../driver-cabinet-ux-plan.md) (Р6, the «Всё верно» checkbox, is
  superseded here)
- Область: [completeness predicate](../../packages/contracts/src/vehicle-readings.ts),
  [time rule](../../packages/contracts/src/reading-times.ts),
  [previous-shift snapshot](../../packages/contracts/src/driver-cabinet.ts),
  [snapshot builder](../../apps/api/src/services/driver-assignment.ts),
  [input rules](../../apps/web/src/entities/vehicle-reading/model/readingLimits.ts),
  [block checks](../../apps/web/src/pages/driver/readingChecks.ts),
  [submit body](../../apps/web/src/pages/driver/readingsSubmit.ts),
  [submit window](../../apps/web/src/pages/driver/DriverSubmitCheck.tsx),
  [time field](../../apps/web/src/pages/driver/DriverTimeField.tsx)

## Context

The cabinet was built for a driver who fills the form in pieces: the fuel at the start in the
morning, a refuelling in the afternoon, the counters in the evening (ADR 0163 decisions 2 and 4).
The fields were optional, the form hinted «Вечерние показания ещё не переданы», and a time field had
a «сейчас» button for a driver who marks the day as it goes (ADR 0234, D9).

In practice the readings are sent once, when the shift ends, and the pieces arrived incomplete: a
block with an odometer and no fuel, a fuel start with no end. The ledger then has a shift it cannot
count consumption for (`fuelSpentSql` needs both levels), and the dispatcher completes it by phone.
The owner asked to stop sending such data from the phone: everything is required except an empty
refuel, and one of the two counters is enough.

The second request: the values at the start of a shift must equal those at the end of the previous
one, and a mismatch must go through an explicit window with a formal text. The fuel start was never
compared with anything (fuel plan Р9, Р10 — "that would be a consumption, which is deferred"). The
consumption ban was lifted by ADR 0194, and the owner now asks for the comparison itself.

The «сейчас» button follows from the first change: the device's clock at the moment of sending is
not the time of the event, and a tap on it wrote a wrong time more often than a right one.

## Decision

1. **A block the driver starts is whole, or it does not leave the phone.** Required: the fuel at the
   start of the shift, the fuel at its end and **one of** the odometer and the engine hours (a
   vehicle often has only one of them, and the form cannot know which — the refusal stands under
   both fields). `fuelFilledLiters`, the comment and the files stay optional: an empty refuel means
   "not refuelled", which is how the server already reads it (`coalesce` in `fuelSpentSql`). The
   rule is one contract predicate, `driverReadingCompletenessIssues`; every refusal of the block is
   shown at once, each under its own field, together with the time refusals.
2. **Whose block is judged.** Only a block the driver changes (`blockChanged`, the comparison the
   time rule already uses). A new block with nothing touched is skipped, as before (ADR 0163
   decision 5): the other shift of a day is sent when it ends. A saved block resent unchanged is not
   judged again, so a staff entry or a morning part saved by an older build never holds the day. A
   saved block the driver empties is a command and is refused as incomplete, not skipped.
3. **The shift is always finished.** `driverReadingTimeIssues` takes `complete: true` from the
   cabinet: an ESM-2 block carries the start and the end time, a route block the arrival at stop 1
   and the departure from every stop, whatever the numbers say. The server never passes the flag, so
   its derived rule (an evening value requires the end time) is unchanged for staff and older builds.
4. **The previous shift.** The snapshot `DriverPreviousReading` gains `fuelEndLiters` and is built
   from the ledger's own order `(report_date, shift_order)`: the latest reading of an earlier day,
   or the nearest earlier shift of the SAME day when there is one — the second shift of a day opens
   with what the first left in the tank. A reading of the entry's own shift is never its own
   predecessor. It is one row: a field the previous shift did not capture is `null` ("nothing to
   compare with"), never the value of an older shift, which would be a consumption, not a
   continuity. In the cabinet, an earlier block of the same vehicle in the same report that carries a
   number wins over the server's snapshot: a day with two shifts is filled and sent in one go, and
   the server cannot know what is typed but not sent.
5. **What is compared, and what is judged by what.** The fuel at the start against `fuelEndLiters`
   (to the column's tenth); the counters against the previous values (a falling counter, an
   implausible daily growth — the existing warnings, which no longer carry a checkbox); and the
   anomalies the server recorded on an earlier submit and nobody confirmed. A changed block is judged
   by its own numbers, because the server recomputes its anomalies on this submit; a block resent
   unchanged carries only the anomalies already recorded. Judging an unchanged block by its numbers
   would ask on every later submit of the day about a discrepancy confirmed five minutes ago. Under
   the fuel start stands «в конце прошлой смены: 92 л (27.10)», as under a counter stands the
   previous value.
6. **One window instead of a checkbox.** Where the block carried «Всё верно, подтверждаю», «Передать»
   now opens a window when any discrepancy exists: a formal text, every discrepancy of the day in
   one numbered list with the vehicle and the source, «Вернуться к исправлению» and «Подтверждаю,
   передать». The return button, the close key and the mask send nothing and open no attempt: the
   idempotency key is not spent. The confirmation flags of the rows follow the window's answer, not
   the draft; a hard error (outside the absolute bounds) never reaches the window. The draft keeps
   `confirmAnomaly` in its shape — changing it would raise the draft format — and nothing reads it.
7. **The fuel confirmation is the cabinet's word only.** The server records no fuel discrepancy: no
   column, no event. The confirmation of a counter anomaly travels as before and the server applies
   it only where an anomaly exists. Staff entering a reading in the garage keep their own form and
   their own confirmation; they are not asked for completeness.
8. **The «сейчас» button is removed** from every time field. A time is typed, and `730` is read as
   07:30 when the field loses focus, as before.
9. **No migration, no client floor.** The snapshot field is additive and old tabs do not read it. A
   tab opened before the release keeps the old rules until it is reloaded, and the server accepts
   what it sends.

## Consequences

- (+) The ledger gets a shift whole at once: both fuel levels and a counter, with the times. The
  consumption of the shift is computable without a call to the driver.
- (+) A mismatch with the previous shift is caught while the driver still stands at the machine.
- (−) A mismatch is often true: a tank drained or topped up overnight, a shift nobody reported or
  staff closed as `no_data` in between, a vehicle changed under the driver. The driver confirms it in
  the window and it is not recorded, so the window costs an extra tap and gives the dispatcher
  nothing to read later. If the owner wants to see confirmed fuel mismatches, the server needs a
  column and an event, which this decision does not add.
- (−) A driver can no longer send the morning part at noon and finish the shift in the evening: the
  whole block waits for the end of the shift. A morning-only reading already in the ledger stays
  valid and can be completed.
- (−) An empty «Заправлено» and a zero are indistinguishable to the form: both mean "not refuelled".
- (−) The previous-shift snapshot costs two more small queries per day (the day's readings and the
  positions of the entries' own items).

## Verification

API db suite `driver-assignment.db.test.ts`: the snapshot carries `fuelEndLiters` as a number; the
second shift of a day gets the first one's reading with zero days, the first shift keeps yesterday's,
and an entry's own reading is never its predecessor; a previous shift without a fuel end gives
`null`, not an older level. Portal: an incomplete block is refused with every missing field named
under it, the odometer-or-hours slot refuses under both fields, an empty refuel leaves as `null`, a
fuel start different from the previous end shows the hint, the warning and the window, a second shift
of the same vehicle is compared with what is typed into the first, «Вернуться» sends nothing, the
confirmation flags follow the answer, an unchanged saved block is not judged again, no time field
has a «сейчас» button, and a morning-only block is refused together with the missing end time.
