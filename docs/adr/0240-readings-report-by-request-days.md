# ADR 0240. The readings export becomes a report on the work of equipment by request days

- Статус: Реализовано (02.11.2026); not deployed
- Домены: гараж, доступ
- Изменяет: [ADR 0180](0180-readings-admin-export.md) — the five-sheet readings book is replaced
  by a two-sheet report by request days; the right, the route, the period picker and the limits
  stay
- Связано: [ADR 0184](0184-vehicle-request-shifts.md) (request days and the driver's readings as
  their numbers), [ADR 0182](0182-analytics-summary-export.md) (the company-wide scope refusal, now
  shared), [ADR 0239](0239-freight-trip-cargo-name.md) (the cargo printed in the task column),
  [ADR 0235](0235-rental-completion-and-request-documents.md) (rental closing in hours and shifts)
- Область: [book writer](../../apps/api/src/lib/xlsx.ts),
  [rows](../../apps/api/src/services/readings-report-rows.ts),
  [book](../../apps/api/src/services/readings-admin-export.ts),
  [freight readings and shared judgement](../../apps/api/src/services/shift-driver-days.ts),
  [route time in batch](../../apps/api/src/services/request-route-time.ts),
  [route](../../apps/api/src/routes/vehicle-readings-stats.ts),
  [scope check](../../apps/api/src/lib/access.ts),
  [requirement](../../packages/contracts/src/grants.ts),
  [access manifest](../../apps/api/src/lib/access-manifest.ts),
  [portal texts](../../apps/web/src/pages/admin/ReadingsExportTab.tsx),
  [rows db test](../../apps/api/test/readings-report-rows.db.test.ts),
  [book test](../../apps/api/test/readings-admin-export.test.ts),
  [route test](../../apps/api/test/readings-admin-export-route.test.ts)

## Context

The administration export «Показания автотранспорта» (ADR 0180) was a readings book: a summary per
vehicle, shift detail with outline groups, a pivot over a hidden data sheet and a parameters sheet,
with fuel and fuel-norm columns. The owner asked on 02.11.2026 for something else: a report on the
work of equipment shaped like his own daily equipment report — rows are shifts, a person filters
them in Excel, totals follow the filter. Five surveys the same day and a three-pass review of the
plan fixed the rules below; they are the owner's decisions, not defaults.

## Decision

1. **A row is a request × day.** As many rows on a date as requests worked on it. The only exception:
   readings of several vehicles for one request day give a row per vehicle, marked «машина заменена
   в течение дня».
2. **The old book goes entirely**: its five sheets and the fuel columns. The pivot writer stays —
   the analytics book uses it.
3. **Two sheets.** «Собственная» (first, open on load) for own vehicles: date, vehicle, plate and
   inventory number, driver or operator, object or route, the task, and the odometer and engine
   hours as start, end and the day's difference. «Аренда» for rented vehicles, which have no
   counters and no operators in the system: lessor, shift time, hours of the day, rate, cost of the
   day.
4. **Date is the second column**; rows go by vehicle, then date, then request number; «№» runs per
   sheet.
5. **Header**: the title «Отчет о работе строительной техники», «Период отчета:» with the export
   dates, the totals «по фильтру». The sample's two legend rows are not in the report.
6. **Every column filterable, the header frozen, computed columns are formulas** — the sample's
   difference formula with «—» and «Проверить», `SUBTOTAL(109, …)` totals, «Проверить» painted red.
   Each formula carries the value the server computed by the same rule (`deltaOf`), and the book
   asks the editor to recalculate on open: previews show stored values only.
7. **«Выполненная задача»** is the request data the other columns lack, in a fixed order: number,
   author and approver with initials, the cargo of a freight request, the comment of a special-
   equipment request up to 80 characters; then the row's marks, in this order: «рейс общий Р-12»,
   «перегон», «без заявки», «вне срока заявки», «машина заменена в течение дня», «показания не
   сданы», «нет данных: …», «начало от 28.10», «сброс счётчика», «подписано 7 ч»; on «Аренда» then
   «часы по плану», «закрыто в сменах», «план не задан», «есть показания водителя».
