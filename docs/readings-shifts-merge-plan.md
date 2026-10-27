# Readings and hours: one source for a day's work

Status: reviewed proposal, 27 October 2026. Nothing is implemented. The owner closed the forks
marked **D1–D8** by two surveys on 27 October; the questions in §12 are still open. Driver cabinet
mock-ups (two variants, A and B) are on the canvas
<https://claude.ai/artifact/65MiduZt4LyhCR19S5pi4c>; the choice between them is open question Q1.

## 1. Problem

A driver submits a reading for a day of work: odometer, engine-hour counter, fuel. The garage shows
it. The shift table of the same special-equipment request stays empty, and the site types the same
day again by hand: machine hours, refuelling, time.

This is not a broken join. The two are separate entities with no link at all:

- `vehicle_request_shifts` ([ADR 0184](adr/0184-vehicle-request-shifts.md), migration 0086,
  August 2026) — the site's record of a request day and its sign-off;
- `vehicle_readings` ([ADR 0103](adr/0103-vehicle-readings.md), migrations 0132/0133, later) — the
  unit's counter snapshots, submitted by a driver per source (a route or a weekly ESM-2 waybill).

The shift table was built when the portal held no driver data. ADR 0103 mentions shifts only to say
they are "contractual accounting with the lessor, not readings of the unit", and no later decision
connected them. Since then two places hold the same day's work, and the one the request shows is the
one typed by hand.

## 2. Where hours and times live today

| Fact                        | Where                                                                            | Who writes                     | Who reads                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Engine-hour counter         | `vehicle_readings.engine_hours` (snapshot), deltas by `previous_engine_hours_id` | driver, staff                  | garage journal (`readings-stats.ts`), month aggregate (`readings-aggregate.ts`), readings book, fuel norms                     |
| Day's machine hours         | `vehicle_request_shifts.machine_hours`                                           | site (shift window, "On site") | shift table, linear days (`vehicle-request-days.ts`), summary book atoms (`analytics/facts-vehicle.ts`), term refusal, history |
| Refuelling                  | `vehicle_readings.fuel_filled_liters`; `vehicle_request_shifts.refuel` (text)    | driver; site                   | garage, readings book; shift table                                                                                             |
| Shift time                  | `vehicle_request_shifts.started_at/ended_at`                                     | site                           | shift table, linear days                                                                                                       |
| Planned arrival at a stop   | `vehicle_route_points.arrival_time`                                              | dispatcher                     | driver cabinet, letters, waybill                                                                                               |
| Actual arrival or departure | nowhere                                                                          | —                              | —                                                                                                                              |
| Billed amount               | `vehicle_request_completions.worked_amount` (+ unit hours/shifts)                | dispatcher at closing          | request card, summary book; prefilled from signed shift hours (`approvedMachineHours`)                                         |

Not in scope: `vehicles.shift_hours` and `vehicle_request_assignments.shift_hours` are a rate
parameter (length of a billed shift), not a fact of work.

## 3. Target model

**The current measured fact lives in the reading.** Counters, refuelling and, after stage 2, times
come from the driver's (or staff's) reading of an own vehicle. A signed shift row necessarily keeps
the numbers accepted by the site as a historical snapshot; later reading edits must be visible as a
difference, not silently rewrite that signature.

**A request day is a view, not a second store.** The shift table answers "what happened on this day
of the request" by reading the driver's reading of that day. It holds its own row only for what has
no other home:

