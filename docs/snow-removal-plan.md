# Plan: snow removal — a request type of its own in the waste section

Drafted 25.11.2026 from the owner's request and a survey the same day. This is **intent, not
state**: once implemented, the decision lives in ADR 0250 (number to be re-checked) and the code.

## 0. Decisions taken in the survey (25.11.2026)

| #   | Question                                   | Answer                                                                                                                                  |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Separate request type or a waste type only | Separate type «Вывоз снега» in the request-type list, so requesters do not confuse it with garbage                                      |
| S2  | Waste type                                 | A service waste type «Снег» set by the server; never offered in the waste-type choice of other requests                                 |
| S3  | Who executes                               | The same operators bound to the object; no new bindings                                                                                 |
| S4  | Ticket at completion                       | Mandatory, exactly as for garbage; recognition and reconciliation unchanged                                                             |
| S5  | Minimum ordered volume                     | 8 m³, the garbage rule (`MIN_WASTE_VOLUME_M3`)                                                                                          |
| S6  | Price                                      | **No price list for snow.** No estimated cost on the request; the cost is typed by hand into the completion's «Стоимость» field         |
| S7  | Cost at completion                         | Optional, as for garbage without a price: empty means "the invoice is not here yet", marked «без цены» in statistics                    |
| S8  | Statistics tab                             | A «Мусор / Снег» switch next to the month: one table, never mixed totals                                                                |
| S9  | Summary book (analytics export)            | Inside «Вывоз мусора» as its own position «Снег» — no fifth module                                                                      |
| S10 | Season                                     | Always available; the service type cannot be deactivated or purged                                                                      |
| S11 | Existing «Снег» in production              | Never created: the migration inserts it; a name clash fails the migration loudly                                                        |
| S12 | Changing the type of a filed request       | **Forbidden** into and out of «Вывоз снега» (my reading: in both directions, from any type) — a wrong type is cancelled and filed again |
| S13 | Release                                    | As soon as it is ready, one push with its release entry, `VERSION` and tag                                                              |

## 1. The scenario

The requester opens «Новая заявка» in «Вывоз мусора», picks «Вывоз снега» (listed right after
«Вывоз мусора (разовый объём)»), and fills object, date and time, volume (≥ 8 m³), the person on
site, comment and files. There is no waste-type field and no price preview; a hint says the cost is
entered at completion. Assignment, statuses, history, comments, archive, ticket upload and
recognition work as for garbage. At «Выполнена» the closer enters removed volume, the removal day,
the tickets and, if known, the cost in roubles — the field starts empty and is never computed.

## 2. Model

The precedent is scrap metal ([ADR 0067](adr/0067-metal-removal-request.md)): a new value of
`request_type` in the same module, not a new module. Snow differs from scrap in that it is ordered
and closed by volume; it differs from garbage in that it has no tariff.

- **`request_type = 'snow_removal'`**, label «Вывоз снега», number `М-<num>` like every new request
  (the legacy letter in `requestTypeShort` is filled only for completeness — «ВС»).
- **Service waste type «Снег»**, code `snow`, seeded by migration with no tariff. Identified by its
  code through one contract map `serviceWasteTypeCodeOf(requestType)` (`snow_removal → 'snow'`);
  the code is immutable (`updateWasteTypeSchema` has no `code`), so no new column is needed. The
  request row carries `waste_type_id` = «Снег», which gives the list subject («Снег · 20 м³») and
  the book position «Снег» for free.
- **No pricing at all on the request**: `waste_tariff_id`, `price_per_m3` and the generated `amount`
  stay NULL. Snow does not join `PRICED_REQUEST_TYPES`; tariff lookup is never run for it — neither
  at filing, nor at operator assignment, nor at completion.
- **Completion**: unit `volume_m3` (`wasteFactUnit`), `price_per_m3` NULL, `total_cost` = whatever
  was typed (may be NULL). The completion route's tariff fallback (`resolveWasteTariffByKind` when
  the snapshot is empty) is skipped by contract predicate, not by an accident of empty tariffs.
- **DB guard** (`waste_requests_snow_subject_check`): for `snow_removal` — no container type, count
  1, no container owner, `waste_type_id` and `volume_m3` NOT NULL, tariff and price NULL. That the
  waste type is exactly «Снег» cannot be a CHECK (it needs a lookup) and is held by the server plus a
  db test.

### Contract predicates (packages/contracts — one rule, one place)

`isPricedRequestType` today answers three different questions at once; snow splits them. Names are
provisional:

