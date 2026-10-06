import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { UserAccountDto } from '@technic/contracts';
import { DriverRestoreModal, personFactsOf } from '@features/user-account-editor';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';

/**
 * Restoring an archived driver account asks for the employee card (R8). The page rebuilds the
 * window's account facts on every render and re-renders while the restore request is pending and
 * after a refusal; the picked employee must survive those renders, or the admin cannot retry.
 */

const ARCHIVED_DRIVER = {
  id: 'u-driver',
  email: 'driver@su10.ru',
  lastName: 'Рулёв',
  firstName: 'Пётр',
  middleName: 'Ильич',
  fullName: 'Рулёв Пётр Ильич',
  phone: '',
  role: 'driver',
  person: null,
  deletedAt: '2026-09-01T10:00:00.000Z',
} as unknown as UserAccountDto;

const CANDIDATE = {
  id: 'p-1',
  lastName: 'Рулёв',
  firstName: 'Пётр',
  middleName: 'Ильич',
  fullName: 'Рулёв Пётр Ильич',
  phone: '',
  email: '',
  jobTitle: 'Водитель',
  matchedBy: ['name'],
};

function Harness() {
  const [pending, setPending] = useState(false);
  return (
    <>
      <button onClick={() => setPending((p) => !p)}>Перерисовать</button>
      <DriverRestoreModal
        account={personFactsOf(ARCHIVED_DRIVER)}
        confirmLoading={pending}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />
    </>
  );
}

describe('восстановление учётки водителя', () => {
  it('выбранный работник переживает перерисовку окна во время запроса', async () => {
    mockHttp({ 'GET /users/person-candidates': () => json({ items: [CANDIDATE] }) });
    renderWithUser(<Harness />, { user: authUser({ role: 'admin' }) });

    const field = await screen.findByRole('combobox');
    fireEvent.mouseDown(field);
    await waitFor(() => {
      const option = [...document.querySelectorAll('.ant-select-item-option')].find((o) =>
        o.textContent?.includes('Рулёв Пётр Ильич'),
      );
      expect(option).toBeTruthy();
      fireEvent.click(option!);
    });
    const picked = () =>
      document.querySelector('.ant-modal .ant-select-content')?.getAttribute('title') ?? null;
    await waitFor(() => expect(picked()).toBe('Рулёв Пётр Ильич'));

    // The page re-renders with a fresh facts object, as it does when the restore request starts
    // and when it fails.
    fireEvent.click(screen.getByRole('button', { name: 'Перерисовать' }));
    fireEvent.click(screen.getByRole('button', { name: 'Перерисовать' }));

    expect(picked()).toBe('Рулёв Пётр Ильич');
  });
});
