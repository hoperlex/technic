# Plan: Mechanization — the lessor's receipt, its visa and lessor accounts

A new approval step in the mechanization module ([ADR 0152](adr/0152-mechanization-module.md)).
After a rental is taken into work, the lessor or the dispatcher attaches the lessor's receipt
(«чек»): one PDF or JPG file. A holder of the request visa reviews it in a preview window and
approves or rejects it. A rental is not completed without an approved receipt or an explicit
«без чека» visa. Lessors of mechanization get portal accounts in the same release, with a narrow
view of their rentals in work.

Basis: the module [ADR 0152](adr/0152-mechanization-module.md); the site visa and the extension
visa [ADR 0171](adr/0171-mechanization-site-approval.md) (decisions 4, 7, 8–15 are the template of
this plan); executors by counterparty type
[ADR 0038](adr/0038-executor-permissions-by-counterparty-type.md); vehicle request documents
[ADR 0235](adr/0235-rental-completion-and-request-documents.md) (decisions 7–8); the permission
oracle [ADR 0223](adr/0223-portal-permission-oracle.md); release entries
[ADR 0077](adr/0077-release-notes.md) and [ADR 0191](adr/0191-version-numbering.md).

Decisions of this plan are `P1…`, owner decisions `O1…`, implementation waves `W1…`. This is a plan:
intent, not state. Code anchors are as of `64a31d73` (03.11.2026); a parallel stream committing
after it moves line numbers, not names.

**Revision 4 (03.11.2026)** — after three proofreading rounds and five owner surveys (§9). Ready
for implementation.

## 1. Owner decisions

Five surveys on 02–03.11.2026. Each answer is binding for this plan; changing one is a new survey.

| #   | Question                                               | Answer                                                                                                   |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| O1  | From when can a receipt be attached                    | From «Взять в работу» (`new → confirmed`), at any point in «В работе»                                    |
| O2  | What waits for the approved receipt                    | Completion (`confirmed → done`) only; issue, extension and cancellation do not                           |
| O3  | Who approves                                           | The request visa circle, ADR 0171 decision 4: the site, and for a department request also its department |
| O4  | One receipt or several                                 | One file, PDF or JPG                                                                                     |
| O5  | Preview                                                | The visa is given in a preview window that shows the receipt itself                                      |
| O6  | Lessor accounts                                        | In the same release as the receipt                                                                       |
| O7  | What the lessor sees                                   | A narrow card (P12); no department, comment, requester files, visa, final cost or foreign history        |
| O8  | Replaced and rejected files                            | Kept: every version stays openable from the card's history while the request lives                       |
| O9  | Amount of the receipt                                  | No number: the file only                                                                                 |
| O10 | A rental that will never have a receipt                | The visa holder may allow completion «без чека» with a required reason: own button, own history event    |
| O11 | PDF on phones (Android Chrome shows no PDF in a frame) | The portal renders PDF itself with pdf.js, loaded lazily only for receipt previews                       |
| O12 | Which rentals the lessor sees                          | Only «В работе» (`confirmed`); closed and cancelled rentals leave his list                               |
| O13 | Who replaces an approved receipt                       | Only the office; the lessor replaces a pending or rejected one                                           |
| O14 | May the one who attached a receipt approve it          | Yes: the permission and the visa circle decide, no "two keys" rule                                       |
| O15 | May the visa holder undo his approval                  | Yes, while the rental is «В работе»; the history keeps the event                                         |
| O16 | The executors' base `directories.read` for the lessor  | Accepted as for vehicle lessors; narrowing it for all executors is a separate task in the journal        |
| O17 | Receipts of an archived request                        | Openable by holders of the archive without a restore; requester attachments keep today's rule            |

Accepted without objection from the user-facing description of 02.11 (restated here so that review
can challenge them):

- rentals taken into work before the release are not gated at completion (P3);
- no mail: the module has no mail contour, the visa holder finds work by a mark and a filter;
- a deal change before issue and any return to «Новая» retire the current receipt (P8);
- «Вернуть в работу» (`done → confirmed`) keeps the approval.

## 2. What changes for people

- **Dispatcher (office).** After «Взять в работу» the card shows a «Чек арендодателя» block with
  «Прикрепить чек». While the receipt waits, is rejected, approved or waived, he can replace it;
  replacing an approved or waived one asks for a new visa. «Завершить аренду» stays in the menu,
  disabled with the reason, while the receipt is neither approved nor waived.
- **Lessor (new portal user).** Sees only his rentals «В работе», in a narrow card. Attaches a
  receipt, replaces it while it waits or after a rejection, sees the decision and the reason of a
  rejection.
- **Visa holder.** Finds rentals by the mark «чек ждёт визы» and the filter «Чек». «Проверить чек»
  opens a window: the receipt rendered in the portal next to the rental's facts, and the actions
  «Утвердить», «Отклонить» (reason required), «Без чека» (reason required). When there is no receipt
  to look at — none attached, or the last one rejected — «Без чека» is its own menu item and card
  button with a reason dialog (O10). While the rental is «В работе» he can undo his decision (O15),
  reason required: «Отозвать утверждение» returns an approved receipt to «ждёт визы»; «Отменить
  „без чека“» withdraws a waiver, and the rental needs a receipt again («нет чека»).
- **Requester (site, department, commandant).** Sees the receipt block and its versions, acts on
  nothing.
- **Administrator.** Creates lessor accounts in the account form (the counterparty type
  «Арендодатель механизации» now appears there). To cut a lessor off, he deactivates the accounts:
  deactivating the counterparty does not end its accounts' sessions (P10).

## 3. Decisions

### P1. Versions of the receipt: one table, a row per version, the current row is the one not retired

O4 says one file, O8 says every version is kept. Both hold when the card has **one current receipt**
and a list of **retired versions**. A table `mech_request_lessor_receipts` keeps one row per version:

- a **file version**: `file_id` set, status `pending → approved | rejected`;
- a **waiver** (O10): `file_id` null, status `waived`, created by the visa holder in its final state.

The current row is the one with `retired_at IS NULL`; a partial unique index allows at most one per
request. Retiring stamps `retired_at`, `retired_by` and `retired_reason`
(`replaced`, `deal_changed`, `rolled_back`, `revoked`) and **never changes the status**: a version
approved and later replaced still reads "approved, replaced on …", and a pending version replaced
before any decision reads "not decided, replaced". The decision columns answer "what was decided",
the retire columns "why it is no longer current"; mixing them in one status would lose one of the
two facts.

The one status change after a decision is the revocation of O15 (P5): an approved file version goes
back to `pending`. Its fact lives in the strict history event, as the revoked request visa lives in
its event (ADR 0171 decision 7).

Each row also stores `created_as` (`lessor` or `office`): who attached it, fixed at insert. The
lessor's view shows that word instead of a name (P12), and deriving it later from the author's
account would relabel old versions after an account changes.

Why not the one-row child table of the extension (ADR 0171 decision 11): there the chain lives in the
history because nothing but a date is overwritten. Here the file is the evidence of money, and O8
asks to keep it openable; history entries alone cannot keep a file linked.

Why not a `kind` column on `mech_request_files` (the ADR 0235 shape): the requester's attachments
are edited as a whole set through `PATCH /:id` (`addFileIds`/`removeFileIds`), and a receipt in the
same table would be one forgotten filter away from leaving through the editor. A receipt also has
a lifecycle (decision, retirement) that an attachment does not.

### P2. "Lessor receipt" is the name everywhere

`receipt` already means three things in this repository: the create receipt of ADR 0231
(`receiptRequired` in `apps/api/src/routes/mech-requests.ts:595` is exactly that), garage auto-part
receipts, and warehouse receipt lines. The new term is always **lessor receipt** in code
(`mech_request_lessor_receipts`, `MechLessorReceiptVersionDto`, `mechLessorReceiptAccess`), and «чек
арендодателя» in the portal. A bare `receipt` in a new identifier is a review finding.

### P3. Completion requires an approved or waived receipt, for rentals that require one

A column `mech_requests.lessor_receipt_required boolean NOT NULL DEFAULT false`:

- set to `true` by the server in the transition `new → confirmed` (every take-in-work after the
  release, whatever the client) and by attaching a receipt (an old rental that got a receipt is
  gated like a new one: a receipt that was shown must be decided);
- never set back to `false`: a return to «Новая» and a new take-in-work set it again anyway.

The gate is one predicate, `mechLessorReceiptCompletionBlocker`, called by `mechTransitionBlocker`
for `to === 'done'`:

```text
required = false                         → no barrier (rental taken into work before the release)
current is approved or waived            → no barrier
current is pending                       → «Чек арендодателя ждёт визы — аренду завершают после неё»
current is rejected                      → «Чек арендодателя отклонён — прикрепите исправленный»
no current row                           → «Прикрепите чек арендодателя или получите визу „без чека“»
```