| Question                                                | garbage     | snow  | scrap       | containers  |
| ------------------------------------------------------- | ----------- | ----- | ----------- | ----------- |
| Ordered volume required at filing (≥ 8 m³)              | yes         | yes   | no          | no          |
| Waste type chosen by the requester                      | yes         | no    | no          | no          |
| Service waste type set by the server                    | —           | Снег  | —           | —           |
| Tariff snapshot / price preview (`isPricedRequestType`) | yes         | no    | no          | no          |
| Completion carries a money figure (manual or computed)  | yes         | yes   | no          | no          |
| Fact unit (`wasteFactUnit`)                             | m³          | m³    | t           | —           |
| Statistics kind (`wasteStatsKindOf`)                    | waste       | snow  | —           | —           |
| Type change allowed (`canChangeWasteRequestType`)       | not to snow | never | not to snow | not to snow |

## 3. Changes by layer

### 3.1 Migrations (next numbers after 0426; re-check before `git add`)

1. `0427_snow_removal_request_type.sql` — `ALTER TYPE request_type ADD VALUE 'snow_removal' AFTER
'waste_removal'`. Alone in its file: a CHECK that names the new value in the same transaction
   fails with "unsafe use of new value" (the 0090/0091 split for scrap).
2. `0428_snow_removal_subject.sql` — insert waste type `snow` «Снег» (high `sort_order`, no tariff);
   add `waste_requests_snow_subject_check`. Plain `INSERT`: a clash on `waste_types_name_key_unique`
   must stop the deploy, not be skipped (S11).
3. `0429_releases_snow_removal.sql` — the `app_releases` entry (§3.6).

Migration window: old code meets the enum value only on rows that new code writes, and the new type
has no tariff, so the old form (which lists only priced types) never offers «Снег». Old clients do
not need a client-floor raise: they cannot create snow, an old editor saving a snow request is
answered by the server's type-change and service-type guards, and an old statistics tab sends no
`kind` and gets garbage — its present meaning. Run the teardown suite (`apps/api/teardown/`) and
apply the migrations on PostgreSQL 17 as well as 16.

### 3.2 Contracts

- [enums.ts](../packages/contracts/src/enums.ts): `REQUEST_TYPES` gets `snow_removal` after
  `waste_removal`; label, colour (`cyan`), short letter.
- [waste-requests.ts](../packages/contracts/src/waste-requests.ts): the predicates of §2;
  `wasteFactUnit(snow_removal) = 'volume_m3'`; `createWasteRequestStableSchema.superRefine` — volume
  for every volume type, waste type only where the requester chooses it; the type-change rule and
  its message; the field table in the schema comment.
- [waste-tariffs.ts](../packages/contracts/src/waste-tariffs.ts): `PRICED_REQUEST_TYPES` stays
  garbage-only, comment explains why snow is out; one refusal text for a price on a service type.
- [waste-stats.ts](../packages/contracts/src/waste-stats.ts): `kind: 'waste' | 'snow'` in the query
  (default `waste`), echoed in the DTO; rewrite decision 3 of the header comment.

### 3.3 API

- [waste-requests.ts](../apps/api/src/routes/waste-requests.ts) `resolveSubject`: a `snow_removal`
  branch before garbage — volume rules, waste type looked up by code, empty price snapshot. The
  garbage branch refuses a service waste type («Снег заказывается заявкой «Вывоз снега»»).
- PATCH `/:id`: refuse a type change into or out of snow by the contract predicate (before the
  existing fact-unit check).
- Operator assignment and completion: no tariff lookup for snow (predicate); completion takes
  `totalCost` as sent, `undefined` → NULL rather than computed.
- [waste-types.ts](../apps/api/src/routes/waste-types.ts): the list excludes service types unless
  asked (`includeService`), so neither the request form nor the tariff editor ever sees «Снег»;
  PATCH refuses `isActive: false` for a service type; purge is unreachable because deactivation is.
- [waste-tariffs.ts](../apps/api/src/routes/waste-tariffs.ts): a price on a service waste type is
  refused — by id, and by name when the editor types «Снег» as a new type (otherwise the duplicate
  check would point at a type nobody can see). A price for «Снег» would never be read.
- Ticket paper: the `waste_removal` literals in
  [waste-ticket-inputs.ts](../apps/api/src/services/waste-ticket-inputs.ts) and in the
  `ticketReview` filter of the list become one contract predicate that also covers snow. The
  literal is the ADR 0150 boundary about the past; snow has no past, so joining it changes no old
  request and gives full parity with garbage (S4).

