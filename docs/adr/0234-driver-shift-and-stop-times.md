# ADR 0234. Driver shift and stop times

- Статус: Принято (27.10.2026); server side, contracts, migration, the driver cabinet and the
  garage screens implemented
- Домены: гараж, кабинет-водителя, заказ-тс
- Изменяет: [ADR 0103](0103-vehicle-readings.md) — decision 3 said a reading has no entered time;
  a reading now carries the driver's shift time and, on a route, the stop times. Shift order is
  still `shift_order`, not these times; [ADR 0129](0129-driver-cabinet-readings-first.md) —
  decision 8: the current draft format is `v3`, and the submit door now checks the declared format
  against the report's stored format
- Развивает: [ADR 0163](0163-vehicle-readings-fuel-levels.md) — the wire contract of decision 7
  (absent key keeps, `null` clears) covers the time keys, and the evening-values signal of the
  cabinet (plan Р8) becomes the moment the end time is required
- Связано: [ADR 0184](0184-vehicle-request-shifts.md) (`shiftSpanHours`, the one reading of a
  start/end pair), plan [readings-shifts-merge-plan.md](../readings-shifts-merge-plan.md) §7 and
  owner decisions D5, D6, D8, D11, Q2
- Область: [migration](../../apps/api/drizzle/0389_vehicle_reading_times.sql),
  [schema](../../apps/api/src/db/schema.ts) (`vehicleReadings`, `vehicleReadingPoints`,
  `vehicleReadingPointRequests`, `driverDailyReports.draftFormat`),
  [time rules](../../packages/contracts/src/reading-times.ts),
  [reading contract](../../packages/contracts/src/vehicle-readings.ts),
  [cabinet contract](../../packages/contracts/src/driver-cabinet.ts),
  [write path](../../apps/api/src/services/readings.ts),
  [times store](../../apps/api/src/services/reading-times.ts),
  [stops of a task](../../apps/api/src/services/driver-assignment.ts),
  [cabinet routes](../../apps/api/src/routes/driver.ts),
  [journal](../../apps/api/src/services/readings-stats.ts),
  [intake registry](../../apps/api/src/services/readings-intake.ts),
  [readings book](../../apps/api/src/services/readings-admin-export.ts),
  [tests](../../apps/api/test/reading-times.db.test.ts),
  [rule tests](../../apps/api/test/reading-times-contracts.test.ts),
  [cabinet fields](../../apps/web/src/pages/driver/DriverReadingFields.tsx),
  [cabinet route block](../../apps/web/src/pages/driver/DriverRouteTimes.tsx),
  [cabinet rule preview](../../apps/web/src/pages/driver/readingsTimes.ts),
  [cabinet stops](../../apps/web/src/pages/driver/readingStops.ts),
  [cabinet draft of older formats](../../apps/web/src/pages/driver/draftLegacy.ts),
  [garage journal](../../apps/web/src/pages/garage/journalTimes.tsx),
  [garage staff entry](../../apps/web/src/pages/garage/IntakeTimeFields.tsx),
  [cabinet tests](../../apps/web/test/driver-reading-times.test.tsx)

## Context

A driver's reading held counters and fuel, but not when the shift ran. The site typed the same
day's time into the shift table of the request by hand, and a freight request had no actual time
at all: only the dispatcher's planned arrival at a stop. Stage 2 of the merge plan asks the driver
for the times, so that stage 3 can show them in the request and split a route's time between the
requests it served.

Three things make this more than two columns. A route is not one interval: it is a sequence of
stops, and its time belongs to different requests at different stops. A route's points are
rebuilt when a waybill is cancelled, so whatever the driver recorded must outlive them. And the
day is submitted in parts (ADR 0163): fuel in the morning, counters in the evening.

## Decisions

1. **Where the times live (Q2).** Every reading has a scalar pair `started_at` / `ended_at`
   (`time`; the day is `report_date`). An ESM-2 item types it. A route item records its stops in
   `vehicle_reading_points` — an address snapshot, the live point reference and the actual times —
   and the service derives the pair from them in the same transaction: the start is the arrival
   at stop 1, the end is the departure from the last stop once every stop has one. A typed pair on
   a route that disagrees with its stops is refused. A relocation records no time (D8), and
   `no_data` clears times and stops with the numbers. A CHECK keeps "end requires start" and "no
   time on `no_data`".

2. **Whose work a stop was.** At the first capture the stop set is compared with the live route
   under the route lock the submit already takes (`lockSources`), and the distinct served request
   ids of every stop are written to `vehicle_reading_point_requests`. Two trips of one request at
   one stop are one share. "Served" is one rule for the task and for the capture
   (`servedRequests`: live and not cancelled), because the cabinet sends back exactly the stops it
   showed. Later edits address the saved stops by position and keep the snapshot; after a rebuild
   (`route_point_id` set to NULL) staff still correct the recorded times. Moving a reading onto a
   new plan is explicit: clear the stops, then capture them again.

3. **"Finished" is derived from the evening values (D11).** There is no finish button, flag or
   column. A driver's `values` submit of an ESM-2 item carries the start time, of a route item
   with stops the arrival at stop 1; a submit that carries any end-of-shift value — odometer,
   engine hours or end fuel — also carries the end time or every departure. The driver's ESM-2
   pair may not have equal start and end. Staff may leave every time empty (D5), a relocation and
   `no_data` need none. The rule is written once (`driverReadingTimeIssues`) and the service applies
   it by actor, by the report's stored format and only to a line the driver authors in this
   submit — a new reading or one whose content changes (`lineRequiresDriverTimes`, the predicate
   the cabinet previews with); the acceptance door is unchanged. A line resent unchanged is not
   judged: the cabinet sends back every block with a reading, and a staff entry without times or a
   reading a rebase moved into the day would otherwise hold the driver's whole day until he made up
   times for a row he never wrote. Shape and order (`readingTimeIssues`) apply to every line.

