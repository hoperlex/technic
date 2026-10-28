# ADR 0238. A rental order does not cross the last day of its month; the weekly visa cuts the extension

- Статус: Реализовано (28.10.2026); not deployed
- Домены: заказ-тс
- Изменяет: [ADR 0085](0085-weekly-vehicle-request.md) — decision 4 (an `extend` row moves one order
  to the date the human chose) for a rental vehicle: the move stops at the last day of the month the
  order ends in, and the rest of the extension becomes a new order of the same vehicle; the weekly
  visa now also creates and takes an order into work for such a row
- Развивает: [ADR 0142](0142-esm2-month-split.md) — the month is the unit the reports close by; the
  paper of an own machine is already cut by it, the term of a rented one was not
- Связано: [ADR 0218](0218-weekly-request-annulment.md) and [ADR 0219](0219-weekly-request-return.md)
  (the reversal of an applied week waits for the new order),
  [ADR 0212](0212-assignment-old-doors-write-history.md) (taking an order into work writes the
  assignment history), [ADR 0235](0235-rental-completion-and-request-documents.md) (a rental closes
  as one piece: hours, shifts, cost)
- Область: [migration](../../apps/api/drizzle/0394_weekly_rental_continuation.sql),
  [schema](../../apps/api/src/db/schema.ts) (`weeklyVehicleRequestItems`),
  [cut predicate and warning](../../packages/contracts/src/weekly-vehicle-requests.ts),
  [visa](../../apps/api/src/services/weekly-request-apply.ts),
  [new order](../../apps/api/src/services/weekly-request-continuation.ts),
  [reversal state](../../apps/api/src/services/weekly-request-annul-state.ts),
  [weekly routes](../../apps/api/src/routes/weekly-vehicle-requests.ts),
  [order card origin](../../apps/api/src/routes/vehicle-requests.ts),
  [composition row](../../apps/web/src/widgets/weekly-request-workspace/ui/WeeklyRequestComposition.tsx),
  [agreed rows](../../apps/web/src/widgets/weekly-request-workspace/ui/WeeklyRequestChecklist.tsx),
  [predicate tests](../../apps/api/test/weekly-rental-month-split.test.ts),
  [db tests](../../apps/api/test/weekly-rental-continuation.db.test.ts),
  [row tests](../../apps/web/test/weekly-rental-month-cut.test.tsx)

## Context

The reports are monthly. A rental order is one piece in them: one closing (hours, shifts, cost —
ADR 0235), one line of the summary book. An order that starts in October and ends in November
cannot be put into either month without cutting it by hand afterwards. For an own machine the
portal already cuts what it prints (the weekly ESM-2 sheet is split at the border, ADR 0142), but
the term of the order itself stays whole, and for a rented machine there is no paper of ours to
absorb the cut.

The weekly request is where an order is extended in practice: a site extends every standing
vehicle by the week, and a week often holds the border (30 Nov – 6 Dec, 28 Dec – 3 Jan). The owner's
rule, 28.10.2026: a rental order is not extended across the month; an extension that starts on the
first opens a new order. Decided by survey the same day: only the weekly request carries the rule,
only a rental vehicle (`ownership = 'rental'`), the new order takes the same vehicle and rates and is
in work at once.

## Decisions

1. **The border is the last day of the month the order ends in.** `border = monthEndKey(L)`, where
   `L` is the order's effective end (`coalesce(date_to, date_from)`). Not the month of `date_from`:
   an order that crossed a month before this rule existed is not cut backwards, and its further
   extension stays inside the month it ends in.

2. **The cut of one row** (`rentalMonthSplit` in the contracts, the only place that knows it). For
   the date `D` the human chose, inside the week:
   - `D ≤ border` — the row is applied as before;
   - otherwise the existing order moves to `border` (`extendTo`; none when `L` is already the
     border) and a new order runs from `border + 1` to `D` (`continuation`).

   Since `D` is inside one week and `L` is not earlier than a week before it, at most one border
   lies between them: one new order is always enough.

   | `L` | `D` | existing order | new order |
   | :-- | :-- | :-- | :-- |
   | 26.11 | 30.11 | to 30.11 | — |
   | 29.11 | 06.12 | to 30.11 | 01.12 – 06.12 |
   | 30.11 | 06.12 | unchanged | 01.12 – 06.12 |
   | 30.12 | 03.01 | to 31.12 | 01.01 – 03.01 |