It applies to **every** completion, including the repeat completion after «Вернуть в работу»: the
approval survives that rollback, so the repeat passes unless the receipt was replaced or the
approval revoked in between. Why a column and not "taken into work after a date": a date cutoff in
the schema outlives everyone who remembers its meaning, the reason ADR 0133 decision 3 rejected it;
and an old rental that later got a receipt must be gated, which a date cannot say.

`MechTransitionState` gets `lessorReceiptRequired: boolean` and `lessorReceipt: { status } | null`
as **required** fields (`null` = no current row). Unlike the optional `extension` field
(`packages/contracts/src/mech-requests.ts:155-160`, which the barrier never reads), the barrier reads
these, and an optional field would let a caller that forgot to load the receipt pass the gate. So
the status route **always** loads the current receipt under the request lock, for every transition,
and the portal menu reads it from the DTO.

The barrier is a state barrier: nobody bypasses it, the administrator included (ADR 0152 decision 7).
The administrator who must close a stuck rental gives the «без чека» visa with a reason.

### P4. Who attaches: a new permission `mechRequests.lessorReceipt`

The lessor must attach without holding `mechRequests.status` (that would let him record the deal,
the issue and the completion). So attaching gets its own permission:

- `mechRequests.lessorReceipt`, label «Прикрепляет чек арендодателя к аренде механизации», action
  `manage` (as `.extend`), `PERMISSION_REQUIRES` → `mechRequests.read`, listed in
  `MECH_REQUEST_PERMISSIONS` (module scope);
- holders: everyone who holds `mechRequests.status`, held as an invariant in three places:
  - **the matrix**: `MECH_REQUEST_OFFICE_PERMISSIONS` (manager, dispatcher) and any other role row
    that lists `.status` (W1 enumerates them; no system set holds `.status` today);
  - **the requirement table**: `PERMISSION_REQUIRES['mechRequests.status']` gains
    `mechRequests.lessorReceipt`. Barrier 4 checks requirements over the **subject's** effective
    permissions after every operation that changes access — per holder on a set save, and on an
    account edit (`packages/contracts/src/grants.ts:1413-1428`, `apps/api/src/routes/users.ts:1695-1715`)
    — so no account can hold `.status` without `.lessorReceipt` from now on, whether the pair comes
    from a role, a set, or both. A grant editor of an older bundle filters a set through its own
    `GRANTABLE_PERMISSIONS` (`apps/web/src/pages/admin/GrantBuilderModal.tsx:106`); after the
    restart its save is refused with `requirement_missing` for every holder whose role does not
    bring `.lessorReceipt` itself. Barrier 4's fixed text says "the account does not see the
    module", which is false for this pair, so the requirement table gains an optional reason per
    pair and this pair reads «Ведущий аренду прикрепляет и чек арендодателя»;
  - **the base**: permission sets assembled by administrators live in `grant_permissions` as free
    text (`apps/api/src/db/schema.ts:1291-1305`). The schema migration adds the row to **every** set
    that holds `mechRequests.status`, deleted ones included (they have no holders, and a restore
    stays consistent; precedent `0285` for `.approve`), and bumps the version of each touched set,
    so an editor opened before the migration gets the editor's ordinary 409
    (`apps/api/src/routes/grants.ts:532`). W2 writes one `grant.update` audit row per touched set if
    migrations of the precedent did, and says so in the ADR if they did not;
  - plus `COUNTERPARTY_TYPE_PERMISSIONS.mech_lessor` (P10);
- the office may replace any current version; the lessor only a pending or rejected one (O13). The
  rule is one predicate with the subject, not two permissions.

**The window between migration and restart is not covered by any of this.** The old API reads the
new string as unknown and **deletes it as an orphan** on any save of a set's contents
(`packages/contracts/src/grants.ts:549`, `:603-610`), and an editor opened after the migration
carries the bumped version. Hence two deploy steps (§5): no edits of permission sets between the
migration and the restart, and a post-deploy query that finds sets holding `.status` without
`.lessorReceipt` (expected: none).

The permission is a protected area (`architecture/`): never an automatic change.

### P5. Who decides: the request visa circle, signing the version he saw

`PATCH /:id/lessor-receipt` with `{ receiptId, decision: 'approve' | 'reject' | 'revoke', comment,
version }` under `mechRequests.approve` and `canApproveMechRequest` (ADR 0171 decision 4, O3):

| Decision  | Allowed when                                                        | Effect                                                                        |
| --------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `approve` | current version `pending`; request live                             | `approved`, decided by and at                                                 |
| `reject`  | current version `pending`; request live; reason                     | `rejected` with the reason                                                    |
| `revoke`  | current version `approved` or `waived`; request `confirmed`; reason | file version back to `pending` (decision cleared); a waiver retired `revoked` |

Like attaching, every decision bumps the request version, writes its strict event and replies with
`{ version, lessorReceipt }` built for the caller's audience (P7).

**Binding the signature to the version seen.** The `receiptId` is the version shown in the window.
The door keeps the module's protocol as it is (lock → existence and scope → version 409 → subject
checks, `apps/api/src/services/mech-request-guards.ts:50-80`): it loads the current row under the
lock first only to choose the words of a version 409 — «Чек заменили, пока окно было открыто —
откройте его заново» when `receiptId` is no longer current, the generic text otherwise. After the
version check the write itself binds the id:
`UPDATE … WHERE id = $receiptId AND request_id = $id AND retired_at IS NULL AND status = <expected>
RETURNING …` (for revoking a waiver the same `WHERE` stamps the retire columns); zero rows is the
same 409. The `request_id` term is not decoration: without it a visa holder of site A could send his
own rental's id and version with a pending `receiptId` of site B. The portal's `mechFailureText` maps
every 409 to `MECH_STALE_MESSAGE`; the visa window shows the server's text for this door instead.

`approve` and `reject` do not ask the request's status: a pending receipt can exist on a rental
cancelled after it was attached, and deciding it is still useful (a prepayment). A `done` rental
never holds a pending receipt (P3), and a return to «Новая» retires it (P8). `revoke` is limited to
«В работе» (O15): after completion the approval is the basis of a closed rental.

Who attached a version does not matter (O14): the permission and the circle decide. Approval is
always an explicit act, never automatic (ADR 0032).

`canApproveMechRequest` (`packages/contracts/src/mech-requests.ts:738-756`) today answers `true` for
every role without its own axis, which includes the executor role. It gains an explicit `false` for
counterparty-scoped roles: no executor can hold `.approve` in mechanization (P10), and the predicate
should not depend on that alone.

### P6. The «без чека» visa (O10)

`POST /:id/lessor-receipt/waiver` with `{ comment, version }`, same permission and circle as P5,
same reply. It inserts a current row with `status = 'waived'`, `file_id = NULL`,
`decided_by = created_by`, `decided_at = created_at` and the required reason, retiring the previous
current row (if any) with `replaced`; the event names the replaced version. Allowed while the
request is `confirmed` and live and the current row is absent, `pending` or `rejected`; not over
`approved` (nothing to allow) or `waived` (a second one is noise).

Two doors in the portal, one dialog: «Без чека» inside the visa window when a file is shown, and a
menu item and card button «Без чека» with a reason dialog (no preview) when there is no current
row or the current one is rejected.

A later receipt replaces the waiver like any version (P7), and the gate asks for its approval
again. Only the office replaces a waiver: like an approval, it closes the question (O13). The visa
holder withdraws his own waiver by `revoke` (P5), labelled «Отменить „без чека“»; the rental is then
«нет чека» again.

### P7. Attaching and replacing

`POST /:id/lessor-receipt` with `{ fileId, version }` under `mechRequests.lessorReceipt`:

1. module protocol: lock first, existence and scope (P11), version 409 before any 422, live;
2. `mechLessorReceiptAttachBlocker({ row, current, lessorVersionCount, actsAsLessor })`, each refusal
   a 422 with its text: the request is not `confirmed` («Чек прикрепляют к аренде в работе»); the
   lessor over an approved or waived current row («Утверждённый чек меняет диспетчер», O13); the
   lessor's cap — 20 versions created by **his account within the current deal** («Слишком много
   замен чека — обратитесь к диспетчеру»). The cap is the lessor's only: it guards against an
   external loop, and capping the office too would let a lessor's loop lock the office out of
   attaching the real receipt; counting per account within the deal keeps a new lessor from
   inheriting his predecessor's count;
3. the file: `assertFilesAttachable(…, { requireActive: true })` (own upload, finished, not linked,
   not quarantined — the option the readings path uses for evidence,
   `apps/api/src/services/request-files.ts:52-58`) and its stored `content_type` in
   `MECH_LESSOR_RECEIPT_CONTENT_TYPES = ['application/pdf', 'image/jpeg']`, otherwise 422 «Чек
   принимается в PDF или JPG»; the portal sends `accept=".pdf,.jpg,.jpeg"`;
