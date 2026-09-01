import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { MemoryRouter } from 'react-router';
import type { AuthUser } from '@technic/contracts';
import { RouteModalContext, type RouteModalApi } from '@features/route-modal';
import { AuthContext, AuthProvider, permissionChecks } from '../src/auth/AuthContext';
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
 *
 * Тем же приёмом подставлены окна рейса и заявки (`RouteModalContext`, см. `routeModalStub` ниже):
 * значением контекста, а не провайдером, — заглушку сценарий подменяет своей опцией `routeModal`.
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
  /**
   * Чем подменить окна рейса, списка рейсов и заявки (`RouteModalApi`, ADR 0120). Передаётся
   * ровно то, что сценарию интересно, — остальные три метода останутся заглушками:
   *
   * ```tsx
   * const openRoute = vi.fn();
   * renderWithUser(<VehicleRequestsTab />, { routeModal: { openRoute } });
   * expect(openRoute).toHaveBeenCalledWith('route-1');
   * ```
   *
   * Те же четыре шпиона возвращает и сам рендер (`routeModal` в результате) — сценариям, которым
   * держать ссылку на них снаружи незачем.
   */
  routeModal?: Partial<RouteModalApi>;
}

/**
 * Заглушка окон рейса, списка рейсов и заявки — контекст, а не провайдер, и это существенно.
 *
 * `useRouteModal` бросает вне провайдера (`@features/route-modal`): отсутствие контекста там —
 * ошибка сборки приложения, а не «нет прав», и молча проглоченный клик по номеру рейса читался бы
 * как поломка самого рейса. Зовут его нынче отовсюду — обе вкладки гаража, список и карточка
 * заявки, дни линейного заказа, журнал путевых листов, — поэтому контекст стоит в общей оболочке:
 * иначе каждый второй тест портала падал бы исключением монтажа, ничего при этом не проверив.
 *
 * Настоящий `RouteModalProvider` сюда не тащим намеренно. Он элемент маршрутизации: рисует
 * `<Outlet/>` вместо детей, разбирает адрес и монтирует за собой карточку рейса, список рейсов и
 * читалку заявки — со всеми их запросами. Тесту чужих экранов нужен не он, а ответ на вопрос
 * «попросили ли открыть окно и какое», и отвечают на него четыре шпиона.
 */
function routeModalStub(overrides: Partial<RouteModalApi> = {}): RouteModalApi {
  return {
    openRoute: vi.fn(),
    openRoutesList: vi.fn(),
    openRequest: vi.fn(),
    editRoute: vi.fn(),
    ...overrides,
  };
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function renderWithUser(
  ui: ReactNode,
  options: RenderOptions = {},
): RenderResult & { queryClient: QueryClient; routeModal: RouteModalApi } {
  const user = options.user === undefined ? authUser() : options.user;
  const queryClient = options.queryClient ?? createTestQueryClient();
  const routeModal = routeModalStub(options.routeModal);
  setViewport(options.viewport ?? DESKTOP_VIEWPORT);

  const auth = {
    user,
    status: user ? ('authenticated' as const) : ('unauthenticated' as const),
    login: async () => user!,
    logout: async () => {},
    setUser: () => {},
    refreshUser: async () => {},
    // Права считаются той же функцией, что в приложении: по списку учётки, а не по её роли
    // (ADR 0106). Своя копия правила здесь означала бы, что тест проверяет не портал, а себя.
    ...permissionChecks(user),
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
            <AuthContext.Provider value={auth}>
              <RouteModalContext.Provider value={routeModal}>{ui}</RouteModalContext.Provider>
            </AuthContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>,
  );

  return { ...result, queryClient, routeModal };
}

/**
 * То же дерево, но с настоящим `AuthProvider`: вход, выход и истечение сессии идут через сеть,
 * как в приложении. Нужен сценариям про сессию — подставленный значением контекст ни входа, ни
 * очистки кэша не выполняет, а проверяются именно они.
 */
export function renderWithSession(
  ui: ReactNode,
  options: Omit<RenderOptions, 'user'> = {},
): RenderResult & { queryClient: QueryClient; routeModal: RouteModalApi } {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const routeModal = routeModalStub(options.routeModal);
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
            <AuthProvider>
              <RouteModalContext.Provider value={routeModal}>{ui}</RouteModalContext.Provider>
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>,
  );

  return { ...result, queryClient, routeModal };
}
