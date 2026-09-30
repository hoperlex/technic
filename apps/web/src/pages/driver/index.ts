import { lazy } from 'react';

/**
 * The driver cabinet is an existing isolated bundle: its role cannot enter the main portal, while
 * dispatchers never open the cabinet. Keeping the lazy declarations behind this public entry
 * preserves that boundary without exposing the slice's internal page files to `App.tsx`.
 */
export const DriverLayout = lazy(() =>
  import('./DriverLayout').then((module) => ({ default: module.DriverLayout })),
);

export const DriverPage = lazy(() =>
  import('./DriverPage').then((module) => ({ default: module.DriverPage })),
);

export const DriverReadingsPage = lazy(() =>
  import('./DriverReadingsPage').then((module) => ({ default: module.DriverReadingsPage })),
);
