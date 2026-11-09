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
  isMechLessorRentalVisible,
  isMechLessorSubject,
  MECH_LESSOR_RECEIPT_CAP_MESSAGE,
  MECH_LESSOR_RECEIPT_LESSOR_CAP,
  MECH_LESSOR_RECEIPT_LESSOR_LOCKED_MESSAGE,
  MECH_LESSOR_RECEIPT_NOT_IN_WORK_MESSAGE,
  MECH_LESSOR_RECEIPT_NOT_PENDING_MESSAGE,
  MECH_LESSOR_RECEIPT_NOTHING_TO_REVOKE_MESSAGE,
  MECH_LESSOR_RECEIPT_REVOKE_NOT_IN_WORK_MESSAGE,
  MECH_LESSOR_RECEIPT_STATUSES,
  MECH_LESSOR_RECEIPT_WAIVER_APPROVED_MESSAGE,
  MECH_LESSOR_RECEIPT_WAIVER_NOT_IN_WORK_MESSAGE,
  MECH_LESSOR_RECEIPT_WAIVER_REPEATED_MESSAGE,
  attachMechLessorReceiptSchema,
  decideMechLessorReceiptSchema,
  isMechLessorReceiptContentType,
  mechLessorReceiptAccess,
  mechLessorReceiptAttachBlocker,
  mechLessorReceiptCompletionBlocker,
  mechLessorReceiptDecisionBlocker,
  mechLessorReceiptMark,
  mechLessorReceiptWaiverBlocker,
  mechLessorVisibleVersions,
  REQUEST_STATUSES,
  validateGrantAssignment,
  waiveMechLessorReceiptSchema,
  MECH_LESSOR_RECEIPT_FILTERS,
  mechDeleteScope,
  mechRequestHistoryQuerySchema,
  mechRequestListQuerySchema,
  mechTransitionBlocker,
  type MechTransitionState,
  type MechApprovalSubject,
  type MechLessorReceiptCurrent,
  type MechLessorReceiptRetireReason,
  type MechLessorReceiptStatus,
  type MechLessorSubject,
  type Permission,
  type RequestStatus,
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
    expect(
      canApproveMechRequest(executor('operator'), target, listOf('mechRequests.approve')),
    ).toBe(false);
    // The same oracle opens the visa to an axis-less role: the refusal is the executor's own branch.
    expect(canApproveMechRequest({ role: 'admin' }, target, listOf('mechRequests.approve'))).toBe(
      true,
    );
  });
});

// ── The receipt's rules (W1): blockers, gate, mark, versions, buttons ──

const LESSOR_ID = 'cp-lessor';
const UUID = '00000000-0000-4000-8000-000000000001';

const current = (status: MechLessorReceiptStatus | null): MechLessorReceiptCurrent =>
  status ? { status } : null;
const CURRENTS: MechLessorReceiptCurrent[] = [null, ...MECH_LESSOR_RECEIPT_STATUSES.map(current)];