### 3.4 Statistics and the summary book

- [facts-waste.ts](../apps/api/src/services/analytics/facts-waste.ts): snow is a volume type, so it
  already lands in the waste module with position «Снег» (S9). The `priced` flag changes meaning
  for snow: a **done** snow request without a typed cost is «без цены»; an unfinished one has no
  estimate by design and is not counted (as scrap is not) — otherwise every open snow request would
  be a warning nobody can fix.
- [waste-stats.ts](../apps/api/src/services/waste-stats.ts): narrow the loader by
  `wasteStatsKindOf(t) === kind` instead of the bare `VOLUME_REQUEST_TYPES`. For snow, ordered cost
  is always «—», removed cost is the sum of typed costs, ticket cost is «—» (no price per m³).

### 3.5 Web

- [waste-request-editor](../apps/web/src/features/waste-request-editor): the type list gains
  «Вывоз снега»; for snow the waste-type field and the price preview are hidden, volume stays, a hint
  says «Стоимость вносится при закрытии заявки». Garbage's waste-type options exclude service types
  (from the server). In edit mode the type select offers only types the contract allows.
- [waste-request-completion](../apps/web/src/features/waste-request-completion): for snow no price
  line and no computed default — an empty «Стоимость, ₽».
- [WasteStatsTab](../apps/web/src/pages/waste/WasteStatsTab.tsx): a «Мусор / Снег» switch beside the
  month, kept in the URL with the month; the site window follows it.
- Card, list, archive, history and filters take the label from the contracts — no change expected;
  check the presentation helpers in [waste-request](../apps/web/src/entities/waste-request) for a
  priced/unpriced wording that assumes a tariff.

### 3.6 Docs and release

- ADR 0250 «Вывоз снега — отдельный тип заявки со служебным типом мусора, стоимость вручную»
  (English body; `Статус`, `Домены` header fields in Russian — the new header form requires the
  dictionaries and `Область`). Develops ADR 0019, 0022, 0035, 0067, 0209; notes the book/tab
  asymmetry (S8 vs S9) on purpose.
- [code-map.md](code-map.md) waste area: the ADR link; [database-schema.md](database-schema.md):
  enum value, CHECK, seeded type; `pnpm docs:index`.
- Release entry draft (user's words): «В разделе «Вывоз мусора» появился тип заявки «Вывоз
  снега». Заявка заводится так же, как вывоз мусора разовым объёмом, — объект, дата, объём от 8 м³
  и ответственный, тип мусора выбирать не нужно. Исполнители те же, при выполнении нужен талон.
  Стоимость вывоза снега вносится вручную при закрытии заявки. На вкладке «Статистика» снег
  считается отдельно — переключатель «Мусор / Снег».» `VERSION` raised, `pnpm check:version`, tag
  `v<version>` after the push.

## 4. Tests

- Contracts: predicate table of §2 for every request type; stable schema (snow without
  `wasteTypeId` passes, without volume fails, < 8 m³ fails); type-change rule both ways.
- DB (own database, `OWN_DB_NAME`): filing snow stores «Снег», no price, CHECK holds; garbage with
  «Снег» refused; type change to/from snow refused; operator assignment leaves the price empty;
  completion stores the typed cost and NULL when empty, refuses without a ticket; deactivating «Снег»
  refused; the tariff route refuses «Снег»; statistics split by `kind`; the book shows «Снег» inside
  waste with done-without-cost counted «без цены».
- Web: `flow-waste-snow-removal.test.tsx` after `flow-waste-metal-removal.test.tsx` (file → assign →
  close with typed cost); the stats switch.
- `pnpm check`, `pnpm check:db`, `pnpm check:docs`, bundle check in the main tree.

## 5. Order of work

1. Contracts + migrations 0427/0428 + API + db tests — committed per step.
2. Web: editor, completion, stats switch, flow test.
3. ADR, code map, schema digest, docs index; release migration 0429, `VERSION`; push the verified
   SHA, then the tag.

## 6. Risks and open items

- **Recognition of snow-melting-point tickets** is untested: their paper differs from landfill
  tickets. Not a blocker — an unreadable scan goes to manual review as today — but a sample ticket
  from the owner would let us check it before the season peaks.
- **Bundle budget**: the label and predicates sit in contracts loaded by the entry chunk; growth of
  a few dozen bytes needs the owner's explicit consent to raise the budget.
- The S12 reading («forbidden in both directions, from any type») is mine; if only garbage ↔ snow
  was meant, the predicate narrows and nothing else moves.
