import { createContext, useContext } from 'react';
import type { VehicleRouteDto } from '@technic/contracts';

/** Commands available to records that open URL-backed route/request windows (ADR 0120). */
export interface RouteModalApi {
  /** Open one route and displace a request overlay if present. */
  openRoute: (routeId: string) => void;
  /**
   * Open the route list. focusDate asks it to land on that day: coming from a route of the day
   * before yesterday, a list left on today would not show that route at all.
   */
  openRoutesList: (options?: { focusDate?: string }) => void;
  /** Overlay a read-only request without discarding the route underneath it. */
  openRequest: (requestId: string) => void;
  /**
   * Open the route header edit over whichever window asked (route card or list row). The only
   * command that does not touch the URL: an edit is a step inside a window, not a place to link to.
   */
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

/**
 * Exported for tests, like AuthContext: they supply a stub as the context value instead of mounting
 * the host with real windows and queries inside.
 */
export const RouteModalContext = createContext<RouteModalApi | undefined>(undefined);
export const RouteModalWindowsContext = createContext<RouteModalWindowsState | undefined>(
  undefined,
);

/**
 * How any portal screen opens a route, the route list or a request. A missing context is a mount
 * error, not "no rights": the host sits above the whole AppLayout branch, so every portal page is
 * under it. A silently swallowed click on a route number would read as a broken route rather than a
 * broken app build, hence the loud failure.
 */
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
