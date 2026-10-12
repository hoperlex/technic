# ADR 0224. Codebase maintenance: code, not the model, decides what may change automatically

- Статус: Реализовано (14.09–30.09.2026, recorded 12.10.2026). The mechanism is in `main`, and its
  own 269 tests and types run inside `pnpm check`. No accepted batch has reached git history yet:
  no ref carries a `refactor(maintain): …` commit
- Домены: качество
- Развивает: [ADR 0147](0147-quality-gates.md) — behaviour is proven by the same two gate commands,
  and the maintenance system may run them but never edit them;
  [ADR 0176](0176-docs-navigation-layer.md) — domains and decisions come from the code map and the
  ADR header parse, not from a second list
- Связано: [ADR 0191](0191-version-numbering.md) (`architecture/policies/versioning.yaml` lives
  next to these policies but is enforced by `check-version.mjs`, not by this system; the start gate
  names the stable point by it), plan [maintenance-framework-plan.md](../maintenance-framework-plan.md)
  (stages ЭA–ЭG and the waves of 17.09 and 24.09), operator guide
  [maintenance-guide.md](../maintenance-guide.md)
- Область: [maintenance.config.ts](../../maintenance.config.ts),
  [architecture/README.md](../../architecture/README.md),
  [modules.yaml](../../architecture/modules.yaml),
  [architecture.yaml](../../architecture/policies/architecture.yaml),
  [protected-surfaces.yaml](../../architecture/policies/protected-surfaces.yaml),
  [exceptions.yaml](../../architecture/policies/exceptions.yaml),
  [maintenance.yaml](../../architecture/policies/maintenance.yaml),
  [main.ts](../../tools/maintenance/cli/main.ts),
  [surfaces.ts](../../tools/maintenance/policies/surfaces.ts),
  [selector.ts](../../tools/maintenance/core/selector.ts),
  [behavior-lock.ts](../../tools/maintenance/verification/behavior-lock.ts),
  [handoff.ts](../../tools/maintenance/git/handoff.ts),
  [release.config.mjs](../../eslint/release.config.mjs)

## Context

By September 2026 the repository already had gates (`pnpm check`, `pnpm check:db`, ADR 0147), a
checked documentation layer (ADR 0176), layer boundaries in the lint config and a quality budget
that may only shrink. Nothing answered a different question: **what may an agent change on its
own, how much of it, and who decides whether the result is accepted.**

Two facts made the question urgent rather than academic.

- **An open-ended "improve the code" loop does not stop.** A model always finds one more
  improvement, and a model that judges its own edit accepts it. A cycle whose scope, budget and
  acceptance are decided by the model is a cycle without an end.
- **The working tree is shared.** Several sessions edit and commit in it several times an hour, and
  uncommitted work of others is always present. A rollback by `git stash` or `git checkout .` would
  take that work with it, irreversibly, for a person who knew nothing about the run.

The plan started from the external concept "Codebase Maintenance & Convergence Framework" (kept
outside history) and measured first what the repository already had under other names. The rule
of [AGENTS.md](../../AGENTS.md) — one rule, one place — decided the shape: reuse the existing
carriers, add only the machine layer that was missing.

## Decision

### 1. `pnpm maintain` answers what may change automatically; the agent only finds and fixes

The agent has two roles and nothing else: a **reviewer** finds problems and returns structured
findings, a **fixer** edits the findings it was given. Everything that decides — what is taken,
how much, whether the edit is accepted, rolled back or handed to a person, when the run stops — is
deterministic code: `core/selector.ts`, `core/convergence.ts`, `core/deep-window.ts`,
`verification/behavior-lock.ts`. The same findings under the same budget give the same selection,
so two runs on unchanged code can be compared.

The commands (`tools/maintenance/cli/main.ts`):

| Command                                            | What it answers                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `doctor`                                           | are the config, policies, module map and runtime directory sound     |
| `policies`, `surfaces [path …]`, `modules`         | what the rules are; which mode a path has and which mask decided it  |
| `analyze`, `review`, `fix-task`, `verify`, `abort` | the manual protocol, one step at a time                              |
| `converge [--status] [--abort]`, `report`          | the short cycle: three different passes, one step per call           |
| `deep [--force] [--status] [--report] [--abort]`   | the long window: zones, a ranked debt queue, small batches, a budget |
| `ledger`                                           | record a human decision on a finding                                 |
| `hook [--install [--auto]] [--remove]`             | the commit queue (see decision 7)                                    |

