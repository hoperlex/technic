# ADR 0220. The weekly visa leads ESM-2 paper by the segment plan when history is read

- Статус: Принято (07.10.2026). Implemented in one release: the visa and its correction preview,
  the shared term-change calculation, the hint of the conducting window, the data migration `0360`
  for order ТС-202 and the release record `0361`
- Домены: заказ-тс, путевые-листы
- Изменяет: [ADR 0060](0060-esm2-weekly-waybill.md) — in `read_mode = history` the weekly visa no
  longer reconciles paper with the weekly sweep (decision 1); [ADR 0178](0178-completion-actual-end-date.md)
  — the shared term-change calculation: the days a command opens bring their whole documents into
  the paper scope (decision 2)
- Уточняет: [ADR 0212](0212-assignment-old-doors-write-history.md) — after work entry and the
  vehicle change, the weekly visa is the next door taken off the weekly sweep in `history`;
  [ADR 0126](0126-assignment-periods.md) — decision 3 («the week is cut by the day of the change»)
  now holds through the next week's visa too
- Связано: [ADR 0085](0085-weekly-vehicle-request.md) (the visa applies the week in the same
  transaction), [ADR 0116](0116-weekly-request-backdated.md) and
  [ADR 0101](0101-backdated-correction.md) (conducting an overdue week, named unlocks),
  [ADR 0218](0218-weekly-request-annulment.md) (the reversal engine already leads paper by plan),
  [ADR 0151](0151-esm2-month-split-backfill-migration.md) (a replacement sheet issued by a migration)
- Область: server —
  [weekly-request-apply.ts](../../apps/api/src/services/weekly-request-apply.ts)
  (`planWeeklyExtension`, `planHistoryPaper`, `weeklyExtensionPreview`),
  [vehicle-request-period.ts](../../apps/api/src/services/vehicle-request-period.ts)
  (`extendSpecialEquipmentPeriod`, option `history`),
  [assignment-shorten-term.ts](../../apps/api/src/services/assignment-shorten-term.ts) (scope of
  opened days), [weekly-vehicle-requests.ts](../../apps/api/src/routes/weekly-vehicle-requests.ts)
  (`GET /:id/correction`); portal —
  [WeeklyRequestConductModal.tsx](../../apps/web/src/widgets/weekly-request-workspace/ui/WeeklyRequestConductModal.tsx);
  migrations [0360](../../apps/api/drizzle/0360_esm2_weekly_visa_gap_ts202.sql) and
  [0361](../../apps/api/drizzle/0361_releases_weekly_visa_segment_paper.sql); tests —
  [weekly-visa-history-paper.db.test.ts](../../apps/api/test/weekly-visa-history-paper.db.test.ts),
  [assignment-period.db.test.ts](../../apps/api/test/assignment-period.db.test.ts)

## Context

On 02.10.2026 the vehicle of order ТС-202 was changed from that day by the history command
(ADR 0212, decision 3). The week 28.09–04.10, already cut by the month into 28–30.09 and
01–04.10, was cut once more at the change: sheet 620 (01–04.10) was cancelled, 733 (01.10, the
previous vehicle) and 734 (02–04.10, the new one) were issued. That is exactly what ADR 0126
decision 3 promises.

Before the week ended, the site's construction manager approved weekly request НЗ-325 for
05–11.10. The visa extended the order to 11.10 through `extendSpecialEquipmentPeriod`, and its
paper was the weekly sweep — in `history` as well. The sweep knows one vehicle and one machinist
per order and wants one sheet per period of the week cut (`esm2Periods`): «01–04.10». Sheet 734
did not match those bounds and was cancelled; the replacement was not issued because worked-out
733 overlapped the period and locked it. Sheet 736 for 05–11.10 was issued normally. The order was
left with no active sheet for 02–04.10.

The defect is general: any order with a mid-week change of vehicle or machinist whose next week is
approved before the cut week ends. While the first half is not worked yet, the sweep does the
opposite harm — it burns both halves and prints the new pair over the previous one's days, the very
case ADR 0212 moved work entry off the sweep for. No portal door could close the gap afterwards:
history commands refuse a no-op, manual ESM-2 issue is for linear orders only, and the weekly
correction scope counted the period as covered by 733.

Implementation found a second defect in the same place. In `history` the `/period` door leads
paper by the segment plan of the shared term-change calculation, and that plan started its scope
from the bare days the extension adds. An order ending on Wednesday and extended to Sunday has no
document touching Thursday–Sunday — the Monday–Wednesday sheet ends the day before — so the plan
issued nothing and Thursday–Sunday stayed without paper. The weekly sweep has always reissued such
a week whole; moving the visa onto the shared calculation as it stood would have traded one gap for
another, in the most common case of the visa.

