# ADR 0245. «Виза отдела» on a manager: a grant-given visa of an axis-less role acts within visa departments

- Статус: Реализовано (05.11.2026); not deployed
- Домены: доступ, заказ-тс, механизация
- Изменяет: [ADR 0025](0025-vehicle-request-approval.md), [ADR 0040](0040-department-scope.md)
  — "a role without an axis signs everything" stops being true for a visa that comes from a grant;
  it stays true for the administrator, whose matrix row carries both visas
- Развивает: [ADR 0201](0201-department-special-equipment.md) — the department head's answer (orders of
  the department and of its sites) is reused as is for the visa departments of an axis-less role;
  [ADR 0223](0223-portal-permission-oracle.md) — the vehicle visa predicate moves into contracts and
  takes the server's permission list, as the mechanization one already did
- Связано: [ADR 0032](0032-approval-not-automatic-for-admin.md) (no auto-visa for a role without a
  subdivision), [ADR 0181](0181-manager-service-requester.md) (the `manager` role is
  temporary: its trace in code must leave with it)
- Область: [scope rule](../../packages/contracts/src/visa-scope.ts),
  [grant](../../packages/contracts/src/grants.ts),
  [mechanization predicates](../../packages/contracts/src/mech-requests.ts),
  [server visa](../../apps/api/src/lib/access.ts),
  [visa endpoint](../../apps/api/src/routes/vehicle-requests.ts),
  [storage](../../apps/api/src/services/user-scopes.ts),
  [account routes](../../apps/api/src/routes/users.ts),
  [migration](../../apps/api/drizzle/0410_user_approval_departments.sql),
  [account form](../../apps/web/src/features/user-account-editor/ui/UserApprovalDepartmentsField.tsx)

## Context

The owner asked (05.11.2026) that two managers sign vehicle and mechanization requests for one
department and keep every manager right. The model could not express it:

- a visa is a permission plus a scope. `canApproveRequest` and `canApproveMechRequest` compare the
  request with the role's axis; a role without an axis (`roleScopeAxis = 'none'`) got `true` —
  written for the administrator. Any visa a manager received was therefore company-wide;
- a manager cannot hold departments: the department axis is emptied for non-department roles, and
  giving it to him would change his visibility, mail audiences and the department card;
- «Виза отдела» (`department_approval`) was compatible with the role `department` only;
- changing the role would lose the manager rights, and `department_head` is retiring.

Rejected by the owner: a custom company-wide visa set for managers, and a second account per person.

## Decision

1. **«Виза отдела» is compatible with `manager`** (`ROLE_GRANTS.department_approval.roles`, migration
   0410 inserts the `grant_roles` row — the grant gate reads the table, not the contract). The
   composition is unchanged: `vehicleRequests.approve`, `mechRequests.approve`.
2. **One rule for a grant-given visa of an axis-less role.** If the role has no axis and its matrix
   row does not carry the visa permission (`visaLimitedToApprovalDepartments`), the visa acts only
   within the account's **visa departments** and the sites attached to them — exactly the
   department head's answer: vehicle orders whose customer is such a department or such a site;
   mechanization rentals filed by such a department on a site attached to it; never an extension.
   Derived from the matrix and the axis, not from a role name: the administrator is unchanged, and
   a custom visa grant given to another axis-less role is limited the same way instead of silently
   becoming company-wide.
3. **Visa departments are a separate storage** (`user_approval_departments`), not `user_departments`.
   They are not a scope axis: the manager keeps company-wide visibility and is not a department
   member. And the account form before this release sends `departmentIds: []` for every axis-less
   role; sharing the table would let an edit from an old tab wipe the visa. The new field is absent
   from old bodies, and absent means "keep".
4. **The visa itself stays optional; once held, a visa department is required** (owner decision
   05.11.2026). The form shows «Отделы визы» — one department per row, a «+» button for the next —
   when a checked grant gives such a visa; the server refuses an account edit and a point assignment
   from the registry that would leave the visa without a department.
5. **The visa endpoint asks the visa predicate.** `PATCH /vehicle-requests/:id/approval` checked only
   the request scope, which equals the visa scope for object and department roles but passes every
   row for an axis-less role. It now also asks `canApproveRequest`.
6. **The portal asks per row.** The vehicle visa predicate moved into contracts
   (`canApproveVehicleRequest`); «Согласовать», the early-end decision and the warning "the edit
   drops the visa" ask it with the server's permission list. The session carries the visa
   departments and their sites.
7. **No auto-visa** for these accounts (ADR 0032): `approvesOwnRequestOnCreate` stays
   `isPlaceScopedRole && …`, so a manager's own request waits for a visa like the administrator's.

## Consequences

- Production has no custom visa grants held by managers or dispatchers (owner, 05.11.2026), so the
  rule narrows nobody today.
- Changing the visa departments revokes the holder's tokens; so does changing the sites of a visa
  department (`markDepartmentScopeChanged`).
- Old bundles show «Согласовать» on foreign rows to a manager with the visa and get a 403 —
  accepted, no client floor raise. The new field is optional in the session DTO, so a portal newer
  than the server reads its absence as "no visa departments".
- Deploy window: the migration is additive; between it and the restart an administrator must not
  grant «Виза отдела» to a manager — the old server would read it as company-wide.
- The cleanup trace for the day `manager` is removed is the `Role`-typed entry in
  `ROLE_GRANTS.department_approval.roles` and the `grant_roles` row; the scope rule itself names no
  role.
