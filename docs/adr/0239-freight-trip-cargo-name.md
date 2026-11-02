# ADR 0239. A freight trip names what it carries: the required field «Что везём»

- Статус: Реализовано (02.11.2026); not deployed
- Домены: заказ-тс
- Развивает: [ADR 0108](0108-request-trips-and-route-points.md) — the trip owns what is carried, as
  it already owns where and how much
- Связано: [ADR 0025](0025-vehicle-request-approval.md) (the approval covers what is carried and
  where, so an edit of the cargo resets it), [ADR 0006](0006-address-verification-dadata.md) (the
  R2a exemption of a value older than the rule), [ADR 0037](0037-freight-transport-waybill.md)
  (the quantity stays conditional by the waybill form), [ADR 0071](0071-blank-waybill-and-form3-task.md)
  (the waybill «Груз» column is not changed)
- Область: [migration](../../apps/api/drizzle/0397_vehicle_request_trip_cargo_name.sql),
  [schema](../../apps/api/src/db/schema.ts) (`vehicleRequestTrips.cargoName`),
  [trip contract](../../packages/contracts/src/vehicle-request-trips.ts),
  [edit contract](../../packages/contracts/src/vehicle-requests.ts),
  [request routes](../../apps/api/src/routes/vehicle-requests.ts),
  [history diff](../../apps/api/src/services/vehicle-request-diff.ts),
  [form field](../../apps/web/src/widgets/vehicle-request-editor/ui/RequestTripFields.tsx),
  [list and card summary](../../apps/web/src/entities/vehicle-request/model/requestCargo.ts),
  [db tests](../../apps/api/test/legacy-trip-edit.db.test.ts),
  [portal tests](../../apps/web/test/vehicle-request-cargo-name.test.tsx)

## Context

A freight request said where to go and how much to carry, but not what: the cargo was described,
when at all, in the request comment, whose label asked for it («Комментарий (опишите груз)»). The
dispatcher matched vehicles against free prose, and a request without the description was legal.

The owner's request of 02.11.2026: a required free-text field «what to carry» when a freight request
is created. Decided by survey the same day: the label is «Что везём»; the field belongs to each
trip; it is not printed on the waybill or shown in the driver cabinet; it is required for every
freight trip, a passenger car included.

## Decisions

1. **The field is per trip** (`vehicle_request_trips.cargo_name`, text). A request with trips A→B
   and A→C may carry different things, exactly as it carries different quantities; a request-level
   field would answer "what does this request carry" by guess for such a request.

2. **Required for every new trip, free text up to 200 characters, stored trimmed**
   (`cargoNameSchema`). The passenger car (form No. 3) is not exempt, unlike the quantity
   (`isCargoAmountRequired`): the quantity exemption exists so that nobody invents a number, while
   naming what a car carries ("passengers", "documents") invents nothing. The rule is in the schema,
   not on the server only, so the form and the API answer the same.

3. **A trip older than the field keeps an empty value (R2a).** Migration 0397 gives every existing
   trip `''`. An edit row (`updateRequestTripSchema`) accepts an empty value, and the server
   (`applyRequestTrips`) lets it pass only while it equals the stored one — the same rule as for an
   old contact: a filled cargo cannot be cleared, an empty one is kept or filled. The form marks the
   field required except on such a trip. There is no not-blank CHECK in the database for this
   reason.

4. **An omitted key is a body older than the field, not an empty answer.** The portal always sends
   the key; only a tab opened before this release, or a body it froze for a retry, lacks it.
   - On an existing row the server writes the stored value back: trips are edited as a full list
     (§7 of the route-trips plan), and reading the absence as "cleared" would erase the cargo on
     every edit from such a tab.
   - The stable create schema accepts it: a creation sent before the release whose answer was lost
     is sent again as is (ADR 0231), and it must still replay its saved response and reconcile under
     the fingerprint it was stored with. So `cargoName` is optional as a key and never empty as a
     value in `requestTripSchema`.
   - A new command without it — a creation, or a new row of an edit or a conversion — is refused
     with 422 and a text that says what to do (`CARGO_NAME_STALE_TAB_MESSAGE`: reload, the draft
     of ADR 0230 keeps the input), before any write. Not 426: the new portal itself resends a frozen
     old body, and a mandatory reload on it would loop. The client floor is not raised for this.

5. **Not printed; the route version does not move.** The waybill «Груз» column keeps printing the
   quantity and the note (ADR 0071), and the driver cabinet is unchanged. So an edit of the cargo
   alone is written but not reported as a document change: it neither bumps the route version nor
   meets the frozen-route refusal (`tripDocumentChanged`).

6. **An edit of the cargo resets the approval.** The construction manager approves what is carried
   and where (ADR 0025); the cargo is the "what" itself (`tripsChangeSubstance`). An omitted value
   (decision 4) changes nothing.

7. **Shown and searched in the portal.** The card names the cargo of the request once per distinct
   value («Что везём: песок, щебень») and per trip in the trips table; the order list shows it under
   the ordered vehicle, the phone card as a line of its own; a request whose trips are all older
   than the field shows nothing instead of a dash. The request search (list, feed and closed
   journal) also matches the cargo of live trips: before the field the cargo lived in the searched
   comment, and moving it out must not make it unfindable. History records the change as «Что везём
   в ездке» and names the cargo in added and removed trips.

8. **The freight comment no longer asks for the cargo.** Its label is plain «Комментарий», and the
   placeholder asks for handling conditions, so one answer is not split between two places.

## Consequences

- Rollout: migration 0397 before the restart; it is additive (`NOT NULL DEFAULT ''`, no rewrite),
  and old code writes `''` during the window. Rollback after it is `--previous --restore-db`.
- The bundle budget grew by measurement with the owner's consent: the entry by 57 B gzip (the trip
  contract lives in the entry chunk), the vehicle requests section by 207 B.
- Not done: printing the cargo on the waybill or in the driver cabinet, a cargo column in the
  reports or the route card. Each is a separate decision if needed.
