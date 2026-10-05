import { lazy } from 'react';

export const AdministrationPage = lazy(() =>
  import('./AdministrationPage').then((module) => ({ default: module.AdministrationPage })),
);
