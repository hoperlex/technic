import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  MECH_EXTENSION_TERM_CHANGED_MESSAGE,
  mechExtensionAccess,
  permissionsFor,
  type AuthUser,
  type MechRequestDto,
  type MechRequestExtensionDto,
  type Permission,
  type Role,
} from '@technic/contracts';
import { MechExtensionRequestModal, MechExtensionStrip } from '../src/features/mech-extend';
import { mechMenuItems, type MechMenuOptions } from '../src/pages/mech/mechRequestMenu';
import { typeDate } from './antd';
import { json, mockHttp } from './http';
import { renderWithProps } from './propsDriver';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { mechRequest } from './factories/mech';

/**
 * The extension visa in the portal (ADR 0171, stage 3).
 *
 * Pinned here: the portal of contract 7 never calls the old immediate `PATCH /:id/extend` — release
 * R2 removes it under floor 7, and a bundle depending on it would break then (ADR 0226, S-21); the
 * menu and the card strip offer each action exactly to whom the server allows it, by the server's
 * permission list (ADR 0223); and a request whose term changed under it cannot be approved from
 * the portal, only refused.
 */

const PENDING: MechRequestExtensionDto = {
  status: 'pending',
  newPlannedTo: '2026-10-22',
  previousPlannedTo: '2026-10-15',
  reason: 'Бетонирование сдвинулось',
  requestedBy: 'user-1',
  requestedByName: 'Диспетчеров Д. П.',
  requestedAt: '2026-10-12T08:00:00.000Z',
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  decisionComment: '',
};

/** A running rental: taken in work with a deal and issued. */
const rental = (over: Partial<MechRequestDto> = {}): MechRequestDto =>
  mechRequest({
    status: 'confirmed',
    approvedAt: '2026-10-01T08:00:00.000Z',
    approvedBy: 'user-r',
    approvedByName: 'Прорабов П. П.',
    lessorId: 'cp-1',
    lessorName: 'СтройАренда',
    lessorType: 'mech_lessor',
    rate: 1500,
    rateUnit: 'shift',
    actualFrom: '2026-10-01',
    plannedTo: '2026-10-15',
    ...over,
  });

const userOf = (role: Role, over: Partial<AuthUser> = {}): AuthUser =>
  authUser({ id: `user-${role}`, role, ...over });

function menuKeys(user: AuthUser, request: MechRequestDto): string[] {
  const noop = () => {};
  const granted = new Set<Permission>(user.permissions);
  const options: MechMenuOptions = {
    user,
    can: (permission) => granted.has(permission),
    open: {
      takeInWork: noop,
      editDeal: noop,
      issue: noop,
      revokeIssue: noop,
      extend: noop,
      decideExtension: noop,
      complete: noop,
      cancel: noop,
      rollbackToNew: noop,
    },
    run: {
      rollback: noop,
      setApproval: noop,
      duplicate: noop,
      remove: noop,
      withdrawExtension: noop,
    },
  };
  return mechMenuItems(request, options).map((item) => `${item.key}:${item.label}`);
}

