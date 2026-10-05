import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import {
  ADMIN_PAGE_PERMISSIONS,
  PERMISSIONS,
  type AuthUser,
  type Permission,
} from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { AppLayout } from '../src/app/layout';
import { AdministrationPage } from '@pages/admin';
import { AsyncContent } from '@shared/ui';
import { HomeRedirect, RequireSection } from '../src/app/routing/ProtectedRoute';

/**
 * Гейты администрирования (`docs/manuals-plan.md` §3.6).
 *
 * Права входа знали четыре места, и знали разное: маршрут — два права, страница — три, пункт меню
 * и стартовый редирект — одно. Стоило это двух живых дыр: держатель набора «Рассылки» проходил
 * маршрут, но пункта меню не видел, а держатель набора «Обмен справочниками» не попадал вовсе —
 * вкладка для него в коде была, а маршрут его разворачивал.
 *
 * Теперь список один — `ADMIN_PAGE_PERMISSIONS`, — и тест следит, чтобы он не разошёлся со
 * страницей. Проверка равенством множеств, а не включением: односторонняя пропустила бы лишнюю
 * запись — право, вкладку которого убрали, а страницу открывать им продолжают.
 */

/** Учётка ровно с одним правом: список прав приходит от сервера (ADR 0106), а не выводится из роли. */
const holder = (permission: Permission): AuthUser =>
  authUser({ id: `user-${permission}`, permissions: [permission] });

/**
 * Ответы всех вкладок разом: какая из них смонтируется, решает право, а неспрошенный маршрут
 * ничего не стоит. Без них вкладка ушла бы за данными в настоящую сеть — экран остался бы пустым
 * молча, и тест проверял бы не то, что думает автор.
 */
const TAB_ROUTES = {
  'GET /users': () => json(emptyList()),
  'GET /users/pending-count': () => json({ count: 0 }),
  'GET /objects': () => json(emptyList()),
  'GET /departments': () => json(emptyList()),
  'GET /counterparties': () => json(emptyList()),
  'GET /admin/mail/schedules': () => json([]),
  'GET /directories': () => json({ items: [] }),
  'GET /manuals': () => json(emptyList()),
  // Журнал обновлений спрашивает сам каркас — он в дереве проверок про меню и маршрут (ADR 0077).
  'GET /releases': () => json([]),
};

/** Count tabs only after the public page module has loaded, including the zero-tab case. */
async function tabsFor(permission: Permission): Promise<number> {
  mockHttp(TAB_ROUTES);
  const { unmount } = renderWithUser(
    <AsyncContent fallback={<span data-testid="admin-loading" />}>
      <AdministrationPage />
    </AsyncContent>,
    { user: holder(permission) },
  );
  // The cold module graph is transformed by Vitest, not fetched from a production chunk. Drain
  // that work explicitly so the DOM polling budget still measures rendering rather than compilation.
  await act(() => vi.dynamicImportSettled());
  // Tab composition is synchronous once the module arrives; waiting for a tab would incorrectly
  // reject permissions that legitimately expose none. Tab data is not the readiness condition.
  await waitFor(() => expect(screen.queryByTestId('admin-loading')).toBeNull());
  expect(screen.queryByText('Не удалось открыть экран')).toBeNull();
  const count = screen.queryAllByRole('tab').length;
  unmount();
  return count;
}

/**
 * Каркас с меню и маршрутом администрирования: оба гейта живут одним списком прав.
 *
 * Обвязка повторяет устройство портала: гейт маршрута — общий `RequireSection` по строке реестра
 * разделов, а её права — те же `ADMIN_PAGE_PERMISSIONS`, которыми меню собирает свой пункт и
 * страница — свои вкладки. Список от этого не перестал быть одним: сменилось только место, где его
 * спрашивает маршрут.
 *
 * Отказ гейта ведёт на корень, и там стоит стартовая страница — тем же index-маршрутом внутри
 * каркаса, что и в `App`. Учётке без разделов она отвечает экраном «разделов нет»; прежняя
 * обвязка держала на этом месте заглушку `/change-password`, потому что туда её и уводил старый
 * перебор разделов.
 */
function renderPortal(permission: Permission) {
  mockHttp(TAB_ROUTES);
  return renderWithUser(
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomeRedirect />} />
        <Route element={<RequireSection id="admin" />}>
          {/* Заглушка вместо самой страницы: проверяется дверь, а не то, что за ней. */}
          <Route path="/admin" element={<div>Страница администрирования</div>} />
        </Route>
      </Route>
    </Routes>,
    { user: holder(permission), route: '/admin' },
  );
}

describe('список прав входа и вкладки страницы не разъезжаются', () => {
  it('вкладку заводят ровно права из ADMIN_PAGE_PERMISSIONS', async () => {
    const opening: Permission[] = [];
    for (const permission of PERMISSIONS) {
      if ((await tabsFor(permission)) > 0) opening.push(permission);
    }
    // Сравнение в обе стороны: недостающее право — это выданный доступ, который не работает, а
    // лишнее — открытая страница без единой вкладки на ней.
    expect([...opening].sort()).toEqual([...ADMIN_PAGE_PERMISSIONS].sort());
  });
});

describe('держатель каждого права из списка доходит до страницы', () => {
  for (const permission of ADMIN_PAGE_PERMISSIONS) {
    it(`${permission}: видит пункт меню и проходит маршрут`, () => {
      renderPortal(permission);
      expect(screen.getByText('Администрирование')).toBeDefined();
      expect(screen.getByText('Страница администрирования')).toBeDefined();
    });
  }

  it('право не из списка на страницу не пускает и пункта меню не даёт', () => {
    /*
     * `drivers.read` открывает справочник водителей, а не администрирование: без него маршрут
     * разворачивает учётку на корень, а разделов у неё нет ни одного — и стартовая страница
     * отвечает пустым главным экраном.
     *
     * Раньше здесь ожидалась «Смена пароля», и это ожидание закрепляло промах как норму
     * (`docs/portal-sections-plan.md` §2): «доступ не настроен» приезжало к человеку служебной
     * формой, неотличимой от просроченного пароля. Форма теперь остаётся за единственным своим
     * поводом — `mustChangePassword`.
     */
    renderPortal('drivers.read');
    expect(screen.queryByText('Администрирование')).toBeNull();
    expect(screen.queryByText('Страница администрирования')).toBeNull();
    expect(screen.getByText('Разделы портала вам пока не назначены')).toBeDefined();
    expect(screen.queryByText('Смена пароля')).toBeNull();
  });
});
