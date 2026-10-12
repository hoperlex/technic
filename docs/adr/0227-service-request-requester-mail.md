# ADR 0227. The requester gets letters about messages and state changes of his office equipment request

- Статус: Принято (12.10.2026). Implemented in branch `m1-requester-mail` (from commit
  `08db31db`), not yet in `origin/main`; the two events arrive switched on with the release
  migration (D6), and the release record is written by the integrator at the push
- Домены: оргтехника, почта
- Изменяет: [ADR 0159](0159-service-request-mail-events.md) — decision 9 («Сервису уходят только
  адресованные ему комментарии»): a message addressed «Заявителю» or «Всем участникам» now also
  reaches the request author by mail; the service and contractor letters of that decision stay as
  they are
- Связано: [ADR 0153](0153-service-request-contractor-mail.md) (letters to the contractor, the
  `repair` channel), [ADR 0141](0141-service-request-chat.md) (the request discussion and the
  addressee of a message), [ADR 0160](0160-service-request-audiences.md) (the requester card
  projection the author's body follows), [ADR 0191](0191-version-numbering.md) (the release
  record), [ADR 0133](0133-service-request-unified-cycle.md) (the unified cycle and its
  auto-close, which now tells the author)
- Область: [service-request-requester-mail.ts](../../apps/api/src/services/service-request-requester-mail.ts)
  (new: the planner, its configuration, the author's body),
  [service-request-mail.ts](../../apps/api/src/services/service-request-mail.ts) (the `requester`
  fields row, shared detail lines, the summary link by the fields map, the chat target filter),
  [service-request-mail-audience.ts](../../apps/api/src/services/service-request-mail-audience.ts)
  (the fifth audience and source),
  [office-equipment-candidate-mail.ts](../../apps/api/src/services/office-equipment-candidate-mail.ts)
  (the forced fields row), [service-request-chat.ts](../../apps/api/src/services/service-request-chat.ts)
  (the comment hook, `requesterMailEnabled`),
  [service-request-bulk.ts](../../apps/api/src/services/service-request-bulk.ts) (Reply-To of the
  digest by audience), [service-requests.ts](../../apps/api/src/routes/service-requests.ts) (the
  status hook in `recordServiceStatusTransition`),
  [internal-service-requests.ts](../../apps/api/src/routes/internal-service-requests.ts) (the
  auto-close hook), [admin-mail.ts](../../apps/api/src/routes/admin-mail.ts) (the debug send),
  [audit.ts](../../apps/api/src/lib/audit.ts), [schema.ts](../../apps/api/src/db/schema.ts);
  contracts — [module-mail.ts](../../packages/contracts/src/module-mail.ts),
  [mail-log.ts](../../packages/contracts/src/mail-log.ts),
  [mailings.ts](../../packages/contracts/src/mailings.ts),
  [service-requests.ts](../../packages/contracts/src/service-requests.ts); portal —
  [ServiceChatComposer.tsx](../../apps/web/src/features/service-chat/ui/ServiceChatComposer.tsx),
  [ServiceMailEventsBlock.tsx](../../apps/web/src/pages/admin/ServiceMailEventsBlock.tsx); tests —
  [service-request-requester-mail.db.test.ts](../../apps/api/test/service-request-requester-mail.db.test.ts),
  [service-chat-contracts.test.ts](../../apps/api/test/service-chat-contracts.test.ts),
  [service-chat.test.tsx](../../apps/web/test/service-chat.test.tsx)
- Миграции: [0372_service_request_requester_mail_kinds.sql](../../apps/api/drizzle/0372_service_request_requester_mail_kinds.sql)
  (M1), [0373_service_request_requester_mail_events.sql](../../apps/api/drizzle/0373_service_request_requester_mail_events.sql)
  (M2); the numbers were the next free ones at creation and may be renumbered on a collision with
  a parallel stream — the code and the tests never name them

## Context

Complaint of the owner (2026-10-07): requesters do not read comments and clarifications in the
portal; comments left in office equipment requests must reach them by email.

Before this decision the requester got no letter of the request cycle at all, by design:

- comment letters: `CHAT_MAIL_TARGETS` mapped `customer` to no target and `all` to the service
  mailbox and the service side only;
- status letters: `TARGETS_BY_EVENT` sent `status_changed` / `cancelled` to the service mailbox
  and the service side only;
- the auto-close (`runAutoClose`) wrote the status history row by raw SQL and queued no letter to
  anyone.

That boundary was the owner's decision of 04.09.2026 (`docs/office-equipment-mail-expansion-plan.md`
§10 item 3, ADR 0159 decision 9). All the requester had was the bright unread badge for comments
addressed «Заявителю» or «Всем участникам» (`audienceMatches`), visible only inside the portal.

