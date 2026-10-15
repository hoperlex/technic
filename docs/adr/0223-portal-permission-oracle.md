# ADR 0223. The portal asks the server's permission list, never the contracts matrix

- Статус: Реализовано (12.10.2026, roadmap item Q6). The three checks ask the server's list, a
  lint rule keeps direct matrix readers out of `apps/web/src`, and a per-profile test pins the
  touched screens to the server's answer; the internal predicate readers named in the initial
  [Implementation](#implementation-12102026) were converged in the [follow-up](#follow-up-15102026)
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
  [serviceRequestExtras.tsx](../../apps/web/src/pages/service/serviceRequestExtras.tsx),
  [serviceRequestModals.tsx](../../apps/web/src/pages/service/serviceRequestModals.tsx),
  [permissions.ts](../../packages/contracts/src/permissions.ts),
  [mech-requests.ts](../../packages/contracts/src/mech-requests.ts),
  [vehicle-requests.ts](../../packages/contracts/src/vehicle-requests.ts),
  [service-requests.ts](../../packages/contracts/src/service-requests.ts),
  [eslint.config.mjs](../../eslint.config.mjs),
  [permission-oracle.test.ts](../../apps/web/test/permission-oracle.test.ts)

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
- Contract predicates that ask the matrix inside the contracts over the subject they are handed
  were matrix readers in the initial portal implementation; the
  [follow-up](#follow-up-15102026) passes `can` to them as well.

## Rejected alternatives

- **Keep both oracles because they agree by construction.** They agree only while the bundle and
  the API come from one build, and nothing on the portal side checks it; the deploy window is
  exactly when they do not.

## Implementation (12.10.2026)

Roadmap item Q6, implemented on top of `40a04c7f`.

**The three checks.** Each contract predicate keeps its rule and receives the membership as a
parameter `has: (permission) => boolean`, defaulting to the matrix over the subject — the server
calls it unchanged, the portal passes its `can`:

- the vehicle request calendar (`vehicleRequestDateRules(subject, can)`) asks `waybills.correct`
  and `waybills.correctBeyondLimit` of `can`, and passes `can` into `minVehicleRequestDateKey` →
  `isVehicleRequestRequester`: the lead time's `vehicleRequests.status` was a fourth matrix read in
  the same calendar, not named above;
- the mechanization row menu asks `mechRequests.status`, `.create`, `.update` and `.delete` of the
  `can` it already received for the extension visa, and passes it to `canApproveMechRequest`;
- `serviceGridView(user, can)` asks `serviceRequests.create` and `serviceRequests.estimate` of
  `can` and passes it to `actsAsServiceExecutor` → `isServiceExecutor`, whose
  `serviceRequests.estimate` and `serviceRequests.execute` were the hidden half of the same column
  choice.

Two more direct imports of `can` turned up in the office equipment request menu (rolling back
«taken into work», consumables, the issue mark, urgency, moving the equipment). The guard below
would have failed on them, so they moved too: `ServiceMenuContext` carries the portal's `can`.

**The guard** is lint, not a scan: `@typescript-eslint/no-restricted-imports` in `eslint.config.mjs`
forbids importing `can`, `canUse` and `permissionsFor` from `@technic/contracts` anywhere under
`apps/web/src`. The typescript-eslint copy of the rule is used because the core rule already
carries the slice entry-point patterns there, and a flat config replaces a rule's options instead
of merging them. Exceptions are by file and by name (`MATRIX_READER_EXCEPTIONS`): `canUse` in
`authContext.tsx`, the scope half of the portal's own `canUse`; `can` and `permissionsFor` in the
four administration modules that describe other accounts and the access profiles. Lint was chosen
because the import is the cheapest moment to catch the rule being broken and the editor shows it
on the line; a call to the matrix `can` reads exactly like a call to the portal's.

**The test.** Decision 3's equality of the matrix and the list per profile was already guard G1
(`apps/api/test/auth-session-permissions.test.ts`): the session builder returns `permissionsFor`
of the full subject and ships that same subject beside the list, so for every profile the matrix
over the shipped subject is the list. What the portal does with it is pinned by
`apps/web/test/permission-oracle.test.ts`:

- the rule is live on the root config (each reader, an alias and a namespace import are errors;
  an exception opens only its own name), and every exception still imports the name it is
  allowed, read from the config itself;
- for every access profile plus every catalogue grant on a compatible role, the calendar, the
  mechanization menu, the column set and the office equipment items around a request show with
  the portal's `can` over the shipped list exactly what the server's oracle answers;
- the same screens on an account the matrix cannot read — grant permissions stripped from the
  subject, kept in the list, one permission added at a time over each profile — still equal the
  server's answer on the full principal, and a sensitivity check proves that recomputing the matrix
  over the shipped subject would differ on every one of the four screens. Reverting any of the
  four places to the matrix fails this sweep (checked by hand on each).

**Residual after the initial Q6 wave.** About seventeen contract predicates the portal calls with the session user still
ask the matrix inside the contracts: the status corridors (`allowedStatusTransitions`,
`allowedVehicleRequestTransitions`, `allowedServiceStatusTransitions`), the office equipment action
predicates (`canStartServiceWork`, `canAssignServiceExecutors`, `canDeclineServiceRequest`,
`canResumeService`, the estimate and dispute predicates, `canCoordinateServiceRequests`, the bulk
operations, `attachableServiceFileKinds`) and the waiting-on badge (`isWaitingOn`). They are not
imports of a matrix reader, so the guard does not see them, and the blind sweep leaves the
mechanization corridor (`status:*` items) out. They agree with the server because the session
builder ships the whole subject beside the list (guard G1), and each moves to `has` the same way
when its screen is next touched.

## Follow-up (15.10.2026)

The residual matrix reads identified above now receive the portal's `can` over
`AuthUser.permissions`: the request status corridors, service request action and estimate
predicates, bulk admission and operation rights, document kinds, coordinator hints, and
waiting-on labels and badge. The contract predicates still own the status and scenario rules;
`has` defaults to the matrix for API callers. The portal supplies `can` at every session-user
call site, including nested predicates such as `canHoldService`, `isServiceExecutor`, and
`canAttachServiceFileSide`. The matrix-blind sweep in `permission-oracle.test.ts` now covers the
mechanization corridor and the additional service request surfaces.

Server-only predicates such as `serviceRequestAudienceOf` continue to use the matrix over the
server principal. A future portal call to one of those functions must pass the server-list
membership before it is used for permission-dependent availability.
