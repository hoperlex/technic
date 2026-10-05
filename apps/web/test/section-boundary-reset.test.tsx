import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import App from '../src/App';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { json, mockHttp } from './http';

// Public page entries replaced by plain screens: the test is about App's boundary per section, not
// about any page. The waste page fails on render the way an ordinary bug would.
vi.mock('@pages/waste', () => ({
  WasteRequestsPage: () => {
    throw new Error('render bug');
  },
}));
vi.mock('@pages/garage', () => ({ GaragePage: () => <h1>Loaded garage</h1> }));
vi.mock('@pages/admin', () => ({ AdministrationPage: () => <h1>Loaded admin</h1> }));
vi.mock('@pages/directories', () => ({ DirectoriesPage: () => <h1>Loaded directories</h1> }));
vi.mock('@pages/mech', () => ({ MechRequestsPage: () => <h1>Loaded mechanization</h1> }));
vi.mock('@pages/service', () => ({ ServiceRequestsPage: () => <h1>Loaded office equipment</h1> }));
vi.mock('@pages/waybills', () => ({ WaybillsPage: () => <h1>Loaded waybills</h1> }));
vi.mock('@pages/vehicle', () => ({
  VehicleRequestsPage: () => <h1>Loaded vehicle requests</h1>,
  WeeklyRequestPage: () => <h1>Loaded weekly</h1>,
  VehicleRequestViewModal: () => null,
}));

afterEach(() => vi.restoreAllMocks());

describe('граница раздела', () => {
  it('ошибка рендера одного раздела не остаётся на экране другого', async () => {
    // React reports the caught render error; the assertions check what the user sees.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockHttp({
      'GET /releases': () => json([]),
      'GET /users/pending-count': () => json({ count: 0 }),
      'GET /service-requests/waiting-count': () => json({ count: 0 }),
      'GET /service-requests/unread-count': () => json({ count: 0 }),
    });
    renderWithUser(<App />, { route: '/waste', user: authUser({ role: 'admin' }) });

    expect(await screen.findByText('Не удалось открыть экран')).toBeDefined();

    const menu = document.querySelector('.ant-layout-sider')!;
    const garage = [...menu.querySelectorAll<HTMLElement>('.ant-menu-item')].find((item) =>
      item.textContent?.includes('Гараж'),
    );
    expect(garage, 'пункт «Гараж» в меню').toBeTruthy();
    fireEvent.click(garage!);

    expect(await screen.findByRole('heading', { name: 'Loaded garage' })).toBeDefined();
    expect(screen.queryByText('Не удалось открыть экран')).toBeNull();
  });
});