4. retire the current row (`replaced`), insert the new one `pending` with the next `version_no`
   (computed under the request lock) and `created_as`, set `lessor_receipt_required = true`, bump
   the request version, strict audit;
5. reply with the request's new `version` and the receipt state (`MechLessorReceiptStateDto`) **for
   the caller's audience**: the office gets every version with names; the lessor gets the P12 view.
   Not the whole request: the reply then needs no request-level audience switch, and the portal
   invalidates its queries.

The content type is the one the browser declared at upload; the plan does not sniff bytes. A
mislabelled file fails to render in the preview and gets rejected; serving it is not a new
exposure — every attachment of the portal is already shown inline by its declared type.

### P8. What else touches the receipt

| Event                                                                                        | Effect on the current receipt                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `PATCH /:id/deal` that changes lessor, rate or unit                                          | retired `deal_changed` (it was issued under other terms)            |
| `PATCH /:id/deal` with the same values                                                       | none                                                                |
| any entry into «Новая» (`mechTransitionResetsDeal`): `confirmed → new` and `cancelled → new` | retired `rolled_back` (the deal is erased with it)                  |
| `confirmed → cancelled`                                                                      | none; a pending one stays decidable (P5)                            |
| `done → confirmed` («Вернуть в работу»)                                                      | none; the approval survives                                         |
| issue revoke, extension request/decision                                                     | none                                                                |
| archive (soft delete) and restore                                                            | none; no attach or decision while archived                          |
| delete of a «Новая» that has receipt versions                                                | **archive, not hard delete** (`mechDeleteScope`); the versions stay |
| duplicate                                                                                    | not copied: the copy is a new request                               |
| hard delete of a «Новая» without versions, purge                                             | rows cascade; every version file of a purged request deleted        |

The rule follows `mechTransitionResetsDeal` (`packages/contracts/src/enums.ts:401`) rather than
naming transitions: the module erases the deal on **any** entry into «Новая», including the chain
`confirmed → cancelled → new` (`apps/api/src/services/mech-request-transition.ts:126-134`). Naming
only `confirmed → new` would leave the old deal's approved receipt current after
`cancelled → new → confirmed`, passing the new deal's gate and showing it to a new lessor.

**Hard delete.** `mechDeleteScope` answers `hard` for every «Новая»
(`packages/contracts/src/mech-requests.ts:1045-1051`), and a site requester holds `.delete`. A rental
with an approved prepayment receipt, returned to «Новая» before issue, would then lose every version
and file at once, and O8 would hold only on paper. So `mechDeleteScope` takes the version count as a
**required** argument (a caller that forgot it must not compile into `hard`) and answers `archive`
for a «Новая» with versions. Its callers — the API delete route (`mech-requests.ts:1329`), the menu
(`apps/web/src/pages/mech/mechRequestMenu.tsx:290`) and the card actions
(`apps/web/src/pages/mech/mechRequestActions.tsx:164`) — get the count from the locked row and the
DTO; the label «Удалить в архив» and its confirmation follow by themselves. Purge does not ask it
(`mech-requests.ts:1466`) and stays what ADR 0070 made it: the administrator's explicit end of the
request, files included.

**"Changes lessor, rate or unit"** compares `lessor_id`, the unit, and the rate **as a number**
(`Number(body.rate) !== Number(row.rate)`), not `mechDealChanges`
(`apps/api/src/services/mech-request-diff.ts:115-128`), which compares lessor names and formatted
money for the history; `1500` sent against a stored `1500.00` is no change.

When the lessor changes, the previous lessor loses the rental at once (his axis is `lessor_id`,
P11) together with every version; the new lessor does not see the versions of earlier deals (P12).

### P9. History and audit

Six strict actions (`writeAuditTx`, added to the closed list in `apps/api/src/lib/audit.ts`
item 5), one history kind each — `mergeHistory` maps one action to one kind
(`AUDIT_KINDS`, `apps/api/src/services/mech-request-history.ts:61-78`), the reason the extension
has `extend` and `extend_reject` apart:

| Action                                | Kind (in `packages/contracts/src/request-history.ts`) | Metadata                                                                       |
| ------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `mech_request.lessor_receipt_attach`  | `mechLessorReceiptAttached`                           | version number, file as `files` of the change, replaced version and its status |
| `mech_request.lessor_receipt_approve` | `mechLessorReceiptApproved`                           | version number                                                                 |
| `mech_request.lessor_receipt_reject`  | `mechLessorReceiptRejected`                           | version number, reason                                                         |
| `mech_request.lessor_receipt_revoke`  | `mechLessorReceiptRevoked`                            | version number, approval or waiver, reason                                     |
| `mech_request.lessor_receipt_waive`   | `mechLessorReceiptWaived`                             | reason, replaced version and its status                                        |
| `mech_request.lessor_receipt_retire`  | `mechLessorReceiptRetired`                            | version number, `deal_changed` or `rolled_back`                                |

Strict for the reason ADR 0152 decision 9 gives for money events: the receipt is the evidence of a
payment, and a revoked approval survives only in its event. The events are strict also because the
card's history must not disagree with the block above it.

**Openable from the history (O8).** The change carries the file as `files`
(`RequestChangeFileDto`, `packages/contracts/src/request-history.ts:44`), but the portal prints only
the text today (`ChangeLines` in `apps/web/src/entities/request-history/ui/RequestHistory.tsx:158`).
W3 adds an optional `renderFiles` prop to the history table; the mechanization card passes the file
link list, so a version opens from its history line. Other modules pass nothing and do not change.
The versions list in the receipt block (P15) is the second way to the same files.

### P10. Lessor accounts: the counterparty type gets two permissions, and nothing else can

`COUNTERPARTY_TYPE_PERMISSIONS.mech_lessor = ['mechRequests.read', 'mechRequests.lessorReceipt']`
(`packages/contracts/src/permissions.ts:1435`). Everything that is computed from non-empty lists
follows: `COUNTERPARTY_TYPES_WITH_ACCOUNTS`, `ACCESS_PROFILES` (`operator × mech_lessor`), the account
form's counterparty dropdown, `resolveCounterpartyId` (`apps/api/src/routes/users.ts:473-500`).

This line is what makes lessor accounts creatable, so it lands **after** the guard and the axis of
P11 (W2, §6), never before: the module is unscoped for an executor until then.

This reverses ADR 0152 decision 6 ("no accounts") and the comments that say so
(`permissions.ts:177-179`, `:1424-1434`, `apps/api/src/routes/files.ts:174-181`); the new ADR records
the reversal and its reason (O6).

**No permission set can add to it.** `GRANT_SCOPE_MATRIX.mech.counterparty` is `forbidden`
(`packages/contracts/src/grant-scope.ts:200-216`), so barrier 3 (`grants.ts:1397-1408`) refuses any
`mechRequests.*` permission to the executor role, both in a set's contents and at assignment; the
executor role's own list is `['directories.read']` (`permissions.ts:1305`) and no role add-on
carries a mechanization permission. The cell's stated reason — "the lessor never logs in" — stops
being true, and the rule "scoped iff a predicate exists"
(`apps/api/test/grants-contracts.test.ts:1928-1941`) invites flipping the cell once P11 adds the
lessor predicate. The cell **stays `forbidden`** with a new reason: the lessor's powers are exactly
his type's list; a set with `.status`, `.update`, `.extend` or `.approve` would open write doors that
answer with the full request DTO and predicates that know nothing of the lessor's narrow view. The
comments there and in `grants-contracts.test.ts:1807-1811` are rewritten; a contract test pins "a set
holding any `mechRequests.*` permission is refused for the executor role", and the existing pin of
`SCOPED_AXES_BY_MODULE.mech` as `['object', 'department']` keeps its value with a new reason.

**The executor status boundary** of ADR 0152 ("Последствия", third bullet) is promised to be removed
"by the decision that gives the lessor accounts". The plan does not edit the shared `cycleTransitions`
in the protected `permissions.ts`: the disjunction stays unreachable for mechanization, now on three
counts — the type's list has no `.status`, the grant matrix refuses one, and every mechanization
mutation requires its own permission. The ADR says so in these words, and the contract tests of this
section pin the first two.

**Directories (O16).** The executor role's base set opens counterparties, departments, sites,
vehicles and waste tariffs to every executor today. The lessor gets the same as the vehicle lessor;
the ADR records the fact, and a separate journal card narrows directories for all executors.

**Cutting a lessor off.** `loadPrincipal` checks the account, not its counterparty
(`apps/api/src/auth/principal.ts:259-264`): deactivating a lessor in the directory leaves his
accounts working. The runbook gets the operator's step — deactivate the accounts — and the ADR names
the gap; tying sessions to the counterparty's state would change every executor and is not this
release.

Not in this release: self-registration of a lessor (`registration_role_request` is a DB enum, and
the owner asked for accounts, not for a registration form) — the administrator creates accounts.

### P11. Lessor scope: deny by default, a second axis underneath