describe('attaching (P7)', () => {
  it('only to a rental in work, for anyone', () => {
    for (const status of REQUEST_STATUSES) {
      for (const actsAsLessor of [false, true]) {
        const refusal = mechLessorReceiptAttachBlocker({
          row: { status },
          current: null,
          lessorVersionCount: 0,
          actsAsLessor,
        });
        expect(refusal, `${status} lessor=${actsAsLessor}`).toBe(
          status === 'confirmed' ? null : MECH_LESSOR_RECEIPT_NOT_IN_WORK_MESSAGE,
        );
      }
    }
  });

  /** O13: the office replaces anything; the lessor a pending or rejected version only. */
  it('the lessor never replaces an approval or a waiver, the office replaces any version', () => {
    for (const cur of CURRENTS) {
      const office = mechLessorReceiptAttachBlocker({
        row: { status: 'confirmed' },
        current: cur,
        lessorVersionCount: 0,
        actsAsLessor: false,
      });
      expect(office, `office over ${cur?.status ?? 'none'}`).toBeNull();
      const lessor = mechLessorReceiptAttachBlocker({
        row: { status: 'confirmed' },
        current: cur,
        lessorVersionCount: 0,
        actsAsLessor: true,
      });
      const locked = cur?.status === 'approved' || cur?.status === 'waived';
      expect(lessor, `lessor over ${cur?.status ?? 'none'}`).toBe(
        locked ? MECH_LESSOR_RECEIPT_LESSOR_LOCKED_MESSAGE : null,
      );
    }
  });

  /** The cap guards against an external loop; the office past it must still attach the real one. */
  it('caps the lessor per account within the deal, never the office', () => {
    const at = (count: number, actsAsLessor: boolean) =>
      mechLessorReceiptAttachBlocker({
        row: { status: 'confirmed' },
        current: current('rejected'),
        lessorVersionCount: count,
        actsAsLessor,
      });
    expect(at(MECH_LESSOR_RECEIPT_LESSOR_CAP - 1, true)).toBeNull();
    expect(at(MECH_LESSOR_RECEIPT_LESSOR_CAP, true)).toBe(MECH_LESSOR_RECEIPT_CAP_MESSAGE);
    expect(at(MECH_LESSOR_RECEIPT_LESSOR_CAP * 5, false)).toBeNull();
  });

  it('takes PDF and JPEG only; the bodies are strict', () => {
    expect(isMechLessorReceiptContentType('application/pdf')).toBe(true);
    expect(isMechLessorReceiptContentType('image/jpeg')).toBe(true);
    for (const type of ['image/png', 'image/heic', 'application/octet-stream', '']) {
      expect(isMechLessorReceiptContentType(type), type).toBe(false);
    }
    expect(attachMechLessorReceiptSchema.safeParse({ fileId: UUID, version: 3 }).success).toBe(
      true,
    );
    expect(
      attachMechLessorReceiptSchema.safeParse({ fileId: UUID, version: 3, status: 'approved' })
        .success,
    ).toBe(false);
  });
});

describe('deciding (P5) and the «без чека» visa (P6)', () => {
  /** A cancelled rental may still hold a pending receipt (a prepayment): deciding it is allowed. */
  it('approve and reject need a pending current version, whatever the request status', () => {
    for (const status of REQUEST_STATUSES) {
      for (const cur of CURRENTS) {
        for (const decision of ['approve', 'reject'] as const) {
          expect(
            mechLessorReceiptDecisionBlocker({ status }, cur, decision),
            `${decision} ${status} ${cur?.status ?? 'none'}`,
          ).toBe(cur?.status === 'pending' ? null : MECH_LESSOR_RECEIPT_NOT_PENDING_MESSAGE);
        }
      }
    }
  });

  /** O15: undone only while the rental is in work — after completion it is a closed rental's basis. */
  it('revoke needs an approval or a waiver, and only in «В работе»', () => {
    for (const status of REQUEST_STATUSES) {
      for (const cur of CURRENTS) {
        const revocable = cur?.status === 'approved' || cur?.status === 'waived';
        const expected = !revocable
          ? MECH_LESSOR_RECEIPT_NOTHING_TO_REVOKE_MESSAGE
          : status === 'confirmed'
            ? null
            : MECH_LESSOR_RECEIPT_REVOKE_NOT_IN_WORK_MESSAGE;
        expect(
          mechLessorReceiptDecisionBlocker({ status }, cur, 'revoke'),
          `revoke ${status} ${cur?.status ?? 'none'}`,
        ).toBe(expected);
      }
    }
  });

  it('the waiver: in work, over nothing, a pending or a rejected version', () => {
    for (const status of REQUEST_STATUSES) {
      for (const cur of CURRENTS) {
        const expected =
          status !== 'confirmed'
            ? MECH_LESSOR_RECEIPT_WAIVER_NOT_IN_WORK_MESSAGE
            : cur?.status === 'approved'
              ? MECH_LESSOR_RECEIPT_WAIVER_APPROVED_MESSAGE
              : cur?.status === 'waived'
                ? MECH_LESSOR_RECEIPT_WAIVER_REPEATED_MESSAGE
                : null;
        expect(
          mechLessorReceiptWaiverBlocker({ status }, cur),
          `waive ${status} ${cur?.status ?? 'none'}`,
        ).toBe(expected);
      }
    }
    // A cancelled rental is not waived: the waiver allows a completion, and there is none to come.
    expect(mechLessorReceiptWaiverBlocker({ status: 'cancelled' }, null)).toBe(
      MECH_LESSOR_RECEIPT_WAIVER_NOT_IN_WORK_MESSAGE,
    );
  });

  it('a rejection and a revocation need their reason, a waiver always does', () => {
    const decide = (decision: string, comment?: string) =>
      decideMechLessorReceiptSchema.safeParse({ receiptId: UUID, decision, comment, version: 1 })
        .success;
    expect(decide('approve')).toBe(true);
    expect(decide('reject')).toBe(false);
    expect(decide('reject', '   ')).toBe(false);
    expect(decide('reject', 'не та сумма')).toBe(true);
    expect(decide('revoke')).toBe(false);
    expect(decide('revoke', 'ошибся')).toBe(true);
    expect(decide('waive', 'x')).toBe(false);
    expect(waiveMechLessorReceiptSchema.safeParse({ comment: '', version: 1 }).success).toBe(false);
    expect(
      waiveMechLessorReceiptSchema.safeParse({ comment: 'арендодатель без чеков', version: 1 })
        .success,
    ).toBe(true);
  });
});

