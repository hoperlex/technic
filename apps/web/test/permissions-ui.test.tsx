import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { can, type AuthUser, type Permission, type Role } from '@technic/contracts';
import { MOBILE_VIEWPORT, setViewport } from './viewport';

/**
 * Портал скрывает недоступное по той же матрице, по которой API запрещает (ADR 0021).
 * Проверяется именно связка «роль → право → элемент интерфейса»: расхождение здесь даёт либо
 * кнопку, ведущую в 403, либо раздел, невидимый тому, кому он разрешён.
 *
 * `useAuth` подменяется целиком: настоящий провайдер поднимает сессию через API, а к правам
 * это отношения не имеет.
 */

let currentRole: Role | null = null;

vi.mock('../src/auth/AuthContext', () => ({
  useAuth: () => ({
    user: currentRole
      ? ({
          id: 'user-1',
          email: 'user@test.local',
          lastName: 'Пользователь',
          firstName: 'Тестовый',
          middleName: '',
          fullName: 'Пользователь Тестовый',
          role: currentRole,
          isActive: true,
          mustChangePassword: false,
          constructionObjectId: null,
        } satisfies AuthUser)
      : null,
    status: 'authenticated' as const,
    login: vi.fn(),
    logout: vi.fn(),
    setUser: vi.fn(),
    refreshUser: vi.fn(),
    hasRole: (...roles: Role[]) => !!currentRole && roles.includes(currentRole),
    can: (permission: Permission) => can(currentRole, permission),
  }),
}));

// Меню показывает бейдж с числом заявок на регистрацию (ADR 0034) — к правам это отношения не
// имеет, но без заглушки макет ходил бы в API за счётчиком.
vi.mock('../src/api/resources', () => ({
  usersApi: { pendingCount: async () => ({ count: 0 }) },
}));

/** Провайдер запросов: в приложении он поднят выше макета, в тесте нужен свой. */
function withQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const { AppLayout } = await import('../src/components/AppLayout');
const { RequirePermission } = await import('../src/auth/ProtectedRoute');

