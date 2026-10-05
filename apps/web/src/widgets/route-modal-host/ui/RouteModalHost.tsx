import { Outlet } from 'react-router';
import {
  RouteModalContext,
  RouteModalWindowsContext,
  useRouteModalState,
} from '@features/route-modal';
import type { RouteModalHostProps } from '../model/types';

/**
 * Mounted once above every portal page (App.tsx -> RouteModalProvider), so a route or request
 * named in the URL opens over whatever page is underneath (ADR 0120). The feature owns URL state;
 * this widget only provides it and draws the windows. App injects the page-owned request card
 * (renderRequestCard) because widgets may not import pages.
 */
export function RouteModalHost({ children, renderRequestCard }: RouteModalHostProps) {
  const state = useRouteModalState();

  return (
    <RouteModalContext.Provider value={state.api}>
      <RouteModalWindowsContext.Provider value={state.windows}>
        <Outlet />
        {children}
        {state.openedRequest.id &&
          renderRequestCard({
            requestId: state.openedRequest.id,
            onClose: state.openedRequest.clear,
          })}
      </RouteModalWindowsContext.Provider>
    </RouteModalContext.Provider>
  );
}
