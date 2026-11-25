# Plan for a snow removal request in the waste section

S1–S13 record the owner's survey answers from 25.11.2026. A numbered ADR will record the decision
when the feature is implemented.

## 0. Owner decisions

| #   | Decision                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Offer «Вывоз снега» as a request type immediately after «Вывоз мусора (разовый объём)».                                                                                 |
| S2  | The server assigns the service waste type «Снег». Regular garbage keeps its usual type picker, which excludes the service type.                                         |
| S3  | Use the existing operators bound to each site and the existing assignment permissions.                                                                                  |
| S4  | Require a ticket at «Выполнена» and use the garbage ticket review and reconciliation rules.                                                                             |
| S5  | Require at least 8 m³ of ordered volume, using `MIN_WASTE_VOLUME_M3`.                                                                                                   |
| S6  | Snow has a manual completion cost. The request has no price list, tariff, or estimate.                                                                                  |
| S7  | The cost may be empty at completion. Statistics flag a removed volume with a missing invoice amount as «без цены».                                                      |
| S8  | Use a «Мусор / Снег» switch beside the report month. Every table, site breakdown and total belongs to the selected kind.                                                |
| S9  | Show the «Снег» position inside «Вывоз мусора» in the summary book.                                                                                                     |
| S10 | Offer the type year-round. The service waste type stays active and is protected from purge.                                                                             |
| S11 | The owner reported that «Снег» had never been created in production. Seed it by migration and stop on a collision.                                                      |
| S12 | Refuse a type change involving a filed snow request. The working interpretation covers both directions and every other type. A wrong type is cancelled and filed again. |
| S13 | Ship the completed feature in one push with the release entry, `VERSION` and its annotated tag.                                                                         |

## 1. Request and completion

The requester chooses «Вывоз снега» in «Новая заявка», then enters the site, delivery date and time,
ordered volume, site contact, comment and files. The form shows «Стоимость вносится при закрытии
заявки». The same access checks, assignments, statuses, history and archive apply as for garbage.
The request has a regular `М-<num>` number. The new enum value is `snow_removal`, with the label
«Вывоз снега», colour `cyan` and legacy short label «ВС».
[ADR 0067](adr/0067-metal-removal-request.md)

At «Выполнена» the closer enters the actual volume in m³, can enter the removal day, attaches a
ticket and can enter «Стоимость, ₽». The first completion starts with a blank cost. Subsequent
completions prefill the previous manual cost and actual date, including an explicit zero cost. A
completion stores an entered cost or explicit NULL. A correction with the amount or date omitted
keeps the corresponding saved value. A transition that reuses a previous completion preserves it in
full. To enter a late invoice, someone with `requests.rollbackStatus` returns «Завершена» to
«Выполнена» if needed, then to «В работе» for re-closing. The closer uses the usual permission to
submit the updated amount. «Завершена» requires settled ticket review.
[ADR 0035](adr/0035-waste-fact-by-volume.md), [ADR 0135](adr/0135-waste-request-completed.md)

If the type was wrong after work was recorded, use the authorized corridor down to «В работе» and
then roll back from «В работе» to «Новая» with a reason. Cancel only after this reset clears the
fact and ticket numbers. If it was already cancelled from «В работе», restore it to «Новая», put it
in work and perform that same reset. The replacement can use a fresh upload of the same paper.
[Status corridors](../packages/contracts/src/enums.ts)

## 2. Contracts and stored data

Use contract predicates for the independent decisions below. Derive SQL type lists from those
predicates and `REQUEST_TYPES`. Preserve the current shape and pricing branches of legacy garbage,
scrap and container requests.
[Waste request contracts](../packages/contracts/src/waste-requests.ts),
[Pricing contracts](../packages/contracts/src/waste-tariffs.ts)

| Rule                               | Garbage                            | Snow              | Scrap | Container operations |
| ---------------------------------- | ---------------------------------- | ----------------- | ----- | -------------------- |
| Ordered volume required            | ≥ 8 m³                             | ≥ 8 m³            | —     | —                    |
| Waste type in the payload          | Selected                           | Set by the server | —     | —                    |
| Tariff snapshot and estimate       | From the price list when available | —                 | —     | —                    |
| Completion unit                    | m³                                 | m³                | t     | —                    |
| Completion money                   | Manual or calculated               | Manual            | —     | —                    |
| Tab statistics kind                | `waste`                            | `snow`            | —     | —                    |
| Unreviewed paper counts before OCR | Yes                                | Yes               | —     | —                    |

