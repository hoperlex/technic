# ADR 0221. The on-site vehicle row shows the trailer recorded on today's route

- Статус: Принято (07.10.2026)
- Домены: заказ-тс, путевые-листы
- Уточняет: [ADR 0036](0036-vehicle-on-site.md) decision 5 — the vehicle row also names its
  trailer when today's route recorded one; [ADR 0207](0207-vehicle-request-day-batch.md)
  decision 5 — the on-site row reads the same day's route that carries the batch-issued sheet
- Связано: [ADR 0138](0138-vehicle-trailers-registry.md) — the current hitch supplies a new
  route, while route fields preserve the selected trailer details
- Область: [vehicle-requests.ts](../../packages/contracts/src/vehicle-requests.ts),
  [vehicle-requests.ts](../../apps/api/src/routes/vehicle-requests.ts),
  [onSiteCells.tsx](../../apps/web/src/pages/vehicle/onSiteCells.tsx),
  [vehicle-on-site-forms.db.test.ts](../../apps/api/test/vehicle-on-site-forms.db.test.ts),
  [vehicle-on-site.test.tsx](../../apps/web/test/vehicle-on-site.test.tsx)

## Context

The day batch now records a hitched trailer in each new route and waybill. The on-site view
already answers which vehicle works at a site today from that day's route, but its vehicle row
only names the vehicle, route and driver. A dispatcher looking at the site cannot see the
trailer that the day's paper names.

The trailer registry stores the current hitch without hitch history. A later change of hitch
must not change the answer about an issued route. A route can also name a manually chosen
trailer, so the current hitch may never have been the route's trailer.

## Decision

1. The on-site API reads the two trailer model and registration pairs from the day's route.
   It builds one label with the shared `trailerLabelOf` rule used by route and waybill views.
   The nullable `dayVehicle.trailerLabel` means the route has no named trailer. For a vehicle
   supplied by assignment history without a route, the label is null: there is no route
   snapshot to report. An unplanned day remains `dayVehicle: null`.

2. The table and mobile card use their existing shared vehicle-line presenter. A named
   trailer appears on its own detail line below the vehicle model, route and driver, with
   the visible prefix `Прицеп:`. There is no independent trailer column or action: it is part of the
   day's vehicle composition and should remain beside it on narrow screens.

3. The view does not derive a route's trailer from today's hitch or from a waybill. The
   route fields are the recorded plan for that day; an issued waybill keeps its own snapshot
   and may later be cancelled and reissued. This view names the route composition, not the
   legal state of a particular paper sheet.

## Consequences

- A route without trailer details keeps the previous vehicle row layout.
- A route with two named trailers displays both in their recorded order.
- No database change is needed: the route already stores both trailer pairs.
