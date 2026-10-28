# Rental closing: hours, delivery cost and request documents

Status: proposal, 28 October 2026. Nothing is implemented. The owner closed forks **D1–D8** by two
surveys on 28 October; the defaults in §5 were chosen by the plan and stand unless the owner
changes them before implementation.

## 1. Request

The owner asked for three changes to vehicle requests (`Заказ ТС`), worded here by meaning:

1. When a request on **rented** equipment is closed, the closing row gets, next to the cost, the
   **actual number of hours** — the total over the shifts, typed by hand. The hours are divided
   between the worked shifts on the fly, and the order cost is recalculated on the fly; the cost can
   still be corrected by hand afterwards.
2. Under that row (shifts, hours, cost) a checkbox **«Доставка на объект»**. Ticking it opens a field
   for the cost of bringing the equipment to the site and taking it away. Delivery is a separate
   entity with its own paperwork: its cost is not part of the order cost.
3. A general way to **attach documents** to a vehicle request. They are shown as a table — file
   (a link), type and date (both typed by hand when the file is added). With no files the table is
   not shown. A file is added with a «Добавить файл» button, from «В работе» up to and including the
   terminal statuses.

## 2. Owner decisions (surveys 28.10.2026)

| #   | Fork                                    | Decision                                                                                                                                                                                           |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How hours drive the cost                | **By the selected unit.** The «Считаем работу» switch stays. A rental closing takes both shifts and hours; with «Часы» cost = hours × hourly rate, with «Смены» cost = shifts × shift rate.        |
| D2  | «Hours divided between worked days»     | **Average per shift**, shown live under the hours field: hours ÷ shifts. Only the totals are stored.                                                                                               |
| D3  | Delivery cost shape                     | **One amount** for bringing and taking away; the performer is the lessor of the order. Stored apart from the order cost and never added to it.                                                     |
| D4  | Which closings get hours and delivery   | **Any rental**: an on-site special-equipment order and a freight request alike, whenever the assigned vehicle is rented.                                                                           |
| D5  | Document type                           | **Free text**, no dictionary.                                                                                                                                                                      |
| D6  | Delivery paperwork apart from the order | **Not distinguished**: one table, no "relates to" mark.                                                                                                                                            |
| D7  | Who adds and removes documents          | **Whoever runs the request** (holds `vehicleRequests.status`: dispatcher, manager, admin) **and the lessor on its own requests**. Removes: the person who added the document, or an administrator. |
| D8  | The requester's existing «Файлы»        | **Merged into the same table**: requester attachments are rows with type «Вложение заявителя» and the upload date.                                                                                 |

## 3. What exists today

- **Closing fact** — one row per request, `vehicle_request_completions` ([ADR 0029](adr/0029-vehicle-request-completion.md)):
  `worked_unit` (hours | shifts), `worked_amount`, a rate snapshot, `total_cost`, and since
  [ADR 0178](adr/0178-completion-actual-end-date.md) `ended_on` / `previous_date_to`. Re-closing
  after a rollback overwrites the row (ADR 0029 decision 6).
- **Three ways to close.** An on-site order uses its own door with a preview and fingerprints
  (`POST /vehicle-requests/:id/completion[/preview]`,
  [vehicle-request-completion.ts](../apps/api/src/routes/vehicle-request-completion.ts)); a freight
  request uses the status door (`PATCH /vehicle-requests/:id/status` with `completion`); the lessor
  closes its own requests without a date and without a preview (plan Р16). The closing window is
  [VehicleCompleteModal.tsx](../apps/web/src/pages/vehicle/VehicleCompleteModal.tsx) with its fields
  in [CompletionFields.tsx](../apps/web/src/pages/vehicle/CompletionFields.tsx); the body is built
  once in [completionCommand.ts](../apps/web/src/pages/vehicle/completionCommand.ts).
- **Hours already prefilled**: signed shift hours (`approvedMachineHours`) for an on-site order,
  the recorded route share (`routeTimePrefill`) for freight — this is the "total over the shifts".
