# ADR 0235. Rental closing with hours and delivery, documents of a vehicle request

- Статус: Реализовано (28.10.2026); not deployed
- Домены: заказ-тс, файлы-и-распознавание
- Изменяет: [ADR 0029](0029-vehicle-request-completion.md) — decision 2 (one count per closing):
  a rental closing records both counts, and the unit names the billed one; decision 6 (a repeated
  closing overwrites the row): a body without the delivery keeps the stored delivery
- Развивает: [ADR 0178](0178-completion-actual-end-date.md) — the completion door's fingerprint
  and preview carry the new facts
- Связано: plan [vehicle-rental-completion-documents-plan.md](../vehicle-rental-completion-documents-plan.md)
  (owner decisions D1–D8 and defaults P1–P11 of 28.10.2026),
  [ADR 0038](0038-executor-permissions-by-counterparty-type.md) (the lessor's corridor and scope),
  [ADR 0223](0223-portal-permission-oracle.md) (predicates over the server's permission list)
- Область: [migration](../../apps/api/drizzle/0391_vehicle_rental_completion_documents.sql),
  [schema](../../apps/api/src/db/schema.ts) (`vehicleRequestCompletions`, `vehicleRequestFiles`),
  [rental rules](../../packages/contracts/src/vehicle-rental-completion.ts),
  [document rules](../../packages/contracts/src/vehicle-request-documents.ts),
  [closing body](../../packages/contracts/src/vehicle-requests.ts),
  [fact resolver](../../apps/api/src/services/vehicle-request-completion.ts),
  [completion door](../../apps/api/src/services/assignment-completion.ts),
  [documents routes](../../apps/api/src/routes/vehicle-request-documents.ts),
  [closing window](../../apps/web/src/pages/vehicle/VehicleCompleteModal.tsx),
  [rental row](../../apps/web/src/pages/vehicle/RentalCompletionFields.tsx),
  [window rules](../../apps/web/src/pages/vehicle/rentalCompletion.ts),
  [documents section](../../apps/web/src/features/vehicle-request-documents/ui/VehicleRequestDocuments.tsx),
  [resolver tests](../../apps/api/test/vehicle-rental-completion.test.ts),
  [rule tests](../../apps/api/test/vehicle-rental-completion-contracts.test.ts),
  [db tests](../../apps/api/test/vehicle-rental-completion.db.test.ts),
  [window tests](../../apps/web/test/vehicle-rental-completion.test.tsx),
  [documents tests](../../apps/web/test/vehicle-request-documents.test.tsx)

## Context

A rental is billed by the lessor's invoice. The closing fact of ADR 0029 held one count — hours
or shifts — and one sum, and the invoice says more: how many shifts, how many hours they made, and
what bringing the machine to the site and taking it away cost. That last amount is a separate
service with its own paperwork; inside the order sum it could not be reconciled with either
invoice. The paperwork itself had nowhere to go: a vehicle request kept only the requester's
attachments, added in the editor while the request was new.

## Decisions

1. **A rental closing records both counts (D1, D4).** Any closing whose assigned vehicle is rented
   — an on-site order and a freight request alike — takes `workedShifts` and `workedHours`. The
   «Считаем работу» switch stays and names the billed count: `worked_amount` is that count, and the
   cost is rate × it, editable by hand as before (ADR 0029 decision 4). The matching count repeats
   `worked_amount`; a CHECK refuses a row where the two copies disagree. Every existing reader of
   `worked_amount` (card, journal, summary book) keeps its meaning.
2. **Hours per shift is shown, not stored (D2).** The window divides the hours between the shifts
   live («по 9 ч на смену», one decimal, P1); above 24 h it warns, never refuses — half shifts make
   odd averages legal.
3. **Delivery is its own amount (D3).** «Доставка на объект» opens one amount for bringing and taking
   away; `delivery_cost` is apart from `total_cost` and never added to it. `NULL` is no delivery, a
   zero is refused. The card shows its own line, the journal its own column and total. The box is
   never ticked by a guess (P3), not even from a 4-P delivery route.
4. **Not a rental, no rental facts.** The server refuses the second count and the delivery by name
   on any other closing (`completionAsksRentalFacts` false): a dropped amount would read as
   accepted.
5. **The wire rule for an old tab.** The closing is one row, not a whole-set form, so an absent key
   and `null` differ. An absent delivery keeps the stored one — the tab could not have been shown
   it; `null` clears it. Absent counts store the billed count only: the tab re-stated the work, and
   the paired count of a previous closing no longer describes it. No client floor raise is needed;
   the portal requires both counts, the server tolerates their absence.
6. **The facts are what was confirmed.** The completion door puts both counts and the delivery
   into its fingerprint and preview: a delivery changed after the preview is a 409, like any other
   changed command. The `vehicle_request.complete` event names them: the worked line carries the
   second count, the delivery its own line.
7. **Documents share the link table (D8).** `vehicle_request_files.kind` is `attachment` (the
   requester's, owned by the editor) or `document` (typed, dated paper); a document carries
   `doc_type` (free text, D5) and `doc_date` (any date, owner correction to P4). One table keeps
   one download rule — `files.ts` already follows it with the lessor scope — one `UNIQUE (file_id)`
   and one branch of `file_is_linked`. The editor's list and its remove button see attachments only,
   so an invoice cannot leave a closed request through the editor.
8. **Who adds and removes (D7, P5).** Adding is running the request: `vehicleRequests.status` within
   the request's visibility, the lessor on its own requests only, in «В работе», «Выполнена» and
   «Отменена». Removing is the uploader's (`files.uploaded_by`) while they may add, or an
   administrator's at any time; an attachment is never removed from the documents table. No new
   permission; adding and removing are history events («Подшит документ», «Снят документ», P8).
   Delivery paperwork is not marked apart (D6). Up to 50 documents per request (P7), counted apart
   from the editor's limit.
9. **One table in the card (D8, P10).** Attachments («Вложение заявителя», dated by upload) and
   documents in one table File | Type | Date; the table is not drawn while empty, the header with
   «Добавить файл» is, whenever the viewer may add.

## Consequences

- The rental rules live in their own contracts module, not in `vehicle-requests.ts`: that module is
  a chunk the portal's entry loads, and whatever is added there is downloaded by every section.
  Lazy-loading the rental row was tried and rejected: the bundler's regrouping added 3.8 KB to the
  entry. The budget was raised after shrinking (entry +73 B gzip, the vehicle section +1.8 KB).
- A tab of the new portal left open over a rollback gets a 400 on closing until reloaded: the old
  API's strict schema rejects the new keys. A rollback after migration 0391 is
  `--previous --restore-db` anyway — an old image refuses a newer schema.
- The summary book and the monthly reports do not show delivery yet (P9); they read `total_cost`,
  which never held it.
- A document's type and date cannot be edited after adding — remove and add again.
