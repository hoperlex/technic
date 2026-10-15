# ADR 0226. Client floor 7 in one raise for every floor-gated debt, and deploy-auto compares floors before migrations

- Статус: Принято (12.10.2026). Release R1 carries contract 7 and the preflight; the floor
  operation `deploy-auto --client-floor=7` and release R2 (`REQUIRED_CLIENT_FLOOR = 7` and the
  removals) are pending — there is no route to the VPS since 08.10.2026
- Домены: схема-и-выкат
- Развивает: [ADR 0146](0146-office-equipment-consumables-tab-and-purchase.md) decision 7 — the
  client contract gate and its two phases; this decision adds one raise policy and a machine check
  of the precondition that decision 7 left to the operator
- Связано: [ADR 0157](0157-maintenance-mode.md) (the other floor barrier — `--maintenance=on`
  refuses below the served contract), [ADR 0209](0209-waste-stats-three-volumes.md) R5 and
  [ADR 0213](0213-waste-stats-ticket-warnings.md) (deprecated waste statistics fields removed
  "when the floor rises above 6"), plan [auto-part-receipts-plan.md](../auto-part-receipts-plan.md)
  R22–R23 (where `REQUIRED_CLIENT_FLOOR` was born)
- Область: [client-floor.ts](../../apps/api/src/lib/client-floor.ts) (new),
  [client-floor-check.ts](../../apps/api/scripts/client-floor-check.ts) (new),
  [config.ts](../../apps/api/src/config.ts), [package.json](../../apps/api/package.json),
  [clientContract.ts](../../apps/web/src/shared/api/clientContract.ts) (contract 6 → 7),
  [deploy-auto.sh](../../deploy/deploy-auto.sh), [runbook.md](../runbook.md),
  [client-floor-preflight.test.ts](../../apps/api/test/client-floor-preflight.test.ts)

## Context

The client gate (ADR 0146 decision 7) has three numbers, and each lives in a different place:

| Number                  | Where                                | Who changes it                     |
| ----------------------- | ------------------------------------ | ---------------------------------- |
| `CLIENT_CONTRACT`       | the web bundle (`clientContract.ts`) | a release, by hand                 |
| `MIN_CLIENT_CONTRACT`   | `prod.env`, read by `technic-api`    | the operator, `--client-floor=N`   |
| `REQUIRED_CLIENT_FLOOR` | the API code (`config.ts` until now) | a release that removes an old door |

Two orderings hold them together. The floor may not exceed the served bundle's contract, or the
portal answers 426 to everyone — `--client-floor=N` checks that itself. And a release may not
require a floor above the one on production, or its API refuses to start in production. The second
ordering was checked only by the API, at startup, which in `deploy-auto` comes after the dump, after
the migrations and after the old containers are replaced. A forgotten floor operation therefore
looked like this: migrations applied, `technic-api` in a restart loop, the health check red, and
`--previous` bringing back code but not schema. The plan text said "first the floor, then the
release"; nothing executed it before the point of no return.

The floor operation checks both sides too. `--client-floor=N` reads the serving revision from
`release.state` and refuses N below that API's `REQUIRED_CLIENT_FLOOR` before changing `prod.env`:
its forced API recreation would otherwise enter the same restart loop. It reads the R1 module or
the earlier `config.ts` location from that revision, rather than HEAD after a pull. If the serving
requirement is unavailable or its declaration has changed format, the operation refuses; the
operator must inspect the serving release before changing the floor.

By 12.10.2026 several releases had left debts that can be paid only above floor 6: the deprecated
waste statistics fields (`volumeM3`, `volumeOrderedM3`, `totalCost`, `costEstimated`, `confirmed*`,
ADR 0209 R5 and ADR 0213) and other removals planned for release R2. Each of those releases was
served with contract 6, both before and after its portal half landed, so no floor can tell the old
tabs from the new ones. Production runs `dc647215` with contract 6, `REQUIRED_CLIENT_FLOOR = 3` and
an operator floor of at least 4.

## Decision

### 1. One raise to 7 for every floor-gated debt

`CLIENT_CONTRACT` goes from 6 to 7 in release R1, and the raise changes nothing in what the bundle
reads or writes. Its only job is to mark "built after all the portal halves", which 6 cannot mean.
One number for all debts instead of one per debt: each raise costs an operator action on
production and a forced reload of every open tab, and the debts are paid in one release anyway.

The sequence is fixed and each step waits for the previous one to be verified on production:

1. **R1** ships contract 7 with `REQUIRED_CLIENT_FLOOR` unchanged (3). Old tabs keep working.
2. **Floor operation** — `deploy-auto --client-floor=7`, after the contract-7 static is verifiably
   served (`deploy-auto --client-floor` shows both numbers). Tabs older than R1 get 426 and reload.
3. **R2** sets `REQUIRED_CLIENT_FLOOR = 7` and removes the debts.

The promise binds whoever removes a debt in R2: a removal is safe at floor 7 only if the
contract-7 bundle no longer depends on what is removed. A debt whose portal half lands after R1 is
deployed cannot ride on this raise — it needs contract 8 and its own floor operation, or it keeps
the old door. At the time of writing this applies to the mechanization extension (the R1 portal
still calls `PATCH /mech-requests/:id/extend`) and to dropping dates from the wide
`PATCH /vehicle-requests/:id` (the R1 editor still sends the full body, dates included).