- **Files**: `vehicle_request_files` links a request to `files` rows; the requester attaches them in
  the editor (`addFileIds` / `removeFileIds`, limit `config.files.maxPerRequest`), the card lists
  them as «Файлы». Download access through this link already follows the request's visibility,
  the lessor scope included ([files.ts](../apps/api/src/routes/files.ts)), and `file_is_linked(uuid)`
  already knows the table.
- **Delivery** exists only as a relocation route (4-P waybill, [ADR 0057](adr/0057-waybill-forms-and-relocation.md)); it carries no money.

## 4. Design

### 4.1 Data — one additive migration (next free number, today `0391`)

`vehicle_request_completions` gets three nullable columns:

- `worked_hours numeric(10,2)`, `worked_shifts numeric(10,2)` — both counts of a rental closing.
  CHECK: positive when present; the column matching `worked_unit` equals `worked_amount` when
  present. `worked_amount` stays the billed count, so every existing reader (card, journal, summary
  book `analytics/facts-vehicle.ts`) keeps working unchanged.
- `delivery_cost numeric(14,2)` — the delivery amount; CHECK `> 0` when present. `NULL` means "no
  delivery", so the checkbox is `delivery_cost IS NOT NULL` and needs no column of its own.

`vehicle_request_files` gets the document columns:

- `kind text NOT NULL DEFAULT 'attachment'` with CHECK `IN ('attachment','document')`;
- `doc_type text`, `doc_date date`; CHECK `(kind = 'document') = (doc_type IS NOT NULL AND doc_date IS NOT NULL)`
  and `btrim(doc_type) <> ''` for a document.

Who added a document is `files.uploaded_by` (the attach path already requires the uploader to be the
caller), so no `added_by` column. One table rather than a new one: the link, the download access, the
`UNIQUE (file_id)` and `file_is_linked` stay single, and a second table would have to repeat all
four.

Migration window: old code inserts closings and links without the new columns and gets `NULL` /
`'attachment'` — the same as before. New data appears only after the restart.

### 4.2 Contracts (`packages/contracts/src/vehicle-requests.ts`)

- `completeVehicleRequestSchema` (the status door) and the completion door body gain optional
  `workedHours`, `workedShifts` (`workedAmountSchema`, nullable) and `deliveryCost`
  (`vehiclePriceSchema`, nullable). A refine: the count matching `workedUnit` equals `workedAmount`
  when sent.
- Predicate `completionAsksRentalFacts(assignment)` — `ownership === 'rental'`; the portal and the
  server ask it, never their own copy.
- `hoursPerShift(hours, shifts)` and its label — the D2 average, one function for the window and
  the card.
- `VehicleRequestCompletionDto` gains `workedHours`, `workedShifts`, `deliveryCost`;
  `completionLabel` adds the hours to "3 смены" when known.
- Documents: `VEHICLE_REQUEST_DOCUMENT_STATUSES = ['confirmed','done','cancelled']`,
  `addVehicleRequestDocumentSchema` (`fileId`, `docType` 1–100 chars after trim, `docDate`),
  `VehicleRequestDocumentDto` (file, kind, docType, docDate, addedAt, uploadedBy name and id), and
  the predicates `canAddVehicleRequestDocument` / `canRemoveVehicleRequestDocument`, taking `can` from
  the server permission list (ADR 0223).
- Request history: change labels for the three new completion fields and two events,
  document added / removed.

### 4.3 API

**Closing.** All three ways write the new fields through the one completion writer
([vehicle-request-completion.ts](../apps/api/src/services/vehicle-request-completion.ts)). The
completion door puts them into the preview fingerprint and the operation replay comparison: they
are part of what the person confirmed. The `vehicle_request.complete` history event carries them in
its diff. Wire rule for an old tab (§4.6): an absent `workedHours` / `workedShifts` stores the count
matching the unit from `workedAmount` and clears the other one; an absent `deliveryCost` keeps the
stored value; `null` clears it. A closing that is not a rental (`completionAsksRentalFacts` is
false) and carries the second count or a delivery cost is refused with the field named, not stored
or dropped: D4 limits both to rentals, and a silently dropped amount would read as accepted.

