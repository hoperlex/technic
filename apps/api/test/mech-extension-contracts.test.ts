import { describe, expect, it } from 'vitest';
import {
  canApproveMechExtension,
  decideMechExtensionSchema,
  MECH_EXTEND_NOT_LATER_MESSAGE,
  MECH_EXTENSION_ENDED_MESSAGE,
  MECH_EXTENSION_NOT_PENDING_MESSAGE,
  MECH_EXTENSION_NOT_RUNNING_MESSAGE,
  MECH_EXTENSION_TERM_CHANGED_MESSAGE,
  mechExtensionAccess,
  mechExtensionApprovalBlocker,
  mechExtensionRequestBlocker,
  mechStateTag,
  mechStateTagLabels,
  requestMechExtensionSchema,
  type MechApprovalSubject,
  type MechExtensionTarget,
  type Permission,
  type Role,
} from '@technic/contracts';

/**
 * The contract of the extension visa (ADR 0171, stage 3; plan
 * `docs/mechanization-approval-and-grants-plan.md`, R10): who decides, what the rental's state
 * allows, the bodies of the three doors and the list tag. Everything here must answer the portal
 * and the server identically; the live rows and the routes are `mech-extension.db.test.ts`.
 */

const OBJECT_ID = 'obj-1';
const OTHER_OBJECT_ID = 'obj-2';
const DEPARTMENT_ID = 'dep-1';

const subject = (
  role: Role,
  scope: Partial<
    Pick<MechApprovalSubject, 'constructionObjectIds' | 'departmentIds' | 'departmentObjectIds'>
  > = {},
): MechApprovalSubject => ({
  role,
  constructionObjectIds: [],
  departmentIds: [],
  departmentObjectIds: [],
  ...scope,
});

/** A running rental with a pending request filed against its current return date. */
const RUNNING: MechExtensionTarget & { deletedAt: string | null } = {
  status: 'confirmed',
  actualFrom: '2026-10-01',
  actualTo: null,
  objectId: OBJECT_ID,
  plannedTo: '2026-10-15',
  extension: { status: 'pending', previousPlannedTo: '2026-10-15', newPlannedTo: '2026-10-22' },
  deletedAt: null,
};

const listOf =
  (...permissions: Permission[]) =>
  (permission: Permission): boolean =>
    permissions.includes(permission);

describe('who decides an extension (R10)', () => {
  it('the visa holder of this site decides, of another site does not', () => {
    const own = subject('rukstroy', { constructionObjectIds: [OBJECT_ID] });
    const other = subject('rukstroy', { constructionObjectIds: [OTHER_OBJECT_ID] });
    expect(canApproveMechExtension(own, { objectId: OBJECT_ID })).toBe(true);
    expect(canApproveMechExtension(other, { objectId: OBJECT_ID })).toBe(false);
  });

  /**
   * The deliberate difference from the request visa: the department head signs his department's
   * request on its site, but not the further cost of a rental already running there.
   */
  it('the department head never decides, even for his department on its site', () => {
    const head = subject('department_head', {
      departmentIds: [DEPARTMENT_ID],
      departmentObjectIds: [OBJECT_ID],
    });
    expect(canApproveMechExtension(head, { objectId: OBJECT_ID })).toBe(false);
  });

  it('the axis-less administrator decides; a role without the visa does not', () => {
    expect(canApproveMechExtension(subject('admin'), { objectId: OBJECT_ID })).toBe(true);
    expect(canApproveMechExtension(subject('dispatcher'), { objectId: OBJECT_ID })).toBe(false);
    expect(
      canApproveMechExtension(subject('shtab', { constructionObjectIds: [OBJECT_ID] }), {
        objectId: OBJECT_ID,
      }),
    ).toBe(false);
  });

  /**
   * The portal passes the server's list (ADR 0223): a site account holding the visa through an
   * assembled set decides by that list, and the predicate keeps only its scope rule.
   */
  it('the permission comes from the oracle passed in, the scope from the predicate', () => {
    const site = subject('site', { constructionObjectIds: [OBJECT_ID] });
    expect(canApproveMechExtension(site, { objectId: OBJECT_ID })).toBe(false);
    expect(
      canApproveMechExtension(site, { objectId: OBJECT_ID }, listOf('mechRequests.approve')),
    ).toBe(true);
    expect(
      canApproveMechExtension(site, { objectId: OTHER_OBJECT_ID }, listOf('mechRequests.approve')),
    ).toBe(false);
  });
});

