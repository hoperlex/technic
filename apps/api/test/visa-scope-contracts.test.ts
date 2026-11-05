import { describe, expect, it } from 'vitest';
import {
  acceptsApprovalDepartments,
  canApproveVehicleRequest,
  needsApprovalDepartments,
  ROLE_GRANTS,
  ROLES,
  roleScopeAxis,
  visaLimitedToApprovalDepartments,
  type Permission,
  type VisaSubject,
} from '@technic/contracts';

/**
 * Scope of a grant-given visa of an axis-less role (ADR 0245) — the contract both the server and
 * the portal ask. The live routes are `manager-department-visa.db.test.ts`.
 */

const DEPARTMENT = 'dep-1';
const OTHER_DEPARTMENT = 'dep-2';
const SITE = 'obj-1';
const OTHER_SITE = 'obj-2';

const listOf =
  (...permissions: Permission[]) =>
  (permission: Permission): boolean =>
    permissions.includes(permission);

describe('whose visa is limited by visa departments', () => {
  it('the manager: no axis, and its matrix row carries neither visa', () => {
    expect(visaLimitedToApprovalDepartments('manager', 'vehicleRequests.approve')).toBe(true);
    expect(visaLimitedToApprovalDepartments('manager', 'mechRequests.approve')).toBe(true);
    expect(acceptsApprovalDepartments('manager')).toBe(true);
  });

  it('the administrator: both visas come from the matrix, so nothing changes for him', () => {
    expect(visaLimitedToApprovalDepartments('admin', 'vehicleRequests.approve')).toBe(false);
    expect(visaLimitedToApprovalDepartments('admin', 'mechRequests.approve')).toBe(false);
    expect(acceptsApprovalDepartments('admin')).toBe(false);
  });

  it('a role with its own axis never: its axis already limits the visa', () => {
    for (const role of ROLES.filter((r) => roleScopeAxis(r) !== 'none')) {
      expect(acceptsApprovalDepartments(role), role).toBe(false);
    }
  });

  it('an account without a role holds no visa at all', () => {
    expect(acceptsApprovalDepartments(null)).toBe(false);
  });
});

describe('when visa departments are required (owner decision 05.11.2026)', () => {
  it('a manager holding a grant-given visa needs at least one', () => {
    expect(
      needsApprovalDepartments('manager', ['vehicleRequests.read', 'vehicleRequests.approve']),
    ).toBe(true);
    expect(needsApprovalDepartments('manager', ['mechRequests.approve'])).toBe(true);
  });

  it('a manager without a visa does not: the visa itself stays optional', () => {
    expect(needsApprovalDepartments('manager', ['vehicleRequests.read'])).toBe(false);
  });

  it('the administrator and the department never', () => {
    expect(needsApprovalDepartments('admin', ['vehicleRequests.approve'])).toBe(false);
    expect(needsApprovalDepartments('department', ['vehicleRequests.approve'])).toBe(false);
  });
});

describe('«Виза отдела» is grantable to the manager', () => {
  it('the catalog lists both compatible roles with the same two visas', () => {
    expect(ROLE_GRANTS.department_approval.roles).toEqual(['department', 'manager']);
    expect(ROLE_GRANTS.department_approval.permissions).toEqual([
      'vehicleRequests.approve',
      'mechRequests.approve',
    ]);
  });
});

describe('the vehicle visa predicate the portal asks per row', () => {
  const manager: VisaSubject = {
    role: 'manager',
    approvalDepartmentIds: [DEPARTMENT],
    approvalDepartmentObjectIds: [SITE],
  };
  const has = listOf('vehicleRequests.approve');

  it('signs its visa department and the sites attached to it, nothing else', () => {
    expect(
      canApproveVehicleRequest(manager, { objectId: null, departmentId: DEPARTMENT }, has),
    ).toBe(true);
    expect(canApproveVehicleRequest(manager, { objectId: SITE, departmentId: null }, has)).toBe(
      true,
    );
    expect(
      canApproveVehicleRequest(manager, { objectId: null, departmentId: OTHER_DEPARTMENT }, has),
    ).toBe(false);
    expect(
      canApproveVehicleRequest(manager, { objectId: OTHER_SITE, departmentId: null }, has),
    ).toBe(false);
  });

  it('reads absent visa fields as "none": a portal newer than the server stays closed', () => {
    expect(
      canApproveVehicleRequest({ role: 'manager' }, { objectId: SITE, departmentId: null }, has),
    ).toBe(false);
  });

  it('without the permission there is no visa, whatever the departments', () => {
    expect(
      canApproveVehicleRequest(manager, { objectId: SITE, departmentId: null }, listOf()),
    ).toBe(false);
  });
});
