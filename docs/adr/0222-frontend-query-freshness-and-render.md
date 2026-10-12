# ADR 0222. Portal query freshness, deferred options, and list rendering

- Статус: Принято (09.10.2026)
- Домены: каркас-портала, качество
- Изменяет: [ADR 0074](0074-entity-links-between-tabs.md) — `PageTabs` refreshes only mounted
  reads in the current section; `useOpenedRecord` keeps an already loaded card open after a
  background refetch error.
- Связано: [ADR 0030](0030-responsive-layout.md) — desktop tables and mobile cards share list
  state; [ADR 0042](0042-directories-on-phone.md) — mobile filter sheets must start deferred
  dictionary reads when opened.
- Область: [query.ts](../../apps/web/src/shared/config/query.ts),
  [query.tsx](../../apps/web/src/app/providers/query.tsx),
  [listQueryOptions.ts](../../apps/web/src/shared/api/listQueryOptions.ts),
  [useDeferredOptions.ts](../../apps/web/src/shared/lib/useDeferredOptions.ts),
  [check-cache-invalidation.mjs](../../apps/web/scripts/check-cache-invalidation.mjs)

## Context

The portal used one ten-second freshness term for most reads. Identical HTTP reads could have
different cache keys, while filters and closed forms loaded dictionaries on the first screen.
Changing a list page or filter blanked its rows. Some forms copied refreshed data over unsaved
input. `ExpandableCell` also recreated a `ResizeObserver` on rerenders. The front-end
architecture decision, [ADR 0228](0228-frontend-architecture.md) (drafted earlier, numbered later),
addresses layer and import boundaries; this decision records the query and render policy introduced
in Stage 5. The
[Stage 5 plan](../frontend-fsd-plan.md) remains intent and measurement history, not runtime policy.

## Decision

1. **One query client and one owner for shared reads.** Application and tests use
   `createQueryClient` and the same production freshness defaults; tests may turn retries off.
   Shared profiled reads use a canonical factory in their owning entity. Other `LIVE` reads may
   remain inline under the client default. Different parameters remain different keys, while
   identical HTTP reads share one key. Cache analysis checks covered families for foreign roots,
   direct foreign API reads, reads bypassing a factory, and duplicate factories. Freshness
   exceptions require an explicit local reason. Mutations invalidate the owner and any affected
   derived views; a long freshness term never suppresses invalidation.

2. **Freshness has five named policies in `shared/config/query.ts`.** The exact values are:

   | Policy       | Stale after |    Cache retained | Browser focus | Use                                                       |
   | ------------ | ----------: | ----------------: | ------------- | --------------------------------------------------------- |
   | `LIVE`       |  10 seconds |         5 minutes | off           | Feeds, summaries, registers and records by client default |
   | `SIGNAL`     |  60 seconds |         5 minutes | on            | Shell badges and pending counts                           |
   | `DICTIONARY` |  30 minutes |        35 minutes | off           | Mutable dictionaries                                      |
   | `PICK`       |  60 seconds | as the dictionary | off           | An open form observing the same dictionary key            |
   | `STATIC`     |       never |      indefinitely | off           | Licence categories with no write API                      |

   `PICK` changes only an observer's age threshold, preserving the dictionary factory's cache
   metadata. Form defaults and copied values wait for a current answer, including completion of
   an in-flight refresh; a disabled observer's cached success alone is insufficient. Reconnect
   refresh remains on except for `STATIC`. No recurring timer was added in this stage.

3. **R1-b keeps `LIVE` focus refetch disabled.** A two-minute return to the browser tab creates
   zero `LIVE` requests in all nine measured sections. Six sections make no focus requests; the
   other three make two or three `SIGNAL` badge requests. Enabling `LIVE` would add one to six
   requests per return, with six in Garage and four in Waste Removal and Vehicle Requests.
   Some forms still initialize from live props, so the measured cost and input-reset risk do
   not justify that refresh before event-driven updates. R2-a refreshes `SIGNAL` badges on focus
   after 60 seconds. Switching an Office Equipment pane does not refresh shell badges.

