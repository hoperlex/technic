import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Navigate, Outlet, Route, Routes } from 'react-router';
import type { AuthUser } from '@technic/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
        {/* Ветка кабинета повторяет портальную формой, а не содержимым: каркас, index и вторая
            страница задания (план driver-readings-first, Р1). Гейт стоит над всей веткой — это и
            проверяется: подстраница задания не должна оказаться дверью в обход условия входа. */}
        <Route
          path="/driver"
          element={
            <div>
              Кабинет водителя
              <Outlet />
            </div>
          }
        >
          <Route index element={<div>Показания</div>} />
          <Route path="assignment" element={<div>Задание</div>} />
        </Route>
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

  it('index кабинета — показания, а не задание', () => {
    // Р1: `/driver` открывается формой показаний. Задание никуда не делось — оно на подстранице,
    // внутри того же каркаса и того же гейта, и дата у них общая, в адресе.
    renderRoutes(driver(), '/driver');
    expect(screen.getByText('Показания')).toBeDefined();
    expect(screen.queryByText('Задание')).toBeNull();
  });

  it('задание открывается своим адресом внутри того же каркаса', () => {
    renderRoutes(driver(), '/driver/assignment');
    expect(screen.getByText('Кабинет водителя')).toBeDefined();
    expect(screen.getByText('Задание')).toBeDefined();
    expect(screen.queryByText('Показания')).toBeNull();
  });

  it('подстраница задания закрыта тем же гейтом, что и кабинет', () => {
    // Гейт стоит над веткой, а не над index-маршрутом: заведи его этажом ниже — и вторая
    // страница открылась бы всем, кто прошёл ProtectedRoute.
    renderRoutes(admin(), '/driver/assignment');
    expect(screen.getByText('Вывоз мусора')).toBeDefined();
    expect(screen.queryByText('Задание')).toBeNull();
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

/**
 * Какая страница стоит на index кабинета — вопрос к `App.tsx`, а не к дереву маршрутов выше: там
 * маршруты собирает сам тест, и подменить в них страницу он может любой. Поэтому источник читается
 * с диска и проверяется буквально: разбирать `App` импортом значило бы поднять весь портал ради
 * двух строк, а `check-portal-routes.mjs` сторожит адреса ветки, но не то, чем они открываются.
 *
 * Путь считается от файла теста, а не от рабочего каталога: прогон из корня репозитория его не
 * сломает.
 */
const appSource = readFileSync(join(import.meta.dirname, '../src/App.tsx'), 'utf8');

describe('кабинет открывается формой показаний', () => {
  it('index кабинета — DriverReadingsPage, задание — подстраница', () => {
    expect(appSource).toMatch(/<Route index element=\{<DriverReadingsPage \/>\} \/>/);
    expect(appSource).toMatch(/<Route path="assignment" element=\{<DriverPage \/>\} \/>/);
  });

  it('страница показаний грузится отдельным чанком, как и весь кабинет', () => {
    // Кабинет — второй контур: его код не должен попадать в первый бандл диспетчера, и наоборот.
    // Проверяется соседство `lazy` и импорта, а не точная запись: переносы строк тут ставит
    // prettier, и требовать от него постоянства значило бы ловить его правки как поломку.
    const lazyImport = appSource.slice(0, appSource.indexOf('export default'));
    expect(lazyImport).toMatch(/lazy\([\s\S]{0,80}pages\/driver\/DriverReadingsPage/);
  });
});
