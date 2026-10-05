import { lazy } from 'react';

export const GaragePage = lazy(() =>
  import('./GaragePage').then((module) => ({ default: module.GaragePage })),
);