## Decisions

1. **In `history` the visa extends a term exactly as the `/period` door does.** For every
   applicable extension row the visa computes the same shared plan the door computes for the same
   term change (`shortenTermPlan`, «shortening» being the name of its hardest case, not its only
   one) and executes it through `assignmentPaperExecution`, as the weekly reversal engine does.
   The outcome is the door's too: the effective date of an extension is its new last day
   (`movedRequestDateKey`, ADR 0101 §4) — today or later is ordinary work, earlier is `crew` and
   runs under the correction operation of an overdue week. In `legacy` nothing changes: the sweep
   leads the paper, and that mode is the rollback of the switch.

   The plans are computed before the first write and under the order locks, after the history
   backstop, so that a refusal names every order of the week at once (Р23). Around the term write
   the extension keeps step 11 of the history doors in the `/period` door's order: history
   materialized by the old term first, readiness recomputed by the new term after (Ж1), paper last.
   The visa asks no per-sheet signatures: its form has none, and the sweep it replaces did not ask
   either (the work-entry precedent of ADR 0212); an issued sheet keeps its warnings unconfirmed.

   A backdated visa must name every worked sheet the plan reissues; an unnamed one refuses the
   visa with its number (422) instead of leaving the added days without paper — the convergence
   rule of the history doors. The correction preview (`GET /weekly-vehicle-requests/:id/correction`)
   lists the unlockable sheets and the past periods from the same plan in a read-only transaction;
   in `legacy` it keeps `esm2CorrectionScope`. The DTO did not change. The window's hint under the
   list now says only what is true in both modes («an unmarked sheet is not rewritten»): in
   `history` an unmarked one refuses the visa.

2. **The days a command opens bring their whole documents into the paper scope.** The shared
   calculation adds to the range it closes over every document of the new cut (`wanted`) that
   touches an opened day; the closure then takes in the sheet that document replaces. The partial
   Monday–Wednesday sheet is burnt and the week reissued whole — a worked one only when named for
   reissue (at the `/period` door the server names it and the person confirms the set by the
   unlock fingerprint). Only the new cut and only opened days: a shortening opens nothing and
   keeps its scope, and a document of the previous cut is no reason to touch days the command does
   not add — that would fill an old gap in passing, which the closure exists to forbid. The
   `/period` door, which had the same defect in production, is fixed by the same change; the early
   end, the completion by the actual date and the weekly reversal open no days and are unchanged.

   The `/period` door's own test that recorded «Wednesday stays without paper» as intended was
   rewritten: that rationale («a document the person did not see in the preview») no longer holds
   once the preview names the sheet. In `legacy` the same named sheet reaches the weekly sweep,
   which then rewrites the period whole with the order's single pair.

3. **The gap of ТС-202 is closed by a new number replacing 734, by migration** (survey of
   07.10.2026). Restoring 734 was rejected: a cancelled form does not come back into circulation.
   Widening the migration to every order hit by the defect was rejected too; the migration is
   bound to order 202 and sheet 734 and is a no-op with a NOTICE unless every guard holds: the
   order is special equipment in work or done; 734 is its ESM-2 sheet, cancelled with a reason of
   the weekly request, for 02–04.10; no sheet already replaces it; no active sheet of the order
   covers those days; the days lie inside the term; the live history on those days names 734's
   vehicle and machinist; the vehicle is own. The replacement copies 734 with a new number of the
   series, is linked to it by `corrects_waybill_id` under a `waybill_corrections` row (pattern of
   migration `0236`, ADR 0151) and is printed by the dispatcher; the 734 blank stays void.

## Consequences

- A visa in `history` burns only what its own extension needs: the documents of the days it adds.
  A cut week before them keeps both halves under their numbers.
- A backdated visa can now refuse with «отметьте их к перевыписке» where it used to pass and leave
  a gap; the preview lists exactly the sheets it will ask for.
- The `/period` door and the visa issue paper for an extension of an order ending mid-week, and a
  backdated one of them names the worked partial sheet for reissue.
- The status handle and the reversal engine's cancellation of «Новая» orders keep the weekly
  sweep: an order in «Новая» has no sheets to cut.
- Out of scope, noted: «0764 ХМ 50» and «Wacker Neuson TH522 · 0764 ХМ 50» in the waybill journal
  are two vehicle cards with one plate (the journal label comes from the card) — likely a registry
  duplicate.
