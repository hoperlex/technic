# Rest days: one working calendar for the whole portal

Status: plan, 03.11.2026. Nothing here is implemented. The hotfix it replaces —
[ADR 0242](adr/0242-sunday-rest-day-readings.md), release 0.1.135.0242 — is pushed and in prod (the
prod build `64a31d73` of 03.11 contains it). The forks of §6 are open and go to the owner as a
survey before stage 1.

## 1. Problem

The portal has no notion of a working day. Every place that walks a term walks the calendar, and
each one that needed a day off wrote its own rule:

- the owner's statement of 02.11.2026: Sunday is a rest day, and no readings are required for it
  unless there is an explicit indication otherwise;
- the hotfix (ADR 0242) wrote that statement as a hard-coded Sunday in the readings module only;
- the rental month cut (ADR 0238) already treats **Saturday and Sunday** as days off — a new order
  starts on the first Monday–Friday of the next month;
- the mailings keep their own list of holidays per schedule (`excludedRunDates`);
- everything else — the day batch, the site's sign-off of shifts, the weekly ESM-2 expectation —
  counts every calendar day as a working day.

So the same Sunday is a rest day for the cabinet, a working day for the site that must sign it, a
day the day batch issues a 4-П for, and a day off for a rental order. Holidays are not known
anywhere except the mailings. And the "explicit indication" the owner asked for has nowhere to live:
the hotfix reads it only from a trip planned that day or from a submitted reading.

## 2. Where days are walked today

| Place                                                                                                                                                  | Rule today                                                                                       | Consequence                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Expected shifts of readings: `restDayShiftSql` / `restDayExemptSql`, [readings-expected.ts](../apps/api/src/services/readings-expected.ts)             | ADR 0242: Sunday of an ESM-2 or of a site-day route is not expected without a reading; a trip is | correct for Sunday, blind to holidays and to a Sunday that was planned as work          |
| Weekly ESM-2 laid over its week (Р34 of [vehicle-readings-stats-plan.md](vehicle-readings-stats-plan.md))                                              | every day of the paper is an expected shift, minus the hotfix's Sunday                           | the paper's seven columns are a form, not a work plan                                   |
| Day batch, [ADR 0207](adr/0207-vehicle-request-day-batch.md) (`linearDaysOf`, `vehicle-request-day-batch.ts`)                                          | a 4-П for every day of the term                                                                  | Sundays and holidays get a paper and a route; the dispatcher cancels them by hand       |
| Site sign-off of a special-equipment request, `pastShiftDaysCount` in [vehicle-request-shifts.ts](../packages/contracts/src/vehicle-request-shifts.ts) | every elapsed calendar day must be signed                                                        | a request stays in «На объекте» and its closing warns until the site signs every Sunday |
| Rental month cut, `rentalMonthSplit` in [weekly-vehicle-requests.ts](../packages/contracts/src/weekly-vehicle-requests.ts) (ADR 0238)                  | the new order starts on the first Monday–Friday                                                  | Saturday is a day off here and a working day everywhere else                            |
| Driver cabinet debt line and day line, [restDay.ts](../apps/web/src/pages/driver/restDay.ts)                                                           | asks the server's `readingOptional`                                                              | already calendar-neutral: follows whatever the server decides                           |
| Garage driver schedule, maintenance tail, "not submitted" filter, garage day state                                                                     | ADR 0242 fragments                                                                               | follow the readings rule                                                                |
| Readings report, [ADR 0241](adr/0241-readings-report-in-garage-header.md)                                                                              | Saturday and Sunday rows coloured                                                                | display only; holidays not coloured                                                     |
| Mailing schedules, `mailing_schedule_excluded_dates`                                                                                                   | own weekday set and own excluded dates per schedule                                              | a second holiday list, typed by hand                                                    |
| Mechanization day counts (`mech-request-list.ts`, `mech-history-export.ts`), waste ticket lateness (`waste-tickets.ts`)                                | calendar days                                                                                    | probably right (statistics, contractual terms) — to confirm, not to change by default   |

## 3. Principles

1. **One answer to "is this a working day".** A company calendar (a weekly pattern plus dated
   exceptions) and, on top of it, the schedule of a request with its per-day marks. One SQL function
   and one TypeScript twin in contracts, kept equal by a parity test. Nobody else computes a
   weekday.
