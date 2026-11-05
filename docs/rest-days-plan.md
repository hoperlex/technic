# Rest days: Sunday by default, a working Sunday by mark, «Не работал» for the rest

Status: plan, revision 4 of 03.11.2026. Stage 1A (compatible readers, `v4` draft, client contract
8, idle writes closed) is implemented in [ADR 0244](adr/0244-idle-shift-reading.md); stages 2–4
(working Sunday, day batch, rental cut) in [ADR 0246](adr/0246-working-sunday-mark.md), release
0.1.138.0246. Stage 1B (idle writes open, `REQUIRED_CLIENT_FLOOR = 8`) waits for 1A to be served and
the floor operation `deploy-auto --client-floor=8`.

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
- **D7. The site's sign-off stays as it is:** every day of the term is signed; unworked Sundays and
  «Не работал» days have zero hours, a worked Sunday has its actual hours.
- **D8. The rental cut follows D1:** the new order starts on the first day of the next month that is
  not a Sunday.

## 3. One rule for "is this shift asked for"

A shift of a source on a day is asked for unless it is a **rest-day shift**: the day is a Sunday,
the source represents calendar site work, and none of its served requests has a working mark for
that day. A trip — a freight row, a delivery, a pickup — is always asked for. A rest-day shift with
a reading in it is counted like any other. The existing source-selection rule still applies:
an ESM-2 covering a site-day route of the same request, vehicle and date suppresses that route's
expectation and cabinet block (ADR 0207); the working mark must reach the surviving source.

The rule stays in `restDayShiftSql` / `restDayExemptSql` and the TypeScript twin `isRestDayShift` in
[readings-expected.ts](../apps/api/src/services/readings-expected.ts). Stage 2 must widen the SQL
source context (day, route id, waybill id/request id) and update **every caller**; today's
`restDayShiftSql(day, routeId)` cannot identify an ESM-2 request when `routeId` is null.
The affected readers are the relation, «не сданы», «источник пропущен», day state, driver schedule,
counter continuity and maintenance tail. The cabinet's route and ESM-2 queries must load the same
request/coverage context and marks before computing `readingOptional`; the portal holds no weekday
or mark-resolution rule (`restDay.ts` stays dependency-free).

Request membership is explicit:

- an ESM-2 has its `source_request_id`;
- a site-day route has **all served** composition requests whose `work_date` equals the day,
  using `servedRequestSql` (archived and cancelled requests do not contribute); **any** member's
  working mark makes the route required;
- if the existing ESM-2 coverage rule suppresses that route, its Sunday demand (a working mark
  from any served member, or an actual trip) also reaches each surviving ESM-2 that covers it.
  Example: route A+B, ESM-2 for A, only B marked — the one surviving ESM-2 is required, and the route
  stays suppressed. Do not create a second expectation or a second cabinet block to carry a mark.

The SQL and cabinet paths must share this mapping's semantics and have matching tests, including
a shared route, a suppressed route, and an archived/cancelled marked member.

The same **coverage context** is needed by intake on **every weekday**, starting in stage 1:
a surviving ESM-2 carries the trip classification and served-request membership of routes it
suppresses for that vehicle/day. Idle warnings must check those routes for trips and all their
served requests for nonzero signed hours, even if the ESM-2's own request has none. Stage 2 reuses
this context for working marks and Sunday demand. This adds diagnostic context without copying
readings or hours between requests or changing the request-day attribution of `shift-driver-days`.

## 4. «Не работал»

### 4.1 In the ledger

- A new reading kind **`idle`** next to `values` and `no_data`, and a column `idle_reason`
  (`day_off`, `site_idle`, `repair`, `other`) with the text in the existing comment, required for
  `other`. The values check of `vehicle_readings` gains the `idle` branch: no numbers, no times,
  no `no_data_reason`; `idle_reason` is required only for `idle` and null for the other kinds.
- Meaning, written into the kind's comment: **the vehicle did not work this shift.** Not
  `no_data` («работали, но снять нечего»): an `idle` shift is not a missing reading, consumes no fuel,
  has zero engine hours, and is transparent to the counter chain.
- **Counter continuity** (`counterPairBrokenSql`, Р13а/Р13б): an `idle` row closes its expectation
  only when aligned with that live source and day. Only such an aligned idle is transparent to
  the pair; a missing or misaligned shift still breaks it under the existing rule.
- **Previous-shift snapshot** (ADR 0237, decision 4): skips `idle` rows, so the next shift's fuel
  start is compared with the last real end, not with "nothing". The cabinet's **local**
  `previousOfItem` also skips earlier idle blocks, even when their hidden draft fields keep numbers.