- the site's sign-off — the decision "this day is accepted", with the numbers it was given under;
- a manual record where no reading can exist (a rented vehicle — its lessor's operator has no cabinet)
  or where the reading cannot answer (a gap in the counter chain, §6.2);
- the site's comment and, until stage 3, the shift time.

**A billed amount stays a separate, editable fact.** The completion
([ADR 0029](adr/0029-vehicle-request-completion.md)) is prefilled from the day records — signed
shift hours for special equipment, per-request route time for freight — and remains editable: the
lessor's invoice includes delivery and minimum rental, and the completion must match the invoice.

## 4. Decisions taken

- **D1. Readings are the basis of a request day** (survey 27.10). The shift table reads the driver's
  reading of the day; the shift window fills its form from it; "Approve" on a day without a site row
  writes the row from the driver's numbers in the same transaction. No migration for this part, no
  copy on submit. Rejected: copying readings into shift rows on submit — a second store to keep in
  sync with edits, rebases and voids of a report, and a submitted day would start refusing term
  edits (the F5 rule counts any shift row as a filled day).
- **D2. Every submitted reading counts**, not only accepted ones: states `submitted`, `accepted`,
  `needs_reacceptance` — the garage's operative rule (Р27). The day shows whether the report is
  accepted. A `draft` never carries a reading (it is written at submit); `voided` never counts.
- **D3. A gap in the counter chain is shown, not signed in one click.** The driver's hours count as
  the day's only when the previous engine-hour snapshot is from the same day or the previous
  calendar day. Otherwise the day shows the hours with "since DD.MM", and the site saves the form
  (prefilled) consciously before signing.
- **D4. The driver's numbers replace the site's unsigned ones.** For an unsigned day with clean
  driver numbers (§6.2) the hours and refuelling come from the reading even if the site typed others.
  A signed day keeps what was signed; a later difference is shown next to it.
- **D5. Times are mandatory when a driver finishes a shift**, optional for staff entering or
  closing a reading on a driver's behalf; a `no_data` reading needs none. ADR 0163 permits an
  interim submission with morning fuel or other partial values. The final action enforces time;
  an unfinished item stays visibly incomplete and cannot be accepted as a finished `v3` reading.
- **D6. Route time is split by stops.** The segment "from the previous departure (the arrival for
  stop 1) to the departure from this stop" belongs to the requests that have a role at this stop; a
  shared stop is split equally. Per-request sums add up to the shift.
- **D7. Per-request route time is shown in the request card and prefills the completion** at closing,
  which stays editable.
- **D8. A relocation records no time.** It has no stops, only "from/to".

Read from the owner's words, not asked separately: on a route the arrival at stop 1 is the start of
the shift and the departure from the last stop is its end; every other stop has a departure only.

## 5. Stage 0 — cleanup without behavior change

One commit, no behavior change, so stage 1 lands on one reader instead of three.

1. Move `SUBMITTED_STATES` from `readings-stats.ts` to contracts as `SUBMITTED_REPORT_STATES`
   (`vehicle-readings.ts`); `readings-stats.ts` imports it. Stage 1 is its second reader.
2. One mapper for shift rows. `vehicle-request-days.ts` has its own `shiftsOfRequest` with its own
   `hours()`/`timeOnly()` copies; it uses the same row mapper as `vehicle-request-shifts.ts`.
   A direct call to `loadRequestShifts(request, term)` would lose a row on a planned day outside the
   current term: a frozen issued route can keep that day visible in the linear days table. Preserve
   this existing behavior by reading rows for the union of term days and planned days, then apply
   the effective-day overlay only to days inside the term. Test an out-of-term frozen route day.
3. `shiftsOfRequest` callers that need rows only (term refusal in `assignment-shifts.ts`) keep
   reading rows: they decide by "the site wrote something", not by the effective day (§6.6).

## 6. Stage 1 — request shifts read driver readings

No migration. Contracts, one server reader, the approval door, the shift window and the card tab.

### 6.1 Which readings belong to a request day

For request `R` (special equipment) and day `D`: readings, not merely expected report items, with
`report_date = D` in a report whose state is in `SUBMITTED_REPORT_STATES`, and

- `source_kind = 'esm2'` and the waybill's `source_request_id = R`, or
- `source_kind = 'route'` and `vehicle_route_requests` has `(route_id, request_id = R, work_date = D)`.

Both branches, not only the expected one. The garage suppresses a day route when a weekly ESM-2
covers the same day (`EXPECTED_ROUTE_FILTER`), but a report composed before the suppression may still
hold the route item, and its reading is still the vehicle's work for this request.