describe('the completion gate (P3)', () => {
  it('a rental taken in before the release is not gated', () => {
    for (const cur of CURRENTS) {
      expect(
        mechLessorReceiptCompletionBlocker({ lessorReceiptRequired: false, lessorReceipt: cur }),
      ).toBeNull();
    }
  });

  it('a required receipt passes approved or waived, and says what is missing otherwise', () => {
    const gate = (cur: MechLessorReceiptCurrent) =>
      mechLessorReceiptCompletionBlocker({ lessorReceiptRequired: true, lessorReceipt: cur });
    expect(gate(current('approved'))).toBeNull();
    expect(gate(current('waived'))).toBeNull();
    expect(gate(current('pending'))).toBe(
      'Чек арендодателя ждёт визы — аренду завершают после неё',
    );
    expect(gate(current('rejected'))).toBe('Чек арендодателя отклонён — прикрепите исправленный');
    expect(gate(null)).toBe('Прикрепите чек арендодателя или получите визу «без чека»');
  });

  /**
   * The gate is asked by the transition barrier itself, so the server's 422 and the portal's menu
   * answer from one place; only completion asks it — issue, extension and cancellation do not (O2).
   */
  it('the transition barrier asks the gate for completion only', () => {
    const issued: MechTransitionState = {
      status: 'confirmed',
      actualFrom: '2026-11-02',
      actualTo: null,
      approvedAt: '2026-11-01T08:00:00.000Z',
      lessorReceiptRequired: true,
      lessorReceipt: current('pending'),
    };
    expect(mechTransitionBlocker(issued, 'done')).toBe(
      'Чек арендодателя ждёт визы — аренду завершают после неё',
    );
    expect(mechTransitionBlocker({ ...issued, lessorReceipt: current('approved') }, 'done')).toBe(
      null,
    );
    expect(mechTransitionBlocker({ ...issued, lessorReceiptRequired: false }, 'done')).toBeNull();
    // Cancellation keeps its own answer (the issued equipment), never the receipt's.
    expect(mechTransitionBlocker(issued, 'cancelled')).toMatch(/завершить, а не отменять/);
    const awaitingIssue = { ...issued, actualFrom: null };
    expect(mechTransitionBlocker(awaitingIssue, 'cancelled')).toBeNull();
    expect(mechTransitionBlocker(awaitingIssue, 'new')).toBeNull();
  });
});

