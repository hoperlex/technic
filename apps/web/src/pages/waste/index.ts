import { lazy } from 'react';

export const WasteRequestsPage = lazy(() =>
  import('./WasteRequestsPage').then((module) => ({ default: module.WasteRequestsPage })),
);
