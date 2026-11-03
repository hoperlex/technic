# ADR 0244. «Не работал»: the driver closes a shift without work, the garage checks it

- Статус: Принято (03.11.2026). Release 1A (compatible readers, `v4` draft, client contract 8,
  writes closed) implemented, not pushed; the floor operation `deploy-auto --client-floor=8` and
  release 1B (writes and the switch open) are pending
- Домены: кабинет-водителя, гараж, схема-и-выкат
- Изменяет: [ADR 0105](0105-driver-cabinet-documentary.md) — decision 3 (the driver has no way to
  close a row without numbers): «Не работал» is the driver's own answer for a shift without work,
  while `no_data` («работали, но снять нечего») stays the dispatcher's; plan
  [driver-cabinet-ux-plan.md](../driver-cabinet-ux-plan.md) — Р4 in the same reading
- Развивает: [ADR 0242](0242-sunday-rest-day-readings.md) (Sunday is a rest day): what the hotfix
  left open for holidays and idle days on other weekdays
- Связано: [ADR 0237](0237-driver-readings-whole-at-shift-end.md) (whole shifts; an empty day is
  not accepted), [ADR 0226](0226-client-floor-seven-and-deploy-preflight.md) (client floor order),
  [ADR 0207](0207-vehicle-request-day-batch.md) (one shift for two papers),
  [ADR 0234](0234-driver-shift-and-stop-times.md) (shift times), plan
  [rest-days-plan.md](../rest-days-plan.md) (§4, stage 1)
- Область: [reading kind and reasons](../../packages/contracts/src/vehicle-readings.ts),
  [schema](../../apps/api/src/db/schema.ts),
  [enum value](../../apps/api/drizzle/0412_reading_kind_idle.sql),
  [reason and checks](../../apps/api/drizzle/0413_reading_idle_reason.sql),
  [write path](../../apps/api/src/services/readings.ts),
  [expected shifts and continuity](../../apps/api/src/services/readings-expected.ts),
  [fleet months and maintenance tail](../../apps/api/src/services/readings-aggregate.ts),
  [intake contradictions](../../apps/api/src/services/readings-idle.ts),
  [intake registry](../../apps/api/src/services/readings-intake.ts),
  [request days](../../apps/api/src/services/shift-driver-days.ts),
  [cabinet block](../../apps/web/src/pages/driver/DriverIdleSwitch.tsx),
  [draft store](../../apps/web/src/pages/driver/draftStore.ts),
  [client contract](../../apps/web/src/shared/api/clientContract.ts)

## Context

After the Sunday hotfix (ADR 0242) the owner decided on 03.11.2026 how the portal treats days off
(plan `docs/rest-days-plan.md`, decisions D1–D8): Sunday is the only rest day by default, a
dispatcher may mark a working Sunday, and holidays are not a company calendar but the driver's
answer. Until now a holiday was a working day everywhere, and the driver could not close it: the
cabinet sends whole shifts only (ADR 0237), an empty day is not accepted, and the only "closed
without numbers" kind, `no_data`, is the dispatcher's (ADR 0105, decision 3). The day stayed a debt
in the cabinet and «нет показания» in the garage until somebody closed it by hand.

Owner decisions of the survey (03.11.2026): the name «Не работал»; a switch per vehicle block, not
per day (D3); a reason from a list — «Выходной или праздник», «Простой на объекте», «Ремонт»,
«Другое» with a word (D4); the garage accepts it as a submitted shift, green, yellow on a
contradiction (D5); the site's sign-off stays as it is (D7).

## Decision

1. **A reading kind of its own.** `idle` next to `values` and `no_data`, with `idle_reason`
   (`day_off`, `site_idle`, `repair`, `other`; «Другое» takes its word from the comment). The
   vehicle did not work this shift: no counter, no fuel, no times. The database holds the shape
   (`vehicle_readings_values_check` gains the branch, `vehicle_readings_idle_check` ties the reason
   to the kind and the word to «Другое»).
2. **The driver's answer.** Unlike `no_data`, the driver sets it, per block; staff may enter it for
   him with the same list. Switching a block to it clears the stored numbers, times, stops and
   anomaly confirmations in the same transaction; switching back is an ordinary edit.
