# ADR 0241. The readings report gets a button in the garage header, for managers and mechanics

- Статус: Реализовано (02.11.2026); not deployed
- Домены: гараж, доступ
- Изменяет: [ADR 0240](0240-readings-report-by-request-days.md) — the book's place (the garage
  header besides «Выгрузки») and its holders (the manager and both mechanic roles by role);
  [ADR 0180](0180-readings-admin-export.md) — the right no longer opens «Администрирование» by
  itself
- Связано: [ADR 0110](0110-readings-intake-stats-maintenance.md) (the mechanics' maintenance form
  without readings, now with them), [ADR 0121](0121-portal-sections-registry.md) (start order of
  sections), [ADR 0076](0076-garage-day-view.md) (the garage)
- Область: [button and window](../../apps/web/src/features/readings-report-export),
  [garage page](../../apps/web/src/pages/garage/GaragePage.tsx),
  [tab strip](../../apps/web/src/shared/ui/PageTabs.tsx),
  [exports tab](../../apps/web/src/pages/admin/ExportsTab.tsx),
  [administration page](../../apps/web/src/pages/admin/AdministrationPage.tsx),
  [role sets](../../packages/contracts/src/permissions.ts),
  [administration entry](../../packages/contracts/src/permission-catalog.ts),
  [start order](../../packages/contracts/src/portal-sections.ts)

## Context

The readings report (ADR 0240) lived only in «Администрирование → Выгрузки», behind its own right
held by the administrator and by grants. On 02.11.2026 the owner asked, urgently, for the book to be
downloadable from a button in the garage header — at the right end of the tab strip, pushing the
day and the counters to the left — with a window that explains the book and picks the period on a
calendar, one export without a choice of kind; available to administrators, managers and mechanics
in full. A survey the same day fixed the two forks below.

## Decision

1. **A «Отчёт» button at the right end of the garage tab strip**, on every tab: the book belongs
   to the section, its period is its own, unlike the day or the period the tabs show. `PageTabs`
   gained `actions` — section buttons after the active tab's widget; on phones they sit at the end
   of the row under the strip, the button shows only its icon.
2. **The window holds the same form as «Выгрузки»**: an explanation, the period on a calendar
   (default — the current month up to today, at most 366 days), «Скачать книгу», the composition of
   the two sheets and the meaning of «—» and «Проверить». The form moved from the admin page into
   the `readings-report-export` feature, so both places show one form. No choice of export.
3. **Holders by role**: the manager gets `vehicleReadings.export` (it already reads readings and
   vehicle requests). Both mechanic roles get the book **and the two reads it requires** —
   `vehicleReadings.read` and `vehicleRequests.read` (the owner's choice over «the book only»): the
   service now sees the garage's «Показания» tab and the «Заказ ТС» section read-only. It still
   neither accepts a day nor corrects a reading (`vehicleReadings.write` is not given). The
   requirement of ADR 0240 stays as it was.
4. **The book stays in «Выгрузки», the menu does not change** (the owner's choice): the right is
   removed from `ADMIN_PAGE_PERMISSIONS`, so it no longer opens «Администрирование» by itself —
   otherwise managers and mechanics would get that menu item with one tab. «Выгрузки» lists the
   book for those the page admits by another right (the administrator).
5. **The garage stays the mechanics' start page**: with `vehicleRequests.read` they would land in
   «Заказ ТС» (start order 3) instead of the garage (4), so the two swap places. Every other role
   holding both sections starts at «Вывоз мусора», so the swap moves nobody else.

## Consequences

- Mechanics see the «Показания» tab — intake, journals, statistics and dashboard photos — and the
  vehicle request list, read-only. ADR 0110's reason for keeping readings from them (a form should
  not open a module) is kept for the maintenance right itself: `vehicleMaintenance.*` still does
  not imply readings; the service now has readings for the report.
- A grant holder of `vehicleReadings.export` whose only administrative right was the export loses
  «Администрирование» and finds the book in the garage, if the garage is open to them; a holder
  without `garage.read` would have no door to the book. None is known: the dev data has no grant
  with the right, and the roles the owner named now hold it by role.
- No migration of the schema and no client floor change: the role sets are computed by the server
  on each request. The release entry is migration `0403`.