Several items on one day (a vehicle swapped mid-day, two items of one vehicle) sum; that matches
ADR 0184's "one row per day with the summed hours". Match the source's actual vehicle and day to
the item snapshot and expose the reading module's source discrepancy as non-clean; use that module's
rule rather than a second definition. Extract the source check into a shared server helper if its
current service boundary prevents reuse. Request membership of a route is deliberately read live in
stage 1: `driver_daily_report_items` has the route ID but no request snapshot, and
`detachRequest` can change `vehicle_route_requests` after a reading was sent. A composition
correction can therefore move an **unsigned** effective day between requests. It must refresh the
card and invalidate the driver's approval fingerprint; a signed row stays the accepted snapshot
and follows the existing route-correction revocation rules (ADR 0210). Do not describe the stage 1
join as historical attribution. Stage 2 snapshots request roles for the timed freight allocation.

### 6.2 The driver's day numbers and when they are clean

Per item: hours = `engine_hours − previous.engine_hours` when the reading is `values`, both numbers
exist and the engine-hour anomaly is not `counter_reset`. Refuelling = `fuel_filled_liters`.

The day is **clean** when every submitted reading for this request day has hours, every predecessor
snapshot is from `D` or `D − 1`, no source discrepancy exists, and the day's sum lies in
`0..MAX_MACHINE_HOURS`. A first snapshot, a `no_data` reading, a missing engine-hour value, a reset
or a source discrepancy is non-clean. Otherwise the day carries the sum it has, the oldest known
predecessor date (`since`) and any reason; it never replaces the site's numbers. Preserve `null`
fuel as "not recorded", distinct from numeric zero; do not label it "not refuelled". Sum only
recorded refill values and show incomplete fuel separately rather than claiming a complete total.

This is not the garage's continuity rule (Р13а: no missing _expected_ shift between the snapshots). It
is a narrower rule about one click, D3, and the plan keeps it that way on purpose: a Monday after a
weekend without readings is continuous for the garage but asks the site to save the form. Q6 asks
whether that cost is acceptable.

### 6.3 The effective day

| Day state                                      | Hours and refuelling | Time, comment   | `source` |
| ---------------------------------------------- | -------------------- | --------------- | -------- |
| signed                                         | the row (frozen)     | the row         | `site`   |
| unsigned, driver clean                         | driver               | the row, if any | `driver` |
| unsigned, driver not clean or none, row exists | the row              | the row         | `site`   |
| nothing                                        | empty                | empty           | `null`   |

The refuelling text from the driver is `"<liters> л"` when all contributing readings recorded a
refill value. Zero is `"0 л"`; a missing value stays visibly unknown. A signed row keeps the text
that was accepted.

### 6.4 Contracts

- `VehicleRequestShiftDto` gains `source?: 'site' | 'driver' | null` and
  `driver?: ShiftDriverDayDto | null` with `machineHours | null`, `refuelLiters | null`, `clean`,
  `fuelComplete`, `since | null`, `noDataReason`, `comment`, `driverNames`, `reportStates`, and
  `sourceDiscrepancy`. Both optional: a portal
  newer than the server falls back to `filledAt ? 'site' : null`.
- `shiftSourceOf(shift)` — that fallback, in one place; `isShiftFilled(shift)` = a source exists.
  The approve checkbox, the "not filled" tag and `unapprovedPastShiftDays` ask it instead of
  `filledAt`.
- `refuelLabel(liters, complete)` — the one way a driver's liters become the refuel text; unknown
  is never converted to zero.
- The approval body optionally carries an `expectedDriverFingerprint`. It is required when the
  effective source is `driver` and includes the candidate reading IDs, versions, predecessor IDs,
  report states, source mapping and the displayed hours/refuelling. An old tab can still approve a
  site-only row; if a clean driver reading has since overlaid that row, its old body gets 409 and a
  refresh prompt rather than signing unseen numbers.

### 6.5 Server

- `loadDriverShiftDays(reader, requestId, term)` in a new `services/shift-driver-days.ts`: one query
  over items, reports, readings, the predecessor reading and both source branches; returns a map by
  day. Hours are computed from the existing chain (`previous_engine_hours_id`), never by searching
  for "the nearest earlier row" again.