3. **The row stays one decision.** The human picks "stays until D"; the cut is not asked about and
   not stored as a second row. A second row would need a new item kind or a second source order in
   the same week, and every reader that takes `coalesce(source_request_id, created_request_id)` as
   "the order of this row" would then read the wrong one. `weekly_vehicle_request_items` gets a
   nullable `continuation_request_id` (unique, RESTRICT, only for an applied `extend` row); the
   meaning of `created_request_id` — the order of a `new` row — does not change. The order card
   shows the new order as "Создан по НЗ-N", like the order of a `new` row.

4. **The new order is opened by the visa, in the same transaction, and put into work.** The
   dispatcher has already agreed the vehicle and the rates on the order being extended, and a visa
   extends an order without the dispatcher (ADR 0085 item 9); a «Новая» order would be a task
   "put the same machine on it again" that asks nobody anything. Steps, in the order of the status
   door: the order (site, ordered position, contact, a comment naming the source order; delivery is
   not copied — the machine is on the site), born approved by the visa; the assignment — the same
   vehicle and the three rates; `new → confirmed` with a history row; the assignment history in
   `history` mode (`enterWorkWithHistory`) or the weekly sweep in `legacy`; the day plan. For a
   rental there is no machinist and no paper of ours, so these steps write history and nothing
   else.

5. **If the assignment cannot be copied the order is still opened.** The vehicle was deleted or
   switched off (a rental has only `active` and `inactive`), stopped being a rental one, or the
   rates are gone. The new order stays «Новая» without a vehicle, and the visa answer names the
   reason. Failing the whole week, or dropping the days past the border, would be worse than a task
   for the dispatcher.

6. **If the new order cannot be opened at all the row is skipped as a whole.** The site or the
   ordered position of the classifier was deactivated: the same conditions as for a `new` row.
   Moving the existing order to the border and silently losing the rest would be the hidden
   shortening the extension rules refuse elsewhere (ADR 0085 item 4).

7. **The cut is computed where the facts are.** The form shows the note live under the date the
   person picks (`rentalMonthSplitText`); the server adds the same text to the row warnings
   (`rental_month_cut`) so the one who signs the week reads it before the signature; the visa
   recomputes it under the order lock from the vehicle standing on the order now, because the
   machine may have changed hands between the assembly and the signature. The saved row keeps the
   date the human chose; nothing derived is stored in it.

8. **The reversal of the week waits for the new order.** Annulment and return for re-approval
   (ADR 0218, ADR 0219) cancel orders a week created while they stand «Новая» and refuse to touch
   an order that went into work. The new order goes into work at once, so a row with a live new
   order is `blocked` with the order's number and the way out: roll it back to «Новая» and cancel
   it. After it is cancelled (or archived) the row reverses as any `extend` row: the term returns
   to the snapshot, and the date the week set is the border, not `D`.

9. **"Продления" on the order card does not claim a term change that did not happen.** A row of an
   order that already ended on the border moved nothing; it is left out of that list and the new
   order carries the explanation.

## Consequences

- The dispatcher no longer takes the continuation of a rental into work; the cost is that it is
  taken without a look. The rates are the old order's, which is the case in practice for a rental
  held by the month, and they are edited as any assignment is.
- Migration `0394` is additive and the portal client floor is not raised: the answers only gain
  fields, and the request of the composition is unchanged. A visa applied by old code during the
  migration window cuts nothing, as before; a draft saved earlier is cut at the visa by the new
  code. Rollback after the migration is `--previous --restore-db`.
- Reversing a week whose rental row was cut needs a manual step first (item 8). It is the same
  rule that already applies to a `new` order the dispatcher took into work.
- The existing apply tests build rental orders that start the month after the border
  (`RENTAL_SRC_END`): they are about the visa, and on the days the border lies in the tested week
  the new rule would otherwise make them a different scenario.

## Not covered

- Other doors that move the term: the window «Срок работ» (`PATCH /vehicle-requests/:id/period`)
  and the old wide edit can still extend a rental across the month. The owner limited the rule to
  the weekly request on 28.10.2026.
- A rental vehicle assigned later to an order that already crosses the month, and a `new` row whose
  vehicle the dispatcher picks afterwards: the vehicle is unknown when the order is made.
- The closing of the old order: the dispatcher closes both orders by fact as before.

## Alternatives

- **A refusal instead of a cut** ("extend to the border, open the next order yourself"). It leaves
  the days past the border to be ordered by hand every month for every rented vehicle, which is the
  work the owner asked the portal to do.
- **The month of `date_from` as the border.** It forbids any extension of a legacy order that
  already crosses, and the new order would have to start the day after its end, not on the first.
- **A second `new` row generated by the form.** The source order of an extension that ends on the
  border would have no row in the week, and the only row kind that keeps it is "leaves" — which
  hands the dispatcher a task to arrange a pickup of a machine that stays.
