import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { useAuth } from '@entities/session';
import { objectsApi } from '@entities/object';
import { isApiError } from '@shared/api';
import { ProtectedRoute } from '../src/app/routing/ProtectedRoute';

import { apiError, json, mockHttp } from './http';
import { renderWithSession } from './render';
import { authUser, loginResponse } from './factories/auth';
import { list } from './factories/common';
import { objectDto } from './factories/waste';

/**
 * The server cannot answer for a while (a failover, a dropped connection; ADR 0233).
 *
 * The refresh cookie outlives such a burst: the API keeps it on any failure that is not a verdict
 * on the token. So the tab must not treat "no answer" as "session over". It used to: a page reload
 * during the burst showed the login form, and a 401 in the middle of work threw the person out of
 * a half-filled form.
 */

const USER = authUser({ id: 'user-a', email: 'a@example.test' });

const dbUnavailable = () =>
  apiError(503, {
    code: 'db_unavailable',
    message: 'База данных временно недоступна. Повторите через несколько секунд.',
  });

/** The first retry comes a second after the failure. */
const FIRST_RETRY = { timeout: 3_000 };

function Portal() {
  return (
    <Routes>
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<div>портал</div>} />
      </Route>
      <Route path="/login" element={<div>форма входа</div>} />
    </Routes>
  );
}

describe('the tab opens while the server cannot answer', () => {
  it('waits for the server instead of showing the login form, then lets the person in', async () => {
    let refreshes = 0;
    mockHttp({
      'POST /auth/refresh': () => (++refreshes === 1 ? dbUnavailable() : json(loginResponse(USER))),
      'GET /auth/me': () => json(USER),
    });

    renderWithSession(<Portal />);

    expect(await screen.findByText(/Нет связи с сервером/)).toBeTruthy();
    expect(screen.queryByText('форма входа')).toBeNull();

    expect(await screen.findByText('портал', {}, FIRST_RETRY)).toBeTruthy();
    expect(screen.queryByText(/Нет связи с сервером/)).toBeNull();
    expect(refreshes).toBe(2);
  });

  it('treats no answer at all the same way, and a verdict after it as a verdict', async () => {
    let refreshes = 0;
    mockHttp({
      'POST /auth/refresh': () => {
        refreshes += 1;
        // A rejected fetch: what the browser gives when nothing answers.
        if (refreshes === 1) throw new TypeError('Failed to fetch');
        return apiError(401, { code: 'unauthorized', message: 'refresh-токен истёк' });
      },
    });

    renderWithSession(<Portal />);

    expect(await screen.findByText(/Нет связи с сервером/)).toBeTruthy();
    // The server came back and said the cookie is dead: that is the login form, as before.
    expect(await screen.findByText('форма входа', {}, FIRST_RETRY)).toBeTruthy();
  });

  it('still sends a dead session straight to the login form, without waiting', async () => {
    const http = mockHttp({
      'POST /auth/refresh': () =>
        apiError(401, { code: 'unauthorized', message: 'refresh-токен истёк' }),
    });

    renderWithSession(<Portal />);

    expect(await screen.findByText('форма входа')).toBeTruthy();
    expect(screen.queryByText(/Нет связи с сервером/)).toBeNull();
    expect(http.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });
});

function SignInProbe() {
  const { user, status, login } = useAuth();
  return (
    <div>
      <div data-testid="who">{user?.email ?? 'никто'}</div>
      <div data-testid="status">{status}</div>
      <button type="button" onClick={() => void login(USER.email, 'pass')}>
        войти
      </button>
    </div>
  );
}

describe('signing in while the tab is still waiting for the server', () => {
  it('the waiting run hands over to the sign-in instead of signing the person out', async () => {
    const http = mockHttp({
      'POST /auth/refresh': dbUnavailable,
      'POST /auth/login': () => json(loginResponse(USER)),
    });

    renderWithSession(<SignInProbe />);
    await waitFor(() => expect(http.calls.some((c) => c.path === '/auth/refresh')).toBe(true));

    screen.getByText('войти').click();
    await screen.findByText('a@example.test');

    // Past the first retry: the waiting run wakes up, sees it was replaced and asks nothing more.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    expect(screen.getByTestId('who').textContent).toBe('a@example.test');
    expect(http.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });
});

function ObjectsProbe() {
  const { user, status } = useAuth();
  return (
    <div>
      <div data-testid="who">{user?.email ?? 'никто'}</div>
      <div data-testid="status">{status}</div>
    </div>
  );
}

async function listObjects(): Promise<string> {
  try {
    const page = await objectsApi.list({ page: 1, pageSize: 50 });
    return page.items.map((o) => o.name).join(', ');
  } catch (e) {
    return isApiError(e) ? `${e.code}: ${e.message}` : String(e);
  }
}

describe('the token expires while the server cannot answer', () => {
  it('keeps the session and fails only the action, which works again after recovery', async () => {
    const http = mockHttp({
      'POST /auth/refresh': () => json(loginResponse(USER)),
      'GET /auth/me': () => json(USER),
    });

    renderWithSession(<ObjectsProbe />);
    await screen.findByText('a@example.test');

    http.use({
      'GET /objects': () =>
        apiError(401, { code: 'unauthorized', message: 'Требуется авторизация' }),
      'POST /auth/refresh': dbUnavailable,
    });
    const failed = await listObjects();

    expect(failed).toBe(
      'server_unreachable: Нет связи с сервером. Повторите через несколько секунд.',
    );
    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    expect(screen.getByTestId('who').textContent).toBe('a@example.test');

    // The server is back: the next request gets its 401 again and refreshes by itself.
    let objectCalls = 0;
    http.use({
      'GET /objects': () =>
        ++objectCalls === 1
          ? apiError(401, { code: 'unauthorized', message: 'Требуется авторизация' })
          : json(list([objectDto({ id: 'obj-a', name: 'Объект первого' })])),
      'POST /auth/refresh': () => json(loginResponse(USER)),
    });

    await waitFor(async () => expect(await listObjects()).toBe('Объект первого'));
    expect(screen.getByTestId('status').textContent).toBe('authenticated');
  });
});