- `loadRequestShifts` merges rows and driver days by §6.3 for term days. Keep a separate row-only
  accessor for write doors and out-of-term planned days: today's `loadRequestShift` returns `null`
  solely by `filledAt`, so changing it to return a driver-only day would make DELETE treat a
  nonexistent row as present and blur the save/approval rules.
- **Approval door** (`POST /:id/shifts/:date/approval`, approve): under the same locks, when the day
  is `driver`, compare the expected fingerprint with a freshly loaded candidate, upsert the row
  from server-computed numbers (keeping the row's time and comment), then sign. Zero hours need a
  comment (the existing CHECK and rule): the row's comment, else the driver's reading comment,
  else 422 asking for one. A day that is neither a row nor clean keeps the old 422. The signature
  records the numbers read in this transaction; a later reading edit is a visible difference. Do
  not promise that readings cannot change immediately after signing. Revoking is unchanged.
- **Save door**: on a clean `driver` day, require the candidate fingerprint and write the current
  server-computed hours/refuelling with the submitted site time/comment. Reject an old tab or a
  stale fingerprint with 409. On a non-clean or manual day, keep the manual save rule. This keeps a
  stale site's numbers from reappearing if a driver report is later voided or rebased. The approval
  and save doors compute the candidate by the same helper under the existing request lock. DELETE
  still addresses only a physical site row.
- **History**: the `shiftApproved` line gains "по показаниям водителя" when the source was the
  driver.

### 6.6 Neighbours that do not change

- The term refusal (`assertTermKeepsFilledShifts`) keeps counting rows. A day filled only by a
  driver does not lock a term edit — the reason D1 rejected copying.
- `shiftSummaries`, the sign-off debt and the "On site" filter count signatures, not fills.
- The completion prefill (`approvedMachineHours`) sums signed rows, which now carry the driver's
  numbers when signed from them.

### 6.7 Portal

- Card tab `VehicleShiftsView`: a `driver` day shows its hours with a "водитель" mark and the report
  state; a non-clean driver day shows "водитель: 23 ч с 14.08" under a dash; a signed day with a
  different driver number shows the difference.
- Shift window `VehicleShiftsModal`: a `driver` day locks hours and refuelling ("по показаниям
  водителя — исправляют в гараже") and leaves time and comment editable; "Approve" is enabled on it.
  Initialize the form by `source`, not today's `filledAt` gate; send the approval/save fingerprint
  and refresh the day on 409. A non-clean driver day may prefill the form with its partial sum when
  it fits `0..24`, but labels it incomplete and requires an explicit manual save before approval.
- The linear days table shows the effective hours through the stage 0 reader.

### 6.8 Tests

- Contracts: `shiftSourceOf`, `isShiftFilled`, `refuelLabel`.
- DB (`vehicle-request-shifts.db.test.ts` or a new `shift-driver-days.db.test.ts`): ESM-2 reading →
  day `driver`; route item of a day route → day `driver`; predecessor two days back → not clean with
  `since`; first snapshot, `no_data`, missing engine hours, source discrepancy and `counter_reset`
  → not clean; `voided` report → ignored; `null` refuel distinct from zero; unsigned site row
  replaced; signed row frozen with a difference; approve on a driver day writes the row and signs;
  old-tab approval and stale fingerprint → 409; zero hours without any comment → 422; term edit not
  refused by a driver-only day; DELETE of a driver-only day → 404; an out-of-term frozen route day
  retains its physical shift row.
- Web: `vehicle-shifts-modal.test.tsx` (locked inputs, approve enabled, conflict refresh),
  `vehicle-shifts-tab.test.tsx`.

### 6.9 Records

Add a dated "Driver readings as the day's numbers" section to ADR 0184 and a related-decision
link in ADR 0103. No new ADR number.

## 7. Stage 2 — the driver records times

Migration, contracts, the cabinet, the readings service and the garage.

### 7.1 Storage (proposal; Q2)

- `vehicle_readings.started_at time NULL`, `ended_at time NULL`, `time_finalized_at timestamptz NULL`.
  CHECK: an end requires a start; all three are null for `no_data`. A start alone is legal while
  the driver records a shift in stages. For a `v3` driver reading, `time_finalized_at` is set only
  by the explicit finish action after the resolved time fields pass the D5 rule. A staff finish can
  set it without times, with the existing edit reason in the reading history. Clearing a required
  time reopens the item and clears finalization. Switching to `no_data` clears its times and points.
- New table `vehicle_reading_points`: `reading_id` (FK, cascade), `position smallint 1..20`,
  `route_point_id uuid NULL` (FK to `vehicle_route_points`, `ON DELETE SET NULL`), `location text`
  (snapshot), `arrived_at time NULL`, `departed_at time NULL`; PK `(reading_id, position)`. Interim
  route stops may lack a departure; at finish, stop 1 needs arrival and every stop needs departure.
  Non-first stops never have arrival. A finished route's scalar start/end are derived from the
  complete points; before finish, `started_at` may hold the first arrival and `ended_at` is null.
- New table `vehicle_reading_point_requests`: `(reading_id, position, request_id)` as its key,
  referencing the reading point and the request. It snapshots the **distinct** request IDs served
  at each stop when its point set is first captured. Later time edits retain the saved associations;
  only an explicit rebase captures a new set. Two trips of one request at one stop give that request
  one share. Stage 3 allocates from this snapshot, not from mutable live roles.
- For a finished route reading the service writes `started_at` = arrival at stop 1 and `ended_at` =
  departure from the last stop in the same transaction, from the same input. `readingColumns`
  handles scalar fields; the same submit transaction replaces child points and request snapshots.
  A route cannot submit independently supplied start/end values that disagree with its points.
- Why a snapshot of the stop: points are rebuilt when a waybill is cancelled and the route
  reassembled (`vehicle_route_points` cascade). The reading must keep what the driver recorded, as
  `driver_daily_report_items` keeps its snapshot of the source. The request-role snapshot is needed
  for the same reason: after a rebuild, live roles no longer say whose work the recorded stop was.

Migration number: next after the maximum at the time (0388 today); check again before `git add`.
Additive only (nullable columns and new tables): old code running during the window ignores them.

### 7.2 Contracts

- `readingValuesSchema` gains optional keys `startedAt`, `endedAt` and `points: [{ position,
  routePointId, arrivedAt?, departedAt? }]` (`routePointId` may be null for a saved historical stop).
  Absent key = keep, explicit `null` = clear for the scalar pair or the whole point set, and an
  array = replace the whole point set — the precedent of the fuel levels (ADR 0163, Р13). A reading
  is sent whole, and an old tab that does not know the keys
  must not erase them. The submit fingerprint is computed after parsing and skips `undefined`, so a
  retried pre-release request keeps its fingerprint. Read and validate the *resolved* saved values
  after applying absent/null/replace, not only the incoming fragment.
- `ReportItemSubmit` gains optional `finishTime` with no schema default: absent means keep the
  existing finish state, `true` finishes after validation, and an explicit staff correction may
  reopen it with a reason. The server persists finalization; the cabinet shows a distinct interim
  save and finish action. No default may appear in a parsed pre-release body, because that would
  change its idempotency fingerprint.
- Time order, in one contract function shared by the cabinet and the server: an ESM-2 end earlier
  than the start is the next day (the shift rule of ADR 0184); departures follow the route order,
  each not earlier than the previous one, with at most one midnight wrap and no more than 24 hours
  from first arrival to last departure. Equal start/end clock times mean zero elapsed time when no
  earlier point established a midnight wrap; an ESM-2 with equal times likewise means zero, never
  an implicit 24-hour shift. Reject malformed `HH:mm`, missing positions and extra points. On first
  capture, compare the submitted point IDs and order with the live route under its lock. After route
  points have been rebuilt, staff may correct times against the **saved** point and request
  snapshot; do not require deleted live
  point IDs or silently replace the original allocation. Moving that historical reading onto a
  new route plan is an explicit rebase with a new snapshot. The portal's check is only a preview.
- `routeTimeByRequest(points, requestIdsByPoint)`: the D6 split, on distinct request IDs at each
  stop. Use exact integer seconds and distribute any indivisible remainder by stable request-ID
  order; then per-request raw totals add exactly to the route duration. Round only the displayed or
  billed hours, after summing each request. A stop without a request association is unresolved and
  blocks automatic allocation instead of dropping its time.
- `DriverAssignmentPoint` gains its route point `id` (today it has `position` only).

### 7.3 Requiredness (D5)

Checked in the readings service by actor, like `assertNoDataIsStaffOnly`: a driver's **finish** of
a `values` reading of an `esm2` item needs `startedAt` and `endedAt`; of a `route` item with stops
it needs arrival at stop 1 and every departure. An interim submit may carry a start or some point
times while the shift is underway. This applies to each submitted item, not every expected item in
the day: partial reports are legal. A relocation and a `no_data` reading need none. Staff may
finish on the driver's behalf without times, recording a reason. For `v3` reports the acceptance
door refuses an unfinished submitted item; the garage marks it incomplete and the ordinary overdue
signal remains. Stage 2 also marks an unfinished `v3` reading non-clean in the stage 1 shift reader,
so the site cannot sign its interim counter as a complete driver day. Readings submitted before the
release stay without times; nothing is backfilled.

Compatibility gate: add `driver_daily_reports.draft_format` with default `v2`. Rows opened by old
code during the migration/restart window and all existing rows remain `v2`; new code opens `v3`.
The `v3` time rule applies to `v3` reports. An already-open `v2` report may finish through the
legacy submit path; a `v3` open of an untouched `v2` draft may upgrade it explicitly, bumping its
version so an old tab receives a conflict. Keep the existing idempotency check ahead of new
requiredness, so a lost response to a pre-release submit still replays. These exceptions end with
the old reports; do not infer the format from the current client alone.

### 7.4 The cabinet

- Variant A or B (Q1); both share the server contract above.
- The local draft gains the new fields: `DRIVER_DRAFT_FORMAT` becomes `v3`, and a new `v3` open
  requires that header.
- Today only `POST /driver/reports/:date/open` checks the draft format. The submit door also checks
  format against the stored report format: a `v3` report needs `v3`, while an already-open `v2`
  report can finish and replay with `v2`. Do not put an unconditional `v3` guard ahead of the
  idempotency lookup: it would break retries of an accepted pre-release request.

### 7.5 Readers

- Garage journal (`loadVehicleReadingJournal`): shift time, stop times and the unfinished-time mark
  per row, including an explicit legacy indication for `v2` readings without times.
- Intake registry and the readings book (`readings-admin-export.ts`): start, end, duration columns.
- Staff entry in the garage: the same fields, optional.
- Content version: times are content — an edit after acceptance moves the report to
  `needs_reacceptance`, as any number does. Include scalar times, point rows and request snapshots
  in `readingSnapshot`, change detection, audit history and report content version. An edit that
  changes only time must be observable and must require reacceptance.
- Tests: a new `v3` report accepts an interim reading but its finish rejects missing driver time;
  interim readings cannot be accepted or signed from the reading; old `v2` report can finish and
  replay after release; a new `v3` open upgrades only an untouched `v2` draft; a time-only edit
  reopens acceptance; midnight and equal times follow one
  rule; duplicate roles of one request get one share; an indivisible split sums exactly; a route
  rebuild leaves point times and request attribution intact and still permits staff correction.

### 7.6 Records

A new ADR "Driver shift and stop times" (number taken at the time: 0234 today, check again).

## 8. Stage 3 — times reach the requests

No migration.

- **Shift time of a special-equipment day.** The effective day (§6.3) takes `startedAt/endedAt` from
  the driver: an ESM-2 item's times, a linear route item's arrival at stop 1 and departure from the
  last stop. Use them only when the driver day is clean and the time pair is complete; otherwise
  keep the site time or show empty. Signed times stay frozen. Several readings on one request day
  need a single unambiguous interval: take the earliest start and
  latest end only when their unfolded date-times fit the ordered day and one midnight wrap; otherwise
  show the intervals separately and require a manual site time rather than fabricate one interval.
- **Freight request.** The card gets a "Факт по точкам" block — arrival and departures at the stops
  of this request — and "время по заявке", the D6 sum over the route's stops where the request has a
  role. Server-side: one reader over the recorded point and request snapshots, calling
  `routeTimeByRequest`. The live `vehicle_route_point_trips` supply the snapshot when times are
  submitted, never historical allocation after a route rebuild.
- **Completion prefill (D7).** The closing window of a freight request proposes unit "hours" and that
  sum, rounded to two decimals (Q7); the dispatcher may change it. No times, an unfinished `v3`
  reading, an incomplete legacy reading, a `no_data` reading or an unresolved allocation — no
  prefill, and the window says why.

## 9. Stage 4 — remaining readers (open)

- Summary book (`analytics/facts-vehicle.ts`) builds shift atoms from shift rows: a driver-only day
  is absent, an unsigned day carries the site's superseded hours. Switching it to the effective day
  changes report numbers (Q3).
- Garage occupancy (`garage.ts`, "day filled / signed") counts rows only (Q4).
- The free-text `refuel` stays for rented vehicles; for own ones it becomes a display of liters (Q5).

## 10. Release and compatibility

| Stage | Migration | Main portal floor | Driver cabinet    | Notes                                                                                                                                                                           |
| ----- | --------- | ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | no        | no                | no                | no behavior change                                                                                                                                                              |
| 1     | no        | no                | no                | an old tab cannot approve a driver-only day; if its site row is overlaid by driver data, approval or save returns 409 and asks for refresh; a new portal on an old server falls back to `filledAt` |
| 2     | additive  | no                | draft format `v3` | `v2` reports opened before the release finish or replay under the stored format; new reports require `v3`, and their finish action requires times                                |
| 3     | no        | no                | no                | completion prefill is a portal default, the server does not require it                                                                                                          |

Stages ship separately; stage 1 does not wait for stage 2.

## 11. Order of work

Each stage is its own session and commit series, per [agent-sessions.md](agent-sessions.md): stage 0
and 1 together (one release), then stage 2 after Q1 and Q2 are closed, then stage 3 after Q7 is
closed. Stage 4 only after Q3–Q5. Q6 is a request to reconsider D3, not a hidden gate for stage 1;
D3 remains the adopted rule unless the owner changes it.

## 12. Open questions

- **Q1.** Driver cabinet: variant A (time fields inside the existing groups) or B (stamp buttons by
  the course of the day, manual entry as a fallback)? Canvas linked at the top.
- **Q2.** Stage 2 storage: start/end columns kept for every reading (a derived copy for routes,
  written in the same transaction as points) — proposed — or derived on read from the points table?
  The role snapshot and legacy-report compatibility gate in §7.1–§7.3 are required with either
  choice.
- **Q3.** Should the summary book switch to the effective day? It changes the numbers of unsigned
  days and adds driver-only days.
- **Q4.** Should the garage occupancy view count a driver-only day as filled?
- **Q5.** Free-text refuelling for own vehicles: keep editable, or show the driver's liters only?
- **Q6.** D3 makes every day after a day without a reading a manual one. Acceptable, or should the
  one-click rule follow the garage's continuity (expected shifts) instead?
- **Q7.** Rounding of freight hours in the completion: two decimals, quarter hours, or whole hours?

## 13. Out of scope

- A cabinet for a lessor's operator: rented vehicles keep the manual shift.
- Two shifts per day in the shift table (ADR 0184, survey S-8 keeps one row per day).
- Fuel consumption by time; norms stay per km or per engine hour ([ADR 0194](adr/0194-fuel-norms.md)).

## 14. Review convergence

The implementation review is bounded to three passes over each stage. A pass checks source links,
write doors and concurrency, compatibility across migration and restart, request attribution,
reader coverage and the stated tests. Record each critical finding with its code or ADR evidence,
change the plan, then recheck the changed clauses and their dependent stages. Stop when a pass finds
no critical finding. If the same issue recurs or a third pass still finds a blocker, stop that
stage, keep the blocker explicit and seek the missing product decision or evidence; do not repeat
the same review indefinitely. The open questions that are stage gates are named in §11; none is
silently chosen for the owner.