The owner closed the product forks by survey on 2026-10-07 (D1–D8) and approved the engineering
decisions E1–E12 by survey on 2026-10-12, confirming three of them explicitly: E3 (skip the
requester letter when the author already receives the service letter about the same fact), E8
(the outcome goes to the audit only, no notice to the actor) and E10 (a closed per-event audience
map in contracts, the two candidate events' labels fixed too).

## Decision

### Owner decisions (survey 2026-10-07)

| #   | Fork                 | Decision                                                                                                                                                                                                                                |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Who receives         | Only the request author (`service_requests.created_by`). Colleagues of the customer side and the free-text «Ответственный» receive nothing.                                                                                             |
| D2  | Which comments       | Addressee «Заявителю» (`customer`) or «Всем участникам» (`all`). Accepted consequence: service ↔ contractor messages written to «Всем участникам» reach the requester too.                                                              |
| D3  | Which status changes | All four groups: entry into «В работе» (taken into work, incl. return to rework and resume from hold); «Отложена» with the reason verbatim; «Выполнена» and «Закрыта» (incl. auto-close); «Отменена» (any arc, incl. estimate refusal). |
| D4  | Where a reply goes   | Nowhere: Reply-To is the portal's general address (`MAIL_REPLY_TO`); the letter says to answer in the portal discussion.                                                                                                                |
| D5  | Switches             | Two rows in «Рассылки → События писем»: requester comment letters and requester status letters, independent of each other and of the service/contractor events.                                                                         |
| D6  | State at deploy      | Enabled by the release migration.                                                                                                                                                                                                       |
| D7  | Sender               | The office equipment channel `repair` (`MAIL_ACCOUNT_REPAIR_FROM`), with Reply-To overridden per D4.                                                                                                                                    |
| D8  | Opt-out              | None. A noisy flow is stopped by the administrator's switch.                                                                                                                                                                            |

«Выполнена» of D3 is the status `done`, labelled «Решена» in the portal.

### Engineering decisions (approved 2026-10-12)

**E1. Two new events, each with its own `mail_kind`.** `service_request_requester_comment` and
`service_request_requester_status`. A kind of its own per event is mandatory (ADR 0159 §2: the
queue is unique on `(kind, dedupe_key)`). Anchors: the message id and the status history row id;
the dedupe key is `<event>:<anchor>:<authorUserId>` (no colons inside the parts). _In code:_
`MODULE_MAIL_EVENTS`, `MAIL_KINDS`, `mailKindEnum`; the key is built in `queueRequesterMail`.

**E2. The requester planner is a separate module, independent of the service events.**
`apps/api/src/services/service-request-requester-mail.ts` exports `queueRequesterMail(tx, …)`. It
reads its own switch, checks the configuration (`mail_disabled`, `channel_missing`), reads the
author and writes its own `serviceRequest.mailPlanned` audit row. It does not sit inside
`queueServiceMailForIntent`: that function returns early on `event_off` / `not_needed` of the
service event, and D5 requires independence. Three hook points:

- **status:** `recordServiceStatusTransition` in `routes/service-requests.ts` — the single point
  that writes a status history row for every arc (single handles, bulk rows, estimate refusal,
  creation). The planner is called there even when the service mail plan is `null`, and filters by
  `toStatus` through a closed `Record<ServiceRequestStatus, boolean>` (`REQUESTER_STATUS_LETTERS`):
  a new status must answer whether the requester hears about it. `new` → false (D3). _In code:_
  `requesterHearsAbout(from, to)` also refuses a row with `from = to` — the executors handle writes
  such a row for a reassignment, and assignment letters are out of scope (see «Out of scope»); the
  rule is by the entered status, so an administrative rollback into `done`, `in_work` or
  `accepted` also tells the author, and a rollback into `new` does not.
- **auto-close:** `runAutoClose` — `RETURNING id` added to the history insert, the planner called
  inside the per-row savepoint with a system actor (`null`). The service side stays silent on
  auto-close, as before.
- **comments:** `postChatMessage` in `services/service-request-chat.ts`, after the service letter,
  in the same transaction; origin `import` never queues (as for service letters).

**E3. The recipient.** The author row is read inside the transaction `FOR SHARE`, active, not
deleted, non-empty email — the same reader as `candidateAuthorRecipients` in
`office-equipment-candidate-mail.ts` (the existing letter to an author). No permission check: the
letter is about the author's own request. Skipped, with the reason in the audit row (`skip`):

- the actor is the author (own comment, own cancellation) → `not_needed` (`actor_is_author`);
- the author's address is already among the recipients of the service letter about the same fact
  (staff who filed a request and are on the service side) → `not_needed`
  (`service_letter_covers_author`); two letters about one fact to one person is noise. If the
  service event is switched off, the requester letter goes. _In code:_ "the recipients of the
  service letter" are all of them, copies included, compared by normalized address;
- the author is inactive, deleted or without email → `no_recipients` (`author_unreachable`).

On `not_needed` no copy is sent either (the copies observe the author's letter, and there is
none); on `no_recipients` the copies still get theirs, as with the service planner.

**E4. A fifth audience `requester`.** Added to `ServiceMailAudience`; the closed maps
`SERVICE_MAIL_AUDIENCE_FIELDS` and `CANDIDATE_LETTER_FIELDS` force a row. Fields follow the
requester card projection (`SERVICE_REQUEST_FIELD_AUDIENCE`, ADR 0160): finance — no; assignees
and service company — yes (the card shows them); place, department, contact — yes; author — no (it
is the reader); attachments count — no (the card hides acts and invoices, a count would leak
them); description — yes (it gates the hold/cancel reason and the comment text, and the
description is the author's own); portal link — yes, with `&chat=1` for comment letters (the
parameter is handled in `RequestsTab.tsx`). Wording: subject `СО-4312 · Новое сообщение по вашей
заявке` and `СО-4312 · <what happened>`; status lines «Заявку приняли в работу», «Заявку
отложили. Причина: …», «Работы по заявке выполнены. Если неисправность осталась — напишите в
обсуждении заявки в портале», «Заявка закрыта» / «Заявка закрыта автоматически», «Заявка
отменена. Причина: …». Footer: «Отвечать на это письмо не нужно — его никто не прочитает.
Ответить можно в обсуждении заявки в портале.» _In code:_ the author's body is built by
`buildRequesterLetter` from the same letter data and detail lines as the service bodies
(`requestDetailLines`); it carries «Статус: …» and «Исполнитель: …» lines, «Написал» / «Кому» and
the message for a comment letter, the description, the link and the footer. The candidate letters
never address this audience; their row is the copy's. A copy of a requester event gets the
redacted copy body of ADR 0159 decision 7.

**E5. Reply-To.** Set explicitly to the default channel's `MAIL_REPLY_TO` (the `replyTo` of the
default account in the configuration), falling back to its `MAIL_FROM` address. Never empty: the
worker transport lets the channel's own Reply-To win over an empty one, and for `repair` that is
the service mailbox — the opposite of D4. _In code:_ `requesterMailConfig()`; a portal with
neither address answers `channel_missing` — the letter is not sent rather than sent with the
service mailbox as Reply-To.

