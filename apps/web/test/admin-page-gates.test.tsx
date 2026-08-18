import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
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
import { AppLayout } from '../src/components/AppLayout';
import { AdministrationPage } from '../src/pages/AdministrationPage';
import { RequirePermission } from '../src/auth/ProtectedRoute';

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

/** Сколько вкладок заводит страница держателю одного этого права. */
function tabsFor(permission: Permission): number {
  mockHttp(TAB_ROUTES);
  const { unmount } = renderWithUser(<AdministrationPage />, { user: holder(permission) });
  // Состав вкладок считается синхронно из прав — ждать нечего, ждут данные внутри вкладки.
  const count = screen.queryAllByRole('tab').length;
  unmount();
  return count;
}

/** Каркас с меню и маршрутом администрирования: оба гейта живут одним списком прав. */
function renderPortal(permission: Permission) {
  mockHttp(TAB_ROUTES);
  return renderWithUser(
    <Routes>
      <Route element={<AppLayout />}>
        <Route element={<RequirePermission permission={[...ADMIN_PAGE_PERMISSIONS]} />}>
          {/* Заглушка вместо самой страницы: проверяется дверь, а не то, что за ней. */}
          <Route path="/admin" element={<div>Страница администрирования</div>} />
        </Route>
      </Route>
      {/* Куда уводит `homePath` учётку, которой раздел закрыт: разделов у неё нет вовсе. */}
      <Route path="/change-password" element={<div>Смена пароля</div>} />
    </Routes>,
    { user: holder(permission), route: '/admin' },
  );
}

describe('список прав входа и вкладки страницы не разъезжаются', () => {
  it('вкладку заводят ровно права из ADMIN_PAGE_PERMISSIONS', () => {
    const opening = PERMISSIONS.filter((permission) => tabsFor(permission) > 0);
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
    // `drivers.read` открывает справочник водителей, а не администрирование: без него маршрут
    // разворачивает учётку в первый доступный ей раздел, а его у неё нет.
    renderPortal('drivers.read');
    expect(screen.queryByText('Администрирование')).toBeNull();
    expect(screen.queryByText('Страница администрирования')).toBeNull();
    expect(screen.getByText('Смена пароля')).toBeDefined();
  });
});
