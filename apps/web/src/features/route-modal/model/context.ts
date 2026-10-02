import { createContext, useContext } from 'react';
import type { VehicleRouteDto } from '@technic/contracts';

/** Commands available to records that open URL-backed route/request windows (ADR 0120). */
export interface RouteModalApi {
  /** Open one route and displace a request overlay if present. */
  openRoute: (routeId: string) => void;
  /** Open the route list and optionally focus the period containing one date. */
  openRoutesList: (options?: { focusDate?: string }) => void;
  /** Overlay a read-only request without discarding the route underneath it. */
  openRequest: (requestId: string) => void;
  /** Open the non-addressable edit child owned by the current route card or list. */
  editRoute: (route: VehicleRouteDto) => void;
}

/** Exported so tests can replace expensive route windows with command spies. */
export const RouteModalContext = createContext<RouteModalApi | undefined>(undefined);

export function useRouteModal(): RouteModalApi {
  const context = useContext(RouteModalContext);
  if (!context) throw new Error('useRouteModal должен использоваться внутри RouteModalProvider');
  return context;
}
