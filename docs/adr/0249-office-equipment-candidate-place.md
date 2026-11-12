# ADR 0249. Office equipment: candidate location and temporary access to any object for departments

- Статус: Принято
- Домены: оргтехника, доступ
- Изменяет: [ADR 0165](0165-office-equipment-candidate.md) — the consequence «Отдел без
  закреплённых площадок сообщить о технике не может» and the department branch of Р7 in the
  [candidate plan](../office-equipment-candidate-plan.md): departments temporarily may report a
  device on any existing object
- Связано: [ADR 0062](0062-department-object-link.md),
  [ADR 0144](0144-department-objects-set.md),
  [ADR 0201](0201-department-special-equipment.md) (the department's derived place axis),
  [ADR 0077](0077-release-notes.md) and [ADR 0191](0191-version-numbering.md) (release entry)
- Область: contracts — [service-requests.ts](../../packages/contracts/src/service-requests.ts);
  API — [service-requests.ts](../../apps/api/src/routes/service-requests.ts); portal —
  [ReportEquipmentModal.tsx](../../apps/web/src/features/missing-equipment/ui/ReportEquipmentModal.tsx),
  [object queries](../../apps/web/src/entities/object/api/queries.ts),
  [object exports](../../apps/web/src/entities/object/index.ts),
  [usePlaceObjectScope.ts](../../apps/web/src/entities/session/model/usePlaceObjectScope.ts);
  tests —
  [candidate object choice](../../apps/api/test/candidate-object-choice.test.ts),
  [candidate intake](../../apps/api/test/service-request-candidate-intake.db.test.ts),
  [missing equipment](../../apps/web/test/missing-equipment.test.tsx)

## Context

The required «Где стоит» field in «Сообщить об аппарате» can have no options, preventing a
requester from reporting a device missing from the equipment directory. The owner approved the
choice changes on 2026-11-12 and clarified that the wider choice for departments is temporary.
Department data, including their links to sites, is incomplete, and the construction-object
directory is incomplete. Restricting reports to those links currently prevents people from
stating where a device actually stands.

Four rules explain the reported failure and the differences between the portal and the server:

1. A department without linked sites gets an empty list. ADR 0165 and Р7 of the candidate plan
   deliberately required a department's own site; this decision temporarily relaxes that rule.
2. An object role cannot name a foreign object. This restriction protects the author's access to
   the resulting request and stays in force unless the subject has module-wide scope.
3. The portal hides inactive objects, although the server checks existence only: a closing site
   can still hold devices that need service.
4. The portal narrows by role even when `canPickAnyServiceSubject` gives the subject module-wide
   `officeEquipment` scope. The server already honours that scope.

## Decision

### 1. Keep the candidate-location rule in contracts

`candidateObjectChoice` in `packages/contracts/src/service-requests.ts` defines the allowed object
IDs and the subject's own objects for display priority. `canPlaceCandidateOn` asks that same choice
for a supplied ID. Both `resolveCandidateObject` and the reporting window use these predicates;
separate role branches allowed the offered and accepted values to drift.

A missing subject has no allowed objects. `canPickAnyServiceSubject` is checked before role scope
and allows any existing object. Object roles without that scope may name only their
`constructionObjectIds`. Department roles temporarily may name any existing object, with their
`departmentObjectIds` offered first. Other roles continue to name any existing object. The server
still checks that the supplied object exists.

The predicates belong next to `canPickAnyServiceSubject`: importing service-request rules from
`office-equipment-candidates.ts` would create a dependency cycle.

### 2. Include inactive objects

The window loads active and inactive objects so that it offers the values the server already
accepts. An inactive object's label ends with «(неактивен)»; active objects precede inactive ones
within each group. The existing name order is preserved otherwise.

### 3. Honour module-wide scope in the window

An administrator or any subject for whom `canPickAnyServiceSubject` is true gets the whole
existing object directory, regardless of role. Its own place-axis objects, when present, come
first. This also applies to holders of the «Согласование ИТ» set.

### 4. Temporarily allow departments to report a device on any existing object

For `department` and `department_head`, allowing any existing object is a **temporary, forced
workaround for incomplete department data and an incomplete construction-object directory**.
Department-to-site links currently cannot serve as a reliable restriction for reporting the
physical location of a missing device. Their own linked sites remain useful as suggestions and
are shown first under «Площадки вашего отдела»; the remaining objects follow under «Другие
объекты». Groups appear only when both contain options. A wider-scope object role uses «Ваши
объекты» for its own group. Otherwise the list is flat.

The person states the place explicitly. No preferred site is preselected; the existing sole-option
autofill remains. A missing directory record still cannot be selected: this workaround only widens
the choice among existing objects and does not complete either directory.

Review this exception after department data and their site links have been completed and checked,
and the object directory covers actual device locations. Record the resulting access rule in a
follow-up ADR before narrowing or replacing the exception; data cleanup alone does not restore
the former restriction. The shared predicate, inactive-object support and module-wide scope remain
independent of this temporary department exception.

### 5. Keep object roles restricted to their own objects

Without module-wide scope, `shtab`, `rukstroy`, `commandant` and `site` still may name only their own
objects, including inactive ones. Their request visibility follows `equipment_object_id`; allowing
a foreign object would hide the created request from its own author. The field error remains
`equipmentCandidate.objectId: Чужой объект` with HTTP 422.

## Consequences

- A department can report a device at a site outside its current links, including when it has no
  linked sites. The request keeps the author's own `customer_department_id`, so the author keeps
  access through the department axis.
- A candidate on a foreign site enters that site's object-role reviewer queue and the mail that
  mirrors that queue. The site's object roles also see the request through `equipment_object_id`.
  The owner accepts both consequences because the declared site is the device's physical location.
- Department and object directory cleanup remains necessary. Its completion triggers review of
  the temporary department exception rather than silently making that exception permanent.
- No schema or data migration is needed for this rule; implementation ships with the release-entry
  migration required by ADR 0077 and ADR 0191.
- No client-floor raise is needed: the server only widens accepted values, and older portal builds
  keep submitting a valid subset.

## Not changed

The «Аппарат стоит на другом объекте» mark (`resolveEquipmentObject`) keeps its department
restriction. Whether it should follow the same rule is a separate owner decision. Reviewer
permissions, request-visibility predicates and mail audiences are unchanged.