describe('deleting a «Новая» that holds receipt versions (P8)', () => {
  const fresh = { status: 'new' as const, actualFrom: null, actualTo: null, deletedAt: null };

  it('is archived, not hard-deleted, so every version stays (O8)', () => {
    expect(mechDeleteScope(fresh, 0)).toBe('hard');
    expect(mechDeleteScope(fresh, 1)).toBe('archive');
    expect(mechDeleteScope(fresh, 3)).toBe('archive');
  });

  it('the count changes nothing else', () => {
    expect(mechDeleteScope({ ...fresh, status: 'cancelled' }, 0)).toBe('archive');
    expect(mechDeleteScope({ ...fresh, status: 'confirmed', actualFrom: '2026-11-02' }, 2)).toBe(
      'none',
    );
    expect(mechDeleteScope({ ...fresh, deletedAt: '2026-11-03T08:00:00.000Z' }, 0)).toBe('none');
  });
});

describe('the filter «Чек» (P16)', () => {
  it('is a parameter of the list and of the journal, with five values', () => {
    for (const value of MECH_LESSOR_RECEIPT_FILTERS) {
      expect(mechRequestListQuerySchema.parse({ lessorReceipt: value }).lessorReceipt).toBe(value);
      expect(mechRequestHistoryQuerySchema.parse({ lessorReceipt: value }).lessorReceipt).toBe(
        value,
      );
    }
    expect(MECH_LESSOR_RECEIPT_FILTERS).toEqual([
      'pending',
      'rejected',
      'missing',
      'approved',
      'waived',
    ]);
    expect(mechRequestListQuerySchema.safeParse({ lessorReceipt: 'none' }).success).toBe(false);
    expect(mechRequestListQuerySchema.parse({}).lessorReceipt).toBeUndefined();
  });
});

describe('the mark (P16)', () => {
  const mark = (
    status: RequestStatus,
    cur: MechLessorReceiptCurrent,
    required = true,
    deletedAt: string | null = null,
  ) =>
    mechLessorReceiptMark({
      status,
      deletedAt,
      lessorReceiptRequired: required,
      lessorReceipt: cur,
    });

  it('marks what waits for someone, and nothing on an archived row', () => {
    expect(mark('confirmed', current('pending'))).toBe('pending');
    // A pending receipt of a cancelled rental is still decidable, so it still asks for the visa.
    expect(mark('cancelled', current('pending'))).toBe('pending');
    expect(mark('confirmed', current('rejected'))).toBe('rejected');
    expect(mark('cancelled', current('rejected'))).toBeNull();
    expect(mark('confirmed', null)).toBe('missing');
    expect(mark('confirmed', null, false)).toBeNull();
    expect(mark('done', null)).toBeNull();
    expect(mark('confirmed', current('approved'))).toBeNull();
    expect(mark('confirmed', current('waived'))).toBeNull();
    for (const cur of CURRENTS) {
      expect(
        mark('confirmed', cur, true, '2026-11-09T10:00:00Z'),
        cur?.status ?? 'none',
      ).toBeNull();
    }
  });
});

describe('the versions of the current deal (P12)', () => {
  const v = (versionNo: number, retiredReason: MechLessorReceiptRetireReason | null) => ({
    versionNo,
    retiredReason,
  });

  it('starts after the last version dropped by a deal change or a return to «Новая»', () => {
    expect(mechLessorVisibleVersions([])).toEqual([]);
    expect(mechLessorVisibleVersions([v(1, 'replaced'), v(2, null)])).toEqual([
      v(1, 'replaced'),
      v(2, null),
    ]);
    // Out of order on input, ascending on output; a revoked waiver stays in the deal.
    expect(
      mechLessorVisibleVersions([
        v(4, null),
        v(1, 'replaced'),
        v(3, 'revoked'),
        v(2, 'deal_changed'),
      ]),
    ).toEqual([v(3, 'revoked'), v(4, null)]);
    expect(
      mechLessorVisibleVersions([v(1, 'deal_changed'), v(2, 'replaced'), v(3, 'rolled_back')]),
    ).toEqual([]);
  });
});