describe('what the rental allows', () => {
  it('only a running rental is extended, and only forward', () => {
    expect(mechExtensionRequestBlocker(RUNNING, '2026-10-16')).toBeNull();
    expect(mechExtensionRequestBlocker(RUNNING, '2026-10-15')).toBe(MECH_EXTEND_NOT_LATER_MESSAGE);
    expect(mechExtensionRequestBlocker(RUNNING, '2026-10-01')).toBe(MECH_EXTEND_NOT_LATER_MESSAGE);
    const awaitingIssue = { ...RUNNING, actualFrom: null };
    expect(mechExtensionRequestBlocker(awaitingIssue, '2026-10-20')).toBe(
      MECH_EXTENSION_NOT_RUNNING_MESSAGE,
    );
    const correction = { ...RUNNING, actualTo: '2026-10-10' };
    expect(mechExtensionRequestBlocker(correction, '2026-10-20')).toBe(
      MECH_EXTENSION_NOT_RUNNING_MESSAGE,
    );
    expect(mechExtensionRequestBlocker({ ...RUNNING, status: 'done' }, '2026-10-20')).toBe(
      MECH_EXTENSION_NOT_RUNNING_MESSAGE,
    );
  });

  it('approval re-reads the rental: pending, still running, still the snapshot date', () => {
    expect(mechExtensionApprovalBlocker(RUNNING)).toBeNull();
    expect(mechExtensionApprovalBlocker({ ...RUNNING, extension: null })).toBe(
      MECH_EXTENSION_NOT_PENDING_MESSAGE,
    );
    expect(
      mechExtensionApprovalBlocker({
        ...RUNNING,
        extension: { ...RUNNING.extension!, status: 'rejected' },
      }),
    ).toBe(MECH_EXTENSION_NOT_PENDING_MESSAGE);
    expect(mechExtensionApprovalBlocker({ ...RUNNING, actualFrom: null })).toBe(
      MECH_EXTENSION_ENDED_MESSAGE,
    );
    // The old door moved the term while the request waited.
    expect(mechExtensionApprovalBlocker({ ...RUNNING, plannedTo: '2026-10-18' })).toBe(
      MECH_EXTENSION_TERM_CHANGED_MESSAGE,
    );
  });

  it('the buttons are the same blockers: the visa holder, the dispatcher, the administrator', () => {
    const holder = subject('rukstroy', { constructionObjectIds: [OBJECT_ID] });
    const holderList = listOf('mechRequests.read', 'mechRequests.approve');
    expect(mechExtensionAccess(holder, RUNNING, holderList)).toEqual({
      request: false,
      approve: true,
      reject: true,
      withdraw: false,
      approveBlocker: null,
    });

    const dispatcherList = listOf('mechRequests.read', 'mechRequests.extend');
    expect(mechExtensionAccess(subject('dispatcher'), RUNNING, dispatcherList)).toEqual({
      request: true,
      approve: false,
      reject: false,
      withdraw: true,
      approveBlocker: null,
    });

    // The term changed under the request: the holder may still refuse, not approve, and is told why.
    const changed = { ...RUNNING, plannedTo: '2026-10-18' };
    expect(mechExtensionAccess(holder, changed, holderList)).toMatchObject({
      approve: false,
      reject: true,
      approveBlocker: MECH_EXTENSION_TERM_CHANGED_MESSAGE,
    });

    // Nothing pending: nothing to decide or withdraw, and an archived row offers nothing at all.
    const none = { ...RUNNING, extension: null };
    const admin = listOf('mechRequests.extend', 'mechRequests.approve');
    expect(mechExtensionAccess(subject('admin'), none, admin)).toMatchObject({
      request: true,
      approve: false,
      reject: false,
      withdraw: false,
    });
    expect(
      mechExtensionAccess(subject('admin'), { ...RUNNING, deletedAt: '2026-10-12' }, admin),
    ).toMatchObject({ request: false, approve: false, reject: false, withdraw: false });
  });
});

describe('the bodies of the three doors', () => {
  it('a request needs a date and a reason that is not blank', () => {
    expect(
      requestMechExtensionSchema.safeParse({ plannedTo: '2026-10-20', reason: 'x', version: 1 })
        .success,
    ).toBe(true);
    expect(
      requestMechExtensionSchema.safeParse({ plannedTo: '2026-10-20', reason: '  ', version: 1 })
        .success,
    ).toBe(false);
    // Strict: an unknown key is a client error, not silently ignored.
    expect(
      requestMechExtensionSchema.safeParse({
        plannedTo: '2026-10-20',
        reason: 'x',
        version: 1,
        approved: true,
      }).success,
    ).toBe(false);
  });

  it('a refusal requires its reason, an approval does not', () => {
    expect(decideMechExtensionSchema.parse({ approved: true, version: 3 }).comment).toBe('');
    const refused = decideMechExtensionSchema.safeParse({
      approved: false,
      comment: ' ',
      version: 3,
    });
    expect(refused.success).toBe(false);
    expect(
      decideMechExtensionSchema.safeParse({ approved: false, comment: 'Нет денег', version: 3 })
        .success,
    ).toBe(true);
  });
});

describe('the list tag (R13)', () => {
  it('a running rental with a pending request waits for the visa; a decided one does not', () => {
    const row = { ...RUNNING, approvedAt: '2026-09-30T08:00:00.000Z' };
    expect(mechStateTag(row)).toBe('extensionPending');
    expect(mechStateTagLabels.extensionPending).toBe('продление ждёт визы');
    expect(
      mechStateTag({ ...row, extension: { ...RUNNING.extension!, status: 'approved' } }),
    ).toBeNull();
    expect(mechStateTag({ ...row, extension: null })).toBeNull();
  });
});
