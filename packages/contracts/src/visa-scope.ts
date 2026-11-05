import { isDepartmentScopedRole, isObjectScopedRole, type Role } from './enums';
import { roleScopeAxis } from './grant-scope';
import { can, ROLE_PERMISSIONS, type Permission, type ScopedSubject } from './permissions';

/*
 * Scope of a visa that a role without its own axis receives from a grant (ADR 0245).
 *
 * A visa is a permission plus a scope: the site signs its own objects, the department its own
 * departments and their sites. A role without an axis (`roleScopeAxis = 'none'`) had no scope to
 * compare with, and every predicate answered `true` for it — meant for the administrator, whose
 * matrix row carries both visas. Once «Виза отдела» became grantable to the manager, that `true`
 * would have made a department visa company-wide.
 *
 * The rule is written once, here, and asked by both sides: the server (`canApproveRequest`,
 * `canApproveMechRequest`, `canApproveMechExtension`) and the portal (the «Визировать» button per
 * row). A copy on the portal would show the button on rows the server refuses.
 *
 * This module is deliberately separate from `vehicle-requests.ts`: that file sits in the portal's
 * entry chunk, and a predicate only the request screens need would grow every bundle point.
 */

/** The visa permissions whose scope this module answers. Weekly visa is not grantable this way. */
export const VISA_PERMISSIONS = [
  'vehicleRequests.approve',
  'mechRequests.approve',
] as const satisfies readonly Permission[];
export type VisaPermission = (typeof VISA_PERMISSIONS)[number];

/**
 * Is this visa limited to the account's visa departments (ADR 0245): the role has no axis of its
 * own AND its matrix row does not carry the permission — so whatever gives it is a grant.
 *
 * Asked per permission, not per role: a role may hold one visa from its matrix (company-wide by
 * design, like the administrator) and the other from a grant. The administrator never falls here —
 * the matrix gives him both — so his answer stays exactly what it was.
 *
 * Derived from the matrix and the axis, not from a list of role names: the day the temporary
 * `manager` role is removed, nothing here needs cleaning, and a custom visa grant given to another
 * axis-less role is limited by the same rule instead of silently becoming company-wide.
 */
export function visaLimitedToApprovalDepartments(
  role: Role | null | undefined,
  permission: VisaPermission,
): boolean {
  if (!role) return false;
  return roleScopeAxis(role) === 'none' && !ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * May the account carry visa departments at all: some visa would be limited by them. Other roles
 * get an empty set, the same way `resolveDepartmentIds` empties the department axis of non-department
 * roles — a link that limits nothing would read in the account card as a working restriction.
 */
export function acceptsApprovalDepartments(role: Role | null | undefined): boolean {
  return VISA_PERMISSIONS.some((permission) => visaLimitedToApprovalDepartments(role, permission));
}

/**
 * Does the account need at least one visa department (owner decision 05.11.2026): it holds a visa
 * that only visa departments make effective. Without one the grant would be issued and give nothing,
 * and the administrator would believe the access exists.
 *
 * Takes the effective permission list after the operation, so the answer covers every source a
 * visa can come from — a grant from the account form and a point assignment alike.
 */
export function needsApprovalDepartments(
  role: Role | null | undefined,
  permissions: Iterable<Permission>,
): boolean {
  const held = new Set(permissions);
  return VISA_PERMISSIONS.some(
    (permission) => held.has(permission) && visaLimitedToApprovalDepartments(role, permission),
  );
}

/** Refusal and field hint: one text for the server and the account form. */
export const APPROVAL_DEPARTMENTS_REQUIRED_MESSAGE =
  'Виза действует в пределах отделов визы — укажите хотя бы один отдел';

/**
 * The subject asking about a visa: permissions plus every scope a visa can be compared with. Both
 * the server principal and the portal's current user fit as they are; the visa fields are optional
 * so that a portal newer than the server (deploy window) reads their absence as "no visa
 * departments" — the closed answer.
 */
export interface VisaSubject extends ScopedSubject {
  /** Account departments (ADR 0040): the own side of a request for a department role. */
  departmentIds?: readonly string[];
  /** Visa departments (ADR 0245): where a grant-given visa of an axis-less role acts. */
  approvalDepartmentIds?: readonly string[];
  /** Sites attached to the visa departments: derived, like `departmentObjectIds`. */
  approvalDepartmentObjectIds?: readonly string[];
}

/** The customer of a vehicle order (ADR 0040): an object OR a department, exactly one is filled. */
export interface VisaCustomer {
  objectId: string | null;
  departmentId: string | null;
}

/**
 * Does a set of departments with their sites own this vehicle order (ADR 0201): the order of a
 * department of the set, or an order of a site attached to one of them. A disjunction, because an
 * order has either a department or an object, never both.
 *
 * Exported because the server's department scope (`departmentOwnsRequest` in `lib/access.ts`)
 * answers with the same function: visibility, scope and visa of a department must not drift apart.
 */
export function departmentsOwnVehicleRequest(
  departmentIds: readonly string[] | undefined,
  departmentObjectIds: readonly string[] | undefined,
  customer: VisaCustomer,
): boolean {
  return (
    (!!customer.departmentId && (departmentIds ?? []).includes(customer.departmentId)) ||
    (!!customer.objectId && (departmentObjectIds ?? []).includes(customer.objectId))
  );
}

/**
 * May the subject sign this vehicle order (ADR 0025, 0040, 0201, 0245): the visa permission plus
 * the subject's own side of the order.
 *
 * - object role — its objects;
 * - department role — its departments and their sites;
 * - axis-less role whose visa came from a grant — its visa departments and their sites, the same
 *   answer the department head gives (owner decision 05.11.2026);
 * - axis-less role whose matrix carries the visa (administrator) — everything.
 *
 * `has` answers the permission, as in `canApproveMechRequest`: the server leaves the default (the
 * matrix over its own principal), the portal passes its `can`, which reads the list the server
 * computed (ADR 0223).
 */
export function canApproveVehicleRequest(
  subject: VisaSubject | null | undefined,
  customer: VisaCustomer,
  has: (permission: Permission) => boolean = (permission) => can(subject, permission),
): boolean {
  if (!has('vehicleRequests.approve')) return false;
  const role = subject?.role;
  if (isObjectScopedRole(role)) {
    return (
      !!customer.objectId && (subject?.constructionObjectIds ?? []).includes(customer.objectId)
    );
  }
  // The department head signs the site order of his department too (ADR 0201): the customer's
  // decision that the equipment is needed is taken by whoever filed the order. Accepted
  // consequence: a site order has two circles of signers — the site and the departments it is
  // attached to. Who signed is visible in the card.
  if (isDepartmentScopedRole(role)) {
    return departmentsOwnVehicleRequest(
      subject?.departmentIds,
      subject?.departmentObjectIds,
      customer,
    );
  }
  if (visaLimitedToApprovalDepartments(role, 'vehicleRequests.approve')) {
    return departmentsOwnVehicleRequest(
      subject?.approvalDepartmentIds,
      subject?.approvalDepartmentObjectIds,
      customer,
    );
  }
  return true;
}
