# The machine layer of the architecture

This directory holds what the codebase maintenance system reads as RULES: the module map, decision
policies, protected areas, exceptions and maintenance budgets. All of it is the desired state of the
project, so it is versioned together with the code. The derived state of a run (facts, findings,
agent assignments, snapshots, reports) lives in `.maintenance/` and stays out of history.

The main rule of this directory: **it does not start second registries**. Domains and their
contents are described by the code map `docs/code-map.md`, portal layers by `eslint.config.mjs`,
permissions by `permissions.ts`, sections by `portal-sections.ts`. Files here refer to them and name
who enforces a rule (`enforcedBy`), but do not copy their contents: a copy of a rule diverges from
the original silently.

- `modules.yaml` — the monorepo level: packages, allowed directions, public entry points. What the
  linter already guards is not repeated here.
- `policies/architecture.yaml` — the machine part of decisions: where each applies, how strictly
  (`hard` / `soft` / `advisory`), whether it may be fixed automatically.
- `policies/protected-surfaces.yaml` — areas where an automatic change is forbidden or needs a human.
- `policies/exceptions.yaml` — deliberate exceptions with a reason and a review date.
- `policies/maintenance.yaml` — budgets and stop conditions of the cycles.
- `policies/versioning.yaml` — release version rules ([ADR 0191](../docs/adr/0191-version-numbering.md));
  the only file here the maintenance system does NOT read: `scripts/check-version.mjs` enforces it.
  It lives here because it is a machine rule of the project as well.

Statement and stages — [docs/maintenance-framework-plan.md](../docs/maintenance-framework-plan.md),
working procedure — [docs/maintenance-guide.md](../docs/maintenance-guide.md).
