# ADR 0250. Snow removal: a request type with a service waste type and a manual cost

- Статус: Реализовано (25.11.2026), release 0.1.146.0250; not deployed
- Домены: вывоз-мусора, справочники, файлы-и-распознавание
- Изменяет: [ADR 0135](0135-waste-request-completed.md) — decision 4 is now also true at the route:
  a holder of `wasteRequests.ticketReview` places «Завершена» without `wasteRequests.status`;
  [ADR 0070](0070-request-archive-tab.md) — a waste request delete and purge carry the confirmed
  version and mode, archive and restore advance the version, purge checks the request scope;
  [ADR 0150](0150-ticket-recognition-all-request-types.md) — unreviewed attached paper counts for
  snow as for garbage
- Связано: [ADR 0009](0009-waste-pricing.md), [ADR 0019](0019-container-ops-without-pricing.md),
  [ADR 0022](0022-waste-removal-by-volume.md), [ADR 0035](0035-waste-fact-by-volume.md),
  [ADR 0067](0067-metal-removal-request.md), [ADR 0073](0073-directory-exchange-xlsx.md),
  [ADR 0155](0155-waste-ticket-auto-confirm.md), [ADR 0182](0182-analytics-summary-export.md),
  [ADR 0189](0189-waste-tickets-after-done.md), [ADR 0209](0209-waste-stats-three-volumes.md),
  [ADR 0213](0213-waste-stats-ticket-warnings.md), [ADR 0230](0230-request-local-drafts.md),
  [ADR 0231](0231-request-create-receipts.md), [ADR 0247](0247-create-attempt-reconcile-by-key.md),
  [ADR 0077](0077-release-notes.md) and [ADR 0191](0191-version-numbering.md) (release entry);
  plan — [snow-removal-plan.md](../snow-removal-plan.md)
- Область: contracts — [waste-requests.ts](../../packages/contracts/src/waste-requests.ts),
  [waste-stats.ts](../../packages/contracts/src/waste-stats.ts),
  [enums.ts](../../packages/contracts/src/enums.ts); schema —
  [0427](../../apps/api/drizzle/0427_snow_removal_request_type.sql),
  [0428](../../apps/api/drizzle/0428_files_storage_verified.sql),
  [0429](../../apps/api/drizzle/0429_snow_removal_guards.sql),
  [0430](../../apps/api/drizzle/0430_snow_removal_subject_validate.sql),
  [schema.ts](../../apps/api/src/db/schema.ts); API —
  [waste-requests.ts](../../apps/api/src/routes/waste-requests.ts),
  [waste-types.ts](../../apps/api/src/routes/waste-types.ts),
  [waste-tariffs.ts](../../apps/api/src/routes/waste-tariffs.ts),
  [waste-tickets.ts](../../apps/api/src/routes/waste-tickets.ts),
  [files.ts](../../apps/api/src/routes/files.ts),
  [waste-stats.ts](../../apps/api/src/services/waste-stats.ts),
  [facts-waste.ts](../../apps/api/src/services/analytics/facts-waste.ts); portal —
  [waste-request-editor](../../apps/web/src/features/waste-request-editor),
  [waste-request-completion](../../apps/web/src/features/waste-request-completion),
  [WasteStatsTab.tsx](../../apps/web/src/pages/waste/WasteStatsTab.tsx)

## Context

The construction sites order snow removal from the same operators that remove garbage, through the
same paper: an ordered volume, a removal ticket at completion, the operator's invoice. Until now it
was filed as garbage with a made-up waste type and a price-list estimate that never applied, so the
monthly statistics and the summary book mixed snow invoices into garbage figures. The owner's survey
of 25.11.2026 fixed the shape (S1–S13 in the plan): a separate request type offered right after
one-off garbage removal, a server-owned waste type «Снег», at least 8 m³, operators and assignment
rights as for garbage, a required ticket and the garbage review rules, and no price list at all — the
cost is entered by hand at completion and may be missing. The plan went through six review rounds
and two judges before implementation; its final text is the reference for the details below.

## Decision

1. **A request type, not a waste type.** `snow_removal` («Вывоз снега», colour `cyan`) follows
   `waste_removal` in the enum and the form. The differences from garbage are separate contract
   predicates — ordered volume, requester-selected waste type, completion unit, manual-only cost,
   unreviewed-paper rule — so that a later type can take one rule without inheriting the others.
