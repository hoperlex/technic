# Rest days: Sunday by default, a working Sunday by mark, «Не работал» for the rest

Status: plan, revision 2 of 03.11.2026; nothing of it is implemented. The owner closed every fork by
two surveys on 03.11.2026 (§2). The hotfix this plan grows from —
[ADR 0242](adr/0242-sunday-rest-day-readings.md), release 0.1.135.0242 — is in prod (build
`64a31d73`). Revision 1 (a company calendar with holidays) is withdrawn: holidays are answered by
the driver, not by a calendar.

## 1. Problem

The portal walks request terms by the calendar, and every calendar day is a working day except
where a rule was written locally:

- the readings module (ADR 0242): a Sunday of a weekly ESM-2 or of a site-day route is not asked
  for; but nothing can make a given Sunday a working one, except a reading the driver happens to
  send;
- the day batch (ADR 0207) issues a 4-П for every day of the term, Sundays included;
- the rental month cut (ADR 0238) treats Saturday and Sunday as days off;
- a holiday is a working day everywhere, and the driver cannot close it: the cabinet sends whole
  shifts only (ADR 0237) and an empty day is not accepted, so a holiday stays a debt in the cabinet
  and «нет показания» in the garage until the dispatcher closes the row as `no_data` by hand.

## 2. Decisions (owner, 03.11.2026)

- **D1. Sunday is the only rest day by default.** No company calendar, no holiday list. Saturday is
  a working day everywhere, the rental cut included.
- **D2. A working Sunday is set by the dispatcher**, on the request card, per date: a switch
  «Рабочая смена» on a Sunday of the request's days. Whoever assigns vehicles (`vehicleRequests.status`)
  sets and removes it, for future Sundays and backwards within the driver's write window (7 days).
  The mark makes the Sunday an ordinary working day of that request: its weekly ESM-2 and its
  site-day 4-П are asked for, the cabinet calls it a debt.
- **D3. «Не работал»** — the driver's answer for a shift without work (a holiday, idle time, a
  repair). A switch in **each vehicle's block**, not one for the whole day: a driver with two vehicles
  closes only the one that stood.
- **D4. A reason is chosen from a list:** «Выходной или праздник», «Простой на объекте», «Ремонт»,
  «Другое» (then a word is required).
- **D5. The garage accepts «Не работал» as a submitted shift:** green and fit for batch acceptance
  when nothing contradicts it, yellow with an explanation when something does (§4.3).
- **D6. The day batch skips Sundays** by default; a checkbox «включая воскресенья» issues them and
  sets the working mark on each.
- **D7. The site's sign-off stays as it is:** every day of the term is signed, Sundays and «Не
  работал» days with zero hours.
- **D8. The rental cut follows D1:** the new order starts on the first day of the next month that is
  not a Sunday.

## 3. One rule for "is this shift asked for"

A shift of a source on a day is asked for unless it is a **rest-day shift**: the day is a Sunday,
the source is a weekly ESM-2 or a route without a trip (its served composition rows are all days of
site work), and the source's request has **no working mark** for that day. A trip — a freight row,
a delivery, a pickup — is always asked for. A rest-day shift with a reading in it is counted like
any other.

The rule stays where the hotfix put it — `restDayShiftSql` / `restDayExemptSql` and the TypeScript
twin `isRestDayShift` in [readings-expected.ts](../apps/api/src/services/readings-expected.ts) —
and gains one condition: `NOT EXISTS` a working mark of the source's request on that day. The
request of a source is the ESM-2's `source_request_id`, or the request of a site-day route's
composition row (`vehicle_route_requests.work_date = day`). Every reader the hotfix wired —
relation, «не сданы», «источник пропущен», day state, driver schedule, maintenance tail — follows
without its own change. The cabinet keeps asking `readingOptional`; the portal holds no weekday rule
(the bundle lesson of the hotfix: `restDay.ts` stays dependency-free).

## 4. «Не работал»

### 4.1 In the ledger

- A new reading kind **`idle`** next to `values` and `no_data`, and a column `idle_reason`
  (`day_off`, `site_idle`, `repair`, `other`) with the text in the existing comment, required for
  `other`. The values check of `vehicle_readings` gains the `idle` branch: no numbers, no times.
- Meaning, written into the kind's comment: **the vehicle did not work this shift.** Not
  `no_data` («работали, но снять нечего»): an `idle` shift is not a missing reading, consumes no fuel,
  has zero engine hours, and is transparent to the counter chain.
- **Counter continuity** (`counterPairBrokenSql`, Р13а/Р13б): an `idle` row closes its expectation
  and does not break the pair across it — today a reading without the counter breaks it.
- **Previous-shift snapshot** (ADR 0237, decision 4): skips `idle` rows, so the next shift's fuel
  start is compared with the last real end, not with "nothing".
- **Fleet months:** `idle` counts as a closed shift, never in `missingReadings`; a separate number
  `idleShifts` so data quality does not read a holiday as work.