Today every read of the module filters by the site only (`mechScopeWhere`,
`apps/api/src/services/mech-request-list.ts:44`; `assertPlaceObjectScope` in the card, history and
`assertMechRequestOpenable`), and `placeObjectScopeIds` returns `null` (unlimited) for an executor.
Granting `.read` to the lessor without more would show him **every** request and file.

**First line — the module refuses executors by default.** The mechanization routes plugin adds a
`preValidation` hook before its first route. Two facts of Fastify decide its shape:

- a plugin-level `preHandler` runs **before** a route's own `preHandler`
  (route-level hooks are appended last), and `app.authenticate` is a route-level `preHandler` here
  (`apps/api/src/routes/mech-requests.ts:220-227`), so in a plugin `preHandler` `req.principal` is
  still `null` (`apps/api/src/auth/plugin.ts:65-113`) and a check `if (p && …)` would refuse nobody;
- params and body are validated before `preHandler`, so a guard there would let a test with an
  empty body see 400 instead of 403.

So the hook is `preValidation`, it authenticates itself when `req.principal` is empty (the same
code as `authenticate`, which becomes a no-op when a principal is already set, so the session is
loaded once), and it refuses a counterparty-scoped principal with 403 «Арендодателю доступен только
список его аренд» unless the route's config marks it a lessor door
(`config: { mechLessorDoor: true }`). Three doors carry the mark: the two `lessor-rentals` reads
(P12) and `POST /:id/lessor-receipt` (P7). The extension routes are registered on the same instance
(`registerMechExtensionRoutes(app)`, `mech-requests.ts:239`), and so are the receipt routes, so the
hook covers them. The hook carries the marker that `apps/api/test/route-authorization.test.ts:181`
needs to tell a guard from the login check. A route added tomorrow is closed to the lessor unless
someone marks it. The scope suite iterates the exported `ACCESS_MANIFEST`
(`apps/api/src/lib/access-manifest.ts:216`, keys `METHOD /path/:id`) under `/api/v1/mech-requests`
and expects 403 for a mech lessor on every unmarked route, with an empty body.

**Second line — the axis.**

- `mechLessorVisibilityWhere(p, column)` in `apps/api/src/lib/access.ts`, next to
  `lessorVisibilityWhere`, built on `counterpartyVisibilityWhere(p, 'mech_lessor', column)`: an
  executor of another type gets `NEVER_MATCH`, a mech lessor his own counterparty, everyone else no
  condition;
- `mechScopeWhere(p)` becomes `and(placeObjectVisibilityWhere(…), mechLessorVisibilityWhere(p,
mechRequests.lessorId))` — list, summary, history list, history summary, export inherit it;
- `assertMechScope(p, row)` replaces **every** `assertPlaceObjectScope` of the module — `GET /:id`,
  `GET /:id/history`, `assertMechRequestOpenable`, and create, duplicate, update, restore and purge
  (`mech-requests.ts:490`, `:647`, `:777`, `:1397`, `:1462`) — so no door relies on the lessor
  lacking a permission;
- **one predicate for everything the lessor may touch**, `isMechLessorRentalVisible(p, row)`: his
  counterparty, `confirmed` (O12), not archived, with a SQL twin `mechLessorRentalVisibleWhere(p)`
  for the list; a test pins the two against each other over a grid of rows. The lessor doors, the
  attach door for a lessor and his receipt-file flag (P13) all ask it, so a rental that closed is
  gone from all three at once. A foreign or closed rental is **404** for a lessor — deliberately
  unlike the vehicle lessor, who gets 403 (`assertLessorScope`, `access.ts:480`): the mechanization
  lessor is a new external party, and which request ids exist is not his business (the reason
  `assertArchiveVisible` answers 404);
- files (`canAccessFile`, `apps/api/src/routes/files.ts:409`, flags in `FileLinkage` `:159-215`):
  the attachment branch `visibleMech` (`:555-575`) **never matches for a mech lessor** — O7 hides
  the requester's files, and a lessor who learnt an attachment's id must not open it; for everyone
  else it uses `mechScopeWhere`. Receipt files get their own flag (P13).

### P12. The lessor's own read doors and DTO: an allow-list, not a mask

Two routes under `mechRequests.read`, marked as lessor doors, that only a mech lessor passes
(everyone else 403):

- `GET /mech-requests/lessor-rentals` — his rentals by `mechLessorRentalVisibleWhere`, in the
  module's list envelope (`baseListQuery` paging, `ListResult<MechLessorRentalDto>`); filters:
  period, receipt state; sort by planned return;
- `GET /mech-requests/lessor-rentals/:id` — one rental, 404 when not visible to him.

Both return `MechLessorRentalDto`, built field by field (`toMechLessorRentalDto`), never by blanking
the full DTO: a field added to `MechRequestDto` tomorrow must not reach the lessor by default.

| Shown                                              | Not shown (O7)                                    |
| -------------------------------------------------- | ------------------------------------------------- |
| id, number, version, status                        | department, requester, created/updated/deleted by |
| model name                                         | comment, requester's files                        |
| site name and address                              | request visa, cancel reason                       |
| planned from/to, actual from/to                    | worked units, final cost                          |
| his rate and unit                                  | extension request and its reason                  |
| responsible name and phone (who meets the machine) | card history                                      |
| receipt versions of the current deal (view below)  | versions of earlier deals                         |

**Versions of the current deal**: back to, not including, the last version retired with
`deal_changed` or `rolled_back`; older versions belong to another deal and may belong to another
lessor (`mechLessorVisibleVersions`, one function for the DTO, the replies of P5–P7, the cap of P7
and the file flag).

**A version as the lessor sees it** (`MechLessorReceiptVersionView`): version number, status, file
(id, name, type, size; none for a waiver), created at and `created_as` (no staff names), decided at,
the rejection reason (a waiver and a revocation show their status and date, not their reason — those
reasons are internal notes), retired at and why. The office view carries names and every reason.

### P13. Files

- `file_is_linked(uuid)` gets an eleventh branch for `mech_request_lessor_receipts.file_id` by a full
  `CREATE OR REPLACE` (the body of `apps/api/drizzle/0243_auto_part_receipts.sql:233` plus the
  branch). Retired versions stay linked: that is O8. `apps/api/test/file-linkage.db.test.ts:656`
  fails if the branch is missing, and `LINK_CASES` (`:372`) gets the new case.
- `canAccessFile` gets a flag `visibleMechLessorReceipt` (field in `FileLinkage`, read by
  `decideFileAccess`, `:244`): the file is a receipt version of a request the principal may see by
  `mechScopeWhere`; for a lessor, `isMechLessorRentalVisible` and a version of the current deal
  (`mechLessorVisibleVersions`). Permission: `mechRequests.read`.
