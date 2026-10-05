import { lazy } from 'react';

export const MechRequestsPage = lazy(() =>
  import('./MechRequestsPage').then((module) => ({ default: module.MechRequestsPage })),
);
