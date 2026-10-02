import { Outlet } from 'react-router';
import { RouteModalContext, useRouteModalState } from '@features/route-modal';
import type { RouteModalHostProps } from '../model/types';

/** Render URL-backed route/request windows while the feature owns navigation state. */
export function RouteModalHost({
  renderRouteList,
  renderRouteCard,
  renderRouteEdit,
  renderRequestCard,
}: RouteModalHostProps) {
  const state = useRouteModalState();

  return (
    <RouteModalContext.Provider value={state.api}>
      <Outlet />
      {state.listOpen &&
        renderRouteList({
          focusDate: state.focus.date,
          focusToken: state.focus.token,
          onChanged: state.refresh,
          onClose: state.closeRoutesList,
        })}
      {state.openedRoute.id &&
        renderRouteCard({
          routeId: state.openedRoute.id,
          onChanged: state.refresh,
          onClose: state.openedRoute.clear,
          onEdit: state.api.editRoute,
        })}
      {state.editing &&
        renderRouteEdit({
          route: state.editing.route,
          onClose: state.closeEdit,
          onSaved: state.finishEdit,
        })}
      {state.openedRequest.id &&
        renderRequestCard({
          requestId: state.openedRequest.id,
          onClose: state.openedRequest.clear,
        })}
    </RouteModalContext.Provider>
  );
}