- **Archived requests (O17).** Receipt files of an archived request open for a holder of the
  archive permission (the one that opens the module's archive tab, `assertArchiveVisible`), inside
  his `mechScopeWhere`, without a restore: the receipt is the evidence of a payment and is examined
  after archiving too. Requester attachments keep today's rule — the archive opens the card, not
  their files (`files.ts:563-575`). A lessor never sees archived rentals (O12).
- `collectMechRequestFiles` (`apps/api/src/services/mech-request-files.ts:82`) also collects receipt
  files, so purge deletes them immediately.
- The FK `file_id → files` is **`ON DELETE RESTRICT`**, unlike the link table: this row carries a
  decision. No current path deletes a linked file (`request-files.ts:294-303`; the worker's cleanup
  filters on `NOT file_is_linked`), so the difference shows only when a future bug tries — and then
  it fails loudly instead of silently removing an approved version. Purge deletes the receipt rows
  (cascade from the request) before it deletes the collected files.

### P14. The preview renders the receipt itself

- JPEG: `<img>` from the inline signed URL, as `FilePreviewModal` does
  (`apps/web/src/entities/file/ui/FileLinks.tsx:29`).
- PDF: **pdf.js** (`pdfjs-dist`, exact version pinned, at least two weeks old, ≥ 4.2.67 for
  CVE-2024-4367), imported dynamically only by the receipt preview, so neither the entry nor the
  mechanization route chunk grows by it. Every page drawn to a canvas, fit to width, scrolled
  vertically; «Скачать» always present.
- Settings that the portal's CSP (`deploy/nginx/technic.conf:49`) forces: `isEvalSupported: false`;
  the worker served as a same-origin file (`script-src 'self'` covers it; a `blob:` worker would be
  refused); `cMapUrl` and `standardFontDataUrl` pointing to copies served from the portal (Cyrillic
  receipts with non-embedded fonts need cMaps); no WebAssembly decoders (`'wasm-unsafe-eval'` is not
  in the policy). If the pinned version cannot run under these rules, the CSP change is its own
  decision in the ADR, with `deploy/nginx/stand.conf` kept identical
  (`apps/api/test/deploy-config.test.ts`).
- pdf.js reads the file from the signed storage URL with `disableRange: true` and
  `disableStream: true`: one plain `GET`, no `Range` request and no exposed headers beyond what the
  bucket already declares. The bucket's CORS already allows `GET` and `HEAD`
  (`docs/setup-infra.md:66`), and the runbook forbids proxying files through the API
  (`docs/runbook.md:1262-1267`), so there is **no API fallback**. What is checked is production
  itself: the runbook's curl preflight with `GET` against the prod bucket from the prod origin is a
  step of the deploy checklist (§5); the W3 browser check runs on dev MinIO and proves rendering
  and the CSP, not the prod bucket.
- The renderer lives in `entities/file` as `FilePreviewFrame` (the body of `FilePreviewModal`
  extracted, plus the PDF branch); `FilePreviewModal` keeps its frame for other files, so no other
  screen changes behaviour in this release.

### P15. The visa window and the receipt block

«Проверить чек» (row menu, card strip) opens one window:

- desktop (≥ 992 px): the receipt on the left (about two thirds), facts on the right: number, site,
  model, lessor, rate and unit, planned term, issue date, the version («Версия 2 из 2»), who
  attached it and when, the previous version's rejection reason if any;
- phone: full-screen sheet, the receipt on top, facts below, actions in a sticky footer;
- actions: «Утвердить» (primary), «Отклонить» (reveals a required reason), «Без чека» (reason
  required), «Отозвать утверждение» (reason required, when the current version is approved and the
  rental is «В работе»), «Скачать»; the buttons come from `mechLessorReceiptAccess` over the
  server's permission list (ADR 0223), so a shown button does not end in a 422;
- the window sends the `receiptId` it shows (P5); the 409 closes the window with the server's
  message and refreshes the card.

The receipt block in the card: the current version (file opens in the same preview, status, who and
when, decision and reason), «Версии чека (n)» collapsed below with every retired version openable,
and the buttons of `mechLessorReceiptAccess` («Прикрепить чек» / «Заменить чек», «Проверить чек»,
«Без чека», «Отозвать утверждение», «Отменить „без чека“»).

The windows live inside the card when opened from it (ADR 0140, `modals` of
`MechRequestViewModal`); the four tabs that open the card (requests, «В аренде», history, archive)
pass the receipt props the way they pass `extension` today.

### P16. Marks and the filter

`mechLessorReceiptMark(row)` — a second mark next to the state tag, not a fifth value of it: the
state tag is the rental's single state (ADR 0171 decision 13), and a receipt can wait for a visa in
any of «ждёт подачи», the running rental, «продление ждёт визы», «коррекция завершения». Archived
rows show no mark.

| Mark            | When                                            |
| --------------- | ----------------------------------------------- |
| «чек ждёт визы» | current version `pending`                       |
| «чек отклонён»  | current version `rejected`, request `confirmed` |
| «нет чека»      | `required`, no current row, request `confirmed` |
| none            | approved, waived, not required, or archived     |

The filter «Чек» — «ждёт визы», «отклонён», «нет», «утверждён», «без чека» — is a parameter of
`mechRequestListQuerySchema` (`packages/contracts/src/mech-requests.ts:364`) and of the history
query, served by `mechListWhere` (`apps/api/src/services/mech-request-list.ts:123`) with `EXISTS` /
`NOT EXISTS` over the current row: the count query of `GET /`
(`apps/api/src/routes/mech-requests.ts:261-270`) joins only sites and models, and a condition that
relies on a join would break it. «нет» means `required` and no current row; a rental that does not
require a receipt matches no value. The list rows themselves get the current row by a LEFT JOIN in
`mechBaseQuery` for the mark, and the version count for `mechDeleteScope` (P8) by a grouped
subquery joined under its own alias — a correlated subquery in a single-table drizzle select reads
the wrong row silently, so the count gets a test on a single-table query too.

## 4. Data model

One schema migration `NNNN_mech_lessor_receipts.sql` (number taken at integration, §6). The
`ALTER` of the live `mech_requests` comes first: `CREATE TABLE … REFERENCES files, users` takes
`SHARE ROW EXCLUSIVE` on both, and waiting up to the lock timeout for `mech_requests` while holding
them would stall uploads and account writes for that long.

```sql
SET LOCAL lock_timeout = '10s';

ALTER TABLE mech_requests
  ADD COLUMN lessor_receipt_required boolean NOT NULL DEFAULT false;

CREATE TYPE mech_lessor_receipt_status AS ENUM ('pending', 'approved', 'rejected', 'waived');

CREATE TABLE mech_request_lessor_receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       uuid NOT NULL REFERENCES mech_requests(id) ON DELETE CASCADE,
  version_no       integer NOT NULL,
  file_id          uuid UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
  status           mech_lessor_receipt_status NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_as       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  decided_at       timestamptz,
  decision_comment text NOT NULL DEFAULT '',
  retired_at       timestamptz,
  retired_by       uuid REFERENCES users(id) ON DELETE RESTRICT,
  retired_reason   text,
  CONSTRAINT mech_lessor_receipts_version_unique UNIQUE (request_id, version_no),
  CONSTRAINT mech_lessor_receipts_version_check CHECK (version_no > 0),
  CONSTRAINT mech_lessor_receipts_created_as_check CHECK (created_as IN ('lessor', 'office')),
  CONSTRAINT mech_lessor_receipts_file_check CHECK ((status = 'waived') = (file_id IS NULL)),
  CONSTRAINT mech_lessor_receipts_waiver_check
    CHECK (status <> 'waived' OR (created_as = 'office' AND decided_by = created_by)),
  CONSTRAINT mech_lessor_receipts_decision_check CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT mech_lessor_receipts_pending_check CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT mech_lessor_receipts_reason_check
    CHECK (status NOT IN ('rejected', 'waived') OR btrim(decision_comment) <> ''),
  CONSTRAINT mech_lessor_receipts_retired_check
    CHECK (num_nonnulls(retired_at, retired_by, retired_reason) IN (0, 3)),
  CONSTRAINT mech_lessor_receipts_retired_reason_check
    CHECK (retired_reason IS NULL
      OR retired_reason IN ('replaced', 'deal_changed', 'rolled_back', 'revoked')),
  CONSTRAINT mech_lessor_receipts_revoked_check
    CHECK (retired_reason IS DISTINCT FROM 'revoked' OR status = 'waived')
);

CREATE UNIQUE INDEX mech_lessor_receipts_current_unique
  ON mech_request_lessor_receipts (request_id) WHERE retired_at IS NULL;

-- Every permission set that runs rentals also attaches receipts (P4); deleted sets too, so that a
-- restore stays consistent. The version moves so that an editor opened before the migration saves
-- into a 409, not over the new permission.
WITH touched AS (
  INSERT INTO grant_permissions (grant_id, permission)
  SELECT grant_id, 'mechRequests.lessorReceipt'
  FROM grant_permissions
  WHERE permission = 'mechRequests.status'
  ON CONFLICT DO NOTHING
  RETURNING grant_id
)
UPDATE grants SET version = version + 1, updated_at = now()
WHERE id IN (SELECT grant_id FROM touched);

-- file_is_linked: full CREATE OR REPLACE, body of 0243 plus the receipt branch
```

Notes:

- The runner wraps each file in `BEGIN`/`COMMIT` (`apps/api/src/db/migration-journal.ts:120-124`),
  so `SET LOCAL` holds for the whole file. `ADD COLUMN … DEFAULT false` is metadata-only on
  PostgreSQL 11+, but it takes an `ACCESS EXCLUSIVE` lock on a live table; hence `lock_timeout` as
  the first statement (the S-27 practice, precedent `0391`). Prod runs PostgreSQL 17, dev 16;
  nothing here uses functions in indexes; the data-modifying CTE and `IS DISTINCT FROM` are valid on
  both.
- The waiver check writes P6 into the base (`decided_by = created_by`, office only); the revoked
  check says only a waiver is retired by revocation — a file version goes back to `pending` instead
  (P5), which the pending and reason checks allow once `decided_*` and the comment are cleared.
- No invariant "done ⇒ approved or waived" in the base: it would fail on the first existing `done`
  row (the reason ADR 0171 decision 3 gives). The server holds it.
- The partial unique index is not used by `ON CONFLICT` (inserts follow an explicit retire under the
  request lock), so the drizzle partial-index trap does not apply; a later upsert must repeat the
  predicate in its `where`. `version_no` is computed under the request's row lock, so two attaches
  cannot take the same number; the unique pair is the backstop.
- Drizzle: the table, the enum and the column in `apps/api/src/db/schema.ts` next to
  `mechRequestExtensions` (`:7405`); `docs/database-schema.md` gets the table.

## 5. Compatibility and the deploy window

- **One API process at a time.** The runbook deploys a single API container: there is no period of
  old and new API serving together; the window is "migration applied, old code still running".
- **Old code on the new schema.** Old code never reads or writes the table or the column. It takes
  rentals into work with `required = false` — they are then not gated, the same as rentals taken
  before the release (accepted). Its purge and hard delete cascade receipt rows, but no receipt row
  exists before the new code runs. Its worker's file cleanup is guarded by the new `file_is_linked`.
  It reads the new permission string as unknown — and would delete it on a save of a set (P4).
- **Proof, as for ADR 0171 §15:** the mechanization db suite of the release serving production runs
  green against its own schema plus this migration.
- **Old tabs (bundles before this release) on the new server.**
  - They cannot show or attach a receipt. Their «Завершить аренду» gets a 422 with the P3 text on a
    gated rental; a reload gives the new portal.
  - Their delete of a «Новая» with versions still confirms "deleted with its attachments" while the
    server archives it — the safer of the two, and a reload shows the right label.
  - An old grant editor's save without the new permission is refused by the set's version (opened
    before the migration) or by `requirement_missing` for holders without an office role (after the
    restart). A set without holders saved by an old bundle after the restart loses the permission;
    it is refused later, when the set is assigned to someone who lacks it.
  - No client-floor raise: nothing old breaks silently for an account, and the lessor has no old
    tab — his accounts appear with this release.
- **Deploy checklist additions** (runbook, section of this release):
  1. no edits of permission sets between the migration and the restart;
  2. after the restart, the query «sets holding `mechRequests.status` without
     `mechRequests.lessorReceipt`» returns nothing (otherwise add the row and bump the version);
  3. the curl preflight of the runbook with `GET` against the prod bucket from the prod origin
     (P14);
  4. before the release, the owner answers by survey two questions on production data that the plan
     cannot measure (risks 2 and 4): every site with mechanization rentals in work has a holder of
     `mechRequests.approve`; how many rentals in work have a `vehicle_lessor` as lessor.
- **Rollback.** The old image refuses a schema newer than itself; a rollback after the migration is
  `--previous --restore-db` (runbook). No teardown file: the migration is additive.
- **Release trains.** The change is independent of the floor-7 train (R1 → R1g → floor 7 → R2): it
  needs no floor and touches none of the R2 removals. Before pushing, `Ждёт` in the task journal is
  read (held releases in the push range).

## 6. Waves

Executors commit every step; integration in a `technic-wt/mech-lessor-receipt` worktree; every
commit builds and passes the gates. **The block is pushed whole** (W1–W5 in one push with its
release entry): intermediate commits never reach production, so W2's lessor accounts never run
without W4's page. ADR and migration numbers are taken at integration (`ls docs/adr`,
`ls apps/api/drizzle`, again before `git add`): ADR 0242 and 0243 were taken by parallel streams
while this plan was written.