2. **A plan for the day beats the calendar, both ways.** A day the dispatcher or the site marked as
   work is a working day even on Sunday; a day marked off is off even on a Tuesday. That mark is the
   owner's "explicit indication".
3. **A trip is always a task.** A freight run, a delivery, a pickup planned on a rest day stays
   asked for: someone planned that trip for that very day (survey of 02.11: "a paper with a real
   task under it").
4. **Not asked for is not refused.** A rest day never blocks input: a driver who worked submits, the
   site may sign. The calendar removes only the demand. A submitted reading stays an indication that
   the day was worked (as in the hotfix).
5. **The portal asks the server.** The client gets flags (`readingOptional`, a day kind on shift
   rows), never the calendar rule — the bundle is byte-exact, and a rule copied into the portal
   drifts (AGENTS.md, "one rule, one place").
6. **An empty calendar behaves like the hotfix.** With no exceptions entered, the pattern "Sunday
   off" gives exactly ADR 0242. So the migration window, when old code runs on the new schema,
   changes nothing, and the hotfix can be replaced without a behavioural step.

## 4. Target model

**Company calendar.**

- A setting: the weekly pattern of working days, ISO weekdays, default `{1,2,3,4,5,6}` (Sunday off).
- A table `work_calendar_exceptions (day date PRIMARY KEY, kind, note, set_by, set_at)` with `kind`
  in `holiday` (a day off on a working weekday) and `working_day` (a transferred working Saturday or
  Sunday). Short pre-holiday days are not modelled: nothing in the portal counts hours of a calendar
  day.
- A page in «Справочники»: the year as a list of exceptions, a button to load the official
  production calendar of the Russian Federation for a year from a file the admin uploads (no network
  dependency at runtime), edits by hand.

**Schedule of a request** (special equipment on a site — the requests whose days are walked):

- `work_schedule`: `calendar` (default — the company calendar) or `all_days` (7/0, a site that works
  without days off). More patterns only if the survey asks for them (W3).
- Day marks `vehicle_request_day_marks (request_id, day, kind work|off, set_by, set_at, reason)` —
  the explicit indication. Set in the request's shift table (the site) and in the assignment window
  (the dispatcher), whoever the survey names (W4). A mark is history-kept like other request facts.

**The rule.** `request_work_day(request_id, day)` — an inlinable `LANGUAGE sql STABLE` function:
the day mark if present, else `all_days` → true, else the calendar exception if present, else the
weekly pattern. A day without a request (a free trip, a relocation) asks the company calendar only.
Not used in an index: a function reading tables is not immutable, and PostgreSQL refuses it there.

**Consumers after the plan.**

| Consumer                      | Rule                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| expected shifts of readings   | an ESM-2 day or a site-day route is expected iff `request_work_day` of its request, or a reading came; a trip always                                          |
| day batch                     | issues 4-П for working days only; the non-working days of the term go to the batch report as «выходной — не выписан», with a checkbox «включая выходные» (W6) |
| site sign-off                 | `unapprovedPastDays` counts working days only; a non-working day may still be signed (zero hours or real hours, the site decides)                             |
| «На объекте», closing warning | follow `unapprovedPastDays`                                                                                                                                   |
| rental month cut              | the new order starts on the first working day of the next month by the company calendar                                                                       |
| cabinet                       | `readingOptional` computed by the rule; day line unchanged                                                                                                    |
| readings report               | colours by day kind: day off, holiday, working weekend                                                                                                        |
| mailings                      | a schedule may follow the company holidays (default for new schedules), its own excluded dates stay for stops                                                 |

## 5. Stages

Each stage is one release with its own entry (ADR 0077), its ADR, and its migration where it has
one. A stage with a migration is never automatic (`pnpm maintain surfaces`).

0. **Survey** (§6). Nothing is built before the answers.
1. **Calendar.** Setting, exceptions table, the SQL function (company part), its TypeScript twin in
   contracts, the parity test (both answer the same over three years of days, with exceptions), the
   «Справочники» page and the file loader. Readings switch from `extract(isodow …) = 7` to the
   function — the first visible change: holidays become rest days for readings. ADR 0242 is changed
   by the new ADR.
2. **Request schedule and day marks.** Columns and table, the shift-table control «рабочий день /
   выходной» per day, the assignment window's control (W4), the request-part of the function. The
   whole-set forms rule applies: a form that sends shift rows whole needs a raised client floor if the
   new field rides in it, or an old tab would erase the marks it does not know.
3. **Day batch.** Working days only by default, the checkbox, the batch report lines.
4. **Site sign-off.** `pastShiftDaysCount` by the function (server-side: the contract keeps the
   counting shape, the server passes the working days), «На объекте» and the closing warning follow.
   Retroactivity per W12.
5. **Rental cut, readings report, mailings.** `rentalMonthSplit` asks the calendar (the hard-coded
   Monday–Friday goes), report colours by kind, mailing schedules may follow holidays.
6. **Cleanup.** The hotfix fragments become thin wrappers or go; tests that pin dates to working
   days (`workday()`, `weekday()` helpers in db tests) keep doing so.

Stages 3–5 are independent after 2 and can go to parallel executors with one integrator; 1 and 2
are sequential.

## 6. Forks for the owner (survey before stage 1)

- **W1. Saturday.** Is the company week 6/1 (Sunday off, as stated 02.11) or 5/2? The rental cut of
  ADR 0238 assumes 5/2 today — one of the two changes.
- **W2. Holidays.** The official production calendar of the Russian Federation as the default days
  off? Who keeps it (administrator only?), loaded once a year from the published file?
- **W3. Schedules of a request.** Are `calendar` and `all_days` enough, or are there sites on 5/2
  inside a 6/1 company (a pattern per request)?
- **W4. Who marks a working weekend** of a request: the dispatcher at assignment, the site in the
  shift table, the mechanic, the request's author? Before the day only, or also after it?
- **W5. A submitted reading as an indication.** Keep the hotfix rule (a reading on a rest day makes
  the shift expected and counted)? Recommended: yes.
- **W6. Day batch.** Skip non-working days by default with «включая выходные», or ask in the window
  each time?
- **W7. ESM-2 paper.** The weekly blank keeps its seven columns (it is a form), and only the
  expectation follows the calendar — confirm nothing changes on the paper.
- **W8. Site sign-off of a rest day.** Not required, but allowed? Or not offered at all unless
  marked as work?
- **W9. Rental.** Does a rental order bill weekends by calendar days (unchanged) or only working
  days? Does the month cut start the new order on the first working day by the calendar?
- **W10. Trips on a rest day** (freight, delivery, pickup): always asked for, as now?
- **W11. Mailings.** Should a mailing follow company holidays by default?
- **W12. Retroactivity.** Apply the calendar to past months (data quality, unsigned past days of
  open requests) or only from the release day?

## 7. Risks

- **Expected-shift queries are hot.** The readings filter was measured at 5 ms on a year's volume
  (`pendingReadingsSql`); a function per row must stay inlinable and the exceptions table tiny.
  Measure the same 200 vehicles × 365 days before stage 1 ships.
- **Migration window.** New tables are written only by new code; old code ignores them; an empty
  calendar equals the hotfix (principle 6).
- **Two clocks.** Every date is a Moscow calendar key (`moscowDateKeyOf`); the SQL function takes a
  `date`, never a timestamp, so the session time zone cannot shift a day.
- **Tests that float with the calendar.** db tests take dates as offsets from today; once days have
  kinds, a scenario lands on a rest day one day a week. The hotfix found such tests in three files
  by running the suite with a shifted clock; stage 1 adds the same clock-shift run to its
  verification.
- **Bundle.** The rule stays on the server; contracts get only types and the twin used by the
  server and tests. The hotfix measured what a careless import costs: `dayState` pulled into the
  cabinet layout added 510 B gzip to every garage route.

## 8. Verification per stage

- parity test of the SQL function and the TypeScript twin over three years with exceptions and
  marks;
- db suites of readings, shifts, day batch and rental cut run on their own database, then again as if
  today were each day of the week;
- the portal: the shift table control, the batch report lines, the cabinet day line on a holiday;
- a release entry per stage, in the users' words.