**Documents.**

- `POST /vehicle-requests/:id/documents` — `{ fileId, docType, docDate }`. The file is uploaded first
  by the shared presign flow, as for every other attachment. Checks: `canAddVehicleRequestDocument`
  (permission, status corridor), the request's visibility with the lessor scope
  (`assertLessorScope`), `assertFilesAttachable`, a document limit of its own (§5 P7). Writes the
  link with `kind = 'document'`, marks the file active, writes a history event.
- `DELETE /vehicle-requests/:id/documents/:fileId` — only `kind = 'document'`;
  `canRemoveVehicleRequestDocument`; unlinks and schedules the object deletion
  (`scheduleFilesDeletion`, as `detachFiles` does); history event.
- `GET /vehicle-requests/:id/documents` — the merged table rows (attachments and documents), read by
  the card only, so the list payload does not grow.
- `VehicleRequestDto.files` keeps returning **attachments only** (`kind = 'attachment'`): the editor
  reads it, and with documents in it a requester could take an invoice off the request with the
  editor's remove button. `detachFiles` is narrowed to `kind = 'attachment'` for the same reason, and
  `assertTotalWithinLimit` keeps counting attachments only.

### 4.4 Portal

**Closing window** ([CompletionFields.tsx](../apps/web/src/pages/vehicle/CompletionFields.tsx)),
when `completionAsksRentalFacts`:

```text
Считаем работу: [Смены · 18 000 ₽] [Часы · 2 500 ₽]

Отработано смен      Фактически часов      Стоимость, ₽
[ 3            ]     [ 27            ]     [ 67 500        ]
Заказано: 5 дн.      по 9 ч на смену       Расчёт: 27 ч × 2 500 ₽

☐ Доставка на объект
  Стоимость привоза/увоза, ₽  [ 12 000 ]   (appears when ticked; not part of the order cost)
```

- Both counts are required for a rental. Editing the count of the selected unit recalculates the
  cost until the cost is touched by hand — the existing `costTouched` rule; the other count only
  moves the average.
- The hours prefill is the existing basis (signed shift hours, route share); the shifts prefill is
  the existing `plannedAmount`. A repeated closing opens on the previous fact, delivery included.
- Not a rental: the window is unchanged.

**Card.** «Выполнение» shows «67 500 ₽ · 3 смены · 27 ч (по 9 ч на смену)» and a separate line
«Доставка: 12 000 ₽». The «Файлы» block becomes **«Документы»**: a header with «Добавить файл» (when
`canAddVehicleRequestDocument`), and a table File | Type | Date | (remove) only when there are rows.
Requester attachments are rows typed «Вложение заявителя» with the upload date and no remove button
(the editor owns them). The add dialog: file upload, type (free text, §5 P11), date.

**Journal of closed orders** ([vehicle-request-history](../apps/web/src/widgets/vehicle-request-history)):
«Отработано» adds the hours; a «Доставка» column; the summary gets a separate delivery total next to
the cost total — one is never folded into the other.

### 4.5 Access

No new permission. Adding a document is the same act as running the request, so it is
`vehicleRequests.status` within the request's visibility; the lessor holds that permission through
its counterparty type and is held to its own requests by the existing lessor scope. Reading the
table needs nothing beyond reading the request. `docs/access-model.md` §9 gets the rule written
down; `permissions.ts` does not change.

### 4.6 Compatibility and rollout

- **No client floor raise.** The closing is one row, not a whole-set form: an absent key and an
  explicit `null` are different on the wire, so an old tab cannot erase the delivery cost (rule in
  §4.3). The portal requires both counts for a rental; the server accepts their absence from an old
  tab, which records the billed count only — the same fact as before this change.