describe('the lessor and his rentals (P11)', () => {
  const lessor: MechLessorSubject = {
    role: 'operator',
    counterpartyType: 'mech_lessor',
    counterpartyId: LESSOR_ID,
  };
  const row = (
    over: Partial<{
      lessorId: string | null;
      status: RequestStatus;
      deletedAt: string | null;
    }> = {},
  ) => ({
    lessorId: LESSOR_ID,
    status: 'confirmed' as RequestStatus,
    deletedAt: null as string | null,
    ...over,
  });

  it('is the executor role with a mechanization lessor counterparty', () => {
    expect(isMechLessorSubject(lessor)).toBe(true);
    expect(isMechLessorSubject({ role: 'operator', counterpartyType: 'vehicle_lessor' })).toBe(
      false,
    );
    expect(isMechLessorSubject({ role: 'admin' })).toBe(false);
  });

  it('sees his own rental in work, not archived — nothing else, and nobody else sees through it', () => {
    expect(isMechLessorRentalVisible(lessor, row())).toBe(true);
    expect(isMechLessorRentalVisible(lessor, row({ lessorId: 'cp-other' }))).toBe(false);
    expect(isMechLessorRentalVisible(lessor, row({ lessorId: null }))).toBe(false);
    for (const status of REQUEST_STATUSES.filter((s) => s !== 'confirmed')) {
      expect(isMechLessorRentalVisible(lessor, row({ status })), status).toBe(false);
    }
    expect(isMechLessorRentalVisible(lessor, row({ deletedAt: '2026-11-09T10:00:00Z' }))).toBe(
      false,
    );
    expect(isMechLessorRentalVisible({ ...lessor, counterpartyId: null }, row())).toBe(false);
    expect(
      isMechLessorRentalVisible(
        { role: 'operator', counterpartyType: 'vehicle_lessor', counterpartyId: LESSOR_ID },
        row(),
      ),
    ).toBe(false);
    expect(isMechLessorRentalVisible({ role: 'admin', counterpartyId: LESSOR_ID }, row())).toBe(
      false,
    );
  });
});

