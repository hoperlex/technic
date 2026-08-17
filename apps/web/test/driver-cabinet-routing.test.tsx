import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import type { AuthUser } from '@technic/contracts';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { HomeRedirect, RequireDriverCabinet } from '../src/auth/ProtectedRoute';

/**
 * Кабинет водителя (ADR 0102) — второй контур портала, и попадать в него должна одна роль.
 *
 * Проверяется здесь не право, а последствие его наличия у чужой роли: `driverCabinet.read` есть у
 * администратора, потому что права у него все (`ROLE_PERMISSIONS.admin` — `[...PERMISSIONS]`), а
 * кабинет живёт вне `AppLayout` — ни меню, ни разделов. Пустив туда по одному праву, портал
 * запирал держателя всех прав в контуре без навигации: стартовая страница вела в кабинет, а
 * корень и любой неизвестный адрес — обратно в неё же.
 *
 * Маршруты собираются тестом, а не берутся из `App`: проверяются два стража — стартовая страница
 * (`HomeRedirect`) и гейт кабинета (`RequireDriverCabinet`), — а страницы за ними к вопросу
 * отношения не имеют. Адрес задаётся оболочкой рендера: роутер поднят ею, второй внутрь не вложить.
 */
function renderRoutes(user: AuthUser, route: string) {
  return renderWithUser(
    <Routes>
      <Route element={<RequireDriverCabinet />}>
        <Route path="/driver" element={<div>Кабинет водителя</div>} />
      </Route>
      <Route path="/waste" element={<div>Вывоз мусора</div>} />
      <Route path="/change-password" element={<div>Смена пароля</div>} />
      {/* Тот же `*`, что в портале: корень и неизвестный адрес отвечают стартовой страницей роли. */}
      <Route path="*" element={<HomeRedirect />} />
    </Routes>,
    { user, route },
  );
}

const admin = () => authUser({ id: 'user-admin', role: 'admin' });
const driver = () => authUser({ id: 'user-driver', role: 'driver' });

describe('кабинет водителя открыт только роли driver', () => {
  it('администратора с корня уводит в его раздел, а не в кабинет', () => {
    renderRoutes(admin(), '/');
    expect(screen.getByText('Вывоз мусора')).toBeDefined();
    expect(screen.queryByText('Кабинет водителя')).toBeNull();
  });

  it('администратора не пускает в кабинет и прямая ссылка', () => {
    renderRoutes(admin(), '/driver');
    expect(screen.getByText('Вывоз мусора')).toBeDefined();
    expect(screen.queryByText('Кабинет водителя')).toBeNull();
  });

  it('водитель с корня попадает в кабинет: разделов основного портала у роли нет', () => {
    renderRoutes(driver(), '/');
    expect(screen.getByText('Кабинет водителя')).toBeDefined();
  });

  it('водителя прямая ссылка на кабинет открывает как прежде', () => {
    renderRoutes(driver(), '/driver');
    expect(screen.getByText('Кабинет водителя')).toBeDefined();
  });

  it('водитель без права кабинета уходит на смену пароля, а не по кругу', () => {
    // Роль без права — состояние переходное (право сняли, учётку ещё не перевели), но именно на
    // нём проверяется отсутствие цикла: гейт уводит на стартовую страницу, и та обязана назвать
    // адрес, отличный от кабинета. Иначе редирект вернулся бы в тот же гейт.
    renderRoutes(authUser({ id: 'user-driver', role: 'driver', permissions: [] }), '/driver');
    expect(screen.getByText('Смена пароля')).toBeDefined();
    expect(screen.queryByText('Кабинет водителя')).toBeNull();
  });
});
