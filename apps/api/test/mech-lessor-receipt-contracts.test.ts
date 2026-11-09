import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  accessProfileLabel,
  canApproveMechRequest,
  COUNTERPARTY_TYPE_PERMISSIONS,
  GRANT_SCOPE_MATRIX,
  PERMISSION_CATALOG,
  PERMISSIONS,
  permissionsFor,
  ROLE_PERMISSIONS,
  ROLES,
  validateGrantAssignment,
  type MechApprovalSubject,
  type Permission,
  type Role,
} from '@technic/contracts';

/**
 * The contract of the lessor's receipt (plan `docs/mechanization-lessor-receipt-plan.md`, W1): the
 * permission and its invariants (P4, P10), the visa circle closed to executors (P5). Everything here
 * must answer the portal and the server identically; the live rows and the routes are W2's db
 * suites.
 */

const OBJECT_ID = 'obj-1';
const DEPARTMENT_ID = 'dep-1';

const listOf =
  (...permissions: Permission[]) =>
  (permission: Permission): boolean =>
    permissions.includes(permission);

const MECH_PERMISSIONS = PERMISSIONS.filter((p) => p.startsWith('mechRequests.'));

describe('the permission to attach a lessor receipt (P4)', () => {
  it('is a manage action of the mechanization module with its own label', () => {
    expect(PERMISSION_CATALOG['mechRequests.lessorReceipt']).toEqual({
      module: 'mech',
      action: 'manage',
      label: 'Прикрепляет чек арендодателя к аренде механизации',
    });
  });

  /**
   * Over the access profiles, not the role list: a permission can reach an account from its role,
   * its counterparty type or an add-on, and the invariant is about the account.
   */
  it('every role and profile that runs rentals also attaches receipts', () => {
    const broken: string[] = [];
    for (const subject of ACCESS_PROFILES) {
      const held = permissionsFor(subject);
      if (held.includes('mechRequests.status') && !held.includes('mechRequests.lessorReceipt')) {
        broken.push(accessProfileLabel(subject));
      }
    }
    expect(broken).toEqual([]);
    for (const role of ROLES) {
      const row = ROLE_PERMISSIONS[role];
      if (row.includes('mechRequests.status')) {
        expect(row.includes('mechRequests.lessorReceipt'), role).toBe(true);
      }
    }
    // The holders named, so that a new one is noticed: the office and the administrator.
    const holders = ROLES.filter((role) =>
      ROLE_PERMISSIONS[role].includes('mechRequests.lessorReceipt'),
    );
    expect(holders).toEqual(['admin', 'manager', 'dispatcher']);
  });

  /**
   * The requirement is checked over the account's effective permissions after every operation that
   * changes access, and its refusal speaks of the receipt: the generic text would tell the
   * administrator the account does not see the module, which is false for this pair.
   */
  it('`.status` requires `.lessorReceipt`, refused with the pair’s own reason', () => {
    const violations = validateGrantAssignment({
      permissions: ['mechRequests.status'],
      roles: ['manager'],
      subjectRole: 'manager',
      subjectPermissionsAfter: ['mechRequests.read', 'mechRequests.status'],
    }).filter((violation) => violation.code === 'requirement_missing');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      permission: 'mechRequests.status',
      requires: 'mechRequests.lessorReceipt',
    });
    expect(violations[0]?.message).toContain('Ведущий аренду прикрепляет и чек арендодателя');
    expect(violations[0]?.message).not.toContain('которого учётка не видит');

    // With the pair complete nothing is missing; the attach permission alone needs reading.
    expect(
      validateGrantAssignment({
        permissions: ['mechRequests.status', 'mechRequests.lessorReceipt'],
        roles: ['manager'],
        subjectRole: 'manager',
        subjectPermissionsAfter: [
          'mechRequests.read',
          'mechRequests.status',
          'mechRequests.lessorReceipt',
        ],
      }),
    ).toEqual([]);
    const unread = validateGrantAssignment({
      permissions: ['mechRequests.lessorReceipt'],
      roles: ['manager'],
      subjectRole: 'manager',
      subjectPermissionsAfter: ['mechRequests.lessorReceipt'],
    });
    expect(unread).toHaveLength(1);
    expect(unread[0]).toMatchObject({
      code: 'requirement_missing',
      requires: 'mechRequests.read',
    });
    // A pair without its own reason keeps the generic words.
    expect(unread[0]?.message).toContain('которого учётка не видит');
  });
});

describe('no permission set widens an executor in mechanization (P10)', () => {
  /**
   * The lessor's powers are exactly his type's list. The cell stays `forbidden` although the lessor
   * logs in: a set with `.status` or `.approve` would open doors that answer with the full request.
   */
  it('a set holding any `mechRequests.*` permission is refused for the executor role', () => {
    expect(GRANT_SCOPE_MATRIX.mech.counterparty).toBe('forbidden');
    for (const permission of MECH_PERMISSIONS) {
      const violations = validateGrantAssignment({
        permissions: [permission],
        roles: ['operator'],
        subjectRole: null,
        subjectPermissionsAfter: null,
      });
      expect(
        violations.map((violation) => violation.code),
        permission,
      ).toEqual(['module_forbidden_for_axis']);
    }
  });

  /**
   * The executor status boundary of ADR 0152 stays unreachable for mechanization without editing
   * the shared `cycleTransitions`: no counterparty type lists `.status`, and the matrix refuses it.
   */
  it('no counterparty type holds the status or the visa of mechanization', () => {
    for (const [type, list] of Object.entries(COUNTERPARTY_TYPE_PERMISSIONS)) {
      expect(list.includes('mechRequests.status'), type).toBe(false);
      expect(list.includes('mechRequests.approve'), type).toBe(false);
      expect(list.includes('mechRequests.update'), type).toBe(false);
      expect(list.includes('mechRequests.extend'), type).toBe(false);
    }
  });
});

describe('the visa circle refuses executors (P5)', () => {
  const executor = (role: Role): MechApprovalSubject => ({
    role,
    counterpartyType: 'mech_lessor',
    constructionObjectIds: [OBJECT_ID],
    departmentIds: [DEPARTMENT_ID],
    departmentObjectIds: [OBJECT_ID],
  });

  it('an executor holding `.approve` through a custom oracle still does not sign', () => {
    const target = { objectId: OBJECT_ID, departmentId: DEPARTMENT_ID };
    expect(canApproveMechRequest(executor('operator'), target, listOf('mechRequests.approve'))).toBe(
      false,
    );
    // The same oracle opens the visa to an axis-less role: the refusal is the executor's own branch.
    expect(canApproveMechRequest({ role: 'admin' }, target, listOf('mechRequests.approve'))).toBe(
      true,
    );
  });
});