function renderMenu(role: Role | null) {
  currentRole = role;
  return render(
    withQueryClient(
      <MemoryRouter initialEntries={['/waste']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/waste" element={<div>Список заявок</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  );
}

function renderGuarded(role: Role | null, permission: Permission) {
  currentRole = role;
  return render(
    <MemoryRouter initialEntries={['/directories']}>
      <Routes>
        <Route element={<RequirePermission permission={permission} />}>
          <Route path="/directories" element={<div>Страница справочников</div>} />
        </Route>
        <Route path="/waste" element={<div>Список заявок</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('пункты меню следуют из прав', () => {
  it('диспетчер видит справочники — доступ выдан вместе с правом directories.write', () => {
    renderMenu('dispatcher');
    expect(screen.getByText('Справочники')).toBeDefined();
    expect(screen.getByText('Заказ ТС')).toBeDefined();
    expect(screen.queryByText('Администрирование')).toBeNull();
  });

  it('менеджер видит то же самое', () => {
    renderMenu('manager');
    expect(screen.getByText('Справочники')).toBeDefined();
    expect(screen.queryByText('Администрирование')).toBeNull();
  });

  it('оператору вывоза не показывают ни заказ ТС, ни справочники (ADR 0010)', () => {
    renderMenu('operator');
    expect(screen.getByText('Вывоз мусора')).toBeDefined();
    expect(screen.queryByText('Заказ ТС')).toBeNull();
    expect(screen.queryByText('Справочники')).toBeNull();
  });

  it('штаб ведёт заявки обоих модулей, но справочники не правит', () => {
    renderMenu('shtab');
    expect(screen.getByText('Заказ ТС')).toBeDefined();
    expect(screen.queryByText('Справочники')).toBeNull();
  });

  it('наблюдатель видит оба модуля заявок и ничего сверх них (ADR 0033)', () => {
    renderMenu('observer');
    expect(screen.getByText('Вывоз мусора')).toBeDefined();
    expect(screen.getByText('Заказ ТС')).toBeDefined();
    expect(screen.queryByText('Справочники')).toBeNull();
    expect(screen.queryByText('Администрирование')).toBeNull();
  });

  it('администратору доступно всё, включая учётки', () => {
    renderMenu('admin');
    expect(screen.getByText('Справочники')).toBeDefined();
    expect(screen.getByText('Администрирование')).toBeDefined();
  });
});

/**
 * Нижняя навигация мобильного режима (ADR 0030) строится из того же списка, что и меню на
 * десктопе, поэтому проверяется не разметка, а состав: лишний пункт здесь — это кнопка, ведущая
 * в 403, а недостающий — раздел, невидимый тому, кому он разрешён. Подписи в навигации сокращены,
 * доступное имя кнопки остаётся полным — по нему пункт и ищется.
 */
function mobileNavLabels(role: Role | null): string[] {
  setViewport(MOBILE_VIEWPORT);
  renderMenu(role);
  const nav = screen.getByRole('navigation', { name: 'Разделы портала' });
  return [...nav.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
}

describe('нижняя навигация на мобильном повторяет права роли', () => {
  it('администратор — все четыре раздела', () => {
    expect(mobileNavLabels('admin')).toEqual([
      'Вывоз мусора',
      'Заказ ТС',
      'Справочники',
      'Администрирование',
    ]);
  });

  it('менеджер — без администрирования', () => {
    expect(mobileNavLabels('manager')).toEqual(['Вывоз мусора', 'Заказ ТС', 'Справочники']);
  });

  it('диспетчер — то же, что у менеджера', () => {
    expect(mobileNavLabels('dispatcher')).toEqual(['Вывоз мусора', 'Заказ ТС', 'Справочники']);
  });

  it('штаб — оба модуля заявок, без справочников', () => {
    expect(mobileNavLabels('shtab')).toEqual(['Вывоз мусора', 'Заказ ТС']);
  });

  it('руководитель строительства — оба модуля заявок, как у штаба (ADR 0031)', () => {
    expect(mobileNavLabels('rukstroy')).toEqual(['Вывоз мусора', 'Заказ ТС']);
  });

  it('оператор вывоза — только вывоз мусора (ADR 0010)', () => {
    expect(mobileNavLabels('operator')).toEqual(['Вывоз мусора']);
  });

  it('наблюдатель — оба модуля заявок, смотреть их можно и с телефона (ADR 0033)', () => {
    expect(mobileNavLabels('observer')).toEqual(['Вывоз мусора', 'Заказ ТС']);
  });

  it('открытый раздел помечен для скринридера и подписан в шапке', () => {
    setViewport(MOBILE_VIEWPORT);
    renderMenu('admin');
    const active = screen.getByRole('button', { name: 'Вывоз мусора' });
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(
      screen.getByRole('button', { name: 'Заказ ТС' }).getAttribute('aria-current'),
    ).toBeNull();
    // Заголовок панели называет раздел полностью — в навигации подпись сокращена.
    expect(screen.getAllByText('Вывоз мусора').length).toBeGreaterThan(0);
  });

  it('на десктопе нижней навигации нет вовсе', () => {
    renderMenu('admin');
    expect(screen.queryByRole('navigation', { name: 'Разделы портала' })).toBeNull();
  });
});

describe('раздел закрывается правом, а не списком ролей', () => {
  it('пускает роль с правом', () => {
    renderGuarded('dispatcher', 'directories.write');
    expect(screen.getByText('Страница справочников')).toBeDefined();
  });

  it('роль без права уводит на список заявок, а не показывает пустую страницу', () => {
    renderGuarded('shtab', 'directories.write');
    expect(screen.queryByText('Страница справочников')).toBeNull();
    expect(screen.getByText('Список заявок')).toBeDefined();
  });

  it('учётку без роли не пускает никуда', () => {
    renderGuarded(null, 'directories.write');
    expect(screen.queryByText('Страница справочников')).toBeNull();
  });

  it('администрирование закрыто правом на учётки', () => {
    renderGuarded('manager', 'users.manage');
    expect(screen.queryByText('Страница справочников')).toBeNull();
  });
});
