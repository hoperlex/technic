/*
 * Public contract and URL state for route, route-list and request windows (ADR 0120).
 *
 * Kept apart from the windows on purpose: the windows are drawn by
 * widgets/vehicle-route-windows and the read-only request card by pages/vehicle, while the commands
 * are needed from layers below and from neighbouring page slices (garage, waybill journal, request
 * tab). While the hook lived next to the provider in pages/vehicle, pages/garage imported a sibling
 * page slice and the boundary lint was red.
 *
 * features rather than shared: this is a portal scenario with its own vocabulary (route, request,
 * header edit), not a foundation detail.
 */
export {
  RouteModalContext,
  RouteModalWindowsContext,
  useRouteModal,
  useRouteModalWindows,
  type RouteModalApi,
  type RouteModalWindowsState,
} from './model/context';
export { useRouteModalState, type RouteModalState } from './model/useRouteModalState';