- **Fleet months:** `idle` counts as a closed shift, never in `missingReadings`; a separate number
  `idleShifts` so data quality does not read a holiday as work.
- **Request shifts** (`shift-driver-days.ts`): an `idle` day gives the driver's day `machineHours: 0`,
  `refuelLiters: 0`, with no driver time. An idle reading contributes zero to a mixed day; numeric
  readings retain their own checks and deltas. Idle bypasses missing-counter/first-snapshot/gap
  checks for that reading, but retains unresolved vehicle/date/source-state discrepancy guards.
  A day is clean only if every contributing reading passes its checks. **Site sign-off stays as it
  is (D7):** a zero-hour day still needs the site's own nonempty comment, then its signature.
  Do not promise unconditional one-click approval or copy the driver's private reason/comment into
  the site's public row or history (ADR 0184, `driverDayComment`). Signed days remain snapshots;
  a later idle submission shows a difference and never rewrites a signature.
- **Maintenance tail:** an aligned idle closes the work expectation without a new numerical
  snapshot. `loadLastExpectedShiftDays` must exclude these closed idle shifts from the unresolved
  tail; several trailing idle days must not set `lowerBound`. Missing/misaligned shifts still do.
- **Exports and the readings report:** the row says «Не работал: <причина>».

### 4.2 In the cabinet

- A block is still **one source/shift**, labelled with its vehicle and source, not a vehicle-day
  command. Two vehicles can be answered independently; two shifts of the same vehicle can be
  `idle` and `values`. No reading is created without an existing report item/source.
- The block gets a switch «Не работал». On: the number and time fields hide, a reason select
  appears, the whole-shift completeness (ADR 0237) does not apply; the block leaves as `idle`. Off:
  the fields come back with whatever was typed.
- Allowed on any day, rest day or not, and on a trip too (a planned trip that did not happen is a
  real answer; the garage sees it, §4.3).
- The day line: a day whose blocks are all `idle` reads «Передано · Не работал». The debt line
  needs nothing: a submitted day is no debt.
- **Draft `v4`, with a distinct prefix**, carries `idle` and `idleReason`. An old `v3` tab drops
  unknown fields while consolidating with the original clocks (`draftMerge.ts` / `draftStore.ts`);
  retained numbers/times can then be resent as `values`. A client floor does not protect local
  storage from an old offline tab. Adopt older formats as read-only input, with the existing
  once-only adoption/tombstone and cross-tab rules; never write `v4` into a `v3` prefix. Preserve
  idempotency keys/bodies of outstanding attempts so an upgrade cannot turn a retry into a new
  submit. This is the **local storage** version; the server report's `draft_format` stays `v3`
  (its time-validation corridor), and `idle` is explicitly exempt from numeric/time completeness.
- All reading serializers and equality/change checks must handle `idle` intentionally, including
  existing saved idle rows when the driver sends another block. An unchanged idle block must not
  hold that submission; a change of kind is a real edit, with normal versioning and histories.
- Changing `values`/`no_data` to `idle` clears stored counters, fuel, scalar times, stop-time rows,
  anomaly confirmations and the old reason in the same transaction; the normal chain rebuild
  updates successors. Hidden input is only a local draft convenience and never enters the ledger.
- Staff entering a reading for a driver (`IntakeReadingForm`) get the same kind and list.

### 4.3 In the garage intake (D5)

An `idle` row is a closed shift. Green, batch-acceptable, unless one of these marks stands (yellow,
single acceptance, one line each):

1. **a working mark** stood on that Sunday — «на этот день стояла рабочая смена»;
2. **the source or a route it suppresses represents a trip** — «назначен рейс, водитель отметил:
   не работал»;
3. **the site signed nonzero hours** for any served request in the source's coverage context on
   that day — «объект подписал N ч»;
4. **another reading of the same vehicle that day has numbers** (a substitute drove it) — «машина в
   этот день работала: <источник>».

These are additional warnings, not a replacement for existing missing-source/alignment/anomaly
diagnostics; a red source discrepancy stays red. Warnings 1–3 use the coverage context of §3,
including suppressed routes and their served requests; retain the concrete request/route labels
in their explanation. Contradiction 4 uses submitted, non-voided
numeric readings of that vehicle/day. No new acceptance blocker: a yellow row remains singly
acceptable, as with `shift_tail_missing`; any warning removes the **whole report** from batch
eligibility. Recompute these live checks on reads and acceptance, including batch acceptance,
rather than trusting the page's colour. Marks 2–4 need only stage 1; mark 1 comes with stage 2.

