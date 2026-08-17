import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { can as matrixCan, type AuthUser, type Permission } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser, departmentUser } from './factories/auth';
import { AppLayout } from '../src/components/AppLayout';
import { RequirePermission } from '../src/auth/ProtectedRoute';

/**
 * Портал берёт права из списка, который отдал сервер (ADR 0106, этап 2), а не выводит их из роли.
 *
 * Ради этого шаг и делался: со свободной сборкой полномочий состав набора живёт в базе и заводится
 * в проде — матрица о нём не знает и знать не должна. Поэтому проверяется здесь не «роль видит свой
 * раздел» (это `permissions-ui.test.tsx`), а расхождение списка с ролью: право, которого роль не
 * даёт, открывает раздел, а снятое из списка — закрывает его при той же роли. Пока портал считал
 * права сам, оба состояния были невыразимы.
 */

const OBJECT_A = '11111111-1111-1111-1111-111111111111';
const DEPARTMENT_A = '55555555-5555-5555-5555-555555555555';

/** Учётка, которой набор выдал право сверх роли: список сервера длиннее прав должности. */
const withGranted = (user: AuthUser, ...extra: Permission[]): AuthUser => ({
  ...user,
  permissions: [...user.permissions, ...extra],
});

/** Учётка, у которой право отняли: роль прежняя, а в списке права больше нет. */
const withRevoked = (user: AuthUser, ...gone: Permission[]): AuthUser => ({
  ...user,
  permissions: user.permissions.filter((p) => !gone.includes(p)),
});

/**
 * Меню портала под заданной учёткой. Сеть заглушена ровно тем, что макет спрашивает независимо от
 * прав: бейдж заявок на регистрацию (ADR 0034), журнал обновлений (ADR 0077) и счётчик «ждут меня»
 * (Р39) к составу пунктов отношения не имеют.
 */
function renderMenu(user: AuthUser) {
  mockHttp({
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /releases': () => json([]),
    'GET /service-requests/waiting-count': () => json({ count: 0 }),
  });
  return renderWithUser(
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/waste" element={<div>Список заявок</div>} />
      </Route>
    </Routes>,
    { user, route: '/waste' },
  );
}

/** Страница, закрытая правом: отказ уводит на стартовый раздел учётки, а не показывает пустоту. */
function renderGuarded(user: AuthUser, permission: Permission) {
  return renderWithUser(
    <Routes>
      <Route element={<RequirePermission permission={permission} />}>
        <Route path="/" element={<div>Страница справочников</div>} />
      </Route>
      <Route path="/waste" element={<div>Список заявок</div>} />
    </Routes>,
    { user },
  );
}

describe('меню следует списку прав, а не роли', () => {
  it('право, выданное набором, открывает раздел роли, которой оно не положено', () => {
    // Матрица про этот доступ ничего не знает и знать не должна: право пришло полномочием, которое
    // администратор собрал в проде. Раньше портал спросил бы её — и пункт остался бы скрытым у
    // человека, которому сервер раздел уже разрешает.
    expect(matrixCan({ role: 'shtab' }, 'directories.write')).toBe(false);

    const shtab = authUser({ role: 'shtab', constructionObjectIds: [OBJECT_A] });
    renderMenu(withGranted(shtab, 'directories.write'));

    expect(screen.getByText('Справочники')).toBeDefined();
  });

  it('та же роль без права в списке справочников не видит', () => {
    // Второе состояние обязательно: видимый пункт сам по себе не доказывает, что смотрели в список.
    renderMenu(authUser({ role: 'shtab', constructionObjectIds: [OBJECT_A] }));
    expect(screen.queryByText('Справочники')).toBeNull();
  });

  it('право, снятое из списка, закрывает раздел при прежней роли', () => {
    // Обратный случай: у диспетчера право есть по должности, но выдачу пересобрали. Портал обязан
    // слушаться списка — иначе он показывал бы дверь, за которой сервер отвечает 403.
    expect(matrixCan({ role: 'dispatcher' }, 'directories.write')).toBe(true);

    const dispatcher = authUser();
    renderMenu(withRevoked(dispatcher, 'directories.write', 'officeEquipment.write'));

    expect(screen.queryByText('Справочники')).toBeNull();
    // Остальное на месте: закрылся ровно один раздел, а не доступ целиком.
    expect(screen.getByText('Заказ ТС')).toBeDefined();
  });

  it('пустая область закрывает раздел, даже когда право в списке есть (ADR 0062)', () => {
    // Область сервер отдельным полем не отдаёт, и считается она по-прежнему по роли. Отдел без
    // площадки — та самая пара состояний: два права из одного списка, а открывается одно.
    const department = departmentUser(DEPARTMENT_A);
    expect(department.permissions).toContain('wasteRequests.read');

    renderMenu(department);

    expect(screen.queryByText('Вывоз мусора')).toBeNull();
    expect(screen.getByText('Заказ ТС')).toBeDefined();
  });

  it('та же учётка с площадкой вывоз мусора видит', () => {
    renderMenu(departmentUser(DEPARTMENT_A, [OBJECT_A]));
    expect(screen.getByText('Вывоз мусора')).toBeDefined();
  });
});

describe('прямая ссылка проверяется тем же списком', () => {
  it('пускает роль без права, если право пришло списком', () => {
    const shtab = authUser({ role: 'shtab', constructionObjectIds: [OBJECT_A] });
    renderGuarded(withGranted(shtab, 'directories.write'), 'directories.write');
    expect(screen.getByText('Страница справочников')).toBeDefined();
  });

  it('уводит на стартовый раздел, если право из списка сняли', () => {
    renderGuarded(withRevoked(authUser(), 'directories.write'), 'directories.write');
    expect(screen.queryByText('Страница справочников')).toBeNull();
    expect(screen.getByText('Список заявок')).toBeDefined();
  });
});
