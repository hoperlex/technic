import { isCounterpartyScopedRole, isDepartmentScopedRole, isObjectScopedRole } from './enums';
import { can, type Permission } from './permissions';
import { visaLimitedToApprovalDepartments, type VisaSubject } from './visa-scope';

/*
 * The request visa circle of mechanization (visa plan `docs/mechanization-approval-and-grants-plan.md`,
 * R1–R6; ADR 0171 decision 4). A leaf module of its own, re-exported by `mech-requests.ts`, because
 * two rule files ask it: the request visa there, and the lessor receipt's decisions
 * (`mech-lessor-receipts.ts`, plan `docs/mechanization-lessor-receipt-plan.md`, P5). The receipt
 * file must not import `mech-requests.ts` at runtime — `mechTransitionBlocker` imports the receipt's
 * completion gate, and the reverse import would close a cycle and drag the whole module's rules
 * after the receipt into every chunk that asks the gate.
 */

/**
 * The subject asking about a visa: permissions plus every scope a visa is compared with. A plain
 * `ScopedSubject` does not fit — it lacks `departmentIds`, which answer "did this department file
 * the request", and the visa departments of an axis-less role (ADR 0245). The server principal and
 * the portal's current user both fit as they are.
 */
export type MechApprovalSubject = VisaSubject;

/** The sides of the request the visa is computed by: the site and the optional department requester. */
export interface MechApprovalTarget {
  objectId: string;
  departmentId: string | null;
}

/**
 * May the subject sign the site visa of this rental (visa plan, R5): the visa permission plus the
 * subject's own side of the request.
 *
 * **One function for the portal and the server** — otherwise the item would appear where the
 * handler answers 403.
 *
 * The module is built differently from the vehicle order, so `canApproveRequest` does not fit here.
 * There the customer is an object **or** a department (`num_nonnulls(object_id, department_id) =
 * 1`), and the role's axis picks unambiguously what to compare. A rental ALWAYS has a site, while
 * the department is an optional requester on top of it, and both columns are often filled at once:
 * that is the customer's answer «the site or the department head, whoever is first».
 *
 * The branch goes **by the role's axis**, not by the disjunction «object matched OR department
 * matched». A department role has a derived list of sites (`departmentObjectIds`, ADR 0062/0144),
 * and asked by it the department head would sign requests filed by the SITE ITSELF, which his
 * department never filed. So the department branch needs both halves: his department filed the
 * request AND the site is attached to the department now. A request with an empty `departmentId`
 * stays unsignable for him — the second branch has nothing to compare.
 *
 * **An executor never signs** (lessor receipt plan, P5). The executor role has no axis of this
 * module, so without its own branch it would fall through to the administrator's "not limited by
 * anything" — today unreachable only because no executor can hold `mechRequests.approve` (the type
 * list lacks it, the grant matrix refuses every `mechRequests.*` to the executor role). Mechanization
 * lessors log in from the receipt release on, and the visa of a rental must not depend on a list
 * staying short: the lessor would otherwise approve his own receipt.
 *
 * `has` answers the permission, as in `canApproveMechExtension`. The server leaves the default (the
 * matrix over its own principal is exactly what it builds the session list with); the portal passes
 * its `can`, which reads the list the server computed (ADR 0223) — the scope rule stays here, the
 * permission comes from one oracle.
 */
export function canApproveMechRequest(
  subject: MechApprovalSubject | null | undefined,
  row: MechApprovalTarget,
  has: (permission: Permission) => boolean = (permission) => can(subject, permission),
): boolean {
  if (!has('mechRequests.approve')) return false;
  const role = subject?.role;
  if (isCounterpartyScopedRole(role)) return false;
  if (isObjectScopedRole(role))
    return (subject?.constructionObjectIds ?? []).includes(row.objectId);
  if (isDepartmentScopedRole(role)) {
    return departmentsOwnMechRequest(subject?.departmentIds, subject?.departmentObjectIds, row);
  }
  // An axis-less role whose visa came from a grant signs as the department head (ADR 0245, owner
  // decision 05.11.2026): its visa department filed the request AND the site is attached to it.
  if (visaLimitedToApprovalDepartments(role, 'mechRequests.approve')) {
    return departmentsOwnMechRequest(
      subject?.approvalDepartmentIds,
      subject?.approvalDepartmentObjectIds,
      row,
    );
  }
  // A role whose matrix carries the visa (administrator) is not limited by anything.
  return true;
}

/**
 * Both halves of the department branch: the department filed the request AND the site is attached
 * to it now. A request with an empty `departmentId` is never the department's to sign.
 */
function departmentsOwnMechRequest(
  departmentIds: readonly string[] | undefined,
  departmentObjectIds: readonly string[] | undefined,
  row: MechApprovalTarget,
): boolean {
  return (
    !!row.departmentId &&
    (departmentIds ?? []).includes(row.departmentId) &&
    (departmentObjectIds ?? []).includes(row.objectId)
  );
}
