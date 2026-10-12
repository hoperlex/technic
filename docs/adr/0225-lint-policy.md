# ADR 0225. Lint policy: errors block, warnings are debt, and a cleanup never raises a level

- Статус: Реализовано (12.10.2026). Records stage Э9 of the lint plan after Э8 switched the gate
  on (`48a2570b`). Measured at `17f53f4a`: `eslint .` over 2415 files — 0 errors, 0 warnings
- Домены: качество
- Развивает: [ADR 0147](0147-quality-gates.md) §4 — that decision owns the gate mechanics (lint
  fails `pnpm check` on errors, exit code 2 and an unreadable report are fatal, the count line is
  always printed); this one owns what the levels mean, which rules sit at which level and what
  happens to a rule once its debt is cleaned
- Связано: [ADR 0224](0224-codebase-maintenance-framework.md) — the `release` lint profile adds
  warning-only signals in a separate overlay and leaves this profile untouched; plan
  [lint-debt-plan.md](../lint-debt-plan.md) (decisions Р1–Р7, stages Э1–Э10); the layer rules in the
  same config — [draft frontend architecture](draft-frontend-architecture.md)
- Область: [eslint.config.mjs](../../eslint.config.mjs), [check.mjs](../../scripts/check.mjs),
  [quality.mjs](../../apps/web/scripts/quality.mjs),
  [quality-budget.json](../../apps/web/quality-budget.json)

## Context

ADR 0147 started lint as a counter: on 31.08.2026 the tree had 12 errors and 111 warnings, and a
blocking gate could not have been passed at all. It promised blocking for the day errors reached
zero, and left open what to do with the warnings.

The lint plan measured 2 errors and 117 warnings on 10.09.2026 and cleaned them stage by stage —
the browser global in a screenshot script, `max-lines` scoped to sources, dead test fixtures and
document-generator helpers, type-only imports, effect dependency lists. Stage Э8 switched blocking
on 12.10.2026, and the tree is at 0 errors and 0 warnings.

Switching the gate on leaves three questions that the gate itself does not answer:

- what exactly blocks — "lint errors" is only as meaningful as the choice of which rules are errors;
- what happens to a rule whose class was just cleaned to zero — keep it a warning, raise it to an
  error to hold the zero, or put a counter on it;
- how a deliberately narrow effect dependency list is written now that `react-hooks/exhaustive-deps`
  is at zero and an `eslint-disable` would switch the check off where it matters most.

## Decision

### 1. A rule's level is its meaning, and only the error set blocks

**An error means broken or forbidden code.** A **warning means known debt**, by construction. The
gate (ADR 0147 §4) blocks on the first and never on the second; the level is therefore part of the
rule, not a dial for how strict the gate feels today.

The warning set is exactly four rules (`eslint --print-config` at `17f53f4a`):

| Rule                                           | Where                  | Why it is a warning                                                        |
| ---------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `@typescript-eslint/no-unused-vars`            | everywhere             | dead code is debt; `^_` arguments and variables are ignored (decision 4)   |
| `@typescript-eslint/consistent-type-imports`   | everywhere             | a style of imports, not a defect                                           |
| `react-hooks/exhaustive-deps`                  | `apps/web/**`          | a narrow list is sometimes the point (decision 4); the rule cannot know it |
| `max-lines` (400, without blanks and comments) | `apps/web/src/**` only | a signal; the gate for length is the quality budget (decision 3)           |

Everything else that is on is an error: the error-level rules of `js.configs.recommended` and
`tseslint.configs.recommended` (`no-undef` in plain JavaScript, `@typescript-eslint/no-explicit-any`
and the rest), `react-hooks/rules-of-hooks`, `react/no-unstable-nested-components`, the
`no-restricted-imports` entries (slice entry through `index.ts`; `shared` does not import
`@technic/contracts`), the `no-restricted-syntax` selectors for deprecated antd props, and the
`boundaries/*` layer rules.

Blocking did not wait for zero warnings (plan Р6): ADR 0147 set zero errors as the condition, and
holding the door open for two errors until 117 warnings were gone would have traded protection for
the convenience of cleaning.

### 2. A cleaned class stays a warning, and no counter guards it

