import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../src/auth/AuthContext';

import { apiError, json, mockHttp } from './http';
import { renderWithSession } from './render';
import { authUser, loginResponse } from './factories/auth';
import { list } from './factories/common';
import { objectDto } from './factories/waste';
import { objectsApi } from '@entities/object';

/**
 * Сессия кончилась сама — и следом вошёл другой человек.
 *
 * Отличие от обычного выхода принципиальное: при истечении портал обнуляет пользователя сам, и
 * сравнивать вход следующего было бы не с чем, если бы владельца кэша хранил только React.
 * Поэтому здесь проверяется именно та ветка, где выхода не было: refresh не прошёл, а данные
 * предыдущего остались бы в кэше до самого протухания.
 */

const FIRST = authUser({ id: 'user-a', email: 'a@example.test' });
const SECOND = authUser({ id: 'user-b', email: 'b@example.test', lastName: 'Второв' });

function ObjectsProbe() {
  const { user, status, login } = useAuth();
  const { data, refetch } = useQuery({
    queryKey: ['objects', 'for-select'],
    queryFn: () => objectsApi.list({ page: 1, pageSize: 500 }),
    enabled: !!user,
    staleTime: 10 * 60 * 1000,
  });
  return (
    <div>
      <div data-testid="who">{user?.email ?? 'никто'}</div>
      <div data-testid="status">{status}</div>
      <div data-testid="objects">{(data?.items ?? []).map((o) => o.name).join(', ')}</div>
      <button type="button" onClick={() => void refetch()}>
        обновить список
      </button>
      <button type="button" onClick={() => void login(SECOND.email, 'pass')}>
        войти вторым
      </button>
    </div>
  );
}

describe('истечение сессии и вход другой учётки', () => {
  it('после протухшего refresh данные предыдущего пользователя не достаются следующему', async () => {
    const http = mockHttp({
      'POST /auth/refresh': () => json(loginResponse(FIRST)),
      'GET /auth/me': () => json(FIRST),
      'POST /auth/login': () => json(loginResponse(SECOND)),
      'GET /objects': () => json(list([objectDto({ id: 'obj-a', name: 'Объект первого' })])),
    });

    renderWithSession(<ObjectsProbe />);
    await screen.findByText('a@example.test');
    await waitFor(() => expect(screen.getByTestId('objects').textContent).toBe('Объект первого'));

    /*
     * Сессия кончается посреди работы: сервер отвечает 401, а обновить токен уже нечем — refresh
     * истёк или отозван. Портал уводит на вход сам, выхода как действия не было.
     */
    http.use({
      'GET /objects': () =>
        apiError(401, { code: 'unauthorized', message: 'Требуется авторизация' }),
      'POST /auth/refresh': () =>
        apiError(401, { code: 'unauthorized', message: 'Сессия истекла' }),
    });
    screen.getByText('обновить список').click();

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthenticated'));
    expect(screen.getByTestId('objects').textContent).toBe('');

    // За тот же компьютер садится другой человек и входит своей учёткой.
    http.use({
      'GET /objects': () => json(list([objectDto({ id: 'obj-b', name: 'Объект второго' })])),
    });
    screen.getByText('войти вторым').click();

    await screen.findByText('b@example.test');
    await waitFor(() => expect(screen.getByTestId('objects').textContent).toBe('Объект второго'));
    // Именно здесь ломалось прежнее сравнение «с текущим пользователем»: к моменту входа он уже
    // был пуст, кэш первого признавался своим и второму показывались чужие объекты.
    expect(screen.getByTestId('objects').textContent).not.toContain('первого');
  });
});
