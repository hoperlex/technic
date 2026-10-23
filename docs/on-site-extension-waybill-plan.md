# On-site request extensions: choose the paper workflow explicitly

Status: investigation and proposal, 23 October 2026. No production records were read from this
workspace. The read-only audit is `.local/vehicle-extension-waybill-audit-2026-10-23.sql` in the main
tree; its results are required before repairing the two reported orders.

## Report and current behavior

The screenshots of TC-1592 and TC-1614 show one applied weekly extension, NZ-497, for 26 October to
1 November 2026. Both orders have issued documents grouped as 19–25 October, 26–31 October and
1 November, and individual issued documents on earlier work days. The cards do not display each
document's form code, so the numbered documents must be identified from `waybills.form_code`,
`source_request_id` and `route_id` before any data repair.

The current rule explains the likely cause. `esm2Mode` derives automatic ESM-2 issue from an own,
nonlinear special-equipment order in work. It uses the ordered type's effective linearity, including
the order's frozen value; it does not inspect 4-P route days. Applying a weekly visa extends the
term and reconciles ESM-2 in the same transaction. In `read_mode = history`, the visa uses the
segment plan shared with the `/period` door; in `legacy`, it uses the weekly sweep. Both use the
same ESM-2 mode. The day batch is a separate command, available for any own on-site order, that
creates routes and optionally issues their daily 4-P sheets. It is invoked after taking an order
into work or from **Work days → Plan the period**. An extension does not invoke it.

This is the behavior accepted by ADR 0207: a nonlinear order can have both weekly ESM-2 and daily
4-P, and the dispatcher cancels an unwanted sheet. Consequently, the mere presence of prior 4-P
does not establish an order's intended future paper policy. The current model has no explicit
per-order selection for “continue with daily 4-P on extension.”

## Exact code workflow

1. A weekly request reaches `pending` with an `extend` row naming the source order and new end
   date. `POST /weekly-vehicle-requests/:id/approval` calls `applyWeeklyRequest` in the visa's
   transaction. A submitter who may approve their own future week takes the same apply path while
   submitting it. The service locks the week and orders, checks every row, and skips an inapplicable
   extension rather than changing that order.
2. An applicable row calls `extendSpecialEquipmentPeriod`. In `read_mode = history`, the service
   first computes `planWeeklyExtension` through the shared `shortenTermPlan`; in `legacy`, it uses
   the weekly sweep. `buildEsm2SyncPlan` reads the *ordered* type's effective linearity
   (`coalesce(is_linear_frozen, vehicle_types.is_linear)`) and `esm2Mode` returns `auto` for an own,
   nonlinear on-site order in work or done. Neither branch asks whether route days or 4-P already
   exist.
3. `extendSpecialEquipmentPeriod` writes `date_to`, then `afterWorkPeriodChanged` applies the ESM-2
   plan or sweep. In `auto`, the requested documents come from the extended term; `esm2Periods`
   splits it at the nearest week or month end. Thus 26 October–1 November 2026 yields sheets for
   26–31 October and 1 November. The days sync only removes invalid days when shortening a term;
   extension creates no route days and never calls the day batch.
4. Daily paper is a separate `POST /vehicle-requests/:id/days/batch`, called after work entry if
   its checkbox was selected, or later from **Work days → Plan the period**. It walks unplanned
   dates, resolves the vehicle from assignment history per day when history is authoritative,
   asks for one driver for the portion, creates/joins a route and optionally issues its route form.
   The route form comes from the assigned vehicle's type (`4p` for these vehicles only if the type
   actually stores `4p`). It commits each day separately and reports skips. The day-batch DB test
   explicitly asserts that the already issued weekly ESM-2 remains beside its newly issued 4-P.

The missing rule is therefore the order's **future paper intent**, not a wrong date split in the
assignment-history slice. History determines *which vehicle and machinist* a weekly sheet names;
it does not decide whether the work should have weekly or daily paper. An extension exposes that
gap because the ESM-2 path is automatic while the 4-P path is a separate dispatcher action. A guard
based on “any 4-P already exists” would fail on initial work entry (ESM-2 runs before the separate
batch request) and misclassify orders where both document types are intentional.

## Database confirmation gate

Run the read-only audit against the active portal database and record:

1. The request type, status, ownership, effective linearity, ordered and assigned vehicle, dates,
   and assignment-history read mode for both orders.
2. NZ-497's applied status and the result and before/after dates of both extension rows.
3. The form, status, period, issue time and source of every document shown in the cards. Compare
   each issue time to the weekly visa and the day batch. Check the live assignment-history changes
   across 26 October–1 November, especially any vehicle or machinist change inside the week.
4. The dates of route days and their 4-P sheets after extension; distinguish unplanned days from
   routes without a sheet. Check any cancellations, corrections and worked-day records before
   replacing controlled documents.

If either order is effectively linear or NZ-497 did not apply its extension row, the proposed
cause is disproved; trace the recorded issuer and the active release before changing policy.

## Immediate UI procedure

This procedure can be carried out by an authorized dispatcher without direct database access, but
the form and status of each numbered sheet must be checked in the UI. The screenshots alone do not
prove that a specific number is ESM-2 or that every day still needs 4-P.

1. Open each order's **Дни работ** tab and inspect the week beginning 26 October and the total
   planned-day count. **Распланировать период** walks the *entire order term*, not the displayed
   week. Use it only when every unplanned day in that term should be added with the selected driver;
   keep **Выписать путевые листы по заведённым рейсам** checked. If earlier gaps must stay open or
   drivers differ by day, use the individual day action for the extension dates. Read the batch's
   per-day report, including skipped/failed days and remaining portions; one run handles at most
   50 unplanned days.