describe('the buttons (P15)', () => {
  type Subject = MechApprovalSubject & MechLessorSubject;
  const OFFICE_PERMS: Permission[] = [
    'mechRequests.read',
    'mechRequests.status',
    'mechRequests.lessorReceipt',
  ];
  const VISA_PERMS: Permission[] = ['mechRequests.read', 'mechRequests.approve'];

  const office: Subject = { role: 'dispatcher' };
  const siteVisa: Subject = { role: 'site', constructionObjectIds: [OBJECT_ID] };
  const foreignSiteVisa: Subject = { role: 'site', constructionObjectIds: ['obj-2'] };
  const departmentVisa: Subject = {
    role: 'department_head',
    departmentIds: [DEPARTMENT_ID],
    departmentObjectIds: [OBJECT_ID],
  };
  const admin: Subject = { role: 'admin' };
  const lessor: Subject = {
    role: 'operator',
    counterpartyType: 'mech_lessor',
    counterpartyId: LESSOR_ID,
  };

  const rental = (
    cur: MechLessorReceiptCurrent,
    over: Partial<{
      status: RequestStatus;
      deletedAt: string | null;
      lessorVersionCount: number;
      lessorId: string;
      departmentId: string | null;
    }> = {},
  ) => ({
    status: 'confirmed' as RequestStatus,
    deletedAt: null as string | null,
    lessorReceiptRequired: true,
    lessorReceipt: cur,
    objectId: OBJECT_ID,
    departmentId: DEPARTMENT_ID as string | null,
    lessorId: LESSOR_ID as string | null,
    lessorVersionCount: 0,
    ...over,
  });

  const NONE = {
    attach: false,
    replace: false,
    review: false,
    waive: false,
    revokeApproval: false,
    revokeWaiver: false,
  };

  it('the office attaches and replaces, and decides nothing without the visa', () => {
    const has = listOf(...OFFICE_PERMS);
    expect(mechLessorReceiptAccess(office, rental(null), has)).toEqual({ ...NONE, attach: true });
    expect(mechLessorReceiptAccess(office, rental(current('approved')), has)).toEqual({
      ...NONE,
      attach: true,
      replace: true,
    });
    expect(mechLessorReceiptAccess(office, rental(null, { status: 'done' }), has)).toEqual(NONE);
    expect(
      mechLessorReceiptAccess(office, rental(null, { deletedAt: '2026-11-09T10:00:00Z' }), has),
    ).toEqual(NONE);
  });

  it('the site visa holder reviews, waives and revokes on his own site only', () => {
    const has = listOf(...VISA_PERMS);
    expect(mechLessorReceiptAccess(siteVisa, rental(current('pending')), has)).toEqual({
      ...NONE,
      review: true,
      waive: true,
    });
    expect(mechLessorReceiptAccess(siteVisa, rental(null), has)).toEqual({ ...NONE, waive: true });
    expect(mechLessorReceiptAccess(siteVisa, rental(current('rejected')), has)).toEqual({
      ...NONE,
      waive: true,
    });
    expect(mechLessorReceiptAccess(siteVisa, rental(current('approved')), has)).toEqual({
      ...NONE,
      revokeApproval: true,
    });
    expect(mechLessorReceiptAccess(siteVisa, rental(current('waived')), has)).toEqual({
      ...NONE,
      revokeWaiver: true,
    });
    // After completion: nothing to revoke; a cancelled rental's pending receipt is still reviewed.
    expect(
      mechLessorReceiptAccess(siteVisa, rental(current('approved'), { status: 'done' }), has),
    ).toEqual(NONE);
    expect(
      mechLessorReceiptAccess(siteVisa, rental(current('pending'), { status: 'cancelled' }), has),
    ).toEqual({ ...NONE, review: true });
    expect(mechLessorReceiptAccess(foreignSiteVisa, rental(current('pending')), has)).toEqual(NONE);
  });

  it('the department visa holder decides the request his department filed (ADR 0171 decision 4)', () => {
    const has = listOf(...VISA_PERMS);
    expect(mechLessorReceiptAccess(departmentVisa, rental(current('pending')), has)).toEqual({
      ...NONE,
      review: true,
      waive: true,
    });
    expect(
      mechLessorReceiptAccess(
        departmentVisa,
        rental(current('pending'), { departmentId: null }),
        has,
      ),
    ).toEqual(NONE);
  });

  it('the administrator does everything the state allows', () => {
    const has = listOf(...OFFICE_PERMS, 'mechRequests.approve');
    expect(mechLessorReceiptAccess(admin, rental(current('pending')), has)).toEqual({
      ...NONE,
      attach: true,
      replace: true,
      review: true,
      waive: true,
    });
  });

  it('the lessor attaches to his rental while it waits or after a rejection, and decides nothing', () => {
    // Even an oracle that hands him the visa does not make him sign: the circle refuses executors.
    const has = listOf('mechRequests.read', 'mechRequests.lessorReceipt', 'mechRequests.approve');
    expect(mechLessorReceiptAccess(lessor, rental(null), has)).toEqual({ ...NONE, attach: true });
    expect(mechLessorReceiptAccess(lessor, rental(current('pending')), has)).toEqual({
      ...NONE,
      attach: true,
      replace: true,
    });
    expect(mechLessorReceiptAccess(lessor, rental(current('rejected')), has)).toEqual({
      ...NONE,
      attach: true,
      replace: true,
    });
    expect(mechLessorReceiptAccess(lessor, rental(current('approved')), has)).toEqual(NONE);
    expect(mechLessorReceiptAccess(lessor, rental(current('waived')), has)).toEqual(NONE);
    expect(
      mechLessorReceiptAccess(
        lessor,
        rental(null, { lessorVersionCount: MECH_LESSOR_RECEIPT_LESSOR_CAP }),
        has,
      ),
    ).toEqual(NONE);
    expect(mechLessorReceiptAccess(lessor, rental(null, { lessorId: 'cp-other' }), has)).toEqual(
      NONE,
    );
  });
});
