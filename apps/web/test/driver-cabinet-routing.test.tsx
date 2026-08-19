import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Navigate, Route, Routes } from 'react-router';
import type { AuthUser } from '@technic/contracts';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { HomeRedirect, RequireSection } from '../src/auth/ProtectedRoute';

/**
 * Кабинет водителя (ADR 0102) — второй контур портала, и попадать в него должна одна роль.
 *
 * Проверяется здесь не право, а последствие его наличия у чужой роли: `driverCabinet.read` есть у
 * администратора, потому что права у него все (`ROLE_PERMISSIONS.admin` — `[...PERMISSIONS]`), а
 * кабинет живёт вне `AppLayout` — ни меню, ни разделов. Пустив туда по одному праву, портал
 * запирал держателя всех прав в контуре без навигации: стартовая страница вела в кабинет, а
 * корень и любой неизвестный адрес — обратно в неё же.
 *
 * Гейт у кабинета больше не свой: `RequireDriverCabinet` упразднён, и вход закрывает общий
 * `RequireSection` по строке реестра разделов, где условие «роль вместе с правом» и записано
 * (`portal-sections.ts`, поле `roles`). Предмет проверки от этого не изменился — изменилось место,
 * которое на вопрос отвечает: раньше про кабинет знали трое (гейт, меню, стартовая), и разъезд
 * между ними и был причиной живучести таких дыр.
 *
 * Маршруты собираются тестом, а не берутся из `App`: проверяются два стража — стартовая страница
 * (`HomeRedirect`) и гейт кабинета (`RequireSection`), — а страницы за ними к вопросу отношения не
 * имеют. Адрес задаётся оболочкой рендера: роутер поднят ею, второй внутрь не вложить.
 */
function renderRoutes(user: AuthUser, route: string) {
  return renderWithUser(
    <Routes>
      <Route element={<RequireSection id="driver-cabinet" />}>
        <Route path="/driver" element={<div>Кабинет водителя</div>} />
      </Route>
      <Route path="/waste" element={<div>Вывоз мусора</div>} />
      {/* Стартовая страница стоит на корне — там же, где в портале, и туда же уводит отказ гейта. */}
      <Route path="/" element={<HomeRedirect />} />
      {/* Тот же `*`, что в портале: неизвестный адрес ведёт на корень, а не рисует стартовую сам. */}
      <Route path="*" element={<Navigate to="/" replace />} />
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

  it('водитель без права кабинета видит экран «разделов нет», а не форму смены пароля', () => {
    /*
     * Роль без права — состояние переходное (право сняли, учётку ещё не перевели), но именно на
     * нём проверяется отсутствие цикла: гейт уводит на корень, и стартовая страница обязана
     * ответить чем-то, кроме кабинета. Иначе редирект вернулся бы в тот же гейт.
     *
     * Отвечает она теперь экраном «разделов нет», а не адресом `/change-password`, и это не
     * послабление проверки, а её ужесточение. Смена пароля — служебная форма вне каркаса: она
     * называла состояние учётки неправильно («пароль просрочен» вместо «доступ не настроен»),
     * выхода из себя не давала и сменой пароля не лечилась — после сохранения перебор разделов
     * повторялся и приводил туда же. Теперь единственный редирект на ту форму — настоящий
     * `mustChangePassword` в `ProtectedRoute`, а «разделов нет» портал показывает экраном.
     */
    renderRoutes(authUser({ id: 'user-driver', role: 'driver', permissions: [] }), '/driver');
    expect(screen.getByText('Разделы портала вам пока не назначены')).toBeDefined();
    expect(screen.queryByText('Кабинет водителя')).toBeNull();
    expect(screen.queryByText('Смена пароля')).toBeNull();
  });
});