2. **The waste type is a reserved service row.** «Снег» is seeded by migration with a fixed id and
   code `snow`. The database binds id, code, canonical name and the active flag together, forbids
   deleting the row, refuses any tariff on it and requires a request to carry it exactly when its
   type is snow, with an ordered volume of at least 8 m³ and no container, tariff or price. The API
   resolves the row by code, discards any waste type a caller sends for snow, refuses the reserved id
   for garbage, hides the row from editable lists and refuses it in tariffs, pricing and Excel
   transfer. The guards are in force from the migration on, so the previous API serving during the
   deploy cannot price, repurpose or reuse the row.
3. **The cost is manual and may be missing.** No tariff snapshot, estimate or computed sum for snow.
   The first completion stores the entered amount or NULL; a re-close keeps an omitted amount and
   removal day and clears them on explicit null; 0 is a known amount. Statistics flag removed snow
   without an invoice amount, and the history summary counts completed snow with and without a cost.
4. **A filed type does not change to or from snow** (S12). A wrong type is cancelled and filed
   again; the paper may be uploaded afresh.
5. **Statistics by kind.** `GET /waste-requests/stats` takes `kind=waste|snow` (default garbage) and
   echoes it; the portal switch «Мусор / Снег» renders only a reply of the selected month and kind.
   Snow has no planned or ticket money. The summary book shows «Снег» as its own position in the
   waste module with manual amounts counted as priced.
6. **Ticket paper is reviewed as for garbage**, including recovery when recognition was off or
   failed, live recognition jobs and unanswered reread proposals holding the review open. Both ticket
   write paths accept only uploads whose storage the completion route verified.
7. **Responses come from one authorized snapshot**, built under the request lock inside the
   transaction that wrote it; frozen receipt responses are re-checked against the current scope and
   the current file quarantine before they are returned.
8. **Archive, restore and purge run under the request lock.** A delete carries the confirmed
   version and mode, and a purge the archived version; the server compares them with the locked row
   and answers 409 before any write, so a confirmation to archive never becomes a hard delete after a
   rollback to «Новая». Both are required for snow and checked when a tab sends them for the older
   types. Archive and restore advance the row version, and purge checks the request scope, which the
   shared purge route did not.
9. **Older tabs are negotiated, not floored.** A snow-capable portal sends
   `X-Waste-Request-Capability: snow-removal-v1`. Without it the API hides snow from lists and
   summaries and answers a direct snow request with the existing `426 client_upgrade_required` after
   the normal permission and scope checks; snow creation, explicit snow filters and the snow
   statistics need the header too. A global client floor was rejected: the deploy tooling applies a
   floor to the whole portal, and a partial rollout would lock out every older tab for one request
   type.

10. **Ordinary edit removes only attachments.** A ticket id in `removeFileIds` is refused: unlinking
    it cascaded away the recognition rows and left a ticket without a page that then settled read
    files as a manual one. Tickets leave only with the authorized reset to «Новая».

## Consequences

- The garbage, scrap and container flows keep their shape and pricing. The exact cost parser now
  refuses blank strings, booleans, arrays and underflowing numbers for every type.
- The review of ticket paper is stricter for every type that has one. A recognition job that is
  queued or running holds completion; a latest attempt that died before writing a result counts as
  failed; an unanswered reread proposal keeps a confirmed ticket pending; a repeated «Перераспознать»
  reuses the live job. The statistics count a scan as unread by the same rule, so garbage months
  with failed pages or dead jobs show more unread scans and fewer scans read without tickets
  (ADR 0213, decision 4). The saved review state format was raised to 2, so stored counts refresh.
- **The format bump has a visible cost after the deploy.** `WASTE_TICKET_REVIEW_STATE_VERSION` 1 → 2
  changes the input fingerprint of EVERY stored review-state row, and the «Требуют разбора» register
  reads a row with a foreign fingerprint as "not known, so show it" (ADR 0155, R21). Right after the
  restart every request with paper — garbage and snow alike, settled ones included — is listed there
  until its row is recomputed: lazily, when its list row or card is read, or in bulk by
  `pnpm --filter @technic/api recompute:ticket-review`. The register is briefly long, not wrong, and
  nothing real is hidden. The deploy runs the bulk warm-up once after the restart (runbook, «Snow
  removal request: steps after the deploy»); the same happened with the release of the stored state
  itself (`docs/waste-ticket-auto-confirm-plan.md`, R19).
- Scrap and container requests with an attached ticket whose recognition is queued, running or was
  interrupted now hold completion; receipts that were never queued stay outside review (ADR 0150).
- An upload completed by the previous API during the deploy window has no storage mark and is
  refused as a ticket; the person uploads the scan again.
- The migrations are forward-only. After 0427 the previous image refuses to start on the newer
  schema; a failed prefix is retried forward, and a schema rollback is the runbook's PITR procedure.