**E6. Frequency cap and summary.** Requester letters pass the same cap (all module letters per
request + address + UTC hour). `queueActivitySummary` decided the link by `audience ===
'internal'`; it now reads the audience fields map, so the requester summary keeps the link, and it
carries the D4 Reply-To (the recipient's own) and the footer.

**E7. Bulk operations.** The bulk sink already groups by `(recipient, audience)`; a bulk cancel /
hold / resume / start / accept of several requests by one author yields one digest.
`queueBulkDigest` in `service-request-bulk.ts` sets Reply-To per audience (requester → D4; the
other audiences keep the channel's) and adds the footer to the author's digest.
`service_request_bulk_mail_items.audience` has no CHECK — no migration.

**E8. The portal notice of the acting person is unchanged.** The requester outcome goes to the
audit only (`targets.requester` of the planner's own row): the actor cannot fix the author's
account, and a warning would be noise.

**E9. The composer notice.** `CHAT_MAIL_TARGETS` gains the target `requester` for `customer` and
`all` (one rule, one place); the service planner filters it out (`serviceChatTargets`).
`chatMailNotice` names «заявитель». The chat summary DTO gets an additive `requesterMailEnabled`
(requester comment switch + mail enabled + `repair` configured — and, by E5, a portal reply
address); `mailEnabled` keeps its meaning. The composer omits «заявитель» when the viewer is the
author (`participantSides` contains `customer` only for the author — `participantSidesOf` passes
`wideCustomer = false`). _In code:_ `chatMailNotice(plan, chat)` takes the three server answers and
returns one of three lines: who gets a letter; that the addressees exist but their letters are off
right now; that the message is addressed only to portal readers.

**E10. Closed registries extended.** `MODULE_MAIL_EVENTS`, `moduleMailEventLabels`,
`moduleMailEventHints` (`module-mail.ts`); `MAIL_KINDS`, `mailKindLabels` (`mail-log.ts`);
`MAIL_TEST_KINDS` and its maps (`mailings.ts`) plus the debug-send renderer in the admin mail route.
The events block (`ServiceMailEventsBlock.tsx`) said for every event that letters go «наружу —
сервисной компании»; a closed per-event audience map in contracts (`moduleMailEventAudience`,
`moduleMailAudienceEnabledNotes`, `moduleMailAudienceEnableWarnings`) now makes the note and the
enable confirmation name the real addressee: the author for the new events, the reviewers / the
author for the two candidate events (which were wrong too). _In code:_ the debug send of the
status kind renders the «Отложена» wording with a sample reason whatever the sample request's
state, and both kinds go with the D4 Reply-To, so the administrator sees what the author gets.

**E11. Migrations.** Numbers are taken at file creation.

- M1 — `ALTER TYPE mail_kind ADD VALUE` ×2, alone in its file: the runner applies one file per
  transaction, and a new enum value is unusable before commit (precedent `0272`).
- M2 — `module_mail_event_settings_event_check` replaced by the eleven values and the two rows
  inserted with `is_enabled = true` (D6) (precedent `0273` + `0320`).
- M3 — the release record (`app_releases`, ADR 0191): «Заявителю приходят письма о сообщениях в
  обсуждении и о смене состояния заявки». Written by the integrator together with the release
  tag; not part of the implementation branch.

The schema of `users` / `service_requests` does not change; `apps/api/teardown/` holds nothing for
these tables (it is for irreversible cutover migrations only).

**E12. Copies.** `module_mail_recipients` rows may subscribe to the new events like any other and
get the redacted `copy` body. Nothing special.

### Deploy window and compatibility

- Migrations run before the restart. M2 inserts enabled rows, but the old server (`dc647215`) does
  not know the events and queues nothing: `git grep service_request_requester dc647215` finds no
  code, its `GET /admin/mail/events` maps its own registry and ignores extra rows, and its
  `PATCH /admin/mail/events/:event` answers 404 for them. The CHECK swap on an eleven-row table is
  instant.
- The client field is additive; an old bundle shows the old notice for the window. No client floor
  bump (no whole-set form changes).
- Rollback: kinds and rows left behind are inert; stopping letters without a rollback is a switch.

### Out of scope

Opt-out (D8); letters to colleagues or to the free-text responsible person (D1); replies by mail
landing in the discussion (no incoming mail parsing); requester letters on assignment, estimate,
documents and «Новая» (creation, rollback); any change to the service/contractor letters,
including their silence on auto-close.

### Administrator actions after deploy

They live in the guide: [guide-office-equipment-mail.md](../guide-office-equipment-mail.md),
section «Письма заявителю» — check `MAIL_ENABLED`, the `repair` channel and `MAIL_REPLY_TO`; find
the two rows in «Рассылки → События писем» enabled; send the two kinds from «Отладка»; run the
pilot; tell the service staff how to reach the requester.

## Consequences

- **The requester learns what happens to his request without opening the portal**: a message
  addressed to him or to everybody, taken into work, put on hold with the reason, done, closed,
  cancelled with the reason. The letter answers the question «что с моей заявкой» and sends him
  to the discussion to reply.
- **Service ↔ contractor messages written to «Всем участникам» reach the requester too** (D2,
  accepted). Service staff who want a message to stay between them address the side, not
  everybody; the line under «Кому» says before «Отправить» who gets a letter.
- **Volume grows**: an active request can send its author several letters an hour; the cap (12 per
  hour, then one summary) bounds it, and the administrator's switch stops either flow at once.
- **A reply by mail goes to the portal's general address**, which nobody reads for request
  business; the footer says so, and a misconfigured `MAIL_REPLY_TO` sends replies somewhere
  unexpected — E5 never leaves it empty, and the guide asks to point it deliberately.
- **Staff who file a request and work on it** get one letter per fact — the service one — not two.
- **The `repair` From reaches internal mailboxes** now, not only contractors: deliverability is
  checked on the pilot.

## Tests

The decision's matrix, in `service-request-requester-mail.db.test.ts` unless noted:

| Row | What                                                                                     | Where                                                                                   |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `customer` / `all` → one letter each; `operator`, `it`, `service`, named executor → none | «1. «Заявителю» и «Всем участникам» — по письму автору…»                                |
| 2   | the author writes `all` → none; a colleague writes `all` → a letter                      | «2. своё сообщение автору не приходит…»                                                 |
| 3   | origin `import` → none                                                                   | `service-chat-contracts.test.ts`, «…остальные стороны — нет» (no route writes `import`) |
| 4   | start, rework, resume, hold, done, accept, auto-close, cancel, refusal; `new` → none     | «4. весь цикл…», «4. автозакрытие…», «4. отмена статусом…», «4 и 10. отказ по объёму…»  |
| 5   | the author cancels own request → none                                                    | «5. автор сам отменил заявку…»                                                          |
| 6   | author inactive / deleted → none, `no_recipients`                                        | «6. автор отключён или удалён…»                                                         |
| 7   | the author on the service side → one letter; service event off → the requester letter    | «7. автор получает письмо службы…»                                                      |
| 8   | switch independence both ways                                                            | «8. рубильники независимы в обе стороны»                                                |
| 9   | `repair`, Reply-To = portal address (never empty), link opens card and chat              | the two «9. …» cases                                                                    |
| 10  | no estimate sum, no attachments count, no document names                                 | «4 и 10. отказ по объёму работ…»                                                        |
| 11  | cap exceeded → the summary with link and portal Reply-To                                 | «11. сверх потолка…»                                                                    |
| 12  | bulk cancel of three requests → one digest, three lines, portal Reply-To                 | «12. массовая отмена…»                                                                  |
| 13  | the same fact twice → one letter                                                         | «13. повтор того же факта…»                                                             |
| 14  | contract `chatMailTargets` / `chatMailNotice`; the composer names / omits «заявитель»    | `service-chat-contracts.test.ts`, `apps/web/test/service-chat.test.tsx`                 |
| E12 | a copy of a requester event gets the redacted body                                       | «копия на событие заявителя получает урезанное тело (E12)»                              |
