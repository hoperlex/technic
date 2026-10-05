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

/** URL-backed route windows consumed by the public route-window widget. */
export interface RouteModalWindowsState {
  listOpen: boolean;
  focus: { date?: string; token: number };
  routeId: string | null;
  editing: VehicleRouteDto | null;
  refresh: () => void;
  closeRoutesList: () => void;
  closeRoute: () => void;
  editRoute: (route: VehicleRouteDto) => void;
  closeEdit: () => void;
  finishEdit: (route: VehicleRouteDto) => void;
}

/** Exported so tests can replace expensive route windows with command spies. */
export const RouteModalContext = createContext<RouteModalApi | undefined>(undefined);
export const RouteModalWindowsContext = createContext<RouteModalWindowsState | undefined>(
  undefined,
);

export function useRouteModal(): RouteModalApi {
  const context = useContext(RouteModalContext);
  if (!context) throw new Error('useRouteModal должен использоваться внутри RouteModalProvider');
  return context;
}

export function useRouteModalWindows(): RouteModalWindowsState {
  const context = useContext(RouteModalWindowsContext);
  if (!context) {
    throw new Error('useRouteModalWindows должен использоваться внутри RouteModalProvider');
  }
  return context;
}
