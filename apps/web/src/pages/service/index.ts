import { lazy } from 'react';

export const ServiceRequestsPage = lazy(() =>
  import('./ServiceRequestsPage').then((module) => ({ default: module.ServiceRequestsPage })),
);
