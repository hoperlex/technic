# ADR 0251. Mechanization: the lessor's invoice instead of «чек», and a rate per day

- Статус: Реализовано (26.11.2026), release 0.1.147.0251; not deployed
- Домены: механизация
- Изменяет: [ADR 0152](0152-mechanization-module.md) — decision 4 (the price is agreed per hour or
  per shift: since this release also per day); [ADR 0248](0248-mechanization-lessor-receipt.md) —
  its words, not its rules: the document the lessor attaches is the invoice («счёт арендодателя»),
  no longer «чек»
- Связано: [ADR 0171](0171-mechanization-site-approval.md) (the visa circle that approves the
  invoice), [ADR 0182](0182-analytics-summary-export.md) (the analytics summary),
  [ADR 0077](0077-release-notes.md) and [ADR 0191](0191-version-numbering.md) (release entry)
- Миграции: `0432` (`mech_rate_unit` gains `day`), `0433` (release entry)
- Область: contracts — [enums.ts](../../packages/contracts/src/enums.ts),
  [mech-requests.ts](../../packages/contracts/src/mech-requests.ts),
  [mech-lessor-receipts.ts](../../packages/contracts/src/mech-lessor-receipts.ts); schema —
  [0432](../../apps/api/drizzle/0432_mech_rate_unit_day.sql),
  [schema.ts](../../apps/api/src/db/schema.ts); API —
  [mech-request-list.ts](../../apps/api/src/services/mech-request-list.ts),
  [mech-history-export.ts](../../apps/api/src/services/mech-history-export.ts),
  [facts-mech.ts](../../apps/api/src/services/analytics/facts-mech.ts),
  [analytics-export.ts](../../apps/api/src/services/analytics-export.ts); portal —
  [mech-lessor-receipt](../../apps/web/src/features/mech-lessor-receipt),
  [mechRequestMenu.tsx](../../apps/web/src/pages/mech/mechRequestMenu.tsx),
  [mechRequestFilters.tsx](../../apps/web/src/pages/mech/mechRequestFilters.tsx),
  [HistoryTab.tsx](../../apps/web/src/pages/mech/HistoryTab.tsx),
  [MechTakeInWorkModal.tsx](../../apps/web/src/features/mech-take-in-work/ui/MechTakeInWorkModal.tsx)

## Context

Two remarks of the owner (26.11.2026) after ADR 0248 reached production:

1. A mechanization lessor sends an **invoice** («счёт»), not a cash receipt («чек»). The portal, its
   messages, the release notes to come, the documents and the code comments said «чек», and the
   office read the word as a different paper.
2. The rate is agreed per hour or per shift, but lessors also price a machine **per day**
   («сутки»): it stays on site round the clock, and the office had to translate that price into
   shifts by hand.

The owner also asked to check that the invoice is approved: it is — ADR 0248 gives the request's
visa circle «Проверить счёт» with approve, reject and revoke, the «без счёта» visa, and a completion
gate that waits for one of them. Nothing in that cycle changes here.

## Decision

1. **The words change, the identifiers stay.** Every user-facing text — menu items, window titles,
   field labels, hints, the state marks, the filter «Счёт», the history labels, server refusals,
   the permission caption — says «счёт арендодателя». Project documents and code comments say
   «счёт» / "invoice". The table `mech_request_lessor_receipts`, the routes `/lessor-receipt`, the
   permission key `mechRequests.lessorReceipt`, the history kinds `mechLessorReceipt*` and every type
   name keep `receipt`: renaming them buys nothing for the user and costs a schema migration, a
   permission data step and a client floor raise for the changed routes. ADR 0248 decision 2 says
   the same at the place where the name was chosen.
2. **Past release entries are not rewritten.** The release feed is a record of what each release
   brought in the words of its day; the entry of this release says that «чек» is now «счёт».
3. **`mech_rate_unit` gains `day`.** Its captions: «сутки» in the picker, «за сутки» next to the rate,
   «N сут.» for worked units (abbreviated like «ч»: «сутки» has no singular, and a third declension
   table would be the only one of its kind). `actual_units` is in days for such a rental, and
   `final_cost` is still entered by hand against `actual_units × rate`.
4. **Units never add up.** The journal's totals get «Отработано суток» (`dayUnits`) beside hours and
   shifts and hide it when zero; the export gets the column «Отработано, сут.». `dayUnits` is not
   `days`: that one is the calendar span of the rentals, which a day rate's billed units may differ
   from.
5. **Analytics prices a day rate like a shift.** Without worked units the estimate of an open rental
   is `rate × days present` for `shift` and now `day`; an hourly rate still has no estimate. The
   summary gets no counter of its own for days: «Дней аренды» (`mechDays`) already counts the days a
   machine stood on site, and a fourth quantity column would be one more number the reader must not
   add to the others.

## Consequences

- Migration `0432` adds the value while the old code still serves; no row holds `day` until the new
  portal offers it, so the old code never reads a value it does not know.
- A tab with the old bundle shows a `day` rental's rate without its unit and its worked units as
  shifts until the page reloads. Display only — the old tab cannot choose `day`, and a value it sends
  back is a value it read. The client floor is not raised for that.
- An API older than this release does not send `dayUnits`: the type marks it optional for the
  client, and the history tab hides an absent value like a zero.
- The words «чек» in other modules — auto-part receipts in the garage, fuel receipts of the driver's
  readings — are other papers and stay as they are.