- **Rollback.** An old API rejects the new keys (`.strict()`): a tab of the new portal left open over
  a rollback gets a 400 on closing until reloaded. An old API re-closing a request leaves the new
  columns as they were — stale hours or delivery on a re-closed rental until the next closing by the
  new code. Both are accepted consequences, recorded in the ADR.
- Migration before restart, additive only; the teardown suite needs no new case beyond the default
  values check.

## 5. Defaults chosen by the plan

| #   | Default                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | The average is shown to one decimal («по 8,7 ч на смену»). Above 24 h per shift — a warning, not a refusal: fractional shifts make odd averages legal.              |
| P2  | Delivery amount is required when the box is ticked and must be above zero; unticking clears it.                                                                     |
| P3  | The delivery box is never pre-ticked, not even when the request has a 4-P delivery route: a route by its own wheels costs nothing extra, and a guess would bill it. |
| P4  | Document date is required and not later than today (Moscow); any past date is allowed.                                                                              |
| P5  | Removing a document: its uploader while the request is in the add corridor, an administrator always. Requester attachments are not removed from the table.          |
| P6  | Documents stay on the request when it is rolled back to «Новая» (ADR 0058); only adding is closed there.                                                            |
| P7  | A document limit of its own, 50 per request, apart from the attachment limit: a month-long rental collects more paper than 20 files.                                |
| P8  | Adding and removing a document are request history events («Добавлен документ: УПД от 14.10.2026»).                                                                 |
| P9  | The summary book (`analytics/facts-vehicle.ts`) is not changed in this work: the delivery measure there is a follow-up (§8).                                        |
| P10 | The documents section header and its button show even when the table is hidden: otherwise the first file could not be added.                                        |
| P11 | The type field is free text with suggestions (Счёт, УПД, Акт, Счёт-фактура, Договор) and the request's previously used types; anything else can be typed.           |

## 6. Stages

Each stage is one session, committed and green before the next (AGENTS.md).

1. **Data and contracts.** Migration, `schema.ts`, contracts (schemas, predicates, DTOs, labels),
   contract unit tests.
2. **API.** The three closing ways, DTO and history; the documents routes; DB tests.
3. **Portal.** Closing window, card «Выполнение» and «Документы», journal; web tests; bundle budget
   re-measured (a growth is raised by hand with the owner's consent).
4. **Docs and release.** ADR (next free number, today `0235`, header in the new form with
   `Домены: заказ-тс, файлы-и-распознавание`; it changes ADR 0029 decisions 2 and 6),
   `access-model.md`, `code-map.md`, `database-schema.md`, `pnpm docs:index`, `pnpm check`,
   `pnpm check:docs`, the DB suites of the area on their own database.

Stages 1 and 2 may be one session if the context allows; 3 and 4 likewise.

## 7. Tests

- Contracts: the refine (matching count equals `workedAmount`), `completionAsksRentalFacts`,
  `hoursPerShift`, the document schema (type trim, date bound) and both document predicates.
- DB: a rental closed by each way stores hours, shifts and delivery; the completion door refuses a
  stale fingerprint after a delivery change; an old-tab body keeps the delivery and clears the other
  count; a non-rental closing with the new fields is refused by name; documents — add in each corridor status,
  refuse in «Новая», the lessor on its own and on another lessor's request, remove by uploader, by
  another user (refused) and by an administrator, the editor cannot remove a document, history events.
- Web: the rental row and its live average and cost; the delivery box opens and clears its field; a
  non-rental window unchanged; the documents section hidden table, the button by status and
  permission, the merged rows.

## 8. Out of scope and follow-ups

- Delivery cost in the summary book and in monthly reports (P9).
- A dictionary of document types (D5 chose free text; suggestions in P11 are not a dictionary).
- Editing a document's type or date after adding — remove and add again.
- Delivery documents marked apart from order documents (D6).