_Resolved on 2026-10-12 by two owner decisions._ Survey S-21: both portal halves land in R1,
before its deploy — the mechanization portal moved to `POST/PATCH/DELETE /:id/extension` and no
longer calls `/extend` (ADR 0171, stage 3), and the vehicle editor changes the term through the term
command. Survey S-22: the term command keeps its `waybills.read` gate, so accounts without it
(customer roles) keep editing the term of a «Новая» request through the wide PATCH; R2 drops the
dates from the wide PATCH only for requests in work (ADR 0214). With both, the R2 removals ride on
this single raise.

### 2. deploy-auto asks the candidate image before anything changes

Right after the build — before the captcha preflight, the vhost sync, `--cutover` and the migration
status check — `deploy-auto` runs `check:client-floor` in the candidate image through the `migrate`
service. The check answers the API's own startup question: would `technic-api` of this image start
with the floor `prod.env` holds?

- **Both sides are read as the new API reads them.** The requirement comes from the code about to
  run, not from the working tree or a pattern. The floor comes through the same `env_file` as
  `technic-api` and through the same zod schema (`minClientContractSchema`, shared with
  `config.ts`): an empty or non-numeric value fails there exactly as the API would fail, while the
  shell reader of `--client-floor` (`tr -dc 0-9`) would turn it into a number.
- **The requirement moved to a module without side effects** (`src/lib/client-floor.ts`), because
  `config.ts` validates the whole environment on import and would die on the very mismatch it
  must report. The API startup check now calls the same comparison; it stays as the last line of
  defence.
- **It covers every deploy path** — plain, `--skip-migrate` (the API would not start either) and
  `--cutover`. Rollbacks do not pass through it: they return to code that already ran.

Outcomes and the safe default for each floor state:

| `MIN_CLIENT_CONTRACT` in `prod.env` | Verdict              | Why                                                     |
| ----------------------------------- | -------------------- | ------------------------------------------------------- |
| equal to or above the requirement   | pass                 | the floor only rises; "not below", never "equal"        |
| below the requirement               | refuse (exit code 3) | the API would refuse to start after the migrations      |
| unset                               | judged as 1          | the API reads unset as 1; any other reading mispredicts |
| empty, fractional, non-numeric, 0   | refuse (exit code 3) | the API fails validation and does not start at all      |
| the check gives no answer           | refuse               | nothing has changed yet; passing blindly is the outage  |

A refusal prints the command that will work, chosen by the contract of the bundle served now: if it
already carries the required contract — `deploy-auto --client-floor=N`, then `deploy-auto` again;
if not — the release with the contract must come first, because `--client-floor=N` refuses a floor
above the served contract; if it cannot be read — how to read it and both branches.

An answer is a marker line together with its exit code (`client-floor pass` with 0,
`client-floor refused` with 3). An exit code alone is not enough: `pnpm --filter <pkg> <script>`
exits 0 in silence when the image has no such script, and a bare 0 would pass. The same reasoning
gave `migration-report.ts` its `journal ok` marker.

For R1 the check is a no-op pass: required 3, production floor at least 4.

### 3. A release never requires more than its own bundle carries

A test reads `CLIENT_CONTRACT` from the web source with the very pattern `deploy-auto` uses
(`client_contract_deployed`) and requires `REQUIRED_CLIENT_FLOOR` not to exceed it. Such a release
would answer 426 to its own freshly opened tabs, and the same pattern pinned in a test keeps the
precondition of `--client-floor=N` readable. A second test pins the R1 expectation — this release
passes on the floor confirmed on production (4) — and is meant to fail in R2 until whoever confirms
the floor operation records the new number.

## What remains

- The floor operation and both deploys — blocked by the missing route to the VPS. The preflight has
  never run against the real `migrate` container on the VPS; locally it is covered by running the
  actual `deploy-auto` block under bash with a stand-in for `docker compose`.
- R2: `REQUIRED_CLIENT_FLOOR = 7` with a new `REQUIRED_CLIENT_FLOOR_REASON`, the removals, and the
  confirmed production floor in the test.
- `--client-floor=N` still runs before the deploy lock (known defect, maintenance mode plan §5.1);
  this decision does not move it. Its two checks cannot prevent a concurrent deploy from changing
  the serving release after they run.

## Rejected

- **Reading `REQUIRED_CLIENT_FLOOR` with `sed` from the working tree**, the way
  `client_contract_deployed` reads the contract. Cheap, but it checks a pattern instead of the code
  that will run, and it would read the floor with a different parser than the API.
- **Loading the candidate's whole `config.ts` as the preflight.** It would catch every startup
  failure, not only the floor, but a config error would surface as a stack trace instead of a
  command, and the gate would silently grow to whatever `config.ts` checks next.
- **Raising `REQUIRED_CLIENT_FLOOR` in R1 together with the contract.** The new API would then
  require a floor that the operator may raise only after this very release is served — a release
  that cannot be deployed.
- **A bypass flag for the preflight.** Passing it would deploy an API that does not start; when
  the check itself is broken, the fix is a commit, and the next deploy carries it.
