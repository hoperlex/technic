import { createContext, useContext } from 'react';
import type { VehicleRouteDto } from '@technic/contracts';

/**
 * Договор окон рейса, списка рейсов и заявки (ADR 0120). Сам провайдер живёт в `pages/vehicle`
 * (`routeModal.tsx`): он рисует четыре окна слоя `pages`, и переехать сюда целиком не может.
 * Здесь — только то, что нужно зовущей стороне.
 */
export interface RouteModalApi {
  /** Карточка рейса поверх текущей страницы. Заявку, если она открыта, вытесняет. */
  openRoute: (routeId: string) => void;
  /**
   * Список рейсов. `focusDate` — просьба встать на этот день: пришли из рейса позавчерашнего дня,
   * и список, оставшийся на сегодняшнем, этого рейса не показал бы вовсе.
   */
  openRoutesList: (options?: { focusDate?: string }) => void;
  /** Карточка заявки на чтение — ложится поверх рейса или списка, из которых её открыли. */
  openRequest: (requestId: string) => void;
  /**
   * Правка реквизитов рейса — окном поверх того, откуда её позвали: карточки рейса или строки
   * списка. Единственный метод контракта, который адреса не трогает вовсе: правка — шаг внутри
   * окна, а не место, куда ходят по ссылке.
   */
  editRoute: (route: VehicleRouteDto) => void;
}

/**
 * Экспортируется ради тестов — по той же причине, что и `AuthContext`: они подставляют заглушку
 * значением контекста, а не поднимают провайдер с настоящими окнами и запросами внутри.
 */
export const RouteModalContext = createContext<RouteModalApi | undefined>(undefined);

/**
 * Чем открыть рейс, список рейсов и заявку с любого экрана портала.
 *
 * Отсутствие контекста — ошибка монтажа, а не «нет прав»: провайдер стоит над всей веткой
 * `AppLayout`, и любая страница портала под ним. Молча проглоченный клик по номеру рейса читался
 * бы как поломка самого рейса, а не сборки приложения, — поэтому падаем громко.
 */
export function useRouteModal(): RouteModalApi {
  const ctx = useContext(RouteModalContext);
  if (!ctx) throw new Error('useRouteModal должен использоваться внутри RouteModalProvider');
  return ctx;
}
