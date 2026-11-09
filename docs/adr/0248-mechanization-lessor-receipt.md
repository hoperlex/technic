# ADR 0248. Mechanization: the lessor's receipt, its visa, and lessor accounts

- Статус: Реализовано (09.11.2026), release 0.1.142.0248; not deployed
- Домены: механизация, доступ
- Изменяет: [ADR 0152](0152-mechanization-module.md) — decision 6 (the mechanization lessor has no
  accounts: since this release he has, with exactly two permissions of his type) and the consequence
  "the executor status boundary is removed by the decision that gives the lessor accounts" (it is
  not removed — it stays unreachable, see «Why the executor status boundary of ADR 0152 stays,
  unreachable»); [ADR 0171](0171-mechanization-site-approval.md) — decision 3 (the visa holds only
  take-in-work: completion now also waits for an approved receipt or a «без чека» visa) and decision
  4 (a role without its own axis passes the visa circle unless it is an executor)
- Развивает: [ADR 0038](0038-executor-permissions-by-counterparty-type.md) (a fourth executor type
  with accounts), [ADR 0223](0223-portal-permission-oracle.md) (the receipt buttons are one
  contracts predicate over the server's permission list)
- Связано: [ADR 0032](0032-approval-not-automatic-for-admin.md) (approval is always explicit), [ADR
  0070](0070-request-archive-tab.md) (archive, restore, purge), [ADR 0077](0077-release-notes.md)
  and [ADR 0191](0191-version-numbering.md) (release entry), [ADR
  0106](0106-assignable-permission-grants.md) (permission sets and their barriers), [ADR
  0133](0133-service-request-unified-cycle.md) (decision 3: no date cutoffs in the schema), [ADR
  0140](0140-service-request-assign-in-card.md) (windows opened from a card live inside it), [ADR
  0235](0235-rental-completion-and-request-documents.md) (the `kind` column this design did not
  take)
- План: [mechanization-lessor-receipt-plan.md](../mechanization-lessor-receipt-plan.md), revision 4
  (03.11.2026), waves W1–W5; the plan's decision numbers `P1…P16` and owner answers `O1…O17` are
  used below
- Миграции: `0420` (schema, permission data step, `file_is_linked`), `0421` (release entry)
- Область: contracts —
  [mech-lessor-receipts.ts](../../packages/contracts/src/mech-lessor-receipts.ts),
  [mech-approval.ts](../../packages/contracts/src/mech-approval.ts),
  [mech-requests.ts](../../packages/contracts/src/mech-requests.ts),
  [permissions.ts](../../packages/contracts/src/permissions.ts),
  [permission-catalog.ts](../../packages/contracts/src/permission-catalog.ts),
  [grants.ts](../../packages/contracts/src/grants.ts),
  [grant-scope.ts](../../packages/contracts/src/grant-scope.ts),
  [request-history.ts](../../packages/contracts/src/request-history.ts); API — [migration
  0420](../../apps/api/drizzle/0420_mech_lessor_receipts.sql),
  [schema.ts](../../apps/api/src/db/schema.ts),
  [mech-lessor-door.ts](../../apps/api/src/routes/mech-lessor-door.ts) (the door guard),
  [mech-request-lessor-receipt.ts](../../apps/api/src/routes/mech-request-lessor-receipt.ts) (the
  three receipt doors), [mech-lessor-rentals.ts](../../apps/api/src/routes/mech-lessor-rentals.ts)
  (the lessor's reads), [mech-requests.ts](../../apps/api/src/routes/mech-requests.ts),
  [mech-lessor-receipt.ts](../../apps/api/src/services/mech-lessor-receipt.ts),
  [mech-lessor-rentals.ts](../../apps/api/src/services/mech-lessor-rentals.ts),
  [mech-request-guards.ts](../../apps/api/src/services/mech-request-guards.ts),
  [mech-request-list.ts](../../apps/api/src/services/mech-request-list.ts),
  [access.ts](../../apps/api/src/lib/access.ts), [files.ts](../../apps/api/src/routes/files.ts),
  [audit.ts](../../apps/api/src/lib/audit.ts),
  [access-manifest.ts](../../apps/api/src/lib/access-manifest.ts), [auth
  plugin](../../apps/api/src/auth/plugin.ts); portal —
  [mech-lessor-receipt](../../apps/web/src/features/mech-lessor-receipt), [lessor
  page](../../apps/web/src/pages/mech/lessor),
  [MechRequestsPage.tsx](../../apps/web/src/pages/mech/MechRequestsPage.tsx),
  [mechRequestMenu.tsx](../../apps/web/src/pages/mech/mechRequestMenu.tsx),
  [FilePreviewFrame.tsx](../../apps/web/src/entities/file/ui/FilePreviewFrame.tsx),
  [PdfPages.tsx](../../apps/web/src/entities/file/ui/PdfPages.tsx),
  [pdfjs-assets.ts](../../apps/web/scripts/pdfjs-assets.ts),
  [RequestHistory.tsx](../../apps/web/src/entities/request-history/ui/RequestHistory.tsx); tests —
  [mech-lessor-receipt-contracts.test.ts](../../apps/api/test/mech-lessor-receipt-contracts.test.ts),
  [mech-lessor-receipt.db.test.ts](../../apps/api/test/mech-lessor-receipt.db.test.ts),
  [mech-lessor-scope.db.test.ts](../../apps/api/test/mech-lessor-scope.db.test.ts),
  [route-authorization.test.ts](../../apps/api/test/route-authorization.test.ts),
  [mech-lessor-receipt.test.tsx](../../apps/web/test/mech-lessor-receipt.test.tsx),
  [mech-lessor-rentals.test.tsx](../../apps/web/test/mech-lessor-rentals.test.tsx)

## Context

A mechanization rental (ADR 0152) is paid against the lessor's receipt («чек»), and the office had
no place to keep it, no one to check it and nothing that stopped a rental from being closed without
it. The owner asked (02.11.2026) for a new approval step: after «Взять в работу» the lessor or the
dispatcher attaches the receipt, the visa holder of the rental reviews it in a window that shows the
receipt itself and approves or rejects it, and a rental is not completed without an approved receipt
or an explicit «без чека» visa. In the same release lessors of mechanization get portal accounts
with a narrow view of their rentals in work, so that they attach their receipts themselves.

That second half is the risky one: the module had one scope axis — the site — and an executor's site
scope is unlimited. Granting the lessor `mechRequests.read` without more would have shown him every
rental and every file of the company.

## Owner decisions

Five surveys of 02–03.11.2026 (plan §1), binding for the release:

| #   | Question                                               | Answer                                                                                                |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| O1  | From when can a receipt be attached                    | From «Взять в работу» (`new → confirmed`), at any point in «В работе»                                 |
| O2  | What waits for the approved receipt                    | Completion (`confirmed → done`) only; issue, extension and cancellation do not                        |
| O3  | Who approves                                           | The request visa circle of ADR 0171 decision 4: the site, and for a department request its department |
| O4  | One receipt or several                                 | One file, PDF or JPG                                                                                  |
| O5  | Preview                                                | The visa is given in a window that shows the receipt itself                                           |
| O6  | Lessor accounts                                        | In the same release as the receipt                                                                    |
| O7  | What the lessor sees                                   | A narrow card: no department, comment, requester files, visa, final cost or foreign history           |
| O8  | Replaced and rejected files                            | Kept: every version stays openable from the card's history while the request lives                    |
| O9  | Amount of the receipt                                  | No number: the file only                                                                              |
| O10 | A rental that will never have a receipt                | The visa holder allows completion «без чека» with a required reason, own button and own history event |
| O11 | PDF on phones (Android Chrome shows no PDF in a frame) | The portal renders PDF itself with pdf.js, loaded lazily only for receipt previews                    |
| O12 | Which rentals the lessor sees                          | Only «В работе» (`confirmed`); closed and cancelled rentals leave his list                            |
| O13 | Who replaces an approved receipt                       | Only the office; the lessor replaces a pending or rejected one                                        |
| O14 | May the one who attached a receipt approve it          | Yes: the permission and the visa circle decide, no "two keys" rule                                    |
| O15 | May the visa holder undo his approval                  | Yes, while the rental is «В работе»; the history keeps the event                                      |
| O16 | The executors' base `directories.read` for the lessor  | Accepted as for vehicle lessors; narrowing it for all executors is a separate task                    |
| O17 | Receipts of an archived request                        | Openable by holders of the archive without a restore; requester attachments keep today's rule         |

Also accepted from the description of 02.11: rentals taken into work before the release are not
gated at completion; no mail (the module has no mail contour — the visa holder finds work by a mark
and a filter); a deal change before issue and any return to «Новая» retire the current receipt;
«Вернуть в работу» (`done → confirmed`) keeps the approval.

Surveys of 09.11.2026 on production data, asked because the plan could not measure them: every site
with mechanization rentals in work has a holder of the visa (risk "completion stuck without a visa
holder" does not arise today); there are no rentals in work whose lessor is a `vehicle_lessor` (such
rentals are invisible to every lessor account, decision 11). The owner also approved that the scope
suite inserts a permission set directly into its test base for the O17 out-of-area case (no system
set gives `archive.read` to a site role), and that the block is pushed whole — W1–W5 with the
release entry in one push, so the completion gate never runs without the screens that satisfy it and
lessor accounts never exist without the lessor's page.

## Decision

1. **Versions: one table, a row per version, the current row is the one not retired** (P1).
   `mech_request_lessor_receipts` holds file versions (`file_id` set, status `pending`, then
   `approved` or `rejected`) and «без чека» waivers (`file_id` null, `waived`, born decided by the
   visa holder). At most one current row per request (partial unique index on `retired_at IS NULL`).
   Retiring stamps `retired_at/by/reason` (`replaced`, `deal_changed`, `rolled_back`, `revoked`) and
   never changes the status: the decision columns say what was decided, the retire columns why the
   version is no longer current, and one status column would lose one of the two facts. The single
   status change after a decision is the revocation of an approval (back to `pending`), whose fact
   lives in its strict event. `created_as` (`lessor` | `office`) is fixed at insert, so the lessor's
   view never derives it from an account that may change later. The base writes the rules it can
   hold alone: a waiver only from the office and decided by its author, a reason on a rejection and
   a waiver, a complete decision, a complete retirement, revocation retires only a waiver.
2. **"Lessor receipt" is the name everywhere** (P2): `receipt` already means the create receipt of
   ADR 0231, auto-part receipts and warehouse receipt lines. Code says `lessorReceipt`
   (`mechRequests.lessorReceipt`, `mechLessorReceiptAccess`), the portal «чек арендодателя».
3. **Completion waits for an approved or waived receipt — for rentals that require one** (P3).
   `mech_requests.lessor_receipt_required` is set by the server at `new → confirmed` and by
   attaching a receipt, and is never cleared. `mechLessorReceiptCompletionBlocker`, asked by
   `mechTransitionBlocker` for `to === 'done'`, refuses with «Чек арендодателя ждёт визы — аренду
   завершают после неё», «Чек арендодателя отклонён — прикрепите исправленный» or «Прикрепите чек
   арендодателя или получите визу „без чека“». It applies to every completion, including the repeat
   after «Вернуть в работу», and to the administrator (a state barrier, ADR 0152 decision 7): a
   stuck rental is closed by the «без чека» visa with a reason. A column, not "taken into work after
   a date": a date cutoff outlives everyone who remembers it (ADR 0133 decision 3), and an old
   rental that later got a receipt must be gated. `MechTransitionState` carries
   `lessorReceiptRequired` and `lessorReceipt` as **required** fields, so a caller that forgot to
   load the receipt does not compile; the status route loads the current row under the request lock
   on every transition. In the portal «Завершить аренду» stays in the menu, disabled with the
   barrier's text — the one blocked move that the menu shows instead of dropping.
4. **Attaching is its own permission, `mechRequests.lessorReceipt`** (P4), action «особые», requires
   `mechRequests.read`. The lessor must attach without `.status`, which would let him record the
   deal, the issue and the completion. "Whoever runs a rental also attaches its receipt" is an
   invariant held in three places: the office bundle (`MECH_REQUEST_OFFICE_PERMISSIONS`: manager,
   dispatcher), the requirement `.status → .lessorReceipt` in `PERMISSION_REQUIRES` (barrier 4,
   checked over every account's effective permissions after every access change), and the data step
   of migration `0420` (every set holding `.status`, deleted ones included, gets the row and a
   version bump). Barrier 4's generic text ("the account does not see the module") would be false
   for this pair, so `PERMISSION_REQUIREMENT_REASONS` gives it its own: «Ведущий аренду прикрепляет
   и чек арендодателя». The dictionary now holds 87 permissions, 81 of them assignable.
5. **Deciding is the request visa circle, signing the version it saw** (P5).
   `PATCH /:id/lessor-receipt` (`approve`, `reject` with a reason, `revoke` with a reason) under
   `mechRequests.approve` and `canApproveMechRequest`. The door keeps the module's protocol (lock →
   existence and scope → version 409 → subject checks) and reads the current row under the lock only
   to choose the words of the 409 («Чек заменили, пока окно было открыто — откройте его заново»).
   The write binds
   `id = receiptId AND request_id = id AND retired_at IS NULL AND status = expected`; the
   `request_id` term keeps a visa holder of one site from deciding another site's receipt through
   his own rental's id and version. `approve`/`reject` do not ask the rental's status (a pending
   receipt of a cancelled rental is still worth deciding); `revoke` is «В работе» only (O15): an
   approval goes back to `pending`, a waiver is retired `revoked`. The attacher may approve his own
   version (O14). `canApproveMechRequest` moved to the leaf module `mech-approval.ts` (the receipt
   rules import it, and `mech-requests.ts` imports the receipt rules) and answers an explicit
   `false` for counterparty-scoped roles: a role without its own axis passed the circle as the
   administrator does, and the visa must not rest on the executor simply lacking `.approve`.
6. **The «без чека» visa** (P6, O10). `POST /:id/lessor-receipt/waiver` with a reason, same
   permission and circle; allowed while the rental is «В работе» and the current version is absent,
   pending or rejected; it retires that version `replaced` and inserts a waiver. Two doors in the
   portal, one dialog: inside the visa window over a pending file, and its own menu item and card
   button when there is nothing to look at. Only the office replaces a waiver; the visa holder
   withdraws it with «Отменить „без чека“».
7. **Attaching and replacing** (P7). `POST /:id/lessor-receipt` with `{ fileId, version }`: module
   protocol; `mechLessorReceiptAttachBlocker` — only «В работе» («Чек прикрепляют к аренде в
   работе»), the lessor never over an approved or waived version («Утверждённый чек меняет
   диспетчер», O13), the lessor's cap of 20 versions **per account within the current deal**
   («Слишком много замен чека — обратитесь к диспетчеру»; the office has no cap, so a lessor's loop
   cannot lock the office out); the file must be the caller's own finished, unlinked, not
   quarantined upload of type PDF or JPEG («Чек принимается в PDF или JPG»; declared type, no byte
   sniffing). The previous current version is retired `replaced` with its status intact; the rental
   becomes `required`. Every door replies `{ version, lessorReceipt }` — the request's new version
   and the receipt block **for the caller's audience** (`MechLessorReceiptStateDto`, a union on
   `audience: 'office' | 'lessor'`), never the whole request; the portal invalidates its queries.
8. **What else touches the receipt** (P8). `PATCH /:id/deal` retires the current version
   `deal_changed` only when the lessor, the unit or the rate **as a number** changes (`1500` against
   a stored `1500.00` is no change). Any entry into «Новая» (`mechTransitionResetsDeal`, the chain
   through «Отменена» included) retires it `rolled_back`. Cancellation, «Вернуть в работу», issue
   revoke and the extension leave it. Delete of a «Новая» that has versions archives it instead of
   erasing it (`mechDeleteScope` takes the version count as a required argument); purge removes
   every version and its file (`collectMechRequestFiles`). Duplicating does not copy receipts.
9. **History and audit** (P9). Six strict actions (`writeAuditTx` in the transaction of the change,
   the closed list of `audit.ts`) — `mech_request.lessor_receipt_` plus `attach`, `approve`,
   `reject`, `revoke`, `waive`, `retire` — each its own history kind (`mechLessorReceiptAttached`
   …). Strict for the reason ADR 0152 decision 9 gives for money events: the receipt is the evidence
   of a payment, and a revoked approval survives only in its event. The attach event carries the
   file as `files` of the change; the history table got an optional `renderFiles` that the
   mechanization card passes, so every version opens from its history line (O8). Other modules pass
   nothing.
10. **Lessor accounts: the type gets two permissions, and nothing can add to them** (P10, O6).
    `COUNTERPARTY_TYPE_PERMISSIONS.mech_lessor` lists `mechRequests.read` and
    `mechRequests.lessorReceipt`. Everything computed from non-empty lists follows:
    `COUNTERPARTY_TYPES_WITH_ACCOUNTS`, `ACCESS_PROFILES` (`operator × mech_lessor`), the account
    form, `resolveCounterpartyId`. This **reverses ADR 0152 decision 6** ("the type has an empty
    list: no accounts — «операторов пока нет»"): the owner wants the lessor to attach his own
    receipts (O6), and an empty list was the only thing that kept accounts impossible. The line
    landed last in W2 (step 7), after the guard, the axis, the lessor's doors and his file rules —
    the module was unscoped for an executor before them. The administrator creates the accounts; no
    self-registration.
11. **The lessor's scope: deny by default, a second axis underneath** (P11).
    - **First line — the door guard** (`routes/mech-lessor-door.ts`). Every route of the
      mechanization instance (the extension and receipt doors included) refuses a
      counterparty-scoped principal with 403 «Арендодателю доступен только список его аренд» unless
      its config marks it `mechLessorDoor`. Three doors carry the mark: `GET /lessor-rentals`,
      `GET /lessor-rentals/:id` and `POST /:id/lessor-receipt`. The guard is a `preValidation` hook
      that authenticates by itself: `authenticate` is a route-level `preHandler` here, so a plugin
      `preHandler` would see no principal, and validation runs before `preHandler`, so an empty body
      would answer 400 and tell a prober which routes exist. `authenticate` became idempotent (the
      session loads once). A route added tomorrow is closed to the lessor unless someone marks it.
    - **Second line — the lessor axis.** `mechLessorVisibilityWhere` (his counterparty on the
      request's own `lessor_id`; an executor of another type gets `NEVER_MATCH`) joins the site axis
      in `mechScopeWhere` (list, summary, journal, export), and `assertMechScope` replaced every
      `assertPlaceObjectScope` of the module — card, history, every mutation, create, duplicate,
      restore, purge. A foreign rental is **404** for the lessor, deliberately unlike the vehicle
      lessor's 403: which request ids exist is not an external party's business.
    - **One predicate for everything he may touch**: `isMechLessorRentalVisible` — his counterparty,
      «В работе» (O12), not archived — with the SQL twin `mechLessorRentalVisibleWhere`, pinned
      against each other over a grid. His reads, his attach and his file flag ask it, so a closed
      rental leaves all three at once. Rentals whose lessor is a `vehicle_lessor` (ADR 0152 decision
      6 still lets the base hold that type) are invisible to every lessor account; production has
      none in work (survey of 09.11), and the office attaches their receipts.
12. **The lessor's own reads and DTO: an allow-list, not a mask** (P12).
    `GET /mech-requests/lessor-rentals` (the module's list envelope, filters «Период аренды» and
    «Чек», search over what his card shows, soonest return first) and
    `GET /mech-requests/lessor-rentals/:id` (404 when not his) answer `MechLessorRentalDto`, built
    field by field (`toMechLessorRentalDto`) from its own narrow query: number, version, status,
    model, site name and address, planned and actual dates, his rate and unit, the responsible
    person who meets the machine, and the receipt block. Not the department, the requester, the
    comment, the requester's files, the visa, the cancel reason, worked units, the final cost, the
    extension, the card history or versions of earlier deals. A field added to `MechRequestDto`
    tomorrow does not reach him. An office account at these doors gets 403. A version as he sees it
    (`MechLessorReceiptVersionView`) has no staff names (`created_as` instead) and no internal
    reasons — only a rejection's, because he has to fix something. **Deals are numbered on the
    request** (`mech_requests.deal_no`, bumped under the lock on a lessor/unit/numeric-rate change
    and on every entry into «Новая»; every version stamped with it at insert).
    `mechLessorVisibleVersions(versions, dealNo)` keeps the versions of the current deal and is the
    one function for his DTO, the doors' replies, the cap of decision 7 and his file flag.
13. **Files** (P13). `file_is_linked` got its eleventh branch (full `CREATE OR REPLACE` of the
    `0243` body plus `mech_request_lessor_receipts`): retired versions stay linked (O8).
    `canAccessFile` got the flag `visibleMechLessorReceipt` under `mechRequests.read`: for the
    office a version of a request visible by `mechScopeWhere`, of an **archived** request too for a
    holder of `archive.read` in his scope (O17 — the receipt is examined after archiving, while the
    request's attachments stay closed in the archive as before); for the lessor a version of the
    current deal of a rental `isMechLessorRentalVisible` gives him. The attachment branch never
    matches a mechanization lessor (O7), even for his own rental and a known id. The receipt FK to
    `files` is `ON DELETE RESTRICT`: the row carries a decision, and a future bug must fail loudly
    instead of removing an approved version; purge deletes the rows by cascade before the files.
14. **The preview renders the receipt itself** (P14, O5, O11). `FilePreviewFrame` (the body of
    `FilePreviewModal` without the window) shows JPEG as `<img>` and, in mode `pdf="pages"`, draws
    every PDF page to a canvas with pdf.js; only the receipt preview asks that mode, so no other
    screen changes. The renderer is a lazy chunk that neither the entry nor the mechanization route
    chunk carries. It fetches the signed storage URL with one plain `GET` (`disableRange`,
    `disableStream`), so the bucket's CORS (`GET` already allowed) is all it needs — no API
    fallback, the runbook forbids proxying files through the API. The portal's CSP is **unchanged**:
    worker, CMaps, standard fonts and the JavaScript JBIG2/JPX decoders are served from the portal's
    own origin (`assets/pdfjs-<version>/`, a Vite plugin), `useWasm: false` (no `wasm-unsafe-eval`
    in the policy), and pdf.js 6 has no `eval` left at all.
15. **The visa window and the receipt block** (P15). «Проверить чек» opens one window: the receipt
    on about two thirds of the width and the rental's facts beside it on a desktop (≥ 992 px), a
    full-screen sheet with the receipt on top and actions in a pinned footer on a phone; actions
    «Утвердить», «Отклонить», «Без чека», «Отозвать утверждение», «Скачать». The window holds the
    version it opened with; a 409 closes it with the server's words and refreshes the card. The card
    shows the strip «Чек арендодателя ждёт визы», the block with the current version and «Версии
    чека (n)» collapsed; the buttons come from `mechLessorReceiptAccess` over the server's
    permission list (ADR 0223), the same blockers the server answers with. Windows opened from the
    card live inside it (ADR 0140); the journal and the archive show the block read-only.
16. **Marks and the filter** (P16). `mechLessorReceiptMark` — «чек ждёт визы», «чек отклонён», «нет
    чека» — is a second tag next to the state tag, not a fifth state; archived rows show none. The
    filter «Чек» (ждёт визы, отклонён, нет, утверждён, без чека) is a parameter of the list, «В
    аренде» and the journal, served by `EXISTS`/`NOT EXISTS` over the current row, because the count
    query of the list joins only the site and the model.

### The kept `forbidden` cell and its new reason

`GRANT_SCOPE_MATRIX.mech.counterparty` stays `forbidden`, so barrier 3 refuses every
`mechRequests.*` permission to the executor role, in a set's contents and at assignment. Its old
reason — "the mechanization lessor never logs in, and the predicate has no lessor branch" — stopped
being true, and the rule "scoped iff a predicate exists" invites flipping the cell now that the
lessor axis exists. The cell is a decision about **sets**, and the new reason is: the lessor's
powers are exactly his type's list over doors built for him; a set with `.status`, `.update`,
`.extend` or `.approve` would open write doors that answer with the full request DTO and predicates
that know nothing of his narrow view, and a set for the executor role would reach every executor
type at once. `grants-contracts.test.ts` names the one exception to "the matrix does not forbid what
the role already sees" (`mech_lessor × mech`) and pins that no set gives the executor role any
mechanization permission; the `SCOPED_AXES_BY_MODULE.mech` pin keeps `['object', 'department']`.

### Why the executor status boundary of ADR 0152 stays, unreachable

ADR 0152 kept the status gate of a role with its own corridor (the executor) a disjunction over
modules (`cycleTransitions` → `canChangeAnyRequestStatus`) and promised to remove that boundary "by
the decision that gives the lessor accounts". This decision does not edit the shared
`cycleTransitions` in the protected `permissions.ts`: removing the disjunction would change the
answer for the waste operator and the vehicle lessor to reach a case that cannot occur. For
mechanization the disjunction stays unreachable on three counts — the `mech_lessor` type list holds
no status permission of any module, so the disjunction answers "no" for him; the grant matrix
refuses him `.status` (the `forbidden` cell above); and every mechanization mutation asks its own
permission on the server — with the door guard refusing him every unmarked route on top.

## Deviations from the plan, and why

- **The deal epoch is a number, not a retire marker.** The plan cut the lessor's versions at the
  last version retired `deal_changed`/`rolled_back`. The independent security review of W2 found the
  blocker, confirmed by a probe: such a marker is written only on a **current** version, and after a
  revoked waiver there is none — a deal change before issue or a return to «Новая» then left no
  boundary, and the next lessor saw his predecessor's version (id and file name) and downloaded his
  file with 200; one rate change also showed a lessor the versions of his previous deal. Fixed by
  `deal_no` on the request and on every version (decision 12), inside the not yet pushed `0420`. The
  markers stay for the office's view and the history. `ADD COLUMN … DEFAULT 1` is metadata-only; no
  CHECK on the live `mech_requests` (it would scan the table under ACCESS EXCLUSIVE), the versions'
  copy is checked.
- **The guard is each route's own first `preValidation`, installed by `onRoute`,** not a
  plugin-level hook. Installed this way it is visible in each route's options, where
  `route-authorization.test.ts` finds its mark `scope:mech-lessor-door` on every mechanization route
  and requires it to be the **first** `preValidation` (a hook placed before it would run for the
  lessor before the refusal); a route registered on another instance fails the run.
- **`MechRequestDto` carries flat fields** — `lessorReceiptRequired`, `lessorReceipt` (current,
  office view), `lessorReceiptVersionCount`, `lessorReceiptRetired` (card only, `null` in list rows)
  — instead of an audience-union field: the DTO itself stays a valid transition state for the
  barrier and the menu. The audience union stays the shape of the doors' replies.
- **The lessor's state carries `ownVersionCount`** — the versions his account attached within the
  current deal, what the cap counts — so the portal hides «Заменить чек» exactly when the server
  would refuse. Not in the plan's P12 table; it is a number about his own actions.
- **The migration's data step writes no `grant.update` audit rows.** The precedents that added a
  permission to existing sets by migration — `0275` (`officeEquipment.move`) and `0285`
  (`mechRequests.approve`) — wrote none (and moved no versions; this one does, so that an editor
  opened before the migration saves into a 409). The migration file in the repository and in
  `_migrations` is the record of who added the row and why.
- **pdf.js 6.4.299, the legacy build, the worker served as `.js`.** 6.4.299 is the newest version at
  least two weeks old (03.10.2026; ≥ 4.2.67 for CVE-2024-4367). The modern build calls
  `Map.prototype.getOrInsertComputed` and `Math.sumPrecise`, newer than the portal's targets (Chrome
  111, Safari 16.4); the legacy build carries polyfills. The worker is renamed from `.mjs` because
  `nginx:1.27-alpine` has no `mjs` in `mime.types`: the file would go out as
  `application/octet-stream`, and with `nosniff` the module worker would not start. The plan's
  `isEvalSupported: false` has no object — pdf.js 6 removed the option with the code.
- **`pnpm.ignoredOptionalDependencies: ["@napi-rs/canvas"]`** in the root `package.json`: an
  optional native dependency of pdf.js for Node (about 36 MB per platform), not needed in a browser.

## Deploy window

- One API process at a time: the window is "migration `0420` applied, old code still serving". Old
  code never reads the table, the enum or the columns; it takes rentals into work with
  `required = false` (not gated, like rentals before the release — accepted) and changes deals
  without moving `deal_no` (harmless: no version exists before the new code). Its worker's orphan
  sweep asks the new `file_is_linked`. Proven as for ADR 0171 §15: the mechanization db suites of
  the release serving production (`38636a9d`) are green on their schema plus `0420`; the new suites
  are green on PostgreSQL 17.
- **The one thing the window can lose is the new permission.** The old API reads
  `mechRequests.lessorReceipt` as an unknown string and deletes it as an orphan on any save of a
  set's contents. Hence two runbook steps for this release: no edits of permission sets between the
  migration and the restart, and a post-deploy query «sets holding `mechRequests.status` without
  `mechRequests.lessorReceipt`» that must return nothing. After the restart barrier 4 refuses a set
  save that would leave a holder with `.status` alone.
- Old tabs cannot show or attach a receipt; their «Завершить аренду» on a gated rental gets a 422
  with the barrier's text, and their delete of a «Новая» with versions archives it while the dialog
  says "deleted" — the safer of the two. No client-floor raise: nothing breaks silently, and the
  lessor has no old tab.
- The prod bucket is a deploy step: the runbook's CORS check with `GET` from the prod origin. The W3
  real-browser check (a Cyrillic PDF with non-embedded fonts and a JPEG, desktop and Android
  viewports, nginx with the production CSP) ran against dev storage: it proves rendering and the
  CSP, not the bucket.
- Rollback after the migration is `--previous --restore-db`: the old image refuses a newer schema.

## Consequences

- The visa holder gets work he did not have: receipts waiting for a visa are found by the mark and
  the filter; there is no mail. Every site with rentals in work has a visa holder today (survey of
  09.11); a site that loses its holder cannot complete gated rentals, the risk ADR 0171 accepted for
  take-in-work.
- Rentals taken into work before the release complete as before; one that gets a receipt is gated.
- **The lessor axis alone does not close the office readers — the guard does.** Behind the guard,
  the office list, card, history, journal and export are narrowed by the lessor axis to his own
  rentals, but they answer in the office DTO and in every status: without the guard he would see the
  department, the requester, the comment and the money of his rentals — exactly what O7 hides.
  Accepted after the W2 review without code, because the guard is pinned twice: by
  `route-authorization.test.ts` (present, and first, on every mechanization route) and by
  `mech-lessor-scope.db.test.ts` (every unmarked route of the access manifest under
  `/api/v1/mech-requests` answers a real lessor account 403 with an empty body).
- **Directories stay open to the lessor (O16).** The executor role's base `directories.read` opens
  counterparties (with INN, mail and internal comments), departments, sites, vehicles and waste
  tariffs to every executor account, the mechanization lessor included, as it already does for the
  vehicle lessor. Accepted for this release; narrowing directories for all executors is the journal
  card «Доступ: сузить справочники для внешних исполнителей».
- **Deactivating a lessor counterparty does not end its accounts' sessions.** `loadPrincipal` checks
  the account, not its counterparty. To cut a lessor off the administrator deactivates his accounts
  (runbook). Tying sessions to the counterparty's state would change every executor and is not this
  release.
- **The migration-window permission loss** is held only by the runbook checklist (above), not by
  code.
- iPhone photos: HEIC is not accepted; the upload's `accept` names PDF and JPEG only, under which
  iOS Safari converts a library photo to JPEG. Not checked on a real iPhone; the upload window names
  the formats it takes.
- The pdf.js renderer is a lazy chunk of about 149 KB gzip, loaded only when a receipt is previewed.

## Alternatives

- **The one-row child table of the extension** (ADR 0171 decision 11): there nothing but a date is
  overwritten, and the chain lives in the history. Here the file is the evidence of money and O8
  asks to keep every version openable; history entries alone cannot keep a file linked.
- **A `kind` column on `mech_request_files`** (the ADR 0235 shape): the requester's attachments are
  edited as a whole set through `PATCH /:id`, and a receipt in the same table would be one forgotten
  filter away from leaving through the editor; a receipt also has a lifecycle an attachment lacks.
- **Granting the lessor `.status`** instead of a new permission: he would record the deal, the issue
  and the completion.
- **Flipping the `forbidden` cell to `scoped`** once the lessor predicate existed: see «The kept
  `forbidden` cell» — sets would widen every executor and open doors with the full DTO.
- **Masking `MechRequestDto` for the lessor**: a field added to the office DTO would reach him by
  default; an allow-list cannot leak by omission.
- **Serving the PDF through the API** as a fallback for the bucket: forbidden by the runbook (files
  never pass through the API), and it would not prove the bucket anyway.
- **Editing the CSP** for a `blob:` worker or WebAssembly: not needed once every asset is served
  from the portal's origin and `useWasm` is off.
