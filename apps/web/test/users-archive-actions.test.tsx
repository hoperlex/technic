import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserAccountDto } from '@technic/contracts';
import { json, mockHttp, type MockResponse } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { UsersTab } from '../src/pages/admin/UsersTab';

/**
 * Buttons of an archived account row (ADR 0063): restore and purge.
 *
 * The row is drawn with icon buttons rather than a menu, and the command must show its own
 * pending state there. Without it a double click on "restore" for a non-driver account sends two
 * requests (the second one fails on an already restored record), and a purge in flight has no
 * visible progress at all.
 */

const ARCHIVED: UserAccountDto = {
  id: 'u-arch',
  email: 'archived@su10.ru',
  lastName: 'Архивов',
  firstName: 'Антон',
  middleName: 'Петрович',
  fullName: 'Архивов Антон Петрович',
  phone: '',
  requestedRole: null,
  requestedObject: '',
  requestedCompany: '',
  requestedComment: '',
  role: 'manager',
  isActive: false,
  mustChangePassword: false,
  emailVerifiedAt: '2026-08-01T10:00:00.000Z',
  constructionObjects: [],
  departments: [],
  addons: [],
  grantCodes: [],
  grants: [],
  permissions: [],
  counterpartyId: null,
  counterpartyName: null,
  counterpartyType: null,
  person: null,
  deletedAt: '2026-09-01T10:00:00.000Z',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

async function archivedButton(title: string): Promise<HTMLElement> {
  return waitFor(() => {
    const row = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(ARCHIVED.email),
    );
    const button = row?.querySelector<HTMLElement>(`button[title="${title}"]`);
    if (!button) throw new Error(`no "${title}" button in the archived row`);
    return button;
  });
}

/** Render the tab for an admin; the given command route answers only when released. */
function renderHeld(route: string) {
  let release: (response: MockResponse) => void = () => undefined;
  const http = mockHttp({
    'GET /users': () => json(list([ARCHIVED])),
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    [route]: () =>
      new Promise<MockResponse>((resolve) => {
        release = resolve;
      }),
  });
  renderWithUser(<UsersTab />, { user: authUser({ id: 'me-1', role: 'admin' }) });
  return { http, release: (response: MockResponse) => release(response) };
}

describe('archived account row', () => {
  it('restore stays loading while the request is in flight and ignores a second click', async () => {
    const { http, release } = renderHeld('POST /users/:id/restore');

    fireEvent.click(await archivedButton('Восстановить'));
    const restoreButton = await archivedButton('Восстановить');
    await waitFor(() => expect(restoreButton.classList.contains('ant-btn-loading')).toBe(true));
    fireEvent.click(restoreButton);
    expect(http.countOf('POST /users/:id/restore')).toBe(1);

    release(json({ ...ARCHIVED, deletedAt: null }));
    await waitFor(() =>
      expect(document.querySelector('.ant-btn-loading[title="Восстановить"]')).toBeNull(),
    );
    expect(http.countOf('POST /users/:id/restore')).toBe(1);
  });

  it('purge shows its pending state on the row button', async () => {
    const { http, release } = renderHeld('DELETE /users/:id/purge');

    fireEvent.click(await archivedButton('Удалить окончательно'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить окончательно' }));
    const purgeButton = await archivedButton('Удалить окончательно');
    await waitFor(() => expect(purgeButton.classList.contains('ant-btn-loading')).toBe(true));
    expect(http.countOf('DELETE /users/:id/purge')).toBe(1);

    release(json({ ok: true }));
    await waitFor(() =>
      expect(document.querySelector('.ant-btn-loading[title="Удалить окончательно"]')).toBeNull(),
    );
  });
});
