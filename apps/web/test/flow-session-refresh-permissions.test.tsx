import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { AuthUser, Permission } from '@technic/contracts';
import { useAuth } from '../src/auth/AuthContext';
import {
  __resetSessionForTests,
  apiFetch,
  clear as clearSession,
  onRefreshedUser,
  refresh,
  startSession,
} from '../src/shared/api';

import { apiError, json, mockHttp } from './http';
import { renderWithSession } from './render';
import { authUser, loginResponse } from './factories/auth';

/**
 * Обновление токена меняет доступ на экране, а не только сам токен.
 *
 * Права считает сервер (ADR 0106, этап 2), и обновление — единственное место, где он сообщает их
 * посреди работы: администратор пересобрал выдачу, `authVersion` вырос, следующий запрос упёрся в
 * 401 — и вернувшийся ответ несёт уже другой набор. Пока портал брал из этого ответа один токен,
 * сервер начинал отвечать по-новому, а меню и кнопки оставались прежними до перезагрузки страницы:
 * человек либо видел раздел, в который его больше не пускают, либо не видел только что открытого.
 *
 * Проверяется именно смена без перезагрузки: `/auth/me` второй раз не спрашивают.
 */

const OBJECT_A = '11111111-1111-1111-1111-111111111111';

const withGranted = (user: AuthUser, ...extra: Permission[]): AuthUser => ({
  ...user,
  permissions: [...user.permissions, ...extra],
});

const withRevoked = (user: AuthUser, ...gone: Permission[]): AuthUser => ({
  ...user,
  permissions: user.permissions.filter((p) => !gone.includes(p)),
});

/**
 * Экран, который показывает своё право и умеет сходить в сеть. Запрос — обычный, не про доступ:
 * обновление токена случается посреди работы, а не в ответ на желание узнать права.
 */
function AccessProbe() {
  const { user, can } = useAuth();
  return (
    <div>
      <div data-testid="who">{user?.email ?? 'никто'}</div>
      <div data-testid="directories">{can('directories.write') ? 'есть' : 'нет'}</div>
      <button type="button" onClick={() => void apiFetch('/objects').catch(() => {})}>
        обновить список
      </button>
    </div>
  );
}

/**
 * Вкладка открыта вошедшей учёткой `before`, а следующее обновление токена вернёт `after`.
 * Первый refresh — это bootstrap вкладки, поэтому учётку меняет второй.
 */
function mountWith(before: AuthUser, after: AuthUser) {
  let refreshes = 0;
  let objectCalls = 0;
  const http = mockHttp({
    'POST /auth/refresh': () => {
      refreshes += 1;
      return json(loginResponse(refreshes === 1 ? before : after));
    },
    'GET /auth/me': () => json(before),
    // Первый запрос упирается в 401 — сервер уже считает по новому набору; после обновления тот же
    // запрос проходит.
    'GET /objects': () => {
      objectCalls += 1;
      return objectCalls === 1
        ? apiError(401, { code: 'unauthorized', message: 'Требуется авторизация' })
        : json({ items: [], total: 0, page: 1, pageSize: 100 });
    },
  });
  renderWithSession(<AccessProbe />);
  return http;
}

describe('учётка из обновления токена доезжает до интерфейса', () => {
  it('выданное набором право открывает раздел без перезагрузки страницы', async () => {
    const before = authUser({
      role: 'shtab',
      email: 'shtab@example.test',
      constructionObjectIds: [OBJECT_A],
    });
    const http = mountWith(before, withGranted(before, 'directories.write'));

    await screen.findByText('shtab@example.test');
    expect(screen.getByTestId('directories').textContent).toBe('нет');

    screen.getByText('обновить список').click();

    // Сначала дожидаемся самого обновления, и только потом смотрим на экран: два ожидания вместо
    // одного дают запросам своё окно — на занятой машине рендер и сеть в одно не всегда влезают.
    await waitFor(() => expect(http.countOf('POST /auth/refresh')).toBe(2));
    await waitFor(() => expect(screen.getByTestId('directories').textContent).toBe('есть'));
    // Ни перезагрузки, ни повторного «кто я»: доступ обновился тем же ответом, что и токен.
    expect(http.countOf('GET /auth/me')).toBe(1);
    // Запрос, который упёрся в 401, всё-таки прошёл: обновление не подменяет работу человека.
    expect(http.countOf('GET /objects')).toBe(2);
  });

  it('снятое право закрывает раздел так же — учётка та же, роль прежняя', async () => {
    const before = authUser();
    const after = withRevoked(before, 'directories.write');
    // Роль не менялась: сервер отдал другой набор, а не другую должность.
    expect(after.role).toBe(before.role);
    const http = mountWith(before, after);

    await screen.findByText('dispatcher@example.test');
    expect(screen.getByTestId('directories').textContent).toBe('есть');

    screen.getByText('обновить список').click();

    await waitFor(() => expect(http.countOf('POST /auth/refresh')).toBe(2));
    await waitFor(() => expect(screen.getByTestId('directories').textContent).toBe('нет'));
  });

  it('учётка из чужого обновления до подписчиков не доходит', async () => {
    // Та же гонка, ради которой у сессии есть номер (`flow-session-refresh-race`): ответ вернулся,
    // когда за компьютером уже другой человек. Токен до него не дотягивается — учётка не должна
    // тем более, иначе новому пользователю подставили бы права предыдущего.
    __resetSessionForTests();
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockHttp({
      'POST /auth/refresh': async () => {
        await held;
        return json(loginResponse(authUser({ id: 'user-a', email: 'a@example.test' })));
      },
    });

    startSession('token-A');
    const seen: unknown[] = [];
    const unsubscribe = onRefreshedUser((user) => seen.push(user));
    const pending = refresh();

    // За компьютер садится второй: выход и вход, пока обновление первого висит.
    clearSession();
    startSession('token-B');
    release!();

    expect(await pending).toEqual({ status: 'stale' });
    expect(seen).toEqual([]);
    unsubscribe();
  });
});