2. For a day already attached to a route but lacking a 4-P, the batch skips that day. Open the
   day's route and use **Выписать лист** there. Check the issued sheet's form: route paper comes
   from the vehicle type and can differ from 4-P.
3. Once the required 4-P are issued, open the **Путевые листы** journal. Search the numbers
   displayed on the order or filter by form ESM-2 and period. Confirm each candidate's form, order, status,
   period and whether the paper has already been used or signed. Cancel only unnecessary issued
   ESM-2, with a reason, using the journal's **Аннулировать** action. A user needs `waybills.cancel`;
   cancelling after the document's last day additionally needs the established correction right.
   The cancelled number remains in the journal and is never reused.
4. Recheck every required day and the journal. Cancelling ESM-2 does not immediately call the
   reconciler, but another term or assignment change under the current `auto` mode can recreate
   missing future ESM-2. Until the policy change ships, repeat this review after each extension.
   Do not cancel a worked, signed, or physically distributed sheet blindly; use the existing
   controlled-document correction procedure with the people who hold the paper.

The 4-P batch is safe to run before ESM-2 cancellation: ADR 0207 explicitly allows both documents
on one work day, and its DB test preserves the existing ESM-2. This ordering avoids a paperless
interval if day planning reports a conflict or a missing driver.

## Proposed change

1. Add an explicit **paper workflow for this on-site order**, separate from `is_linear` and the
   vehicle type's route form. Use `NULL` as a legacy fallback for existing orders and old writers:
   their effective behavior stays unchanged. An explicit `daily_4p` choice suppresses *new
   automatic* ESM-2 weeks while retaining the reconciliation of already issued ESM-2. An explicit
   `weekly_esm2` choice keeps automatic ESM-2. Do not infer this selection from earlier 4-P: ADR
   0207 intentionally permits both documents. Store the selection on the order so that a later
   type-directory edit cannot change the decision silently.
2. Let a dispatcher with the existing issue rights select the workflow in the order's work setup
   and change it for future issuance through a guarded action. The site manager's weekly visa
   still approves dates; it cannot choose a driver or issue route sheets. Show the selected workflow
   and the expected document effect in the term and weekly-visa previews. A change after documents
   have been issued must name the affected sheets and refuse or require the existing cancellation /
   correction flow. Preserve issued numbers and their audit history.
3. Make `esm2Mode`, the weekly sweep, the history segment planner and all relevant previews read
   the same explicit selection. Reuse the existing `on_demand` reconciliation behavior for the
   daily workflow so old ESM-2 remains governed by term and assignment changes, but new weeks are
   not created automatically. An explicit `daily_4p` choice also blocks *new manual* ESM-2 issue;
   otherwise the daily label would permit contradictory paper. Legacy linear orders keep their
   present manual ESM-2 behavior. Keep route form selection with `routeWaybillForm`; it should
   remain 4-P for these tractors if their vehicle types say `4p`.
4. After a successful extension, display unplanned days and offer the existing day batch from the
   card. It asks for one driver per portion, uses the history-selected vehicle of **each day**,
   checks route conflicts and licence requirements, issues at most 50 days per portion, and reports
   skips. The current window suggests the machinist effective on the viewing date, so a future
   driver change needs an explicit choice and possibly separate portions; do not mistake that
   suggestion for the driver of every newly opened day. Do not issue 4-P silently inside the visa:
   the visa lacks the dispatcher right and the day-specific driver, and the batch deliberately
   commits one day at a time.
5. For the reported orders, after the database audit and the chosen workflow are confirmed, set
   their future workflow explicitly, reconcile only the still-cancellable unwanted ESM-2 through
   the normal cancellation/correction path, and use the day batch for missing 4-P days. Worked or
   signed documents require the established correction procedure. Never rewrite `form_code` or
   recycle a number in SQL. A pending extension should be evaluated against the new workflow; an
   already applied one needs a separate data repair, not a replay of NZ-497.

## Implementation and verification sequence

- Record the policy and transition rules in a new ADR that updates ADR 0100 and ADR 0207. Specify
  that explicit `daily_4p` forbids new manual ESM-2 while previously issued ESM-2 stays in the
  normal reconciliation/cancellation flow. Preserve legacy linear manual issue without override.
- Add a migration that is safe while the old API still runs before restart. A nullable override
  with a legacy fallback is one option: existing orders and old writers keep their old behavior;
  new readers honor the explicit choice. Do not reuse `is_linear_frozen`: it also controls fleet
  occupation, deliveries and assignment behavior.
- Update contracts, API readers and writers, weekly visa and `/period` preview/apply paths, and
  the web order setup and work-day view. Preserve the `history` and `legacy` behavior for orders
  without an override and cover both modes for an overridden order.
- Add DB tests for extension across a week and month boundary, vehicle and driver changes within a
  week, a worked ESM-2, a day route with 4-P, partial batch skips, repeated visa/command requests,
  and an old API running after the migration. Verify that an extension creates no new ESM-2 under
  the daily workflow and that the day batch can issue the required 4-P without duplicates.

Until this change, the existing **Work days → Plan the period** action can issue 4-P for the newly
added days. It does not stop automatic ESM-2 for a nonlinear order; cancelling those sheets alone
does not persist a daily workflow decision for the next extension.
