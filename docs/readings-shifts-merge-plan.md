# Readings and hours: one source for a day's work

Status: proposal for correction, 27 October 2026. Nothing is implemented. The owner closed the forks
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

**A measured fact lives once — in the reading.** Counters, refuelling and, after stage 2, times are
the driver's (or staff's) reading of an own vehicle. Nothing copies them.

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
- **D5. Times are mandatory for a driver**, optional for staff entering on a driver's behalf; a
  `no_data` reading needs none.
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
2. One shift-row reader. `vehicle-request-days.ts` has its own `shiftsOfRequest` with its own
   `hours()`/`timeOnly()` copies; it switches to `loadRequestShifts` of
   `vehicle-request-shifts.ts`. After stage 1 that reader returns the effective day, and the linear
   days table must show the same numbers as the shift table.
3. `shiftsOfRequest` callers that need rows only (term refusal in `assignment-shifts.ts`) keep
   reading rows: they decide by "the site wrote something", not by the effective day (§6.6).

## 6. Stage 1 — request shifts read driver readings

No migration. Contracts, one server reader, the approval door, the shift window and the card tab.

### 6.1 Which readings belong to a request day

For request `R` (special equipment) and day `D`: report items with `report_date = D` in a report whose
state is in `SUBMITTED_REPORT_STATES`, and

- `source_kind = 'esm2'` and the waybill's `source_request_id = R`, or
- `source_kind = 'route'` and `vehicle_route_requests` has `(route_id, request_id = R, work_date = D)`.

Both branches, not only the expected one. The garage suppresses a day route when a weekly ESM-2
covers the same day (`EXPECTED_ROUTE_FILTER`), but a report composed before the suppression may still
hold the route item, and its reading is still the vehicle's work for this request.

Several items on one day (a vehicle swapped mid-day, two items of one vehicle) sum; that matches
ADR 0184's "one row per day with the summed hours".

### 6.2 The driver's day numbers and when they are clean

Per item: hours = `engine_hours − previous.engine_hours` when the reading is `values`, both numbers
exist and the engine-hour anomaly is not `counter_reset`. Refuelling = `fuel_filled_liters`.

The day is **clean** when every item has hours, every predecessor snapshot is from `D` or `D − 1`,
and the day's sum lies in `0..MAX_MACHINE_HOURS`. Otherwise the day carries the sum it has, the
oldest predecessor date (`since`) and, for `no_data`, the reason; it never replaces the site's
numbers.

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

The refuelling text from the driver is `"<liters> л"`; no liters means "not refuelled" (`''`), as the
readings module reads an empty refuel.

### 6.4 Contracts

- `VehicleRequestShiftDto` gains `source?: 'site' | 'driver' | null` and
  `driver?: ShiftDriverDayDto | null` with `machineHours | null`, `refuelLiters | null`, `clean`,
  `since | null`, `noDataReason`, `comment`, `driverNames`, `reportStates`. Both optional: a portal
  newer than the server falls back to `filledAt ? 'site' : null`.
- `shiftSourceOf(shift)` — that fallback, in one place; `isShiftFilled(shift)` = a source exists.
  The approve checkbox, the "not filled" tag and `unapprovedPastShiftDays` ask it instead of
  `filledAt`.
- `refuelLabel(liters)` — the one way a driver's liters become the refuel text.

### 6.5 Server

- `loadDriverShiftDays(reader, requestId, term)` in a new `services/shift-driver-days.ts`: one query
  over items, reports, readings, the predecessor reading and both source branches; returns a map by
  day. Hours are computed from the existing chain (`previous_engine_hours_id`), never by searching
  for "the nearest earlier row" again.
- `loadRequestShifts` merges rows and driver days by §6.3. All existing callers get the effective day.
- **Approval door** (`POST /:id/shifts/:date/approval`, approve): under the same locks, when the day
  is `driver`, upsert the row from the effective numbers (keeping the row's time and comment), then
  sign. Zero hours need a comment (the existing CHECK and rule): the row's comment, else the driver's
  reading comment, else 422 asking for one. A day that is neither a row nor clean keeps the old 422.
  Revoking is unchanged.
- **Save door**: unchanged. On a `driver` day the portal sends the driver's numbers (its inputs are
  locked); a different number from an old tab is stored and overridden on read by D4.
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
  A non-clean driver day prefills the form with the driver's sum when it fits `0..24`.
- The linear days table shows the effective hours through the stage 0 reader.

### 6.8 Tests

- Contracts: `shiftSourceOf`, `isShiftFilled`, `refuelLabel`.
- DB (`vehicle-request-shifts.db.test.ts` or a new `shift-driver-days.db.test.ts`): ESM-2 reading →
  day `driver`; route item of a day route → day `driver`; predecessor two days back → not clean with
  `since`; `counter_reset` → not clean; `voided` report → ignored; unsigned site row replaced; signed
  row frozen with a difference; approve on a driver day writes the row and signs; zero hours without
  any comment → 422; term edit not refused by a driver-only day.
- Web: `vehicle-shifts-modal.test.tsx` (locked inputs, approve enabled), `vehicle-shifts-tab.test.tsx`.

### 6.9 Records

A section in ADR 0184 ("Driver readings as the day's numbers", dated), and the "Изменён:" line of
ADR 0184 / a "Связано" note in ADR 0103. No new ADR number.

## 7. Stage 2 — the driver records times