3. **A closed shift, transparent to the counters.** An idle shift ALIGNED with its live source
   closes the expectation: it is never «нет показания», the counter pair across it stays continuous
   (Р13а), the maintenance tail does not rise through trailing idle days, the fleet months count it
   as a shift and apart (`idleShifts`), and a request day gets zero hours and zero refuelling from
   it, keeping the source-discrepancy guard. A misaligned one closes nothing, like any reading at an
   old coordinate.
4. **The garage checks it (D5).** Green unless contradicted; each contradiction is a yellow line:
   a trip on the source or on a route it suppresses («назначен рейс»), nonzero hours the site
   recorded for a served request of the source that day («объект подписал N ч»), another reading of
   the vehicle that day with numbers («машина в этот день работала»). The coverage context of the
   ESM-2 suppression (ADR 0207) is walked on every weekday: a route A+B hidden by the sheet of A
   still carries B's trip and B's hours. Recomputed on every read and again by the batch acceptance,
   which refuses a contradicted report; a single acceptance stays one click.
5. **The words.** «Не работал: <причина>» in the registry, the journal, the exports and the readings
   book; the request-day route time says «водитель отметил смену рейса «Не работал»» and proposes no
   time; the driver schedule shows «не работал».
6. **Two releases, ADR 0226 order.** Release 1A ships every reader, the cabinet's `v4` draft and
   client contract 8 with writes closed (`IDLE_READINGS_OPEN = false`, one constant for the server
   refusal and the hidden switch). A contract-7 tab drops the kind from its draft and would resend the
   numbers hidden under the switch as `values`; a client floor does not reach local storage, so the
   draft moved to its own prefix and `v3`/`v2` became read-only input (rows and pending attempts are
   adopted once, with their keys). After 1A is served, the operator raises the floor to 8; release 1B
   then requires it and opens the kind.

## Consequences

- (+) A holiday or an idle day is answered by the driver in one switch, and stops being a debt in
  the cabinet and a red row in the garage; the dispatcher no longer closes it by hand.
- (+) The counters stay honest across it: the next numbers are compared with the last real ones.
- (−) It is an opt-out button again, the one ADR 0105 removed. The intake contradictions are its
  counterweight, not a proof: work hidden under «Не работал» without a trip, a site signature or
  another reading shows only as a larger delta in the next shift, and the growth threshold scales by
  calendar days (`jumpLimit`), so an idle day widens it. See «Open».
- (−) A zero-hour request day still needs the site's own comment before its signature (D7): the site
  writes one per idle day.
- (−) Release 1A changes nothing a person sees except the new «Не работал» count on the vehicle card;
  the switch appears only with 1B, after a separate operator step.

## Open

- A contradiction for work hidden under «Не работал»: the next shift's engine-hour delta longer than
  its own shift time (ADR 0234), or its fuel start differing from the last end before the idle days;
  and whether idle days should widen the growth threshold at all.
- A garage action to close the unsubmitted shifts of a date as «Не работал» for many vehicles at
  once: after long holidays the driver's window (7 days) is shorter than the holiday.
- Whether the site's comment of a zero-hour day may default to the idle reason category.

## Verification

API db suite `readings-idle.db.test.ts`: the write is refused while closed; values ↔ idle edits clear
and restore the shape; the database checks refuse a reason on numbers and numbers on idle; an aligned
idle keeps the pair continuous while an opened empty day breaks it; the month counts the shift and
apart; trailing idle days do not raise the tail; the intake is green without contradictions and
yellow with a trip, another reading's numbers, signed hours, and through a route the sheet
suppresses; hours signed after the page loaded take the report out of the batch. Pure tests: an idle
request day is a clean zero day, adds nothing next to a worked shift, still stops on an unresolved
discrepancy. Portal: the switch hides the numbers, needs a reason and sends the kind alone, brings the
typed numbers back when off, «Другое» needs its word, a later shift is not compared with the hidden
numbers, and a build with the switch closed shows a saved idle and sends it back unchanged; the draft
store adopts `v3` rows and pending attempts and reads the `v3` journal of adopted `v2` rows.
