import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { SHELL_SECTIONS } from '@technic/contracts';
import App from '../src/App';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { json, mockHttp } from './http';

const loading = vi.hoisted(() => ({
  requested: [] as string[],
  resolve: new Map<string, () => void>(),
}));

// Public page entries are controlled promises, not private page mocks. This tests the actual App
// routing/layout tree while manifest checks prove that the production factories split the code.
async function page(id: string) {
  const { createElement, lazy } = await import('react');
  return lazy(
    () =>
      new Promise<{ default: () => ReturnType<typeof createElement> }>((resolve) => {
        loading.requested.push(id);
        loading.resolve.set(id, () =>
          resolve({ default: () => createElement('h1', null, `Loaded ${id}`) }),
        );
      }),
  );
}

vi.mock('@pages/admin', async () => ({ AdministrationPage: await page('admin') }));
vi.mock('@pages/directories', async () => ({ DirectoriesPage: await page('directories') }));
vi.mock('@pages/garage', async () => ({ GaragePage: await page('garage') }));
vi.mock('@pages/mech', async () => ({ MechRequestsPage: await page('mechanization') }));
vi.mock('@pages/service', async () => ({ ServiceRequestsPage: await page('office-equipment') }));
vi.mock('@pages/vehicle', async () => ({
  VehicleRequestsPage: await page('vehicle-requests'),
  WeeklyRequestPage: await page('weekly'),
  VehicleRequestViewModal: await page('request-card'),
}));
vi.mock('@pages/waste', async () => ({ WasteRequestsPage: await page('waste') }));
vi.mock('@pages/waybills', async () => ({ WaybillsPage: await page('waybills') }));

beforeEach(() => {
  mockHttp({
    'GET /releases': () => json([]),
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /service-requests/waiting-count': () => json({ count: 0 }),
    'GET /service-requests/unread-count': () => json({ count: 0 }),
  });
});

describe('права проверяются раньше ленивого входа', () => {
  it.each(SHELL_SECTIONS)('$id: закрытый прямой адрес не запрашивает модуль', async (section) => {
    renderWithUser(<App />, {
      route: section.path,
      user: authUser({ role: 'commandant', permissions: [], constructionObjectIds: [] }),
    });

    expect(await screen.findByText('Разделы портала вам пока не назначены')).toBeDefined();
    expect(loading.requested).toEqual([]);
  });
});

describe('восемь публичных входов под постоянным каркасом', () => {
  it.each(SHELL_SECTIONS)('$id: холодный прямой вход оставляет меню на экране', async (section) => {
    const previous = [...loading.requested];
    const user = authUser({ role: 'admin' });
    renderWithUser(<App />, { route: section.path, user });

    const shell = document.querySelector('.ant-layout-sider');
    expect(shell).not.toBeNull();
    expect(screen.getByText(user.fullName)).toBeDefined();
    await waitFor(() => expect(loading.requested).toEqual([...previous, section.id]));
    expect(screen.queryByRole('heading', { name: `Loaded ${section.id}` })).toBeNull();
    expect(document.querySelector('.ant-spin-spinning')).not.toBeNull();

    await act(async () => loading.resolve.get(section.id)!());
    expect(await screen.findByRole('heading', { name: `Loaded ${section.id}` })).toBeDefined();
    expect(document.querySelector('.ant-layout-sider')).toBe(shell);
    expect(screen.getByText(user.fullName)).toBeDefined();
  });

  it('повторный вход использует загруженную фабрику без нового запроса модуля', async () => {
    const previous = [...loading.requested];
    renderWithUser(<App />, { route: '/garage', user: authUser({ role: 'admin' }) });
    expect(await screen.findByRole('heading', { name: 'Loaded garage' })).toBeDefined();
    expect(loading.requested).toEqual(previous);
    expect(loading.requested).not.toContain('weekly');
    expect(loading.requested).not.toContain('request-card');
  });
});