describe('menu of a running rental', () => {
  const holder = userOf('rukstroy', { constructionObjectIds: ['obj-1'] });
  const dispatcher = userOf('dispatcher');

  it('the dispatcher asks; with a pending request he changes or withdraws it', () => {
    expect(menuKeys(dispatcher, rental())).toContain('extend:Запросить продление');
    const pending = menuKeys(dispatcher, rental({ extension: PENDING }));
    expect(pending).toContain('extend:Изменить запрос продления');
    expect(pending).toContain('extension:withdraw:Отозвать запрос продления');
    expect(pending.some((key) => key.startsWith('extension:approve'))).toBe(false);
  });

  it('the site visa holder decides and does not ask; the department head does neither', () => {
    const keys = menuKeys(holder, rental({ extension: PENDING }));
    expect(keys).toContain('extension:approve:Согласовать продление');
    expect(keys).toContain('extension:reject:Отклонить продление');
    expect(keys.some((key) => key.startsWith('extend:'))).toBe(false);

    const head = userOf('department_head', {
      departmentIds: ['dep-1'],
      departmentObjectIds: ['obj-1'],
    });
    const headKeys = menuKeys(head, rental({ departmentId: 'dep-1', extension: PENDING }));
    expect(headKeys.some((key) => key.startsWith('extension:'))).toBe(false);
  });

  /** The server's list, not the role: a site account with the visa set decides by its list. */
  it('a visa assembled in a set counts by the list the server sent', () => {
    const site = userOf('site', {
      constructionObjectIds: ['obj-1'],
      permissions: [
        ...permissionsFor({ role: 'site' }),
        'mechRequests.read',
        'mechRequests.approve',
      ],
    });
    expect(menuKeys(site, rental({ extension: PENDING }))).toContain(
      'extension:approve:Согласовать продление',
    );
  });

  it('the term changed under the request: refusal only', () => {
    const changed = rental({ plannedTo: '2026-10-18', extension: PENDING });
    const keys = menuKeys(holder, changed);
    expect(keys.some((key) => key.startsWith('extension:approve'))).toBe(false);
    expect(keys).toContain('extension:reject:Отклонить продление');
  });
});

describe('the card strip', () => {
  it('names the date, the reason and who asked; buttons follow the access', () => {
    const holder = userOf('rukstroy', { constructionObjectIds: ['obj-1'] });
    const request = rental({ extension: PENDING });
    const granted = new Set<Permission>(holder.permissions);
    const onApprove = vi.fn();
    renderWithUser(
      <MechExtensionStrip
        request={request}
        access={mechExtensionAccess(holder, request, (p) => granted.has(p))}
        onApprove={onApprove}
        onReject={() => {}}
        onWithdraw={() => {}}
      />,
    );
    expect(screen.getByText('Продление до 22.10.2026 ждёт визы площадки')).toBeTruthy();
    expect(screen.getByText(/Бетонирование сдвинулось/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Отозвать запрос' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Согласовать' }));
    expect(onApprove).toHaveBeenCalledWith(request);
  });

  it('a term changed under the request says why the visa is not offered', () => {
    const holder = userOf('rukstroy', { constructionObjectIds: ['obj-1'] });
    const request = rental({ plannedTo: '2026-10-18', extension: PENDING });
    const granted = new Set<Permission>(holder.permissions);
    renderWithUser(
      <MechExtensionStrip
        request={request}
        access={mechExtensionAccess(holder, request, (p) => granted.has(p))}
        onApprove={() => {}}
        onReject={() => {}}
        onWithdraw={() => {}}
      />,
    );
    expect(screen.getByText(MECH_EXTENSION_TERM_CHANGED_MESSAGE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Согласовать' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeTruthy();
  });
});

describe('the request window', () => {
  it('asks through POST /:id/extension and never through the old /extend', async () => {
    const request = rental();
    const http = mockHttp({
      'POST /mech-requests/:id/extension': () =>
        json({ ...request, version: request.version + 1, extension: PENDING }),
    });
    renderWithProps(MechExtensionRequestModal, {
      request: request as MechRequestDto | null,
      onClose: () => {},
    });

    typeDate('Новая дата возврата', '22.10.2026');
    fireEvent.change(screen.getByLabelText('Причина продления'), {
      target: { value: 'Бетонирование сдвинулось' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запросить продление' }));

    await waitFor(() => expect(http.countOf('POST /mech-requests/:id/extension')).toBe(1));
    expect(http.lastCall('POST /mech-requests/:id/extension')?.body).toEqual({
      plannedTo: '2026-10-22',
      reason: 'Бетонирование сдвинулось',
      version: request.version,
    });
    expect(http.calls.some((call) => call.path.endsWith('/extend'))).toBe(false);
  });
});