Required fields that every caller must fill (`MechTransitionState`, `MechRequestDto`,
`mechDeleteScope`) cannot land in a contracts-only commit: the API status route, the portal menu,
`MechStateTag` and the fixtures of `mech-approval-contracts.test.ts:29-96` and
`mech-extension-contracts.test.ts` would stop compiling. They land in W2 together with the server
and the portal call sites (stubs where the portal has no UI yet).

### W1. Contracts that break no caller

- `packages/contracts/src/mech-lessor-receipts.ts` (new, exported from
  `packages/contracts/src/index.ts`; kept out of `mech-requests.ts` so the rules do not ride into the
  entry chunk — measure it in W2, when `mechTransitionBlocker` starts importing the completion
  blocker at runtime): status type and labels, `MECH_LESSOR_RECEIPT_CONTENT_TYPES`, schemas
  `attachMechLessorReceiptSchema`, `decideMechLessorReceiptSchema`, `waiveMechLessorReceiptSchema`,
  DTOs `MechLessorReceiptVersionDto`, `MechLessorReceiptVersionView`, `MechLessorReceiptStateDto`,
  `MechLessorRentalDto`; predicates `mechLessorReceiptAttachBlocker`,
  `mechLessorReceiptDecisionBlocker` (approve, reject, revoke), `mechLessorReceiptWaiverBlocker`,
  `mechLessorReceiptCompletionBlocker`, `mechLessorReceiptAccess(subject, row, has)`,
  `mechLessorReceiptMark`, `isMechLessorSubject`, `isMechLessorRentalVisible`,
  `mechLessorVisibleVersions`.
- `canApproveMechRequest` refuses counterparty-scoped roles (P5).
- Permissions: `mechRequests.lessorReceipt` in `permissions.ts`, `permission-catalog.ts`,
  `grants.ts` (`PERMISSION_REQUIRES` for itself and for `.status`, with the per-pair reason of P4),
  the office bundle (P4); the `forbidden` cell of `grant-scope.ts` with its new reason (P10). **Not**
  the `mech_lessor` type list — that is W2's last step.
- History kinds in `packages/contracts/src/request-history.ts`, labels in
  `mechRequestChangeLabels`; the web `HISTORY_TITLES`
  (`apps/web/src/entities/request-history/model/labels.ts:11`) is compiler-enforced, so W1 touches
  it too.
- Tests: `apps/api/test/mech-lessor-receipt-contracts.test.ts` — blockers × status × version state ×
  subject (revoke only in `confirmed`, waiver refused on a cancelled rental, the lessor's cap per
  account within the deal); marks; completion gate with `required` true/false; access buttons for
  office, lessor, site visa, department visa, foreign visa, administrator; the version cut;
  `canApproveMechRequest` false for an executor holding `.approve` through a custom `has`; "every
  role with `.status` has `.lessorReceipt`"; the requirement `.status` ⇒ `.lessorReceipt` refuses a
  subject that lacks it, with the pair's own reason; "a set holding any `mechRequests.*` is refused
  for the executor role". Pinned sets: `apps/api/test/permissions.test.ts:722-725` (the exact
  manager and dispatcher lists); `grants-contracts.test.ts` comments (`:1807-1811`) and the
  `SCOPED_AXES_BY_MODULE.mech` pin.

### W2. Schema, API, required fields, then lessor accounts

In this order; each step is a commit that builds:

1. The migration (§4) and `schema.ts`.
2. Required fields and their call sites: `MechTransitionState` (P3), `MechRequestDto`
   (`lessorReceiptRequired`, `lessorReceipt` — current in list rows, current and versions in the
   card — and `lessorReceiptVersionCount`), `mechDeleteScope` with the required count (P8), the
   filter parameter in `mechRequestListQuerySchema` and the history query; `mechBaseQuery`
   (`apps/api/src/services/mech-request-dto.ts:140`) with the LEFT JOIN and the grouped count;
   `loadMechRequestDto` with the versions; the portal's menu, `MechStateTag` and the contract test
   fixtures fill the fields (no receipt UI yet); the entry-chunk measurement.
3. `apps/api/src/services/mech-lessor-receipt.ts`: `loadMechLessorReceipts(tx, requestId)` (under the
   request lock), `attachMechLessorReceipt`, `decideMechLessorReceipt` (approve, reject, revoke),
   `waiveMechLessorReceipt`, `retireMechLessorReceipt(tx, row, reason, actor)`,
   `mechLessorReceiptStateFor(p, rows)`; `apps/api/src/routes/mech-request-lessor-receipt.ts`:
   `POST /:id/lessor-receipt` (lessor door), `PATCH /:id/lessor-receipt`,
   `POST /:id/lessor-receipt/waiver`, registered on the same instance next to the extension routes
   (`mech-requests.ts:239`); `bumpRequest` moves from
   `apps/api/src/routes/mech-request-extension.ts:59` to `mech-request-guards.ts` and both use it;
   `assertMechRequestOpenable` takes an optional stale message (P5).
4. The status route: `lessor_receipt_required = true` on `new → confirmed`; the current receipt
   loaded under the lock on every transition and passed to `mechTransitionBlocker`
   (`mech-requests.ts:973`); retire on every `mechTransitionResetsDeal` move (P8).
   `PATCH /:id/deal` (`mech-requests.ts:879-931`): retire only when lessor, unit or the numeric rate
   changes. `DELETE /:id` (`mech-requests.ts:1316-1345`): the version count under the lock.
5. Audit: six actions in the strict list; `AUDIT_ACTIONS` / `AUDIT_KINDS` in
   `apps/api/src/services/mech-request-history.ts:22-78`.
6. Scope, **before** any account can exist: the `preValidation` guard and `mechLessorDoor` config
   (P11), `authenticate` made idempotent; `mechLessorVisibilityWhere`, `mechScopeWhere`,
   `assertMechScope` at every call site, `isMechLessorRentalVisible` with its SQL twin; the two
   lessor routes (P12); `canAccessFile` flags including O17 (P11, P13); `collectMechRequestFiles`
   (P13); access manifest (`apps/api/src/lib/access-manifest.ts:1235-1327`): five new lines.
