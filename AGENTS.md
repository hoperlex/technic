# How to work in this repository

A construction company's portal: vehicle, waste removal, mechanization and office equipment
requests, waybills, garage, directories, driver cabinet. A pnpm monorepo: `apps/api` (Fastify),
`apps/web` (React), `apps/worker` (background jobs), `packages/contracts` (schemas, permissions,
predicates — the shared language of server and portal).

## Where to start

1. **[docs/code-map.md](docs/code-map.md)** — 16 logical areas: where the scenario you are changing
   lives and which layers it passes through. The directory tree does not follow the logic.
2. **[docs/adr/README.md](docs/adr/README.md)** — the decision index by domain, with "changed /
   revoked" links. Built by `pnpm docs:index`, never edited by hand.
3. The decision (ADR) itself — why it is done this way. The rule is simple: **read the decision for
   your area first, then change code**. Half of the invariants here are held not by types but by
   agreement, and that agreement is written in ADRs and in comments next to the code.

## Source-of-truth hierarchy

When sources disagree, the higher one wins. A plan is the history of an intent, not the system:

| What                                         | Where                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| System behavior                              | code `packages/contracts` → `apps/api` → `apps/web`                                |
| Access model (permissions, sets, scope)      | [docs/access-model.md](docs/access-model.md) + `packages/contracts/permissions.ts` |
| DB schema                                    | `apps/api/src/db/schema.ts` + migrations `apps/api/drizzle/`                       |
| Schema digest for reading                    | [docs/database-schema.md](docs/database-schema.md)                                 |
| Why it was decided this way                  | `docs/adr/*.md`                                                                    |
| What was intended (including never realized) | `docs/*-plan.md` — **intent, not state**                                           |
| How to deploy and what to do on failure      | [docs/runbook.md](docs/runbook.md)                                                 |

## Commands

```bash
pnpm check          # types, lint and all tests except the db suite
pnpm check:db       # db tests (needs its own fresh database)
pnpm check:docs     # docs integrity; fails on errors (dead link, duplicate number, stale index),
                    # only shows warnings; `-- --strict` raises them, `-- --report-only` never fails
pnpm test:docs      # tests of the documentation parser
pnpm docs:index     # rebuild docs/adr/README.md (after editing ADR headers)
pnpm db:migrate     # apply migrations
pnpm maintain       # codebase maintenance: doctor, policies, surfaces, analyze, verify
```

`pnpm maintain` ([plan](docs/maintenance-framework-plan.md)) answers "what may be changed
automatically here"; its rules and protected areas live in `architecture/`. A change in a protected
area (migrations, permissions, gates, decisions) is never automatic, whatever the confidence;
`pnpm maintain surfaces <path>` tells the mode for a file.

## The rules most expensive to break

**Russian is for talking to the user — the one justified exception.** Everything else agents write
is English: reasoning, instruction files, handoffs, agent memory, code comments, new ADRs, plans and
docs; old Russian text is translated when touched. Commit messages and journal cards stay Russian,
as do UI strings, domain terms and ADR header fields (`Статус`, `Домены`) with their dictionaries.

**ADR and migration numbers are taken by parallel streams.** Before creating a file, look at the
taken numbers (`ls docs/adr`, `ls apps/api/drizzle`), take the next after the maximum and check again
before `git add`. It is a detector, not a lock: 0060 and 0085 are already taken twice and too late to
renumber, so a reference to them never uses a bare number — it carries the file path.

**Writing `Домены` in a decision header declares the new form**: the status and domain dictionaries
and the `Область` field are then required. Without it nothing new is required, and the domain comes
from `scripts/lib/docs-legacy-domains.mjs`. **Never both**: add the field — remove the table row.

**A header path missing from the tree is checked against git history**: the file lived and was
removed — the decision's history, a warning; it never existed — a typo and an error.

**One rule, one place.** Contract predicates, not the portal, decide whether an action is
available; document kinds, status corridors and dictionaries live in `packages/contracts` and both
sides ask them. A copy on the other side diverges silently — prohibitions were lost this way.

**Migrations run while the portal is up and before the application restarts.** So for a while a new
column is written only by old code: a change must survive that window (see `docs/runbook.md` and
the teardown suite in `apps/api/teardown/`).

**A comment explains the reason, not the action, and is written in English.** Delete comments that
retell the code, repeat the function name or no longer match the implementation. A useful comment
names the invariant on its own, why this path was chosen and what breaks if it is violated, so an AI
agent need not guess the author's context. Translate the Russian comments of the fragment you work on
by meaning, not word for word. A comment next to an invariant beats an ADR link in every file.

**Work is recorded in the task journal** — one, in the main tree, `.local/tasks/` outside history:
`current.md` (cards by status), `README.md` (form and rules), `archive.md`. Accepted a task — open a
card; advanced or closed it — update the card in the same pass; before taking a task or pushing —
read `В работе` and `Ждёт`. Otherwise manual deploy steps live in a single session.

**One session — one stage of a task.** At a stage boundary (a wave committed and green; research,
a plan or a review round done; a plan approved) a session commits, updates its card, writes
`.local/handoff-<topic>-<YYYY-MM-DD>.md` and stops. An integrator goes on until its context is
spent, then finishes the item in hand and hands over: [docs/agent-sessions.md](docs/agent-sessions.md).

## What not to do

- create a second registry where a machine one exists (portal sections — `portal-sections.ts`,
  permissions — `permissions.ts`): the map and the index point to them instead of copying;
- edit `docs/adr/README.md` by hand — it is generated;
- add `console.log` to root `scripts/**` (no node globals there in the lint config) — print through
  `process.stdout.write`;
- treat a plan as a description of today's state.
