# ADR 0228. Front-end structure: six layers, slice entries and a 400-line file limit

- Статус: Реализовано (12.10.2026, roadmap item Q11 — stage 7 of the FSD plan). Drafted on
  31.07.2026 with stage 0 as an unnumbered draft and numbered now, when the tree matches it;
  describes `apps/web` at `b8e70ff5`. Not done — [What remains](#what-remains)
- Домены: каркас-портала, качество
- Изменяет: [ADR 0225](0225-lint-policy.md) (decisions 1 and 3) — `max-lines` leaves the warning
  set and becomes an error; the quality budget stays the gate for length, and both length measures
  are unchanged
- Связано: [ADR 0222](0222-frontend-query-freshness-and-render.md) (query and render policy on
  top of these layers), [ADR 0223](0223-portal-permission-oracle.md) (the matrix-reader guard in
  the same config), [ADR 0147](0147-quality-gates.md) §4 (lint errors fail `pnpm check`); plans
  [frontend-fsd-plan.md](../frontend-fsd-plan.md),
  [frontend-followup-plan.md](../frontend-followup-plan.md),
  [frontend-fsd-stage-2.md](../frontend-fsd-stage-2.md),
  [frontend-fsd-stage-3.md](../frontend-fsd-stage-3.md); baseline
  [frontend-baseline.md](../reports/frontend-baseline.md)
- Область: [eslint.config.mjs](../../eslint.config.mjs),
  [tsconfig.json](../../apps/web/tsconfig.json),
  [boundaries.test.ts](../../apps/web/test/boundaries.test.ts) and
  [its fixtures](../../apps/web/test/fixtures/boundaries),
  [quality.mjs](../../apps/web/scripts/quality.mjs),
  [quality-budget.json](../../apps/web/quality-budget.json),
  [check-stage1-layout.mjs](../../apps/web/scripts/check-stage1-layout.mjs),
  [check-stage2-layout.mjs](../../apps/web/scripts/check-stage2-layout.mjs)

## Context

By 31.07.2026 the front-end had grown with its sections to the point where file size meant
nothing: the five largest files held 29 % of the code (5 560 of 19 116 lines), and the request list
page carried its form, columns, cards, four modal windows, five mutations and a dozen queries. The
cause was not volume but the absence of layers: `pages/` held business rules, `components/` mixed
the ui kit with domain blocks, dictionary queries were copied from file to file (22 copies in 12
files), and query keys lived as string literals in 29 files.

The draft of this decision was written then, with stage 0 of the
[FSD plan](../frontend-fsd-plan.md), and lived as `docs/adr/draft-frontend-architecture.md`
without a number: on that one day the main ADR stream moved from 0043 to 0050, faster than any
reservation could hold (plan §10). It is numbered at stage 7, the closing stage, when the tree it
describes exists. What follows is today's code; where the plan's intent was not reached, the text
says so.

The analysis with numbers is in the plan, the baseline measurements in
[frontend-baseline.md](../reports/frontend-baseline.md). The plan was suspended in August 2026
after stage 1 and seven slices of stage 2, and the work went on through the
[follow-up plan](../frontend-followup-plan.md) and [stage 3](../frontend-fsd-stage-3.md). The plans
record intent; this decision and the config are the state.

## Decision

### 1. Six layers, and an import goes only down

```text
app/        composition roots (App.tsx, main.tsx, theme, styles) and app slices:
            providers, routing, layout, route windows
pages/      a route: its address, permissions, tabs and composition
widgets/    a self-contained screen block: a list with filters and cards, a host of related windows
features/   a user action — create, assign, change status, approve: form, command, mutation and
            its effect on the cache
entities/   a business entity: api, query keys, queryOptions, labels, domain ui
shared/     ui kit, utilities, http client and session, configuration — no portal rules
```

Today: 46 entity slices, 67 feature slices, 22 widget slices, 11 page slices, 4 app slices and the
four `shared` segments (`api`, `config`, `lib`, `ui`) — 1139 source files. There is no
`processes/` layer: the portal has no multi-step scenarios spanning pages.

The rules keep the draft's numbers, because code comments cite them by number:

1. **Imports go only down.** `entities` knows nothing of `features`, `features` nothing of
   `widgets`.
2. **Slices do not see their neighbours.** `entities/object` does not import `entities/user`: what
   they share moves down into `shared` or is joined one layer up. The single exception is granted
   by name: both request kinds, `entities/waste-request` and `entities/vehicle-request`, take what
   they share from `entities/request` — statuses, history, transition corridors
   ([ADR 0012](0012-waste-request-history.md), [ADR 0015](0015-vehicle-request-history.md)). The
   reverse direction is forbidden.
3. **A slice is entered only through its `index.ts`.** Internal modules (`api/`, `model/`, `ui/`)
   are invisible outside, so a slice can be rebuilt without touching its users. The entry is also
   the slice's lazy-loading point: 12 entries export `lazy(() => import('./…'))` of their own
   internals, and a dynamic import across slices names the other slice's entry
   (`import('@widgets/vehicle-request-history')`), never a file inside it.
4. **Query keys live in their entity** (`entities/<e>/api/keys.ts`, 39 slices), not in `shared`:
   otherwise the bottom layer would know every domain of the portal.
5. **A key describes a request, not an entity.** Variants ("active objects only" and "all
   objects") differ by a parameter in the key: merging them would change the behaviour of the
   forms that introduced them.

Inside `shared` the segments have a direction of their own: `ui` may use `lib` and `config`, `lib`
may use `config`, and nothing else is granted. `lib → ui` is never allowed — that is why the table
protocol moved from a component into `lib`; `api → config` waits until the transport has a
consumer of the constants. `shared` does not import `@technic/contracts`: password, name and
contact rules are domain and belong in `entities`. Every other layer may import the contracts:
they are the portal's shared vocabulary, not a layer.

### 2. The rules are held by machine, not by agreement

- **`boundaries/dependencies`** (`eslint-plugin-boundaries` 7.1.0, pinned) at `error` with
  `default: 'disallow'`: direction and slice entry in one rule. Every allowance is granted on
  `fileInternalPath: 'index.ts'`, so an import of an internal module matches no allowance and
  falls to the default. `boundaries/entry-point` is deprecated in 7.x and not used. Aliases are
  resolved by `eslint-import-resolver-typescript`.
- **`boundaries/no-unknown-files`** at `error` on `apps/web/src/**`: every source file is inside a
  layer element or is one of the composition-root files (`App.tsx`, `main.tsx`, `theme.ts`,
  `styles.css`, `vite-env.d.ts`, `app/*.{ts,tsx}`). A file in an unclassified directory fails
  lint.
- **`boundaries/no-unknown-dependencies`** at `error`: slice layers must import elements
  (`require: 'element'`), composition roots a slice element or a classified root file
  (`require: 'any'`). The draft deferred this rule to the last stage, "when no unplaced files
  remain"; it is on.
- **`no-restricted-imports`** on `apps/web/**`, tests included, rejects `@shared/*/*`,
  `@entities/*/*`, `@features/*/*`, `@widgets/*/*` and `@pages/*/*` with a message naming the
  entry. It is not redundant next to `boundaries`: it also covers the tests, which the boundary
  rules do not see.
- **26 fixture cases** in [boundaries.test.ts](../../apps/web/test/boundaries.test.ts) over
  `apps/web/test/fixtures/boundaries`, which has its own config and aliases; each case asserts a
  specific `ruleId`. A rule that no fixture checks turns out to be switched off a month later. A
  per-slice exception, like the one for `entities/request`, gets a fixture of its own.
- **Aliases** `@app`, `@pages`, `@widgets`, `@features`, `@entities` and `@shared` are declared
  once in `apps/web/tsconfig.json`; Vite and Vitest read them through `resolve.tsconfigPaths`, so
  no copy can drift.
- **`pretest`** keeps the pre-FSD tree from coming back: `check-stage1-layout.mjs` (files moved
  into `shared` do not reappear at their old paths or as stubs) and `check-stage2-layout.mjs`
  (`src/api` and the legacy directories stay gone). The quality budget counts `legacyFiles` (0 in
  `hooks`, `utils`, `components`) and `rawKeyFiles` (0 files with a string-literal key outside an
  entity's `keys.ts`). No re-export stub of an old path remains.

### 3. A source file is at most 400 lines, and lint reports a longer one as an error

`max-lines` on `apps/web/src/**` — 400 lines without blank lines and comments — is an **error since
12.10.2026**. This amends [ADR 0225](0225-lint-policy.md), whose decision 2 says that a level
changes only by a new ADR; this is that record.

- **Why now.** The plan's first acceptance criterion (§8.1) is that no file in `apps/web/src` is
  longer than 400 lines. Stage 3 reached it: `maxLines` in `quality-budget.json` held 21 files with
  18 597 lines on 30.09.2026 and is empty today, and the longest source file has exactly 400 raw
  lines. Under ADR 0225 decision 1 a warning means known debt and an error means forbidden code.
  With the list empty there is no debt left to know, and a warning would describe a state that no
  longer exists.
- **Why this is not the raise ADR 0225 decision 2 rejected.** That rejection is about rules whose
  cleaned class an author would newly meet as a red `pnpm check` in the middle of work. Length was
  already gated: the budget fails `pretest` on any new file over 400 raw lines, and raw lines are
  never fewer than the lint count, so the budget already rejects every file this rule reports. The
  error adds no demand on an author; it makes lint agree with the gate and names the file in the
  editor and in the error list of `pnpm check`.
- **What does change.** The one way past the budget — a relaxation of `maxLines` edited by hand,
  where review sees it — now covers only a file whose excess is comments and blank lines. A file
  whose code alone is over 400 lines also needs a `max-lines` disable directive with its reason in
  that file (ADR 0225 decision 5: a one-file exception lives in the file).
- **What stays.** The budget is the gate and keeps the raw measure; lint keeps `skipBlankLines`
  and `skipComments`, because comments carry this repository's decisions and a length rule that
  punished them would reward deleting them (ADR 0225 decision 3). Tests stay outside the rule. A
  file is split along its responsibilities, not to meet the number: the stage 3 invariants hold (a
  move and a logic change are separate commits, invariant comments travel with the code), and the
  maintenance policy `module-size-signal` keeps length an advisory signal for automated work.

Measured at `b8e70ff5`: `eslint .` over 2438 files gives 0 errors and 0 warnings with the rule at
`warn`, and the same with it at `error`.

## Consequences

What becomes impossible:

- importing up the layers or sideways across slices;
- reaching inside another slice past its `index.ts`;
- keeping domain query keys and domain ui in `shared`;
- adding a dictionary query by copy-paste: it has a home, `entities/<e>/api/queries.ts`;
- adding a source file longer than 400 lines.

What it costs:

- every slice carries an `index.ts` to maintain;
- moving code between layers takes thought, not a file move: a module that fits no layer usually
  does two different things;
- some knowledge has no home: a cache effect spanning two entities can live neither in one of them
  (rule 2) nor in `shared` (rule 4), so each feature that causes it names the stale roots itself
  (`features/device-mail-identities`, `features/device-poll`); a third root means editing each of
  them;
- the boundary rules add a few seconds to lint.

What it gives: a page stops being the place where everything lives; a cross-cutting change (a
filter, a status, an invalidation) is made in one place instead of five; queries and dictionaries
are reused instead of copied.

## What remains

- **`pages` still hold behaviour.** "Composition only" holds for the request lists and
  directories cut in stage 3, not for the layer as a whole: 63 of the 290 files under `pages/` call
  `useMutation` (features: 68 files, widgets: 22). The plan's own exceptions (§2.2) are pages by
  intent — the authentication forms in `pages/auth` and waybill annulment in `pages/waybills`. The
  rest is stage 4 work, done along with tasks; no counter holds it.
- **Tests bypass slice entries.** 225 imports in 143 files of `apps/web/test` reach inside a slice
  by relative path (`../src/<layer>/<slice>/…`), 208 of them inside `pages`. `no-restricted-imports`
  matches only the alias form, and the boundary rules cover `apps/web/src/**` only. Stage 3
  recorded 196 such imports in 130 files as named debt of stage 4; with no ratchet on it, it has
  grown.
- **The plan's query and render goals** are a separate decision,
  [ADR 0222](0222-frontend-query-freshness-and-render.md); the styles stage (plan §6) is not part
  of this one.

## Rejected

- **`import/no-restricted-paths` instead of `boundaries`**: it controls direction but does not
  forbid a deep import into a slice (plan §2.4).
- **A `processes/` layer**: there are no multi-page scenarios to put in it.
- **Query keys in `shared`**: the bottom layer would know every domain (rule 4).
- **One key per entity**: it would merge the variants that forms depend on (rule 5).
- **Reserving an ADR number for the draft**: the stream outran any reservation, so the number was
  taken at commit (plan §10).
- **Keeping `max-lines` a warning once the budget's list was empty**: the level would claim debt
  that no longer exists (decision 3).
