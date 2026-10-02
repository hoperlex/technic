import { Outlet } from 'react-router';
import {
  RouteModalContext,
  RouteModalWindowsContext,
  useRouteModalState,
} from '@features/route-modal';
import type { RouteModalHostProps } from '../model/types';

/** Render URL-backed route/request windows while the feature owns navigation state. */
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