7. Last: `COUNTERPARTY_TYPE_PERMISSIONS.mech_lessor` (P10), with the pinned sets it moves:
   `apps/api/test/permissions.test.ts:1018-1022` (types with accounts) and `:1045-1062` (profiles);
   `apps/api/test/access-matrix.test.ts` — `DECLARED_PROFILE_KEYS` (`:141-155`) **and** the `allowed`
   lists that name every executor profile (about twelve: `:532`, `:660`, `:681`, `:704`, `:791`,
   `:1283-1444`, `:1595`); the scope text for `mech_lessor` in `permission-catalog.ts:715-725`
   (`portal-sections.test.ts` and `permission-catalog.test.ts` loop over profiles and need only it);
   `registration-request-contracts.test.ts` does not change.

Tests of W2:

- `apps/api/test/mech-lessor-receipt.db.test.ts`: attach, replace (previous retired `replaced` with
  its status intact), the lessor's cap and the office past it, content type refused, unfinished or
  foreign file refused, attach in `new`/`done`/`cancelled` and while archived refused, lessor
  replacing an approved or waived version refused; approve/reject (reason required), decide on a
  cancelled rental allowed, decide while archived refused; revoke of an approval (back to `pending`,
  gate closes again) and of a waiver (retired `revoked`), revoke after completion refused; a stale
  `receiptId` gets the receipt text on the version 409; a `receiptId` of **another request** is
  refused with 409 and changes neither request; version 409 before 422; foreign visa circle 403;
  department visa allowed per ADR 0171 decision 4; the attacher approving his own version allowed
  (O14); waiver rules; completion gate (422, then passes after approval and after waiver; old rental
  with `required = false` completes; attaching to an old rental gates it); deal change retires only
  on change, `1500` against `1500.00` does not; `confirmed → new` and `confirmed → cancelled → new`
  retire; «Вернуть в работу» keeps approval; delete of a «Новая» with versions archives it; purge
  removes every version file; a failing strict audit rolls the change back; the data step adds the
  permission to every set holding `.status`, deleted ones included, and bumps their versions; the
  version count on a single-table query;
- `apps/api/test/mech-lessor-scope.db.test.ts`: every `ACCESS_MANIFEST` route under
  `/api/v1/mech-requests` without the lessor mark answers 403 to a mech lessor with an empty body; an
  unauthenticated call still answers 401; his own rentals only on the lessor routes; `confirmed`
  only; a foreign rental 404 on reads **and on the attach door**; after a deal change the old lessor
  loses the rental; the new lessor sees neither the predecessor's versions nor versions before a
  return to «Новая»; the lessor DTO's keys and the nested keys of `MechLessorReceiptVersionView`
  equal their allow-lists exactly (a waiver and a revocation carry no reason); the replies of P5–P7
  to a lessor hold no staff names and no versions of earlier deals; `resolveCounterpartyId` accepts
  a `mech_lessor` counterparty; `isMechLessorRentalVisible` and its SQL twin agree over a grid;
- a unit test of `mechLessorVisibilityWhere` for a `vehicle_lessor` principal that holds
  `mechRequests.read` through a test `has`: `NEVER_MATCH` — the "vehicle lessor sees nothing" db
  case alone passes on the permission check and pins nothing;
- `apps/api/test/route-authorization.test.ts` recognises the guard by its marker;
- `apps/api/test/file-access.test.ts` and a db case: receipt files for office in scope, foreign
  site, own lessor, foreign lessor, vehicle lessor; versions of an earlier deal refused to the
  lessor; files of his rental refused once it closed; a requester's attachment refused to the
  lessor of that very rental; receipt files of an archived request open for an archive holder in
  scope and stay closed for one out of scope, while its attachments stay closed (O17);
- `apps/api/test/file-linkage.db.test.ts` with its new `LINK_CASES` entry;
- the window proof of §5.

### W3. Portal: office and visa holder

- `entities/file`: `FilePreviewFrame` extracted; PDF branch with lazy `pdfjs-dist` (`disableRange`,
  `disableStream`), worker and cMaps as same-origin assets (Vite), CSP-compatible settings (P14).
- `entities/request-history`: the optional `renderFiles` prop of the history table (P9).
- `features/mech-lessor-receipt`: `model/useMechLessorReceiptActions` (mutations registered in
  `apps/web/cache-invalidation-map.json`; plain functions, not hook results, in write handlers —
  the cache scan cannot see through a hook), `ui/MechLessorReceiptBlock`,
  `ui/MechLessorReceiptUploadModal` (one file, `accept`), `ui/MechLessorReceiptVisaModal` (P15),
  `ui/MechLessorReceiptReasonModal` (waiver and both revocations: a reason only).
- `pages/mech`:
  - `mechRequestMenu.tsx`: items «Прикрепить чек» / «Заменить чек», «Проверить чек», «Без чека»,
    «Отозвать утверждение», «Отменить „без чека“»; their keys join `MECH_RENTAL_ACTION_KEYS`
    (`:111-119`) so the «В аренде» tab keeps them; the transition loop (`:143`) today **drops** a
    blocked move — it changes so that `done` blocked by the receipt is pushed `disabled` with the
    blocker text, key `status:done` unchanged (the header comment `:34-37`, which says only delete
    is shown disabled, is updated);
  - `mechRequestActions.tsx`: the strip «Чек арендодателя ждёт визы» with its actions;
  - `MechRequestViewModal.tsx` and the four tabs that open it: the receipt block and windows (P15);
  - `mechRequestFilters.tsx` and `MechFilterBar.tsx`: the filter «Чек» (P16);
- `entities/mech-request/ui/MechStateTag.tsx` and the phone card: the receipt mark (P16), none on
  archived rows; the visa window uses the server's 409 text instead of `mechFailureText`
  (`entities/mech-request/model/failure.ts`).
- Tests: `apps/web/test/mech-lessor-receipt.test.tsx` — menu by role; «Завершить аренду» disabled
  with the reason; upload accepts one PDF/JPG; the visa window renders `<img>` for JPEG and hands a
  PDF to the renderer (a mocked `pdfjs-dist` must be called with the file's URL and the two
  `disable*` options — a bare "canvas host exists" check would pass with any div); reject, waiver
  and both revocations require a reason; the waiver door without a file; 409 closes the window with
  the server's text; marks; filter; the history line opens the version;
  `apps/web/test/permission-oracle.test.ts` covers `mechLessorReceiptAccess`.
- A real-browser check of the preview (headless Chrome harness, desktop and Android viewport, a
  Cyrillic PDF with non-embedded fonts) on dev MinIO: it proves rendering and the CSP; the prod
  bucket is the deploy checklist's (§5).

### W4. Portal: the lessor

- `pages/mech/lessor/`: `MechLessorRentalsPage` (one list: number, model, site, term, rate, receipt
  mark; filters period and receipt state), `MechLessorRentalCard` (P12 fields, receipt block with
  «Прикрепить чек» / «Заменить чек», versions of the current deal); `MechRequestsPage` renders it
  when `isMechLessorSubject(user)`, lazily, so the office route chunk does not carry it, and never
  mounts the office tabs (they would call routes that refuse him).
- `entities/mech-request/api`: `lessorRentals`, `lessorRental` client methods and query keys.
- The section opens by `mechRequests.read` (`packages/contracts/src/portal-sections.ts:110-129`);
  for a lessor it is the only section, so it is his start page.
- Tests: `apps/web/test/mech-lessor-rentals.test.tsx` (no hidden field rendered, no office tab, no
  create button, attach flow, replace offered only for pending or rejected); the oracle test gains
  the `operator × mech_lessor` subject with its own counterparty id (today `shipped()` gives every
  counterparty subject the service counterparty, `apps/web/test/permission-oracle.test.ts:205-241`).

### W5. Documents and release

- ADR `NNNN-mechanization-lessor-receipt.md`, new header form: `Статус`,
  `Домены: механизация, доступ`, `Область`; it records O1–O17, P1–P16, the reversal of ADR 0152
  decision 6, the kept `forbidden` cell with its new reason, why the executor boundary stays
  unreachable without editing `cycleTransitions`, the accepted directories exposure (O16) and the
  counterparty-deactivation gap (P10); ADR 0152 and 0171 get "changed by" links; `pnpm docs:index`.
- `docs/code-map.md` (Механизация: new contracts file, routes, services, features),
  `docs/database-schema.md`, `docs/access-model.md` (subject table `:88-91`, the role and permission
  counts `:198-202`, executor matrix `:294-335`, `:339`, `:1164`), `docs/runbook.md` (the deploy
  checklist additions of §5 and "cutting a lessor off"), the comments that said "the lessor never
  logs in".
- Release: `NNNN_releases_mech_lessor_receipt.sql` with the entry in the user's words — written for
  external readers too, since every signed-in account, a lessor included, reads the release feed
  (`apps/api/src/lib/access-manifest.ts:312`) — `VERSION` raised to it, `pnpm check:version`; after
  the push the annotated tag `v<version>` on the commit that brought the release migration.