- Keep `isPricedRequestType` for tariff eligibility. Use separate predicates for ordered volume,
  requester-selected waste type, completion measure, manual-only cost and the unreviewed-paper rule.
  In `createWasteRequestStableSchema`, require snow volume and apply the same minimum to the
  effective volume on PATCH. Bound the snow input to the storage range of `volume_m3`. Omission on
  PATCH keeps the stored volume. Compare the saved and requested types before validating the new
  subject. Equal types are valid, and an actual change to or from `snow_removal` gets the same
  field-level explanation in the portal and API.
- Resolve the service type through a contract mapping from `snow_removal` to the reserved code
  `snow`. The migration gives «Снег» a fixed reserved UUID for the SQL constraints. The request
  stores that UUID, ordered volume, count 1 and NULL container type and owner. Its
  `waste_tariff_id`, `price_per_m3` and generated `amount` are all NULL.
- Snow completions use the existing volume arm of the completion DTO and table. Price per m³ and
  tariff ID are always NULL. The optional `total_cost` uses the existing nonnegative cost
  validation. Accept numeric amounts and validate the exact value of numeric strings before
  coercion. Reject inputs outside the currency range or precision, including strings that would
  underflow to a false zero. Blank strings, booleans and arrays fail validation. The first
  completion stores NULL for an omitted or null cost. On re-close an omitted cost keeps the saved
  value, explicit null clears it, and 0 is a known amount. The server skips snapshot and fallback
  resolution for snow. Garbage keeps the existing snapshot, lookup and computation rules.

## 3. Implementation

### 3.1. Migrations and the live API window

Assign numbers after the current maximum and recheck before staging. Before applying any of the
feature migrations, check the proposed reserved UUID, code and generated normalized name key for
collisions. Verify that the running application role can read the migration journal. Mirror the enum
and checks in the typed DB schema. [Drizzle schema](../apps/api/src/db/schema.ts)

1. Add `snow_removal` after `waste_removal` in `request_type`, in a migration that only extends the
   enum. Refer to the new value in a later committed file, as in the scrap migration pair.
   [Enum migration](../apps/api/drizzle/0090_metal_removal_request_type.sql)