The levels of `exhaustive-deps`, `no-unused-vars` and `consistent-type-imports` did not change when
their debt reached zero (plan Р7, the owner's answer of 10.09.2026). The cleanup was one-off by
choice:

- **raising a cleaned rule to error** was rejected: it is a demand on people rather than on code,
  and with blocking lint it would stop the author of a new window at a red `pnpm check` in the
  middle of work;
- **a ratchet over the counts** was rejected twice: a counter that allows `N > 0` legitimises debt
  by a number nobody argues with any more, and the frozen file would have to change in every stage,
  becoming a contention point of the same kind as `quality-budget.json`.

The consequence is accepted as such: the only guard for warnings is the count line that
`pnpm check` prints (`линт: N ошибок, M предупреждений`), read by a person. With the tree at zero,
any number there is new. A future cleanup will be manual again.

**Changing a level is changing this decision**, recorded by a new ADR that amends this one, not an
edit to `eslint.config.mjs` on the way. The front-end layering plan intends exactly that for
`max-lines` at its closing stage (roadmap item Q11).

### 3. `max-lines` warns in lint; length is gated by the quality budget

`max-lines` has its own config block on `apps/web/src/**` only (plan Р2): a test is a linear script
read top to bottom, and the reason behind the threshold does not apply to it. A separate block, not
a narrower React block, so that the hook rules still cover the tests.

The two measures of length stay different on purpose (plan Р3): lint counts without blank lines
and comments, the budget in `quality.mjs` counts raw lines, with the same threshold of 400.
Comments are where this repository records its decisions, and a length rule that punished them
would reward deleting them. The budget is therefore strictly stricter than lint, and it is the gate:
`pretest` fails on a new file over the limit. Its `maxLines` list is empty today.

### 4. A narrow effect dependency list is written with `useEffectEvent`, the key passed as an argument

When an effect must re-run on a key but read other values fresh — a form reset per opened record
that must not wipe what the user typed when the same record arrives as a new object — the body
moves into an effect event and **the effect itself reads the key and passes it in** (plan Р4, fixed
by Э6а `1e9da4d6`):

```tsx
const resetForRequest = useEffectEvent((_id: string | null) => {
  setVersion(request.version);
  form.resetFields();
});
useEffect(() => resetForRequest(targetId), [targetId]);
```

- **The key must stay in the effect.** The first form moved the whole body into the event and left
  the effect a bare call; the dependency list became decoration and removing the key from it was
  silent. The proof of the technique is negative: remove the key from the list, lint must report
  the missing dependency, put it back.
- **The parameter starts with `_`.** The event body does not read it; it exists for the effect.
  `no-unused-vars` ignores `^_` arguments, so without the prefix the technique trades one warning
  for another.
- **Effects only.** An effect event may be called only from an effect, and `rules-of-hooks` reports
  any other call as an error; a `useMemo` with a "missing" dependency gets an honest dependency
  instead.

19 effect events in 17 files use this form today. A disable directive for
`react-hooks/exhaustive-deps` is left for a place where the technique does not apply, with the
reason in the comment above it. The 12 such directives in 11 files predate the plan; they are
recorded narrow lists rather than debt, and converting working windows for uniformity is not this
policy's business.

### 5. A one-file exception lives in the file, not in the config

When a single file needs a global the environment of its block does not have, the file declares it
(plan Р1): `docs/capture-request-guide-screenshots.mjs` carries `/* global document */` with the
reason — `page.evaluate` bodies run in the browser — instead of `globals.browser` for all of
`docs/**/*.mjs`. Widening the block would let a stray `window` in a Node script pass silently, and
a config block for one file would separate the exception from the code that explains it. The block
keeps the whole `globals.node` set because a hand-kept list of names always lags behind the code.

## What remains

- **The shared db-test fixture** (plan Э10, roadmap item Q13) is deferred. It is not a lint problem —
  lint only saw the dead copies — but the same `prepareEnv` set-up copied into each db test.
  Measured at `17f53f4a`: 175 of 234 `*.db.test.ts` files declare their own `prepareEnv`, all of
  them called (the plan counted 146 live copies on 10.09.2026).
- **No guard for cleaned classes** — accepted in decision 2.
- **The 12 pre-plan `exhaustive-deps` disables** — kept in decision 4.

## Rejected

- **Raising cleaned rules to error** and **a ratchet over warning counts** — decision 2.
- **Blocking only once warnings reach zero** — decision 1.
- **`eslint-disable` as the way to write a narrow dependency list** — it turns off the half of the
  check that would catch a real missing dependency added to the same effect later.
- **`globals.browser` for the whole `docs/**/*.mjs` block** — decision 5.
- **Aligning the two length measures** — either comments start costing length, or part of the long
  files leaves the budget's ratchet.