4. **One reading of time.** A start/end pair is read by `shiftSpanMinutes` only (equal times are
   24 h; `shiftSpanHours` is its rounding for the site's window). A route's elapsed time is the sum
   of its consecutive steps: an equal next time is a zero step, a smaller one is the single allowed
   midnight wrap, and the whole route fits in 24 h. The D6 split (`routeTimeByRequest`) works in
   integer seconds and hands an indivisible remainder out by ascending request id, so the shares add
   up exactly to the shift.

5. **Wire compatibility.** `startedAt`, `endedAt` and `points` are optional without defaults: an
   absent key keeps, `null` clears, an array replaces the whole stop set. A body from a build that
   does not know them parses to the same object as before, so its idempotency fingerprint is
   unchanged and a lost pre-release response still replays. The rules read the resolved values,
   not the incoming fragment.

6. **The format gate.** `driver_daily_reports.draft_format` defaults to `v2`, which is what every
   existing report and every report opened by old code during the migration window gets. New code
   opens `v3`, and only a `v3` report applies decision 3. A new report is opened only by a `v3`
   build; a `v2` build may reopen a report that is itself `v2` (the old cabinet calls open on every
   entry to the form) and is refused on anything else. A driver's `v3` open of an untouched `v2`
   draft upgrades it and moves its version, so an old tab gets a conflict. The submit door passes the declared format to the service, which checks it
   against the stored format after the idempotency lookup: a `v3` report takes only a `v3` build,
   a `v2` report finishes and replays from the build that opened it. Staff opening a day do not
   upgrade it: the garage form has no draft format.

7. **Times are content.** Scalar times, stops and the request snapshot are part of the reading's
   snapshot, change detection and history, so a time-only edit raises `content_version` and moves
   an accepted report to `needs_reacceptance`. The vehicle journal, the intake registry and the
   readings book carry the times; the book adds start, end and duration columns.

8. **The cabinet (D9: variant A with a "now" button).** The ESM-2 pair stands in the existing
   groups — «Время начала» opens «Начало смены», «Время окончания» opens «Конец смены» with the
   duration by `shiftSpanMinutes`. A route item gets «Маршрут — время по факту» above the counters:
   its stops in route order with what is done there and the planned time, an arrival and a
   departure at stop 1 and a departure at every other stop, and a live «Время по заявкам» computed
   by `routeTimeByRequest`. Every time field has «сейчас», which writes the device's current time
   into the draft like a keystroke; there is no "shift running" state. The stops shown and sent
   back are the reading's saved stops once it has them, otherwise the live stops the server names
   on the report item (`ReportItemDto.stops`, read by `loadReadingStops` — the same answer the time
   rule asks through `routeHasStops`). The task only lends a stop its actions and planned time: it
   drops a route without a valid waybill or under a weekly ESM-2 that a submitted report still
   holds, and a form built from it would have no field for the arrival the server requires. The
   cabinet previews decision 3 with the same contract functions, by the report's stored format and
   per line (`lineRequiresDriverTimes`, a block compared with its saved reading as the service
   compares content), so its refusals stand under the fields before the day leaves the phone. The
   task carries no request id, so the preview keys a request by its label («ТС-40» of «ТС-40/2»);
   the server's split reads the snapshot by id.

9. **The local draft moved to `v3` under its own prefix** (`technic:driver-draft-v3:`), for the
   reason ADR 0129 gave `v2` one: a `v2` build still open in a tab normalizes every branch it
   reads without the time keys and consolidates it back with the original clocks, so a shared
   prefix would let its copy tie with ours and erase typed times. `v2` branches are read-only here.
   A `v2` row is addressed by the source key, as `v3` is: when `v3` holds nothing for that key the
   row is taken over, its mark journaled in the same branch write; when `v3` already holds it, the
   `v2` row is a later edit in an old tab and is shown as an unmatched record for the person to
   place. The submit door receives the draft format too, so a build that declares nothing is
   refused on a `v3` report.

## Consequences

- Readings submitted before the release keep NULL times: "not asked", not "unknown". Nothing is
  backfilled. The journal row carries the report's `draftFormat`, so a `v2` reading without times
  reads as legacy rather than as a skipped field.
- A time alone does not make a `values` reading: the five-number rule of ADR 0163 stands, and a
  driver of a vehicle without a fuel gauge records the start together with the evening counters.
- The request reference of the snapshot cascades: a purge of an archived request
  (`directory-purge.ts`) must not fail on a historical reading, and the share of a request that no
  longer exists has no reader. A stop left without requests is reported as unresolved by the
  split instead of dropping its time.
- Old code that switches a reading carrying times to `no_data` during a rollback fails on the
  CHECK instead of keeping a time on a shift closed without values.
- Stage 3 allocates from the snapshot only, never from live roles.
- Staff correct the times of a route reading's saved stops; the garage form does not capture a
  first stop set, although the report item now names the live stops. A route reading entered by
  staff without stops stays without stop times until the driver captures them.

## Rejected

- **An explicit finish action** with `time_finalized_at`, a `finishTime` flag and an acceptance
  refusal (plan §7.1–§7.3 as first written). Superseded by D11: the evening values already say the
  shift ended, and a morning-only reading has no engine hours, so it is non-clean for stage 1
  anyway.
- **Deriving the pair on read from the stops.** Every reader of a pair would need the stops, and
  the ESM-2 pair has no stops to derive from (Q2).
- **A RESTRICT request reference.** It would make the purge of an archived request fail on a
  reading recorded months earlier.