- Journal: this card (commits, tails, handoff) and a new card «Доступ: сузить справочники для внешних
  исполнителей» (O16).

### Gates (every commit, then on the integrated tree)

`pnpm check`; `pnpm check:db` on its own fresh database (`OWN_DB_NAME`); `pnpm check:docs`;
`pnpm check:version` (W5); `pnpm typecheck` judged by its exit code; eslint of the portal from the
repository root; `bundle:check` in the main tree — any growth of the mechanization route or the entry
is shown to the owner before the budget is raised by hand; `pnpm maintain surfaces` on the migration,
`permissions.ts`, `grants.ts` and `grant-scope.ts` (protected: never automatic).

## 7. Risks

1. **A scope leak to the first external users of the module.** Mitigation: the module refuses
   executors by default in `preValidation` (P11), lessor accounts become possible only after the
   guard and the axis (W2 order), no permission set can widen the lessor (P10), the lessor's doors
   are an allow-list DTO (P12), requester attachments never match for him, and the scope suite walks
   the access manifest with empty bodies instead of a hand-written list.
2. **Completion stuck without a visa holder.** A site without a holder of `mechRequests.approve`
   cannot complete gated rentals, the same risk ADR 0171 accepted for take-in-work; asked of the
   owner before the release (§5).
3. **pdf.js under the CSP.** Settled by the real-browser check in W3; the prod bucket by the deploy
   checklist.
4. **The lessor of an old rental is a `vehicle_lessor`.** The base still allows that type in
   `lessor_type` (ADR 0152 decision 6). Such rentals are invisible to every lessor account: the axis
   matches `mech_lessor` only. Only the office attaches their receipts; their number is asked of the
   owner before the release (§5).
5. **iPhone photos.** HEIC is not accepted; iOS Safari converts a library photo to JPEG when the
   input accepts only JPEG — confirmed in the W3 browser check, otherwise the upload window says
   which formats it takes.
6. **Directories open to the lessor** (O16): accepted for this release; the separate card closes it
   for every executor.
7. **A deactivated lessor keeps working** until his accounts are deactivated (P10): a runbook step.
8. **Parallel streams.** ADR and migration numbers are taken at integration.

## 8. Out of scope

Mail and reminders; the receipt amount (O9); self-registration of lessors; anything for the lessor
outside his rentals in work (no closed list, no other modules); lessor edits of the request;
receipts for vehicle orders; OCR of receipts; byte sniffing of uploads; proxying files through the
API; narrowing directories for executors (its own card, O16); tying sessions to the counterparty's
state.

## 9. Review log

### Round 1 (02.11.2026) — the plan against the code

21 findings, all accepted; six of them changed decisions:

1. **Any entry into «Новая» retires the receipt**, not only `confirmed → new`: the deal is erased by
   `mechTransitionResetsDeal`, including `cancelled → new`; the lessor's version cut stops at
   `rolled_back` too (P8, P12).
2. **Five audit actions, not four**: one action maps to one history kind; approve and reject split
   (P9).
3. **The history table does not render file links** — it prints text. O8 "openable from the
   history" now has its own change: a `renderFiles` prop used by the mechanization card only (P9, W3).
4. **«Завершить аренду» was hidden, not disabled**, by the menu loop; W3 changes the loop for the
   receipt barrier.
5. **«Без чека» had no door when there is no file to show**: a menu item and card button with a
   reason dialog (P6).
6. **The lessor could open requester attachments** of his own rental by id: the attachment branch
   never matches for him (P11).

Smaller corrections: `canAccessFile`, not `decideFileAccess`, holds the queries; the vehicle lessor
gets 403 and the 404 for the mechanization lessor got its own reason; the filter uses `EXISTS`
because the count query has no join, and «нет» is defined; W3 names `MechStateTag` in `entities`,
`MECH_RENTAL_ACTION_KEYS`, the four tabs and archived rows; the transition-state fields are
required; the access-matrix updates are about twelve lists; `LINK_CASES`; the P7 reply is built per
audience and the lessor's version view is specified; `requireActive: true`; the role counts in
`access-model.md`; the contracts index export and the entry-chunk measurement; administrator-built
permission sets get the new permission by a data step of the migration.

### Round 2 (02–03.11.2026) — an adversarial read of the design

15 findings; three went to the owner as the fourth survey (O14–O16), the rest are accepted:

1. **A permission set could have widened the lessor.** The `forbidden` cell of the grant matrix was
   the only barrier, and its reason was about to become false. It stays, with a new reason and a
   test; `canApproveMechRequest` no longer answers `true` for an executor (P5, P10).
2. **The refusal of the lessor was opt-in per route.** It became deny-by-default in the plugin with
   marked lessor doors, and the suite walks the access manifest (P11).
3. **Hard delete would have erased receipt versions** of a «Новая» that had been in work; such a
   «Новая» is archived instead (P8).
4. **A `receiptId` of another request** could have been decided through one's own rental; the write
   binds `request_id`, with a test (P5).
5. **The grant data step** did not bump set versions, and an old grant editor would have dropped the
   new permission silently; the step bumps versions, and `.status` now requires `.lessorReceipt`
   (P4, §4, §5).
6. **Four-eyes** — the owner allowed self-approval (O14); **undoing an approval** — the owner allowed
   it in «В работе» (O15), now the `revoke` decision.
7. **Directories** — accepted as for vehicle lessors, narrowing as its own task (O16).
8. **The lessor's file flag** ignored O12; one predicate now serves his doors, his attach and his
   files (P11, P13).
9. **`file_id` FK** is `RESTRICT`: the row carries a decision (P13, §4).
10. **The version cap** applies to the lessor only (P7).
11. **"Deal changed"** compares the numeric rate, not formatted money (P8).
12. **`created_as`** is stored at insert (P1, §4).
13. **Tests**: the vehicle-lessor case pins `NEVER_MATCH` by a unit test; the PDF jsdom test checks
    the renderer call, and the browser check is named as the real proof; archived, cancelled,
    foreign-attach, after-close and nested-key cases added (W2, W3).
14. **Simplification**: P5 keeps the module's protocol and only chooses the words of the 409.
15. **Simplification**: `cycleTransitions` is not edited; the boundary stays unreachable on three
    counts, recorded in the ADR (P10).

### Round 3 (03.11.2026) — sign-off review, the fixes themselves under attack

One blocker, three majors, eight minors; one owner question became the fifth survey (O17). All
accepted:

1. **Blocker: the deny-by-default guard of round 2 would have refused nobody.** A plugin
   `preHandler` runs before the route's `authenticate`, so no principal exists yet, and validation
   runs before it, so the suite would have seen 400s. The guard is a `preValidation` hook that
   authenticates itself; `authenticate` becomes idempotent; the guard carries the route-authorization
   marker; the suite sends empty bodies (P11).
2. **W1 could not pass its own gate, and its green commit would have opened a leak.** Required
   fields move to W2 with their call sites; the `mech_lessor` type list is W2's last step, after the
   guard and the axis; the block is pushed whole (§6).
3. **The API file fallback contradicted the runbook**, and the dev browser check proved nothing
   about the prod bucket. No fallback; pdf.js asks one plain `GET`; the prod bucket is a deploy
   checklist step (P14, §5).
4. **O8 for archived requests** — the owner chose: receipts open in the archive for its holders
   (O17, P13).
5. **The window between migration and restart** can still lose the new permission (the old API
   deletes unknown strings as orphans); a runbook step forbids set edits in the window and a
   post-deploy query checks the invariant; deleted sets get the row too (P4, §4, §5).
6. **Barrier 4's text** would have told the administrator the account "does not see the module"; the
   pair gets its own reason (P4).
7. P10's claims held; the `SCOPED_AXES_BY_MODULE.mech` pin keeps its value with a new reason.
8. `mechDeleteScope` takes the count as a required argument; the old bundle's delete confirmation
   is named in §5.
9. **Lock order in the migration**: the `ALTER` of `mech_requests` comes before the `CREATE TABLE`
   that locks `files` and `users` (§4).
10. **Every `assertPlaceObjectScope` of the module** becomes `assertMechScope`, not only the three
    named before (P11).
11. **Guesses removed**: reply shape and version bump of decide and waive; texts of the cap and the
    content-type refusals; the lessor list envelope; the SQL twin of the visibility predicate with a
    test; the cap per account within the deal; the receipt loaded on every transition; the grouped
    count against the drizzle correlation trap; the replaced version in the waiver event;
    `permissions.test.ts:722-725`.
12. **Production exposure**: cutting a lessor off is a runbook step and an ADR note (counterparty
    deactivation does not end sessions); the release entry is written for external readers; risks 2
    and 4 go to an owner survey before the release; the waiver's revocation has its own label and
    result («нет чека»).

Verdict of round 3, after these fixes: implementable. The largest remaining risk is still a scope
leak to the first external users; it is now held by the guard, the wave order, the grant matrix and
a suite that walks the manifest, and W2 must not be reordered.
