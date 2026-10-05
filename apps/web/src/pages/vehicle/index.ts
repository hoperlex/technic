import { lazy } from 'react';

// A request opened over the garage or waybill journal must not download the vehicle list or a
// weekly workspace. Separate factories preserve these ownership boundaries behind one public API.
export const VehicleRequestViewModal = lazy(() =>
  import('./VehicleRequestViewModal').then((module) => ({
    default: module.VehicleRequestViewModal,
  })),
);

export const VehicleRequestsPage = lazy(() =>
  import('./VehicleRequestsPage').then((module) => ({ default: module.VehicleRequestsPage })),
);

export const WeeklyRequestPage = lazy(() =>
  import('./WeeklyRequestPage').then((module) => ({ default: module.WeeklyRequestPage })),
);