Migration, contracts, the cabinet, the readings service and the garage.

### 7.1 Storage (proposal; Q2)

- `vehicle_readings.started_at time NULL`, `ended_at time NULL`. CHECK: both or neither; both null
  for `no_data`.
- New table `vehicle_reading_points`: `reading_id` (FK, cascade), `position smallint 1..20`,
  `route_point_id uuid NULL` (FK to `vehicle_route_points`, `ON DELETE SET NULL`), `location text`
  (snapshot), `arrived_at time NULL`, `departed_at time NOT NULL`; PK `(reading_id, position)`; CHECK
  `(position = 1) = (arrived_at IS NOT NULL)`.
- For a route reading the service writes `started_at` = arrival at stop 1 and `ended_at` = departure
  from the last stop in the same transaction, from the same input. One write path
  (`readingColumns`), so every reader of "shift time" reads two columns whatever the source.
- Why a snapshot of the stop: points are rebuilt when a waybill is cancelled and the route
  reassembled (`vehicle_route_points` cascade). The reading must keep what the driver recorded, as
  `driver_daily_report_items` keeps its snapshot of the source.

Migration number: next after the maximum at the time (0388 today); check again before `git add`.
Additive only (nullable columns, a new table): old code running during the window ignores both.

### 7.2 Contracts

- `readingValuesSchema` gains optional keys `startedAt`, `endedAt` and `points: [{ position,
routePointId, arrivedAt?, departedAt }]`. Absent key = keep, `null` = clear — the precedent of the
  fuel levels (ADR 0163, Р13): a reading is sent whole, and an old tab that does not know the keys
  must not erase them. The submit fingerprint is computed after parsing and skips `undefined`, so a
  retried pre-release request keeps its fingerprint.
- Time order, in one contract function shared by the cabinet and the server: an ESM-2 end earlier
  than the start is the next day (the shift rule of ADR 0184); departures follow the route order,
  each not earlier than the previous one, with at most one midnight wrap.
- `routeTimeByRequest(points, roles)`: the D6 split, minutes per request. The cabinet shows it
  live, stage 3 uses it on the server — one rule.
- `DriverAssignmentPoint` gains its route point `id` (today it has `position` only).

### 7.3 Requiredness (D5)

Checked in the readings service by actor, like `assertNoDataIsStaffOnly`: a driver's `values`
reading of an `esm2` item needs `startedAt` and `endedAt`; of a `route` item with stops — the arrival
at stop 1 and every departure; a relocation and a `no_data` reading need none. Staff may leave them
empty. Readings submitted before the release stay without times; nothing is backfilled.

### 7.4 The cabinet

- Variant A or B (Q1); both share the server contract above.
- The local draft gains the new fields: `DRIVER_DRAFT_FORMAT` becomes `v3`, so an old build is told
  to update instead of writing a draft the server cannot read.
- Today only `POST /driver/reports/:date/open` checks the draft format. A tab that opened the day
  before the release would submit without times and meet the D5 refusal as a bare error. The submit
  door gets the same `assertDraftFormat` check.

### 7.5 Readers

- Garage journal (`loadVehicleReadingJournal`): shift time and stop times per row.
- Intake registry and the readings book (`readings-admin-export.ts`): start, end, duration columns.
- Staff entry in the garage: the same fields, optional.
- Content version: times are content — an edit after acceptance moves the report to
  `needs_reacceptance`, as any number does.

### 7.6 Records

A new ADR "Driver shift and stop times" (number taken at the time: 0234 today, check again).

## 8. Stage 3 — times reach the requests

No migration.

- **Shift time of a special-equipment day.** The effective day (§6.3) takes `startedAt/endedAt` from
  the driver: an ESM-2 item's times, a linear route item's arrival at stop 1 and departure from the
  last stop. Same rule as the numbers: they replace unsigned site times, signed ones stay.
- **Freight request.** The card gets a "Факт по точкам" block — arrival and departures at the stops
  of this request — and "время по заявке", the D6 sum over the route's stops where the request has a
  role (`vehicle_route_point_trips`). Server-side: one reader over the route's reading points and
  roles, calling `routeTimeByRequest`.
- **Completion prefill (D7).** The closing window of a freight request proposes unit "hours" and that
  sum, rounded to two decimals (Q7); the dispatcher may change it. No times or a `no_data` reading —
  no prefill, and the window says why.

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
| 1     | no        | no                | no                | an old tab keeps the approve checkbox disabled on a day without a row (`!filledAt`), so it never sends the new approval; a new portal on an old server falls back to `filledAt` |
| 2     | additive  | no                | draft format `v3` | the submit door starts checking the format                                                                                                                                      |
| 3     | no        | no                | no                | completion prefill is a portal default, the server does not require it                                                                                                          |

Stages ship separately; stage 1 does not wait for stage 2.

## 11. Order of work

Each stage is its own session and commit series, per [agent-sessions.md](agent-sessions.md): stage 0
and 1 together (one release), then stage 2 after Q1 and Q2 are closed, then stage 3. Stage 4 only
after Q3–Q5.

## 12. Open questions

- **Q1.** Driver cabinet: variant A (time fields inside the existing groups) or B (stamp buttons by
  the course of the day, manual entry as a fallback)? Canvas linked at the top.
- **Q2.** Stage 2 storage: start/end columns kept for every reading (a derived copy for routes,
  written by one path) — proposed — or derived on read from the points table?
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
