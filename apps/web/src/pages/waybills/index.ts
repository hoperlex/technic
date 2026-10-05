import { lazy } from 'react';

export const WaybillsPage = lazy(() =>
  import('./WaybillsPage').then((module) => ({ default: module.WaybillsPage })),
);
