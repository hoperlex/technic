import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { MOBILE_VIEWPORT } from './viewport';
import { VehiclesTab } from '@pages/directories';
import { UsersTab } from '../src/pages/admin/UsersTab';

function sheetRow(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.filter-sheet__row')].find(
    (row) => row.querySelector('.filter-sheet__label')?.textContent === label,
  );
}

async function choose(label: string, option: string) {
  const row = sheetRow(label);
  expect(row, label).toBeTruthy();
  fireEvent.mouseDown(row!.querySelector('.ant-select-content')!);
  await waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
      (node) => node.textContent?.includes(option),
    );
    expect(match, option).toBeTruthy();
    fireEvent.click(match!);
  });
}

describe('dependent phone filters', () => {
  it('switches rental fields and drops an owned-vehicle status before Apply', async () => {
    const http = mockHttp({
      'GET /vehicles': () => json(emptyList()),
      'GET /vehicle-types': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
      'GET /vehicle-classifications': () => json(emptyList()),
    });
    renderWithUser(<VehiclesTab />, { viewport: MOBILE_VIEWPORT });
    await waitFor(() => expect(http.countOf('GET /vehicles')).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /Фильтры/ }));
    await choose('Статус', 'Обслуживание');
    await choose('Принадлежность', 'Аренда');
    expect(sheetRow('Арендодатель')).toBeDefined();
    expect(sheetRow('Статус')?.querySelector('.ant-select-selection-item')).toBeNull();
    expect(http.countOf('GET /vehicles')).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() =>
      expect(http.lastCall('GET /vehicles')?.query.get('ownership')).toBe('rental'),
    );
    expect(http.lastCall('GET /vehicles')?.query.has('status')).toBe(false);
  });

  it('shows requested role as soon as pending mode is chosen', async () => {
    const http = mockHttp({
      'GET /users': () => json(emptyList()),
      'GET /users/pending-count': () => json({ count: 0 }),
      'GET /objects': () => json(emptyList()),
      'GET /counterparties': () => json(emptyList()),
    });
    renderWithUser(<UsersTab />, {
      user: authUser({ role: 'admin' }),
      viewport: MOBILE_VIEWPORT,
    });
    await waitFor(() => expect(http.countOf('GET /users')).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: /Фильтры/ }));
    expect(sheetRow('Пожелание при регистрации')).toBeUndefined();
    fireEvent.click(sheetRow('Только ожидающие активации')!.querySelector('[role="switch"]')!);
    expect(sheetRow('Пожелание при регистрации')).toBeDefined();
    await choose('Пожелание при регистрации', 'Диспетчер');
    expect(http.countOf('GET /users')).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(http.lastCall('GET /users')?.query.get('pending')).toBe('true'));
    expect(http.lastCall('GET /users')?.query.get('requestedRole')).toBe('dispatcher');
  });
});
