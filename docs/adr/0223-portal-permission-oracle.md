# ADR 0223. The portal asks the server's permission list, never the contracts matrix

- Статус: Принято (12.10.2026). The rule already holds for the shell and almost every action; three
  checks still recompute the matrix, and moving them to the list with a guard test is pending
  (roadmap item Q6)
- Домены: доступ, каркас-портала
- Изменяет: [ADR 0021](0021-permissions-model.md) (decision 2) — the portal no longer hides what
  is unavailable «по той же таблице»: it hides it by the list the server computed from that table
- Развивает: [ADR 0106](0106-assignable-permission-grants.md) — the session carries the server's
  list because sets assembled in production are unknown to the matrix; this decision makes the list
  the portal's only permission oracle and names the remaining exceptions
- Связано: [ADR 0165](0165-office-equipment-candidate.md) (candidate intake — the first predicate
  converged to the list), [access model §10](../access-model.md) (the portal takes permissions
  from the server)
- Область: [authContext.tsx](../../apps/web/src/entities/session/model/authContext.tsx),
  [intake.ts](../../apps/web/src/entities/office-equipment-candidate/model/intake.ts),
  [dateRules.ts](../../apps/web/src/entities/vehicle-request/model/dateRules.ts),
  [mechRequestMenu.tsx](../../apps/web/src/pages/mech/mechRequestMenu.tsx),
  [serviceRequestGrid.tsx](../../apps/web/src/pages/service/serviceRequestGrid.tsx),
  [permissions.ts](../../packages/contracts/src/permissions.ts)

## Context

The portal can answer «does this account hold permission P» in two ways.

- **The server's list.** Every session response carries `AuthUser.permissions`, which the API's
  session builder `makeAuthUser` fills with `permissionsFor(subject)`. The portal's `can` and
  `canUse` (`permissionChecks` in `authContext.tsx`) read that list; `canUse` adds the scope rule
  of the contracts on top of the same membership.
- **The contracts matrix.** `can(subject, P)` from `packages/contracts/src/permissions.ts`
  recomputes the answer from the subject the server ships beside the list — role, addons and
  `grantPermissions`, the last one carrying the composition of sets assembled in production.

Today both give the same answer, because the server builds the list with the same matrix over the
same subject. On the portal side that agreement is held by convention, not by a type or a test,
and two carriers of one rule drift silently. The drift also has a direction: inside a deploy window
the bundle is newer than the running API, and a matrix that already knows a permission the server
does not yet grant opens a door with a 403 behind it.

Commit `440f8d26` (29.09.2026) converged the first case: candidate intake
(`candidateIntakeAccess`) now receives the portal's `can` as a parameter instead of calling the
matrix. Three places still ask the matrix with the session user:

- `apps/web/src/entities/vehicle-request/model/dateRules.ts` — `waybills.correct` and
  `waybills.correctBeyondLimit` decide how far back the request calendar opens;
- `apps/web/src/pages/mech/mechRequestMenu.tsx` — the visa item asks `canApproveMechRequest`,
  whose first check is the matrix `can(subject, 'mechRequests.approve')`;
- `apps/web/src/pages/service/serviceRequestGrid.tsx` — `serviceGridView` asks
  `serviceRequests.create` and `serviceRequests.estimate` to choose the column set.

## Decision

1. **Permission-dependent availability in the portal is decided by the server's list.** Membership
   is asked through the portal's `can`, or `canUse` where the scope matters, and never by running
   the contracts matrix over the session's subject. The matrix stays what the server computes the
   list with, and the source of the scope rule that `canUse` asks for scope only.
2. **Contract predicates stay the one place of their rules** — status corridors, scope, lead time.
   When such a predicate needs a permission, the portal supplies the membership from the server's
   list, as `candidateIntakeAccess` takes `can` as a parameter: the predicate keeps its rule, and
   the permission comes from one oracle. How each of the three remaining places gets it is the
   implementation's choice; the answer it shows must be the server's.
3. **The three remaining checks move to the server's list, guarded by a test.** A test checks, for
   every access profile (`ACCESS_PROFILES`), that the matrix over the profile's subject and the
   list the server builds for it give the same permissions. While a matrix reader is left in the
   portal, a drift is caught by that test and not by a 403 in production. The server's own half —
   the session builder returns exactly `permissionsFor` of the full subject — is pinned separately
   by guard G1 (roadmap item Q2).

## Consequences

- A new portal check that imports `can` from `@technic/contracts` and passes it the session user
  breaks this rule. The import itself stays legitimate: scope (`scopedCanUse`) and rules that are
  not permissions still come from the contracts.
- Test fixtures describe an account the way production delivers it: with its `permissions` list.
  The render harness already builds the context with the same `permissionChecks`
  (`apps/web/test/render.tsx`), so a fixture with a role and no list reads as «no permission».
- Until item Q6 lands, the three places above keep the matrix and its agreement with the list
  stays a convention. This record names them so that the debt is not mistaken for the rule.

## Rejected alternatives

- **Keep both oracles because they agree by construction.** They agree only while the bundle and
  the API come from one build, and nothing on the portal side checks it; the deploy window is
  exactly when they do not.