4. **A section tab refreshes only its mounted section reads.** Switching a Directories or
   Administration pane does not invalidate other sections or shell badges. The measured request
   counts for a switch with two visited panes are six and five respectively, down from seven and
   nine. This narrows the old global invalidation in `DirectoriesPage` and
   `AdministrationPage`. Mutations that change labels embedded in other dictionaries invalidate
   those carriers explicitly.

5. **Filters and forms start dictionary reads when needed.** A filter starts its own observer on
   opening, or immediately when it has a selected or saved value so its label remains visible.
   Opening a mobile filter sheet starts its visible deferred filters. A covered form selection
   starts its own `PICK` observer on opening and refetches a list older than 60 seconds; an
   answer already in flight is shared by the key. A field stays in loading state until the first
   answer, so an empty-list message or automatic selection cannot treat an unfetched list as
   empty. The twelve measured first-screen scenarios reached their named targets: 3, 3, 4, 3,
   1, 4, 2, 1, 1, 1, 1, and 2 requests in plan order. An operator hint still needs present
   containers for every waste request kind and was not deferred.

6. **Keep server-list context during a parameter change.** `listQueryOptions` uses
   `keepPreviousData` for server lists and paired summaries, except when a query is disabled.
   The old rows and pagination remain visible under loading indication. Selection and bulk
   actions are disabled while rows are placeholders, so a command cannot act on the previous
   result set. Search waits 300 ms after typing and submits immediately on Enter.

7. **An open form owns its input session.** A background read cannot silently replace dirty
   fields. Versioned forms submit the version captured when populated; their own mutations
   advance that snapshot. A clean form can accept a newer answer. A dirty form whose record
   changed shows the R6-a conflict notice and an explicit “Reload” action. A loaded card stays
   open after a background refetch error; an initial failure or 404 closes it.

8. **Keep observers stable; require measured value before table memoization.**
   `ExpandableCell` keeps one `ResizeObserver` and one `MutationObserver` per mounted cell,
   watches clamped text mutations, and disconnects both on unmount. A test asserts that
   rerendering unchanged text creates zero additional resize observers. A temporary
   `memo(DataTable)` change was discarded after the browser measurement below.

## Render measurement and limits

The browser fixture rendered the real `VehicleRequestFeed` widget with 500 vehicle orders in a
production Vite build using `react-dom/profiling`, headless Chromium 154, and a 1440 × 900
viewport. Each series contains five React update commits after one warm-up. Actual durations in
milliseconds were:

| Series                      | Five update commits (ms)               | Median |
| --------------------------- | -------------------------------------- | -----: |
| Baseline A                  | 779.7, 781.2, 847.8, 921.3, 1163.0     |  847.8 |
| Temporary `memo(DataTable)` | 730.2, 758.6, 766.8, 855.3, 1112.9     |  766.8 |
| Baseline B                  | 1345.9, 1346.0, 1430.9, 2239.6, 2692.9 | 1430.9 |

The two baseline medians differ by 583.1 ms, more than the 81.0 ms difference between baseline
A and the temporary memo variant. The feed recreates rows, columns, card configuration and
callbacks on rerender, so `memo(DataTable)` did not prevent its 500 rows from rendering. This
fixture does not measure authenticated live API latency or establish a user-visible speedup.
The temporary benchmark code and memo change were removed. The production entry bundle after
wave 6 measured 558,637 gzip bytes (545.5 KiB), below the Stage 3 ceiling of 555.7 KiB.

## Consequences

- Infrequently changed dictionaries can be stale for up to 30 minutes when another user edits
  them; opening a form after 60 seconds or a local mutation makes its selection current sooner.
- `LIVE` records changed by another user appear on a later mount or local invalidation; browser
  focus alone does not update them under R1-b.
- List placeholders keep visual context but cannot be selected or used for bulk commands.
- The browser render result supports stable cell observers. It does not support retaining
  `memo(DataTable)` or a claim of production latency improvement.
