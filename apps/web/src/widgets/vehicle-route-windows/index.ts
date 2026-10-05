import { lazy } from 'react';

/** Route list, record and planning windows mounted over the current portal page. */
export { VehicleRouteWindows } from './ui/VehicleRouteWindows';
export const VehicleDayRouteModal = lazy(() =>
  import('./ui/VehicleDayRouteModal').then((module) => ({ default: module.VehicleDayRouteModal })),
);

// Public component entries keep focused scenario tests and page adapters out of slice internals.
export { RouteRequestRow } from './ui/RouteRequestRow';
export const VehicleRouteCorrectionModal = lazy(() =>
  import('./ui/VehicleRouteCorrectionModal').then((module) => ({
    default: module.VehicleRouteCorrectionModal,
  })),
);
export const VehicleRouteEditModal = lazy(() =>
  import('./ui/VehicleRouteEditModal').then((module) => ({
    default: module.VehicleRouteEditModal,
  })),
);
export const VehicleRouteModal = lazy(() =>
  import('./ui/VehicleRouteModal').then((module) => ({ default: module.VehicleRouteModal })),
);
export const VehicleRoutesModal = lazy(() =>
  import('./ui/VehicleRoutesModal').then((module) => ({ default: module.VehicleRoutesModal })),
);
export const VehicleRouteTransferCorrectionModal = lazy(() =>
  import('./ui/VehicleRouteTransferCorrectionModal').then((module) => ({
    default: module.VehicleRouteTransferCorrectionModal,
  })),
);