8. **A shared reading's counters go to one row**: the request whose stop comes first on the route
   (the route's points, then the composition place, then the lower request number). The other rows
   have empty counters and the mark «рейс общий».
9. **A request day with a vehicle always has a row**, with readings or not. Days after today
   (Moscow) and days without a vehicle are not rows.
10. **Readings outside requests are rows too, for own vehicles**: a relocation route is a row of its
    source request on the route's vehicle (which may be a carrier), marked «перегон»; any other
    own-vehicle reading of the period is a row «без заявки» with its source. So the mileage of one
    vehicle over the filter equals its odometer growth.
11. **A broken chain keeps its start**: the start is the previous snapshot even when the garage's
    continuity rule (Р13а) breaks the pair; the task says «начало от 28.10».
12. **Engine hours on «Собственная» are the counters**; a different number signed on the request's
    «Смены» tab is shown as «подписано 7 ч».
13. **Hours on «Аренда»**, independent of the request status: a special-equipment day signed on
    «Смены» gives its hours; otherwise the assignment's shift length with «часы по плану», or empty
    with «план не задан». A freight request gives its closing hours; a closing in shifts only falls
    back to the plan with «закрыто в сменах»; an open one plans by its share of the route time
    rounded up (`routeTimePrefill`, D12), then by the shift length. The rate is the closing's, else
    the assignment's by the closing's own rule (`rateForWorkUnit`) for the unit the closing window
    starts from — a shift price first.

**Access** (a protected area, approved by the owner on 02.11.2026). The rows are vehicle requests,
so `vehicleReadings.export` requires `vehicleReadings.read` **and** `vehicleRequests.read`
(`PERMISSION_REQUIRES`), the route asks for request reading by its own guard, and the handler refuses
a principal whose role stands on any area axis (`assertWholeOrganizationScope`, moved from the
analytics route to `lib/access.ts` — one rule for both company-wide exports).

## How it is built

- **One selection, batch reads** (`readings-report-rows.ts`). A special-equipment day is a term day
  by `shiftDaysOf` with the vehicle of the day (`requestDayVehicleSql`); a freight day is its route
  day with the route's vehicle. Readings come by the request card's readers: special equipment by
  `loadDriverShiftDaysByRequest` (an ESM-2 of the request, a linear route day), freight by the new
  `loadFreightRouteReadings` beside it — same report states (D2), same reading columns and the same
  judgement, extracted into one helper. Both counters' continuity is the garage's
  `loadBrokenCounterPairs`. Every read is one query for the period; there is no query per request
  or vehicle. Live requests only (not deleted, not cancelled).
- **The book reads rows, decides nothing about them** (`readings-admin-export.ts`), so it is tested
  on rows in memory; the selection has its own db test on the live schema.
- **The writer grew generic parts** (`lib/xlsx.ts`): a formula cell with a stored value and
  `fullCalcOnLoad`, per-column looks in the sample's colours, conditional formats, a number format
  with a unit, no grid, a title font, row heights. New style records are numbered after the base
  ones and written only into a book that uses them: every other book stays byte-identical, which the
  writer test pins by hash.

## Consequences

- The book answers "what did each vehicle do on each request day"; fuel, the norm check and the
  monthly pivot are no longer in it. The garage's six books and the analytics book are unchanged.
- The unit of an estimate mirrors the portal's closing default (`defaultUnit` in the completion
  command): moving that rule into contracts would put it into the portal's entry chunk, so the
  server keeps a three-line twin (`plannedUnit`) with a comment naming the original.
- A request membership of a route is read live, as in the request card: a correction of the
  composition moves an unsigned day's readings between requests in the next export.
- The row limit (50 000) counts both sheets; the period limit (366 days) is unchanged.
- No migration and no client floor change. Stored grants cannot become inconsistent: grants with
  `vehicleReadings.*` go only to roles without an area axis (the scope matrix), and every such role
  reads vehicle requests by role. The dev data has no grant with the export right.
- Rented trucks rarely have stop times (a lessor's driver has no cabinet), so their planned hours
  usually come from the assignment's shift length. The dev database holds no routes, assignments
  or readings at all, so how often this fallback fires is not measured; prod measurements were not
  available.