## 5. Stages

Each shipped block has its ADR and entry in «Обновления» (ADR 0077), pushed with the release
migration, raised `VERSION` and annotated version tag (ADR 0191). Stage 1 requires a compatibility
release before activation, following ADR 0226. Migrations and permissions are never automatic
(`pnpm maintain surfaces`).

1. **«Не работал»** (§4), in two releases:
   - **1A, compatibility:** migration A adds the enum value alone; migration B adds `idle_reason`
     and checks. The runner commits each file separately, so B may use the new enum value.
     All contracts, SQL readers, serializers, garage/cabinet/staff forms and local `v4` storage
     understand and preserve `idle`; the portal's client contract rises from the current 7 to the
     next free value N (recheck at implementation). Server writes of `idle` and the new input controls
     remain disabled. Existing `values`/`no_data` operations keep working. No idle data may be
     created while pre-1A readers still serve.
   - Verify the compatible static is served, then perform the separate
     `deploy-auto --client-floor=N` operation. Test that older tabs receive 426. A combined first
     deployment requiring an as-yet-unserved contract would be refused by the preflight.
   - **1B, activation:** only after that floor operation, require N via `REQUIRED_CLIENT_FLOOR`
     and enable `idle` writes and controls. Include continuity, both predecessor paths, aggregate,
     maintenance tail, intake marks 2–4, exports/report, schedule and request-day reconciliation.
     Intake warnings 2–3 include the shared/covered-route context of §3 from this release, on any
     weekday. Compatibility clients must safely display saved idle and submit other blocks while 1B rolls
     out; disabled controls in 1A do not permit an idle row to become `values` accidentally.
2. **Working Sunday** (D2). A table `vehicle_request_working_days (request_id, work_date, set_by,
set_at)`, unique/primary key `(request_id, work_date)`, request FK and Sunday check. Set/remove
   in the request's days on its card with `vehicleRequests.status` **and the existing request
   visibility/scope checks**, within [Moscow today − `DRIVER_SUBMIT_PAST_DAYS`, ∞), intersected
   with the request's effective term. Validate again under the request lock; no future date limit
   beyond the term. Record actual changes in request history; a repeated set/remove is a no-op.
   Shared contracts define action availability; the portal asks server permissions.
   Update source context, callers and cabinet queries as §3 requires; add intake mark 1.
   Removing a mark never deletes an existing reading or stops counting it; its live contradiction
   warning is recomputed. A mark changes demand, not hours or site signatures.
3. **Day batch** (D6). Add an optional `includeSundays` input (absent means false), expose the
   checkbox at both callers, and include true in operation identity/fingerprints. Preserve the
   old omitted-key fingerprint for false/absent input, so a pre-release pending retry is not a
   different command merely because the schema added a default. Apply Sunday
   eligibility **before** the 50-unplanned-day portion and `remaining` calculations; skipped
   Sundays neither consume capacity nor remain work to retry. Keep them in the report as
   «воскресенье — не выписан». Repeated portions must progress through long terms.
   With inclusion, a successfully processed Sunday sets the mark in the same per-day transaction
   as placement and optional paper issue (the existing `issueWaybills: false` mode still exists).
   A refused/failed day writes no mark; an already planned/skipped day is not silently marked.
   D2's seven-day limit also applies here: an older Sunday is skipped with a distinct reason and
   no placement, paper or mark, even if the actor can issue older backdated paper. Normal
   backdating/permission/reason checks still apply within that limit. Changing inclusion needs a
   new operation key; an identical retry preserves committed results and resumes remaining work.
4. **Rental cut** (D8). `rentalMonthSplit` skips only Sunday; ADR 0238 is changed by the stage's
   ADR. Small: may ride with stage 3.

Order: 1 first — it closes holidays, the part drivers hit today. 2 before 3: the batch writes marks.
4 is independent.

### 5.1 Working-mark lifecycle

A mark belongs to a request/date, not to a vehicle, driver, route or paper. Reassignment and paper
reissue keep it and resolve it through the current source mapping of §3. Duplication and a rental
continuation do not copy it into another request. A cancelled/archived request's mark contributes
no demand; a physical request deletion cascades its marks. Returning a request to «Новую» clears
its marks with the existing work reset. Shortening a term (including the actual end at completion)
removes marks outside the resulting term in the same transaction and records the change, so a
later extension cannot resurrect an old choice. Changes inside the term keep marks. These paths
and manual/batch mark writes must use the existing request lock order; do not acquire request
locks in reverse order from the route-first day-batch path.

