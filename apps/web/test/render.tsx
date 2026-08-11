import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { MemoryRouter } from 'react-router';
import type { AuthUser, Permission, Role } from '@technic/contracts';
import { can as roleCan, canUse as scopedCanUse } from '@technic/contracts';
import { AuthContext, AuthProvider } from '../src/auth/AuthContext';
import { themeFor } from '../src/theme';
import { FORM_VALIDATE_MESSAGES } from '../src/shared/config';
import { setViewport, DESKTOP_VIEWPORT, type Viewport } from './viewport';
import { authUser } from './factories/auth';

/**
 * Общая оболочка рендера для тестов — тот же порядок провайдеров, что и в точке входа портала.
 *
 * Порядок важен: `AntApp` даёт `App.useApp()`, которым формы показывают сообщения и модальные
 * подтверждения (без него падает любая форма), `MemoryRouter` — навигацию, `QueryClientProvider` —
 * кэш запросов. Клиент каждый раз свежий и без повторов: тест, который «иногда проходит»,
 * потому что запрос повторился, хуже упавшего.
 *
 * Пользователь подставляется значением контекста, а не моком модуля: `vi.mock` поднимается на
 * верх файла и не переключается между тестами. Настоящий `AuthProvider` (со входом через сеть)
 * появится отдельным helper'ом `renderWithSession` — он нужен сценариям смены сессии.
 */
export interface RenderOptions {
  /** Кто смотрит на экран. По умолчанию — диспетчер: у него полный набор действий. */
  user?: AuthUser | null;
  /** Режим устройства (ADR 0030): десктоп по умолчанию. */
  viewport?: Viewport;
  queryClient?: QueryClient;
  /**
   * Начальный адрес. Нужен экранам, где от него зависит показанное: подсветка пункта меню,
   * `aria-current`, редиректы прав. Свой `MemoryRouter` внутрь не вложить — react-router
   * запрещает вложенные роутеры, поэтому адрес задаётся здесь.
   */
  route?: string;
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function renderWithUser(
  ui: ReactNode,
  options: RenderOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const user = options.user === undefined ? authUser() : options.user;
  const queryClient = options.queryClient ?? createTestQueryClient();
  setViewport(options.viewport ?? DESKTOP_VIEWPORT);

  const auth = {
    user,
    status: user ? ('authenticated' as const) : ('unauthenticated' as const),
    login: async () => user!,
    logout: async () => {},
    setUser: () => {},
    refreshUser: async () => {},
    hasRole: (...roles: Role[]) => !!user?.role && roles.includes(user.role),
    can: (permission: Permission) => roleCan(user, permission),
    canUse: (permission: Permission) => scopedCanUse(user, permission),
  };

  const result = render(
    <ConfigProvider
      locale={ruRU}
      theme={themeFor(false)}
      form={{ validateMessages: FORM_VALIDATE_MESSAGES }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[options.route ?? '/']}>
            <AuthContext.Provider value={auth}>{ui}</AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>,
  );

  return { ...result, queryClient };
}

/**
 * То же дерево, но с настоящим `AuthProvider`: вход, выход и истечение сессии идут через сеть,
 * как в приложении. Нужен сценариям про сессию — подставленный значением контекст ни входа, ни
 * очистки кэша не выполняет, а проверяются именно они.
 */
export function renderWithSession(
  ui: ReactNode,
  options: Omit<RenderOptions, 'user'> = {},
): RenderResult & { queryClient: QueryClient } {
  const queryClient = options.queryClient ?? createTestQueryClient();
  setViewport(options.viewport ?? DESKTOP_VIEWPORT);

  const result = render(
    <ConfigProvider
      locale={ruRU}
      theme={themeFor(false)}
      form={{ validateMessages: FORM_VALIDATE_MESSAGES }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[options.route ?? '/']}>
            <AuthProvider>{ui}</AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>,
  );

  return { ...result, queryClient };
}