- **Request shifts** (`shift-driver-days.ts`): an `idle` day gives the driver's day `machineHours: 0`,
  clean, so the site signs it in one click (D7).
- **Exports and the readings report:** the row says «Не работал: <причина>».

### 4.2 In the cabinet

- The block gets a switch «Не работал». On: the number and time fields hide, a reason select
  appears, the whole-shift completeness (ADR 0237) does not apply; the block leaves as `idle`. Off:
  the fields come back with whatever was typed.
- Allowed on any day, rest day or not, and on a trip too (a planned trip that did not happen is a
  real answer; the garage sees it, §4.3).
- The day line: a day whose blocks are all `idle` reads «Передано · Не работал». The debt line
  needs nothing: a submitted day is no debt.
- Draft: one more field of a block (`idle`, `idleReason`). Whether that is an additive field of the
  `v3` format or a `v4` is decided in implementation against ADR 0129's rules (an older build must
  not resend an `idle` block as an empty `values` one — today it would refuse locally as
  incomplete, which is safe).
- Staff entering a reading for a driver (`IntakeReadingForm`) get the same kind and list.

### 4.3 In the garage intake (D5)

An `idle` row is a closed shift. Green, batch-acceptable, unless one of these marks stands (yellow,
single acceptance, one line each):

1. **a working mark** stood on that Sunday — «на этот день стояла рабочая смена»;
2. **the source is a trip** — «назначен рейс, водитель отметил: не работал»;
3. **the site signed hours** for that request day — «объект подписал N ч»;
4. **another reading of the same vehicle that day has numbers** (a substitute drove it) — «машина в
   этот день работала: <источник>».

No new blocker: the dispatcher accepts a yellow row consciously, as with `shift_tail_missing`.
Marks 2–4 need only stage 1; mark 1 comes with stage 2.

## 5. Stages

Each stage is one release with its ADR and its entry in «Обновления» (ADR 0077), pushed together
with the entry. Migrations and permissions are never automatic (`pnpm maintain surfaces`).

1. **«Не работал»** (§4). Migration A adds the enum value alone (PostgreSQL does not let a
   transaction use an enum value it added); migration B adds `idle_reason` and the check. Contracts
   (kind, schema, reason list and labels), server (submit, continuity, snapshot, aggregate, intake
   marks 2–4, exports, schedule, request days), cabinet switch and select, staff form. Client floor:
   decided in implementation; the conservative answer is to raise it with this release: an older tab
   knows two kinds, and how it renders a third must be checked, not assumed.
2. **Working Sunday** (D2). A table `vehicle_request_working_days (request_id, work_date, set_by,
set_at)` with a check that `work_date` is a Sunday; set and remove on the request card's days with
   `vehicleRequests.status`, within [today − 7, ∞); an event in the request history. The rule of §3
   gains the mark; `readingOptional` follows; intake mark 1. Removing a mark after a reading came
   changes nothing for that reading (a reading is always counted).
3. **Day batch** (D6). Sundays skipped by default and listed in the batch report as «воскресенье —
   не выписан»; the checkbox issues them and sets the marks in the same transaction per day.
4. **Rental cut** (D8). `rentalMonthSplit` skips only Sunday; ADR 0238 is changed by the stage's
   ADR. Small: may ride with stage 3.

Order: 1 first — it closes holidays, the part drivers hit today. 2 before 3: the batch writes marks.
4 is independent.

## 6. Open, decided in implementation (defaults stated)

- The draft format question of §4.2.
- The client floor of stage 1 (default: raise).
- The exact labels of the reason list (default: D4 as written).
- Whether `idle` on a trip should also notify the dispatcher by mail (default: no — the intake mark is
  the signal).

## 7. Risks

- **22 files read the reading kind today** (`'no_data'` appears in contracts, services, garage and
  cabinet code). Every one must answer `idle` on purpose; exhaustive switches over `ReadingKind`
  make the compiler point at them, the SQL ones need a grep and a test each.
- **Expected-shift queries are hot.** The working-mark lookup is an indexed `EXISTS` on
  `(request_id, work_date)`; measure `pendingReadingsSql` on a year's volume before stage 2 ships
  (5 ms today).
- **Tests that float with the calendar.** db tests date their scenarios from today. Run the readings,
  shifts and batch suites as if today were each day of the week (clock shift in the test process),
  and compare with the same shifted run on the base commit: failures on both are artefacts of the
  shift, not regressions.
- **Migration window.** New code writes the new kind and the new table; old code running during the
  window never reads them; an empty working-days table equals the hotfix.

## 8. Verification

- db: an `idle` row closes the expectation, keeps the pair continuous, is skipped by the previous
  snapshot, gives the site a clean zero day; intake marks 1–4 each; a working mark makes a Sunday
  pending and the cabinet's debt; the batch skips and, with the checkbox, issues and marks.
- portal: the switch hides and restores the fields, the reason select and «Другое» with text, the
  day line «Не работал», the request card switch within the window only.
- release entries in the users' words for each stage.