## 6. Open, decided in implementation (defaults stated)

- The exact labels of the reason list (default: D4 as written).
- Whether `idle` on a trip should also notify the dispatcher by mail (default: no — the intake mark is
  the signal).

## 7. Risks

- **Readers of the kind include SQL and local draft logic.** Rebuild the inventory in contracts,
  services, garage, cabinet and exports; do not assume an old file count is exhaustive. Every
  branch must answer `idle` intentionally. Types catch exhaustive switches, but not a fallback
  `kind !== 'no_data'`, raw SQL unions, column checks or a local predecessor search.
- **Expected-shift queries are hot.** The working-mark lookup is an indexed `EXISTS` on
  `(request_id, work_date)`; measure `pendingReadingsSql` on a year's volume before stage 2 ships
  (5 ms today).
- **Tests that float with the calendar.** db tests date their scenarios from today. Run the readings,
  shifts and batch suites as if today were each day of the week (clock shift in the test process),
  and compare with the same shifted run on the base commit: failures on both are artefacts of the
  shift, not regressions.
- **Migration window.** In 1A, pre-release code keeps serving against the expanded schema but no
  writer can create idle yet. B uses nullable/default-compatible columns and preserves all old
  writes; use the strong-lock timeout from the runbook and the teardown suite to verify this
  running-old-code window. In 1B the remaining 1A API/portal already understands idle, and the
  floor blocks pre-1A clients. An empty working-days table equals the hotfix, and stage 2's new
  table has no old-code writer. Rehearse both windows; never infer compatibility from types alone.
- **Recovery.** After any new migration, an older image refuses to start on the newer journal.
  Follow the runbook's PITR plus matching image procedure, or roll forward; neither a code-only
  rollback nor a floor decrease is a compatibility strategy.

## 8. Verification

- Ledger/db: aligned idle closes an expectation and preserves counter continuity; missing or
  misaligned shifts still break it. Several trailing idle days do not create a maintenance tail.
  Both directions of a kind edit clear incompatible fields, rebuild chains and invalidate a prior
  acceptance through the usual report version/history. The previous snapshot skips idle, including
  an earlier shift on the same day, without borrowing individual missing fields from older values.
- Request days: all-idle is a clean zero day unless a source discrepancy remains; mixed idle/values
  adds only the numeric work. Zero hours still requires the site's own comment before approval;
  a principal without `vehicleReadings.read` sees no private idle reason/comment. A signed row is
  never silently overwritten by an idle edit. Normal nonzero hours, anomalies and handshakes stay.
- Intake: each contradiction 1–4, nonzero versus zero signed hours, shared source requests,
  whole-report batch eligibility and a contradiction introduced after the page loaded. Genuine
  missing/source discrepancies retain their existing severity and acceptance rules. On a weekday
  and on Sunday, an idle ESM-2(A) covering route A+B is yellow when only B has nonzero signed hours;
  a freight row on a suppressed mixed route also makes that ESM-2 yellow.
- Working Sunday: matching SQL/cabinet tests for an unmarked/marked ESM-2, shared A+B route,
  ESM-2(A) suppressing route A+B with only B marked, and an inactive marked member. Verify all
  expected-shift consumers, removal after a reading, mark lifecycle, request scope and dates at
  Moscow midnight, today − 7 and today − 8. A trip never becomes optional.
- Batch: default skips, explicit inclusion, plan-only and paper modes, failure rollback and retry;
  a long term with more than 50 Sundays finishes in successive portions with truthful `remaining`.
  Sundays at −7 and −8 respect both the mark window and normal paper backdating checks; a reused
  operation key with changed inclusion is rejected wherever correction-operation identity applies,
  while a pending pre-release body without the key retains its original fingerprint.
- Portal: switch hides/restores fields; required reason and «Другое» text; all-idle/mixed day lines;
  earlier idle draft blocks supply no hidden predecessor values; sending another block leaves saved
  idle intact; two shifts of one vehicle and two vehicles remain independent. Both batch callers
  show inclusion and the request-card switch follows server scope/window availability.
- Compatibility: `v4` adoption/tombstones and pending attempts; an old `v3` tab consolidates/edits
  its own prefix without erasing idle in `v4`. Rehearse 1A with idle writes refused, verified static,
  the separate floor raise, old tabs receiving 426, then 1B against compatible readers. Run the
  repository gates appropriate to each implementation stage, plus the calendar matrix in §7.
- Rental cut: a next month beginning on Saturday starts there; Sunday advances to Monday;
  no continuation is created when the requested extension contains no remaining eligible day.
- release entries in the users' words for each stage.
