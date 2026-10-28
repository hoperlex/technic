# ADR 0236. A unit may carry several open office-equipment requests; the form names the open ones

- Статус: Принято (28.10.2026); migration, server, contracts and the request form implemented.
  The owner's request of 28.10.2026 and the survey of the same day (both kinds, a soft hint in the
  form, the pending-candidate lock kept)
- Домены: оргтехника
- Отменяет: **item 13 [ADR 0085](0085-office-equipment-module.md)** — "one open request per
  unit": a second open request on a unit is no longer refused
- Отменяет: **per-kind lock [ADR 0133](0133-service-request-unified-cycle.md)** — "the unique
  index «одна открытая заявка на единицу» is split in two": both partial indexes are dropped, so
  neither two repairs nor two cartridge requests on one unit are refused
- Связано: [ADR 0165](0165-office-equipment-candidate.md) (the pending-candidate lock stays),
  [ADR 0170](0170-service-request-repeat.md) (the repeat marker counts closed predecessors only and
  is unaffected), [ADR 0125](0125-service-request-cycle-changes.md) (a held request is open)
- Область: [migration](../../apps/api/drizzle/0392_service_request_open_unique_drop.sql),
  [schema](../../apps/api/src/db/schema.ts),
  [request routes](../../apps/api/src/routes/service-requests.ts),
  [candidate decisions](../../apps/api/src/routes/office-equipment-candidates.ts),
  [contract](../../packages/contracts/src/service-requests.ts),
  [form hint](../../apps/web/src/pages/service/ServiceRequestOpenOnUnit.tsx),
  [form](../../apps/web/src/pages/service/ServiceRequestForm.tsx)

## Context

ADR 0085 item 13 allowed one open request per unit: two parallel ones were read as two services,
two acts and two warranties for one piece of work. ADR 0133 split the lock per kind, so a cartridge
request could be filed beside an open repair, but a second open repair or a second open cartridge
request on the same unit was still refused with 409 "По этой технике уже есть незакрытая заявка
СО-N — откройте её".

The lock was held in five places: two partial unique indexes
(`service_requests_open_repair_unique`, `service_requests_open_consumable_unique`), the create route
check, the restore-from-archive check and the check that refused to merge a reported device into a
card that already had an open request.

The owner asked to remove the ban. A printer can have two independent faults handled by different
people, two employees can ask cartridges for one MFP, and the refusal made the second person either
wait for the first request to close or write into a request that is not theirs.

## Decision

1. **A unit may carry any number of open requests of either kind.** Migration `0392` drops both
   partial unique indexes. The create route, the restore route and the candidate merge no longer
   check for an open request on the unit. A held request is still open (R109); it simply no longer
   blocks anything.
2. **The form hints and never refuses.** When a new request's unit is chosen, the form asks the
   ordinary list `GET /service-requests?equipmentId=…&openOnly=true` and names the open requests of
   the same kind with links that open the card in a new tab, so the half-written form is kept. The
   text suggests writing in the open request's discussion if it is the same problem. Same kind
   only: a cartridge request beside an open repair was always normal, and naming the repair there
   would be noise. Editing does not ask: the unit cannot change there.
3. **The hint is scoped by the reader.** It uses the registry list and therefore the reader's
   request scope: no hint means "none visible to you", not "none at all", and the hint reveals no
   request the reader could not open anyway.
4. **`openOnly` is a list filter of its own.** It keeps requests not closed by
   `isServiceRequestClosed`, archived ones excluded by the usual archive filter. It is named
   `openOnly`, not `open`, because the portal's `open` URL parameter already names the card to open.
   The portal also drops closed rows itself: a server older than the filter strips the unknown
   parameter and answers with the unit's history.
5. **What stays.** The pending-candidate lock (`office_equipment_candidates_*_pending_unique`): a
   second report of a device not yet in the directory is still refused while the first is under
   review, because it protects the directory from two cards for one device; once the card exists,
   further requests on it are free. The deactivation and deletion guard of a unit with an open
   request is a different rule and is unchanged. A warranty claim still needs an accepted source;
   a source that is done but not accepted is now reachable as a neighbour and is refused by that
   rule, not by the lock.

## Consequences

- (+) Two faults of one unit are two requests with their own executors, acts and history; two
  people asking for the same unit are not turned away.
- (−) Duplicates become possible. The form hint is the only prompt against them; a duplicate is
  cancelled by the dispatcher with a reason, as any other mistaken request.
- (−) Rollback of the rule is one-way in practice: once a unit holds two open requests of one kind,
  recreating either unique index fails until those requests are closed. An application rollback
  needs no schema change: old code reads without the indexes and refuses new duplicates by its own
  route check.
- (−) Choosing a unit costs one more list request in the form.
- The release feed entry (ADR 0077) is written with the deploy window that carries this change.

## Verification

API db suites: a second request of the same kind on one unit is accepted and both are listed by
`openOnly`; a cancelled one leaves that list; an archived open request is restored beside another
open one; a held request does not block a second one; a reported device merges into a card with an
open request of the same kind. The two refusal tests that used a successful retry as proof that
nothing was written now count the rows. Portal: the hint names only open requests of the chosen
kind, follows the kind switch, links into a new tab, stays silent without open requests and is not
asked while editing.