2. In one transaction, acquire bounded DDL locks, install the guards and seed the reserved row by
   plain INSERT. Abort on a UUID, code or normalized name clash and resolve it with the owner. The
   SQL constraints and INSERT enforce the result even if a writer races the preflight.
   - Keep the reserved row's UUID, code, canonical name and active state bound together with a
     CHECK. Protect the row from deletion. Reject a tariff targeting the reserved UUID by CHECK,
     including an inactive tariff.
   - Add `waste_requests_snow_subject_check` with a NULL-safe, two-way identity rule. A row uses the
     reserved UUID exactly when its type is `snow_removal`. A snow row also requires a volume of at
     least 8 m³, empty container fields, a count of 1 and NULL tariff and price. A NULL volume or
     waste type fails explicitly. Legacy rows retain their existing shape.
   - Use a bounded lock timeout for live schema changes. Add checks on large tables with `NOT VALID`
     in the seed transaction so they protect incoming writes immediately. Validate those checks in a
     following committed migration with a weaker lock. Rehearse the lock window on data of
     representative size.
     [Runbook](runbook.md#a-migration-fails-with-canceling-statement-due-to-lock-timeout)
3. Add the release entry in its own migration. Rehearse the old API, worker and ordinary writes
   after each committed migration prefix before replacing containers. The old tariff selector can
   see the seeded type through its unfiltered list. The SQL guards must already stop it from being
   priced, repurposed or used by any ordinary request.
   [Old tariff selector](../apps/web/src/features/waste-tariff-editor/model/useWasteTariffEditor.tsx)

### 3.2. API, directories and tickets

- Both create routes use the normal stable schema and receipt identity. Build the initial response
  from the authorized insert transaction, including its file links. For keyed creation, freeze the
  response in the receipt before committing that transaction. The unkeyed path returns the same
  creation snapshot. The effective subject for snow comes from server-side lookup by reserved code
  on create and PATCH. The server discards any caller-supplied waste type for snow. Garbage rejects
  the reserved ID before pricing. Use the existing normalization for containers and scrap. Apply the
  type-change guard before resolving the subject and before the existing fact-unit guard. Enforce
  the existing site and counterparty scopes in creation, edit, assignment, delete and receipt
  replay. For creation and reassignment by a counterparty-scoped actor, the effective operator must
  be their own. An omitted operator on creation cannot satisfy this scope. Require the existing
  assignment permission and use the established site binding rule, including its fallback for sites
  without any operator links. Count all links for that fallback, including links to inactive or
  archived operators. Use the same eligibility input on the portal and keep the version check in the
  transaction. [Waste request routes](../apps/api/src/routes/waste-requests.ts),
  [ADR 0231](adr/0231-request-create-receipts.md),
  [ADR 0247](adr/0247-create-attempt-reconcile-by-key.md)
- Build request, history and ticket detail responses from one authorized snapshot of the row and its
  related data. Mutation handlers build full DTOs before releasing the request lock. A move or
  assignment committed afterwards cannot contribute attachments, comments or other data to the
  response. Apply the same snapshot rule if a legacy receipt has to be completed after a failed
  first send. Before emitting any response, apply the current file visibility and quarantine rules
  to the attachment IDs it contains. This applies to the first send and both replay paths, including
  previously stored legacy responses and detached files. Reuse the shared file view to mask a
  quarantined filename and include its quarantine flag. Suppress the filename if current file
  visibility cannot be established. Read these flags by the saved IDs without loading a fresh
  attachment list or replacing the receipt's other frozen fields. Use the same mask for historical
  filenames, including audit entries for late tickets.
  [File view](../apps/api/src/services/file-view.ts),
  [ADR 0183](adr/0183-service-estimate-exemption-and-document-submit.md)
- Assignment and removal of the operator keep both price fields NULL for snow. Completion runs the
  existing status transition and ticket count in the same transaction as fact storage. Include the
  stored removal day in the completion DTO so re-closing can retain it. In «Выполнена» → «В работе»
  the saved completion and tickets are available to re-close. A second snow completion with fact or
  ticket data against a request already in «Выполнена» returns 409. On conflict, reload the saved
  fact and ticket links before the user retries or discards uploads. Recheck the current state and
  version under the request lock before writing the fact or files. A concurrent update that loses
  the version check rolls back its whole transaction. Require each new ticket in completion and late
  attachment to be active after storage verification. A pending upload must finish through the file
  completion route before it can count as a ticket.
  [Status routes](../apps/api/src/routes/waste-requests.ts),
  [ADR 0189](adr/0189-waste-tickets-after-done.md)
- Use the shared status corridor and reflect its entry rights in the access manifest. A reviewer
  with `wasteRequests.ticketReview` can place the terminal status after settling the paper. Other
  transitions require the ordinary status right and the applicable role and rollback checks. Keep
  both the site and operator scope checks in this path.
  [Permissions](../packages/contracts/src/permissions.ts),
  [Access manifest](../apps/api/src/lib/access-manifest.ts)
- Serialize delete, restore and purge with status and edit writers. Acquire the request row lock
  first and check scope, status and archive state from the locked row. Require the version and
  confirmed mode for a snow delete, and the confirmed archived version for a snow purge. The server
  rejects drift with 409 before any writes, and the portal reloads before asking for a new
  confirmation. A confirmation to archive cannot turn into a hard delete after rollback to «Новая».
  Reuse the purge audit handling. Archive and restore advance the row version.
  [ADR 0070](adr/0070-request-archive-tab.md)
- Exclude the service type from editable waste-type lists. Refuse edits and purge of the service
  row, checking its identity in both routes. Tariff POST and PATCH reject its ID and tariff
  resolution refuses it before lookup. Resolve UUIDs as UUIDs regardless of case. At name-based
  entry points, use the database's `waste_type_name_key`, including tariff POST by new name. Use a
  field error explaining «Для вывоза снега стоимость вносится при закрытии заявки».
  [Waste type routes](../apps/api/src/routes/waste-types.ts),
  [Tariff routes](../apps/api/src/routes/waste-tariffs.ts)
- In Excel transfer, leave the service row out of editable exports and the import match set. Reject
  a reference to its UUID and reject an incoming reserved code or normalized name in type imports.
  Reject service codes in tariff preview and apply. Test a file whose service row UUID is intact but
  whose name and code have both been changed, as imports match UUID before code. Both entry points
  keep the database protections in §3.1.
  [Directory transfer](../apps/api/src/services/directory-transfer/defs/waste.ts),
  [ADR 0073](adr/0073-directory-exchange-xlsx.md)
- OCR is already enqueued for all types. Extend the unreviewed-paper type predicate used by the
  badge input, the `ticketReview=pending` list fallback and the review-state recompute script. It
  covers garbage and snow. The same badge guards terminal completion. Keep file and page failures,
  the per-file paper requirement, reconciliations and the review permission. A manual confirmed
  ticket settles a successfully read file with no detected ticket. If OCR was off or recognition
  failed, restore the service or scan and rerun recognition. For an unusable original, use the
  authorized reset to «Новая» and re-close with a usable scan. Correct any text that offers manual
  entry alone for an unread or failed file. Ordinary edit removes only request attachments. The
  authorized reset to «Новая» removes ticket links and associated review data. Terminal review loads
  the request and its evidence through the same transaction under the existing request lock. Overlay
  live OCR jobs for attached files on the badge and pending list as well as the terminal check. Use
  pending and running queue state from enqueue to outcome, including a forced rerun of a file with
  an earlier accepted reading. Reuse the existing live job for that file under the request lock
  instead of enqueueing a duplicate. Read the live condition alongside materialized review state so
  an older attempt cannot clear another attempt's outstanding review. A latest attempt that died
  before writing a file result still counts as failed. A skipped attempt can reuse an intact earlier
  outcome. If it left a pending file without a committed outcome, the paper needs review again even
  if there was an earlier accepted ticket. On re-close, offer «Перераспознать» for that paper. After
  a job completes, its unresolved reread proposal keeps a non-dismissed ticket pending until the
  reviewer accepts or dismisses it, even if the earlier reading was confirmed. Feed that condition
  into the same badge, pending list and terminal guard. Bump the saved badge format version so
  earlier counts are refreshed and existing accepted discrepancies keep their fingerprints.
  Replacing an invalid file after reset requires a new upload.
  [Ticket inputs](../apps/api/src/services/waste-ticket-inputs.ts),
  [Review state](../apps/api/src/services/waste-ticket-review-state.ts),
  [Recompute script](../apps/api/scripts/recompute-ticket-review.ts),
  [ADR 0150](adr/0150-ticket-recognition-all-request-types.md),
  [ADR 0155](adr/0155-waste-ticket-auto-confirm.md)

### 3.3. Web

- In the editor, separate the volume field, waste-type choice and tariff state. Send snow `volumeM3`
  on create and edit. Omit the waste type and clear fields for a container operation. Skip the
  tariff lookup. Use the same shape when saving and restoring local drafts. On a type switch in the
  create form, filter hidden fields out of the payload. A pending receipt retries its original body
  and key even across a reload. Edit choices follow the type-change predicate. A counterparty-scoped
  creator needs the existing assignment right, and the create form can submit only their own
  operator when eligible for the chosen site. The portal and API use the same access rule.
  [Waste request editor](../apps/web/src/features/waste-request-editor),
  [ADR 0230](adr/0230-request-local-drafts.md)
- The completion form resets volume, cost and actual date for each target. Prefill from the saved
  completion when correcting it. For snow, skip the tariff query, price line and any cost
  recomputation as the actual volume changes. Submit NULL for a cleared amount and preserve zero.
  [Completion form](../apps/web/src/features/waste-request-completion)
- Bind uploads and async save callbacks in the editor, completion and late-ticket forms to their
  target and opening. A response for a closed or replaced form cannot add its file, satisfy a ticket
  requirement or close a newer form, even when the same request was reopened. Retain files
  referenced by an unresolved save or frozen receipt until the server outcome is known. Cleanup
  takes the same file row lock as attachment and rechecks the current links and quarantine before
  deleting or scheduling storage deletion. This protects the files of a completion or late
  attachment that committed while the form was closing.
  [Late-ticket attachment](../apps/web/src/features/waste-ticket-attach)
- Use the type label in the feed, card, history and archive. The subject formatter must display
  ordered volume even without a tariff, and the card shows «Снег» and ordered volume outside the
  pricing section. Show the recorded completion amount or an «ожидает ввода» note in the fact block.
  Show the history summary only when it and the list match the selected filters. Add counts of
  completed snow requests with and without a recorded cost to the history summary. Preserve the
  numeric total for legacy clients. For a snow-only selection, show a dash when all costs are absent
  and flag incomplete sums. A recorded 0 remains a known cost. Check the narrow/mobile views.
  [Request presentation](../apps/web/src/entities/waste-request),
  [Request card](../apps/web/src/widgets/waste-request-view)

### 3.4. Monthly statistics and analytics

- Add `kind: 'waste' | 'snow'` to the monthly stats query with default `waste`. Echo it in the
  response. Pass month, kind and the existing site scope into the shared atom load. The SQL type
  filter runs before atoms and quality counts are calculated. Preserve the audience guard, including
  refusal to operator and worker-cabinet accounts. Keep the old garbage response fields and allow
  requests that only carry `month`. [Stats contract](../packages/contracts/src/waste-stats.ts),
  [Stats service](../apps/api/src/services/waste-stats.ts)
- Snow volumes use the same attribution date and ticket rules as garbage. Ordered volume comes from
  all valid requests, while removed and ticket figures follow `analyticsCountsAsFact` (`done` and
  `completed`). The plan and ticket cost fields are NULL for snow, even at zero volume. Their
  unpriced-volume warnings do not apply. Removed cost sums the entered amounts, including zero. Show
  a dash if no amount is known and flag only the factual volume with missing cost. An unfinished or
  rolled-back request with no estimate does not count as missing a price.
  [ADR 0209](adr/0209-waste-stats-three-volumes.md),
  [ADR 0213](adr/0213-waste-stats-ticket-warnings.md)
- Set the book's `priced` flag from the same fact-status and cost rule for manual-cost snow. Keep
  the shared atom loader so `GET /analytics/summary` and Excel use those same counts and amounts.
  The reserved waste type supplies the «Снег» position in the waste module and keeps it separate
  from other positions. Include snow in the module totals and quality counts. The existing
  price-quality denominator is the count of all requests in the scoped data set. The numerator for
  snow counts only fact-status requests with a NULL total. Align the workbook's methodology and the
  export form with the rule that snow has actual amounts when entered and no estimate. Keep exact
  kopeck arithmetic through the final combined or derived report total and convert once to the
  precision of the existing numeric output formats. Compare common figures over the same scope and
  period using garbage and snow fixtures. The book's broader waste module also has scrap and
  container positions. Confirm the snow position and its numeric amounts in the workbook.
  [Waste atoms](../apps/api/src/services/analytics/facts-waste.ts),
  [ADR 0182](adr/0182-analytics-summary-export.md)
- The switch writes `kind` with `tab=stats` and `month` in the URL. Validate incoming values and
  default to «Мусор». Key the React Query cache by both month and kind under the waste request root.
  Reset pagination and close the site window on a switch. Only render figures for the current kind,
  including under slow and out-of-order replies. Use the same presentation for rows, totals and the
  site detail. Validate the renderable response shape, month and kind before caching or rendering. A
  malformed or mismatched reply gets a local stats error and may retain data only for the same month
  and kind. Missing snow cost refers to the manual invoice amount. Keep unread and unconfirmed
  ticket warnings on the ticket volume. Count failed scans, including a failed page or a dead latest
  attempt, once per file. A failed scan is excluded from the count of successfully read scans
  without a ticket. [Statistics tab](../apps/web/src/pages/waste/WasteStatsTab.tsx),
  [Figure formatting](../apps/web/src/pages/waste/wasteStatsNumbers.ts)

### 3.5. Browser compatibility and deployment

An open tab from before this release lacks the snow label and uses the ticket-only completion flow
for an unfamiliar type. Use explicit negotiation on waste request endpoints and the existing 426
refresh response for a direct request the open tab cannot handle.
[Client upgrade handling](../apps/web/src/shared/api/clientContract.ts),
[Waste request client](../apps/web/src/entities/waste-request/api/wasteRequestsApi.ts)

- A snow-capable portal sends `X-Waste-Request-Capability: snow-removal-v1` on waste request calls.
  `GET /waste-requests/capabilities`, protected by `wasteRequests.read`, confirms that the serving
  API supports the type. The capability selects compatible request and response shapes.
  Authentication, role rights and scope checks are still mandatory. Put the header and token in the
  contracts so browser and API use the same values.
- Without the capability, apply one shared legacy type filter to the feed, archive, status counts,
  history list and history summary before pagination and totals. Existing container-only queries
  already exclude snow by subject. For a direct snow request, first enforce the normal permissions
  and scope. Then respond with the existing `426 client_upgrade_required` before returning a snow
  DTO or mutating the request. Cover detail, request history, edit, status, operator, comment,
  ticket attachment, delete, restore, purge and create receipt replay. Require the capability for
  snow creations and explicit snow filters. For both the early receipt lookup and the replay after
  an insert conflict, use the stored request ID to check the current row's site, operator and
  archive scope before returning the frozen response. Keep the header out of the saved fingerprint.
  Type-neutral paper review and blind-check endpoints use their existing ticket scopes and payloads.
  Links from them to the request pass through the guarded detail route. Receipt reconciliation by
  key uses the receipt identity and may still recheck a frozen attempt.
- On a new portal against an old or temporarily unavailable API, hide snow creation and filters when
  the server has not confirmed support. Recheck support on opening the waste editor and stats and on
  entry to feed and history filters. Skip snow queries and new submissions while support is
  unconfirmed, before freezing a new create attempt. Preserve an already frozen save and use receipt
  reconciliation when needed. An unsupported snow deep link shows an unavailable state. Garbage
  stats keeps `?month=` and accepts an older response without a kind. Snow stats requires an echoed
  `kind=snow`. Display an unavailable state on rejection, even if a recent capability check
  succeeded.
- For the normal rollout, verify the current OCR worker and the candidate's ticket flow before
  deployment. The old worker can handle the new API's jobs because the payload and link query are
  type-independent. Rehearse the mixed window. The ordinary deploy brings the schema, API and portal
  in one release. Browser negotiation lets older tabs keep their ordinary waste workflows during the
  rollout. [Recognizer job](../apps/worker/src/ticket-ocr/job.ts), [Runbook](runbook.md)
- When migration fails after a committed prefix, the old API can keep serving while its process
  stays up. Pause any operation that restarts it until the failed migration can be retried forward
  or an image and a matching journal are restored. Schema rollback follows the runbook's PITR
  procedure with matching images and an explicit decision about writes since the restore point. The
  runbook's usual narrow teardown applies only to cutover releases. [Runbook](runbook.md),
  [Schema startup check](../apps/api/src/db/migration-check.ts)

## 4. Acceptance cases

- **Requests and permissions.** File snow at exactly 8 m³ without supplying a waste type. Reject
  missing or smaller volume. Edit volume without changing type. Test conversions to and from all
  other types and replay after loss of the original create response. Move and archive a request
  between send and replay and check live scope on both replay branches. Move the record just after
  the initial insert commits and prove its first response contains only the creation snapshot. Cover
  responses from authorized writes followed immediately by reassignment. Quarantine an attachment
  between snapshot and response, then repeat with a frozen replay. Expect the live mask on both
  receipt branches and on a legacy stored response. Use separate site requester, dispatcher,
  assigned operator and reviewer accounts. Also test an out-of-scope grant and a reviewer with
  ticket review but no ordinary status right. A counterparty granted creation without an in-scope
  operator cannot create an out-of-scope request. Verify that a creator with both rights can use the
  form to file for their own eligible operator. Include a site whose only binding is to an inactive
  operator.
- **Directory and DB.** Try a mismatched or NULL subject and volume below 8 m³ via SQL. Cover HTTP
  edits, purge and tariffs, plus XLSX preview and apply by ID, code and name, including uppercase
  UUIDs and normalized name collisions. Verify a clean export/import round trip of ordinary data.
- **Close and review.** Test omission, NULL, nonzero, zero and malformed cost, missing tickets, late
  attachment, recovery after OCR off and failure, and full terminal completion. For both ticket
  write routes, reject an upload session that never completed storage verification. Quarantine a
  late ticket after its audit event and check that history masks its filename. Exercise terminal
  review with an API pool size of one. Test a rerun queued against terminal completion, a completed
  rerun with an unanswered proposal on a confirmed ticket, concurrent rerun requests for one file,
  re-close while OCR is queued, a job expiring before worker start, and skipped retries over
  previously read and failed scans. Submit two distinct completions with uploaded tickets, both
  overlapping and after the first commit. Test wrong-type reset and refile with the same paper. Race
  archive and purge against restore, scope change and work start. Confirm a stale archive after
  rollback to «Новая» and verify the request and files survive. Switch forms while an upload is
  pending and verify the new form stays empty. Include reopening the same request. Race file discard
  against a completion or late attach and retain committed links. Close two different requests
  across a month boundary with independent dates. Re-close a request delivered on the last day and
  removed on the first. Change only the cost and preserve the removal month, original tickets and
  date reconciliation. Cover date omission and explicit clearing through the API.
- **Stats, history and analytics.** Use a shared site and month with both kinds. Test empty,
  partially priced, zero and unpaid snow facts in `done`, `completed` and rolled-back requests.
  Check audience/scope, row, total, site modal, ticket warnings, reload/back/forward and delayed
  replies, including history list versus summary, a wrong-month reply and malformed data. Reconcile
  factual volumes, exact costs and missing costs with the summary module totals and the «Снег»
  detail row in the actual Excel export. Cover a partially failed scan without double counting and
  large legal amounts grouped by site. Compare numeric output within the format's representable
  precision, including a combined total above exact cent precision.
- **Rollout.** Run each committed migration prefix on isolated PostgreSQL 16 and 17 with the
  previous API and worker still serving ordinary workflows. Exercise UUID, code and normalized name
  collisions and safe retry. Assert that old web gets a coherent legacy list, history summary and
  426 on direct snow, and that the new web handles old API capability, filters, receipts and stats.
  Test a complete mixed-version OCR job with an existing worker stub.

Run `pnpm check`, `pnpm check:db` against its own fresh database, `pnpm check:docs` and the bundle
budget check when implementing. Use isolated databases for the rollout rehearsal.

## 5. Integration and release

1. Implement the contracts, seed and DB guards, API, and targeted DB tests. Implement the web and
   statistics changes under the same compatibility plan.
2. Write the English ADR using the current header and domain dictionaries. Link the applicable
   decisions and update the code map and schema digest. Rebuild the ADR index with
   `pnpm docs:index`. Confirm the ADR, migration and release sequence numbers on the final base.
3. Include the release migration and `VERSION` in the one feature push. Verify with
   `pnpm check:version`. Tag the commit that introduced the release migration, push the annotated
   `v<version>` tag immediately and verify it with `pnpm check:version -- --tags --remote`. Use the
   rollout checks in §3.5. [Release notes](adr/0077-release-notes.md),
   [Versioning](adr/0191-version-numbering.md), [Tag procedure](runbook.md#тег-выпуска-adr-0191)

### Release text

> В разделе «Вывоз мусора» появился тип заявки «Вывоз снега». Укажите объект, дату, объём от 8 м³ и
> ответственного. Тип мусора определяет портал. При выполнении приложите талон и внесите стоимость,
> если она известна. На вкладке «Статистика» переключатель «Мусор / Снег» показывает раздельные
> итоги.

## 6. Implementation checks still open

- Check a sample from a snow-melting site when available. Production deployment needs a working OCR
  and review flow for scans carrying the fields used by garbage, including volume in m³. Reproduce
  success and failed-file recovery before deployment. If real paper needs a different measure or a
  manual-only corridor, agree on that decision before changing the review rule.
- Measure the final entry and waste route bundle sizes. A budget increase requires the owner’s
  approval under the repository rules.
