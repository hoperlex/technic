import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useAuth } from '../src/auth/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { objectsApi } from '../src/api/resources';
import { json, mockHttp } from './http';
import { renderWithSession } from './render';
import { authUser, loginResponse } from './factories/auth';
import { list } from './factories/common';
import { objectDto } from './factories/waste';

/**
 * Смена пользователя на одном рабочем месте.
 *
 * Ключи запросов учётку не содержат, а справочники живут в кэше минутами, поэтому вошедший
 * следующим увидел бы данные предыдущего — не «свои пустые», а именно чужие. На стройке это одно
 * и то же место у прораба и диспетчера, поэтому проверяется не «удобно», а «не показывает чужого».
 */

const FIRST = authUser({ id: 'user-a', email: 'a@example.test' });
const SECOND = authUser({ id: 'user-b', email: 'b@example.test', lastName: 'Второв' });

/** Экран, который держит в кэше справочник объектов и показывает, чей он. */
function ObjectsProbe() {
  const { user, login, logout } = useAuth();
  const { data } = useQuery({
    queryKey: ['objects', 'for-select'],
    queryFn: () => objectsApi.list({ page: 1, pageSize: 500 }),
    enabled: !!user,
    staleTime: 10 * 60 * 1000,
  });
  return (
    <div>
      <div data-testid="who">{user?.email ?? 'никто'}</div>
      <div data-testid="objects">{(data?.items ?? []).map((o) => o.name).join(', ')}</div>
      <button type="button" onClick={() => void logout()}>
        выйти
      </button>
      <button type="button" onClick={() => void login(SECOND.email, 'pass')}>
        войти вторым
      </button>
    </div>
  );
}

describe('смена пользователя на одном рабочем месте', () => {
  it('после выхода и входа другой учётки список запрашивается заново и чужого не показывает', async () => {
    const http = mockHttp({
      // Вкладка открывается уже вошедшей: bootstrap меняет refresh-cookie на токен и спрашивает,
      // кто это.
      'POST /auth/refresh': () => json(loginResponse(FIRST)),
      'GET /auth/me': () => json(FIRST),
      'POST /auth/logout': () => json({ ok: true }),
      'POST /auth/login': () => json(loginResponse(SECOND)),
      'GET /objects': () => json(list([objectDto({ id: 'obj-a', name: 'Объект первого' })])),
    });

    renderWithSession(<ObjectsProbe />);

    await screen.findByText('a@example.test');
    await waitFor(() => expect(screen.getByTestId('objects').textContent).toBe('Объект первого'));
    expect(http.countOf('GET /objects')).toBe(1);

    // Второй пользователь работает на тех же объектах не обязательно: сервер отдаст ему своё.
    http.use({
      'GET /objects': () => json(list([objectDto({ id: 'obj-b', name: 'Объект второго' })])),
    });

    screen.getByText('выйти').click();
    await screen.findByText('никто');
    // Данные предыдущего исчезают сразу с выходом, а не «когда-нибудь протухнут».
    expect(screen.getByTestId('objects').textContent).toBe('');

    screen.getByText('войти вторым').click();
    await screen.findByText('b@example.test');

    await waitFor(() => expect(screen.getByTestId('objects').textContent).toBe('Объект второго'));
    expect(http.countOf('GET /objects')).toBe(2);
  });
});