### 2. A protected area is never changed automatically, whatever the confidence

[protected-surfaces.yaml](../../architecture/policies/protected-surfaces.yaml) names the places
where a mistake costs more than a failed test. Modes are three: `allowed` (the default, so the file
lists exceptions, not the repository), `manual-review` (an edit may be proposed, the system never
accepts it itself) and `forbidden`.

| Surface                    | Mode            | What it covers                                                                                                                                |
| -------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-schema-and-migrations` | `forbidden`     | `apps/api/drizzle/**`, `schema.ts`, `migrate.ts`, the migration journal, `apps/api/teardown/**`                                               |
| `access-model`             | `forbidden`     | `permissions.ts`, `permission-*.ts` in contracts, `apps/api/src/auth/**`, the auth plugins                                                    |
| `quality-gates`            | `forbidden`     | `check.mjs`, `check-db.mjs`, `check-docs.mjs`, `scripts/lib/**`, `quality.mjs`, the budget, `eslint.config.mjs`, `package.json`, the lockfile |
| `decisions-and-deploy`     | `forbidden`     | `docs/adr/**`, `deploy/**`, `certs/**`, `.env.example`                                                                                        |
| `money-and-documents`      | `manual-review` | ESM-2, waybill, print and waste pricing services                                                                                              |
| `outbound-mail`            | `manual-review` | mail services, `apps/api/src/mail/**`, `apps/worker/src/**`                                                                                   |
| `tests-as-behavior-proof`  | `manual-review` | `apps/*/test/**`, `packages/*/test/**`                                                                                                        |

The rule is held in two places of the code, and neither asks the agent's confidence:

- **at selection** the surface is asked first, before exceptions, before the policy, before the
  behaviour risk and the confidence threshold. A finding with a file in a `forbidden` or
  `manual-review` area goes to a person (`manual`). An exception from `exceptions.yaml` cannot lift
  it: it is asked second precisely so that a line there cannot silently override a surface it never
  mentioned;
- **after the edit** the behaviour lock flags any touched file whose mode is not `allowed`, and the
  outcome is "needs a human" with nothing rolled back.

For the automaton `manual-review` and `forbidden` therefore end the same way; the difference is
for the person reading the report. **Severity** in `architecture.yaml` and **mode** here are
different questions on purpose: severity says how strict a rule is, the mode says how expensive a
mistake in this place is. A migration is `forbidden` whether or not it breaks any rule.

**How a mode is computed** (`policies/surfaces.ts`, `core/paths.ts`): the path is normalised to a
repository-relative path with forward slashes; a mask `dir/**` also covers the directory itself;
among the matching masks the longest one wins, so a narrow rule inside a broad one prevails
regardless of file order; on equal length the stricter mode wins, because an extra prohibition
costs one manual edit and an extra permission costs an edit in a migration. A batch takes the
strictest mode of its files. `pnpm maintain surfaces <path>` prints the verdict and the mask that
produced it.

### 3. Rules live in `architecture/`, decisions stay in `docs/adr/`, nothing is copied

[architecture/](../../architecture/README.md) holds only the machine layer and points to the
carriers of each rule instead of restating them.

- **`policies/architecture.yaml`** — ten rules (8 `hard`, 1 `soft`, 1 `advisory`). Each names who
  enforces it (`enforcedBy`: `eslint`, `check-docs`, `quality-budget`, `tests`, `ai-review`,
  `human`) so the system neither re-checks what a machine already checks nor pretends to check what
  only a person watches. Each says whether automatic fixing is allowed; only two allow it —
  `docs-header-integrity` (the check itself proves the fix) and `comment-explains-why` (no
  executable code changes).
- **`modules.yaml`** — package directions, which the lint config does not guard: `contracts` depends
  on nothing; `api`, `worker` and `web` depend only on `contracts`; `tools` and `scripts` on
  nothing. The portal layers are named with a pointer to `eslint.config.mjs`, not repeated.
  **Domains are not listed**: they are read from [docs/code-map.md](../code-map.md) by
  `tools/maintenance/project/code-map.ts`, with the dictionary of `scripts/lib/docs-navigation.mjs`.
- **`policies/exceptions.yaml`** — empty on purpose: the exceptions in force already have carriers
  (lint `ignores`, the collision sets of the docs parser) and a copy would drift. An entry needs a
  policy, masks, a reason and a review date; an expired one does not shelter its finding, it sends
  it to a person.
- **`policies/maintenance.yaml`** — numbers only: budgets, passes, stop conditions, the deep
  window, ledger review periods. The wiring — which commands prove behaviour, which lint profile
  collects facts, path aliases, the workshop, the agent, the scope — is
  [maintenance.config.ts](../../maintenance.config.ts), the only file where the core meets this
  repository. The scope is `apps/**`, `packages/**`, `scripts/**`, `tools/**`; `docs/**` is left to
  `check-docs`, and migrations are excluded outright.
- **`eslint/release.config.mjs`** — the `release` lint profile collects facts. It imports the
  everyday profile unchanged and adds warning-only signals (complexity, depth, function and module
  length, parameters, `TODO`), thresholds taken from this tree's distribution.

`pnpm maintain doctor` fails when the runtime directory is not ignored by git, a rule's carrier or
decision link is missing, a package directory or public entry has gone, or no verification level
is on by default. It warns, without failing, when a `hard` rule has no decision link, a linked
decision was changed after the policy file, an exact surface path no longer exists or an exception
is past its review date.

### 4. Selection: eight refusals and three limits, each with a reason

`selectFindings` asks, in this order: the protected surface; a covering exception (active →
rejected as legitimised, expired → a person); the policy (unknown → a person, since the model may
have invented it; `advisory` → rejected, never a reason to edit; `autofix: false` → a person);
behaviour risk above `allowedRisk: low` → a person; confidence below `0.88` → deferred. Then three
budget limits: 5 findings per pass, 25 files, 1500 lines (a finding without an estimate counts as
40). Findings are ordered by severity, confidence, cost and id. Every verdict, taken or not, goes
into the report with its reason — otherwise the report could not answer "why was this not taken".

### 5. Behaviour is proven by the existing gates, judged by difference

Verification levels are the gates of ADR 0147: `pnpm check` on by default, `pnpm check:db` only by
flag, because on a shared database it fails falsely and a false failure rolls back a correct edit.

Before any gate runs, the behaviour lock asks four questions: did the edit leave the batch (a file
the fixer itself named → out of scope; a file it did not name → concurrent work, accepted only with
`--allow-concurrent`); was a test touched (`test/` directories, `*.test.*`, `*.spec.*` — adjusting
the proof to the edit is forbidden); was a protected area touched; did it get worse where it can be
measured (more lint errors, broken types, or lint that produced no machine report — unmeasured is
not clean). Warnings do not count: they are debt, and a change of one is no reason to undo a correct
edit.

Outcomes are three and chosen by code: **accepted**; **rolled back** — the batch files restored
byte for byte from a per-file checkpoint, never the whole tree; **needs a human** — nothing is
touched, because undoing the permitted half would leave a state that never existed. There is no
"try again" outcome. A failing gate step is compared with the failure trace of the bare base,
measured once per run: the same failures are not the batch's fault, new ones roll it back, and a
base that fails without the edit is reported as such instead of punishing the batch.

### 6. Work happens in a workshop; accepted work leaves as a local commit, never a push

With `workshop.enabled` (on in this repository) a run works in a separate git worktree built from
`HEAD` under `.maintenance/tmp/workshop/`, and the shared working tree is touched neither by file
nor by index. The scope is taken from **cooled** code: files of queued commits (or the last ten),
minus everything dirty or edited on disk in the last ten minutes.

With `workshop.commit` (also on) an accepted batch leaves as a commit `refactor(maintain): …` that
contains only the batch files (`git/handoff.ts`): the branch ref moves by compare-and-swap, a
branch that moved meanwhile gets the commit replayed on top once, untouched working files are
synced to the new tip, and files busy with someone's work are named instead. Without the workshop
(the manual `maintain verify`) an accepted edit stays in the tree for the person to commit.
**Nothing in `tools/maintenance` pushes.**

Derived run state — facts, tasks, results, reports, checkpoints, the ledger, logs, the workshop —
lives in `.maintenance/`, which git and lint both ignore.

### 7. Nothing starts by itself unless a person installs it

`converge` advances a run by one step per call and keeps its state in
`.maintenance/state/run.json`; a lock admits one run at a time and a second one leaves instead of
waiting. `deep` is enabled in the policy, which only means it does not need `--force`; a person
still calls it. The start gate blocks on gates that are red on the tip and only warns on gates
that were not run; `converge` runs them before starting only with `start.requireGreen` (off today,
so it starts with a warning), while `deep` always runs the full baseline and refuses a red tip.

`pnpm maintain hook --install` installs a `post-commit` hook that appends the commit to the queue
and skips the system's own commits by their subject; `--auto` additionally starts a run per commit,
opt-in. The hook never blocks or delays a commit, so ADR 0147's "no hook that stops a commit" still
holds.

The agent is reached through an adapter. The framework default is `manual` (the person carries the
task); this repository's config selects `command` with `provider: 'claude'` since 16.09.2026, and
`--agent manual` switches back for one run. The reviewer is started without edit tools, the fixer
with them; a timeout (20 minutes), a non-zero exit or an empty answer is an agent failure, not an
empty result.

### 8. The ledger remembers human decisions, but not forever

Each finding has a fingerprint built from its kind, files and a stable subject — not from line
numbers or the editable title — and a status (`new`, `accepted-debt`, `deferred`, `false-positive`,
`fixed`, `reopened`). A decided finding is not shown to the agent again until the code around it
changes (asked from git, not from file times), the rule changes, the evidence changes materially or
the review period passes (90 days deferred, 180 days false positive).

### 9. The core is meant to be portable; the boundary is a rule, not a test

Only `tools/maintenance/project/` may know this repository; `core`, `analyzers`, `policies`,
`work-packets`, `git`, `state`, `verification`, `reporters` and `cli` must not name `apps/`,
`packages/`, `pnpm check` or `docs/code-map.md` — all of it arrives through the config. This is the
`hard` rule `tooling-core-is-portable`, and its only enforcer is `ai-review`: no test and no lint
rule checks it. This decision is the written rationale that `doctor` reports the rule as lacking.

## What was left out

These were in the plan or the concept and are **not** in the code. The plan describes them as
intent; none of them is today's behaviour.

- **External state store** (`~/.vibe-maintenance/<project-id>/`, plan Р1) — not built; state lives
  only in `.maintenance/` of the checkout.
- **Moving the everyday lint profile to `eslint/vibe.config.mjs`** (plan Р4, §7) — not done; the
  `release` profile is an overlay on `eslint.config.mjs`.
- **Characterisation tests** (concept F14) — not built; behaviour proof is the existing gates.
- **SQLite for the ledger** — not built; the ledger is JSON (`.maintenance/state/ledger.json`).
- **An API agent adapter** — stage ЭG named "CLI/API"; only the manual adapter and the command
  adapter for the `claude` and `codex` CLIs exist.
- **Extraction of the core into an external library**, and the "mechanical" check of its boundary
  (plan §5) — neither exists; the boundary is the review-enforced rule of decision 9.
- **CI, schedules, concurrent runs** — none: runs are started by a person or by the opt-in `--auto`
  hook, and a second run is refused by the lock, not queued.
- **A portal section or permission** — none by design: the system lives in the developer's command
  line.

## Cost and limits

- **The proof is as good as `pnpm check`.** The db suite is off by default, so an edit in server
  services is accepted on the fast suite unless the run is started with `--level database`.
- **Tests are never edited automatically**, not even renamed: every such finding goes to a person.
- **Text-only rules depend on the reviewer.** `single-source-of-rule`, `no-second-registry`,
  `contracts-are-shared-language` and `tooling-core-is-portable` are `hard` but enforced by
  `ai-review`; a reviewer that misses a violation lets it through.
- **The path from workshop to branch has been rehearsed and tested, not used.** No accepted batch
  is in history yet; the first real one is the first proof that the handoff behaves on a live
  branch.

## Rejected

- **Let the model decide scope, budget and acceptance.** The loop would never end, and the
  acceptance would be the author grading its own work.
- **Roll back with `git stash` or `git checkout .`.** It takes other sessions' uncommitted work.
- **Own gates for the maintenance system.** Two answers to "is the behaviour kept" would diverge;
  ADR 0147's commands are reused and protected from edits.
- **A domain list in `modules.yaml`.** It would drift from the code map within a week, and
  `check:docs` would not notice.
- **A commit hook that runs maintenance by default.** Commits arrive several per hour from several
  sessions, each would start a quarter-hour agent run; the hook only queues.
- **Policies in JSON or TypeScript.** JSON has no comments for the reasons, and a `.ts` file is
  executed, which is the wrong role for data an agent reads and a person edits; YAML costs one root
  dependency (`yaml`).
